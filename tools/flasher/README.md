# Projection5000 SD Flasher

Windows desktop tool that writes Raspberry Pi OS Lite (64-bit) to an SD card and
pre-configures the Pi so that on first boot it joins Wi-Fi, takes its hostname,
enables SSH, installs the Projection5000 player from GitHub and registers with
the console. No monitor, keyboard or SSH session needed: fill in the form,
insert a card, click Flash, put the card in the Pi.

## What it does

1. Registers the device on the console (logs in with your console account,
   creates the device, reads its token) or uses a token you paste in.
2. Downloads the latest Raspberry Pi OS Lite arm64 image (verified against the
   published `.sha256`, cached in `%LOCALAPPDATA%\Projection5000\images`), or
   uses a local `.img` / `.img.xz`.
3. Removes every partition from the card (`Clear-Disk`, skipped when the disk
   is already RAW: a blank card or one from an earlier failed run), streams the image to
   `\\.\PhysicalDriveN` with Win32 `WriteFile`, flushes, asks Windows to
   re-read the partition table and reads back the first 64 MiB to verify.
4. Writes `firstrun.sh`, `projection5000-provision.sh` and a patched
   `cmdline.txt` to the FAT boot partition, then ejects the card.

On the Pi, `firstrun.sh` runs once as root (hostname, user + password, SSH,
Wi-Fi, timezone, keyboard), installs a systemd service and deletes itself.
That service waits for the console's `/api/health`, installs `git`, clones
`https://github.com/Mattkillsyou/piplayer.git` and runs
`player/deploy/install-player.sh` with the device id, token and console URL,
retrying every 60 s (up to 20 times). On success it disables itself and removes
the token from the card. The device shows up on the console's Devices page
within about 5 minutes of the first boot.

## Requirements

- Windows 10/11, 64-bit, an SD card reader.
- Administrator rights (raw disk writes). The exe asks for elevation (UAC) on
  start; running from source relaunches itself elevated.
- Internet access for the image download and for the Pi's first boot.
- For building or running from source: Python 3.11+ with tkinter (the
  python.org installer includes it). No third-party packages at runtime.

## Run the exe

Download or build `dist\Projection5000-SD-Flasher.exe`, double-click, accept
the UAC prompt. If you decline the prompt the tool shows "Run as administrator"
and exits.

## Run from source

Open PowerShell **as administrator**, then:

```powershell
cd tools\flasher
python flasher.py
```

From a normal prompt it relaunches itself elevated (UAC prompt) and exits.

`python flasher.py --dry-run` opens the same window with the "Dry run" box
ticked and needs no admin rights: Flash validates the form, registers the
device on the console (or uses the token), resolves the image (download URL
and sha256, cache check, no download) and then stops with "Dry run: would
write ... Nothing was written". Use it to check console credentials and the
form before touching a card. The box can also be ticked in an elevated run.

`python flasher.py --selfcheck` prints the generated `firstrun.sh`,
`projection5000-provision.sh` and `cmdline.txt` for a sample configuration and
exits 0 (no admin needed). The exe does the same, but because it is a windowed
program it writes the text to `selfcheck.txt` next to the exe and only prints
to the console when it was started from one. To run the exe without a UAC
prompt for that check: `$env:__COMPAT_LAYER='RunAsInvoker'; .\dist\Projection5000-SD-Flasher.exe --selfcheck`.

## Build the exe

```powershell
powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1
```

Installs PyInstaller if missing, runs the selfcheck, builds
`tools\flasher\dist\Projection5000-SD-Flasher.exe`
(`--onefile --windowed --uac-admin`) and smoke-tests it. Set
`$env:FLASHER_PYTHON` to choose the interpreter. `dist/`, `build/` and the
`.spec` file are git-ignored.

## Tests

```powershell
cms\.venv\Scripts\python.exe -m pytest tools\flasher\tests -q
```

No admin rights or card needed: the write engine is tested against temp files
with a synthetic `.img.xz`, the download code against a local HTTP server on
port 8931, and device registration against the real Python CMS in `cms/`
started on a free port (or `FLASHER_TEST_PORT`) with a temporary data
directory. The GUI test is skipped
when there is no display.

## Settings

Last-used form values are kept in `%LOCALAPPDATA%\Projection5000\flasher.json`.
Passwords and tokens are never saved there.

## Security note

Until the first boot completes, the card's boot partition holds the Wi-Fi
password, the Pi user's password and the device token in plain text
(`firstrun.sh` and `projection5000-provision.sh`). `firstrun.sh` deletes itself
on the first boot; the provisioning script deletes itself (and its copy on the
boot partition) after the player installs successfully. Treat an un-booted card
like a password: do not leave it lying around, and re-flash it if it is lost.

The console credentials used for "Register this device for me" are used for
that one login only and never written to disk.

## Troubleshooting

- **Card not listed**: click Refresh. The tool only lists USB/SD/MMC disks that
  are not the Windows boot or system disk. Some readers report the card only
  after a re-insert; if it still does not appear, try a different reader or
  USB port. Cards over 512 GB are refused.
- **"Access is denied" while writing**: another program has the card open
  (Explorer preview, an antivirus scan, a previous flash that did not finish).
  Re-insert the card and try again.
- **Download fails or is slow**: use "Local image file" with an image you
  downloaded from raspberrypi.com. Cached downloads live in
  `%LOCALAPPDATA%\Projection5000\images`.
- **Pi does not appear on the console**: put the card back in the PC and read
  `firstrun.log` on the boot partition (hostname/user/Wi-Fi steps). If that
  looks fine, the Pi booted; SSH in (or attach a keyboard) and read
  `/var/log/projection5000-provision.log`: it shows whether the Pi could reach
  the console URL, install git, clone the repo and run the installer. The
  console URL must be reachable from the Pi's network (a LAN address or a public
  HTTPS name), not `localhost`.
- **Wrong Wi-Fi password / SSID**: nothing to fix on the card after the fact,
  re-flash it.
