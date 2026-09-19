#!/usr/bin/env bash
# Read-only health check for the radar Pi: clock, services, local server, tunnel, DNS, the public
# URL as seen FROM the Pi, and the kiosk browser. Changes nothing. Run it on the Pi:
#
#   bash deploy/diagnose.sh
#
# Optional env vars: URL (default https://aero-sentry.co.uk), PORT (default 10004)

set -u

PORT="${PORT:-10004}"
URL="${URL:-https://aero-sentry.co.uk}"
HOST="${URL#*://}"; HOST="${HOST%%/*}"
FAILS=0

sect() { printf '\n== %s\n' "$*"; }
ok()   { printf '  [ ok ]  %s\n' "$*"; }
bad()  { printf '  [FAIL]  %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '  [info]  %s\n' "$*"; }
diag() { printf '  [ >> ]  %s\n' "$*"; }   # a conclusion, not another failed check

printf 'radar diagnose - %s - host %s\n' "$(date '+%F %T %Z')" "$(hostname)"

sect "Clock (a wrong date makes every HTTPS site fail)"
sync="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
case "$sync" in
  yes) ok "clock is NTP-synchronised" ;;
  no)  bad "clock is NOT synchronised yet - HTTPS fails until it is" ;;
  *)   info "couldn't read NTP status" ;;
esac

sect "Services"
for s in radar radar-tunnel; do
  st="$(systemctl is-active "$s" 2>/dev/null || true)"
  if [ "$st" = active ]; then ok "$s.service is active"; else bad "$s.service is '${st:-unknown}'  (see: journalctl -u $s -e)"; fi
done

sect "Local server (http://localhost:$PORT)"
code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null || true)"
if [ "$code" = 200 ]; then ok "answers 200"; else bad "expected 200, got '${code:-no response}'"; fi

sect "Cloudflare tunnel"
if logs="$(journalctl -u radar-tunnel -b --no-pager 2>/dev/null)" && [ -n "$logs" ]; then
  n="$(printf '%s\n' "$logs" | grep -c 'Registered tunnel connection')"
  if [ "$n" -gt 0 ]; then ok "$n connection(s) registered with Cloudflare this boot"; else bad "no 'Registered tunnel connection' in this boot's log"; fi
  printf '%s\n' "$logs" | grep -E ' ERR ' | tail -3 | cut -c1-220 | while IFS= read -r line; do info "recent error: $line"; done
else
  info "can't read the tunnel log as this user (try: sudo journalctl -u radar-tunnel -b)"
fi

sect "DNS and the public URL, as seen from the Pi"
info "resolver(s) the Pi uses: $(grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | tr '\n' ' ')"
ip="$(getent ahostsv4 "$HOST" 2>/dev/null | awk 'NR==1{print $1}')"
if [ -n "$ip" ]; then ok "$HOST resolves to $ip via the Pi's normal DNS"; else bad "the Pi's normal DNS cannot resolve $HOST"; fi

pcode="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL/" 2>/dev/null)"; crc=$?
if [ "$pcode" = 200 ]; then
  ok "$URL answered 200 from the Pi"
else
  case "$crc" in
    6)  why="couldn't resolve the name (DNS)" ;;
    7)  why="couldn't connect" ;;
    28) why="timed out" ;;
    35|60) why="TLS/certificate problem (usually a wrong clock)" ;;
    *)  why="curl exit $crc" ;;
  esac
  bad "$URL failed from the Pi: $why (http '${pcode:-000}')"
  # Retry with name lookup done by Cloudflare's DNS-over-HTTPS instead of the Pi's resolver, to
  # tell "the Pi's DNS is stale/wrong" apart from "the site itself is down".
  dcode="$(curl -s -o /dev/null -m 10 --doh-url https://1.1.1.1/dns-query -w '%{http_code}' "$URL/" 2>/dev/null || true)"
  if [ "$dcode" = 200 ]; then
    diag "it WORKS when the Pi's own DNS is bypassed => the Pi's DNS (router cache) is the problem"
  else
    diag "also fails with the Pi's DNS bypassed => not just DNS (tunnel, Cloudflare route or clock)"
  fi
fi

sect "Kiosk browser"
chrom="$(command -v chromium || command -v chromium-browser || true)"
if [ -n "$chrom" ]; then ok "browser installed: $chrom"; else bad "chromium not installed"; fi
entry="$HOME/.config/autostart/radar-kiosk.desktop"
if [ -f "$entry" ]; then
  ok "kiosk entry present"
  info "$(grep '^Exec=' "$entry" | cut -c1-170)"
else
  bad "no kiosk entry at $entry  (run: bash deploy/install-services.sh kiosk)"
fi
for f in "$HOME"/.config/autostart/*.desktop "$HOME/.config/labwc/autostart" "$HOME/.config/wayfire.ini" "$HOME"/.config/lxsession/*/autostart; do
  [ -f "$f" ] && [ "$f" != "$entry" ] && grep -qi chromium "$f" && info "another Chromium launcher: $f"
done
running="$(pgrep -af chromium 2>/dev/null | grep -m1 -- '--kiosk' | cut -c1-200)"
if [ -n "$running" ]; then info "running now: $running"; else info "no kiosk Chromium running right now"; fi

printf '\n'
if [ "$FAILS" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$FAILS check(s) failed - paste this whole report back."
fi
