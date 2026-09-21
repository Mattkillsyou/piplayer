# Building a master SD-card image

Once you have one Pi running Projection5000 end-to-end, you can clone its SD card to
a `.img` file and flash it to every other Pi. Each new Pi only needs a 30-second
edit to give it a unique `device_id` and token.

This is much faster than running `install-player.sh` on every Pi by hand, and
gives you a consistent base to roll back to if something gets weird.

## When to do this

- After at least one Pi is fully working (video plays, CMS shows it online).
- Before deploying to 3+ more Pis. For 1–2 more Pis, the SSH + install-script
  path is probably faster than reading this doc.

## One image, all Pi models

You do **not** need separate images for Pi 3 / Pi 4 / Pi 5. Raspberry Pi OS
Lite 64-bit contains kernels and device-tree blobs for every supported board;
the bootloader picks the right one at runtime. Flash the same `.img` to any
model.

Two caveats:

- **Use a 64-bit image.** Pi 5 requires 64-bit. Pi 3/4 work fine on 64-bit
  too. Do not snapshot from a 32-bit install — it won't boot on a Pi 5. Both
  supported releases are fine as the base: Trixie (Imager's "Raspberry Pi OS
  Lite (64-bit)", mpv 0.40) or Bookworm (Imager's "Raspberry Pi OS (Legacy)
  Lite (64-bit)", mpv 0.35). See [adding-a-pi.md](adding-a-pi.md) step 1.
- **Pi 3 is slow for video.** It's roughly half the CPU of a Pi 4 and uses
  the older VideoCore IV decoder. 1080p H.264 plays but may stutter; 720p
  plays smoothly; images are always fine. If you have Pi 3s, either keep
  them on lighter content or save them for non-projector tasks.

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

# Set the timezone once here so every clone logs in local time. (Schedule
# rules are evaluated on the *controller* Pi, so set it there too — see the
# README. The players' own zone only affects their journal timestamps.)
sudo timedatectl set-timezone Region/City   # e.g. America/Los_Angeles

# Blank the device-specific config (we'll fill it in per-Pi after flashing).
# Keep the "# device_id = " / "# device_token = " / "# cms_url = " lines
# exactly as written: Option B in Step 5 rewrites them with sed.
sudo tee /etc/projector-player/config.toml > /dev/null <<'EOF'
# Per-device identity. Fill in the three lines below on each Pi before it
# goes into service (see docs/make-master-image.md, Step 5).
# device_id = "REPLACE_ME"
# device_token = "REPLACE_ME"
# cms_url = "http://REPLACE_ME:8080"
media_dir = "/var/lib/projector-player/media"
manifest_path = "/var/lib/projector-player/manifest.json"
mpv_socket = "/tmp/projector-mpv.sock"
poll_interval_seconds = 30
EOF

# Drop any downloaded media, the cached manifest and the player's local state
# (hash cache + executed-command list) from the master.
sudo rm -rf /var/lib/projector-player/media/* \
            /var/lib/projector-player/manifest.json \
            /var/lib/projector-player/media_index.json \
            /var/lib/projector-player/executed_commands.json

# Remove SSH host keys so all your Pis don't end up with the same host key,
# and make sure they are regenerated on the clones' first boot (see below).
sudo rm -f /etc/ssh/ssh_host_*
sudo systemctl enable regenerate_ssh_host_keys.service
sudo tee /etc/systemd/system/piplayer-ssh-hostkeys.service > /dev/null <<'EOF'
[Unit]
Description=Regenerate SSH host keys if missing (Projection5000 master image)
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key
Before=ssh.service

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable piplayer-ssh-hostkeys.service

# Clear bash history and shut down.
history -c
sudo poweroff
```

**Why the extra SSH steps?** Raspberry Pi OS regenerates host keys with
`regenerate_ssh_host_keys.service`, but that unit runs exactly once — on the
master's own first boot — and then disables itself. Your master has already
booted (you are SSHed into it), so the unit is already disabled, and a clone
made after `rm -f /etc/ssh/ssh_host_*` would boot with **no host keys and no
way to make them**: `sshd` refuses to start ("no hostkeys available") and every
`ssh pi@...` below is refused. Re-enabling the unit fixes this on Bookworm. On
Trixie the stock unit is additionally gated on "first boot" (which a clone is
not), so the small `piplayer-ssh-hostkeys.service` above runs `ssh-keygen -A`
whenever the keys are missing, on either release. It stays enabled and is
harmless once keys exist. **Repeat the `enable regenerate_ssh_host_keys` line
every time you re-image** — the stock unit disables itself again after each
first boot.

**What a freshly flashed, not-yet-configured Pi does:** the player daemon
cannot start until `device_id`, `device_token` and `cms_url` are all set. Until
then `journalctl -u projector-player.service` shows "missing required config"
and the service keeps retrying. That is expected, not a fault; it picks the
config up within one restart once you complete Step 5. mpv starts regardless
and shows a black screen.

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

You have two options. In both cases the values come from the CMS: on the
**Devices** page (signed in as an admin), expand **Token / install** for the device you
registered for this Pi.

### Option A: SSH in and edit (simpler, requires monitor or known IP)

Boot the Pi with HDMI + a keyboard attached, OR with ethernet so you can find
its IP from your router. Then SSH in:

```bash
ssh pi@<ip-or-hostname>

sudo nano /etc/projector-player/config.toml
# Uncomment and fill in device_id, device_token, cms_url. Save.

sudo hostnamectl set-hostname lobby-projector  # or whatever, optional
sudo systemctl restart projector-player.service projector-mpv.service
sudo reboot
```

Within 30 seconds of reboot, the Pi should be syncing with the CMS (check
**Last seen** on the Devices page).

### Option B: Edit before first boot (no monitor needed)

After flashing, the SD card still in your laptop — mount it. The boot
partition (FAT32) is visible to all OSes; the root partition needs Linux/WSL.

Linux/WSL:

```bash
# mount the rootfs partition
sudo mount /dev/sdX2 /mnt/pi
sudo sed -i \
    -e 's|^# device_id = .*|device_id = "lobby-projector"|' \
    -e 's|^# device_token = .*|device_token = "PASTE_FROM_CMS"|' \
    -e 's|^# cms_url = .*|cms_url = "http://controller-pi:8080"|' \
    /mnt/pi/etc/projector-player/config.toml
sudo umount /mnt/pi
```

The patterns are anchored on `# device_id = ` (with the ` = `) on purpose:
they must match only the three placeholder lines, never the header comment.
A stray second `device_id = ...` line would make the config invalid TOML and
the daemon would refuse to start.

On Windows: easiest to use Option A.

## Updating the master image

When Projection5000 code changes, update the golden master with a fresh copy of the
repo and re-run the installer. `/opt/piplayer/player` is a plain copy of the
`player/` subtree (no `.git`, no `deploy/`), so you cannot `git pull` there —
always work from a clone in your home directory. The installer rewrites
`/etc/projector-player/config.toml` from `DEVICE_ID`, `DEVICE_TOKEN` and
`CMS_URL`, so those must be supplied again; if the master still has its
identity in `config.toml`, read them from there:

```bash
# 1. Fresh clone of the repo (or `git pull` in an existing clone).
rm -rf ~/piplayer
git clone https://github.com/Mattkillsyou/piplayer.git ~/piplayer
cd ~/piplayer/player

# 2. Re-use the identity already in config.toml (skip this if the master was
#    left blank by Step 1 — then paste DEVICE_ID/DEVICE_TOKEN/CMS_URL from the
#    Devices page instead, exactly as in adding-a-pi.md).
eval "$(sudo sed -n \
    -e 's/^device_id = "\(.*\)"$/export DEVICE_ID="\1"/p' \
    -e 's/^device_token = "\(.*\)"$/export DEVICE_TOKEN="\1"/p' \
    -e 's/^cms_url = "\(.*\)"$/export CMS_URL="\1"/p' \
    /etc/projector-player/config.toml)"
echo "$DEVICE_ID $CMS_URL"   # sanity check: both should be non-empty

# 3. Re-run the installer (sudo -E keeps the three variables).
sudo -E bash deploy/install-player.sh
```

Then:

1. Confirm the master plays and shows online in the CMS.
2. Re-run Step 1 (clean state, including the SSH host-key lines) and Step 2
   (snapshot).
3. The old `.img` is now stale — re-flash existing Pis at your leisure, or
   leave them and they'll keep working with the older code. To upgrade a Pi
   in place instead of re-flashing, use the same three commands above on that
   Pi (see "Operations" in the README).

## Per-device serial numbers in your CMS

A useful convention: name your devices in the CMS to match the room or
projector, and pick a `device_id` you can remember (e.g.
`lobby-projector-1`, `lobby-projector-2`, `studio-projector`). The token is
the only thing that has to be unique and unguessable.
