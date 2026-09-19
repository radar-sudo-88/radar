#!/usr/bin/env bash
# Opens the radar full-screen in Chromium kiosk mode. Meant to be started by the Pi's desktop at
# login (deploy/install-services.sh sets that up), but you can also run it by hand from the Pi's
# own desktop session:  bash deploy/kiosk.sh
#
# Env vars:
#   KIOSK_URL        what to open (default https://aero-sentry.co.uk). Use http://localhost:10004
#                    to skip the internet round trip and keep working if the tunnel is down.
#   PORT             the local server's port, used for the wait below (default 10004)
#   KIOSK_WAIT_SECS  how long to wait for things to come up before opening anyway (default 90)
#   KIOSK_AUTOSTART  1 (default) opens the page with ?autostart=1 so it starts by itself, with no
#                    click and no extension needed. Set to 0 to get the tap-to-start overlay.
#
# Deliberately does NOT pass --user-data-dir or --incognito, so Chromium uses your normal profile
# and any extensions you've installed on the Pi (e.g. an auto-click extension) still load.

set -u

URL="${KIOSK_URL:-https://aero-sentry.co.uk}"
PORT="${PORT:-10004}"
WAIT_SECS="${KIOSK_WAIT_SECS:-90}"
AUTOSTART="${KIOSK_AUTOSTART:-1}"

BROWSER="$(command -v chromium || command -v chromium-browser || true)"
[ -n "$BROWSER" ] || { echo "kiosk: chromium not found (sudo apt install chromium)" >&2; exit 1; }

# At boot the desktop can come up before the server, the network or the tunnel do. Opening the
# browser too early just shows an error page that never retries, so wait until things answer.
wait_for() {
  local target="$1" i
  for i in $(seq 1 "$WAIT_SECS"); do
    curl -fsS -o /dev/null --max-time 3 "$target" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

wait_for "http://localhost:$PORT/" || echo "kiosk: local server not answering after ${WAIT_SECS}s - opening anyway" >&2
case "$URL" in
  http://localhost*|http://127.0.0.1*) ;;   # already covered by the check above
  *) wait_for "$URL" || echo "kiosk: $URL not reachable after ${WAIT_SECS}s - opening anyway" >&2 ;;
esac

# What the browser actually opens (the waits above use the plain URL).
OPEN_URL="$URL"
if [ "$AUTOSTART" = 1 ]; then
  case "$URL" in
    *\?*) OPEN_URL="$URL&autostart=1" ;;
    *)    OPEN_URL="$URL?autostart=1" ;;
  esac
fi

# A wall board often loses power without a clean shutdown; Chromium then shows a "didn't shut
# down correctly - restore pages?" bubble on next start. Mark the last session as clean first.
PREFS="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' "$PREFS"
fi

exec "$BROWSER" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --no-first-run \
  --password-store=basic \
  --disable-features=Translate \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  "$OPEN_URL"
