# Projection5000 SD Flasher

Windows desktop tool that writes Raspberry Pi OS Lite (64-bit) to an SD card and
pre-configures the Pi so that on first boot it joins Wi-Fi, takes its hostname,
enables SSH, installs the Projection5000 player (a copy of `player/` travels on
the card; the Pi never needs GitHub access) and registers with the console. No monitor, keyboard or SSH session needed: fill in the form,
insert a card, click Flash, put the card in the Pi.

## What it does

1. Registers the device on the console (logs in with your console account,
   creates the device, reads its token) or uses a token you paste in.
2. Takes the Raspberry Pi OS Lite arm64 image that is built into the exe (the
   default; see "Bundled image" below), or downloads the latest one (verified
   against the published `.sha256`, cached in
   `%LOCALAPPDATA%\Projection5000\images`), or uses a local `.img` / `.img.xz`.
   The image must fit the card (checked before anything is erased).
3. Re-reads the target disk and refuses if it is not the disk that was confirmed
   (same reader slot, size and partition signature: a swapped card or a
   renumbered drive is caught), removes every partition (`Clear-Disk`, skipped
   when the disk is already RAW: a blank card or one from an earlier failed run),
   locks the disk, streams the image to `\\.\PhysicalDriveN` with Win32
   `WriteFile`, flushes, asks Windows to re-read the partition table and reads
   the whole card back to verify.
4. Writes `firstrun.sh`, `projection5000-provision.sh`,
   `projection5000-player.tar.gz` (the `player/` tree) and a patched
   `cmdline.txt` to the FAT boot partition, then ejects the card.

On the Pi, `firstrun.sh` runs once as root (hostname, user + password, SSH,
Wi-Fi, timezone, keyboard), logs the exit status of every step to
`firstrun.log`, moves the provisioning script and the player archive off the
FAT partition (root-only), installs a systemd service, zero-fills and deletes
its own copies of the secrets and writes `firstrun.ok` when every step
succeeded. The Wi-Fi passphrase is stored pre-hashed (PBKDF2, as Raspberry Pi
Imager does), so the plaintext never reaches the card.
The service waits for the clock to sync (or seeds it from the console), waits
for the console's `/api/health`, unpacks the player archive to
`/opt/projection5000-src` and runs `player/deploy/install-player.sh` with the
device id, token and console URL, retrying every 60 s (up to 20 times). On
success it disables itself and deletes the token. The device shows up on the
console's Devices page within about 5 minutes of the first boot.

## Requirements

- Windows 10/11, 64-bit, an SD card reader.
- Administrator rights (raw disk writes). The exe and the source both relaunch
  themselves elevated (UAC prompt) on start.
- Internet access for the Pi's first boot (and for the "latest" image mode;
  the bundled image needs none).
- For building or running from source: Python 3.11+ with tkinter (the
  python.org installer includes it). No third-party packages at runtime.

## Run the exe

Download or build `dist\Projection5000-SD-Flasher.exe`, double-click, accept
the UAC prompt. If you decline the prompt the tool shows "Run as administrator"
and exits. `Projection5000-SD-Flasher.exe --dry-run` works without the prompt
(see below). The exe is not code-signed: a downloaded copy triggers SmartScreen
("Windows protected your PC"; More info, Run anyway); a locally built copy does
not.

## Bundled image

The exe carries a Raspberry Pi OS Lite (64-bit) `.img.xz` inside it, so an
operator needs no download and no internet for the image. `build.ps1` appends
the image and a 256-byte trailer after PyInstaller's archive (`bundle.py`); at
flash time the image is streamed straight out of the exe, nothing is unpacked
to disk. `--selfcheck` prints which image is inside:
`bundled image: <name> <bytes> bytes sha256 <hex> (trailer ok)`. The Image box
shows it as "Bundled: <name> (<size>)" and selects it by default; the "latest"
(download) and "Local image file" modes stay available for a newer image than
the one built in.

To rebuild with a newer image, run `build.ps1` again: it resolves the official
"latest" redirect, downloads into the tool's own cache
(`%LOCALAPPDATA%\Projection5000\images`, so a second build does not download
again), verifies the `.sha256` and embeds it. `$env:FLASHER_IMAGE = 'C:\path\to\x.img.xz'`
embeds that file instead (offline or pinned builds); `$env:FLASHER_NO_BUNDLE = '1'`
builds the small exe without an image (the download mode is then the default).
The exe is about 550 MB with the image inside.

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
Note that a dry run really registers the device on the console (the log says
so); delete it there if it was only a test.

`python flasher.py --selfcheck` prints the generated `firstrun.sh`,
`projection5000-provision.sh` and `cmdline.txt` for a sample configuration and
exits 0 (no admin needed). It also starts and stops Tk once and checks the
player archive. The exe does the same, but because it is a windowed program it
writes the text (LF line endings, byte-identical to what goes on the card) to
`selfcheck.txt` next to the exe (or in `%LOCALAPPDATA%\Projection5000` when
that folder is read-only) and only prints to the console when it was started
from one.

## Build the exe

```powershell
powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1
```

Installs PyInstaller if missing, runs the selfcheck, bundles `player/` as
`player.tar.gz` plus a build stamp (date, commit; shown by `--selfcheck`),
builds `tools\flasher\dist\Projection5000-SD-Flasher.exe`
(`--onefile --windowed`, asInvoker: it elevates itself), embeds the OS image
(see "Bundled image": `FLASHER_IMAGE`, `FLASHER_NO_BUNDLE`) and smoke-tests it
(the frozen exe must start Tk and see its bundled image; the build prints the
`bundled image:` line and the final exe size). Set `$env:FLASHER_PYTHON` to
choose the interpreter; the source floor is Python 3.11, so build with 3.11
when in doubt.
`dist/`, `build/` and the `.spec` file are git-ignored. Rebuild after every
change to `tools/flasher` or `player/`: the exe carries a copy of both.

## Tests

```powershell
cms\.venv\Scripts\python.exe -m pytest tools\flasher\tests -q
```

No admin rights or card needed: the write engine is tested against temp files
and a fake drive with a synthetic `.img.xz`, the download code against a local
HTTP server on a free port, device registration against the real Python CMS in
`cms/` started on a free port (or `FLASHER_TEST_PORT`) with a temporary data
directory, the rendered `firstrun.sh` by actually running it in bash against
stubbed tools, and the GUI flow (failure, cancel, confirmations) against a
withdrawn Tk window. The GUI tests are skipped when there is no display.

## Settings

Last-used form values are kept in `%LOCALAPPDATA%\Projection5000\flasher.json`.
Passwords and tokens are never saved there. The Pi password defaults to a
random value that is printed in the log after the flash and nowhere else:
record it then, or type your own.

## Security note

Until the first boot completes, the card's boot partition holds the Pi user's
password, the pre-hashed Wi-Fi key and the device token in plain text
(`firstrun.sh` and `projection5000-provision.sh`). On the first boot
`firstrun.sh` moves the provisioning script to `/usr/local/sbin` (root only),
zero-fills and deletes both files on the FAT partition, and the provisioning
script deletes itself after the player installs. A card whose Pi never
completed the first boot still carries everything: treat an un-booted card
like a password, do not leave it lying around, and re-flash it if it is lost.

The console credentials used for "Register this device for me" are used for
that one login only and never written to disk. `http://` console URLs are only
accepted for LAN addresses, `.local` names and localhost; anything else must be
`https://` so the password and token are not sent in clear text.

## Troubleshooting

- **Card not listed**: click Refresh. The tool only lists USB/SD/MMC disks that
  are not the Windows boot or system disk. Some readers report the card only
  after a re-insert; if it still does not appear, try a different reader or
  USB port. Cards over 256 GiB and USB hard disks/SSDs are refused.
- **"Another program is using the card" / "Access is denied"**: another program
  has the card open (Explorer preview, an antivirus scan, a previous flash that
  did not finish). Re-insert the card and try again.
- **"is not the one confirmed" / "target disk changed"**: the card or reader
  changed between Refresh and Flash. Click Refresh, check the target, retry.
- **"The image was written but the first-boot files were NOT"**: Windows did
  not mount the boot partition in time. The card holds a plain, unconfigured OS;
  re-insert it and Flash again (the download is cached, registration is reused).
- **Download fails or is slow**: use the bundled image (the default), or
  "Local image file" with an image you downloaded from raspberrypi.com. Cached
  downloads live in `%LOCALAPPDATA%\Projection5000\images`.
- **Pi does not appear on the console**: put the card back in the PC and read
  `firstrun.log` on the boot partition: every step is listed with its exit
  status (`rc=0` is good) and `firstrun.ok` exists when all of them passed. If
  that looks fine, the Pi booted; SSH in (or attach a keyboard) and read
  `/var/log/projection5000-provision.log`: it shows whether the Pi could reach
  the console URL, sync its clock and run the installer. The
  console URL must be reachable from the Pi's network (a LAN address or a public
  HTTPS name), not `localhost`.
- **Wrong Wi-Fi password / SSID**: nothing to fix on the card after the fact,
  re-flash it.
