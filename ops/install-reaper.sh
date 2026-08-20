#!/bin/sh
# Install (or reinstall) the Switchyard standalone reaper as a launchd
# LaunchAgent. Idempotent.
#
# The reaper is COPIED out of the project (which lives under the TCC-protected
# ~/Documents) into ~/Library/Application Support/switchyard/, because a
# background launchd agent cannot read files under ~/Documents without a Full
# Disk Access grant. The reaper reads only managed VM names via prlctl, so it
# needs nothing from the project tree at runtime — the copy is fully
# self-sufficient.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

LABEL="com.zerodelta.switchyard.reaper"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
SRC_REAPER="$SCRIPT_DIR/switchyard-reaper.sh"

INSTALL_DIR="$HOME/Library/Application Support/switchyard"
REAPER_SH="$INSTALL_DIR/switchyard-reaper.sh"
LOG_DIR="$HOME/Library/Logs"
REAPER_OUT="$LOG_DIR/switchyard-reaper.launchd.out.log"
REAPER_ERR="$LOG_DIR/switchyard-reaper.launchd.err.log"

TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

for f in "$TEMPLATE" "$SRC_REAPER"; do
	[ -f "$f" ] || {
		echo "error: missing $f" >&2
		exit 1
	}
done

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$TARGET_DIR"

# Copy the reaper out of ~/Documents into the non-TCC location, executable.
cp "$SRC_REAPER" "$REAPER_SH"
chmod +x "$REAPER_SH"

# Render the plist with resolved absolute paths.
sed \
	-e "s|__REAPER_SH__|$REAPER_SH|g" \
	-e "s|__REAPER_OUT__|$REAPER_OUT|g" \
	-e "s|__REAPER_ERR__|$REAPER_ERR|g" \
	"$TEMPLATE" >"$TARGET"
plutil -lint "$TARGET" >/dev/null

# Idempotent (re)load.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$TARGET"
launchctl enable "$DOMAIN/$LABEL"

echo "installed $LABEL"
echo "  reaper:  $REAPER_SH"
echo "  plist:   $TARGET"
echo "  runs:    at load + every 3600s"
echo "  log:     $LOG_DIR/switchyard-reaper.log"
echo "  kick:    launchctl kickstart $DOMAIN/$LABEL"
