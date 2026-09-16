# Adding a Pi to Projection5000

End-to-end walkthrough for taking a fresh Raspberry Pi (4 or 5) and turning it
into a projector loop player.

## Before you start

You'll need:

- A Raspberry Pi 4 or 5
- microSD card (32GB+ recommended)
- HDMI cable to the projector (use **HDMI0** on a Pi 4 — the port closer to
  the USB-C power port)
- The Pi connected to the same network as the controller, or Tailscale
  installed on both

> **On Windows: use the Projection5000 SD Flasher** (`tools/flasher/README.md`).
> It replaces sections 1, 2, 4 and 5 below: fill in the form, insert a card,
> click Flash, put the card in the Pi. No console login is needed: the exe
> carries the console's **enrollment key** (Settings page, baked in by
> `build.ps1`) and the Pi enrolls itself on first boot, creating the device
> and fetching its token. Re-flashing a card with the same device id
> re-enrolls the same device (same token, same playlist); rotate the key on the
> Settings page if a flashed card is lost, then rebuild the exe. If the
> Settings page names a default group and playlist ("New devices join
> group" / "New devices get playlist"), the device gets them on its first
> enrollment only; see [automation.md](automation.md). The manual
> path that follows still works.

## 1. Flash Raspberry Pi OS Lite (64-bit)

Download Raspberry Pi Imager: <https://www.raspberrypi.com/software/>.

Projection5000 supports both current Raspberry Pi OS releases:

| Release | Imager entry | mpv | Python |
| --- | --- | --- | --- |
| **Trixie** (Debian 13) | Raspberry Pi OS (other) → **Raspberry Pi OS Lite (64-bit)** | 0.40 | 3.13 |
| **Bookworm** (Debian 12) | Raspberry Pi OS (other) → **Raspberry Pi OS (Legacy) Lite (64-bit)** | 0.35 | 3.11 |

Pick either; the install script and the player daemon are tested against both
mpv versions. Use the 64-bit Lite image in both cases (no desktop).

In the Imager:

1. Choose device: Pi 4 or Pi 5.
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
the **Actions** column. It shows the token and the exact install command
(including the `cd` and the CMS URL the browser is using) — copy it.

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
  (Devices page → Token / install → **New token**), then either re-run the
  install script with the new token (step 5 command) or just edit
  `config.toml` and `sudo systemctl restart projector-player.service`. The
  old token stops working the moment you click New token.

**Player syncs but mpv doesn't switch:**

- `ls -l /tmp/projector-mpv.sock` — should exist. If not, mpv isn't running.
- `sudo systemctl restart projector-mpv.service`. The daemon notices the new
  mpv process (its pid changes) and re-pushes the playlist on its next loop.

**Reboot / Restart mpv buttons in the CMS do nothing:**

- Expand **Recent commands** for the device on the Devices page (last 5 commands
  with their result). A command is delivered on up to 5 polls; if the player
  never reports back it is marked `undeliverable`. On the Pi, check that
  `/etc/sudoers.d/projector-player` exists and `sudo -n -l -U projector`
  lists `/sbin/reboot` and `systemctl restart projector-mpv.service`; re-run
  the install script if not.

**Pi reboots and there's a desktop flash before mpv starts:**

- You installed Pi OS Desktop instead of Lite. Re-flash with Lite, or run
  `sudo systemctl set-default multi-user.target` to disable the desktop.

## Removing a Pi

In the CMS, click **Delete device** (Devices page → Token / install) next to
the device. Then on the Pi, from a clone of the repo (the installed copy under
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
