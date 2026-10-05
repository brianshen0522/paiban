import type { DetectedLang, Lang, SourceCheck } from '@paiban/shared';
import { z } from 'zod';
import {
  asJson,
  check,
  type Download,
  DownloadFailure,
  type FilmContext,
  type FoundSubtitle,
  failureCheck,
  holdSource,
  hostList,
  type ProviderEnv,
  ProviderFailure,
  request,
  type SubtitleProvider,
  wanted,
} from './common.js';

/**
 * 射手網(偽) (docs/07-subtitle-providers.md, "射手網"): the official API with a Bearer token, keyword
 * search, at most 20 requests a minute per token and IP (we pace at 3.4 s). Its download addresses
 * are temporary, so they are asked for right before downloading and never stored.
 */
const API_HOSTS = hostList('api.assrt.net', 'api.makedie.me');
/** Download hosts: assrt.net and its subdomains only. Anything else is logged (host only) and not contacted. */
const FILE_HOSTS = hostList('assrt.net', '.assrt.net');
export const ASSRT_CREDIT = { name: 'assrt.net', url: 'https://assrt.net' } as const;

const Sub = z.object({
  id: z.union([z.number(), z.string()]),
  native_name: z.string().nullish(),
  videoname: z.string().nullish(),
  subtype: z.string().nullish(),
  vote_score: z.number().nullish(),
  release_site: z.string().nullish(),
  lang: z.object({ desc: z.string().nullish(), langlist: z.record(z.string(), z.unknown()).nullish() }).nullish(),
  url: z.string().nullish(),
  filename: z.string().nullish(),
  filelist: z.array(z.object({ f: z.string(), s: z.string().nullish(), url: z.string() })).nullish(),
});
const Envelope = z.object({
  status: z.number(),
  sub: z.object({ subs: z.array(z.unknown()).optional() }).optional(),
  user: z.object({ quota: z.number().optional() }).optional(),
});

/**
 * An answer's status code → what happens (docs/07, "錯誤碼"). 0 is fine; 101 (keyword too short)
 * and 20900 (nothing found) are "no results" for a search. 30900 is handled by the caller.
 */
export function assrtStatus(status: number): ProviderFailure | 'empty' | null {
  if (status === 0) return null;
  if (status === 101 || status === 20900) return 'empty';
  if (status === 1) return new ProviderFailure('NOT_CONFIGURED', 'no such user');
  if (status === 20001) return new ProviderFailure('NOT_CONFIGURED', 'token refused', { invalidKey: true });
  if (status === 20000 || status === 20400) return new ProviderFailure('BAD_RESPONSE', `status ${status}`);
  if ([30000, 30001, 30002, 30300].includes(status)) return new ProviderFailure('UNREACHABLE', `status ${status}`);
  if (status === 30900) return new ProviderFailure('RATE_LIMITED', 'over 20 requests a minute');
  return new ProviderFailure('BAD_RESPONSE', `status ${status}`);
}

function guess(langlist: Record<string, unknown> | null | undefined): DetectedLang {
  const has = (k: string) => !!langlist?.[k];
  if (has('langcht')) return 'zh-Hant';
  if (has('langchs')) return 'zh-Hans';
  if (has('langdou')) return 'zh';
  if (has('langeng')) return 'en';
  return 'und';
}

const plain = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

/** Search results: graphic (VobSub) subtitles dropped, and only those that mention the year or the title. */
export function parseAssrtSearch(body: unknown, film: FilmContext, languages: readonly Lang[]): FoundSubtitle[] {
  const e = Envelope.safeParse(body);
  if (!e.success) throw new ProviderFailure('BAD_RESPONSE', 'not the search answer');
  const titles = [film.title, film.titleZh]
    .filter((t): t is string => !!t)
    .map(plain)
    .filter((t) => t.length >= 2);
  const out: FoundSubtitle[] = [];
  for (const raw of e.data.sub?.subs ?? []) {
    const s = Sub.safeParse(raw);
    if (!s.success) continue;
    const d = s.data;
    if (/vobsub/i.test(d.subtype ?? '')) continue;
    const names = `${d.videoname ?? ''} ${d.native_name ?? ''}`;
    if (!names.includes(String(film.year)) && !titles.some((t) => plain(names).includes(t))) continue;
    const lang = guess(d.lang?.langlist);
    const english = !!d.lang?.langlist?.langeng;
    if (!wanted(languages, lang) && !(english && languages.includes('en'))) continue;
    out.push({
      ref: String(d.id),
      languageLabel: d.lang?.desc ?? '',
      language: lang,
      releaseName: d.videoname || d.native_name || '',
      uploader: d.release_site || null,
      pageUrl: null,
      hearingImpaired: false,
      rating: typeof d.vote_score === 'number' ? d.vote_score : null,
      downloadUrl: null,
      ass: /ass|ssa/i.test(d.subtype ?? ''),
    });
  }
  return out;
}

const SUBTITLE_FILE = /\.(srt|ass|ssa|vtt)$/i;

/** The detail answer → what to download: each subtitle file of `filelist`, or the whole package when the list is empty. */
export function parseAssrtDetail(body: unknown, log: (host: string) => void): Download[] {
  const e = Envelope.safeParse(body);
  if (!e.success) throw new DownloadFailure('not the detail answer');
  const s = Sub.safeParse(e.data.sub?.subs?.[0]);
  if (!s.success) throw new DownloadFailure('no subtitle in the detail answer');
  const okHost = (u: string) => {
    try {
      const host = new URL(u).hostname;
      if (FILE_HOSTS(host)) return true;
      log(host);
      return false;
    } catch {
      return false;
    }
  };
  const files = (s.data.filelist ?? []).filter((f) => SUBTITLE_FILE.test(f.f));
  if (files.length) return files.filter((f) => okHost(f.url)).map((f) => ({ url: f.url, fileName: f.f }));
  if (s.data.url && okHost(s.data.url)) return [{ url: s.data.url, fileName: s.data.filename || `${s.data.id}` }];
  return [];
}

export class Assrt implements SubtitleProvider {
  readonly id = 'assrt' as const;
  private readonly env: ProviderEnv;
  constructor(env: ProviderEnv) {
    this.env = env;
  }

  allow(host: string): boolean {
    return API_HOSTS(host) || FILE_HOSTS(host);
  }

  private async call(path: string): Promise<{ status: number; body: unknown }> {
    const token = await this.env.secret('assrtToken');
    if (!token) throw new ProviderFailure('NOT_CONFIGURED', 'no token');
    const res = await request(this.env, `https://api.assrt.net${path}`, {
      allow: API_HOSTS,
      pace: 'assrt',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new ProviderFailure('UNREACHABLE', `answered ${res.status}`);
    const body = asJson(res);
    const e = Envelope.safeParse(body);
    if (!e.success) throw new ProviderFailure('BAD_RESPONSE', 'not an assrt answer');
    if (e.data.status === 30900) {
      // Nobody sends again for 60 s, from either process (docs/07, "限制").
      const retryAt = await holdSource(this.env.pool, 'assrt', 60);
      throw new ProviderFailure('RATE_LIMITED', 'over 20 requests a minute', { retryAt });
    }
    return { status: e.data.status, body };
  }

  async search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]> {
    const queries = [`${film.title} ${film.year}`];
    if (film.titleZh) queries.push(film.titleZh);
    const seen = new Set<string>();
    const out: FoundSubtitle[] = [];
    for (const q of queries) {
      if ([...q].length < 3) continue;
      const r = await this.call(`/v1/sub/search?q=${encodeURIComponent(q)}&cnt=15&pos=0`);
      const s = assrtStatus(r.status);
      if (s === 'empty') continue;
      if (s) throw s;
      for (const f of parseAssrtSearch(r.body, film, languages))
        if (!seen.has(f.ref)) {
          seen.add(f.ref);
          out.push(f);
        }
    }
    return out;
  }

  async resolveDownload(found: { ref: string }): Promise<Download[]> {
    if (!/^\d+$/.test(found.ref)) throw new DownloadFailure('not an assrt id');
    let r: { status: number; body: unknown };
    try {
      r = await this.call(`/v1/sub/detail?id=${found.ref}`);
    } catch (err) {
      // Over the limit while fetching: the slot is pushed back 60 s; wait for it once, then give up.
      if (err instanceof ProviderFailure && err.code === 'RATE_LIMITED')
        r = await this.call(`/v1/sub/detail?id=${found.ref}`);
      else throw err;
    }
    const s = assrtStatus(r.status);
    if (s === 'empty') throw new DownloadFailure('no such subtitle');
    if (s) throw s;
    return parseAssrtDetail(r.body, (host) =>
      this.env.log.warn({ host }, 'assrt download host not on the list; not contacted'),
    );
  }

  /** `POST /api/admin/sources/assrt/test`: the remaining quota. */
  async test(): Promise<SourceCheck> {
    const started = Date.now();
    try {
      const r = await this.call('/v1/user/quota');
      const s = assrtStatus(r.status);
      if (s && s !== 'empty') throw s;
      const quota = Envelope.parse(r.body).user?.quota;
      return check(started, true, 'OK', quota === undefined ? {} : { quota });
    } catch (err) {
      return failureCheck(started, err);
    }
  }
}
