#!/usr/bin/env bash
# Phase 0, item 3 (docs/14-plan.md): RAR and 7z versions of fixtures/archive.zip, plus the hostile
# archives the upload checks must reject (docs/12-auth.md, docs/07-subtitle-providers.md).
#
#   scripts/phase0/make-archives.sh
#
# RAR can only be written by RARLAB's proprietary `rar`, which Debian ships in non-free. It is
# installed in a throwaway Debian container, never on the host and never in the product image
# (the product only reads archives, with bsdtar). The files land in fixtures/archives/.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=fixtures/archives
mkdir -p "$OUT"

docker run --rm -i -v "$PWD":/work -w /work -u 0 debian:trixie-slim bash -s "$(id -u)" "$(id -g)" <<'EOF'
set -euo pipefail
uid=$1; gid=$2
sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources
apt-get update -qq >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends rar 7zip python3 >/dev/null
OUT=/work/fixtures/archives
SRC=$(mktemp -d)
cd "$SRC"
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('/work/fixtures/archive.zip')
for n in z.namelist():
    import os
    os.makedirs(os.path.dirname(n) or '.', exist_ok=True)
    open(n, 'wb').write(z.read(n))
PY
files=(*.srt readme.txt __MACOSX/._junk)
rm -f "$OUT"/archive.rar "$OUT"/archive.7z
# RAR5, what current WinRAR writes. rar 7 can no longer write the older RAR 2.9/4 format (-ma4 is
# gone), so there is no RAR4 sample; libarchive has read RAR4 far longer than RAR5.
rar a -ma5 -idq "$OUT/archive.rar" "${files[@]}"
7z a -bso0 -bsp0 "$OUT/archive.7z" "${files[@]}"

# Hostile archives. Each holds one harmless subtitle plus the thing that must be refused.
H=$(mktemp -d); cd "$H"
cp "$SRC/Sample.Movie.2020.1080p.BluRay.x264.YIFY.eng.srt" ok.srt
python3 - "$OUT" <<'PY'
import sys, zipfile, io
out = sys.argv[1]
ok = open('ok.srt', 'rb').read()
# 1. path traversal
with zipfile.ZipFile(f'{out}/hostile.traversal.zip', 'w') as z:
    z.writestr('ok.srt', ok)
    z.writestr('../../escaped.srt', ok)
# 2. absolute path
with zipfile.ZipFile(f'{out}/hostile.absolute.zip', 'w') as z:
    z.writestr('ok.srt', ok)
    z.writestr('/tmp/absolute.srt', ok)
# 3. symlink entry pointing outside (unix mode 0o120777)
with zipfile.ZipFile(f'{out}/hostile.symlink.zip', 'w') as z:
    z.writestr('ok.srt', ok)
    info = zipfile.ZipInfo('link.srt')
    info.create_system = 3
    info.external_attr = (0o120777 << 16)
    z.writestr(info, '/etc/passwd')
# 4. expands far beyond the limits (60 MB of zeros in one entry, 50 MB total / 10 MB per file)
with zipfile.ZipFile(f'{out}/hostile.bomb.zip', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr('ok.srt', ok)
    z.writestr('big.srt', b'\0' * (60 * 1024 * 1024))
# 5. more than 200 entries
with zipfile.ZipFile(f'{out}/hostile.many.zip', 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for i in range(201):
        z.writestr(f'{i:03}.srt', ok)
# 6. opens, but holds no subtitle file
with zipfile.ZipFile(f'{out}/nosubtitle.zip', 'w') as z:
    z.writestr('readme.txt', b'nothing here\n')
# 7. not an archive at all, but named like one
open(f'{out}/broken.zip', 'wb').write(b'PK\x03\x04 this is not really a zip file')
PY
chown -R "$uid:$gid" "$OUT"
EOF
ls -l "$OUT"
