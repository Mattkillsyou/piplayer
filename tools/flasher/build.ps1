# Build tools/flasher/dist/Projection5000-SD-Flasher.exe with PyInstaller.
# Usage (from any directory):  powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1 [-ConsoleUrl <url>] [-Key <key>]
# Set $env:FLASHER_PYTHON to pick the interpreter (default: python on PATH, must be 3.11+ with tkinter; no
# third-party package is needed, the SSH key is generated in pure Python).
# -ConsoleUrl (or FLASHER_CONSOLE_URL) bakes the console the exe talks to (shown as a fixed header, never a
# field; without it the product default https://projectors.photogen5000.com applies). No key is baked in: the
# operator signs in through the browser and the flasher fetches the enrollment key at flash time. -Key (or
# FLASHER_ENROLL_KEY) bakes one anyway for offline builds (LAN-only cms sites); the UI never mentions it.
param(
    [string]$ConsoleUrl = $env:FLASHER_CONSOLE_URL,
    [string]$Key = $env:FLASHER_ENROLL_KEY
)
$ErrorActionPreference = 'Stop'
$python = if ($env:FLASHER_PYTHON) { $env:FLASHER_PYTHON } else { 'python' }
Set-Location $PSScriptRoot

# The tool targets Python 3.11+ stdlib; refuse older interpreters and require tkinter up front.
& $python -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { throw "FLASHER_PYTHON must be Python 3.11 or newer with tkinter (got: $(& $python --version))" }

& $python -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('PyInstaller') else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing PyInstaller..."
    & $python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }
}

& $python flasher.py --selfcheck | Out-Null
if ($LASTEXITCODE -ne 0) { throw "selfcheck failed before build" }

# Bundle the player tree (the Pi installs from the card, not from GitHub) and a build stamp.
$stage = Join-Path $env:TEMP 'projection5000-flasher-build'
New-Item -ItemType Directory -Force $stage | Out-Null
$archive = Join-Path $stage 'player.tar.gz'
& $python -c "import flasher; flasher.build_player_archive(r'$archive')"
if ($LASTEXITCODE -ne 0) { throw "could not build player.tar.gz" }
$commit = 'unknown'
try {
    $c = git -C $PSScriptRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { $commit = $c.Trim() }
    # Mark builds from an uncommitted tree so the stamp never claims a commit it does not match.
    $dirty = git -C $PSScriptRoot status --porcelain -- . 2>$null
    if ($LASTEXITCODE -eq 0 -and $dirty) { $commit = "$commit+dirty" }
} catch {}
$info = Join-Path $stage 'build_info.txt'
[IO.File]::WriteAllText($info, "built $(Get-Date -Format s) from commit $commit with $(& $python --version)")

# Console defaults baked into the exe (optional): -ConsoleUrl becomes console.json (the fixed header);
# -Key adds an enrollment key for offline builds (otherwise the flasher fetches it after the browser sign-in).
$consoleJson = Join-Path $stage 'console.json'
Remove-Item -Force $consoleJson -ErrorAction SilentlyContinue
$consoleData = @()
if ($Key -and -not $ConsoleUrl) { throw "-Key needs -ConsoleUrl (or FLASHER_CONSOLE_URL)" }
if ($ConsoleUrl) {
    $env:CONSOLE_JSON_OUT = $consoleJson
    $env:CONSOLE_JSON_URL = $ConsoleUrl
    $env:CONSOLE_JSON_KEY = "$Key"
    & $python -c "import os, flasher; flasher.write_console_json(os.environ['CONSOLE_JSON_OUT'], os.environ['CONSOLE_JSON_URL'], os.environ.get('CONSOLE_JSON_KEY', ''))"
    if ($LASTEXITCODE -ne 0) { throw "-ConsoleUrl / -Key rejected" }
    $consoleData = @('--add-data', "$consoleJson;.")
}

# asInvoker: the exe starts unelevated (so --dry-run works on any account) and relaunches itself with
# a UAC prompt for a real flash; declining the prompt shows the "Run as administrator" message.
# fonts/ (Silkscreen, IBM Plex Mono, Space Grotesk; loaded privately at startup), the window icon and the
# version resource (Explorer's Properties > Details) travel inside the exe.
& $python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --add-data "$archive;." --add-data "$info;." @consoleData `
    --add-data "fonts;fonts" --add-data "icon.ico;." --add-data "icon.png;." --icon icon.ico --version-file version.txt `
    --name Projection5000-SD-Flasher flasher.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $PSScriptRoot 'dist\Projection5000-SD-Flasher.exe'
if (-not (Test-Path $exe)) { throw "build produced no exe" }

# Embed the OS image: appended after PyInstaller's archive with a trailer (bundle.py), streamed from the
# exe at flash time. Not --add-data: onefile would unpack 500+ MB to %TEMP% on every launch.
# FLASHER_IMAGE=<path to .img.xz> skips the download (CI, offline); FLASHER_NO_BUNDLE=1 skips embedding.
if ($env:FLASHER_NO_BUNDLE -ne '1') {
    if ($env:FLASHER_IMAGE -and -not (Test-Path $env:FLASHER_IMAGE)) { throw "FLASHER_IMAGE not found: $env:FLASHER_IMAGE" }
    $env:FLASHER_EXE = $exe
    $embed = @'
import os, threading
import bundle, flasher, windisk
exe, image = os.environ["FLASHER_EXE"], os.environ.get("FLASHER_IMAGE")
if not image:
    # Same path as the tool's "latest" mode: official redirect, .sha256 check, %LOCALAPPDATA% cache.
    seen = set()
    def progress(pct, text):
        if int(pct) // 10 not in seen:
            seen.add(int(pct) // 10); print("  " + text, flush=True)
    image, _ = flasher.obtain_image({"image_mode": "latest"}, print, progress, threading.Event())
windisk.check_image_magic(image)
bundle.strip_bundle(exe)
b = bundle.append_bundle(exe, image, os.path.basename(image))
print(f"embedded {b.name}: {b.length} bytes at offset {b.offset}, sha256 {b.sha256}")
'@
    $embedScript = Join-Path $stage 'embed.py'
    [IO.File]::WriteAllText($embedScript, $embed)
    $env:PYTHONPATH = $PSScriptRoot
    & $python $embedScript
    if ($LASTEXITCODE -ne 0) { throw "embedding the OS image failed" }
}

# Smoke test the exe: --selfcheck needs no rights, starts Tk once, checks the bundled player archive
# and writes dist\selfcheck.txt because a --windowed exe has no stdout.
Remove-Item -Force (Join-Path $PSScriptRoot 'dist\selfcheck.txt') -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList '--selfcheck' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "exe --selfcheck exited $($p.ExitCode)" }
$out = Join-Path $PSScriptRoot 'dist\selfcheck.txt'
if (-not (Select-String -Path $out -Pattern 'install-player.sh' -Quiet)) { throw "selfcheck output looks wrong" }
if (-not (Select-String -Path $out -Pattern '^tk: ok' -Quiet)) { throw "frozen exe cannot start Tk" }
$bundled = (Select-String -Path $out -Pattern '^bundled image: ' | Select-Object -First 1).Line
if ($env:FLASHER_NO_BUNDLE -ne '1' -and -not ($bundled -like '*(trailer ok)')) { throw "exe does not see its bundled image: '$bundled'" }
Write-Host $bundled
$consoleLine = (Select-String -Path $out -Pattern '^console: ' | Select-Object -First 1).Line
if ($ConsoleUrl) {
    $keyState = if ($Key) { 'set' } else { 'fetched with the operator token' }
    if ($consoleLine -ne "console: $($ConsoleUrl.TrimEnd('/')) (enrollment key: $keyState)") {
        throw "exe does not see its console.json: '$consoleLine'"
    }
}
Write-Host $consoleLine
Write-Host "OK: $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB), selfcheck output in $out"
