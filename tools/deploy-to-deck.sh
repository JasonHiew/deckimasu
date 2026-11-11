#!/usr/bin/env bash
# Pushes this checkout's plugin code to a Steam Deck over SSH, without Desktop
# Mode. Only the plugin's own files are copied (dist, main.py, py_modules/providers,
# package.json); the Python dependencies already installed in the plugin's bin/
# folder are left alone. Decky Loader live-reloads a plugin when its main.py or
# dist/index.js changes, so the new version starts within a few seconds.
#
# Usage: tools/deploy-to-deck.sh [host] [--no-build] [--sudo] [--dry-run]
#   host       Deck hostname or IP (default: $DECK_HOST or steamdeck-jason.local)
#   --no-build skip "npm run build"
#   --sudo     extract with sudo (asks for the deck password) if the plugin
#              files on the Deck are not owned by the deck user
#   --dry-run  build the update archive and list it, without connecting
# The SSH user is $DECK_USER (default: deck).

set -euo pipefail

HOST="${DECK_HOST:-steamdeck-jason.local}"
BUILD=1
USE_SUDO=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --no-build) BUILD=0 ;;
        --sudo) USE_SUDO=1 ;;
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) HOST="$arg" ;;
    esac
done
# .local (mDNS) lookups on Windows fail intermittently, so resolve the name
# once up front, with retries, and connect by IP
if [[ "$HOST" == *.local ]] && command -v powershell >/dev/null 2>&1 && [ "$DRY_RUN" = 0 ]; then
    for attempt in 1 2 3 4 5; do
        IP="$(powershell -NoProfile -Command "(Resolve-DnsName '$HOST' -Type A -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress" | tr -d '\r')"
        [ -n "$IP" ] && break
        sleep 1
    done
    if [ -n "${IP:-}" ]; then
        echo "$HOST is $IP"
        HOST="$IP"
    else
        echo "Could not resolve $HOST; is the Deck awake and on the same network? Trying the name anyway." >&2
    fi
fi
TARGET="${DECK_USER:-deck}@$HOST"
SSH_OPTS=(-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

cd "$(dirname "$0")/.."

if [ "$BUILD" = 1 ]; then
    echo "Building frontend..."
    npm run build --silent
fi
[ -f dist/index.js ] || { echo "dist/index.js is missing; run npm run build first" >&2; exit 1; }

mkdir -p tmp
ARCHIVE="tmp/deck-update.tgz"
REMOTE_ARCHIVE="/tmp/deckimasu-update.tgz"
# main.py goes last so the reload it triggers already sees the new modules
tar -czf "$ARCHIVE" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.map' \
    py_modules/providers dist package.json main.py
echo "Update archive: $(du -h "$ARCHIVE" | cut -f1)"

if [ "$DRY_RUN" = 1 ]; then
    tar -tzf "$ARCHIVE"
    exit 0
fi

echo "Looking for Deckimasu on $TARGET..."
PLUGIN_DIR="$(ssh "${SSH_OPTS[@]}" "$TARGET" 'for f in ~/homebrew/plugins/*/plugin.json; do grep -q "\"Deckimasu\"" "$f" && dirname "$f"; done' | head -n 1)"
if [ -z "$PLUGIN_DIR" ]; then
    echo "Deckimasu is not installed on $HOST. Install it once from a release zip, then rerun this." >&2
    exit 1
fi
echo "Updating $PLUGIN_DIR"

scp -q "${SSH_OPTS[@]}" "$ARCHIVE" "$TARGET:$REMOTE_ARCHIVE"
# --overwrite rewrites files in place: the plugin folder itself is root-owned,
# so replacing (unlinking) top-level files like main.py would be refused
EXTRACT="tar -xzf $REMOTE_ARCHIVE --overwrite -m --no-same-owner -C '$PLUGIN_DIR'"
if [ "$USE_SUDO" = 1 ]; then
    ssh -t "${SSH_OPTS[@]}" "$TARGET" "sudo $EXTRACT; status=\$?; rm -f $REMOTE_ARCHIVE; exit \$status"
elif ! ssh "${SSH_OPTS[@]}" "$TARGET" "$EXTRACT; status=\$?; rm -f $REMOTE_ARCHIVE; exit \$status"; then
    echo "Copying failed. If it was a permission error, rerun with --sudo." >&2
    exit 1
fi

# Decky only hot-reloads plugins that carry the "debug" flag in plugin.json.
# That file is root-owned, so the first deploy adds the flag with sudo (asks
# for the deck password once) and restarts Decky so the flag takes effect.
if ssh "${SSH_OPTS[@]}" "$TARGET" "grep -q '\"debug\"' '$PLUGIN_DIR/plugin.json'"; then
    echo "Done. Decky reloads the plugin by itself within a few seconds."
else
    echo "Enabling hot reload for this plugin (one time). Enter the deck password when asked."
    ssh -t "${SSH_OPTS[@]}" "$TARGET" "sudo sed -i 's/\"flags\": *\[\]/\"flags\": [\"debug\"]/' '$PLUGIN_DIR/plugin.json' && grep -q debug '$PLUGIN_DIR/plugin.json' && sudo systemctl restart plugin_loader"
    echo "Done. Decky restarted with the new version; later deploys reload without a password."
fi
