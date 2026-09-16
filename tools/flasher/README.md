# Projection5000 SD Flasher

Windows desktop tool that writes Raspberry Pi OS Lite (64-bit) to an SD card and
pre-configures the Pi so that on first boot it joins Wi-Fi, takes its hostname,
enables SSH, installs the Projection5000 player (a copy of `player/` travels on
the card; the Pi never needs GitHub access) and enrolls itself with the console.
No monitor, keyboard, SSH session or console login needed: fill in the form,
insert a card, click Flash, put the card in the Pi.

## What it does

1. Puts the console URL and the console's **enrollment key** on the card. The
   key is fetched from the console on every launch with the operator's
   personal API token (`GET /api/operator/enrollment`; see "Enrollment"
   below), so a card never carries a stale key and the exe carries no secret.
   The flasher never enrolls anything: the Pi does that on first boot. Under
   "Advanced" you can paste a device token instead, which skips enrollment on
   the Pi.
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
for the console's `/api/health`, enrolls (`POST /api/enroll` with the key, the
device id and the name; the console answers with the device token and its
URL), unpacks the player archive to `/opt/projection5000-src` and runs
`player/deploy/install-player.sh` with the device id, token and console URL,
retrying every 60 s (up to 20 times; a token once received is kept across
retries). On success it disables itself and deletes the script that carried
the key. The device shows up on the console's Devices page within about
5 minutes of the first boot.

## Enrollment

The console keeps one secret enrollment key (Settings page, admins only). The
flasher fetches it live instead of carrying it:

1. On the console, open Settings, "My API tokens", create a token (it is shown
   once, format `p5k_...`; the token acts with your role, editor or admin).
2. On the first launch the flasher asks for the console URL and that token
   (Cancel is allowed: you can then paste an enrollment key by hand). Both are
   saved in `%APPDATA%\Projection5000\flasher.json`; the token is
   DPAPI-protected (Windows `CryptProtectData`, readable only by the same
   Windows account). If DPAPI is not available the token is stored in plain
   text and the log says so.
3. On every launch (and on "Connect") the flasher calls
   `GET /api/operator/enrollment` with `Authorization: Bearer <token>`. The
   answer carries the console URL, the current enrollment key, the group and
   playlist lists (shown in the log; new devices are assigned site-wide by the
   console's "New devices" settings, not per card) and the timezone. The key
   lands in the masked "Enrollment key" field and goes on the card. A fetch
   failure (wrong token, revoked token, no network) is shown in the Console box
   and the log; the field can still be filled by hand. The answer also says
   whether the console has a Wyze account (`wyze_configured`): when it does, the
   log shows "Wyze bridge: will be installed" and the card's provision script
   runs the installer with `--with-wyze` (Docker + the wyze-bridge unit; the
   camera credentials come from the console later, nothing is written to the
   card). Otherwise the log says "Wyze bridge: not configured". The flag is
   never saved and is dropped whenever the URL or token changes or a fetch fails.

The Console box: "Console URL", "Operator API token" (masked, Show), "Enrollment
key" (masked, Show; fetched, or pasted for an offline session, never written
to disk by the tool), "Connect" (saves URL + token, fetches the key) and "Test
connection" (`GET /api/health` and nothing more). `--selfcheck` prints
`console: <url> (enrollment key: fetched with the operator token)` for a build
that carries a URL, or `(enrollment key: set)` for an offline build with a
baked key (`build.ps1 -Key`).

- A **re-flashed card enrolls the same device**: the console keeps the
  existing device (and its token) for a known `device_id` and only updates the
  name, so the Devices page, playlist assignment and history survive a
  re-flash.
- **Rotate the key** on the console's Settings page if a flashed card is lost:
  cards flashed with the old key that have not booted yet then fail enrollment
  (the Pi logs a 401 in `/var/log/projection5000-provision.log`) and must be
  flashed again (relaunch the flasher or click Connect: it fetches the new
  key). Devices that already enrolled are unaffected. **Revoke the API token**
  (Settings, "My API tokens") if the PC that holds it is lost.
- **Advanced: device token**: tick the box and paste a token from the
  console's Devices page to bypass enrollment (the old manual path). The key
  is then not written to the card.

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
ticked and needs no admin rights: Flash validates the form, renders the
first-boot files, resolves the image (download URL and sha256, cache check,
no download) and then stops with "Dry run: would write ... Nothing was
written". The flash sequence never contacts the console (only the launch-time
key fetch does). Use it to check the form before touching a card. The box can
also be ticked in an elevated run.

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

No secret is needed to build. `-ConsoleUrl <url>` (or `$env:FLASHER_CONSOLE_URL`)
prefills the console URL; without it the default `https://projectors.photogen5000.com`
is used and the first-run prompt asks anyway. `-Key <enrollment key>` (or
`$env:FLASHER_ENROLL_KEY`, needs a URL) bakes a key into `console.json` for an
offline build; such an exe carries the secret, share it only with the people
who flash cards. The script installs PyInstaller if missing, runs the
selfcheck, bundles `player/` as `player.tar.gz` plus a build stamp (date,
commit; shown by `--selfcheck`) and `console.json` when a URL was given, builds
`tools\flasher\dist\Projection5000-SD-Flasher.exe` (`--onefile --windowed`,
asInvoker: it elevates itself), embeds the OS image (see "Bundled image":
`FLASHER_IMAGE`, `FLASHER_NO_BUNDLE`) and smoke-tests it (the frozen exe must
start Tk, see its bundled image and report the console line; the build prints
both lines and the final exe size). Set `$env:FLASHER_PYTHON` to choose the
interpreter; the source floor is Python 3.11, so build with 3.11 when in doubt.
`dist/`, `build/` and the `.spec` file are git-ignored. Rebuild after every
change to `tools/flasher` or `player/`: the exe carries a copy of both.

## Tests

```powershell
cms\.venv\Scripts\python.exe -m pytest tools\flasher\tests -q
```

No admin rights or card needed: the write engine is tested against temp files
and a fake drive with a synthetic `.img.xz`, the download code against a local
HTTP server on a free port, enrollment and the operator key fetch against a
stub `/api/enroll` + `/api/operator/enrollment` server and
(one test, skipped until that CMS answers `/api/enroll`) against the real
Python CMS in `cms/` started on a free port (or `FLASHER_TEST_PORT`) with a
temporary data directory, the rendered `firstrun.sh` and
`projection5000-provision.sh` by actually running them in bash against stubbed
tools (curl, python3, the installer), and the GUI flow (failure, cancel,
confirmations) against a withdrawn Tk window. The GUI tests are skipped when
there is no display.

## Settings

Last-used form values are kept in `%LOCALAPPDATA%\Projection5000\flasher.json`.
Passwords, the enrollment key and tokens are never saved there. The console
URL and the operator API token live in `%APPDATA%\Projection5000\flasher.json`
(token DPAPI-protected, see "Enrollment"); delete that file to be asked again.
The Pi password defaults to a random value that is printed in the log after
the flash and nowhere else: record it then, or type your own.

## Security note

Until the first boot completes, the card's boot partition holds the Pi user's
password, the pre-hashed Wi-Fi key and the console's enrollment key (or a
device token) in plain text (`firstrun.sh` and `projection5000-provision.sh`). On the first boot
`firstrun.sh` moves the provisioning script to `/usr/local/sbin` (root only),
zero-fills and deletes both files on the FAT partition, and the provisioning
script deletes itself after the player installs. A card whose Pi never
completed the first boot still carries everything: treat an un-booted card
like a password, do not leave it lying around, and rotate the enrollment key
on the console if it is lost (then relaunch the flasher and re-flash).

`http://` console URLs are only accepted for LAN addresses, `.local` names and
localhost; anything else must be `https://` so the key and token are not sent
in clear text.

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
  re-insert it and Flash again (the download is cached).
- **Download fails or is slow**: use the bundled image (the default), or
  "Local image file" with an image you downloaded from raspberrypi.com. Cached
  downloads live in `%LOCALAPPDATA%\Projection5000\images`.
- **Pi does not appear on the console**: put the card back in the PC and read
  `firstrun.log` on the boot partition: every step is listed with its exit
  status (`rc=0` is good) and `firstrun.ok` exists when all of them passed. If
  that looks fine, the Pi booted; SSH in (or attach a keyboard) and read
  `/var/log/projection5000-provision.log`: it shows whether the Pi could reach
  the console URL, sync its clock, enroll and run the installer. `enrollment
  failed (curl rc=22)` with a 401 means the console's enrollment key was
  rotated after the card was flashed: relaunch the flasher (it fetches the
  current key) and re-flash. The console URL must
  be reachable from the Pi's network (a LAN address or a public HTTPS name),
  not `localhost`.
- **Wrong Wi-Fi password / SSID**: nothing to fix on the card after the fact,
  re-flash it.
- **"Enrollment key fetch FAILED: HTTP 401"** at launch: the operator API token
  was revoked, mistyped or belongs to a viewer account. Create a new token on
  the console (Settings, "My API tokens"), paste it into "Operator API token"
  and click Connect.
