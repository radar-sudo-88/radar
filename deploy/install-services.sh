#!/usr/bin/env bash
# Installs two systemd services so the radar comes up on its own at boot:
#
#   radar.service         the Node server (cors-proxy/server.js: serves the page + aircraft API)
#   radar-tunnel.service  the Cloudflare tunnel named "radar", started after the server
#
# Run it as your normal user (it calls sudo itself where needed):
#
#   ./deploy/install-services.sh              tunnel run by name, using ~/.cloudflared/config.yml
#   TUNNEL_TOKEN=eyJ... ./deploy/install-services.sh
#                                             dashboard-managed tunnel, run with its token
#   ./deploy/install-services.sh uninstall    stop, disable and remove both services
#
# Optional env vars: PORT (default 10004), TUNNEL_NAME (default radar),
#                    DRY_RUN=1 (print the generated unit files, change nothing)

set -euo pipefail

PORT="${PORT:-10004}"
TUNNEL_NAME="${TUNNEL_NAME:-radar}"
DRY_RUN="${DRY_RUN:-0}"

SERVER_UNIT=/etc/systemd/system/radar.service
TUNNEL_UNIT=/etc/systemd/system/radar-tunnel.service
TOKEN_FILE=/etc/radar-tunnel.env

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this script lives in <repo>/deploy/
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  [ "$DRY_RUN" = "1" ] && die "uninstall doesn't support DRY_RUN"
  sudo systemctl disable --now radar-tunnel.service radar.service 2>/dev/null || true
  sudo rm -f "$SERVER_UNIT" "$TUNNEL_UNIT" "$TOKEN_FILE"
  sudo systemctl daemon-reload
  say "Removed radar.service and radar-tunnel.service."
  exit 0
fi

# ---- preflight ----------------------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
CF_BIN="$(command -v cloudflared || true)"

[ -f "$REPO_DIR/cors-proxy/server.js" ] || die "can't find $REPO_DIR/cors-proxy/server.js - run this from inside the radar repo."
[ -n "$NODE_BIN" ] || die "node not found in PATH. Install Node 18+ first (sudo apt install nodejs)."
"$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "Node 18+ is required, found $("$NODE_BIN" -v)."
[ -n "$CF_BIN" ] || die "cloudflared not found in PATH. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  MODE=token
else
  MODE=named
  CF_CONFIG="$RUN_HOME/.cloudflared/config.yml"
  [ -f "$CF_CONFIG" ] || die "no $CF_CONFIG. Either create the tunnel locally first, or pass the token of a dashboard-managed tunnel: TUNNEL_TOKEN=... $0"
  grep -Eq "(localhost|127\.0\.0\.1):$PORT" "$CF_CONFIG" \
    || warn "$CF_CONFIG has no ingress rule pointing at localhost:$PORT - the tunnel will connect but won't reach the radar."
fi

if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared.service'; then
  warn "a stock cloudflared.service is already installed. It would run a second connector for the same tunnel; consider: sudo systemctl disable --now cloudflared"
fi

# ---- unit files ---------------------------------------------------------------------------
server_unit() {
  cat <<EOF
[Unit]
Description=Radar scope (Node server)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$REPO_DIR/cors-proxy
ExecStart=$NODE_BIN server.js
Environment=PORT=$PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

tunnel_unit() {
  cat <<EOF
[Unit]
Description=Cloudflare Tunnel "$TUNNEL_NAME"
After=network-online.target radar.service
Wants=network-online.target radar.service

[Service]
User=$RUN_USER
EOF
  if [ "$MODE" = token ]; then
    # cloudflared reads TUNNEL_TOKEN from the environment; kept out of the unit file itself
    printf 'EnvironmentFile=%s\nExecStart=%s --no-autoupdate tunnel run\n' "$TOKEN_FILE" "$CF_BIN"
  else
    printf 'ExecStart=%s --no-autoupdate tunnel run %s\n' "$CF_BIN" "$TUNNEL_NAME"
  fi
  cat <<EOF
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

if [ "$DRY_RUN" = "1" ]; then
  say "# (dry run) mode: $MODE, user: $RUN_USER, repo: $REPO_DIR"
  say; say "# ---- $SERVER_UNIT"; server_unit
  say; say "# ---- $TUNNEL_UNIT"; tunnel_unit
  [ "$MODE" = token ] && { say; say "# ---- $TOKEN_FILE (mode 600, root only)"; say "TUNNEL_TOKEN=<hidden>"; }
  exit 0
fi

# ---- install ------------------------------------------------------------------------------
server_unit | sudo tee "$SERVER_UNIT" >/dev/null
tunnel_unit | sudo tee "$TUNNEL_UNIT" >/dev/null
if [ "$MODE" = token ]; then
  ( umask 077; printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" | sudo tee "$TOKEN_FILE" >/dev/null )
  sudo chmod 600 "$TOKEN_FILE"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now radar.service radar-tunnel.service
sleep 3

say
say "radar.service:         $(systemctl is-active radar.service || true)"
say "radar-tunnel.service:  $(systemctl is-active radar-tunnel.service || true)"
if curl -fsS -o /dev/null "http://localhost:$PORT/"; then
  say "server answering on http://localhost:$PORT/"
else
  warn "nothing answering on localhost:$PORT yet - check: journalctl -u radar -e"
fi
say
say "Logs:    journalctl -u radar -f     journalctl -u radar-tunnel -f"
say "Restart: sudo systemctl restart radar radar-tunnel"
