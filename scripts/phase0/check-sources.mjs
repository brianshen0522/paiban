#!/usr/bin/env node
// Phase 0, item 4 (docs/14-plan.md): record one real response from each external source for the
// fixed film Inception (IMDb tt1375666, TMDB 27205) and compare it with docs/05-yts.md and
// docs/07-subtitle-providers.md.
//
// Manual only. Never part of the automated tests (they never touch the network).
//
//   node scripts/phase0/check-sources.mjs            # fetch whatever is not recorded yet
//   node scripts/phase0/check-sources.mjs --only yify
//
// Rules this script keeps (AGENTS.md):
// - Each response is fetched once and stored under .scratch/sources/ (ignored by git); later runs
//   reuse the stored copy. Requests to one host are at least 1.5 s apart.
// - Honest User-Agent, no browser imitation, no retries with different headers. A captcha or
//   challenge page stops that source and is reported as unavailable.
// - Keys are read from deploy/.env (TMDB_KEY, ASSRT_TOKEN, SUBDL_KEY). A source whose key is empty
//   is skipped. Before anything is written to disk, our own keys and any key-like query parameter
//   value (api_key, token, signatures) in the response are replaced with PLACEHOLDER.
// - Subtitle archives (at most one per source) go to .scratch/archives/ only to look at their
//   format; delete them afterwards with `rm -r .scratch/archives`.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.scratch', 'sources');
const ARCHIVES = join(ROOT, '.scratch', 'archives');
const USER_AGENT = 'Paiban/0.0.0 (phase-0 manual source check)';
const IMDB = 'tt1375666';
const TMDB_ID = 27205;
const TITLE = 'Inception';
const YEAR = 2010;
const SPACING_MS = 1500;

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

async function loadEnv() {
  const env = {};
  try {
    const text = await readFile(join(ROOT, 'deploy', '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  } catch {
    // no deploy/.env: every keyed source is skipped
  }
  return { TMDB_KEY: env.TMDB_KEY ?? '', ASSRT_TOKEN: env.ASSRT_TOKEN ?? '', SUBDL_KEY: env.SUBDL_KEY ?? '' };
}

const env = await loadEnv();
const ownSecrets = Object.values(env).filter((v) => v.length >= 6);

const KEY_PARAM =
  /([?&;](?:api_key|apikey|api-key|key|token|access_token|sig|signature|Signature|Expires|Policy|Key-Pair-Id|X-Amz-[A-Za-z-]+|hmac|hash)=)([^&"'\s<>\\]+)/g;

// Key-like fields inside JSON or HTML attributes, e.g. the analytics beacon's "token":"…".
const KEY_FIELD = /("(?:api_key|apikey|token|access_token|secret)"\s*:\s*")([^"]*)"/gi;

/** Removes our keys and any key-like query value from text before it is written anywhere. */
export function redact(text) {
  let out = text;
  for (const s of ownSecrets) out = out.split(s).join('PLACEHOLDER');
  out = out.replace(KEY_PARAM, (_m, p) => `${p}PLACEHOLDER`);
  out = out.replace(KEY_FIELD, (_m, p) => `${p}PLACEHOLDER"`);
  return out;
}

/** Strips the query string so a URL can be printed or logged. */
function bare(url) {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

const lastByHost = new Map();
async function pace(url) {
  const host = new URL(url).host;
  const wait = (lastByHost.get(host) ?? 0) + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastByHost.set(host, Date.now());
}

const CHALLENGE = /(captcha|cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|hcaptcha|recaptcha)/i;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches `url` once and stores the redacted response as `<name>.<ext>` plus `<name>.meta.json`.
 * Returns the stored copy on later runs without touching the network.
 */
async function record(name, url, { headers = {}, ext = 'json', redirect = 'manual' } = {}) {
  const bodyPath = join(OUT, `${name}.${ext}`);
  const metaPath = join(OUT, `${name}.meta.json`);
  if (await exists(metaPath)) {
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    const body = (await exists(bodyPath)) ? await readFile(bodyPath, 'utf8') : '';
    return { ...meta, body, cached: true };
  }
  await pace(url);
  const started = Date.now();
  let meta;
  let body = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: ext === 'html' ? 'text/html' : 'application/json', ...headers },
      redirect,
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.text();
    meta = {
      url: redact(bare(url)),
      status: res.status,
      ms: Date.now() - started,
      contentType: res.headers.get('content-type'),
      cacheControl: res.headers.get('cache-control'),
      location: res.headers.get('location') ? redact(res.headers.get('location')) : null,
      server: res.headers.get('server'),
      bytes: Buffer.byteLength(body),
      challenge: CHALLENGE.test(body.slice(0, 20_000)) && !(ext === 'json' && body.trim().startsWith('{')),
      at: new Date().toISOString(),
    };
  } catch (err) {
    meta = {
      url: redact(bare(url)),
      error: String(err?.cause?.code ?? err?.name ?? err),
      at: new Date().toISOString(),
    };
  }
  await mkdir(OUT, { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  if (body) await writeFile(bodyPath, redact(body));
  return { ...meta, body: redact(body), cached: false };
}

/** Downloads one archive to .scratch/archives (not committed, deleted after looking at it). */
async function fetchArchive(name, url) {
  const file = join(ARCHIVES, name);
  if (await exists(file)) return { file, cached: true };
  await pace(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(ARCHIVES, { recursive: true });
  if (res.status === 200) await writeFile(file, buf);
  return {
    file: res.status === 200 ? file : null,
    status: res.status,
    contentType: res.headers.get('content-type'),
    location: res.headers.get('location') ? bare(res.headers.get('location')) : null,
    bytes: buf.length,
    magic: buf.subarray(0, 8).toString('hex'),
  };
}

function summary(r) {
  if (r.error) return `ERROR ${r.error}`;
  return `${r.status} ${r.contentType ?? ''} ${r.bytes}B${r.cached ? ' (stored copy)' : ` ${r.ms}ms`}${r.location ? ` -> ${r.location}` : ''}${r.challenge ? ' CHALLENGE' : ''}`;
}

const report = {};
const want = (s) => !only || only === s;

// ---------------------------------------------------------------------------- JustSubtitles (direct)
if (want('justsubtitles')) {
  const out = {};
  for (const lang of ['EN', 'ZH', 'ZH_BG']) {
    const r = await record(
      `justsubtitles.subtitles.${TMDB_ID}.${lang}`,
      `https://www.justsubtitles.com/api/subtitles/${TMDB_ID}?lang=${lang}`,
    );
    console.log(`justsubtitles ${lang}: ${summary(r)}`);
    if (r.challenge) {
      out.unavailable = 'challenge page';
      break;
    }
    try {
      const j = JSON.parse(r.body);
      const subs = Array.isArray(j.subtitles) ? j.subtitles : [];
      out[lang] = {
        status: j.status,
        count: subs.length,
        keys: subs[0] ? Object.keys(subs[0]) : [],
        languages: [...new Set(subs.map((s) => `${s.language}/${s.lang}`))],
        urlsWithQuery: subs.filter((s) => typeof s.url === 'string' && s.url.includes('?')).length,
        urlPattern: subs.every((s) => /^\/subtitle\/\d+-\d+\.zip/.test(String(s.url))),
        sampleUrl: subs[0]?.url,
      };
    } catch {
      out[lang] = { notJson: true };
    }
  }
  // An id that does not exist: docs say HTTP 500 with {"status":false,"subtitles":[]}.
  const missing = await record(
    'justsubtitles.subtitles.missing',
    'https://www.justsubtitles.com/api/subtitles/999999999?lang=EN',
  );
  console.log(`justsubtitles missing id: ${summary(missing)} ${missing.body.slice(0, 80)}`);
  out.missing = { status: missing.status, body: missing.body.slice(0, 200) };

  const search = await record(
    'justsubtitles.search',
    `https://search.justsubtitles.com/api/search?q=${encodeURIComponent(TITLE)}`,
  );
  console.log(`justsubtitles title search: ${summary(search)}`);
  try {
    const j = JSON.parse(search.body);
    out.search = {
      topLevelKeys: Object.keys(j),
      firstResultKeys: Object.keys((j.results ?? j.data ?? j.hits ?? [])[0] ?? {}),
    };
  } catch {
    out.search = { notJson: true };
  }

  // One archive, only to see its format. A Chinese one, because the encoding is the open question.
  try {
    const zh = JSON.parse(await readFile(join(OUT, `justsubtitles.subtitles.${TMDB_ID}.ZH.json`), 'utf8'));
    const path = zh.subtitles?.[0]?.url?.split('?')[0];
    if (path) {
      const a = await fetchArchive('justsubtitles.zip', `https://dl.subdl.com${path}`);
      console.log(`justsubtitles archive: ${JSON.stringify(a)}`);
      out.archive = a;
    }
  } catch (err) {
    out.archive = { error: String(err) };
  }
  report.justsubtitles = out;
}

// ---------------------------------------------------------------------------- YIFY Subtitles
if (want('yify')) {
  const out = {};
  const base = 'https://yts-subs.com';
  const page = await record('yify.movie-page', `${base}/movie-imdb/${IMDB}`, { ext: 'html' });
  console.log(`yify movie page: ${summary(page)}`);
  out.page = { status: page.status, bytes: page.bytes, challenge: page.challenge, location: page.location };
  if (page.status === 200 && !page.challenge) {
    const slugs = [...page.body.matchAll(/href="\/subtitles\/([^"]+)"/g)].map((m) => m[1]);
    out.rows = slugs.length;
    const header = /<th[^>]*>\s*Rating[\s\S]*?Language[\s\S]*?Release[\s\S]*?Uploader[\s\S]*?Download/i.test(page.body);
    out.headerOrderMatches = header;
    // Prefer a Chinese row for the archive, to see the encoding the Chinese sites use.
    const rowRe = /<tr[\s\S]*?<\/tr>/g;
    let chosen = null;
    for (const m of page.body.matchAll(rowRe)) {
      if (/Chinese|Big 5/i.test(m[0])) {
        const s = /href="\/subtitles\/([^"]+)"/.exec(m[0]);
        if (s) {
          chosen = s[1];
          break;
        }
      }
    }
    chosen ??= slugs[0];
    if (chosen) {
      const sub = await record('yify.subtitle-page', `${base}/subtitles/${chosen}`, { ext: 'html' });
      console.log(`yify subtitle page: ${summary(sub)}`);
      const btn = /<a[^>]*id="btn-download-subtitle"[^>]*>/i.exec(sub.body)?.[0] ?? '';
      const dataLink = /data-link="([^"]+)"/.exec(btn)?.[1];
      out.subtitlePage = { status: sub.status, hasButton: Boolean(btn), hasDataLink: Boolean(dataLink) };
      if (dataLink) {
        const decoded = Buffer.from(dataLink, 'base64').toString('utf8');
        out.subtitlePage.decodedHost = (() => {
          try {
            return new URL(decoded).host;
          } catch {
            return null;
          }
        })();
        out.subtitlePage.decodedPath = (() => {
          try {
            return new URL(decoded).pathname;
          } catch {
            return decoded.slice(0, 80);
          }
        })();
        if (out.subtitlePage.decodedHost === 'subtitles.yts-subs.com') {
          const a = await fetchArchive('yify.zip', decoded);
          console.log(`yify archive: ${JSON.stringify(a)}`);
          out.archive = a;
        }
      }
    }
  }
  report.yify = out;
}

// ---------------------------------------------------------------------------- TMDB
if (want('tmdb')) {
  if (!env.TMDB_KEY) {
    console.log('tmdb: skipped (TMDB_KEY is empty in deploy/.env)');
    report.tmdb = { skipped: 'no key' };
  } else {
    const v4 = env.TMDB_KEY.split('.').length === 3;
    const url = `https://api.themoviedb.org/3/find/${IMDB}?external_source=imdb_id&language=zh-TW${v4 ? '' : `&api_key=${env.TMDB_KEY}`}`;
    const r = await record('tmdb.find', url, { headers: v4 ? { Authorization: `Bearer ${env.TMDB_KEY}` } : {} });
    console.log(`tmdb find: ${summary(r)}`);
    try {
      const j = JSON.parse(r.body);
      report.tmdb = {
        status: r.status,
        keyKind: v4 ? 'v4 bearer' : 'v3 api_key',
        id: j.movie_results?.[0]?.id,
        title: j.movie_results?.[0]?.title,
      };
    } catch {
      report.tmdb = { status: r.status, notJson: true };
    }
  }
}

// ---------------------------------------------------------------------------- assrt
if (want('assrt')) {
  if (!env.ASSRT_TOKEN) {
    console.log('assrt: skipped (ASSRT_TOKEN is empty in deploy/.env)');
    report.assrt = { skipped: 'no token' };
  } else {
    const auth = { Authorization: `Bearer ${env.ASSRT_TOKEN}` };
    const quota = await record('assrt.quota', 'https://api.assrt.net/v1/user/quota', { headers: auth });
    console.log(`assrt quota: ${summary(quota)}`);
    const search = await record(
      'assrt.search',
      `https://api.assrt.net/v1/sub/search?q=${encodeURIComponent(`${TITLE} ${YEAR}`)}&cnt=15&pos=0`,
      { headers: auth },
    );
    console.log(`assrt search: ${summary(search)}`);
    const out = { quota: quota.body.slice(0, 200) };
    try {
      const j = JSON.parse(search.body);
      const subs = j.sub?.subs ?? [];
      out.search = {
        status: j.status,
        count: subs.length,
        keys: Object.keys(subs[0] ?? {}),
        langlists: [...new Set(subs.map((s) => Object.keys(s.lang?.langlist ?? {}).join('+')))],
      };
      const id = subs.find((s) => !/vobsub/i.test(String(s.subtype)))?.id;
      if (id) {
        const detail = await record('assrt.detail', `https://api.assrt.net/v1/sub/detail?id=${id}`, { headers: auth });
        console.log(`assrt detail: ${summary(detail)}`);
        const d = JSON.parse(detail.body).sub?.subs?.[0] ?? {};
        out.detail = {
          keys: Object.keys(d),
          files: (d.filelist ?? []).map((f) => f.f),
          downloadHost: d.url ? new URL(d.url).host : null,
        };
        const fileUrl = d.filelist?.find((f) => /\.(srt|ass|ssa|vtt)$/i.test(f.f))?.url ?? d.url;
        if (fileUrl) out.archive = await fetchArchive('assrt.bin', fileUrl);
      }
    } catch (err) {
      out.error = String(err);
    }
    report.assrt = out;
  }
}

// ---------------------------------------------------------------------------- SubDL official API
if (want('subdl')) {
  if (!env.SUBDL_KEY) {
    console.log('subdl: skipped (SUBDL_KEY is empty in deploy/.env)');
    report.subdl = { skipped: 'no key' };
  } else {
    const r = await record(
      'subdl.subtitles',
      `https://api.subdl.com/api/v1/subtitles?api_key=${env.SUBDL_KEY}&imdb_id=${IMDB}&type=movie&languages=EN,ZH,ZH_BG&subs_per_page=30`,
    );
    console.log(`subdl: ${summary(r)}`);
    try {
      const j = JSON.parse(r.body);
      report.subdl = { status: j.status, count: j.subtitles?.length, keys: Object.keys(j.subtitles?.[0] ?? {}) };
    } catch {
      report.subdl = { status: r.status, notJson: true };
    }
  }
}

// ---------------------------------------------------------------------------- YTS
if (want('yts')) {
  const base = process.env.YTS_BASE_URL ?? '';
  if (!base) {
    console.log('yts: skipped (pass the address Brian gives as YTS_BASE_URL=https://…)');
    report.yts = { skipped: 'no address' };
  } else {
    const list = await record('yts.list_movies', `${base}/api/v2/list_movies.json?query_term=${IMDB}&limit=1`);
    console.log(`yts list: ${summary(list)}`);
    const genre = await record('yts.list_movies.genre', `${base}/api/v2/list_movies.json?genre=sci-fi&limit=1`);
    console.log(`yts genre: ${summary(genre)}`);
    const none = await record('yts.list_movies.empty', `${base}/api/v2/list_movies.json?query_term=zzqqxxnotafilm`);
    console.log(`yts empty: ${summary(none)}`);
    report.yts = { list: list.status, genre: genre.status, empty: none.body.slice(0, 300) };
    try {
      const id = JSON.parse(list.body).data?.movies?.[0]?.id;
      if (id) {
        const d = await record('yts.movie_details', `${base}/api/v2/movie_details.json?movie_id=${id}`);
        console.log(`yts details: ${summary(d)}`);
      }
    } catch {
      // reported through the stored response
    }
  }
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nreport written to ${join('.scratch', 'sources', 'report.json')}`);
