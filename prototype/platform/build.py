"""Assembles the platform prototype into one HTML file.

    python3 build.py           -> index.html         (H.264 clip embedded; open it in a browser)
    python3 build.py --webm    -> preview_webm.html  (VP9 clip; for e2e.cjs, because the Chromium that
                                                      Playwright bundles cannot decode H.264)

Sources are in src/. The clip comes from ../../fixtures/.
"""
import base64
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / 'src'
FIX = HERE.parent.parent / 'fixtures'
read = lambda name: (SRC / name).read_text(encoding='utf-8')

webm = '--webm' in sys.argv
clip_file, mime = (FIX / 'clip.webm', 'video/webm') if webm else (FIX / 'clip.mp4', 'video/mp4')
clip = f'data:{mime};base64,' + base64.b64encode(clip_file.read_bytes()).decode()

app = '\n'.join(read(f) for f in ('app1.js', 'app2.js', 'app3.js', 'app4.js'))
assert '</script>' not in app
html = read('page.html')
parts = {'/*__APPCSS__*/': read('app.css'), '/*__BENCHCSS__*/': read('bench.css'), '<!--__BENCH__-->': read('bench.html'),
         '/*__DATA__*/': read('data.json'), '/*__CLIP__*/': clip, '/*__CORE__*/': read('core.js'),
         '/*__SCENARIOS__*/': read('scenarios.js'), '/*__BENCHUI__*/': read('bench-ui.js'), '/*__APP__*/': app}
for marker, text in parts.items():
    assert marker in html, marker
    html = html.replace(marker, text)

# page.html starts with <title>, the font <link> and one <style> block: that is the head.
head, body = html.split('</style>\n', 1)
page = ('<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<style>html,body{height:100%}body{margin:0}[hidden]{display:none!important}</style>\n'
        + head + '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
out = HERE / ('preview_webm.html' if webm else 'index.html')
out.write_text(page, encoding='utf-8')
print(out.name, len(page.encode()), 'bytes')
