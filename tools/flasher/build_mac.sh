#!/usr/bin/env bash
# Build tools/flasher/dist/Projection5000 SD Flasher.app and the DMG with PyInstaller (the macOS twin of build.ps1).
# Usage (from any directory):  bash tools/flasher/build_mac.sh
# Environment, the same names as build.ps1:
#   FLASHER_PYTHON       the interpreter (default: python3 on PATH; must be 3.11+ with tkinter)
#   FLASHER_CONSOLE_URL  bakes the console the app talks to into console.json (never shown; without it the
#                        product default https://projectors.photogen5000.com applies)
#   FLASHER_ENROLL_KEY   bakes an enrollment key for an offline build (needs the URL); never for a public release
#   FLASHER_IMAGE        a local .img.xz to embed instead of downloading the latest Raspberry Pi OS Lite (64-bit)
#   FLASHER_NO_BUNDLE=1  build without an embedded image (every model's image is then downloaded at flash time)
# The image goes to Contents/Resources/bundle.bin (a Mach-O with bytes appended fails its signature), the .app
# is signed ad hoc (not notarized: see README "On a Mac" for the first-open steps), --selfcheck must pass, and
# the DMG is dist/Projection5000-SD-Flasher-mac-arm64.dmg or -intel.dmg after the CPU this runs on.
set -euo pipefail
cd "$(dirname "$0")"

python="${FLASHER_PYTHON:-python3}"
name="Projection5000 SD Flasher"
app="dist/$name.app"
case "$(uname -m)" in
    arm64) arch=arm64 ;;
    *) arch=intel ;;
esac
dmg="dist/Projection5000-SD-Flasher-mac-$arch.dmg"

# The tool targets Python 3.11+ stdlib; refuse older interpreters and require tkinter up front.
"$python" -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 11) else 1)" \
    || { echo "FLASHER_PYTHON must be Python 3.11 or newer with tkinter (got: $("$python" --version))" >&2; exit 1; }
"$python" -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('PyInstaller') else 1)" || {
    echo "Installing PyInstaller..."
    "$python" -m pip install pyinstaller
}

"$python" flasher.py --selfcheck >/dev/null || { echo "selfcheck failed before build" >&2; exit 1; }

# Bundle the player tree (the Pi installs from the card, not from GitHub) and a build stamp.
stage="${TMPDIR:-/tmp}/projection5000-flasher-build"
rm -rf "$stage"
mkdir -p "$stage"
archive="$stage/player.tar.gz"
"$python" -c "import flasher; flasher.build_player_archive('$archive')"
commit=unknown
if c=$(git rev-parse --short HEAD 2>/dev/null) && [ -n "$c" ]; then
    commit="$c"
    # Mark builds from an uncommitted tree so the stamp never claims a commit it does not match.
    if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then commit="$commit+dirty"; fi
fi
info="$stage/build_info.txt"
printf 'built %s from commit %s with %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$commit" "$("$python" --version)" >"$info"

# Console defaults baked into the app (optional): the URL becomes console.json; the key only for offline builds.
console_data=()
if [ -n "${FLASHER_ENROLL_KEY:-}" ] && [ -z "${FLASHER_CONSOLE_URL:-}" ]; then
    echo "FLASHER_ENROLL_KEY needs FLASHER_CONSOLE_URL" >&2; exit 1
fi
if [ -n "${FLASHER_CONSOLE_URL:-}" ]; then
    CONSOLE_JSON_OUT="$stage/console.json" CONSOLE_JSON_URL="$FLASHER_CONSOLE_URL" CONSOLE_JSON_KEY="${FLASHER_ENROLL_KEY:-}" \
        "$python" -c "import os, flasher; flasher.write_console_json(os.environ['CONSOLE_JSON_OUT'], os.environ['CONSOLE_JSON_URL'], os.environ.get('CONSOLE_JSON_KEY', ''))" \
        || { echo "FLASHER_CONSOLE_URL / FLASHER_ENROLL_KEY rejected" >&2; exit 1; }
    console_data=(--add-data "$stage/console.json:.")
fi

# The app icon: icon.png (make_icon.py's 256 px render, committed) resized by sips into an iconset, then iconutil.
iconset="$stage/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 64 128 256; do
    sips -z $size $size icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
done
cp "$iconset/icon_32x32.png" "$iconset/icon_16x16@2x.png"
cp "$iconset/icon_64x64.png" "$iconset/icon_32x32@2x.png"
cp "$iconset/icon_256x256.png" "$iconset/icon_128x128@2x.png"
rm "$iconset/icon_64x64.png"  # not an iconset size on its own
iconutil -c icns "$iconset" -o "$stage/icon.icns"

# fonts/ (registered for the process at startup), the masthead icon and console.json travel in the .app.
rm -rf build dist "$name.spec"
"$python" -m PyInstaller --noconfirm --clean --windowed --name "$name" \
    --osx-bundle-identifier com.mattbrown.projection5000.flasher --icon "$stage/icon.icns" \
    --add-data "$archive:." --add-data "$info:." ${console_data[@]+"${console_data[@]}"} \
    --add-data "fonts:fonts" --add-data "icon.ico:." --add-data "icon.png:." \
    flasher.py
[ -d "$app" ] || { echo "build produced no .app" >&2; exit 1; }

# Info.plist: the product name in the menu bar and Finder, Retina drawing, the version from version.txt.
version=$("$python" -c "import re; print(re.search(r\"FileVersion', '(\d+\.\d+\.\d+)\", open('version.txt').read()).group(1))")
INFO_PLIST="$app/Contents/Info.plist" APP_VERSION="$version" "$python" - <<'PY'
import os, plistlib
p = os.environ["INFO_PLIST"]
with open(p, "rb") as f:
    d = plistlib.load(f)
d.update({"CFBundleName": "Projection5000 SD Flasher", "CFBundleDisplayName": "Matt Brown's Projection5000",
          "NSHighResolutionCapable": True, "CFBundleShortVersionString": os.environ["APP_VERSION"],
          "CFBundleVersion": os.environ["APP_VERSION"], "NSHumanReadableCopyright": "Matt Brown",
          "LSApplicationCategoryType": "public.app-category.utilities"})
with open(p, "wb") as f:
    plistlib.dump(d, f)
PY

# Embed the OS image: Contents/Resources/bundle.bin is the image plus the 256-byte trailer (bundle.py), streamed
# from there at flash time. FLASHER_IMAGE=<path to .img.xz> skips the download; FLASHER_NO_BUNDLE=1 skips embedding.
if [ "${FLASHER_NO_BUNDLE:-}" != "1" ]; then
    if [ -n "${FLASHER_IMAGE:-}" ] && [ ! -f "$FLASHER_IMAGE" ]; then echo "FLASHER_IMAGE not found: $FLASHER_IMAGE" >&2; exit 1; fi
    FLASHER_BUNDLE="$app/Contents/Resources/bundle.bin" "$python" - <<'PY'
import os, threading
import bundle, flasher, windisk
out, image = os.environ["FLASHER_BUNDLE"], os.environ.get("FLASHER_IMAGE")
if not image:
    # Same path as the tool's "latest" mode: official redirect, .sha256 check, the Application Support cache.
    seen = set()
    def progress(pct, text):
        if int(pct) // 10 not in seen:
            seen.add(int(pct) // 10); print("  " + text, flush=True)
    image, _ = flasher.obtain_image({"image_mode": "latest"}, print, progress, threading.Event())
windisk.check_image_magic(image)
open(out, "wb").close()  # the trailer file starts empty: the image lands at offset 0
b = bundle.append_bundle(out, image, os.path.basename(image))
print(f"embedded {b.name}: {b.length} bytes in {out}, sha256 {b.sha256}")
PY
fi

# Ad hoc signature over the finished bundle (Apple Silicon refuses unsigned code; Gatekeeper still asks on first open).
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

# Smoke test the app: --selfcheck needs no rights, starts Tk once, checks the bundled player archive and writes
# dist/selfcheck.txt next to the .app (a windowed app has no reliable stdout).
rm -f dist/selfcheck.txt
"$app/Contents/MacOS/$name" --selfcheck >/dev/null 2>&1 || { echo "app --selfcheck failed" >&2; exit 1; }
out=dist/selfcheck.txt
[ -f "$out" ] || { echo "selfcheck wrote no $out" >&2; exit 1; }
grep -q 'install-player.sh' "$out" || { echo "selfcheck output looks wrong" >&2; exit 1; }
grep -q '^tk: ok' "$out" || { echo "frozen app cannot start Tk" >&2; exit 1; }
bundled=$(grep '^bundled image: ' "$out" | head -1)
if [ "${FLASHER_NO_BUNDLE:-}" != "1" ] && [[ "$bundled" != *"(trailer ok)" ]]; then
    echo "app does not see its bundled image: '$bundled'" >&2; exit 1
fi
echo "$bundled"
console_line=$(grep '^console: ' "$out" | head -1)
if [ -n "${FLASHER_CONSOLE_URL:-}" ]; then
    key_state="fetched with the operator token"; [ -n "${FLASHER_ENROLL_KEY:-}" ] && key_state=set
    want="console: ${FLASHER_CONSOLE_URL%/} (enrollment key: $key_state)"
    [ "$console_line" = "$want" ] || { echo "app does not see its console.json: '$console_line'" >&2; exit 1; }
fi
echo "$console_line"
cp "$out" "dist/selfcheck-mac-$arch.txt"

# The DMG: the .app plus an Applications link, compressed.
dmgroot="$stage/dmg"
rm -rf "$dmgroot"
mkdir -p "$dmgroot"
cp -R "$app" "$dmgroot/"
ln -s /Applications "$dmgroot/Applications"
rm -f "$dmg"
hdiutil create -volname "$name" -srcfolder "$dmgroot" -ov -format UDZO "$dmg" >/dev/null
echo "OK: $dmg ($(du -h "$dmg" | cut -f1)), selfcheck output in $out"
