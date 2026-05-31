# Exposing the CMS on the public internet

If you want to reach the CMS from a device that doesn't have Tailscale
installed (e.g., showing it to a client on their phone), you can expose it
publicly. **Tailscale is still the safer default** — only do this if you need
no-install access.

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

### 6. Update PiPlayer config

In `/etc/projector-cms/env`, set:

```
PIPLAYER_PUBLIC_BASE_URL=https://cms.yourdomain.com
```

Then restart: `sudo systemctl restart projector-cms.service`.

This makes the player-download URLs absolute and pointed at the public host,
so player Pis on other networks can reach the videos.

### 7. Put authentication in front of it

Cloudflare Zero Trust → Access → Applications → Add an application →
Self-hosted. Hostname: `cms.yourdomain.com`. Policy: require email match for
your email, or your Google Workspace domain.

Now anyone hitting `cms.yourdomain.com` gets a Cloudflare login page first.
Even if PiPlayer's own login were bypassed, attackers wouldn't reach it.

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
6. Set `PIPLAYER_PUBLIC_BASE_URL=https://cms.yourhost.duckdns.org` in
   `/etc/projector-cms/env` and restart the CMS.

You're now public. Set a strong admin password
(`PIPLAYER_ADMIN_PASSWORD` env), watch your logs, and consider fail2ban.

## Security checklist before going public

- [ ] Set a long, unique `PIPLAYER_ADMIN_PASSWORD`
- [ ] Set a strong `PIPLAYER_SECRET_KEY` (the install script auto-generates one)
- [ ] Put Cloudflare Access / Caddy basic auth in front, OR rely on the
      built-in login (Cloudflare Access is much stronger)
- [ ] Enable automatic OS security updates: `sudo apt install unattended-upgrades`
- [ ] Watch logs: `journalctl -u projector-cms.service -f`
- [ ] Run `fail2ban` if exposing directly without Cloudflare Access
