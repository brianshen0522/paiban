"""Rebuilds the subtitle fixtures from data.json and records what ffsubsync does with them.

Run from this folder with the Python that has ffsubsync installed:

    FFSUBSYNC=/path/to/ffsubsync python make_fixtures.py

late.zh-CN.srt is made separately by make_simplified.mjs (it needs opencc-js); run that first
if the Traditional lines change. clip.mp4 and data.json are not rebuilt here: they are the
synthetic source everything else is derived from.
"""
import datetime as dt
import json
import os
import re
import subprocess
import tempfile
import zipfile

import srt  # installed together with ffsubsync

FFS = os.environ.get('FFSUBSYNC', 'ffsubsync')
D = json.load(open('data.json', encoding='utf-8'))
cues = D['cues']

# The three ways a downloaded subtitle is typically wrong. f(t, cue_index) -> wrong time.
SCENARIOS = {
    'late': lambda t, i: t + 2.4,                              # whole subtitle 2.4 s late
    'rate': lambda t, i: t * (23.976 / 25) + 0.8,              # made for a 25 fps release
    'cut': lambda t, i: t - 1.2 if i < 13 else t - 13.2,       # its cut lacks a 12 s scene after line 13
}


def td(seconds):
    return dt.timedelta(seconds=seconds)


def write_srt(path, f, key):
    subs = [srt.Subtitle(c['id'], td(f(c['start'], i)), td(f(c['end'], i)), c[key]) for i, c in enumerate(cues)]
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(srt.compose(subs, reindex=False))


write_srt('truth.zh-TW.srt', lambda t, i: t, 'zh')
write_srt('truth.en.srt', lambda t, i: t, 'en')
for name, f in SCENARIOS.items():
    write_srt(f'{name}.zh-TW.srt', f, 'zh')

# --- encodings -------------------------------------------------------------------------
late = open('late.zh-TW.srt', encoding='utf-8').read()
open('late.zh-TW.big5.srt', 'wb').write(late.encode('big5'))
open('late.zh-TW.utf16le-bom.srt', 'wb').write(b'\xff\xfe' + late.replace('\n', '\r\n').encode('utf-16-le'))
if os.path.exists('late.zh-CN.srt'):
    open('late.zh-CN.gb18030.srt', 'wb').write(open('late.zh-CN.srt', encoding='utf-8').read().encode('gb18030'))

# --- other formats ---------------------------------------------------------------------
def ass_time(t):
    cs = round(t * 100)
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


f = SCENARIOS['late']
ass = ['[Script Info]', 'Title: Paiban fixture', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720', '',
       '[V4+ Styles]',
       'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
       'Style: Default,Noto Sans TC,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,30,1',
       'Style: Sign,Noto Sans TC,36,&H0000FFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,8,30,30,30,1', '',
       '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
       'Comment: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,translator note, must be ignored',
       'Dialogue: 0,0:00:00.50,0:00:02.50,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}']
for i, c in enumerate(cues):
    text = c['zh'] + '\\N{\\fs28\\i1}' + c['en'] + '{\\i0}'
    ass.append(f"Dialogue: 0,{ass_time(f(c['start'], i))},{ass_time(f(c['end'], i))},Default,,0,0,0,,{text}")
open('late.bilingual.ass', 'w', encoding='utf-8-sig', newline='\r\n').write('\n'.join(ass) + '\n')

vtt = ['WEBVTT', '']
for i, c in enumerate(cues):
    a, b = srt.timedelta_to_srt_timestamp(td(f(c['start'], i))), srt.timedelta_to_srt_timestamp(td(f(c['end'], i)))
    vtt += [f"{a.replace(',', '.')} --> {b.replace(',', '.')}", c['en'], '']
open('late.en.vtt', 'w', encoding='utf-8', newline='\n').write('\n'.join(vtt))

# --- an archive the way subtitle sites ship them ----------------------------------------
with zipfile.ZipFile('archive.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('Sample.Movie.2020.1080p.BluRay.x264.YIFY.cht.srt', late.encode('big5'))
    z.writestr('Sample.Movie.2020.1080p.BluRay.x264.YIFY.eng.srt', open('truth.en.srt', 'rb').read())
    z.writestr('readme.txt', 'Downloaded from an example subtitle site.\n')
    z.writestr('__MACOSX/._junk', b'\x00\x05\x16\x07')

# --- what ffsubsync does with the wrong subtitles ----------------------------------------
def run(args):
    r = subprocess.run([FFS] + args, capture_output=True, text=True)
    log = r.stderr
    g = lambda p: re.findall(p, log)
    return {'offset_seconds': [float(x) for x in g(r'offset seconds: (-?[\d.]+)')],
            'framerate_scale': [float(x) for x in g(r'framerate scale factor: ([\d.]+)')],
            'segments': [{'cues': int(a), 'offset_seconds': float(b)} for a, b in g(r'(\d+) cue\(s\) offset (-?[\d.]+)s')]}


def starts(path):
    return [s.start.total_seconds() for s in srt.parse(open(path, encoding='utf-8').read())]


truth = starts('truth.zh-TW.srt')
out = {}
os.makedirs('ffsubsync', exist_ok=True)
with tempfile.TemporaryDirectory() as tmp:
    ref = os.path.join(tmp, 'clip.mp4')
    os.symlink(os.path.abspath('clip.mp4'), ref)          # the speech cache is written next to the reference path
    subprocess.run([FFS, ref, '--serialize-speech', '--vad', 'webrtc'], stdin=subprocess.DEVNULL, capture_output=True, check=True)
    os.replace(os.path.join(tmp, 'clip.npz'), 'clip.npz')
for name in SCENARIOS:
    for mode, extra in (('linear', []), ('split', ['--split-penalty'])):
        dst = f'ffsubsync/{name}.{mode}.out.srt'
        res = run(['clip.npz', '-i', f'{name}.zh-TW.srt', '-o', dst] + extra)
        err = sorted(abs(a - b) for a, b in zip(starts(dst), truth))
        res.update(within_100ms=sum(e <= 0.1 for e in err), within_250ms=sum(e <= 0.25 for e in err), cues=len(err), max_error_ms=round(err[-1] * 1000))
        out[f'{name}.{mode}'] = res
        print(f'{name}.{mode}', res)
json.dump({'tool': 'ffsubsync 0.5.1, speech cached from clip.mp4 with --vad webrtc',
           'note': 'A 92-second clip is too short for the speed search to be reliable on its own; see docs/08-media-pipeline.md.',
           'results': out}, open('expected.ffsubsync.json', 'w', encoding='utf-8'), indent=1)
