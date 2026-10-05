import { describe, expect, it } from 'vitest';
import { audioCanBeCopied, directPlay, parseProbe } from './probe.js';

const probe = (streams: object[], format = 'mov,mp4,m4a,3gp,3g2,mj2') =>
  parseProbe({ streams, format: { format_name: format, duration: '92.4' } });
const h264 = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', avg_frame_rate: '24000/1001' };
const aac = { codec_type: 'audio', codec_name: 'aac', channels: 2, bit_rate: '128000' };

describe('can the browser play it (docs/08)', () => {
  it('plays H.264 8-bit with AAC or MP3 in MP4, or without audio', () => {
    expect(directPlay(probe([h264, aac]), 'a.mp4')).toBe(true);
    expect(directPlay(probe([h264, { codec_type: 'audio', codec_name: 'mp3' }]), 'a.mp4')).toBe(true);
    expect(directPlay(probe([h264]), 'a.mp4')).toBe(true);
  });
  it('does not play HEVC, 10-bit, other audio, or anything in MKV', () => {
    expect(directPlay(probe([{ ...h264, codec_name: 'hevc' }, aac]), 'a.mp4')).toBe(false);
    expect(directPlay(probe([{ ...h264, pix_fmt: 'yuv420p10le' }, aac]), 'a.mp4')).toBe(false);
    expect(directPlay(probe([h264, { codec_type: 'audio', codec_name: 'ac3' }]), 'a.mp4')).toBe(false);
    expect(directPlay(probe([h264, aac], 'matroska,webm'), 'a.mkv')).toBe(false);
  });
  it('plays VP9 with Opus in WebM, told from MKV by the extension', () => {
    const vp9 = { codec_type: 'video', codec_name: 'vp9', pix_fmt: 'yuv420p' };
    const opus = { codec_type: 'audio', codec_name: 'opus' };
    expect(directPlay(probe([vp9, opus], 'matroska,webm'), 'a.webm')).toBe(true);
    expect(directPlay(probe([vp9, opus], 'matroska,webm'), 'a.mkv')).toBe(false);
  });
  it('ignores cover art when looking for the video stream', () => {
    const cover = { codec_type: 'video', codec_name: 'mjpeg', pix_fmt: 'yuvj420p', disposition: { attached_pic: 1 } };
    expect(parseProbe({ streams: [cover, h264, aac], format: {} }).videoCodec).toBe('h264');
  });
  it('copies only small stereo AAC into the audio file', () => {
    expect(audioCanBeCopied(probe([h264, aac]))).toBe(true);
    expect(audioCanBeCopied(probe([h264, { ...aac, channels: 6 }]))).toBe(false);
    expect(audioCanBeCopied(probe([h264, { ...aac, bit_rate: '192000' }]))).toBe(false);
  });
});
