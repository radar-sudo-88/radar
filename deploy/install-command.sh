#!/usr/bin/env bash
# Puts deploy/simulate.js on your PATH as a command, so you can run it from anywhere:
#
#   ./deploy/install-command.sh                 installs as "radar-sim"
#   ./deploy/install-command.sh plane           installs as "plane" (any name you like)
#   ./deploy/install-command.sh uninstall [name]
#
# Then e.g.:  radar-sim emergency --postcode "NG1 1AA"
#
# It's a symlink to the script in this repo, so `git pull` updates the command too.
# Optional env var: BIN_DIR (default /usr/local/bin; sudo is used only if it isn't writable).

set -euo pipefail

BIN_DIR="${BIN_DIR:-/usr/local/bin}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/deploy/simulate.js"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

as_needed() { if [ -w "$BIN_DIR" ]; then "$@"; else sudo "$@"; fi; }

if [ "${1:-}" = uninstall ]; then
  NAME="${2:-radar-sim}"
  LINK="$BIN_DIR/$NAME"
  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$SRC" ]; then
    as_needed rm "$LINK"
    echo "Removed $LINK"
  else
    die "$LINK isn't a link to $SRC - not touching it"
  fi
  exit 0
fi

NAME="${1:-radar-sim}"
LINK="$BIN_DIR/$NAME"

[ -f "$SRC" ] || die "can't find $SRC"
command -v node >/dev/null 2>&1 || die "node isn't installed"
case "$NAME" in */*|'') die "name must be a plain command name, got '$NAME'" ;; esac

# Don't clobber a real command that happens to have the same name.
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$SRC" ]; then
    :  # already ours - just refresh below
  else
    die "$LINK already exists and isn't this script - pick another name: ./deploy/install-command.sh <name>"
  fi
fi
if existing="$(command -v "$NAME" 2>/dev/null)" && [ "$existing" != "$LINK" ]; then
  die "'$NAME' is already a command ($existing) - pick another name: ./deploy/install-command.sh <name>"
fi

chmod +x "$SRC"
as_needed mkdir -p "$BIN_DIR"
as_needed ln -sf "$SRC" "$LINK"

echo "Installed: $LINK -> $SRC"
echo "Try:  $NAME emergency --postcode \"NG1 1AA\""
echo "      $NAME list   |   $NAME clear   |   $NAME --help"
