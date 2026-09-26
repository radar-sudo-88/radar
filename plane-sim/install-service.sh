#!/usr/bin/env bash
# Installs plane-sim as a systemd service so it's always up.
#
#   ./plane-sim/install-service.sh
#   PORT=1113 PROXY_URL=http://localhost:10004 ./plane-sim/install-service.sh
#   ./plane-sim/install-service.sh uninstall
#
# Requires cors-proxy's SIMULATE_KEY to already be set (see the comment above SIMULATE_KEY in
# cors-proxy/server.js) - the service will crash-loop with a clear log message if it isn't.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$USER}}"
PORT="${PORT:-1113}"
PROXY_URL="${PROXY_URL:-http://localhost:10004}"
NODE_BIN="$(command -v node || true)"
UNIT=/etc/systemd/system/plane-sim.service

if [ "${1:-}" = uninstall ]; then
  sudo systemctl disable --now plane-sim 2>/dev/null || true
  sudo rm -f "$UNIT"
  sudo systemctl daemon-reload
  echo "Removed plane-sim.service"
  exit 0
fi

[ -n "$NODE_BIN" ] || { echo "ERROR: node not found on PATH" >&2; exit 1; }

echo "Installing plane-sim.service:"
echo "  user:  $SERVICE_USER"
echo "  port:  $PORT"
echo "  proxy: $PROXY_URL"

sudo tee "$UNIT" > /dev/null << EOF
[Unit]
Description=plane-sim WASD-controlled fake aircraft
After=network.target radar.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}/plane-sim
Environment=PORT=${PORT}
Environment=PROXY_URL=${PROXY_URL}
ExecStart=${NODE_BIN} ${REPO_DIR}/plane-sim/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now plane-sim

echo
echo "Done. Check status with:  sudo systemctl status plane-sim"
echo "Logs with:                journalctl -u plane-sim -n 30 --no-pager"
