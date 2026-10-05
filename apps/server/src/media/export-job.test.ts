import { describe, expect, it } from 'vitest';
import { trackTag } from '../exports/view.js';
import { muxArgs } from './export-job.js';

describe('the mux command', () => {
  it('is reference/pipeline/mux.sh, option for option', () => {
    const args = muxArgs(
      '/data/torrents/h/movie.mp4',
      '/data/exports/e/out.mkv.part',
      [
        { file: 't/0.srt', ...trackTag('zh-Hant') },
        { file: 't/1.srt', ...trackTag('en') },
      ],
      'Sample Movie (2020)',
    );
    expect(args.join(' ')).toBe(
      [
        '-v error -nostdin -y -progress pipe:1 -nostats',
        '-i /data/torrents/h/movie.mp4 -i t/0.srt -i t/1.srt',
        '-map 0:V -map 0:a? -map 1:0 -map 2:0 -c copy',
        '-metadata:s:s:0 language=chi -metadata:s:s:0 title=繁體中文 -disposition:s:0 default',
        '-metadata:s:s:1 language=eng -metadata:s:s:1 title=English -disposition:s:1 0',
        '-metadata title=Sample Movie (2020)',
        '-f matroska /data/exports/e/out.mkv.part',
      ].join(' '),
    );
  });

  it('tags languages as docs/08 lists them', () => {
    expect(trackTag('zh')).toEqual({ language: 'chi', title: '繁體中文' });
    expect(trackTag('zh-Hans')).toEqual({ language: 'chi', title: '简体中文' });
    expect(trackTag('und')).toEqual({ language: 'und', title: 'und' });
  });
});
