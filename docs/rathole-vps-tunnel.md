# Expose RSS Reader via rathole → Aliyun VPS (replacing Cloudflare Tunnel)

A step-by-step runbook to publish the local Mac RSS service (`127.0.0.1:3002`) on the public
internet through an Aliyun VPS, using **rathole** for the reverse tunnel and **Caddy** for TLS,
reusing the existing domain `rss.royl.uk`. This replaces the Cloudflare Tunnel path.

> **Public endpoint is `https://rss.royl.uk:8443`** (non-standard port). This is deliberate:
> Aliyun mainland ECS requires an ICP filing (备案) to serve on ports 80/443, so we avoid them
> entirely. The trade-off is that the port must appear in the URL, and ACME's HTTP-01 /
> TLS-ALPN-01 challenges (which only ever probe 80/443) cannot be used — so Caddy obtains its
> certificate via the **DNS-01 challenge** through Cloudflare's API. Cloudflare stays in
> **DNS-only (grey-cloud)** mode; Caddy manages the cert itself and auto-renews.

## Architecture

```
                 Aliyun VPS (public IP)                         Mac (behind NAT)
  ┌───────────────────────────────────────────┐     ┌──────────────────────────────┐
  │  Caddy :8443  (TLS, rss.royl.uk)           │     │  rathole client (launchd)    │
  │     │  reverse_proxy → 127.0.0.1:5202      │     │     dials out to VPS:2333     │
  │     ▼                                      │     │     forwards → 127.0.0.1:3002 │
  │  rathole server                            │◄────┤                              │
  │     control :2333  (noise + token)         │ tun │  RSS service (launchd)       │
  │     service rss → bind 127.0.0.1:5202      │ nel │     listens 127.0.0.1:3002    │
  └───────────────────────────────────────────┘     └──────────────────────────────┘

  Public client ─HTTPS :8443─► Caddy ─► rathole(VPS) ══tunnel══► rathole(Mac) ─► RSS :3002
```

- The **VPS is the rathole server** (it has the public IP and accepts the tunnel).
- The **Mac is the rathole client** (it dials *out* to the VPS, so no inbound port / no NAT
  forwarding is needed on the home network).
- `5202` is an arbitrary VPS-local port where the tunneled traffic surfaces. It is bound to
  `127.0.0.1` so **only Caddy** can reach it — it is never exposed publicly.
- Caddy terminates TLS and proxies plain HTTP to `127.0.0.1:5202`.

### Why no app code change is needed

- The rathole **client runs on the Mac** and connects to `127.0.0.1:3002`, so from Express's
  view the peer is loopback. `app.set('trust proxy', 'loopback')` therefore still trusts the
  forwarded headers — exactly as it did with `cloudflared`.
- Caddy's `reverse_proxy` automatically sets `X-Forwarded-Proto: https` and `X-Forwarded-For`.
  Those headers travel as part of the HTTP bytes through rathole's raw-TCP tunnel and reach
  Express unchanged. So:
  - `req.secure` is `true` → the session cookie's `Secure` flag works.
  - `req.ip` resolves to the **real public client** (from `X-Forwarded-For`), not `127.0.0.1`
    → the MCP localhost-only block keeps returning `404` over the tunnel, same as before.
- Net result: session auth (`AUTH_USER`/`AUTH_PASS`) and the MCP private-surface guarantee are
  preserved with no changes to `server/`.

> **Important:** the security depends on Caddy setting `X-Forwarded-For`. Do **not** point
> Caddy at rathole with header passthrough disabled, and do **not** expose port `5202`
> publicly — either would let a request reach Express with a loopback `req.ip` and silently
> unlock the MCP surface.

---

## Part 0 — Prerequisites & secrets

On the Mac, generate the shared tunnel **token** (used by both sides for client auth):

```bash
openssl rand -hex 32     # → <TUNNEL_TOKEN>
```

Then generate the noise **keypair** (required by the `noise` transport — its default
`Noise_NK` pattern needs a server static key + the client knowing the server's public key;
without it rathole aborts with `Missing noise config`):

```bash
rathole --genkey
# Private Key:  → <SERVER_PRIVATE_KEY>   (goes in server.toml on the VPS)
# Public Key:   → <SERVER_PUBLIC_KEY>    (goes in client.toml on the Mac)
```

Placeholders used throughout this guide — substitute your real values:

| Placeholder        | Meaning                                              | Example                 |
|--------------------|------------------------------------------------------|-------------------------|
| `<VPS_PUBLIC_IP>`      | Aliyun VPS public IP                              | `47.xx.xx.xx` |
| `<TUNNEL_TOKEN>`       | shared rathole token from `openssl rand -hex 32`  | `9f3c…`       |
| `<SERVER_PRIVATE_KEY>` | noise private key from `rathole --genkey` (VPS)   | `mAhh3v…`     |
| `<SERVER_PUBLIC_KEY>`  | noise public key from `rathole --genkey` (Mac)    | `DiR2T1…`     |
| `rss.royl.uk`          | the public hostname (reused)                      | —             |
| `<CF_API_TOKEN>`       | Cloudflare API token, *Zone → DNS → Edit* on royl.uk | `cf_xxx`   |

### Aliyun security group / firewall

Open **inbound** on the VPS for:

| Port   | Proto | Purpose                                            |
|--------|-------|----------------------------------------------------|
| `8443` | TCP   | public HTTPS (Caddy) — non-standard, no ICP filing needed |
| `2333` | TCP   | rathole control channel (Mac client dials in here) |

Do **not** open `80`, `443`, `5202`, or `3002`. (80/443 are intentionally avoided to skip ICP
filing; `5202`/`3002` must stay private.) All VPS commands below assume you are logged in as
**root** (drop the `sudo` prefixes if you copy from elsewhere). If `ufw` is enabled on the VPS:

```bash
ufw allow OpenSSH       # ⚠ ALWAYS allow SSH first, or `ufw enable` locks you out
ufw allow 8443/tcp
ufw allow 2333/tcp
ufw status              # confirm 22/8443/2333 are listed before relying on it
```

> If you ever do lock yourself out of SSH, recover via the Aliyun console's **VNC / Workbench**
> web terminal (it doesn't use port 22) and run `ufw allow OpenSSH && ufw reload`.

---

## Part 1 — Install rathole on the VPS (server)

SSH into the VPS. Download the latest release for `x86_64` Linux (check the version on
<https://github.com/rapiz1/rathole/releases>):

```bash
cd /tmp
RATHOLE_VER=v0.5.0          # pin to the current latest
curl -fsSL -o rathole.zip \
  "https://github.com/rapiz1/rathole/releases/download/${RATHOLE_VER}/rathole-x86_64-unknown-linux-gnu.zip"
unzip rathole.zip
install -m 0755 rathole /usr/local/bin/rathole
rathole --help    # sanity check
```

### Server config

```bash
mkdir -p /etc/rathole
tee /etc/rathole/server.toml >/dev/null <<'EOF'
[server]
bind_addr = "0.0.0.0:2333"          # control channel — open in the security group

[server.transport]
type = "noise"                       # encrypts the tunnel (rathole's plain TCP transport is cleartext)

[server.transport.noise]
local_private_key = "<SERVER_PRIVATE_KEY>"   # from `rathole --genkey`; without it: "Missing noise config"

[server.services.rss]
token = "<TUNNEL_TOKEN>"             # must match the Mac client exactly
bind_addr = "127.0.0.1:5202"         # tunneled traffic surfaces here; localhost-only on purpose
EOF
```

The config holds the token + private key, so lock it down to root-only (the service runs as
root here, so root ownership is exactly what it can read):

```bash
chmod 600 /etc/rathole/server.toml
```

Fill in `<TUNNEL_TOKEN>` and `<SERVER_PRIVATE_KEY>` in the file before starting
(`nano /etc/rathole/server.toml`).

### systemd unit (VPS)

```bash
tee /etc/systemd/system/rathole-server.service >/dev/null <<'EOF'
[Unit]
Description=rathole server (RSS tunnel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Runs as root (no User=/DynamicUser). Do NOT add DynamicUser=yes — a transient user
# cannot read the root-owned 600 config and the service crash-loops "Permission denied".
ExecStart=/usr/local/bin/rathole /etc/rathole/server.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now rathole-server
systemctl status rathole-server --no-pager
ss -tlnp | grep 2333          # rathole should own the control port
```

At this point the control port is listening but no client is connected yet — that's expected.

---

## Part 2 — Install rathole on the Mac (client)

The simplest on macOS is Homebrew:

```bash
brew install rathole
command -v rathole       # note the path — Apple Silicon: /opt/homebrew/bin/rathole, Intel: /usr/local/bin/rathole
```

> ⚠ Whatever path `command -v rathole` prints is the one the launchd plist below **must** use.
> A wrong/hardcoded path makes launchd exit with status `78` and the tunnel silently never
> starts. The plist generation below resolves it automatically with `$(command -v rathole)`.

(Manual alternative: download the `aarch64-apple-darwin` / `x86_64-apple-darwin` zip from the
releases page and `install -m 0755 rathole /opt/homebrew/bin/rathole`.)

### Client config

Store it next to the deploy root so it's easy to find:

```bash
mkdir -p ~/Deploy/rathole
cat > ~/Deploy/rathole/client.toml <<'EOF'
[client]
remote_addr = "<VPS_PUBLIC_IP>:2333"

[client.transport]
type = "noise"

[client.transport.noise]
remote_public_key = "<SERVER_PUBLIC_KEY>"    # from `rathole --genkey`; without it: "Missing noise config"

[client.services.rss]
token = "<TUNNEL_TOKEN>"             # must match the VPS server exactly
local_addr = "127.0.0.1:3002"        # the RSS service
EOF
chmod 600 ~/Deploy/rathole/client.toml
# then edit the file to fill in <VPS_PUBLIC_IP> and <TUNNEL_TOKEN>
```

### Quick manual test (before installing the service)

With the RSS service already running on `:3002`, run the client in the foreground:

```bash
rathole ~/Deploy/rathole/client.toml
```

You should see a "control channel established" / "service rss started" log line. From the VPS,
confirm the tunnel surfaced locally:

```bash
# on the VPS:
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5202/api/auth-check    # expect 200
```

Stop the foreground client with `Ctrl-C` once verified.

### launchd service (Mac)

```bash
RATHOLE_BIN="$(command -v rathole)"     # resolves the real path → avoids the exit-78 trap
cat > ~/Library/LaunchAgents/com.rss-reader.rathole.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.rss-reader.rathole</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RATHOLE_BIN</string>
    <string>$HOME/Deploy/rathole/client.toml</string>
  </array>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>$HOME/Deploy/rathole/rathole.log</string>
  <key>StandardErrorPath</key> <string>$HOME/Deploy/rathole/rathole.log</string>
</dict>
</plist>
EOF

launchctl bootout gui/$(id -u)/com.rss-reader.rathole 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rss-reader.rathole.plist

# verify: second column must be a PID with exit code 0 — NOT 78 (78 = bad binary path)
launchctl list | grep rathole
tail -f ~/Deploy/rathole/rathole.log     # expect "Control channel established"
# force restart later with:
#   launchctl kickstart -k "gui/$(id -u)/com.rss-reader.rathole"
```

---

## Part 3 — Install Caddy on the VPS (TLS)

Because the public port is `8443` (no inbound 80/443), the cert **must** come from the
**DNS-01 challenge** — it's the only ACME challenge that doesn't probe ports 80/443. `rss.royl.uk`
is on Cloudflare, so Caddy proves ownership through the Cloudflare API. This needs a Caddy build
with the Cloudflare DNS module.

### DNS record

In the Cloudflare dashboard for `royl.uk`, set `rss` to an **A record → `<VPS_PUBLIC_IP>`**, in
**DNS-only (grey cloud)** mode. Grey-cloud is required here: Cloudflare's proxy only forwards
standard ports, so an orange-cloud record would never reach `:8443`. With DNS-only, the name
resolves straight to the VPS IP and the browser connects to `:8443` directly.

### Install Caddy with the Cloudflare DNS module

Caddy needs the `caddy-dns/cloudflare` module compiled in (the stock release doesn't have it).
**From mainland China this binary is the hard part:** `caddyserver.com`'s on-demand build API,
`goproxy.cn`, and `caddy add-package` are all unreachable/blocked from both the VPS and (in this
setup) the Mac. The reliable path is to **cross-compile it on the Mac with `xcaddy` and `scp` it
to the VPS** — `proxy.golang.org` is reachable, so the Go build works.

On the **Mac** (needs Go ≥ 1.22 — `brew install go` gives current; the build is GFW-tolerant
because it uses the default `proxy.golang.org`):

```bash
export PATH="/opt/homebrew/bin:$HOME/go/bin:$PATH"
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
# cross-compile a Linux x86_64 Caddy with the Cloudflare DNS module
GOOS=linux GOARCH=amd64 xcaddy build --with github.com/caddy-dns/cloudflare \
  --output ~/Deploy/caddy/caddy-linux-amd64
gzip -kf ~/Deploy/caddy/caddy-linux-amd64                       # 46M → ~16M for a faster upload
scp ~/Deploy/caddy/caddy-linux-amd64.gz root@<VPS_PUBLIC_IP>:/tmp/caddy.gz
```

On the **VPS** (root) — install and confirm the module is actually baked in:

```bash
gunzip -f /tmp/caddy.gz
install -m 0755 /tmp/caddy /usr/local/bin/caddy
mkdir -p /etc/caddy /var/lib/caddy
caddy version
caddy list-modules | grep dns.providers.cloudflare    # MUST print the module, else the build lacks it
```

> If GitHub/`proxy.golang.org` are also unreachable from your Mac, fall back to the
> **nginx + certbot (`python3-certbot-dns-cloudflare`)** stack — all installable from Aliyun's
> apt mirror, cert via the same Cloudflare DNS-01 challenge. nginx must set `X-Forwarded-For`
> and `X-Forwarded-Proto` (see the security note in the architecture section).

### Cloudflare API token

Create a token at Cloudflare → *My Profile → API Tokens → Create Token → Edit zone DNS*,
scoped to zone `royl.uk`. This is `<CF_API_TOKEN>`.

### Caddyfile

```bash
tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
rss.royl.uk:8443 {
	reverse_proxy 127.0.0.1:5202
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	encode zstd gzip
}
EOF
```

### systemd unit for Caddy (with the API token in the environment)

Keep the API token out of the world-readable unit by putting it in a `600` env file:

```bash
echo 'CF_API_TOKEN=<CF_API_TOKEN>' > /etc/caddy/cf.env
chmod 600 /etc/caddy/cf.env
nano /etc/caddy/cf.env            # paste the real token
```

```bash
tee /etc/systemd/system/caddy.service >/dev/null <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
# Runs as root — no User=/Group=. 8443 is non-privileged, so no CAP_NET_BIND_SERVICE needed.
Environment=HOME=/root
Environment=XDG_DATA_HOME=/var/lib/caddy
EnvironmentFile=/etc/caddy/cf.env
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now caddy
journalctl -u caddy -f      # watch it obtain the cert (look for "certificate obtained")
```

The `--environ` flag makes Caddy log its env on start; confirm `CF_API_TOKEN` is present there
if the DNS challenge fails. `XDG_DATA_HOME=/var/lib/caddy` pins where the cert is stored so it
survives even if `$HOME` is unset under systemd.

> There is no port-80/443 fallback in this setup — that's the whole reason for using `:8443`.
> The DNS-01 challenge above is therefore mandatory, not optional. If you ever *do* complete an
> ICP filing and want a clean `https://rss.royl.uk` (no port), switch the Caddyfile site
> address to `rss.royl.uk`, open 443 (and 80 for redirects) in the security group, and you can
> then drop the `tls { … }` block to let Caddy use the default challenge.

---

## Part 4 — End-to-end verification

```bash
# 1. Tunnel up?  (on the Mac)
tail -n 20 ~/Deploy/rathole/rathole.log          # "control channel established"

# 2. Local surface on the VPS reachable?
ssh <VPS> 'curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5202/api/auth-check'   # 200

# 3. Public HTTPS works and serves the app?
curl -sS -o /dev/null -w "%{http_code}\n" https://rss.royl.uk:8443/api/auth-check            # 200
curl -sSI https://rss.royl.uk:8443/ | head -n1                  # cert/TLS OK (HTTP/2 200)

# 4. MCP must NOT be reachable from the public side (security check)
curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://rss.royl.uk:8443/mcp                # expect 404

# 5. Open https://rss.royl.uk:8443 in a browser, log in, confirm the Secure cookie is set.
```

If step 4 returns anything other than `404`, **stop** — Caddy is not forwarding
`X-Forwarded-For` (or port 5202 is exposed). Fix before going live; see the warning in the
architecture section.

---

## Part 5 — Cut over from Cloudflare Tunnel

Only after Part 4 fully passes:

1. The `rss.royl.uk` A record now points at the VPS (done in Part 3). Confirm propagation:
   `dig +short rss.royl.uk` → `<VPS_PUBLIC_IP>`.
2. Stop and disable `cloudflared` on the Mac so the old tunnel no longer competes:
   ```bash
   # if cloudflared runs under launchd:
   launchctl list | grep -i cloudflared
   launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist 2>/dev/null || true
   # or, if started via `brew services`:
   brew services stop cloudflared
   ```
3. (Optional) Delete the old Cloudflare Tunnel route/tunnel in the Cloudflare Zero Trust
   dashboard once you're confident in the new path.
4. Update `CLAUDE.md` / `server/.env.example` comments that mention "Cloudflare Tunnel" to say
   "rathole → Aliyun VPS (Caddy TLS)". Keep `trust proxy = 'loopback'` and the `Secure` cookie
   logic as-is — they remain correct (see "Why no app code change is needed").

---

## Operations cheat-sheet

| Action                          | Command |
|---------------------------------|---------|
| Restart tunnel (Mac)            | `launchctl kickstart -k "gui/$(id -u)/com.rss-reader.rathole"` |
| Tunnel logs (Mac)               | `tail -f ~/Deploy/rathole/rathole.log` |
| Restart rathole server (VPS)    | `systemctl restart rathole-server` |
| rathole server logs (VPS)       | `journalctl -u rathole-server -f` |
| Reload Caddy after edit (VPS)   | `systemctl reload caddy` |
| Caddy logs / cert renewal (VPS) | `journalctl -u caddy -f` |
| Rotate the tunnel token         | edit token in both `server.toml` and `client.toml`, restart both services |

## Troubleshooting

- **Server crash-loops with `Failed to read the config … Permission denied (os error 13)`** →
  the service user can't read `/etc/rathole/server.toml`. This happens if the unit has
  `DynamicUser=yes` (a transient user) against a root-owned `600` config. Fix: remove
  `DynamicUser=yes` so the unit runs as root (which owns the file), then
  `systemctl daemon-reload && systemctl restart rathole-server`. Check with
  `systemctl status rathole-server` — the restart counter should stop climbing.
- **`panicked … Missing noise config`** → the `[*.transport.noise]` table is absent. The
  `noise` transport's default `Noise_NK` pattern requires `local_private_key` on the server and
  `remote_public_key` on the client (both from `rathole --genkey`). Add them and restart.
- **Mac client logs "authentication failed"** → the `token` differs between `server.toml` and
  `client.toml`, the `[*.transport] type` differs (both must be `noise`), or the client's
  `remote_public_key` doesn't match the server's keypair.
- **`curl https://rss.royl.uk:8443` hangs / connection refused** → security group not allowing
  `8443`, the record is orange-clouded (must be grey/DNS-only), or Caddy isn't running. Check
  `systemctl status caddy` and `dig +short rss.royl.uk`.
- **Caddy can't get a cert** → `<CF_API_TOKEN>` lacks *Zone:DNS:Edit* on `royl.uk`, or the Caddy
  binary lacks the `cloudflare` DNS module (`caddy list-modules | grep dns.providers`). Watch
  `journalctl -u caddy`. Remember: with 80/443 closed, **only** DNS-01 can work.
- **502 from Caddy** → the tunnel is down (Mac client not connected) so nothing is listening on
  `127.0.0.1:5202`. Check the Mac client and `rathole-server`.
- **Login works but you get logged out / cookie missing** → `X-Forwarded-Proto` isn't reaching
  Express; confirm Caddy's `reverse_proxy` (it sets it by default) and that `trust proxy` is
  still `'loopback'`.
- **MCP reachable publicly (step 4 ≠ 404)** → `X-Forwarded-For` not propagating or port 5202
  exposed; see the architecture warning. This is a security issue — fix before serving traffic.
