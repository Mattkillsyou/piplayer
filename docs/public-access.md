# Exposing the CMS on the public internet

If you want to reach the CMS from a device that doesn't have Tailscale
installed (e.g., showing it to a client on their phone), you can expose it
publicly. **Tailscale is still the safer default** — only do this if you need
no-install access.

Two things to keep straight before you start:

- **Humans and players use different paths.** People log in through the web
  UI (session cookie); player Pis talk to `/api/*` with their device bearer
  token and never see a login page. Anything you put in front of the public
  hostname (Cloudflare Access, basic auth) must let `/api/*` through, or
  every player that uses that hostname stops syncing.
- **`PIPLAYER_PUBLIC_BASE_URL` is usually not needed.** The CMS builds each
  media download URL from the `Host` and `X-Forwarded-Proto` of the request
  that fetched the manifest (the systemd unit runs uvicorn with
  `--proxy-headers`, trusting the same-host proxy), so a player that polls
  `http://controller-pi:8080` gets `http://controller-pi:8080/api/media/...`
  and one that polls `https://cms.yourdomain.com` gets the https URL. Set the
  variable only when the CMS sees a wrong `Host` (a proxy that rewrites it),
  and understand that it then rewrites the download URL for **every** player,
  including LAN and Tailscale ones — they must all be able to reach that
  address.

## Recommended: Cloudflare Tunnel

Cloudflare Tunnel is free, gives you HTTPS automatically, requires no port
forwarding, and lets you put Cloudflare Access in front of it for SSO-based
auth. Cloudflare's edge handles TLS and DDoS; your Pi just runs a daemon that
connects outbound.

### 1. Get a domain

You need a domain managed by Cloudflare (free Cloudflare account works,
domain can be from any registrar but nameservers point at Cloudflare).

### 2. Install cloudflared on the controller Pi

```bash
curl -L --output cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared.deb
```

For Pi Zero / older 32-bit Pi use the `linux-armhf` package.

### 3. Create the tunnel

```bash
cloudflared tunnel login          # opens a browser, pick the zone
cloudflared tunnel create piplayer
cloudflared tunnel route dns piplayer cms.yourdomain.com
```

### 4. Configure routes

Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: piplayer
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: cms.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

### 5. Run as a service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### 6. Tell the CMS it is behind TLS

In `/etc/projector-cms/env`, set:

```
PIPLAYER_HTTPS_ONLY=1
```

Then restart: `sudo systemctl restart projector-cms.service`.

This marks the session cookie `Secure`, so a browser never sends it over
plain http. Only do this once **every** way you log in is https: with
`PIPLAYER_HTTPS_ONLY=1`, logging in at `http://controller-pi:8080` (LAN or
Tailscale) no longer works — the browser drops the cookie and you bounce back
to the login page. If you still want the plain-http path for yourself, leave
it at `0` (the default) and put Cloudflare Access in front (next step).

Leave `PIPLAYER_PUBLIC_BASE_URL` unset unless your players are going to reach
the CMS *only* through `cms.yourdomain.com` (see the note at the top). If you
do set it, use `PIPLAYER_PUBLIC_BASE_URL=https://cms.yourdomain.com` and make
sure step 7 lets `/api/*` through, or every player will fail its downloads.

`PIPLAYER_FORWARDED_ALLOW_IPS` (default `127.0.0.1`, set in the systemd unit)
is the list of proxy addresses whose `X-Forwarded-*` headers the CMS trusts.
`cloudflared` on the same Pi connects from `127.0.0.1`, so the default is
right; only change it if the tunnel daemon runs on another machine.

### 7. Put authentication in front of it — but not in front of `/api/*`

Cloudflare Access is deny-by-default: an unauthenticated request to a
protected hostname is redirected to the identity-provider login page. Player
Pis only send a `Authorization: Bearer <device token>` header, so if `/api/*`
is behind Access every manifest fetch and media download comes back as login
HTML (the player logs a sha256 mismatch or an HTTP error on every poll and
never loads the new playlist). Create
two applications so the API path bypasses Access:

1. Cloudflare Zero Trust → **Access → Applications → Add an application →
   Self-hosted**.
   - Application name: `PiPlayer API`
   - Application domain: `cms.yourdomain.com`, path `api` (this covers
     `cms.yourdomain.com/api/*`)
   - Add a policy: name `players`, **Action: Bypass**, Include: **Everyone**.
   - Save.
2. Add a second Self-hosted application:
   - Application name: `PiPlayer`
   - Application domain: `cms.yourdomain.com` (no path)
   - Add a policy: name `admins`, **Action: Allow**, Include: **Emails**
     (your address) or your Google Workspace / Microsoft domain.
   - Save.

Access applies the most specific matching application, so `/api/*` requests
skip the login page while everything else gets it. The API is still
protected by the device tokens (a token can only fetch the manifest for its
own device and only the media in that device's current playlist) and by the
built-in login for the rest.

Alternative: Cloudflare **Service Tokens** (Access → Service Auth) let a
client authenticate with `CF-Access-Client-Id` / `CF-Access-Client-Secret`
headers instead of a bypass. The PiPlayer daemon does not send those headers,
so use the Bypass application above for players.

Now anyone hitting `cms.yourdomain.com` in a browser gets a Cloudflare login
page first. Even if PiPlayer's own login were bypassed, attackers wouldn't
reach it.

## Alternative: direct port forward + Caddy

Only do this if you can't use Cloudflare (e.g., self-hosted DNS only).

1. Set up dynamic DNS (DuckDNS, no-ip, etc.) so a hostname points at your
   home IP.
2. Forward port 443 on your router to the controller Pi.
3. Install Caddy on the Pi:
   ```bash
   sudo apt install -y caddy
   ```
4. Configure `/etc/caddy/Caddyfile`:
   ```
   cms.yourhost.duckdns.org {
     reverse_proxy localhost:8080
   }
   ```
5. `sudo systemctl reload caddy`. Caddy will auto-fetch a Let's Encrypt cert.
6. Set `PIPLAYER_HTTPS_ONLY=1` in `/etc/projector-cms/env` (same caveat as
   step 6 above: every login must then be over https) and restart the CMS.
   Caddy proxies from `127.0.0.1`, so the default
   `PIPLAYER_FORWARDED_ALLOW_IPS` is correct. Leave `PIPLAYER_PUBLIC_BASE_URL`
   unset unless all players use the public hostname.

You're now public with only the built-in login between the internet and the
CMS. Change the admin password (next section), watch your logs, and run
fail2ban.

### fail2ban for the direct-exposure path

The CMS logs every failed login at WARNING as
`login failed for user=<name> ip=<ip>` (and records it in the audit log as
`login_failed`), and locks an IP+username pair for 30 s after 5 failures
(HTTP 429). fail2ban can turn repeated failures into a firewall ban. With
Caddy the client connects straight to the Pi, so the ban is effective (behind
Cloudflare Tunnel it is not — connections arrive from `cloudflared` on
localhost — use Access there instead).

```bash
sudo apt install -y fail2ban
```

`/etc/fail2ban/filter.d/piplayer.conf`:

```ini
[Definition]
failregex = login failed for user=\S+ ip=<HOST>
ignoreregex =
```

`/etc/fail2ban/jail.d/piplayer.conf`:

```ini
[piplayer]
enabled      = true
backend      = systemd
journalmatch = _SYSTEMD_UNIT=projector-cms.service
filter       = piplayer
port         = http,https
maxretry     = 5
findtime     = 10m
bantime      = 1h
```

Then `sudo systemctl restart fail2ban` and check with
`sudo fail2ban-client status piplayer`. Test it: make five bad logins and
confirm your IP appears under "Banned IP list" (from a different address than
the one you administer from, or you will lock yourself out for an hour).

## Changing the admin password

`PIPLAYER_ADMIN_PASSWORD` (and `PIPLAYER_ADMIN_USERNAME`) are read **only
when the first admin user is created**, i.e. on the very first start with an
empty database. Setting the variable in `/etc/projector-cms/env` on a running
install and restarting changes nothing — the CMS logs nothing about it and
the old password keeps working.

To change a password on an existing install: log in as an admin, open
**Users**, type the new password in the **Reset password** box on that user's
row and click **Set**. This works on your own account too. Do this for the
`admin` user before going public if it still has the generated password from
the install log (that password was printed to the journal, which anyone with
`sudo` on the controller can read), or any weak password you chose.

## Security checklist before going public

- [ ] Change the admin password via **Users → Reset password** (not the env
      var — it only seeds the first admin)
- [ ] `PIPLAYER_SECRET_KEY` is set in `/etc/projector-cms/env` (the install
      script generates one; without it sessions don't survive a restart)
- [ ] Put Cloudflare Access in front, with the `/api` Bypass application so
      players keep working, OR rely on the built-in login (Cloudflare Access
      is much stronger)
- [ ] `PIPLAYER_HTTPS_ONLY=1` once every login path is https
- [ ] `PIPLAYER_PUBLIC_BASE_URL` left unset unless every player uses the
      public hostname
- [ ] Enable automatic OS security updates: `sudo apt install unattended-upgrades`
- [ ] Watch logs: `journalctl -u projector-cms.service -f` (failed logins
      show as `login failed for user=... ip=...`; the **Audit** page lists
      them as `login_failed`)
- [ ] Run `fail2ban` with the filter above if exposing directly without
      Cloudflare Access
