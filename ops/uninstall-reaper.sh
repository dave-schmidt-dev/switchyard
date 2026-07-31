#!/bin/sh
# Uninstall the Switchyard standalone reaper LaunchAgent. Idempotent.
set -eu

LABEL="com.zerodelta.switchyard.reaper"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
REAPER_SH="$HOME/Library/Application Support/switchyard/switchyard-reaper.sh"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$TARGET" "$REAPER_SH"
echo "uninstalled $LABEL (removed $TARGET and $REAPER_SH)"
