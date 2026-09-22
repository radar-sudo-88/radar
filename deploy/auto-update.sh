#!/usr/bin/env bash
# Checks the radar repo's remote for new commits and, if there are any, pulls them and restarts
# radar.service so the change goes live - no manual "git pull" on the Pi needed.
#
# Meant to run on a timer (see install-services.sh's "autoupdate" command, which sets up
# radar-updater.timer plus a sudoers rule scoped to exactly the restart below, so this can run as
# your normal user without a sudo password prompt). Can also be run by hand:
#
#   bash deploy/auto-update.sh
#
# IMPORTANT: an update is applied with `git reset --hard`, which throws away any local changes in
# this checkout. Don't hand-edit files here on the Pi if you're running this on a timer - make
# changes on your own machine and push them; the Pi will pick them up on its next check.
#
# Env vars:
#   BRANCH             branch to track (default: main)
#   RESTART_SERVICES   space-separated systemd units to restart on an update (default: radar.service)
#   LOCK_FILE          flock file so two checks can't overlap (default: /tmp/radar-auto-update.lock)

set -euo pipefail

BRANCH="${BRANCH:-main}"
RESTART_SERVICES="${RESTART_SERVICES:-radar.service}"
LOCK_FILE="${LOCK_FILE:-/tmp/radar-auto-update.lock}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this script lives in <repo>/deploy/

# If a previous check is still running (a slow/hung network call), skip this one rather than pile up.
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "auto-update: a check is already running - skipping"; exit 0; }

cd "$REPO_DIR"

if ! git fetch --quiet origin "$BRANCH"; then
  echo "auto-update: git fetch failed (offline, or GitHub unreachable) - skipping this check" >&2
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

# Nothing to do most of the time - this runs every couple of minutes, so stay quiet when so.
[ "$LOCAL" = "$REMOTE" ] && exit 0

echo "auto-update: new commits on $BRANCH ($LOCAL -> $REMOTE) - updating"
git reset --hard --quiet "origin/$BRANCH"

# When this script is itself run as root (e.g. the systemd unit has no User= set), no sudo is
# needed at all. Otherwise use sudo - install_autoupdate() in install-services.sh sets up a
# sudoers rule scoped to exactly "systemctl restart radar.service", so this doesn't prompt.
RESTART_CMD=(systemctl restart)
[ "$(id -u)" -ne 0 ] && RESTART_CMD=(sudo "${RESTART_CMD[@]}")

for svc in $RESTART_SERVICES; do
  echo "auto-update: restarting $svc"
  "${RESTART_CMD[@]}" "$svc"
done

echo "auto-update: done, now at $(git rev-parse --short HEAD)"
