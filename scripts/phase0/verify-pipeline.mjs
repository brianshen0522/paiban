#!/usr/bin/env node
// Phase 0, item 2 (docs/14-plan.md): run the reference pipeline scripts on the fixtures and compare
// the results with what the handoff measured on ffmpeg 6.1.1. Meant to run inside the built image
// (scripts/phase0/reference-in-image.sh mounts the repository at /work); it works on the host too
// if ffmpeg and ffsubsync are installed.
//
//   node scripts/phase0/verify-pipeline.mjs [work dir]
//
// Prints one line per check and a JSON summary; exits 1 if any check fails.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FIX = join(ROOT, 'fixtures');
const PIPE = join(ROOT, 'reference', 'pipeline');
const WORK = resolve(process.argv[2] ?? '/tmp/paiban-phase0');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`,
  );
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr?.slice(0, 2000)}`);
  return r.stdout;
}
const probe = (file, extra) => JSON.parse(run('ffprobe', ['-v', 'error', ...extra, '-of', 'json', file]));

// ---------------------------------------------------------------------------- analyze.sh
const data = JSON.parse(readFileSync(join(FIX, 'data.json'), 'utf8'));
const analyzed = join(WORK, 'analyze');
run('bash', [join(PIPE, 'analyze.sh'), join(FIX, 'clip.mp4'), analyzed]);
{
  const speech = JSON.parse(readFileSync(join(analyzed, 'speech.json'), 'utf8'));
  const frames = (segments, n) => {
    const a = new Uint8Array(n);
    for (const [s, e] of segments) a.fill(1, s, e);
    return a;
  };
  const n = Math.max(speech.frames, data.speechFrames);
  const got = frames(speech.segments, n);
  const want = frames(data.speech, n);
  let differ = 0;
  for (let i = 0; i < n; i++) if (got[i] !== want[i]) differ++;
  const same = JSON.stringify(speech.segments) === JSON.stringify(data.speech) && speech.frames === data.speechFrames;
  check('analyze.sh speech.json == data.json speech', same, {
    segments: `${speech.segments.length} vs ${data.speech.length}`,
    frames: `${speech.frames} vs ${data.speechFrames}`,
    differingFrames: differ,
    differingPct: Number(((differ / n) * 100).toFixed(3)),
  });
  results.at(-1).speechDifferingPct = (differ / n) * 100;

  const peaks = readFileSync(join(analyzed, 'peaks.bin'));
  const expected = Buffer.from(data.peaks, 'base64');
  let peakDiff = 0;
  let maxDelta = 0;
  for (let i = 0; i < Math.max(peaks.length, expected.length); i++) {
    if (i >= peaks.length || i >= expected.length) {
      peakDiff++;
      continue;
    }
    const d = Math.abs(peaks.readInt8(i) - expected.readInt8(i));
    if (d !== 0) peakDiff++;
    if (d > maxDelta) maxDelta = d;
  }
  check('analyze.sh peaks.bin == data.json peaks', peaks.equals(expected), {
    bytes: `${peaks.length} vs ${expected.length}`,
    differingBytes: peakDiff,
    maxDelta,
  });
}

// ---------------------------------------------------------------------------- align.ts
// docs/08-media-pipeline.md, last column of the table: segments, scale, offset (±0.01 s), agree.
const expectedAlign = {
  late: [{ scale: 1, offset: -2.36 }],
  rate: [{ scale: 1.04271, offset: -0.79 }],
  cut: [
    { scale: 1, offset: 1.25 },
    { scale: 1, offset: 13.24 },
  ],
};
for (const [name, want] of Object.entries(expectedAlign)) {
  const out = JSON.parse(
    run('node', [join(PIPE, 'align.ts'), analyzed, join(FIX, `${name}.zh-TW.srt`)], {
      env: { ...process.env, FFSUBSYNC: process.env.FFSUBSYNC ?? 'ffsubsync' },
    }),
  );
  const segs = out.segments;
  const ok =
    out.agree === true &&
    segs.length === want.length &&
    segs.every(
      (s, i) =>
        Math.abs(s.scale - want[i].scale) < 0.000005 + 1e-9 && Math.abs(s.offset - want[i].offset) <= 0.01 + 1e-9,
    );
  check(`align.ts ${name}`, ok, {
    method: out.method,
    agree: out.agree,
    score: out.score,
    segments: segs.map((s) => ({ scale: s.scale, offset: s.offset })),
    ms: out.ms,
  });
}

// ---------------------------------------------------------------------------- preview.sh
const preview = join(WORK, 'preview');
run('bash', [join(PIPE, 'preview.sh'), join(FIX, 'clip.hevc10.mp4'), preview, '480']);
{
  const p = probe(join(preview, 'proxy.mp4'), ['-show_streams']);
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const audio = probe(join(preview, 'audio.m4a'), ['-show_streams']).streams;
  // Seconds, not raw pts (time bases may differ). Side data on a frame adds CSV columns, so keep
  // only the first field of each line.
  const ts = (file) =>
    run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file])
      .trim()
      .split('\n')
      .map((l) => l.split(',')[0])
      .join('\n');
  const srcTs = ts(join(FIX, 'clip.hevc10.mp4'));
  const proxyTs = ts(join(preview, 'proxy.mp4'));
  check(
    'preview.sh proxy.mp4 is H.264 + stereo AAC',
    v?.codec_name === 'h264' && v?.pix_fmt === 'yuv420p' && a?.codec_name === 'aac' && a?.channels === 2,
    {
      video: `${v?.codec_name} ${v?.pix_fmt} ${v?.width}x${v?.height}`,
      audio: `${a?.codec_name} ${a?.channels}ch`,
    },
  );
  check(
    'preview.sh audio.m4a exists (AAC stereo)',
    audio.length === 1 && audio[0].codec_name === 'aac' && audio[0].channels === 2,
    {
      audio: audio.map((s) => `${s.codec_name} ${s.channels}ch`),
    },
  );
  check('preview.sh every frame timestamp equals the source', srcTs === proxyTs, {
    frames: `${srcTs.split('\n').length} vs ${proxyTs.split('\n').length}`,
  });
}

// ---------------------------------------------------------------------------- mux.sh
const mkv = join(WORK, 'out.mkv');
run(
  'bash',
  [
    join(PIPE, 'mux.sh'),
    join(FIX, 'clip.mp4'),
    mkv,
    join(FIX, 'truth.zh-TW.srt'),
    'chi',
    '繁體中文',
    join(FIX, 'truth.en.srt'),
    'eng',
    'English',
  ],
  {
    env: { ...process.env, TITLE: 'Sample Clip (2026)' },
  },
);
{
  const p = probe(mkv, ['-show_streams', '-show_format']);
  const kinds = p.streams.map((s) => s.codec_type);
  const subs = p.streams.filter((s) => s.codec_type === 'subtitle');
  const tagsOk =
    subs.length === 2 &&
    subs[0].tags?.language === 'chi' &&
    subs[0].tags?.title === '繁體中文' &&
    subs[0].disposition?.default === 1 &&
    subs[1].tags?.language === 'eng' &&
    subs[1].tags?.title === 'English' &&
    subs[1].disposition?.default === 0;
  check(
    'mux.sh one video, one audio, two subtitles',
    kinds.filter((k) => k === 'video').length === 1 &&
      kinds.filter((k) => k === 'audio').length === 1 &&
      subs.length === 2,
    { kinds },
  );
  check('mux.sh language tags and default track', tagsOk, {
    subs: subs.map((s) => ({ lang: s.tags?.language, title: s.tags?.title, default: s.disposition?.default })),
    title: p.format.tags?.title ?? p.format.tags?.TITLE,
  });
  // Only the payload hashes: timestamps legitimately shift (the MKV starts at 0, the MP4's AAC at
  // -46 ms) and side data such as "Skip Samples" adds CSV columns.
  const hashes = (file, sel) =>
    run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      sel,
      '-show_packets',
      '-show_data_hash',
      'sha256',
      '-show_entries',
      'packet=data_hash',
      '-of',
      'csv=p=0',
      file,
    ])
      .match(/SHA256:[0-9a-f]{64}/g)
      ?.join('\n') ?? '';
  check('mux.sh video packets identical to the source', hashes(join(FIX, 'clip.mp4'), 'v:0') === hashes(mkv, 'v:0'));
  check('mux.sh audio packets identical to the source', hashes(join(FIX, 'clip.mp4'), 'a:0') === hashes(mkv, 'a:0'));
}

const versions = {
  ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
  node: process.version,
};
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ versions, passed: results.length - failed.length, failed: failed.map((f) => f.name) }));
process.exit(failed.length ? 1 : 0);
