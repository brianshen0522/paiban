import type { DetectedLang, Lang, SourceCheck } from '@paiban/shared';
import { load } from 'cheerio';
import {
  check,
  type Download,
  DownloadFailure,
  type FilmContext,
  type FoundSubtitle,
  failureCheck,
  type ProviderEnv,
  ProviderFailure,
  request,
  type SubtitleProvider,
  wanted,
} from './common.js';

/**
 * YIFY Subtitles (docs/07-subtitle-providers.md, "YIFY Subtitles"): no API, server-rendered pages
 * at the configured address. The table is found by its five headings, not by class names; the
 * download link is the base64 `data-link` of `a#btn-download-subtitle` and is never guessed.
 */
const HEADINGS = ['rating', 'language', 'release', 'uploader', 'download'];

const LANGUAGE: Record<string, DetectedLang> = {
  english: 'en',
  chinese: 'zh',
  'big 5 code': 'zh-Hant',
  'chinese bg code': 'zh-Hans',
};

export type YifyRow = {
  slug: string;
  rating: number | null;
  language: string;
  release: string;
  uploader: string;
};

/** Every row of the subtitles table; null when the page has no such table (a changed layout, or not the page at all). */
export function parseYifyMoviePage(html: string): YifyRow[] | null {
  const $ = load(html);
  const table = $('table')
    .toArray()
    .find((t) => {
      const heads = $(t)
        .find('th')
        .toArray()
        .map((th) => $(th).text().trim().toLowerCase());
      return heads.length === HEADINGS.length && heads.every((h, i) => h === HEADINGS[i]);
    });
  if (!table) return null;
  const rows: YifyRow[] = [];
  for (const tr of $(table).find('tbody tr').toArray()) {
    const cells = $(tr).find('td').toArray();
    if (cells.length < HEADINGS.length) continue;
    // A row links its slug twice (release and download); one is enough.
    const href = $(tr)
      .find('a[href^="/subtitles/"]')
      .toArray()
      .map((a) => $(a).attr('href') ?? '')
      .find(Boolean);
    const slug = href ? /^\/subtitles\/([A-Za-z0-9._-]+)$/.exec(href)?.[1] : undefined;
    if (!slug) continue;
    const text = (i: number) => $(cells[i]).text().replace(/\s+/g, ' ').trim();
    const rating = Number(text(0));
    rows.push({
      slug,
      rating: text(0) !== '' && Number.isFinite(rating) ? rating : null,
      language: text(1),
      release: text(2).replace(/^subtitle\s+/i, ''),
      uploader: text(3),
    });
  }
  return rows;
}

/** The zip address hidden in the subtitle page, or null when the button or its link is not there. */
export function parseYifyDownloadLink(html: string): string | null {
  const $ = load(html);
  const link = $('a#btn-download-subtitle').attr('data-link');
  if (!link) return null;
  try {
    const url = Buffer.from(link, 'base64').toString('utf8').trim();
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function yifyRowsToFound(rows: YifyRow[], base: string, languages: readonly Lang[]): FoundSubtitle[] {
  const seen = new Set<string>();
  const out: FoundSubtitle[] = [];
  for (const r of rows) {
    const guess = LANGUAGE[r.language.toLowerCase()];
    if (!guess || !wanted(languages, guess) || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push({
      ref: r.slug,
      languageLabel: r.language,
      language: guess,
      releaseName: r.release,
      uploader: r.uploader || null,
      pageUrl: `${base}/subtitles/${r.slug}`,
      hearingImpaired: false,
      rating: r.rating,
      downloadUrl: null,
      ass: false,
    });
  }
  return out;
}

export class Yify implements SubtitleProvider {
  readonly id = 'yify' as const;
  private readonly env: ProviderEnv;
  private readonly base: string;
  private readonly host: string;
  constructor(env: ProviderEnv, baseUrl: string) {
    this.env = env;
    this.base = baseUrl.replace(/\/+$/, '');
    this.host = new URL(this.base).hostname;
  }

  /** The configured host, subtitles.yts-subs.com, and the configured host's `subtitles.` subdomain. */
  allow(host: string): boolean {
    return host === this.host || host === 'subtitles.yts-subs.com' || host === `subtitles.${this.host}`;
  }

  async search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]> {
    const res = await request(this.env, `${this.base}/movie-imdb/${encodeURIComponent(film.imdbCode)}`, {
      allow: (h) => this.allow(h),
      pace: 'yify',
    });
    if (res.status === 404) return [];
    if (res.status !== 200) throw new ProviderFailure('UNREACHABLE', `answered ${res.status}`);
    const rows = parseYifyMoviePage(res.body.toString('utf8'));
    if (!rows) throw new ProviderFailure('BAD_RESPONSE', 'no subtitles table on the page');
    return yifyRowsToFound(rows, this.base, languages);
  }

  async resolveDownload(found: { ref: string }): Promise<Download[]> {
    const res = await request(this.env, `${this.base}/subtitles/${encodeURIComponent(found.ref)}`, {
      allow: (h) => this.allow(h),
      pace: 'yify',
    });
    if (res.status !== 200) throw new DownloadFailure(`subtitle page answered ${res.status}`);
    const url = parseYifyDownloadLink(res.body.toString('utf8'));
    // No button or no address: the page changed. Do not guess an address (docs/07, "下載").
    if (!url) throw new DownloadFailure('no download link on the subtitle page', true);
    if (!this.allow(new URL(url).hostname)) throw new DownloadFailure('download host not on the list');
    return [{ url, fileName: `${found.ref}.zip` }];
  }

  /** `POST /api/admin/sources/yify/test`: the rows of tt1375666's page. */
  async test(): Promise<SourceCheck> {
    const started = Date.now();
    try {
      const res = await request(this.env, `${this.base}/movie-imdb/tt1375666`, {
        allow: (h) => this.allow(h),
        pace: 'yify',
      });
      if (res.status !== 200)
        return check(started, false, res.status === 404 ? 'BAD_RESPONSE' : 'UNREACHABLE', { status: res.status });
      const rows = parseYifyMoviePage(res.body.toString('utf8'));
      if (!rows || rows.length === 0) return check(started, false, 'BAD_RESPONSE');
      return check(started, true, 'OK', { rows: rows.length });
    } catch (err) {
      return failureCheck(started, err);
    }
  }
}
