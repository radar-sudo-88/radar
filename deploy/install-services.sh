#!/usr/bin/env bash
# Sets up the radar to come up on its own on the Pi:
#
#   radar.service         the Node server (cors-proxy/server.js: serves the page + aircraft API)
#   radar-tunnel.service  the Cloudflare tunnel named "radar", started after the server
#   kiosk entry           opens the site full-screen in Chromium when the Pi's desktop logs in
#                         (~/.config/autostart/radar-kiosk.desktop -> deploy/kiosk.sh)
#
# Run it as your normal user (it calls sudo itself where needed):
#
#   ./deploy/install-services.sh              services + kiosk; tunnel run by name, using
#                                             ~/.cloudflared/config.yml
#   TUNNEL_TOKEN=eyJ... ./deploy/install-services.sh
#                                             same, but a dashboard-managed tunnel run by its token
#   ./deploy/install-services.sh kiosk        ONLY (re)do the kiosk entry - touches no services,
#                                             needs no sudo and no token
#   ./deploy/install-services.sh uninstall    remove the services and the kiosk entry
#
# Aircraft-details panel (tap an aircraft -> Gemini profile): put the key in /etc/radar.env, which the
# server unit reads if it exists (nothing here creates or touches it):
#   GEMINI_API_KEY=...                (required for the panel's AI profile; get one at aistudio.google.com/apikey)
#   GEMINI_MODEL=gemini-3.1-flash-lite   GEMINI_DAILY_LIMIT=500     (both optional)
#
# Optional env vars:
#   PORT (default 10004)          TUNNEL_NAME (default radar)
#   KIOSK=0                       skip the kiosk entry during a full install
#   KIOSK_URL                     what the kiosk opens (default https://aero-sentry.co.uk;
#                                 http://localhost:10004 also works and doesn't need the internet)
#   DRY_RUN=1                     print what would be written, change nothing

set -euo pipefail

PORT="${PORT:-10004}"
TUNNEL_NAME="${TUNNEL_NAME:-radar}"
DRY_RUN="${DRY_RUN:-0}"
KIOSK="${KIOSK:-1}"
KIOSK_URL="${KIOSK_URL:-https://aero-sentry.co.uk}"

SERVER_UNIT=/etc/systemd/system/radar.service
TUNNEL_UNIT=/etc/systemd/system/radar-tunnel.service
TOKEN_FILE=/etc/radar-tunnel.env

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this script lives in <repo>/deploy/
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
KIOSK_SCRIPT="$REPO_DIR/deploy/kiosk.sh"
KIOSK_DIR="$RUN_HOME/.config/autostart"
KIOSK_ENTRY="$KIOSK_DIR/radar-kiosk.desktop"

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Files in the user's home must belong to the user even if someone ran this whole script with sudo.
run_as_user() {
  if [ "$(id -u)" -eq 0 ] && [ "$RUN_USER" != root ]; then sudo -u "$RUN_USER" "$@"; else "$@"; fi
}

# =============================================================================================
# Services (Node server + Cloudflare tunnel)
# =============================================================================================
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
# Optional secrets/settings file (e.g. GEMINI_API_KEY for the aircraft-details panel). The leading
# "-" means a missing file is fine. Create it with: sudo install -m 600 /dev/null /etc/radar.env
EnvironmentFile=-/etc/radar.env
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

install_services() {
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
    local cf_config="$RUN_HOME/.cloudflared/config.yml"
    [ -f "$cf_config" ] || die "no $cf_config. Either create the tunnel locally first, or pass the token of a dashboard-managed tunnel: TUNNEL_TOKEN=... $0"
    grep -Eq "(localhost|127\.0\.0\.1):$PORT" "$cf_config" \
      || warn "$cf_config has no ingress rule pointing at localhost:$PORT - the tunnel will connect but won't reach the radar."
  fi

  if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared.service'; then
    warn "a stock cloudflared.service is already installed. It would run a second connector for the same tunnel; consider: sudo systemctl disable --now cloudflared"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say "# (dry run) mode: $MODE, user: $RUN_USER, repo: $REPO_DIR"
    say; say "# ---- $SERVER_UNIT"; server_unit
    say; say "# ---- $TUNNEL_UNIT"; tunnel_unit
    [ "$MODE" = token ] && { say; say "# ---- $TOKEN_FILE (mode 600, root only)"; say "TUNNEL_TOKEN=<hidden>"; }
    return 0
  fi

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
}

# =============================================================================================
# Kiosk: open the site full-screen in Chromium at desktop login
# =============================================================================================
kiosk_entry() {
  # No shell is involved in a .desktop Exec line, and % is special in it, hence %%.
  cat <<EOF
[Desktop Entry]
Type=Application
Name=Radar kiosk
Comment=Open the radar full-screen in Chromium kiosk mode
Exec=env "KIOSK_URL=${KIOSK_URL//%/%%}" PORT=$PORT bash "$KIOSK_SCRIPT"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
}

# $1 = strict: a missing browser is an error; anything else: warn and skip (so a full install
# on a Pi without a desktop browser still gets its services).
install_kiosk() {
  local strict="${1:-soft}"

  if [ -z "$(command -v chromium || command -v chromium-browser || true)" ]; then
    if [ "$strict" = strict ]; then die "chromium not found. Install it: sudo apt install chromium"; fi
    warn "chromium not found - skipping the kiosk entry. After installing it (sudo apt install chromium), run: $0 kiosk"
    return 0
  fi
  [ -f "$KIOSK_SCRIPT" ] || die "missing $KIOSK_SCRIPT"

  # An older kiosk setup (e.g. one that opens the previous GitHub Pages address) probably launches
  # Chromium from one of these places. Two launchers = two windows, so point them out - but don't
  # edit the user's own config files.
  local f found=""
  for f in "$KIOSK_DIR"/*.desktop "$RUN_HOME/.config/labwc/autostart" "$RUN_HOME/.config/wayfire.ini" \
           "$RUN_HOME"/.config/lxsession/*/autostart; do
    [ -f "$f" ] && [ "$f" != "$KIOSK_ENTRY" ] && grep -qi chromium "$f" && found="$found
    $f"
  done
  if [ -n "$found" ]; then
    warn "an existing Chromium launcher was found in:$found
  Remove or comment out its chromium line, otherwise you'll get two windows at login."
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say; say "# (dry run) ---- $KIOSK_ENTRY"; kiosk_entry
    return 0
  fi

  run_as_user mkdir -p "$KIOSK_DIR"
  kiosk_entry | run_as_user tee "$KIOSK_ENTRY" >/dev/null

  say
  say "Kiosk entry written: $KIOSK_ENTRY"
  say "  opens $KIOSK_URL full-screen when the Pi's desktop logs in (change it by editing KIOSK_URL there,"
  say "  or re-run:  KIOSK_URL=... $0 kiosk)"
  say "  Needs desktop auto-login: sudo raspi-config -> System Options -> Boot / Auto Login -> Desktop Autologin"
  say "  Try it now from the Pi's own screen (not over SSH):  bash $KIOSK_SCRIPT"
}

# =============================================================================================
# main
# =============================================================================================
case "${1:-install}" in
  install)
    install_services
    if [ "$KIOSK" = "1" ]; then install_kiosk soft; fi
    ;;
  kiosk)
    install_kiosk strict
    ;;
  uninstall)
    [ "$DRY_RUN" = "1" ] && die "uninstall doesn't support DRY_RUN"
    sudo systemctl disable --now radar-tunnel.service radar.service 2>/dev/null || true
    sudo rm -f "$SERVER_UNIT" "$TUNNEL_UNIT" "$TOKEN_FILE"
    sudo systemctl daemon-reload
    run_as_user rm -f "$KIOSK_ENTRY"
    say "Removed radar.service, radar-tunnel.service and the kiosk entry."
    ;;
  *)
    die "unknown command '$1' (use: install | kiosk | uninstall)"
    ;;
esac
