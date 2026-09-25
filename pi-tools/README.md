# pi-tools

A small standalone file browser + command runner for the Pi itself, reachable at
`http://192.168.0.187:6969` (or whatever the Pi's LAN IP is) from any device on your network.
Not part of the radar app - separate process, separate port.

- **Editor tab**: browse folders, click a file to view/edit it, Ctrl/Cmd+S or the Save button to
  write it back.
- **Terminal tab**: type a command, pick the working directory (defaults to whatever folder
  you're browsing), hit Run. Shows stdout, stderr, and the exit code.

## Security - read this first

With no token set, **anything on your LAN can read/write files and run arbitrary commands as
whatever user runs this** - equivalent to SSH access with no password. That's a reasonable
trade-off on a home network you trust, but:

- **Never** expose this through the Cloudflare tunnel, port-forward it, or put it on the same
  hostname/port as anything internet-facing.
- If your LAN has anything you don't fully trust (guest wifi, IoT devices, smart TVs), set
  `PI_TOOLS_TOKEN` (see below) so a token is required.

All file access is confined to `ROOT_DIR` (default: your home directory) - paths that would
escape it are rejected server-side.

## Run it directly

```bash
cd pi-tools
node server.js
# or, restricted to the repo folder only, with a token required:
ROOT_DIR=/home/radar/radar PI_TOOLS_TOKEN=changeme PORT=6969 node server.js
```

Then open `http://192.168.0.187:6969` (swap in the Pi's actual IP) from your phone or PC. If you
set a token, the page will prompt for it once and remember it in that browser.

## Run it as a service (auto-start on boot)

```bash
sudo tee /etc/systemd/system/pi-tools.service > /dev/null << 'EOF'
[Unit]
Description=pi-tools file browser + command runner
After=network.target

[Service]
Type=simple
User=radar
WorkingDirectory=/home/radar/radar/pi-tools
Environment=PORT=6969
Environment=ROOT_DIR=/home/radar
# Uncomment and set a real value to require a token:
# Environment=PI_TOOLS_TOKEN=changeme
ExecStart=/usr/bin/node /home/radar/radar/pi-tools/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pi-tools
```

Check it's up:

```bash
sudo systemctl status pi-tools
journalctl -u pi-tools -n 20 --no-pager
```

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `6969` | Port to listen on |
| `ROOT_DIR` | home directory | Everything is confined under here |
| `PI_TOOLS_TOKEN` | (none) | If set, `X-Auth-Token` header required on every API call |
| `CMD_TIMEOUT_MS` | `60000` | Kill a command if it runs longer than this |
