# Building a master SD-card image

Once you have one Pi running PiPlayer end-to-end, you can clone its SD card to
a `.img` file and flash it to every other Pi. Each new Pi only needs a 30-second
edit to give it a unique `device_id` and token.

This is much faster than running `install-player.sh` on every Pi by hand, and
gives you a consistent base to roll back to if something gets weird.

## When to do this

- After at least one Pi is fully working (video plays, CMS shows it online).
- Before deploying to 3+ more Pis. For 1–2 more Pis, the SSH + install-script
  path is probably faster than reading this doc.

## What you'll need

- The "golden master" Pi (the one that's working)
- An SD card reader on your laptop (or a card reader on another Linux machine)
- ~16GB of free disk space for the raw image
- Optional: a Linux box (or WSL) to run `pishrink.sh` so the resulting `.img`
  is only as big as the data actually on it

## Step 1: Prepare the golden master

Before cloning, generalize the master so it doesn't carry one device's identity.
SSH into the golden Pi:

```bash
sudo systemctl stop projector-player.service projector-mpv.service

# Blank the device-specific config (we'll fill it in per-Pi after flashing).
sudo tee /etc/projector-player/config.toml > /dev/null <<'EOF'
# device_id, device_token, cms_url MUST be set on each device before booting.
# device_id = "REPLACE_ME"
# device_token = "REPLACE_ME"
# cms_url = "http://REPLACE_ME:8080"
media_dir = "/var/lib/projector-player/media"
manifest_path = "/var/lib/projector-player/manifest.json"
mpv_socket = "/tmp/projector-mpv.sock"
poll_interval_seconds = 30
EOF

# Drop any downloaded media + cached manifest from the master.
sudo rm -rf /var/lib/projector-player/media/* /var/lib/projector-player/manifest.json

# Remove SSH host keys (they'll regenerate on first boot — important so all your
# Pis don't end up with the same host key).
sudo rm -f /etc/ssh/ssh_host_*

# Clear bash history and shut down.
history -c
sudo poweroff
```

## Step 2: Snapshot the SD card

Unplug the SD card from the Pi and put it in your laptop.

### On Windows

1. Install [Win32 Disk Imager](https://win32diskimager.org/) (free).
2. Launch it.
3. Click the folder icon and choose a save location, name it
   `piplayer-master.img`.
4. Pick the SD card's drive letter in the **Device** dropdown. **Triple-check
   this** — picking the wrong drive will overwrite data.
5. Click **Read**. Takes 5–15 minutes depending on card size.

### On Linux / macOS

```bash
# Find the device (e.g. /dev/sdb or /dev/disk2). lsblk on Linux, diskutil list on Mac.
sudo dd if=/dev/sdX of=piplayer-master.img bs=4M status=progress conv=fsync
```

You'll end up with a `.img` file the size of the SD card (e.g., 32GB) even
though most of it is empty. That's fine until you want to ship it around.

## Step 3 (optional but recommended): Shrink the image

A 32GB `.img` is unwieldy. `pishrink.sh` resizes it to just the data actually
in use. Run on Linux or WSL:

```bash
wget https://raw.githubusercontent.com/Drewsif/PiShrink/master/pishrink.sh
chmod +x pishrink.sh
sudo ./pishrink.sh piplayer-master.img
```

After shrinking, the image is typically 3–6GB. It will auto-resize on first
boot to fill whatever SD card you flash it to.

## Step 4: Flash to each new Pi

Use Raspberry Pi Imager (or balenaEtcher):

1. Choose OS → **Use custom** → pick `piplayer-master.img`.
2. Choose storage → the target SD card.
3. **Don't** use Imager's "advanced options" to set hostname/SSH/Wi-Fi —
   those settings only work with stock Pi OS images. We'll do it manually.
4. Write.

## Step 5: Configure each Pi after flashing

You have two options.

### Option A: SSH in and edit (simpler, requires monitor or known IP)

Boot the Pi with HDMI + a keyboard attached, OR with ethernet so you can find
its IP from your router. Then SSH in:

```bash
ssh pi@<ip-or-hostname>

sudo nano /etc/projector-player/config.toml
# Set device_id, device_token, cms_url. Save.

sudo hostnamectl set-hostname lobby-projector  # or whatever, optional
sudo systemctl restart projector-player.service projector-mpv.service
sudo reboot
```

Within 30 seconds of reboot, the Pi should be syncing with the CMS.

### Option B: Edit before first boot (no monitor needed)

After flashing, the SD card still in your laptop — mount it. The boot
partition (FAT32) is visible to all OSes; the root partition needs Linux/WSL.

Linux/WSL:

```bash
# mount the rootfs partition
sudo mount /dev/sdX2 /mnt/pi
sudo sed -i \
    -e 's|^# device_id.*|device_id = "lobby-projector"|' \
    -e 's|^# device_token.*|device_token = "PASTE_FROM_CMS"|' \
    -e 's|^# cms_url.*|cms_url = "http://controller-pi:8080"|' \
    /mnt/pi/etc/projector-player/config.toml
sudo umount /mnt/pi
```

On Windows: easiest to use Option A.

## Updating the master image

When PiPlayer code changes:

1. Pull the latest code on the golden Pi: `cd /opt/piplayer/player && sudo git
   pull`, then re-run `sudo bash deploy/install-player.sh`.
2. Re-run Step 1 (clean state) and Step 2 (snapshot).
3. The old `.img` is now stale — re-flash existing Pis at your leisure, or
   leave them and they'll keep working with the older code.

## Per-device serial numbers in your CMS

A useful convention: name your devices in the CMS to match the room or
projector, and pick a `device_id` you can remember (e.g.
`lobby-projector-1`, `lobby-projector-2`, `studio-projector`). The token is
the only thing that has to be unique and unguessable.
