#!/bin/sh
# Install (or reinstall) the provider-CLI cadence as a launchd LaunchAgent.
# Idempotent.
#
#   install-cli-cadence.sh [--mode check|stage|promote] [--notify /path/to/notifier] [--no-load]
#
# The rendered plist goes to $SWITCHYARD_LAUNCHD_DIR (default ~/.launchd, the
# owner's launchd directory); the entry script is copied to
# ~/Library/Application Support/switchyard/ like the reaper's. --notify names an
# executable that receives the title as $1 and the report on stdin; without it
# the job posts a macOS notification and always writes .logs/cli-cadence/.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$SCRIPT_DIR/../.." && pwd)

LABEL="com.zerodelta.switchyard.cli-cadence"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
SRC_SH="$SCRIPT_DIR/cli-cadence.sh"

INSTALL_DIR="$HOME/Library/Application Support/switchyard"
CADENCE_SH="$INSTALL_DIR/cli-cadence.sh"
LOG_DIR="$HOME/Library/Logs"
TARGET_DIR="${SWITCHYARD_LAUNCHD_DIR:-$HOME/.launchd}"
TARGET="$TARGET_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

MODE=promote
NOTIFY=""
LOAD=1
while [ $# -gt 0 ]; do
	case "$1" in
	--mode)
		MODE="$2"
		shift 2
		;;
	--notify)
		NOTIFY="$2"
		shift 2
		;;
	--no-load)
		LOAD=0
		shift
		;;
	*)
		echo "usage: install-cli-cadence.sh [--mode check|stage|promote] [--notify PATH] [--no-load]" >&2
		exit 2
		;;
	esac
done
case "$MODE" in check | stage | promote) ;; *)
	echo "error: --mode must be check, stage or promote" >&2
	exit 2
	;;
esac
if [ -n "$NOTIFY" ] && [ ! -x "$NOTIFY" ]; then
	echo "error: --notify must be an executable: $NOTIFY" >&2
	exit 2
fi

for f in "$TEMPLATE" "$SRC_SH"; do
	[ -f "$f" ] || {
		echo "error: missing $f" >&2
		exit 1
	}
done

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$TARGET_DIR"
sed -e "s|__SWITCHYARD_REPO__|$REPO|g" "$SRC_SH" >"$CADENCE_SH"
chmod +x "$CADENCE_SH"

sed \
	-e "s|__CADENCE_SH__|$CADENCE_SH|g" \
	-e "s|__MODE__|$MODE|g" \
	-e "s|__NOTIFY__|$NOTIFY|g" \
	-e "s|__CADENCE_OUT__|$LOG_DIR/switchyard-cli-cadence.launchd.out.log|g" \
	-e "s|__CADENCE_ERR__|$LOG_DIR/switchyard-cli-cadence.launchd.err.log|g" \
	"$TEMPLATE" >"$TARGET"
plutil -lint "$TARGET" >/dev/null

if [ "$LOAD" -eq 1 ]; then
	launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
	launchctl bootstrap "$DOMAIN" "$TARGET"
	launchctl enable "$DOMAIN/$LABEL"
fi

echo "installed $LABEL"
echo "  script:  $CADENCE_SH (repo $REPO)"
echo "  plist:   $TARGET"
echo "  runs:    daily 06:41, mode $MODE"
echo "  report:  $REPO/.logs/cli-cadence/latest.txt"
echo "  notify:  ${NOTIFY:-macOS notification}"
echo "  kick:    launchctl kickstart $DOMAIN/$LABEL"
