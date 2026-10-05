import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assrtStatus, parseAssrtDetail, parseAssrtSearch } from './assrt.js';
import { type FilmContext, ProviderFailure, wanted } from './common.js';
import {
  justSubtitlesLangs,
  parseJustSubtitlesAnswer,
  parseSubdlAnswer,
  parseTmdbFind,
  pickTitleMatch,
} from './justsubtitles.js';
import { parseYifyDownloadLink, parseYifyMoviePage, yifyRowsToFound } from './yify.js';

/** The parsers against the responses recorded in phase 0 (reference/providers). No network. */
const sample = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../reference/providers/${f}`, import.meta.url)), 'utf8');
const json = (f: string) => JSON.parse(sample(f));

const inception: FilmContext = {
  imdbCode: 'tt1375666',
  tmdbId: null,
  title: 'Inception',
  titleZh: null,
  year: 2010,
  release: { quality: '1080p', source: 'bluray', videoCodec: 'x264' },
};

describe('JustSubtitles', () => {
  it('drops somebody else’s api_key the moment the answer is parsed (D28)', () => {
    const raw = sample('justsubtitles.subtitles.sample.json');
    expect(raw).toContain('api_key=PLACEHOLDER');
    const found = parseJustSubtitlesAnswer(200, JSON.parse(raw));
    expect(found.length).toBe(7);
    const text = JSON.stringify(found);
    expect(text).not.toContain('api_key');
    expect(text).not.toContain('PLACEHOLDER');
    expect(text).not.toContain('?');
    for (const f of found) {
      expect(f.ref).toMatch(/^\/subtitle\/\d+-\d+\.zip$/);
      expect(f.downloadUrl).toBe(`https://dl.subdl.com${f.ref}`);
    }
    expect(found[3]).toMatchObject({
      ref: '/subtitle/2812131-2837486.zip',
      languageLabel: 'chinese-bg-code',
      language: 'zh-Hans',
      releaseName: 'Inception.2010.1080p.BrRip.x264.YIFY.cht',
      uploader: 'JackDesigner',
      pageUrl: 'https://www.justsubtitles.com/s/info/5RqOeLPkaT',
    });
  });

  it('reads the English answer (30 entries, the cap) with its hearing-impaired flags', () => {
    const found = parseJustSubtitlesAnswer(200, json('justsubtitles.subtitles.en.sample.json'));
    expect(found.length).toBe(30);
    expect(found.every((f) => f.language === 'en')).toBe(true);
    expect(found.filter((f) => f.hearingImpaired).length).toBe(9);
  });

  it('treats a missing id as no results, with 200 or with 500', () => {
    const missing = json('justsubtitles.subtitles.missing.sample.json');
    expect(parseJustSubtitlesAnswer(200, missing)).toEqual([]);
    expect(parseJustSubtitlesAnswer(500, missing)).toEqual([]);
    expect(() => parseJustSubtitlesAnswer(200, { hello: 1 })).toThrow(ProviderFailure);
    expect(() => parseJustSubtitlesAnswer(502, { status: true, subtitles: [] })).toThrow(ProviderFailure);
  });

  it('skips entries whose path is not a subtitle zip', () => {
    const found = parseJustSubtitlesAnswer(200, {
      status: true,
      subtitles: [
        { url: '/subtitle/1-2.zip?api_key=x', language: 'EN' },
        { url: '/elsewhere/1.zip', language: 'EN' },
        { url: 'https://evil.example/subtitle/3-4.zip', language: 'EN' },
        { language: 'EN' },
      ],
    });
    expect(found.map((f) => f.ref)).toEqual(['/subtitle/1-2.zip', '/subtitle/3-4.zip']);
    expect(found[1]?.downloadUrl).toBe('https://dl.subdl.com/subtitle/3-4.zip');
  });

  it('asks both Chinese categories for Traditional', () => {
    expect(justSubtitlesLangs(['zh-Hant', 'en'])).toEqual(['EN', 'ZH_BG', 'ZH']);
    expect(justSubtitlesLangs(['zh-Hans'])).toEqual(['ZH']);
  });

  it('takes the title search’s id only for one exact title and year (Inception 2010, not 1980)', () => {
    const body = json('justsubtitles.search.sample.json');
    expect(pickTitleMatch(body, 'Inception', 2010)).toBe(27205);
    expect(pickTitleMatch(body, 'inception', 1980)).toBe(1359046);
    expect(pickTitleMatch(body, 'Inception', 2011)).toBeNull();
    expect(pickTitleMatch({ results: [] }, 'Inception', 2010)).toBeNull();
  });

  it('reads TMDB find with the zh-TW title', () => {
    expect(parseTmdbFind(json('tmdb.find.sample.json'), 'Inception')).toEqual({ id: 27205, titleZh: '全面啟動' });
    expect(parseTmdbFind({ movie_results: [{ id: 1, title: 'Same' }] }, 'Same')).toEqual({ id: 1, titleZh: null });
    expect(parseTmdbFind({ movie_results: [] }, 'x')).toBeNull();
  });

  it('reads SubDL with the same entry parser, and tells a refused key from a used-up quota', () => {
    expect(parseSubdlAnswer(200, json('justsubtitles.subtitles.sample.json')).length).toBe(7);
    expect(() => parseSubdlAnswer(403, {})).toThrow(
      expect.objectContaining({ code: 'NOT_CONFIGURED', invalidKey: true }),
    );
    expect(() => parseSubdlAnswer(429, {})).toThrow(expect.objectContaining({ code: 'RATE_LIMITED' }));
    expect(parseSubdlAnswer(200, { status: false, error: "can't find movie" })).toEqual([]);
  });
});

describe('YIFY Subtitles', () => {
  it('finds the table by its headings and reads all 402 rows', () => {
    const rows = parseYifyMoviePage(sample('yify.movie-page.sample.html'));
    expect(rows?.length).toBe(402);
    const by = (l: string) => rows?.filter((r) => r.language === l).length;
    expect([by('English'), by('Chinese'), by('Big 5 code'), by('Chinese BG code')]).toEqual([147, 6, 2, 2]);
    expect(rows?.[0]).toEqual({
      slug: 'inception-2010-arabic-yify-90032',
      rating: 3,
      language: 'Arabic',
      release: 'Inception 2010 720p BrRip x264 YIFY',
      uploader: 'sub',
    });
  });

  it('keeps the asked languages; Traditional lists all three Chinese kinds', () => {
    const rows = parseYifyMoviePage(sample('yify.movie-page.sample.html')) ?? [];
    const zh = yifyRowsToFound(rows, 'https://yts-subs.com', ['zh-Hant']);
    expect(zh.length).toBe(10);
    expect(new Set(zh.map((f) => f.language))).toEqual(new Set(['zh', 'zh-Hant', 'zh-Hans']));
    expect(zh[0]?.pageUrl).toBe(`https://yts-subs.com/subtitles/${zh[0]?.ref}`);
    expect(yifyRowsToFound(rows, 'https://yts-subs.com', ['en']).length).toBe(147);
  });

  it('says there is no table on a page that is not the subtitles page', () => {
    expect(parseYifyMoviePage('<!doctype html><title>Just a moment...</title>')).toBeNull();
  });

  it('decodes the download button and does not guess without it', () => {
    expect(parseYifyDownloadLink(sample('yify.subtitle-page.sample.html'))).toBe(
      'https://subtitles.yts-subs.com/subtitles/inception-2010-chinese-yify-90051.zip',
    );
    expect(parseYifyDownloadLink('<a id="other" data-link="aGVsbG8=">x</a>')).toBeNull();
    expect(parseYifyDownloadLink('<a id="btn-download-subtitle" data-link="!!!">x</a>')).toBeNull();
  });
});

describe('射手網', () => {
  it('keeps results that name the film, guesses the language from langlist, skips VobSub', () => {
    const film = { ...inception, title: 'Sample Movie', year: 2010 };
    const found = parseAssrtSearch(json('assrt.search.sample.json'), film, ['zh-Hant']);
    expect(found.map((f) => [f.ref, f.language, f.languageLabel, f.ass])).toEqual([
      ['600001', 'zh-Hant', '繁 英 雙語', false],
      ['600002', 'zh-Hans', '简', true],
    ]);
    expect(
      parseAssrtSearch(json('assrt.search.sample.json'), { ...film, title: 'Unrelated', year: 1999 }, ['zh-Hant']),
    ).toEqual([]);
    const vob = {
      status: 0,
      sub: {
        subs: [{ id: 1, videoname: 'Sample Movie 2010', subtype: 'VobSub', lang: { langlist: { langcht: true } } }],
      },
    };
    expect(parseAssrtSearch(vob, film, ['zh-Hant'])).toEqual([]);
    expect(parseAssrtSearch(json('assrt.search.sample.json'), film, ['en']).map((f) => f.ref)).toEqual(['600001']);
  });

  it('prefers the file list (no archive to open) and refuses download hosts outside assrt.net', () => {
    const logged: string[] = [];
    const detail = json('assrt.detail.sample.json');
    expect(parseAssrtDetail(detail, (h) => logged.push(h))).toEqual([]);
    expect(logged).toEqual(['file.example.invalid', 'file.example.invalid']);
    const real = JSON.parse(sample('assrt.detail.sample.json').replaceAll('file.example.invalid', 'file0.assrt.net'));
    const files = parseAssrtDetail(real, () => undefined);
    expect(files.map((f) => f.fileName)).toEqual(['Sample.Movie.2010.cht&eng.srt', 'Sample.Movie.2010.cht.srt']);
    real.sub.subs[0].filelist = [];
    expect(parseAssrtDetail(real, () => undefined)).toEqual([
      {
        url: expect.stringContaining('https://file0.assrt.net/download/600001/'),
        fileName: 'Sample.Movie.2010.BluRay.1080p.x264-GROUP.rar',
      },
    ]);
  });

  it('maps its status codes (docs/07, "錯誤碼")', () => {
    expect(assrtStatus(0)).toBeNull();
    expect(assrtStatus(101)).toBe('empty');
    expect(assrtStatus(20900)).toBe('empty');
    expect(assrtStatus(1)).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(assrtStatus(20001)).toMatchObject({ code: 'NOT_CONFIGURED', invalidKey: true });
    expect(assrtStatus(20000)).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(assrtStatus(20400)).toMatchObject({ code: 'BAD_RESPONSE' });
    for (const c of [30000, 30001, 30002, 30300]) expect(assrtStatus(c)).toMatchObject({ code: 'UNREACHABLE' });
    expect(assrtStatus(30900)).toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('languages', () => {
  it('Traditional takes every Chinese guess; Simplified takes Simplified and unclear Chinese', () => {
    expect(['zh-Hant', 'zh-Hans', 'zh', 'en', 'und'].map((g) => wanted(['zh-Hant'], g as 'zh'))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(['zh-Hant', 'zh-Hans', 'zh', 'en'].map((g) => wanted(['zh-Hans'], g as 'zh'))).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});
