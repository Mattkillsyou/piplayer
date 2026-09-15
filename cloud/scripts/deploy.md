# Deployment runbook — PiPlayer Cloud

Target: worker `piplayer-cloud` at `https://projectors.photogen5000.com` (D1 `piplayer-cloud-db`,
R2 `piplayer-cloud-media`). Run every command from `cloud/` with Node 24 / npm 11 after
`npm install`. Nothing below touches `hackthon5000`'s code, its D1 `hackthon-db` or its R2
`hackthon-media`; the only change to that worker is that the custom domain is moved.

Prerequisites: `npx wrangler login` with Workers Scripts, D1 and R2 write scopes on the account
that owns the `photogen5000.com` zone. Check with `npx wrangler whoami`. That account must be on
the **Workers Paid** plan (dashboard → Workers & Pages → Plans): Workers Free caps CPU at 10 ms
per request and one PBKDF2 password derivation (100 000 iterations) needs ≈ 15 ms, so login
and user creation would fail with error 1102; D1/R2 calls are subrequests (Free: 50 external +
1 000 to Cloudflare services per invocation, Paid: 10 000) and the Devices/Dashboard pages
issue several per device. `wrangler deploy` does not check the plan — a Free-plan deploy only
breaks at the first login. See README "Limits and design notes".

## 0. Verify the build first

```sh
npm test                    # vitest inside workerd (local D1/R2)
npm run e2e                 # black-box suites against wrangler dev (see README)
npm run deploy:dry          # wrangler deploy --dry-run --outdir dist: bundles, uploads nothing
```

## 1. Create the storage and record the D1 id

```sh
npx wrangler d1 create piplayer-cloud-db
npx wrangler r2 bucket create piplayer-cloud-media
```

`d1 create` prints a `database_id`; put it in `wrangler.toml` under `[[d1_databases]]`
(replace `TBD-set-at-deploy`). The bucket name already matches `[[r2_buckets]]`.

## 2. Apply the schema to the remote database

```sh
npm run migrate:remote      # = npx wrangler d1 migrations apply piplayer-cloud-db --remote
```

Wrangler lists the pending files in `migrations/` and asks for confirmation. Re-running is
safe: only unapplied migrations run.

## 3. Secrets (generated, never chosen by hand)

`SESSION_SECRET` signs the session cookie (HMAC-SHA256); `SETUP_TOKEN` guards the one-time
first-admin page. Generate them and pipe them straight into wrangler so they never land in
shell history or a file:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" | npx wrangler secret put SETUP_TOKEN
```

You will need the SETUP_TOKEN value once, in step 5, so print it to the terminal instead of
piping if you prefer (`node -e ...` alone, then paste it at the `wrangler secret put` prompt).
`npx wrangler secret list` shows the names (never the values). Rotating `SESSION_SECRET`
later logs every browser out; rotating `SETUP_TOKEN` is harmless once the first admin exists
(`/setup` answers 404 after that).

`wrangler secret put` targets the deployed worker; if the worker has never been deployed,
wrangler offers to create it — answer yes (an empty worker with secrets is fine, step 4
overwrites its code).

## 4. Move the custom domain, then deploy

`projectors.photogen5000.com` is currently attached to the worker `hackthon5000`. A hostname
can be a custom domain of only one worker, so detach it there first (do not touch anything
else on that worker).

Dashboard: Workers & Pages → `hackthon5000` → Settings → Domains & Routes → the row
`projectors.photogen5000.com` → Remove. (Cloudflare docs: the advanced certificate created for
a custom domain is not deleted with it; remove it under SSL/TLS → Edge Certificates only if
you want it gone — the new attachment reuses/creates one anyway.)

API (Workers Domains API, same effect):

```sh
# list domains on the account; note the "id" of the row whose hostname is projectors.photogen5000.com
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/domains"
# detach it from hackthon5000
curl -s -X DELETE -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/domains/<domain_id>"
```

Then deploy; `wrangler.toml` carries
`routes = [{ pattern = "projectors.photogen5000.com", custom_domain = true }]`, so the deploy
attaches the hostname (DNS record + certificate) to `piplayer-cloud`:

```sh
npm run deploy              # = npx wrangler deploy
```

Wrangler prints the version id and the bindings (DB, MEDIA, ASSETS, the `PIPLAYER_*` vars,
the cron `0 3 * * *`). Expect a minute or two before the certificate is active.

Smoke check:

```sh
curl -s https://projectors.photogen5000.com/api/health      # {"ok":true}
curl -sI https://projectors.photogen5000.com/               # 303 -> /setup (no users yet)
curl -s https://projectors.photogen5000.com/openapi.json    # {"detail":"Not Found"}
```

## 5. Hand over: first admin

Open `https://projectors.photogen5000.com/setup?token=<SETUP_TOKEN>` and create the admin
(username, password twice, min 6 chars). The form logs you in and `/setup` is gone from then
on (404). Then `/settings`: set the site timezone (IANA name, e.g. `America/Los_Angeles`) —
schedules and every displayed timestamp use it — plus the screenshot interval and default
image duration.

Point each Pi at it from the Devices page: register the device, open "Token / install" and run
the printed command on the Pi
(`cd piplayer/player && DEVICE_ID=... DEVICE_TOKEN=... CMS_URL=https://projectors.photogen5000.com sudo -E bash deploy/install-player.sh`).

## Rollback

- Code: `npx wrangler versions list` shows recent versions; `npx wrangler rollback [<VERSION_ID>]`
  (defaults to the previous version) puts an earlier bundle back without touching D1/R2.
  Migrations are additive (`migrations/000N_*.sql`, never edits), so an older worker keeps
  working against a newer schema.
- Domain: to give `projectors.photogen5000.com` back to `hackthon5000`, detach it from
  `piplayer-cloud` (dashboard or the DELETE call above) and re-attach it on `hackthon5000`
  (dashboard → that worker → Domains & Routes → Add custom domain, or a `wrangler deploy` of
  that worker with the same `routes` entry). Its D1/R2 data was never touched.
- Data: restore from the backups in `scripts/backup.md` (`wrangler d1 execute --remote --file`
  for the SQL dump, `rclone copy` back into the bucket for media).

## Later deploys

`npm run migrate:remote` (if `migrations/` gained files), then `npm run deploy`. The cron
handler (audit retention, abandoned uploads, expired sessions) needs nothing else.
