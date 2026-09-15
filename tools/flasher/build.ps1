# Build tools/flasher/dist/Projection5000-SD-Flasher.exe with PyInstaller.
# Usage (from any directory):  powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1
# Set $env:FLASHER_PYTHON to pick the interpreter (default: python on PATH, must be 3.11+ with tkinter).
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

# asInvoker: the exe starts unelevated (so --dry-run works on any account) and relaunches itself with
# a UAC prompt for a real flash; declining the prompt shows the "Run as administrator" message.
& $python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --add-data "$archive;." --add-data "$info;." `
    --name Projection5000-SD-Flasher flasher.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $PSScriptRoot 'dist\Projection5000-SD-Flasher.exe'
if (-not (Test-Path $exe)) { throw "build produced no exe" }

# Smoke test the exe: --selfcheck needs no rights, starts Tk once, checks the bundled player archive
# and writes dist\selfcheck.txt because a --windowed exe has no stdout.
Remove-Item -Force (Join-Path $PSScriptRoot 'dist\selfcheck.txt') -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList '--selfcheck' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "exe --selfcheck exited $($p.ExitCode)" }
$out = Join-Path $PSScriptRoot 'dist\selfcheck.txt'
if (-not (Select-String -Path $out -Pattern 'install-player.sh' -Quiet)) { throw "selfcheck output looks wrong" }
if (-not (Select-String -Path $out -Pattern '^tk: ok' -Quiet)) { throw "frozen exe cannot start Tk" }
Write-Host "OK: $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB), selfcheck output in $out"
