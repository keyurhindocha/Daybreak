#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CRON_MARKER="# inspiration-daily"

# Find node/npx
NPX_PATH=$(which npx 2>/dev/null || echo "")
if [ -z "$NPX_PATH" ]; then
    echo "Error: npx not found. Please install Node.js first."
    exit 1
fi

SCHEDULE_HOUR="${SCHEDULE_HOUR:-7}"
SCHEDULE_MINUTE="${SCHEDULE_MINUTE:-0}"

CRON_CMD="$SCHEDULE_MINUTE $SCHEDULE_HOUR * * * cd \"$PROJECT_DIR\" && $NPX_PATH tsx src/index.ts >> /tmp/inspiration.log 2>> /tmp/inspiration.err $CRON_MARKER"

if [ "$1" = "uninstall" ]; then
    echo "Uninstalling inspiration cron job..."
    crontab -l 2>/dev/null | grep -v "$CRON_MARKER" | crontab -
    echo "Uninstalled."
    exit 0
fi

echo "Installing inspiration cron job..."

# Remove existing entry if present, then add new one
(crontab -l 2>/dev/null | grep -v "$CRON_MARKER"; echo "$CRON_CMD") | crontab -

echo "Installed cron job."
printf "The wallpaper will update daily at %02d:%02d.\n" "$SCHEDULE_HOUR" "$SCHEDULE_MINUTE"
echo "To uninstall: $0 uninstall"
