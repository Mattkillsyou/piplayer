# Adding a Pi to Projection5000

End-to-end walkthrough for taking a fresh Raspberry Pi and turning it into a
projector loop player. A Pi 5 or Pi 4 is the normal choice; older boards work
too, see "Which Pi?" below.

## Before you start

You'll need:

- A Raspberry Pi (see "Which Pi?" below; a Pi 5 is the best pick)
- microSD card (32GB+ recommended)
- HDMI cable to the projector (use **HDMI0** on a Pi 4 — the port closer to
  the USB-C power port)
- The Pi connected to the same network as the controller, or Tailscale
  installed on both

> **On Windows: use the Projection5000 SD Flasher** (`tools/flasher/README.md`).
> It replaces sections 1, 2, 4 and 5 below. There is one button. Fill in the
> form, press **Flash**, and the card is made; no console login on the Pi and
> nothing to copy and paste:
>
> 1. **Device name**, e.g. "Lobby Projector"; the device id / hostname
>    (`lobby-projector`) is derived and shown under it.
> 2. **Pi model**: pick the board the card is going into (the dropdown under
>    Device name; the line under it says what to expect). The flasher
>    remembers your last pick. Get this right: a card made for the wrong
>    model stays on the rainbow square (see Troubleshooting).
> 3. **Wi-Fi network and password** (blank for a wired Pi).
> 4. **SD card**, then **Flash**. The line under the progress bar tells you
>    what is happening in plain words ("Writing the card (43%)...") and ends
>    with "Done. Put the card in the Pi and turn it on."
>
> The first time you press Flash on a PC, the flasher needs to be connected
> to your Projection5000 account. The status line says "Approve this computer
> in the browser window that just opened", a browser page opens with a code
> already filled in, and you click Approve (as an admin; the page also shows
> which computer asked and from where). The
> flasher then carries on and makes the card by itself; nothing more to click.
> From then on the PC stays connected and Flash just flashes. If the browser
> does not open, the status line shows the web address and the code to type.
> **Advanced** (collapsed, at the bottom) shows whether this PC is connected
> ("Connected as <you>" with a **Disconnect** button, or **Connect**), plus
> time zone, hidden network, static IP, and a **Show details** checkbox that
> reveals the full technical log for when something goes wrong. The same log
> is saved to `%LOCALAPPDATA%\Projection5000\flasher.log`.
>
> Behind the scenes: the flasher fetches the console's current **enrollment
> key** with your connection and puts it on the card, never showing it; the
> Pi enrolls itself on first boot, creating the device and fetching its
> token, and appears on the Devices page within a few minutes. The Pi's login
> is the fixed user `projector-admin` with **SSH by key only**: the flasher
> makes one ed25519 key per Windows user
> (`%APPDATA%\Projection5000\ssh\id_ed25519`) and installs the public key
> on every card; there is no Pi password to record. Time zone, keyboard
> layout and Wi-Fi country come from Windows; the 64-bit image is built into
> the exe, and the 32-bit image for the older models is downloaded once
> (about 530 MB) and kept for later flashes (developers can point the flasher
> at another image with `--image <path>` or the `FLASHER_IMAGE` environment
> variable). Re-flashing a card with the same device id re-enrolls the same
> device: the new card gets a new token and keeps the same playlist and
> group, and the old card stops syncing. Rotate the key on the Settings page
> when a card or a flasher PC is lost: the next flash fetches the new key,
> no rebuild needed. If the Settings page names a default group and playlist ("New
> devices join group" / "New devices get playlist"), the device gets them on
> its first enrollment only; see [automation.md](automation.md) sections A
> and B. Both consoles enroll: the cloud console and the Python console
> (`cms/`) each have the Settings page with the key and the two defaults, but
> only the cloud console offers the browser approval; for a LAN-only cms site
> build the flasher with the offline `build.ps1 -ConsoleUrl <url> -Key <key>`
> override (the key from the cms Settings page), which flashes without
> connecting. The manual path that follows still works.
>
> **First boot.** Put the card in the Pi, plug in HDMI and power. The
> projector shows a black screen with "MATT BROWN'S PROJECTION5000" and the
> step it is on: "Step 1 of 4: first start", "Step 2 of 4: joining the
> network", "Step 3 of 4: installing the player (about 10 minutes)", "Step 4
> of 4: connecting to the console", then "Ready. Waiting for the first
> video." The whole thing takes about 10 minutes; leave it alone. A "login:"
> prompt never appears any more. If the screen says "Setup did not finish",
> read the line under it (it says why in plain words) and send Matt the log
> file named there (`/boot/firmware/setup-failed.log`; take the card out, put
> it in the PC, and it is `setup-failed.log` on the small `bootfs` drive).

## Which Pi?

The flasher's Pi model list, top to bottom. Every row plays the loop; the
differences are picture size, whether the room camera works and whether the
board has Wi-Fi of its own.

| Pi model (as in the flasher) | Plays | Camera | Remote access | Wi-Fi |
| --- | --- | --- | --- | --- |
| Raspberry Pi 5 / 500 | Up to 4K. Best pick. | Yes | Yes | Built in |
| Raspberry Pi 4 / 400 | 1080p | Yes | Yes | Built in |
| Raspberry Pi 3 (B, B+, A+) | 1080p. Slower updates. | Yes | Yes | Built in |
| Raspberry Pi Zero 2 W | 1080p | No (512 MB is not enough for the camera bridge) | Yes | Built in |
| Raspberry Pi 2 Model B V1.2 | 1080p (same chip as the Pi 3) | Yes | Yes | USB adapter or Ethernet |
| Raspberry Pi 2 Model B V1.1 | 1080p, may stutter | No | Yes | USB adapter or Ethernet |
| Raspberry Pi Zero / Zero W | 720p at best | No | No | Zero W built in; Zero (no W) needs a USB adapter |
| Raspberry Pi 1 Model B+ / A+ | 720p at best | No | No | USB adapter or Ethernet (B+ only) |

The first five rows get the 64-bit image built into the flasher. The last
three need the 32-bit image, which the flasher downloads once (about 530 MB)
and keeps for later flashes. "Remote access" is the console's tunnel to the
Pi; the Zero and Pi 1 do not get it because the tunnel program's package
does not run on their chip. A Pi 2 Model B comes in two versions that look the
same: read the white print on the board, "V1.1" is the 32-bit row and "V1.2"
the 64-bit row.

## 1. Flash Raspberry Pi OS Lite (64-bit)

Download Raspberry Pi Imager: <https://www.raspberrypi.com/software/>.

Projection5000 supports both current Raspberry Pi OS releases:

| Release | Imager entry | mpv | Python |
| --- | --- | --- | --- |
| **Trixie** (Debian 13) | Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)** | 0.40 | 3.13 |
| **Bookworm** (Debian 12) | Raspberry Pi OS (other) → **Raspberry Pi OS (Legacy) Lite (64-bit)** | 0.35 | 3.11 |

Pick either; the install script and the player daemon are tested against both
mpv versions. Use the 64-bit Lite image in both cases (no desktop). For the
32-bit models in the "Which Pi?" table (Pi 2 V1.1, Zero, Zero W, Pi 1) pick
**Raspberry Pi OS Lite (32-bit)** instead; the install script detects the
board and adjusts (no camera bridge, hardware video decoding on, no tunnel on
the Zero and Pi 1).

In the Imager:

1. Choose device: your Pi model.
2. Choose OS: one of the two Lite entries above.
3. Choose storage: your SD card.
4. Click the gear icon for advanced options:
   - Set hostname (e.g. `lobby-projector`)
   - Enable SSH with password auth
   - Set username and password
   - Set locale settings: pick your **time zone** (this also sets the
     keyboard layout). Player timestamps in the journal use this zone.
   - Configure Wi-Fi if you're not using ethernet
5. Write the image.

Insert the SD card, plug HDMI into HDMI0, power it on. Wait ~60 seconds for
the first boot.

## 2. SSH in

From your laptop:

```bash
ssh pi@<pi-hostname>.local
```

If `.local` doesn't resolve, find the Pi's IP from your router and use that.

## 3. (Optional but recommended) Install Tailscale

See [setup-tailscale.md](setup-tailscale.md). Saves a lot of pain later.

## 4. Register the device in the CMS

In your browser, open the CMS (e.g. `http://controller-pi:8080`), sign in, go
to **Devices → Register a new device**.

Fill in:

- **device_id:** short, lowercase, hyphens. e.g. `lobby-projector`. This is
  used in URLs and config — pick a stable name.
- **name:** friendly label, e.g. "Lobby Projector". Shown in the UI.

After creating, find the device's row and expand **Token / install** under
the **Actions** column (on the cloud console only an admin sees it). It
shows the token and the exact install command (including the `cd` and the
CMS URL the browser is using) — copy it.

## 5. Clone the repo onto the Pi and run the install script

On the Pi (over SSH). Pi OS Lite does not ship `git`, so install it first:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Mattkillsyou/piplayer.git
```

(Or copy the project over with `scp -r` if you don't want to push it to git.)

Run the install command from the CMS Devices page. It looks like:

```bash
cd piplayer/player && \
DEVICE_ID=lobby-projector \
DEVICE_TOKEN=<long-string-from-cms> \
CMS_URL=http://controller-pi:8080 \
sudo -E bash deploy/install-player.sh
```

`CMS_URL` is whatever address this Pi will use to reach the CMS — the LAN
address, or the controller's Tailscale name if you did step 3. `sudo -E` is
required so the three variables reach the script.

The script will:

- install mpv, Python, etc.
- create the `projector` system user
- set up a Python venv and install the daemon
- write `/etc/projector-player/config.toml` with your device credentials
- install the sudoers drop-in that lets the daemon reboot the Pi and restart
  mpv when you click those buttons in the CMS
- install and start the systemd services
- disable the console getty on tty1 so mpv owns the display

## 6. Assign a playlist

Back in the CMS, on the **Devices** page, pick a playlist from the dropdown
next to your new device. Within 30 seconds the Pi will sync.

If the playlist isn't empty, you should see video on the projector shortly
after.

## 7. Verify

The quickest check is in the CMS: the device's **Last seen** on the Devices
page (and the dashboard card) updates on every poll, i.e. every 30 seconds,
and no sync error is shown next to it. If a download failed, the error the
player reported is shown there as a warning (e.g.
`2 of 5 items missing: a.mp4, b.png`; the same text appears in the player
journal as `sync incomplete: ...`) and the player keeps retrying the missing
items on every poll while playing the ones it has.

On the Pi:

```bash
# is the daemon running and syncing?
sudo journalctl -u projector-player.service -f

# is mpv running?
sudo journalctl -u projector-mpv.service -f

# are the videos downloaded?
ls -lh /var/lib/projector-player/media/

# what playlist does the player think it has? (JSON, written after each sync)
cat /var/lib/projector-player/manifest.json
```

Right after install, or whenever you change the playlist in the CMS, the
player journal shows the downloads followed by:

```
piplayer.sync: sync complete: 3 items (3 downloaded, 0 missing), hash=sha256:abc...
```

**A healthy player is otherwise silent.** Polls that find the playlist
unchanged log nothing, so at steady state `journalctl -f` shows no new lines
for hours — that is not a hang. To watch a sync happen, keep `journalctl -f`
open and change something in the playlist (add or reorder an item); the
"sync complete" line appears within one poll interval. For liveness, use
**Last seen** in the CMS.

## Troubleshooting

**The Pi shows a rainbow square and nothing else:**

The rainbow square is the Pi's "powered on, found nothing to start" screen.
(A Pi 5 does not draw it; with a bad card it shows a text diagnostics screen
instead, which means the same thing.) Check these in order:

1. **The card was made for the wrong model.** This is the usual cause on a
   Pi 2, Zero or Pi 1: a card flashed for a Pi 4 or 5 carries the 64-bit
   system, which those boards cannot start. Open the flasher, pick the right
   row under **Pi model** (see "Which Pi?" above; on a Pi 2 read the V1.1 /
   V1.2 print on the board), and flash the card again.
2. **Wrong HDMI port.** A Pi 4 has two micro-HDMI ports; the picture comes
   out of the one marked **HDMI0**, next to the USB-C power socket. The Pi 5
   is the same. A Pi with one HDMI port has nothing to get wrong here.
   Source: [raspberrypi.com, Getting started](https://www.raspberrypi.com/documentation/computers/getting-started.html)
   ("plug your primary monitor into the port marked HDMI0").
3. **Read the green light.** The green ACT light (the one that flickers
   during card activity; on a Zero it is the only light) blinks a code when
   the Pi cannot start. Count the long and short flashes between the
   two-second pauses (long ones, if any, come first):

   | Flashes | Meaning | What to do |
   | --- | --- | --- |
   | 3 short | Generic failure to boot | Re-flash the card. |
   | 4 short | `start*.elf` not found (the card is empty or half written) | Re-flash the card. |
   | 7 short | Kernel image not found (no system on the card that this board can run) | Wrong model: re-flash with the right Pi model. |
   | 2 long, 2 short | Failed to read from partition (the card is unreadable) | Try another card or another reader. |
   | 4 long, 4 short | Unsupported board type | This image cannot run on this board at all. |

   A steady green light with the rainbow square (no blinking at all) also
   points at the wrong model: the Pi found a system on the card but not one
   it can start. Source: [raspberrypi.com, LED warning flash codes](https://www.raspberrypi.com/documentation/computers/configuration.html#led-warning-flash-codes).
4. **Power supply.** A phone charger or a long thin USB cable often cannot
   hold the Pi up; it sits at the rainbow square or reboots in a loop. Use
   the official supply for the board (27 W USB-C for a Pi 5, 15 W USB-C for
   a Pi 4, 2.5 A micro-USB for the Pi 3 and older) and a short cable.
5. **Look at the card on the PC.** Put the card back in the reader. Windows
   shows a small drive (a few hundred MB) called `bootfs`; it should contain
   `config.txt`, `cmdline.txt` and the kernel files (`kernel8.img` on a
   64-bit card; `kernel.img`, `kernel7.img` and `kernel7l.img` on a 32-bit
   card). If the drive is empty or Windows cannot open it, re-flash. After a
   first boot the same drive gains `firstrun.log`, so its presence tells you
   the Pi did get past the rainbow square at least once.

**No video on the projector:**

- Confirm HDMI cable is in HDMI0 (Pi 4: the port closer to USB-C).
- `sudo journalctl -u projector-mpv.service -n 50` — look for errors. The
  most common is "could not open drm device" — usually means the
  `projector` user doesn't have `video`/`render` group membership. Re-run the
  install script (with `DEVICE_ID`/`DEVICE_TOKEN`/`CMS_URL` and `sudo -E`,
  exactly as in step 5, or via the "Upgrading a player" commands in the
  README's Operations section).
- The shipped `mpv.conf` uses `vo=gpu` with `gpu-context=drm` for hardware
  decoding. If mpv logs a GPU/EGL error and the screen stays black, switch to
  the software path: edit `/var/lib/projector-player/.config/mpv/mpv.conf`,
  replace the `vo=gpu` / `gpu-context=drm` lines with `vo=drm`, and
  `sudo systemctl restart projector-mpv.service`. See "Operating notes" in the
  README.
- Check `sudo cat /etc/projector-player/config.toml` — confirm device ID,
  token, CMS URL are correct.

**The player log shows HTTP 401 or 403 from the CMS:**

- 401: the token in `config.toml` doesn't match what's in the CMS. 403: the
  token belongs to a different `device_id`. Regenerate the token in the CMS
  (Devices page → Token / install → **New token**; admin), then either re-run the
  install script with the new token (step 5 command) or just edit
  `config.toml` and `sudo systemctl restart projector-player.service`. The
  old token stops working the moment you click New token (on the cloud
  console a device with an automatic camera tunnel gets a new tunnel key
  too; the Pi picks it up on its next sync).

**Player syncs but mpv doesn't switch:**

- `ls -l /tmp/projector-mpv.sock` — should exist. If not, mpv isn't running.
- `sudo systemctl restart projector-mpv.service`. The daemon notices the new
  mpv process (its pid changes) and re-pushes the playlist on its next loop.

**Reboot / Restart playback buttons in the CMS do nothing:**

- Expand **Recent commands** for the device on the Devices page (last 5 commands
  with their result). A command is delivered on up to 5 polls; if the player
  never reports back it is marked `undeliverable`. Clicking the same button
  again while the first is still waiting queues nothing new (the cloud
  console says so at the top of the page). On the Pi, check that
  `/etc/sudoers.d/projector-player` exists and `sudo -n -l -U projector`
  lists `/sbin/reboot` and `systemctl restart projector-mpv.service`; re-run
  the install script if not.

**Pi reboots and there's a desktop flash before mpv starts:**

- You installed Pi OS Desktop instead of Lite. Re-flash with Lite, or run
  `sudo systemctl set-default multi-user.target` to disable the desktop.

## Removing a Pi

In the CMS, click **Delete device** (Devices page, at the bottom of the
device's Actions; editor or admin) next to the device. Then on the Pi, from a
clone of the repo (the installed copy under
`/opt/piplayer/player` has no `deploy/` directory):

```bash
git clone https://github.com/Mattkillsyou/piplayer.git ~/piplayer   # skip if you still have the clone
cd ~/piplayer/player
sudo bash deploy/install-player.sh --uninstall
```

`--uninstall` needs no `DEVICE_*` variables. It undoes what the installer did:
stops and disables both units and removes their files, removes the sudoers
drop-in, `/opt/piplayer/player`, `/var/lib/projector-player`,
`/etc/projector-player` and the `projector` user, re-enables the tty1 getty
and runs `systemctl daemon-reload`. It leaves `/opt/piplayer/cms` alone, so it
is safe on a Pi that is also the controller.
