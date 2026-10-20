#!/usr/bin/env bash
# Pushes this checkout's plugin code to a Steam Deck over SSH, without Desktop
# Mode. Only the plugin's own files are copied (dist, main.py, py_modules/providers,
# package.json); the Python dependencies already installed in the plugin's bin/
# folder are left alone. Decky Loader live-reloads a plugin when its main.py or
# dist/index.js changes, so the new version starts within a few seconds.
#
# Usage: tools/deploy-to-deck.sh [host] [--no-build] [--sudo] [--dry-run]
#   host       Deck hostname or IP (default: $DECK_HOST or steamdeck.local)
#   --no-build skip "npm run build"
#   --sudo     extract with sudo (asks for the deck password) if the plugin
#              files on the Deck are not owned by the deck user
#   --dry-run  build the update archive and list it, without connecting
# The SSH user is $DECK_USER (default: deck).

set -euo pipefail

HOST="${DECK_HOST:-steamdeck.local}"
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
TARGET="${DECK_USER:-deck}@$HOST"

cd "$(dirname "$0")/.."

if [ "$BUILD" = 1 ]; then
    echo "Building frontend..."
    npm run build --silent
fi
[ -f dist/index.js ] || { echo "dist/index.js is missing; run npm run build first" >&2; exit 1; }

mkdir -p tmp
ARCHIVE="tmp/deck-update.tgz"
REMOTE_ARCHIVE="/tmp/decky-translator-update.tgz"
# main.py goes last so the reload it triggers already sees the new modules
tar -czf "$ARCHIVE" --exclude='__pycache__' --exclude='*.pyc' --exclude='*.map' \
    py_modules/providers dist package.json main.py
echo "Update archive: $(du -h "$ARCHIVE" | cut -f1)"

if [ "$DRY_RUN" = 1 ]; then
    tar -tzf "$ARCHIVE"
    exit 0
fi

echo "Looking for Decky Translator on $TARGET..."
PLUGIN_DIR="$(ssh "$TARGET" 'for f in ~/homebrew/plugins/*/plugin.json; do grep -q "\"Decky Translator\"" "$f" && dirname "$f"; done' | head -n 1)"
if [ -z "$PLUGIN_DIR" ]; then
    echo "Decky Translator is not installed on $HOST. Install it once (Decky store or a release zip), then rerun this." >&2
    exit 1
fi
echo "Updating $PLUGIN_DIR"

scp -q "$ARCHIVE" "$TARGET:$REMOTE_ARCHIVE"
# --overwrite rewrites files in place: the plugin folder itself is root-owned,
# so replacing (unlinking) top-level files like main.py would be refused
EXTRACT="tar -xzf $REMOTE_ARCHIVE --overwrite -m --no-same-owner -C '$PLUGIN_DIR'"
if [ "$USE_SUDO" = 1 ]; then
    ssh -t "$TARGET" "sudo $EXTRACT; status=\$?; rm -f $REMOTE_ARCHIVE; exit \$status"
elif ! ssh "$TARGET" "$EXTRACT; status=\$?; rm -f $REMOTE_ARCHIVE; exit \$status"; then
    echo "Copying failed. If it was a permission error, rerun with --sudo." >&2
    exit 1
fi

echo "Done. Decky reloads the plugin by itself within a few seconds."
echo "If the old version is still running: ssh -t $TARGET sudo systemctl restart plugin_loader"
