# Backups — PiPlayer Cloud

Two things hold state: D1 `piplayer-cloud-db` (users, devices (incl. camera RTSP URLs),
playlists, schedules, audit log, settings (incl. the enrollment key and alert webhook URL),
api_tokens, alerts, device_codes and secrets) and R2 `piplayer-cloud-media` (`media/<filename>`
objects, `screenshots/<device_id>.jpg` and `camera/<device_id>.jpg`). Back them up together; a
media row without its object is exactly the "download failed" condition the player reports as
`sync_error`.

## D1: SQL dump

```sh
cd cloud
npx wrangler d1 export piplayer-cloud-db --remote --output=./backup/db-$(date +%F).sql
```

`--remote` targets the production database (omit it, or pass `--local --persist-to <dir>`,
for a local dev copy). The file is plain SQL (schema + data); `--no-schema` / `--no-data` /
`--table <name>` narrow it. Keep it private: it holds password hashes (PBKDF2, salted), device
bearer tokens (each one also fetches the Wyze password and the device's Cloudflare Tunnel token
on sync), the enrollment key, the alert webhook URL, up to an hour of unclaimed operator tokens
in `device_codes`, and session rows. The `secrets` table (Wyze, Twilio) and the per-device
camera RTSP URLs (`devices.camera_rtsp_url`, which carry the camera's password; a URL saved
before they were encrypted stays plain until it is re-saved) are encrypted with a key derived
from `SESSION_SECRET` and are unreadable without it.

Restore into an empty database:

```sh
npx wrangler d1 create piplayer-cloud-db         # only if the database is gone; update wrangler.toml
npx wrangler d1 execute piplayer-cloud-db --remote --file=./backup/db-2026-09-15.sql
```

The dump includes the `d1_migrations` bookkeeping table, so `npm run migrate:remote`
afterwards applies only migrations newer than the dump. Sessions in the dump are stale by then;
`DELETE FROM sessions` after a restore forces everyone to log in again, which is what you want
if the restore was security-motivated.

If a dump may have leaked, also: Settings > New key (enrollment), Devices > New token on
every device, re-enter the alert webhook URL, and delete unclaimed device codes
(`DELETE FROM device_codes`; the housekeeping does it within the hour anyway). If the worker
was recreated with a new `SESSION_SECRET`, Wyze and Twilio show as not set after the restore
and every RTSP camera reads as `none`: re-enter them on Settings and in each device's Camera
block.

## R2: media and screenshots

Option A — rclone (bulk, incremental). Create an R2 API token (dashboard → R2 → Manage R2 API
Tokens, Object Read for backups) and put this in `~/.config/rclone/rclone.conf`:

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <token access key id>
secret_access_key = <token secret>
endpoint = https://<account_id>.r2.cloudflarestorage.com
acl = private
```

```sh
rclone copy r2:piplayer-cloud-media ./backup/media --progress        # download everything new/changed
rclone copy ./backup/media r2:piplayer-cloud-media --progress        # restore
```

`rclone copy` never deletes; use `rclone sync` only when you want the destination to mirror
the source exactly.

Option B — wrangler only (no extra tools, one request per object). Wrangler has no bulk list
or sync command, so drive it with the list of filenames from D1:

```sh
mkdir -p backup/media
npx wrangler d1 execute piplayer-cloud-db --remote --json --command "SELECT filename FROM media" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>JSON.parse(s)[0].results.forEach(r=>console.log(r.filename)))" \
  | while read -r f; do
      npx wrangler r2 object get "piplayer-cloud-media/media/$f" --remote --file "backup/media/$f"
    done
```

Restore one object with `npx wrangler r2 object put piplayer-cloud-media/media/<filename> --remote --file backup/media/<filename> --content-type video/mp4`
(the worker serves the stored content type as `Content-Type`; set it to match the extension).
Screenshots and camera snapshots (`screenshots/`, `camera/`) are transient — the player
re-uploads them every `screenshot_interval` / `camera_interval` seconds — so they are not worth
backing up.

## Verify a backup

- `grep -c "INSERT INTO media" backup/db-*.sql` should equal the number of files under
  `backup/media/`.
- Optional integrity check: every `media.sha256` in the dump is the SHA-256 of the file with
  that `filename` (`sha256sum backup/media/<filename>`); the player performs the same check on
  download, so a mismatch here is a mismatch a Pi would also report.

## Schedule

Nightly `d1 export` plus `rclone copy` from any machine with the credentials is enough: the
media set only changes when someone uploads, and D1 rows are small. Keep at least the last
few dumps; the daily cron prunes audit rows older than `PIPLAYER_AUDIT_RETENTION_DAYS`, so an
old dump is the only place older audit history survives.
