#!/bin/sh
# Install (or reinstall) the Switchyard standalone sandbox canary as a launchd
# LaunchAgent. Idempotent and rollback-safe.
#
# Like the reaper, the canary is installed outside the TCC-protected
# ~/Documents tree, under ~/Library/Application Support/switchyard/, because a
# background launchd agent cannot read files under ~/Documents without a Full
# Disk Access grant. What is installed is an immutable `git archive` of an
# explicitly pinned accepted revision - never a copy of the mutable working
# tree - so the runtime executes exactly the accepted bytes. It needs NO Full
# Disk Access grant, NO root privileges, and makes NO provider calls.
#
# Safety properties:
#   * scratch state lives only in an exact `mktemp -d` staging directory that
#     traps remove; no glob or wildcard deletion is ever performed
#   * the previous snapshot and plist stay in place until the replacement
#     snapshot, rendered plist, and launchd load have all validated, so a
#     failed update rolls back instead of destroying the prior installation
#   * every external tool call (git, tar, plutil, launchctl) is wall-clock
#     bounded so a hung tool cannot wedge an unattended install
#   * stale locks fail closed for inspection; no prior process path is deleted
set -eu

[ -n "${HOME:-}" ] || {
	echo "error: HOME is not set" >&2
	exit 1
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

LABEL="com.zerodelta.switchyard.sandbox-canary"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"
SNAPSHOT_PATHS="package.json scripts/sandbox-canary.mjs scripts/sandbox-canary-daily.mjs scripts/hermetic-test-env.mjs src tests"
REQUIRED_SNAPSHOT_FILES="scripts/sandbox-canary.mjs scripts/sandbox-canary-daily.mjs scripts/hermetic-test-env.mjs src/switchyard/runner/checks-sandbox.mjs tests/runner-quick-checks-toolchain-sandbox.test.mjs"

INSTALL_BASE="$HOME/Library/Application Support/switchyard"
INSTALL_DIR="$INSTALL_BASE/sandbox-canary"
STATE_DIR="$INSTALL_BASE/sandbox-canary-state"
LOG_DIR="$HOME/Library/Logs"
CANARY_OUT="$LOG_DIR/switchyard-sandbox-canary.launchd.out.log"
CANARY_ERR="$LOG_DIR/switchyard-sandbox-canary.launchd.err.log"

TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET="$TARGET_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOCK_DIR="$INSTALL_BASE/.sandbox-canary-install.lock"
BOUND_SECONDS="${SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS:-60}"
case "$BOUND_SECONDS" in ""|*[!0-9]*|0) echo "error: invalid command timeout" >&2; exit 1;; esac
[ "$BOUND_SECONDS" -le 60 ] || exit 1
ACTIVE_CHILD=""

STAGE_DIR=""
STAGE_PLIST=""
BACKUP_DIR=""
TARGET_BACKUP=""
LOCK_HELD=0
SWAPPED=0
NEW_TARGET=0
LAUNCHD_TOUCHED=0
INSTALL_OK=0
PRIOR_SERVICE_LOADED=0

fail() {
	echo "error: $*" >&2
	exit 1
}

# A Node supervisor owns a process group and kills the whole group on timeout
# or interruption. Progress precedes every external command.
bounded() {
 limit="$1"; shift
 echo "canary install: running $1 (limit ${limit}s)" >&2
 "$NODE_BIN" --input-type=commonjs -e '
 const {spawn}=require("node:child_process");
 const [limit,command,...args]=process.argv.slice(1);
 const child=spawn(command,args,{stdio:"inherit",detached:true});
 let status=0;
 const stop=(code)=>{status=code;try{process.kill(-child.pid,"SIGKILL")}catch{}};
 const timer=setTimeout(()=>stop(124),Number(limit)*1000);
 process.on("SIGTERM",()=>stop(143));process.on("SIGINT",()=>stop(130));
 child.on("error",()=>{clearTimeout(timer);process.exit(127)});
 child.on("exit",(code,signal)=>{clearTimeout(timer);process.exit(status||(signal?1:code??1))});
 ' "$limit" "$@" &
 ACTIVE_CHILD=$!
 result=0
 wait "$ACTIVE_CHILD" || result=$?
 ACTIVE_CHILD=""
 return "$result"
}

# Only a recognized launchctl service-not-found response proves absence.
# Return 0 loaded, 1 absent, 2 unknown/error (including timeout).
service_loaded() {
 echo "canary: checking launchd service (limit ${BOUND_SECONDS}s)" >&2
 probe_status=0
 probe_output=$(bounded "$BOUND_SECONDS" launchctl print "$DOMAIN/$LABEL" 2>&1) || probe_status=$?
 if [ "$probe_status" -eq 0 ]; then return 0; fi
 if [ "$probe_status" -eq 113 ]; then
  case "$probe_output" in
   *"Could not find service \"$LABEL\" in domain for user gui: ${DOMAIN#gui/}") return 1;;
  esac
 fi
 echo "error: launchctl service state could not be verified (status $probe_status)" >&2
 return 2
}

# Restore the previous installation after a failed update. The prior plist and
# snapshot are only discarded once the new ones load successfully.
rollback() {
	if [ "$INSTALL_OK" -eq 1 ]; then
		return 0
	fi
	echo "warning: install failed; restoring previous $LABEL state" >&2
	if [ "$LAUNCHD_TOUCHED" -eq 1 ]; then
		bounded "$BOUND_SECONDS" launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
	fi
	if [ "$NEW_TARGET" -eq 1 ]; then
		rm -f -- "$TARGET" 2>/dev/null || true
	fi
	if [ -n "$TARGET_BACKUP" ] && [ -f "$TARGET_BACKUP" ]; then
		if mv -f "$TARGET_BACKUP" "$TARGET"; then
			TARGET_BACKUP=""
		else
			echo "error: could not restore prior plist from $TARGET_BACKUP" >&2
		fi
	fi
	if [ "$SWAPPED" -eq 1 ]; then
		rm -rf -- "$INSTALL_DIR" 2>/dev/null || true
		if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
			if mv "$BACKUP_DIR" "$INSTALL_DIR"; then
				BACKUP_DIR=""
			else
				echo "error: could not restore prior snapshot from $BACKUP_DIR" >&2
			fi
		fi
		SWAPPED=0
	fi
	NEW_TARGET=0
	if [ "$LAUNCHD_TOUCHED" -eq 1 ] && [ "$PRIOR_SERVICE_LOADED" -eq 1 ] && [ -f "$TARGET" ]; then
		bounded "$BOUND_SECONDS" launchctl bootstrap "$DOMAIN" "$TARGET" 2>/dev/null || true
	fi
}

# Remove only the exact scratch paths this run owns. Prior-installation backups
# are kept when a rollback could not complete.
cleanup() {
 if [ -n "$ACTIVE_CHILD" ]; then
  kill -TERM "$ACTIVE_CHILD" 2>/dev/null || true
  wait "$ACTIVE_CHILD" 2>/dev/null || true
  ACTIVE_CHILD=""
 fi
	if [ "$INSTALL_OK" -ne 1 ] && [ "$SWAPPED" -eq 1 ]; then
		rollback
	fi
	if [ "$INSTALL_OK" -eq 1 ]; then
		if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
			rm -rf -- "$BACKUP_DIR"
		fi
		if [ -n "$TARGET_BACKUP" ] && [ -f "$TARGET_BACKUP" ]; then
			rm -f -- "$TARGET_BACKUP"
		fi
		BACKUP_DIR=""
		TARGET_BACKUP=""
	fi
	if [ -n "$STAGE_PLIST" ] && [ -f "$STAGE_PLIST" ]; then
		rm -f -- "$STAGE_PLIST"
	fi
	if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
		rm -rf -- "$STAGE_DIR"
	fi
	if [ "$LOCK_HELD" -eq 1 ]; then
		rm -f -- "$LOCK_DIR/pid" 2>/dev/null || true
		rmdir "$LOCK_DIR" 2>/dev/null || true
		LOCK_HELD=0
	fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ -f "$TEMPLATE" ] || fail "missing $TEMPLATE"
[ -f "$PROJECT_ROOT/package.json" ] || fail "missing $PROJECT_ROOT/package.json"
[ -d "$PROJECT_ROOT/src" ] || fail "missing $PROJECT_ROOT/src"

NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
	for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
		if [ -x "$candidate" ]; then
			NODE_BIN="$candidate"
			break
		fi
	done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
	fail "node binary not found or not executable"
fi

GIT_BIN=$(command -v git 2>/dev/null || true)
[ -n "$GIT_BIN" ] || fail "git is required to pin the accepted source snapshot"

mkdir -p "$INSTALL_BASE" "$LOG_DIR" "$TARGET_DIR"

# Never delete stale paths from a prior process or a writable marker. A stale
# lock fails closed for operator inspection; traps release this run own lock.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
 owner_pid=""
 if [ -f "$LOCK_DIR/pid" ] && [ -r "$LOCK_DIR/pid" ]; then
  owner_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
 fi
 lock_detail="invalid or uninspectable owner PID"
 case "$owner_pid" in
  ""|*[!0-9]*) ;;
  *) if [ "$owner_pid" -gt 0 ] 2>/dev/null; then
   if kill -0 "$owner_pid" 2>/dev/null; then
    lock_detail="recorded owner is live"
   else
    lock_detail="recorded PID is not reachable; lock may be stale or uninspectable"
   fi
  fi;;
 esac
 echo "error: install lock exists at $LOCK_DIR; $lock_detail; preserving it for owner inspection" >&2
 exit 1
fi
LOCK_HELD=1
printf '%s\n' "$$" >"$LOCK_DIR/pid"

# Activation must name the exact accepted commit, never infer acceptance from HEAD.
ACCEPTED_REV="${SWITCHYARD_CANARY_REV:-}"
[ "${#ACCEPTED_REV}" -eq 40 ] || fail "set SWITCHYARD_CANARY_REV to the accepted full commit SHA"
case "$ACCEPTED_REV" in *[!0-9a-f]*) fail "invalid accepted commit SHA";; esac
RESOLVED_REV=$(bounded "$BOUND_SECONDS" "$GIT_BIN" -C "$PROJECT_ROOT" rev-parse --verify "$ACCEPTED_REV^{commit}") || fail "accepted commit unavailable"
[ "$RESOLVED_REV" = "$ACCEPTED_REV" ] || fail "accepted commit mismatch"
PREFIX=$(bounded "$BOUND_SECONDS" "$GIT_BIN" -C "$PROJECT_ROOT" rev-parse --show-prefix) || fail "could not resolve project prefix"
if [ -n "$PREFIX" ]; then
 TREE_REF="$ACCEPTED_REV:${PREFIX%/}"
else
 TREE_REF="$ACCEPTED_REV^{tree}"
fi
SNAPSHOT_TREE=$(bounded "$BOUND_SECONDS" "$GIT_BIN" -C "$PROJECT_ROOT" rev-parse --verify "$TREE_REF") || fail "accepted project tree unavailable"

# Exact owned staging directory; traps remove exactly this path.
STAGE_DIR=$(mktemp -d "$INSTALL_BASE/.sandbox-canary-stage.XXXXXX") ||
	fail "could not create a staging directory under $INSTALL_BASE"

SNAPSHOT_TAR="$STAGE_DIR/.snapshot.tar"
if ! bounded "$BOUND_SECONDS" "$GIT_BIN" -C "$PROJECT_ROOT" archive \
	--format=tar -o "$SNAPSHOT_TAR" "$SNAPSHOT_TREE" -- $SNAPSHOT_PATHS; then
	fail "git archive failed for revision $ACCEPTED_REV"
fi
if ! bounded "$BOUND_SECONDS" tar -xf "$SNAPSHOT_TAR" -C "$STAGE_DIR"; then
	fail "could not extract the accepted snapshot"
fi
rm -f -- "$SNAPSHOT_TAR"

for required in $REQUIRED_SNAPSHOT_FILES; do
	if [ ! -s "$STAGE_DIR/$required" ]; then
		fail "accepted snapshot $ACCEPTED_REV is missing $required"
	fi
done
chmod +x "$STAGE_DIR/scripts/sandbox-canary.mjs"
for script in sandbox-canary.mjs sandbox-canary-daily.mjs hermetic-test-env.mjs; do
 if ! bounded "$BOUND_SECONDS" "$NODE_BIN" --check "$STAGE_DIR/scripts/$script"; then
  fail "accepted snapshot $script failed node syntax validation"
 fi
done

# Record the pinned identity inside the snapshot so the running revision is
# auditable without reading the (mutable) project tree.
{
	printf '{\n'
	printf '  "label": "%s",\n' "$LABEL"
	printf '  "revision": "%s",\n' "$ACCEPTED_REV"
	printf '  "tree": "%s",\n' "$SNAPSHOT_TREE"
	printf '  "paths": "%s"\n' "$SNAPSHOT_PATHS"
	printf '}\n'
} >"$STAGE_DIR/snapshot.json"

# Render and validate the new plist before touching the prior installation.
STAGE_PLIST="$TARGET_DIR/.$LABEL.plist.stage.$$"
sed \
	-e "s|__NODE_BIN__|$NODE_BIN|g" \
	-e "s|__CANARY_SCRIPT__|$INSTALL_DIR/scripts/sandbox-canary.mjs|g" \
	-e "s|__CANARY_OUT__|$CANARY_OUT|g" \
	-e "s|__CANARY_ERR__|$CANARY_ERR|g" \
	"$TEMPLATE" >"$STAGE_PLIST"
if ! bounded "$BOUND_SECONDS" plutil -lint "$STAGE_PLIST" >/dev/null; then
	fail "rendered launchd plist failed plutil validation"
fi

service_state=0
service_loaded || service_state=$?
case "$service_state" in
 0) PRIOR_SERVICE_LOADED=1;;
 1) echo "canary: prior service is already unloaded" >&2;;
 *) fail "could not verify prior LaunchAgent state";;
esac

# Atomic swap of the accepted snapshot, previous snapshot kept as backup.
if [ -d "$INSTALL_DIR" ]; then
	BACKUP_DIR="$INSTALL_BASE/.sandbox-canary-previous.$$"
	mv "$INSTALL_DIR" "$BACKUP_DIR" || fail "could not move the previous snapshot aside"
fi
if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
	if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
		mv "$BACKUP_DIR" "$INSTALL_DIR" 2>/dev/null || true
		BACKUP_DIR=""
	fi
	fail "could not install the accepted snapshot"
fi
STAGE_DIR=""
SWAPPED=1

# Atomic swap of the rendered plist, previous plist kept as backup.
if [ -f "$TARGET" ]; then
	TARGET_BACKUP="$TARGET_DIR/.$LABEL.plist.previous.$$"
	mv "$TARGET" "$TARGET_BACKUP" || fail "could not move the previous plist aside"
fi
if ! mv "$STAGE_PLIST" "$TARGET"; then
	fail "could not install the rendered plist"
fi
STAGE_PLIST=""
NEW_TARGET=1

# Bounded, idempotent (re)load.
LAUNCHD_TOUCHED=1
if [ "$PRIOR_SERVICE_LOADED" -eq 1 ]; then
 bounded "$BOUND_SECONDS" launchctl bootout "$DOMAIN/$LABEL" || fail "could not unload prior LaunchAgent"
fi
if ! bounded "$BOUND_SECONDS" launchctl bootstrap "$DOMAIN" "$TARGET"; then
	fail "launchctl bootstrap failed for $TARGET"
fi
if ! bounded "$BOUND_SECONDS" launchctl enable "$DOMAIN/$LABEL"; then
	fail "launchctl enable failed for $LABEL"
fi
INSTALL_OK=1

echo "installed $LABEL"
echo "  canary:   $INSTALL_DIR/scripts/sandbox-canary.mjs"
echo "  revision: $ACCEPTED_REV (tree $SNAPSHOT_TREE)"
echo "  plist:    $TARGET"
echo "  runs:     reports at load + every 86400s (daily, deduplicated locally)"
echo "  state:    $STATE_DIR"
echo "  runtime:  bounded probes and an overall canary deadline"
echo "  log:      $CANARY_OUT"
echo "  kick:     launchctl kickstart $DOMAIN/$LABEL"
