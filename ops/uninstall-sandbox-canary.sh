#!/bin/sh
# Uninstall the Switchyard sandbox canary LaunchAgent. Idempotent.
#
# Removes only the exact owned paths: the rendered LaunchAgent plist, the
# installed immutable snapshot directory, and the local daily state directory.
# No glob deletion, no root privileges, no host privilege changes.
set -eu

[ -n "${HOME:-}" ] || {
	echo "error: HOME is not set" >&2
	exit 1
}

LABEL="com.zerodelta.switchyard.sandbox-canary"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_BASE="$HOME/Library/Application Support/switchyard"
INSTALL_DIR="$INSTALL_BASE/sandbox-canary"
STATE_DIR="$INSTALL_BASE/sandbox-canary-state"
LOCK_DIR="$INSTALL_BASE/.sandbox-canary-install.lock"
DOMAIN="gui/$(id -u)"
BOUND_SECONDS="${SWITCHYARD_CANARY_INSTALL_TIMEOUT_SECONDS:-60}"
case "$BOUND_SECONDS" in ""|*[!0-9]*|0) exit 1;; esac
[ "$BOUND_SECONDS" -le 60 ] || exit 1
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
 echo "error: node binary is required for bounded uninstall; not found or not executable" >&2
 exit 1
fi
ACTIVE_CHILD=""
LOCK_HELD=0
cleanup() {
 if [ -n "$ACTIVE_CHILD" ]; then kill -TERM "$ACTIVE_CHILD" 2>/dev/null || true; wait "$ACTIVE_CHILD" 2>/dev/null || true; fi
 if [ "$LOCK_HELD" -eq 1 ]; then rm -f -- "$LOCK_DIR/pid"; rmdir "$LOCK_DIR"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

# Install and uninstall share an atomic lock; stale ownership fails closed.
mkdir -p "$INSTALL_BASE"
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
# Never infer absence from an arbitrary print/bootout error.
service_state=0
service_loaded || service_state=$?
case "$service_state" in
 0) bounded "$BOUND_SECONDS" launchctl bootout "$DOMAIN/$LABEL" || { echo "error: unload failed; preserving installation" >&2; exit 1; };;
 1) echo "canary: service is already unloaded" >&2;;
 *) echo "error: service state unknown; preserving installation" >&2; exit 1;;
esac
rm -f -- "$TARGET"
rm -rf -- "$INSTALL_DIR"
rm -rf -- "$STATE_DIR"
echo "uninstalled $LABEL"
echo "  removed plist:    $TARGET"
echo "  removed snapshot: $INSTALL_DIR"
echo "  removed state:    $STATE_DIR"
