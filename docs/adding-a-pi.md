# Adding a Pi to PiPlayer

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

## 1. Flash Raspberry Pi OS Lite (64-bit)

Download Raspberry Pi Imager: <https://www.raspberrypi.com/software/>.

In the Imager:

1. Choose device: Pi 4 or Pi 5.
2. Choose OS: **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**.
3. Choose storage: your SD card.
4. Click the gear icon for advanced options:
   - Set hostname (e.g. `lobby-projector`)
   - Enable SSH with password auth
   - Set username and password
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

After creating, click **Show** in the Token column. It displays the exact
install command — copy it.

## 5. Clone the repo onto the Pi and run the install script

On the Pi (over SSH):

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Mattkillsyou/piplayer.git
cd piplayer/player
```

(Or copy the project over with `scp -r` if you don't want to push it to git.)

Run the install command from the CMS Devices page. It looks like:

```bash
DEVICE_ID=lobby-projector \
DEVICE_TOKEN=<long-string-from-cms> \
CMS_URL=http://controller-pi:8080 \
sudo -E bash deploy/install-player.sh
```

The script will:

- install mpv, Python, etc.
- create the `projector` system user
- set up a Python venv and install the daemon
- write `/etc/projector-player/config.toml` with your device credentials
- install and start the systemd services
- disable the console getty on tty1 so mpv owns the display

## 6. Assign a playlist

Back in the CMS, on the **Devices** page, pick a playlist from the dropdown
next to your new device. Within 30 seconds the Pi will sync.

If the playlist isn't empty, you should see video on the projector shortly
after.

## 7. Verify

On the Pi:

```bash
# is the daemon running and syncing?
sudo journalctl -u projector-player.service -f

# is mpv running?
sudo journalctl -u projector-mpv.service -f

# are the videos downloaded?
ls -lh /var/lib/projector-player/media/

# is the playlist file written?
cat /var/lib/projector-player/playlist.m3u
```

A healthy player logs sync attempts every 30 seconds:

```
piplayer.sync: sync complete: 3 items, hash=sha256:abc...
```

## Troubleshooting

**No video on the projector:**

- Confirm HDMI cable is in HDMI0 (Pi 4: the port closer to USB-C).
- `sudo journalctl -u projector-mpv.service -n 50` — look for errors. The
  most common is "could not open drm device" — usually means the
  `projector` user doesn't have `video`/`render` group membership. Re-run the
  install script.
- Check `cat /etc/projector-player/config.toml` — confirm device ID, token,
  CMS URL are correct.

**"401 Unauthorized" in the player log:**

- The token in `config.toml` doesn't match what's in the CMS. Regenerate the
  token in the CMS (Devices page → New token), re-run the install script with
  the new token, or just edit `config.toml` and `systemctl restart
  projector-player.service`.

**Player syncs but mpv doesn't switch:**

- `ls -l /tmp/projector-mpv.sock` — should exist. If not, mpv isn't running.
- `sudo systemctl restart projector-mpv.service`

**Pi reboots and there's a desktop flash before mpv starts:**

- You installed Pi OS Desktop instead of Lite. Re-flash with Lite, or run
  `sudo systemctl set-default multi-user.target` to disable the desktop.

## Removing a Pi

In the CMS, click **Delete** next to the device on the Devices page. Then on
the Pi:

```bash
sudo systemctl disable --now projector-mpv.service projector-player.service
sudo rm -rf /opt/piplayer /var/lib/projector-player /etc/projector-player
sudo rm /etc/systemd/system/projector-mpv.service /etc/systemd/system/projector-player.service
sudo userdel projector
```
