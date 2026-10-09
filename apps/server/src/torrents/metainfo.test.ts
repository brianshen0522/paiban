import { createHash } from 'node:crypto';
import bencode from 'bencode';
import { describe, expect, it } from 'vitest';
import {
  chosenFile,
  decodeMetainfo,
  guessVersion,
  MetainfoError,
  readMagnet,
  readTorrentFile,
  safeTrackers,
} from './metainfo.js';

/** A small multi-file .torrent, built by hand: a film, a sample and a text file. */
function torrentFile(extra: Record<string, unknown> = {}): { buf: Buffer; hash: string } {
  const info = {
    name: 'Night.of.the.Living.Dead.1968.1080p.BluRay.x264',
    'piece length': 16384,
    pieces: Buffer.alloc(20 * 3),
    files: [
      { length: 30000, path: ['Night.1968.1080p.mp4'] },
      { length: 9000, path: ['Sample', 'sample.mkv'] },
      { length: 120, path: ['readme.txt'] },
    ],
  };
  const hash = createHash('sha1').update(bencode.encode(info)).digest('hex');
  const buf = Buffer.from(
    bencode.encode({
      announce: 'udp://tracker.example.org:1337/announce',
      'announce-list': [['udp://tracker.example.org:1337/announce'], ['http://192.168.1.2/announce']],
      'url-list': ['http://10.0.0.5/seed/'],
      info,
      ...extra,
    }),
  );
  return { buf, hash };
}

describe('reading what someone gives by hand', () => {
  it('reads a .torrent file, keeps only the info dictionary and public trackers', async () => {
    const { buf, hash } = torrentFile();
    const { meta, trackers } = await readTorrentFile(buf);
    expect(meta.infoHash).toBe(hash);
    expect(meta.files.map((f) => f.path)).toEqual([
      expect.stringMatching(/Night\.1968\.1080p\.mp4$/),
      expect.stringMatching(/sample\.mkv$/),
      expect.stringMatching(/readme\.txt$/),
    ]);
    expect(meta.length).toBe(39120);
    expect(trackers).toEqual(['udp://tracker.example.org:1337/announce']);
    // The stored form is {info} only: no web seeds, no trackers.
    const stored = bencode.decode(new Uint8Array(meta.metainfo)) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['info']);
    expect((await decodeMetainfo(meta.metainfo)).infoHash).toBe(hash);
    expect(chosenFile(meta)?.path).toMatch(/Night\.1968\.1080p\.mp4$/);
  });

  it('refuses what is not a torrent, or too large', async () => {
    await expect(readTorrentFile(Buffer.from('hello'))).rejects.toBeInstanceOf(MetainfoError);
    await expect(readTorrentFile(Buffer.alloc(5 * 1024 * 1024))).rejects.toMatchObject({ code: 'BAD_TORRENT' });
  });

  it('reads a magnet link, hex or base32, and drops unsafe trackers', async () => {
    const hex = 'c9e15763f722f23e98a29decdfae341b98d53056';
    const m = await readMagnet(
      `magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=x&tr=${encodeURIComponent('udp://open.example.com:80')}&tr=${encodeURIComponent('http://127.0.0.1:9000/a')}&ws=${encodeURIComponent('http://10.1.1.1/x')}`,
    );
    expect(m).toEqual({ infoHash: hex, trackers: ['udp://open.example.com:80'] });
    const b32 = await readMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW');
    expect(b32.infoHash).toBe(hex);
    await expect(readMagnet('https://example.com/x.torrent')).rejects.toMatchObject({ code: 'BAD_MAGNET' });
    await expect(readMagnet('magnet:?xt=urn:sha1:abc')).rejects.toMatchObject({ code: 'BAD_MAGNET' });
  });

  it('keeps udp, http(s) and ws(s) trackers on public hosts only', () => {
    expect(
      safeTrackers([
        'udp://a.example.org:6969',
        'udp://a.example.org:6969',
        'http://localhost/announce',
        'http://intranet/announce',
        'http://[::1]/a',
        'http://172.20.0.3/a',
        'http://user:pw@b.example.org/a',
        'file:///etc/passwd',
        'wss://c.example.org/a',
      ]),
    ).toEqual(['udp://a.example.org:6969', 'wss://c.example.org/a']);
  });

  it('guesses the version from the release name', () => {
    expect(guessVersion('Movie.2019.2160p.UHD.BluRay.x265.10bit-GRP')).toEqual({
      quality: '2160p',
      source: 'bluray',
      videoCodec: 'x265',
      bitDepth: 10,
    });
    expect(guessVersion('Movie 2019 720p WEB-DL H264')).toEqual({
      quality: '720p',
      source: 'web',
      videoCodec: 'x264',
      bitDepth: 8,
    });
    expect(guessVersion('home video')).toEqual({ quality: '', source: '', videoCodec: '', bitDepth: 8 });
  });
});
