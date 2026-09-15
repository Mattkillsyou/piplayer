# Build tools/flasher/dist/Projection5000-SD-Flasher.exe with PyInstaller.
# Usage (from any directory):  powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1
# Set $env:FLASHER_PYTHON to pick the interpreter (default: python on PATH, must be 3.11+ with tkinter).
$ErrorActionPreference = 'Stop'
$python = if ($env:FLASHER_PYTHON) { $env:FLASHER_PYTHON } else { 'python' }
Set-Location $PSScriptRoot

& $python -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('PyInstaller') else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing PyInstaller..."
    & $python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }
}

& $python flasher.py --selfcheck | Out-Null
if ($LASTEXITCODE -ne 0) { throw "selfcheck failed before build" }

& $python -m PyInstaller --noconfirm --clean --onefile --windowed --uac-admin `
    --name Projection5000-SD-Flasher flasher.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$exe = Join-Path $PSScriptRoot 'dist\Projection5000-SD-Flasher.exe'
if (-not (Test-Path $exe)) { throw "build produced no exe" }

# Smoke test the exe. The manifest demands admin, so run it as the invoker (no UAC prompt);
# --selfcheck needs no rights and writes dist\selfcheck.txt because a --windowed exe has no stdout.
$env:__COMPAT_LAYER = 'RunAsInvoker'
$p = Start-Process -FilePath $exe -ArgumentList '--selfcheck' -Wait -PassThru
Remove-Item Env:__COMPAT_LAYER
if ($p.ExitCode -ne 0) { throw "exe --selfcheck exited $($p.ExitCode)" }
$out = Join-Path $PSScriptRoot 'dist\selfcheck.txt'
if (-not (Select-String -Path $out -Pattern 'install-player.sh' -Quiet)) { throw "selfcheck output looks wrong" }
Write-Host "OK: $exe ($([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB), selfcheck output in $out"
