# Matt Brown's Projection5000 SD Flasher

Windows and macOS desktop tool (window title "Matt Brown's Projection5000") that writes Raspberry Pi OS Lite to
an SD card and pre-configures the Pi so that on first boot it joins the
network, takes its hostname, installs the Projection5000 player (a copy of
`player/` travels on the card; the Pi never needs GitHub access) and enrolls
itself with the console. One screen, one button, nothing to copy and paste.
The screen, the words and the flow are the same on both systems; the Windows
exe is described first, "On a Mac" below lists what differs on a Mac.

## The screen

The masthead is the product logo: the projector icon, "MATT BROWN'S" over
"PROJECTION5000". Under it the form, the white FLASH button, a progress bar and
one status line in plain words ("Ready.", "Writing the card (43%)...", "Done.
Put the card in the Pi and turn it on. It shows up on the Devices page in a
few minutes."). Nothing on the screen names the console, the fonts or the
account; all of that is under Advanced.

1. **Device name**, e.g. "Lobby Projector". The device id / hostname
   (`lobby-projector`) is derived from it and shown in grey under the entry.
   Then **pick your Pi model** in the row below it (see "Pi models"); the
   grey line under the box says what to expect from that board. The last
   choice is remembered.
2. **Wi-Fi network and password**. The network box lists the networks this
   PC currently sees (strongest first, the one it is connected to at the top;
   Refresh rescans). Picking one that this PC has a saved profile for fills
   the password too ("password from this computer" in grey; the hint goes
   away as soon as you edit it). A network that is not listed can be typed in as
   before. Leave both blank for a wired Pi.
3. **SD card**: pick the reader (Refresh rescans), press **FLASH**, confirm
   the erase warning. The first time on a PC the status line says "Approve
   this computer in the browser window that just opened, then the card is
   made automatically." and the browser opens the console's `/authorize` page
   with the code prefilled; approve it there and the flash continues with no
   further click (see "Connecting"). When it finishes: "Done. Put the card in
   the Pi and turn it on. It shows up on the Devices page in a few minutes."

The console is fixed (baked in by `build.ps1 -ConsoleUrl`, or the product
default) and never shown. There is no console field, no key field, no token
field and no Pi password field. Validation is inline, in plain words under the
field ("Give the Pi a name.", "Wi-Fi password must be 8-63 characters."); the
only dialogs are the erase confirmation, the final "Done" and a failure.

## Pi models

The model decides which OS image goes on the card. The 64-bit image built into
the exe boots every board from the Pi 3 up (and the Zero 2 W and the Pi 2
V1.2); the older 32-bit boards need the 32-bit image, which the flasher
downloads once (about 530 MB, cached in `%LOCALAPPDATA%\Projection5000\images`,
verified against the published `.sha256`) and reuses afterwards. No prompt: the
status line says "Getting the 32-bit image (12%)..." and the details log
"<model> needs the 32-bit image; downloading <name> (<size>)". Without
internet the model row shows "This model needs the 32-bit image. Connect to the
internet once (about 530 MB) and press FLASH again." The table lives in
`pimodel.py`, newest first; `--selfcheck` prints it.

| Pi model                     | Image                   | What to expect                                                  |
|------------------------------|-------------------------|-----------------------------------------------------------------|
| Raspberry Pi 5 / 500         | 64-bit, bundled         | Best pick. 4K video, camera, remote access.                     |
| Raspberry Pi 4 / 400         | 64-bit, bundled         | 1080p video, camera, remote access.                             |
| Raspberry Pi 3 (B, B+, A+)   | 64-bit, bundled         | 1080p video, camera, remote access. Slower updates.             |
| Raspberry Pi Zero 2 W        | 64-bit, bundled         | 1080p video, remote access. No camera (512 MB is not enough for the camera bridge). |
| Raspberry Pi 2 Model B V1.2  | 64-bit, bundled         | Same chip as the Pi 3. Board print says V1.2.                   |
| Raspberry Pi 2 Model B V1.1  | 32-bit, downloaded once | 1080p may stutter. No camera. Board print says V1.1 (the common one). |
| Raspberry Pi Zero / Zero W   | 32-bit, downloaded once | Slow: 720p at best. No camera. Zero (no W) needs a USB Wi-Fi or Ethernet adapter. |
| Raspberry Pi 1 Model B+ / A+ | 32-bit, downloaded once | Slow: 720p at best. No camera. Wi-Fi needs a USB adapter.       |

A card made for the wrong model sits on the rainbow square (the 64-bit image
has no kernel for a Pi 1, Pi 2 V1.1, Zero or Zero W): pick the right model and
flash it again. There is no image choice on the screen: the model decides.
Developers can write any file instead with `python flasher.py --image
C:\path\to\x.img.xz` (or `$env:FLASHER_IMAGE`); it is written as given, with a
warning in the details log when its name carries the other architecture.

## What is automatic

- **Enrollment key**: fetched from the console at flash time with your sign-in
  (`GET /api/operator/enrollment`), written to the card, never shown; the
  details log says "Enrollment key: ok". The flasher never enrolls anything itself: the Pi
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
  The `.pub` file next to it is the line for any other machine's
  `authorized_keys`. (On a Mac the key is
  `~/Library/Application Support/Projection5000/ssh/id_ed25519`, mode 0600.)
  The key, like every file under "Files on this PC", belongs to the Windows
  account that answered the UAC prompt: a standard user who typed an
  administrator's password finds it under that administrator's profile (the
  details log names the path: "Created the SSH key ..."). A lost or damaged
  `.pub` is derived from the private key again; the private key is never
  replaced (an unreadable one is set aside as `id_ed25519.bak`).
- **Time zone, keyboard, Wi-Fi country**: taken from Windows (the registry's
  time zone key mapped to an IANA name, the input locale, the region setting;
  fallbacks `America/Los_Angeles`, `us`, `US`). `--selfcheck` prints what this
  PC yields; Advanced lets you override the time zone.
- **Image**: for 64-bit models the Raspberry Pi OS Lite arm64 image built
  into the exe (see "Bundled image"); no download, no internet needed. For
  the 32-bit models the one-time download (see "Pi models").
- **Wyze bridge**: when the console has a Wyze account (`wyze_configured` in
  the enrollment answer) the card's installer runs with `--with-wyze`; the
  details log says so. Nothing to tick.
- **The technical log**: every line the tool used to print (console, fonts,
  image, enrollment key, disk steps, the summary) goes to the details box
  under Advanced and to `%LOCALAPPDATA%\Projection5000\flasher.log`
  (timestamped, appended; rotated to `flasher.log.1` at 2 MB). The status line
  never shows any of it.

## Advanced

One collapsed section at the bottom holds everything else (the window grows to
show it):

- **Time zone** (editable, from Windows), **Hidden Wi-Fi network**.
- **Static IP** (`192.168.1.50/24`) and **Gateway** (also used as the DNS
  server); blank means DHCP. Works for Wi-Fi and wired cards.
- **Account**: "Connected as <you>" with **Disconnect** (forgets the stored
  sign-in; revoke the token on the console's Settings page as well if the PC
  changes hands), or "Not connected" with **Connect** (the same browser flow
  FLASH runs by itself).
- **Show details**: reveals the technical log box. **Dry run** (see "Run from
  source"). The build stamp.

A problem in an Advanced field opens the section and shows the words there.

## Connecting

The device-code flow, so no token is ever copied by hand. It is invisible in
normal use: a stored token is used silently, and FLASH connects first when
there is none.

1. FLASH (or Connect under Advanced) calls `POST /api/operator/device-code`
   (no auth) with this PC's hostname and gets a `device_code`, a short
   `user_code` and the `verification_url`.
2. The browser opens `<verification_url>?code=<user_code>`; the status line
   reads "Approve this computer in the browser window that just opened, then
   the card is made automatically." If no browser could be opened the status
   line shows the URL and the code to type. On the console (signed in as an
   editor or admin) you approve "Sign in the SD Flasher on <hostname>?".
   Cancel (or closing the window) stops the wait and puts the line back to
   "Ready.".
3. The flasher polls `POST /api/operator/device-token` every few seconds for
   up to 10 minutes. `428` means not yet, `410 {status}` means expired or denied
   (the status line then reads "Not approved: denied on the console" or "The
   approval took too long (10 minutes). Press FLASH again."), `200` carries the
   token (one shot) and your username; the flash then continues by itself.
4. The token is stored DPAPI-protected (Windows `CryptProtectData`, readable
   only by the same Windows account) in `%APPDATA%\Projection5000\flasher.json`
   together with the console URL and username (on a Mac: in the login
   keychain, the file holds only the URL and username). On later launches it is used
   right away and checked with `GET /api/operator/enrollment` in the
   background; a `401` (revoked) forgets it so the next FLASH connects again,
   a network error keeps it. A token saved for a different console is ignored.
   The result of the check is a line in the details log, never on the screen.

On the console the sign-in appears as an API token named "SD Flasher on
<hostname>" (Settings, "My API tokens"); revoke it there to lock a PC out.

## Requirements

- Windows 10/11, 64-bit, an SD card reader; or a Mac (macOS 12 or newer, Apple
  Silicon or Intel; see "On a Mac").
- Administrator rights (raw disk writes). The exe and the source both relaunch
  themselves elevated (UAC prompt) on start. On a Mac nothing is relaunched:
  macOS asks for your password when the card is written.
- Internet access for the Pi's first boot (and, once, for the 32-bit image of
  the older models; the bundled image needs none).
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
not. The browser opened for the approval runs from the elevated process; that
is fine for approving a code.

## On a Mac

Download `Projection5000-SD-Flasher-mac-arm64.dmg` (Apple Silicon: M1, M2,
M3, M4) or `Projection5000-SD-Flasher-mac-intel.dmg` (an Intel Mac) from the
release, open it and drag **Projection5000 SD Flasher** to Applications.

**The first time you open it** macOS says the app "cannot be opened because
the developer cannot be verified" (it is signed but not notarized, see
below). Do this once:

1. In Applications, **right-click** (or Control-click) **Projection5000 SD
   Flasher** and choose **Open**.
2. In the box that appears, click **Open** again.

On macOS 15 (Sequoia) and newer the right-click trick is gone and the steps
are:

1. Double-click the app; macOS says it was not opened. Click **Done**.
2. Open **System Settings**, **Privacy & Security**, scroll down to the line
   that says the app was blocked and click **Open Anyway**.
3. Enter your Mac password, then click **Open** in the box that follows.

After that it opens like any other app. (Removing this step needs an Apple
Developer account, US$99 a year: `build_mac.sh` signs with
`FLASHER_SIGN_IDENTITY="Developer ID Application: ..."` when it is set
(hardened runtime and timestamp included), after which the DMG is sent to
`xcrun notarytool submit --wait` and stapled with `xcrun stapler staple`;
without the account the ad hoc signature and the first-open step stay.)

Then it is the same screen: name the Pi, pick the model, pick the Wi-Fi,
pick the card, press **FLASH**, confirm the erase warning. What differs:

- **Password prompt**: writing a card needs administrator rights, so macOS
  shows its standard prompt ("Projection5000 SD Flasher wants to make
  changes") once per flash. Enter your Mac password. Cancel it and the status
  line says "Permission was refused or the password prompt was cancelled:
  enter your Mac password when asked, then flash again"; nothing was written.
  This is Apple's `authopen`, the same mechanism Raspberry Pi Imager and
  Etcher use; no `sudo`, nothing installed.
- **Cards** are listed as `disk4  SanDisk  32 GB` (what `diskutil list` and
  Finder call them), USB readers and the built-in SD slot alike. Internal
  disks, disk images, USB hard disks and SSDs and any disk holding a mounted
  system volume are never listed. Refresh rescans.
- **Wi-Fi**: the network list comes from `system_profiler` (no Location
  permission needed; it takes a few seconds, the box says "Looking for
  networks..." meanwhile). Picking a network this Mac knows reads its password
  from the keychain: macOS puts up its keychain prompt (your Mac user name and
  password, then **Allow**); Cancel or Deny just leaves the field empty for
  you to type.
- **Time zone, keyboard, Wi-Fi country** come from macOS (`/etc/localtime`,
  the keyboard layout in System Settings, the region of the language setting).
- **The sign-in** (first FLASH, browser approval) is the same; the token is
  kept in the login keychain as "Matt Brown's Projection5000" (Keychain
  Access shows it), never in a file.
- **Ejecting**: the card is ejected when the flash finishes, as on Windows.
  macOS's own files (`._*`, `.fseventsd`, `.Spotlight-V100`) are removed from
  the boot partition first.
- **The card is written the same way**: unmounted, the old partition table
  blanked, the image streamed to the raw device (`/dev/rdiskN`), read back and
  verified, and the partition table written and checked last, so macOS cannot
  mount the new boot partition and write to it before the verification is
  done.

Files on this Mac (all under `~/Library/Application Support/Projection5000`):
`flasher.json` (the remembered form, never a secret), `signin.json` (the
console URL and your user name; the token itself is in the keychain),
`flasher.log` (the technical log), `images/` (downloaded images) and
`ssh/id_ed25519` plus `.pub` (the SSH key, mode 0600;
`ssh -i ~/"Library/Application Support/Projection5000/ssh/id_ed25519" projector-admin@<device-id>.local`,
the `~` outside the quotes so the shell expands it). **Disconnect** under
Advanced deletes the keychain item and `signin.json`.

Two more one-time prompts can appear on a Mac. Writing the first-boot files
to the card may trigger "Projection5000 SD Flasher would like to access
files on a removable volume": click **Allow** (declining fails the flash with
the words "macOS did not let the flasher write to the card ..."; the fix is
System Settings, Privacy & Security, Files and Folders, allow the flasher
under Removable Volumes, then flash again). And if macOS says the app "is
damaged and can't be opened" instead of offering Open (some versions say
this about downloaded apps that are signed but not notarized), clear the
download flag once in Terminal and open the app again:
`xattr -d com.apple.quarantine "/Applications/Projection5000 SD Flasher.app"`.
Both go away with notarization.

Run from source on a Mac: `python3 flasher.py` from `tools/flasher` (Python
3.11+ with tkinter; python.org's installer has it, Homebrew's needs
`python-tk`). No admin shell: the password prompt appears at FLASH.
`--dry-run`, `--selfcheck` and `--image` work as on Windows; `--selfcheck`
prints "defaults from macOS: ...".

Build: `bash tools/flasher/build_mac.sh` (same environment variables as
`build.ps1`: `FLASHER_CONSOLE_URL`, `FLASHER_ENROLL_KEY` for an offline build,
`FLASHER_IMAGE`, `FLASHER_NO_BUNDLE`, `FLASHER_PYTHON`) makes
`dist/Projection5000 SD Flasher.app`, signs it ad hoc, runs `--selfcheck`
(output in `dist/selfcheck.txt`) and packs `dist/Projection5000-SD-Flasher-mac-arm64.dmg`
or `-intel.dmg` after the Mac it runs on. The OS image is not appended to the
program (a Mach-O with bytes after it fails its signature) but written to
`Contents/Resources/bundle.bin`, the same image-plus-trailer bytes, which is
the second place `bundle.find_bundle()` looks. The GitHub Actions workflow
`.github/workflows/flasher-mac.yml` builds both DMGs (Apple Silicon on
`macos-14`, Intel on `macos-15-intel`), runs this test suite on macOS first,
and attaches them to a release: run it by hand (Actions, flasher-mac, Run
workflow, optionally naming an existing release tag) or let it run when a
release is published. It needs no secret beyond the repository's own token.

How the code is split: `flasher.py` (the screen and the flash sequence) never
asks which system it is on. `sysplat.py` picks, once, by `sys.platform`:
`windisk.py` / `macdisk.py` (cards), `wifi.py` / `macwifi.py` (networks),
`winlocale.py` / `maclocale.py` (time zone, keymap, country) and
`winhost.py` / `machost.py` (folders, the token store, fonts, elevation, the
window). The pairs expose the same function names; the streaming and verify
engine (`write_image`, `verify_image`, the deferred first MiB) is one piece of
code in `windisk.py` used by both. `tests/test_mac*.py` drive the macOS
modules on any system with `diskutil`, `authopen`, `system_profiler`,
`security` and `defaults` faked.

## What happens on the card

1. Re-reads the target disk and refuses if it is not the disk that was
   confirmed (same reader slot, size and partition signature: a swapped card or
   a renumbered drive is caught), removes every partition (`Clear-Disk`,
   skipped when the disk is already RAW), locks the disk, streams the image
   (all but its first MiB) to `\\.\PhysicalDriveN` with Win32 `WriteFile`,
   flushes, reads the written image back to verify (the blank first MiB
   skipped; the unused rest of the card is not read), then writes and re-reads
   the first MiB (the partition table) and asks Windows to re-read it. The
   table lands last because Windows mounts the new boot partition and starts
   writing its own files there the moment it sees one. On a Mac the same
   order, with `diskutil` and `/dev/rdiskN` (see "On a Mac").
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
`bundled image: <name> <bytes> bytes sha256 <hex> (trailer ok)`; the details
log names it at flash time ("Using bundled image <name> ...").

To rebuild with a newer image, run `build.ps1` again: it resolves the official
"latest" redirect, downloads into the tool's own cache
(`%LOCALAPPDATA%\Projection5000\images`, so a second build does not download
again), verifies the `.sha256` and embeds it. `$env:FLASHER_IMAGE = 'C:\path\to\x.img.xz'`
embeds that file instead (offline or pinned builds); `$env:FLASHER_NO_BUNDLE = '1'`
builds the small exe without an image (every model's image is then
downloaded). The exe is about 550 MB with the image inside.

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
then stops with "Dry run finished. Nothing was written." (the details log has
"Dry run: would write ..."). Use it to check the form and the connection before
touching a card. `--image <path>` (or `$env:FLASHER_IMAGE`) writes that
`.img` / `.img.xz` instead of the model's image, for developers.

`python flasher.py --selfcheck` prints the generated `firstrun.sh`,
`projection5000-provision.sh` and `cmdline.txt` for a sample configuration,
the console line, the Pi model table (key, image arch, label), the
Windows-derived defaults and the SSH key path, and exits
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
bakes the console into `console.json` (never shown on screen); without it the
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

The window wears the console's look (`cms/app/static/style.css`: black ground,
white ink, solid white primary action, corner brackets) on ttk's clam engine.
The masthead is the logo: `icon.png` at 64 px, "MATT BROWN'S" in Silkscreen
Regular 13 pt and "PROJECTION5000" in Silkscreen Bold 24 pt; the status line
is IBM Plex Mono. The three faces (Silkscreen, IBM Plex Mono, Space Grotesk;
OFL notices alongside) live in `fonts/`, travel in the exe (`--add-data`) and
are registered for the process only at startup (`gdi32.AddFontResourceExW`,
`FR_PRIVATE`: nothing is installed); the details log line "Fonts: ..." says
which families are in use, with Consolas / Segoe UI as fallbacks. `icon.ico`
is the window and exe icon and `icon.png` the masthead's (`make_icon.py`
renders both; both travel in the exe), `version.txt` the exe's version
resource (Explorer's Properties > Details).

## Tests

```powershell
cms\.venv\Scripts\python.exe -m pytest tools\flasher\tests -q
```

On a Mac: `python3 -m pytest -q` from `tools/flasher` (the first-boot script
tests that run bash need GNU `sed` and `stat` and an `openssl` with
`passwd -6`: `brew install gnu-sed coreutils openssl@3` with their `gnubin`
and `bin` folders first on PATH, as the CI workflow does; without GNU tools
they skip). The same
suite runs on Windows and macOS: the Windows-only tests (live PowerShell,
DPAPI, gdi32, netsh) skip on a Mac and the macOS layer's tests run everywhere
with the tools faked.

No admin rights, card, console or browser needed: the write engine is tested
against temp files and a fake drive with a synthetic `.img.xz`, the download
code against a local HTTP server on a free port, enrollment, the key fetch and
the device-code sign-in against a stub console (`/api/enroll`,
`/api/operator/enrollment`, `/api/operator/device-code`,
`/api/operator/device-token`) and (one test, skipped until that CMS answers
`/api/enroll`) against the real Python CMS in `cms/`, the rendered
`firstrun.sh` and `projection5000-provision.sh` by running them in bash against
stubbed tools, the SSH key against RFC 8032 vectors and `ssh-keygen -y`, and
the GUI (the exact set of top-level fields, the masthead, inline validation,
the connect-then-flash flow, the status line, the details log and its file,
failure, cancel, confirmation) against a withdrawn Tk window. The GUI tests are skipped
when there is no display.

## Files on this PC (for a Mac see "On a Mac")

- `%LOCALAPPDATA%\Projection5000\flasher.json`: last-used form values (name,
  Pi model, Wi-Fi network, hidden flag, time zone, static IP, gateway). Never
  a password, key or token.
- `%LOCALAPPDATA%\Projection5000\flasher.log` (and `.log.1`): the technical
  log, the same lines as the details box.
- `%APPDATA%\Projection5000\flasher.json`: the sign-in (console URL, username,
  DPAPI-protected token). "Disconnect" under Advanced deletes it.
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

- **"Approve this computer in the browser window that just opened ..."** and
  nothing happens: the browser page must be approved by an editor or admin
  within 10 minutes; a viewer account cannot approve. If no browser opened the
  status line shows the URL and the code; open it on any device that can
  reach the console.
- **The browser asks for approval again** on a PC that was connected: the
  token was revoked on the console (Settings, "My API tokens") or created by
  another Windows account. Approve once more; Advanced shows "Connected as
  <you>" afterwards.
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
- **"Could not get the image."**: a 32-bit model needs its one-time download;
  the line under the model row says so. Connect the PC to the internet and
  press FLASH again (developers: `--image` with a file from raspberrypi.com).
- **The Pi shows a rainbow square and nothing else**: the card was made for
  the wrong model (a 64-bit image on a Pi 1, Pi 2 V1.1, Zero or Zero W). Pick
  the right model and flash again; `docs/adding-a-pi.md` has the longer list.
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
  the card, or add this PC's `%APPDATA%\Projection5000\ssh\id_ed25519.pub` line
  to the Pi's `~projector-admin/.ssh/authorized_keys` from a PC that can log in.
- **ssh.exe says "UNPROTECTED PRIVATE KEY FILE"**: the ACL on
  `id_ed25519` is too open (the details log said "icacls failed" when the key
  was created). Run `icacls "%APPDATA%\Projection5000\ssh\id_ed25519"
  /inheritance:r /grant:r "%USERNAME%:F"`.
- **Wrong Wi-Fi password / SSID**: nothing to fix on the card after the fact,
  re-flash it.
- **The network list is empty** ("type the network name"): the scan comes
  from `netsh wlan show networks`; there is no Wi-Fi adapter, it is off, or
  the Wireless AutoConfig service is not running. On a non-English Windows
  the output may not be recognised at all: type the network name, everything
  else works the same. The saved password is read from `netsh wlan show
  profile ... key=clear` and is never written to the log file or the settings.
- **"turn on Location in Windows Settings to list networks"**: this PC is
  connected to Wi-Fi but the scan is empty. Windows 11 hides scan results
  from desktop apps while Location access is off: Settings, Privacy &
  security, Location, turn on "Location services" and "Let desktop apps
  access your location", then click Refresh next to the network box.
