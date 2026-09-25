#!/usr/bin/env bash
# Installs pi-tools as a systemd service so it starts on boot and restarts if it crashes.
#
# Run from anywhere on the Pi:
#   ./pi-tools/install-service.sh
#   PORT=7000 ROOT_DIR=/home/radar TOKEN=changeme ./pi-tools/install-service.sh
#   ./pi-tools/install-service.sh uninstall
#
# Env vars (all optional):
#   PORT      default 6969
#   ROOT_DIR  default the home directory of the user running the service (see SERVICE_USER)
#   TOKEN     if set, becomes PI_TOOLS_TOKEN - required as X-Auth-Token on every request.
#             Leaving it unset means NO auth - see pi-tools/README.md before doing that on a
#             network you don't fully trust.
#   SERVICE_USER  default the user invoking this script (via sudo -u), falls back to $USER

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$USER}}"
PORT="${PORT:-6969}"
ROOT_DIR="${ROOT_DIR:-$(getent passwd "$SERVICE_USER" | cut -d: -f6)}"
NODE_BIN="$(command -v node || true)"
UNIT=/etc/systemd/system/pi-tools.service

if [ "${1:-}" = uninstall ]; then
  sudo systemctl disable --now pi-tools 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "Removed pi-tools.service"
  exit 0
fi

[ -n "$NODE_BIN" ] || { echo "ERROR: node not found on PATH" >&2; exit 1; }

TOKEN_LINE=""
if [ -n "${TOKEN:-}" ]; then
  TOKEN_LINE="Environment=PI_TOOLS_TOKEN=${TOKEN}"
fi

echo "Installing pi-tools.service:"
echo "  user:    $SERVICE_USER"
echo "  root:    $ROOT_DIR"
echo "  port:    $PORT"
echo "  token:   $([ -n "${TOKEN:-}" ] && echo set || echo "NOT set - no auth, LAN only")"

sudo tee "$UNIT" > /dev/null << EOF
[Unit]
Description=pi-tools file browser + command runner
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}/pi-tools
Environment=PORT=${PORT}
Environment=ROOT_DIR=${ROOT_DIR}
${TOKEN_LINE}
ExecStart=${NODE_BIN} ${REPO_DIR}/pi-tools/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pi-tools

echo
echo "Done. Check status with:  sudo systemctl status pi-tools"
echo "Logs with:                journalctl -u pi-tools -n 30 --no-pager"
