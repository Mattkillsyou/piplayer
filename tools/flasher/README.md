# Projection5000 SD Flasher

Windows desktop tool that writes Raspberry Pi OS Lite (64-bit) to an SD card and
pre-configures the Pi so that on first boot it joins the network, takes its
hostname, installs the Projection5000 player (a copy of `player/` travels on
the card; the Pi never needs GitHub access) and enrolls itself with the console.
One screen, four steps, nothing to copy and paste.

## The four steps

1. **Sign in** (once per PC). Click "Sign in": the browser opens the console's
   `/authorize` page with a short code prefilled; approve it there. The header
   then reads "Signed in as <you>" and stays that way on later launches.
2. **Device name**, e.g. "Lobby Projector". The device id / hostname
   (`lobby-projector`) is derived from it and shown in grey under the entry.
3. **Wi-Fi network and password**. Leave both blank for a wired Pi.
4. **SD card**: pick the reader (Refresh rescans), click **Flash**, confirm the
   erase warning. When it finishes: "Done. Put the card in the Pi and power it
   on. It appears on the Devices page within a few minutes."

The console is fixed: the header shows `Console: projectors.photogen5000.com`
(baked in by `build.ps1 -ConsoleUrl`, or the product default). There is no
console field, no key field, no token field and no Pi password field.
Validation is inline, in plain words under the field ("Give the Pi a name.",
"Wi-Fi password must be 8-63 characters."); the only dialogs are the erase
confirmation, the final "Done" and a failure.

## What is automatic

- **Enrollment key**: fetched from the console at flash time with your sign-in
  (`GET /api/operator/enrollment`), written to the card, never shown; the log
  says "Enrollment key: ok". The flasher never enrolls anything itself: the Pi
  does that on first boot, and a re-flashed card with the same device id
  re-enrolls the same device (token, playlist and history survive).
- **Pi login**: the fixed user `projector-admin`. SSH is on with **key-based
  login only**: the flasher creates one ed25519 keypair per Windows user on
  first use (`%APPDATA%\Projection5000\ssh\id_ed25519` and `.pub`, ACL cut
  down to your account) and installs the public key on every card
  (`~/.ssh/authorized_keys` plus `PasswordAuthentication no` in
  `/etc/ssh/sshd_config.d/projection5000.conf`). The OS still needs a password
  to create the user, so `firstrun.sh` sets a random 32-character one that is
  never shown or saved anywhere; `sudo` works without it, as for any Pi OS
  first user. Log in with `ssh projector-admin@<device-id>.local` from the PC
  that flashed the card (ssh.exe finds the key when you pass
  `-i %APPDATA%\Projection5000\ssh\id_ed25519`, or copy it to `~/.ssh/`).
  "Copy public key" under Advanced puts the `.pub` line on the clipboard for
  any other machine's `authorized_keys`.
- **Timezone, keyboard, Wi-Fi country**: taken from Windows (the registry's
  time zone key mapped to an IANA name, the input locale, the region setting;
  fallbacks `America/Los_Angeles`, `us`, `US`). `--selfcheck` prints what this
  PC yields; Advanced lets you override all three.
- **Image**: the Raspberry Pi OS Lite arm64 image built into the exe (see
  "Bundled image"); no download, no internet needed for the image.
- **Wyze bridge**: when the console has a Wyze account (`wyze_configured` in
  the enrollment answer) the card's installer runs with `--with-wyze`; the log
  says so. Nothing to tick.

## Advanced

One collapsed section at the bottom holds everything else:

- **Image**: the bundled image (default), "Latest Raspberry Pi OS Lite"
  (downloaded, verified against the published `.sha256`, cached in
  `%LOCALAPPDATA%\Projection5000\images`) or a local `.img` / `.img.xz`.
- **Timezone**, **Keyboard layout**, **Wi-Fi country**, **Hidden Wi-Fi
  network**.
- **Static IP** (`192.168.1.50/24`) and **Gateway** (also used as the DNS
  server); blank means DHCP. Works for Wi-Fi and wired cards.
- **Existing device token**: a token from the console's Devices page. The
  card then installs straight away without enrolling (no key on the card).
- **SSH key**: the private key path and "Copy public key".
- **Sign out**: forgets the stored sign-in (revoke the token on the console's
  Settings page as well if the PC changes hands). **Dry run** (see "Run from
  source"). The build stamp.

A problem in an Advanced field opens the section and shows the words there.

## Sign in

The device-code flow, so no token is ever copied by hand:

1. "Sign in" calls `POST /api/operator/device-code` (no auth) with this PC's
   hostname and gets a `device_code`, a short `user_code` and the
   `verification_url`.
2. The browser opens `<verification_url>?code=<user_code>`; the header shows
   "Approve in your browser (code XXXX-XX)". If no browser could be opened the
   log prints the URL and the code to type. On the console (signed in as an
   editor or admin) you approve "Sign in the SD Flasher on <hostname>?".
3. The flasher polls `POST /api/operator/device-token` every few seconds for
   up to 10 minutes. `428` means not yet, `410 {status}` means expired or denied
   (the header then reads "Sign in failed: denied on the console" or "... the
   code expired (click Sign in again)"), `200` carries the token (one shot) and
   your username.
4. The token is stored DPAPI-protected (Windows `CryptProtectData`, readable
   only by the same Windows account) in `%APPDATA%\Projection5000\flasher.json`
   together with the console URL and username. On later launches the header
   shows the username right away and the token is checked with
   `GET /api/operator/enrollment` in the background; a `401` (revoked) clears
   it and offers Sign in again, a network error keeps it. A token saved for a
   different console is ignored.

On the console the sign-in appears as an API token named "SD Flasher on
<hostname>" (Settings, "My API tokens"); revoke it there to lock a PC out.

## Requirements

- Windows 10/11, 64-bit, an SD card reader.
- Administrator rights (raw disk writes). The exe and the source both relaunch
  themselves elevated (UAC prompt) on start.
- Internet access for the Pi's first boot (and for the "latest" image mode;
  the bundled image needs none).
- For building or running from source: Python 3.11+ with tkinter (the
  python.org installer includes it). No third-party packages at runtime: the
  SSH key is generated in pure Python (RFC 8032 arithmetic plus the OpenSSH
  file formats, checked against an RFC 8032 vector and `ssh-keygen -y` /
  `-l` in the tests). `cryptography` would make the build depend on a native
  wheel the build machine may not have, and `ssh-keygen.exe` (Windows'
  OpenSSH client is an optional feature that can be removed) could only ever
  be a second generator next to a pure-Python fallback; one tested generator
  is less code than two. `icacls` (always present) restricts the private
  key's ACL.

## Run the exe

Download or build `dist\Projection5000-SD-Flasher.exe`, double-click, accept
the UAC prompt. If you decline the prompt the tool shows "Run as administrator"
and exits. `Projection5000-SD-Flasher.exe --dry-run` works without the prompt
(see below). The exe is not code-signed: a downloaded copy triggers SmartScreen
("Windows protected your PC"; More info, Run anyway); a locally built copy does
not. The browser opened by "Sign in" runs from the elevated process; that is
fine for approving a code.

## What happens on the card

1. Re-reads the target disk and refuses if it is not the disk that was
   confirmed (same reader slot, size and partition signature: a swapped card or
   a renumbered drive is caught), removes every partition (`Clear-Disk`,
   skipped when the disk is already RAW), locks the disk, streams the image to
   `\\.\PhysicalDriveN` with Win32 `WriteFile`, flushes, asks Windows to
   re-read the partition table and reads the whole card back to verify.
2. Writes `firstrun.sh`, `projection5000-provision.sh`,
   `projection5000-player.tar.gz` (the `player/` tree) and a patched
   `cmdline.txt` to the FAT boot partition, then ejects the card.

On the Pi, `firstrun.sh` runs once as root (hostname, user, SSH key, Wi-Fi or
static address, timezone, keyboard), logs the exit status of every step to
`firstrun.log`, moves the provisioning script and the player archive off the
FAT partition (root-only), installs a systemd service, zero-fills and deletes
its own copies of the secrets and writes `firstrun.ok` when every step
succeeded. The Wi-Fi passphrase is stored pre-hashed (PBKDF2, as Raspberry Pi
Imager does), so the plaintext never reaches the card. The service waits for
the clock to sync (or seeds it from the console), waits for the console's
`/api/health`, enrolls (`POST /api/enroll` with the key, the device id and the
name; the console answers with the device token and its URL), unpacks the
player archive to `/opt/projection5000-src` and runs
`player/deploy/install-player.sh`, retrying every 60 s (up to 20 times; a
token once received is kept across retries). On success it disables itself and
deletes the script that carried the key.

`firstboot.validate_cfg` is the single list of rules for a card configuration
(device id, name, login, Wi-Fi, country, timezone, keymap, key or token, SSH
public key, static IP); the form and the renderers both use it.

## Bundled image

The exe carries a Raspberry Pi OS Lite (64-bit) `.img.xz` inside it, so an
operator needs no download and no internet for the image. `build.ps1` appends
the image and a 256-byte trailer after PyInstaller's archive (`bundle.py`); at
flash time the image is streamed straight out of the exe, nothing is unpacked
to disk. `--selfcheck` prints which image is inside:
`bundled image: <name> <bytes> bytes sha256 <hex> (trailer ok)`. Advanced
shows it as "Bundled: <name> (<size>)" and selects it by default.

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

`python flasher.py --dry-run` opens the same window with "Dry run" (under
Advanced) ticked and needs no admin rights: Flash validates the form, fetches
the enrollment key (unless one is baked in), renders the first-boot files,
resolves the image (download URL and sha256, cache check, no download) and
then stops with "Dry run: would write ... Nothing was written". Use it to check
the form and the sign-in before touching a card.

`python flasher.py --selfcheck` prints the generated `firstrun.sh`,
`projection5000-provision.sh` and `cmdline.txt` for a sample configuration,
the console line, the Windows-derived defaults and the SSH key path, and exits
0 (no admin needed). It also starts and stops Tk once and checks the player
archive. The exe does the same, but because it is a windowed program it writes
the text (LF line endings, byte-identical to what goes on the card) to
`selfcheck.txt` next to the exe (or in `%LOCALAPPDATA%\Projection5000` when
that folder is read-only) and only prints to the console when it was started
from one.

## Build the exe

```powershell
powershell -ExecutionPolicy Bypass -File tools\flasher\build.ps1 -ConsoleUrl https://projectors.photogen5000.com
```

No secret is needed to build. `-ConsoleUrl <url>` (or `$env:FLASHER_CONSOLE_URL`)
bakes the console into `console.json` (the fixed header); without it the
product default `https://projectors.photogen5000.com` applies. `-Key
<enrollment key>` (or `$env:FLASHER_ENROLL_KEY`, needs a URL) bakes a key for
an offline build (a LAN-only `cms/` site that cannot issue sign-ins); such an
exe carries the secret and flashes without signing in, share it only with the
people who flash cards. The script installs PyInstaller if missing, runs the
selfcheck, bundles `player/` as `player.tar.gz` plus a build stamp (date,
commit; shown under Advanced and by `--selfcheck`), builds
`tools\flasher\dist\Projection5000-SD-Flasher.exe` (`--onefile --windowed`,
asInvoker: it elevates itself), embeds the OS image (see "Bundled image":
`FLASHER_IMAGE`, `FLASHER_NO_BUNDLE`) and smoke-tests it (the frozen exe must
start Tk, see its bundled image and report the console line). Set
`$env:FLASHER_PYTHON` to choose the interpreter; the source floor is Python
3.11. `dist/`, `build/` and the `.spec` file are git-ignored. Rebuild after
every change to `tools/flasher` or `player/`: the exe carries a copy of both.

## Tests

```powershell
cms\.venv\Scripts\python.exe -m pytest tools\flasher\tests -q
```

No admin rights, card, console or browser needed: the write engine is tested
against temp files and a fake drive with a synthetic `.img.xz`, the download
code against a local HTTP server on a free port, enrollment, the key fetch and
the device-code sign-in against a stub console (`/api/enroll`,
`/api/operator/enrollment`, `/api/operator/device-code`,
`/api/operator/device-token`) and (one test, skipped until that CMS answers
`/api/enroll`) against the real Python CMS in `cms/`, the rendered
`firstrun.sh` and `projection5000-provision.sh` by running them in bash against
stubbed tools, the SSH key against RFC 8032 vectors and `ssh-keygen -y`, and
the GUI (the exact set of top-level fields, inline validation, sign-in, failure,
cancel, confirmation) against a withdrawn Tk window. The GUI tests are skipped
when there is no display.

## Files on this PC

- `%LOCALAPPDATA%\Projection5000\flasher.json`: last-used form values (name,
  Wi-Fi network, country, timezone, keymap, image choice, static IP). Never a
  password, key or token.
- `%APPDATA%\Projection5000\flasher.json`: the sign-in (console URL, username,
  DPAPI-protected token). "Sign out" deletes it.
- `%APPDATA%\Projection5000\ssh\id_ed25519` and `.pub`: the SSH key installed
  on every card. Delete both to start over (cards flashed before then keep the
  old public key).
- `%LOCALAPPDATA%\Projection5000\images`: downloaded images.

## Security note

Until the first boot completes, the card's boot partition holds the Pi user's
random password, the pre-hashed Wi-Fi key, your SSH public key and the
console's enrollment key (or a device token) in plain text (`firstrun.sh` and
`projection5000-provision.sh`). On the first boot `firstrun.sh` moves the
provisioning script to `/usr/local/sbin` (root only), zero-fills and deletes
both files on the FAT partition, and the provisioning script deletes itself
after the player installs. A card whose Pi never completed the first boot
still carries everything: treat an un-booted card like a password, do not
leave it lying around, and rotate the enrollment key on the console if it is
lost (the next flash fetches the new key).

The private SSH key never leaves this PC. `http://` console URLs are only
accepted for LAN addresses, `.local` names and localhost; anything else must be
`https://` so the key and token are not sent in clear text.

## Troubleshooting

- **"Sign in first."** under the header: no stored sign-in and no baked key.
  Click Sign in.
- **Sign in never completes**: the browser page must be approved by an editor
  or admin within 10 minutes; a viewer account cannot approve. The log shows
  the URL and code if the browser did not open; open it on any device that
  can reach the console.
- **"Session expired: sign in again"** at launch: the token was revoked on the
  console (Settings, "My API tokens") or created by another Windows account.
  Sign in again.
- **Card not listed**: click Refresh. The tool only lists USB/SD/MMC disks that
  are not the Windows boot or system disk. Some readers report the card only
  after a re-insert; if it still does not appear, try a different reader or
  USB port. Cards over 256 GiB and USB hard disks/SSDs are refused.
- **"Another program is using the card" / "Access is denied"**: another program
  has the card open (Explorer preview, an antivirus scan, a previous flash that
  did not finish). Re-insert the card and try again.
- **"The card changed since it was chosen"**: the card or reader changed
  between Refresh and Flash. Click Refresh, check the target, retry.
- **"The image was written but the first-boot files were NOT"**: Windows did
  not mount the boot partition in time. The card holds a plain, unconfigured OS;
  re-insert it and Flash again.
- **Download fails or is slow**: use the bundled image (the default), or
  "Local image file" under Advanced with an image you downloaded from
  raspberrypi.com.
- **Pi does not appear on the console**: put the card back in the PC and read
  `firstrun.log` on the boot partition: every step is listed with its exit
  status (`rc=0` is good) and `firstrun.ok` exists when all of them passed. If
  that looks fine, the Pi booted; SSH in (`ssh -i
  %APPDATA%\Projection5000\ssh\id_ed25519 projector-admin@<device-id>.local`)
  and read `/var/log/projection5000-provision.log`: it shows whether the Pi
  could reach the console, sync its clock, enroll and run the installer.
  `enrollment failed (curl rc=22)` with a 401 means the console's enrollment
  key was rotated after the card was flashed: flash it again (the flasher
  fetches the current key).
- **SSH says "Permission denied (publickey)"**: the card was flashed on another
  PC (a different key) or the key files were deleted and regenerated. Re-flash
  the card, or add this PC's `.pub` line (Advanced, "Copy public key") to the
  Pi's `~projector-admin/.ssh/authorized_keys` from a PC that can log in.
- **ssh.exe says "UNPROTECTED PRIVATE KEY FILE"**: the ACL on
  `id_ed25519` is too open (the log said "icacls failed" when the key was
  created). Run `icacls "%APPDATA%\Projection5000\ssh\id_ed25519"
  /inheritance:r /grant:r "%USERNAME%:F"`.
- **Wrong Wi-Fi password / SSID**: nothing to fix on the card after the fact,
  re-flash it.
