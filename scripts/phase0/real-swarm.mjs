#!/usr/bin/env node
// Phase 0, item 5 (docs/14-plan.md): a real BitTorrent download of a freely redistributable film,
// to see how DHT, trackers and the incoming port behave where the site will run, and that pause,
// resume and a hard kill followed by a restart all work against the public swarm. The downloaded
// films (with their official subtitles) are also the material for items 6 and 7.
//
// Standalone on purpose: it is not part of the product, the product never gets a "download any
// torrent" entry point (D26), and this script is not copied into the image. The only torrent it
// knows is Blender Foundation's *Sintel* (CC BY 3.0), info hash taken from the WebTorrent docs
// (https://webtorrent.io/docs, 2026-10-05). The webseed in that page's magnet link is left out on
// purpose so that the data has to come from BitTorrent peers. `--film tears-of-steel` takes the
// other Blender film from https://webtorrent.io/free-torrents (CC BY 3.0), which has more dialogue.
//
//   cd scripts/phase0 && npm ci
//   node real-swarm.mjs [--film sintel|tears-of-steel] [--dir <download dir>] [--port 51413] [--dht-port 51414]
//
// Flow, each step in a fresh child process (as after a container restart):
//   A  add by info hash → metadata → download to ~25 % → "pause" (save bitfield, destroy, keep files)
//   B  resume with the saved bitfield → check it is ready at once and keeps its pieces → ~55 %
//      → SIGKILL (no bitfield saved, like a crash)
//   C  restart without a bitfield → WebTorrent re-verifies the files → download to the end
// Prints one JSON summary at the end; the files stay in --dir (used by items 6 and 7).

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILMS = {
  sintel: { hash: '08ada5a7a6183aae1e09d831df6748d566095a10', name: 'Sintel' },
  'tears-of-steel': { hash: '209c8226b299b308beaf2b9cd3fb49212dbd13ec', name: 'Tears+of+Steel' },
};
// The tracker list in docs/05-yts.md (written from memory; this run checks which still answer).
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://p4p.arenabg.com:1337',
];

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const FILM = FILMS[opt('--film', 'sintel')];
if (!FILM) throw new Error(`--film must be one of ${Object.keys(FILMS).join(', ')}`);
const INFO_HASH = FILM.hash;
const DIR = resolve(opt('--dir', join(HERE, '..', '..', '.scratch', opt('--film', 'sintel'))));
const PORT = Number(opt('--port', 51413));
const DHT_PORT = Number(opt('--dht-port', 51414));
const STATE = join(DIR, '.phase0-state');

if (argv[0] === 'worker') await worker();
else await orchestrate();

// ------------------------------------------------------------------------------------- worker
async function worker() {
  const { default: WebTorrent } = await import('webtorrent');
  const useBitfield = argv.includes('--bitfield');
  const emit = (o) => process.stdout.write(`${JSON.stringify({ t: Date.now(), ...o })}\n`);

  const client = new WebTorrent({
    torrentPort: PORT,
    dhtPort: DHT_PORT,
    natUpnp: false,
    natPmp: false,
    lsd: false,
    maxConns: 55,
  });
  client.on('error', (e) => {
    emit({ ev: 'clientError', message: String(e?.message ?? e) });
    process.exit(2);
  });

  let bitfield;
  if (useBitfield) bitfield = await readFile(join(STATE, 'bitfield.bin')).catch(() => undefined);
  const magnet = `magnet:?xt=urn:btih:${INFO_HASH}&dn=${FILM.name}&${TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join('&')}`;
  const added = Date.now();
  const t = client.add(magnet, { path: DIR, ...(bitfield ? { bitfield } : {}) });

  const wires = {};
  const trackers = {};
  let incomingAt = null;
  t.on('infoHash', () => emit({ ev: 'infoHash' }));
  t.on('metadata', () =>
    emit({
      ev: 'metadata',
      ms: Date.now() - added,
      name: t.name,
      length: t.length,
      pieces: t.pieces.length,
      files: t.files.map((f) => [f.path, f.length]),
    }),
  );
  t.on('ready', () =>
    emit({ ev: 'ready', ms: Date.now() - added, have: have(t), pieces: t.pieces.length, progress: t.progress }),
  );
  t.on('wire', (wire) => {
    const type = wire.type ?? 'unknown';
    wires[type] = (wires[type] ?? 0) + 1;
    if (type === 'tcpIncoming' || type === 'utpIncoming') incomingAt = Date.now();
  });
  t.on('trackerAnnounce', () => {
    trackers.announces = (trackers.announces ?? 0) + 1;
  });
  t.on('dhtAnnounce', () => {
    trackers.dhtAnnounces = (trackers.dhtAnnounces ?? 0) + 1;
  });
  t.on('warning', (w) => emit({ ev: 'warning', message: String(w?.message ?? w).slice(0, 200) }));
  t.on('noPeers', (src) => emit({ ev: 'noPeers', src }));
  t.on('error', (e) => emit({ ev: 'torrentError', message: String(e?.message ?? e) }));
  t.on('done', () => emit({ ev: 'done', ms: Date.now() - added }));

  const timer = setInterval(() => {
    emit({
      ev: 'progress',
      progress: Number(t.progress.toFixed(4)),
      downloaded: t.downloaded,
      speed: t.downloadSpeed,
      peers: t.numPeers,
      wires,
      trackers,
      dhtNodes: client.dht?.toJSON?.().nodes?.length ?? null,
      incomingAt,
      verifying: !t.ready,
    });
  }, 2000);

  // "pause" from the orchestrator: what docs/06-torrent-worker.md does for a real pause.
  process.stdin.on('data', async (buf) => {
    if (buf.toString().trim() !== 'pause') return;
    clearInterval(timer);
    await mkdir(STATE, { recursive: true });
    await writeFile(join(STATE, 'bitfield.bin'), Buffer.from(t.bitfield.buffer));
    const at = have(t);
    await new Promise((r) => t.destroy({ destroyStore: false }, r));
    await new Promise((r) => client.destroy(r));
    emit({ ev: 'paused', have: at });
    process.exit(0);
  });
}

function have(t) {
  if (!t.bitfield || !t.pieces) return 0;
  let n = 0;
  for (let i = 0; i < t.pieces.length; i++) if (t.bitfield.get(i)) n++;
  return n;
}

// ------------------------------------------------------------------------------- orchestrator
async function orchestrate() {
  await mkdir(DIR, { recursive: true });
  const summary = { infoHash: INFO_HASH, dir: DIR, port: PORT, dhtPort: DHT_PORT, steps: {} };
  const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

  function run(args, { until, onLine }) {
    return new Promise((res) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', ...argv, ...args], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const events = [];
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let i = buf.indexOf('\n');
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          i = buf.indexOf('\n');
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          events.push(e);
          onLine?.(e, child);
          if (until(e, child)) {
            /* the predicate acts on the child itself */
          }
        }
      });
      child.on('exit', (code, signal) => res({ code, signal, events }));
    });
  }

  const pick = (events, ev) => events.filter((e) => e.ev === ev);
  const lastProgress = (events) => pick(events, 'progress').at(-1);
  const printProgress = (e) => {
    if (e.ev === 'progress')
      log(
        `${(e.progress * 100).toFixed(1)}%  ${(e.speed / 1e6).toFixed(2)} MB/s  peers ${e.peers}  wires ${JSON.stringify(e.wires)}  dht ${e.dhtNodes}`,
      );
    else if (e.ev !== 'warning') log(JSON.stringify(e).slice(0, 300));
  };
  const STEP_LIMIT_MS = 30 * 60_000;

  // A: fresh download → pause at 25 %
  log('step A: add by info hash, download to 25 %, then pause');
  const started = Date.now();
  const a = await run([], {
    onLine: printProgress,
    until: (e, child) => {
      if ((e.ev === 'progress' && e.progress >= 0.25) || Date.now() - started > STEP_LIMIT_MS) {
        child.stdin.write('pause\n');
        return true;
      }
      return false;
    },
  });
  summary.steps.A = {
    metadataMs: pick(a.events, 'metadata')[0]?.ms ?? null,
    metadata: pick(a.events, 'metadata')[0] ?? null,
    pausedHave: pick(a.events, 'paused')[0]?.have ?? null,
    last: lastProgress(a.events) ?? null,
    warnings: [...new Set(pick(a.events, 'warning').map((w) => w.message))].slice(0, 20),
    noPeers: pick(a.events, 'noPeers').map((e) => e.src),
    exit: a.code,
  };
  if (!summary.steps.A.pausedHave) return finish();

  // B: resume with bitfield → 55 % → SIGKILL
  log('step B: resume from the saved bitfield, download to 55 %, then SIGKILL');
  const b = await run(['--bitfield'], {
    onLine: printProgress,
    until: (e, child) => {
      if (e.ev === 'progress' && e.progress >= 0.55) {
        child.kill('SIGKILL');
        return true;
      }
      return false;
    },
  });
  const readyB = pick(b.events, 'ready')[0];
  summary.steps.B = {
    readyMs: readyB?.ms ?? null,
    haveAtReady: readyB?.have ?? null,
    keptPieces: readyB ? readyB.have >= summary.steps.A.pausedHave : null,
    last: lastProgress(b.events) ?? null,
    signal: b.signal,
  };

  // C: restart without bitfield (as after a crash) → re-verify → done
  log('step C: restart without a bitfield (after a crash), let it verify and finish');
  const c = await run([], {
    onLine: printProgress,
    until: (e, child) => {
      if (e.ev === 'done') {
        setTimeout(() => child.kill('SIGTERM'), 1000);
        return true;
      }
      return false;
    },
  });
  const readyC = pick(c.events, 'ready')[0];
  summary.steps.C = {
    verifyReadyMs: readyC?.ms ?? null,
    haveAfterVerify: readyC?.have ?? null,
    done: pick(c.events, 'done')[0] ?? null,
    last: lastProgress(c.events) ?? null,
  };
  return finish();

  async function finish() {
    summary.totalMs = Date.now() - started;
    await mkdir(STATE, { recursive: true });
    await writeFile(join(STATE, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  }
}
