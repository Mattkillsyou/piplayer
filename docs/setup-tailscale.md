# Setting up Tailscale

Tailscale is the recommended way to reach your Projection5000 CMS from anywhere
without exposing it to the public internet. It's free for personal use (up to
100 devices) and takes ~5 minutes.

## What you get

- Reach `http://controller-pi:8080` from any laptop, phone, or tablet you own,
  anywhere in the world.
- No port forwarding, no DNS, no HTTPS certificates to manage. (The
  connection is plain `http://` inside the encrypted Tailscale tunnel, so
  leave `PIPLAYER_HTTPS_ONLY` at its default `0` — with `1` the login cookie
  is only sent over https and this path stops working.)
- Devices that aren't on your Tailnet can't see the CMS at all.

## Sign up

1. Go to <https://tailscale.com> and click "Get started for free".
2. Sign in with Google, Microsoft, GitHub, or email.
3. That's it — you don't need to configure anything yet.

## Install on the controller Pi

SSH into the controller Pi and run:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The command will print a URL — open it in any browser logged into your
Tailscale account. The Pi will appear in your Tailnet.

Find the Pi's Tailscale name:

```bash
tailscale status
```

You'll see something like `controller-pi.tail1234.ts.net`. That's its address.

## Install on each player Pi

Same two commands as above. Each player joins your Tailnet and can reach the
controller by its Tailscale name, regardless of which network it's on.

After Tailscale is up on a player, edit `/etc/projector-player/config.toml` and
change `cms_url` to the controller's Tailscale name:

```toml
cms_url = "http://controller-pi.tail1234.ts.net:8080"
```

Then restart the player:

```bash
sudo systemctl restart projector-player.service
```

## Install on your laptop / phone

- **Mac / Windows / Linux:** download from <https://tailscale.com/download>.
- **iOS / Android:** install the Tailscale app from the App Store / Play Store.

Sign in with the same account. Done — you can now reach the controller from
anywhere by typing `http://controller-pi.tail1234.ts.net:8080` in your
browser.

## Tighten it up (optional)

In the Tailscale admin console (<https://login.tailscale.com/admin/machines>):

- **Disable key expiry** on the Pis so they never need re-authentication:
  click the device → "Disable key expiry".
- **Tag the Pis** as servers (`tag:server`) and your phones/laptops as clients
  (`tag:client`), then write an ACL that only allows clients to reach
  servers on port 8080.

## Troubleshooting

- **"Can't reach the Pi":** run `tailscale ping controller-pi` from your
  laptop. If it fails, check that both devices show "Connected" in
  `tailscale status`.
- **"It worked at home, not at the office":** corporate networks sometimes
  block UDP, forcing Tailscale to use a slower TCP relay. Still works, just
  slower for video preview.
- **"I want to use a short name":** in the admin console, enable MagicDNS to
  use just `controller-pi:8080` instead of the full `.ts.net` name.
