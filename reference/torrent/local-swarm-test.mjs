// Hermetic WebTorrent check: one client seeds a local file, another downloads it by info hash
// over 127.0.0.1 with every discovery mechanism off. No tracker, no DHT, no internet.
// It exercises what the torrent worker relies on: add by info hash, metadata from the peer,
// progress, "pause" by removing the torrent while keeping its files, fast resume from a saved
// bitfield, completion, and deleting the files.
import WebTorrent from 'webtorrent'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const OFF = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utPex: false }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-'))
const srcDir = path.join(work, 'seed'), dstDir = path.join(work, 'leech')
fs.mkdirSync(srcDir); fs.mkdirSync(dstDir)
const SIZE = 24 * 1024 * 1024
const srcFile = path.join(srcDir, 'Sample.Movie.2020.1080p.mp4')
fs.writeFileSync(srcFile, crypto.randomBytes(SIZE))
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const log = (...a) => console.log(new Date().toISOString().slice(17, 23), ...a)
const fail = (m) => { console.error('FAIL:', m); process.exit(1) }
const once = (em, ev) => new Promise((res) => em.once(ev, res))

const seeder = new WebTorrent({ ...OFF, torrentPort: 51801 })
seeder.on('error', (e) => fail('seeder ' + e.message))
const seeded = await new Promise((res) => seeder.seed(srcFile, { announce: [] }, res))
const infoHash = seeded.infoHash
log('seeding', seeded.name, 'pieces', seeded.pieces.length, 'pieceLength', seeded.pieceLength, 'infoHash', infoHash)

// ---- 1. add by info hash only, as the worker does with a hash that came from YTS ----
let leecher = new WebTorrent({ ...OFF, torrentPort: 51802, downloadLimit: 4 * 1024 * 1024 })
leecher.on('error', (e) => fail('leecher ' + e.message))
let t = leecher.add(infoHash, { path: dstDir, announce: [] })
t.on('warning', (w) => log('warning', w.message))
await once(t, 'infoHash')               // addPeer() throws before this event
t.addPeer('127.0.0.1:51801')
await once(t, 'metadata')
log('metadata: name', t.name, '| length', t.length, '| files', t.files.map((f) => f.path + ':' + f.length).join(', '))
if (t.length !== SIZE) fail('length mismatch')

// ---- 2. download part of it, then "pause" = remember the bitfield and drop the torrent, keeping files ----
await new Promise((res) => { const iv = setInterval(() => { if (t.progress >= 0.35) { clearInterval(iv); res() } }, 50) })
const saved = Buffer.from(t.bitfield.buffer)
const have = () => { let n = 0; for (let i = 0; i < t.pieces.length; i++) if (t.bitfield.get(i)) n++; return n }
const haveAtPause = have()
log('pausing at', (t.progress * 100).toFixed(0) + '%', '| pieces', haveAtPause + '/' + t.pieces.length, '| speed', (t.downloadSpeed / 1048576).toFixed(1), 'MB/s', '| bitfield bytes', saved.length)
await new Promise((res) => t.destroy({ destroyStore: false }, res))
await new Promise((res) => leecher.destroy(res))
const partial = path.join(dstDir, 'Sample.Movie.2020.1080p.mp4')
if (!fs.existsSync(partial)) fail('partial file is gone after destroy({destroyStore:false})')
log('after pause: file on disk', fs.statSync(partial).size, 'bytes (sparse/partial)')

// ---- 3. resume in a brand-new client (as after a container restart) from the saved bitfield ----
leecher = new WebTorrent({ ...OFF, torrentPort: 51802, downloadLimit: 4 * 1024 * 1024 })
leecher.on('error', (e) => fail('leecher2 ' + e.message))
const t0 = Date.now()
t = leecher.add(infoHash, { path: dstDir, announce: [], bitfield: saved })
await once(t, 'infoHash')
t.addPeer('127.0.0.1:51801')
await once(t, 'ready')
const haveAtResume = (() => { let n = 0; for (let i = 0; i < t.pieces.length; i++) if (t.bitfield.get(i)) n++; return n })()
log('resumed: ready after', Date.now() - t0, 'ms | pieces already had', haveAtResume + '/' + t.pieces.length, '| progress', (t.progress * 100).toFixed(0) + '%')
if (haveAtResume < haveAtPause) fail('resume lost pieces: ' + haveAtResume + ' < ' + haveAtPause)
let bytesAfterResume = 0
t.on('download', (n) => { bytesAfterResume += n })
if (!t.done) await once(t, 'done')
log('done | downloaded after resume', (bytesAfterResume / 1048576).toFixed(1), 'MB of', (SIZE / 1048576), 'MB | ratio', t.ratio.toFixed(2))
if (sha(partial) !== sha(srcFile)) fail('content differs from the source')
log('sha256 matches the source')

// ---- 4. a finished torrent re-added with skipVerify is ready at once ----
await new Promise((res) => t.destroy({ destroyStore: false }, res))
const t1 = Date.now()
t = leecher.add(infoHash, { path: dstDir, announce: [], skipVerify: true })
await once(t, 'infoHash')
t.addPeer('127.0.0.1:51801')
await once(t, 'ready')
log('re-added finished torrent with skipVerify: ready after', Date.now() - t1, 'ms | done =', t.done, '| progress', t.progress)

// ---- 5. removing with destroyStore deletes the files ----
await new Promise((res) => leecher.remove(infoHash, { destroyStore: true }, res))
log('after remove({destroyStore:true}): file exists =', fs.existsSync(partial), '| dir entries', fs.readdirSync(dstDir))
await new Promise((res) => leecher.destroy(res))
await new Promise((res) => seeder.destroy(res))
fs.rmSync(work, { recursive: true, force: true })
log('PASS')
process.exit(0)
