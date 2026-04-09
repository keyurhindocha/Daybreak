#!/bin/bash
set -e

PLIST_NAME="com.inspiration.daily"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

# Find npx
NPX_PATH=$(which npx 2>/dev/null || echo "")
if [ -z "$NPX_PATH" ]; then
    echo "Error: npx not found. Please install Node.js first."
    exit 1
fi

if [ "$1" = "uninstall" ]; then
    echo "Uninstalling ${PLIST_NAME}..."
    launchctl bootout gui/$(id -u) "$PLIST_DEST" 2>/dev/null || true
    rm -f "$PLIST_DEST"
    echo "Uninstalled."
    exit 0
fi

SCHEDULE_HOUR="${SCHEDULE_HOUR:-7}"
SCHEDULE_MINUTE="${SCHEDULE_MINUTE:-0}"

echo "Installing ${PLIST_NAME}..."

# Ensure LaunchAgents directory exists
mkdir -p "$HOME/Library/LaunchAgents"

# Generate the plist dynamically with the current user's paths
cat > "$PLIST_DEST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NPX_PATH}</string>
        <string>tsx</string>
        <string>${PROJECT_DIR}/src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${SCHEDULE_HOUR}</integer>
        <key>Minute</key>
        <integer>${SCHEDULE_MINUTE}</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/inspiration.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/inspiration.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NPX_PATH"):/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
EOF

# Unload if already loaded
launchctl bootout gui/$(id -u) "$PLIST_DEST" 2>/dev/null || true

# Load the agent
launchctl bootstrap gui/$(id -u) "$PLIST_DEST"

echo "Installed and loaded ${PLIST_NAME}"
printf "The wallpaper will update daily at %02d:%02d.\n" "$SCHEDULE_HOUR" "$SCHEDULE_MINUTE"
echo "To uninstall: $0 uninstall"
