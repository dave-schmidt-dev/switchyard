#!/bin/sh
# Switchyard standalone reaper (VM-name-only, reporting-only).
#
# Inventories managed Parallels VM names and reports candidate residue. It never
# establishes ownership from a PID, run record, or other background metadata,
# and it never stops or deletes a VM. Definitive cleanup is guarded foreground
# pre-dispatch or explicit recovery work, where authoritative run records are
# available.
#
# It reads NO project code and NO run store, so it runs from a launchd
# LaunchAgent under ~/Library without any Full Disk Access / TCC grant (a
# background agent cannot read the project tree under ~/Documents; this reaper
# never needs to).
#
# The name prefix below MUST match PARALLELS_WORKING_PREFIX in
# src/switchyard/lifecycle/parallels-execution-backend.mjs. A parity test
# (tests/reaper-script.test.mjs) asserts they stay in sync so a rename does not
# silently stop candidate reporting.
set -u

# --- Name source of truth (kept in sync by the parity test) ---
WORKING_PREFIX="switchyard-work-"

# launchd starts jobs with a minimal PATH; prlctl lives here.
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export PATH

# Which prlctl to invoke. Overridable so the ops tests can run this script
# end-to-end against a stub: because the PATH above is replaced rather than
# extended, a test that only prepends a stub directory would silently reach the
# real daemon instead, which is the one thing these tests must never do.
PRLCTL="${SWITCHYARD_REAPER_PRLCTL:-prlctl}"
INVENTORY_MAX_ROWS=256

# GNU timeout owns process-group supervision and blocks signals around waitpid,
# avoiding a shell-level PID-reuse race. Production accepts only these trusted
# absolute locations. Tests can select fixed failure fixtures, never an
# arbitrary executable.
case "${SWITCHYARD_REAPER_TESTING:-0}:${SWITCHYARD_REAPER_TEST_SUPERVISOR:-}" in
1:missing) TIMEOUT_CANDIDATES="/switchyard-test/missing-gtimeout" ;;
1:wrong) TIMEOUT_CANDIDATES="/bin/true" ;;
*)
	TIMEOUT_CANDIDATES="/opt/homebrew/bin/gtimeout /opt/homebrew/bin/timeout /usr/local/bin/gtimeout /usr/local/bin/timeout"
	;;
esac

LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/switchyard-reaper.log"

# Bound the log: keep the last 500 lines once it passes ~1 MB.
if [ -f "$LOG" ]; then
	SIZE=$(wc -c <"$LOG" 2>/dev/null || echo 0)
	if [ "$SIZE" -gt 1048576 ]; then
		tail -n 500 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
	fi
fi

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG"; }

# Recognize the bounded managed-name format. This is inventory compatibility,
# not ownership proof: a matching name alone never authorizes a change.
parse_owned_vm() {
	name="$1"
	case "$name" in
	"$WORKING_PREFIX"*) ;;
	*) return 1 ;;
	esac
	remainder=${name#"$WORKING_PREFIX"}
	creator_pid=${remainder##*-}
	run_id=${remainder%-"$creator_pid"}
	case "$creator_pid" in
	'' | 0 | *[!0-9]*) return 1 ;;
	esac
	case "$run_id" in
	'') return 1 ;;
	*[!A-Za-z0-9._-]*) return 1 ;;
	esac
	return 0
}

TIMEOUT_BIN=""
for candidate in $TIMEOUT_CANDIDATES; do
	[ -x "$candidate" ] || continue
	version=$("$candidate" --version 2>/dev/null) || continue
	case "$version" in
	"timeout (GNU coreutils) "*)
		TIMEOUT_BIN="$candidate"
		break
		;;
	esac
done
if [ -z "$TIMEOUT_BIN" ]; then
	log "reaper: GNU timeout supervisor unavailable; managed VM inventory unavailable — no resource changed"
	exit 0
fi

if ! command -v "$PRLCTL" >/dev/null 2>&1; then
	log "reaper: prlctl not found on PATH — no resource changed"
	exit 0
fi

reported=0

# `prlctl list -a -o uuid,status,name` may fail if Parallels isn't running;
# record that the inventory was unavailable. Listed into a temp file (not
# piped straight into `while read`) so the loop runs in THIS shell, not a
# subshell — a piped loop would lose the $reported count across iterations.
LIST_TMP=$(mktemp "${TMPDIR:-/tmp}/switchyard-reaper-list.XXXXXX")
trap 'rm -f "$LIST_TMP"' EXIT HUP INT TERM

log "reaper: managed VM inventory started"
# The supervised shell exists only to apply the output cap before replacing
# itself with prlctl. GNU timeout uses its default process-group mode.
"$TIMEOUT_BIN" --signal=TERM --kill-after=1s 3s \
	/bin/sh -c 'ulimit -f 1024 || exit 125; exec "$@"' \
	switchyard-reaper-inventory "$PRLCTL" list -a -o uuid,status,name \
	>"$LIST_TMP" 2>/dev/null
inventory_status=$?

if [ "$inventory_status" -eq 124 ]; then
	log "reaper: managed VM inventory timed out — no resource changed"
	exit 0
fi
if [ "$inventory_status" -eq 153 ]; then
	log "reaper: managed VM inventory truncated (output limit reached; no resource changed)"
	exit 0
fi
case "$inventory_status" in
125)
	log "reaper: inventory supervisor failed; managed VM inventory unavailable — no resource changed"
	exit 0
	;;
126 | 127)
	log "reaper: inventory invocation unavailable; managed VM inventory unavailable — no resource changed"
	exit 0
	;;
137)
	log "reaper: inventory supervision terminated; managed VM inventory unavailable — no resource changed"
	exit 0
	;;
esac
if [ "$inventory_status" -ne 0 ]; then
	log "reaper: managed VM inventory unavailable — no resource changed"
	exit 0
fi

rows=0
truncated=0
while IFS= read -r line; do
	rows=$((rows + 1))
	if [ "$rows" -gt "$INVENTORY_MAX_ROWS" ]; then
		truncated=1
		break
	fi
	uuid=$(printf '%s\n' "$line" | awk '{print $1}')
	name=$(printf '%s\n' "$line" | awk '{$1=""; $2=""; sub(/^[ \t]+/, ""); print}')
	case "$uuid" in
	'' | UUID) continue ;;
	esac
	if ! parse_owned_vm "$name"; then
		continue
	fi
	reported=$((reported + 1))
	log "reaper: managed VM candidate; ownership unverified; no resource changed"
done <"$LIST_TMP"

if [ "$truncated" -eq 1 ]; then
	log "reaper: managed VM inventory truncated (row limit=$INVENTORY_MAX_ROWS; candidates=$reported; no resources changed)"
	exit 0
fi
log "reaper: managed VM inventory complete (candidates=$reported; no resources changed)"
exit 0
