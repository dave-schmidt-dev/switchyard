#!/bin/sh
# Switchyard standalone reaper (VM-name-only, project-code-free).
#
# Reclaims proven-dead managed Parallels VMs by reading ownership straight off
# each VM's own reserved name — switchyard-work-<runId>-<creatorPid>, the
# exact prefix/suffix contract ParallelsExecutionBackend.buildParallelsWorkingName
# writes and parseParallelsWorkingName parses — and probing the embedded
# creator PID with `kill -0`. It reads NO project code and NO run store, so it
# runs from a launchd LaunchAgent under ~/Library without any Full Disk
# Access / TCC grant (a background agent cannot read the project tree under
# ~/Documents; this reaper never needs to).
#
# This is the standalone counterpart to `switchyard-dispatch recover`. It is
# deliberately NARROWER than recover: it only touches VMs whose complete name
# parses as a Switchyard owner, and it SKIPS anything else — a foreign or
# malformed-prefix VM is never touched or reported, and a live owner (live
# PID) is always skipped. It shares INV-3's guarantee: force-remove ONLY a
# proven-dead owner's VM.
#
# The name prefix below MUST match PARALLELS_WORKING_PREFIX in
# src/switchyard/lifecycle/parallels-execution-backend.mjs. A parity test
# (tests/reaper-script.test.mjs) asserts they stay in sync so a rename there
# can't silently disable this reaper. The same applies to the linked-clone
# snapshot name and the sidecar directory below.
#
# Snapshots are REPORTED, never deleted. A golden-image snapshot that no
# sidecar accounts for is unreclaimable by design — the code must never delete
# a snapshot it did not record — but leaving it invisible is how one sat on
# switchyard-golden-6 from 2026-08-13 unnoticed.
set -u

# --- Name source of truth (kept in sync by the parity test) ---
WORKING_PREFIX="switchyard-work-"
LINKED_SNAPSHOT_NAME="Snapshot for linked clone"
SIDECAR_DIR="$HOME/.switchyard/admission/linked-snapshots"

# launchd starts jobs with a minimal PATH; prlctl lives here.
PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export PATH

# Which prlctl to invoke. Overridable so the ops tests can run this script
# end-to-end against a stub: because the PATH above is replaced rather than
# extended, a test that only prepends a stub directory would silently reach the
# real daemon instead, which is the one thing these tests must never do.
PRLCTL="${SWITCHYARD_REAPER_PRLCTL:-prlctl}"

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

# Is the owning PID live? Empty/non-numeric => no signal => NOT reapable (return
# 1 so the caller skips). A live PID (kill -0 ok) => alive. Note: kill -0 by the
# same user (all switchyard workers + this reaper run as the invoking user) is
# reliable; the only EPERM case is a foreign process that reused a dead worker's
# PID, whose liveness is irrelevant because the actual owner is already dead —
# so treating "signalable" as the alive test never false-reaps a live owner.
owner_reapable() {
	pid="$1"
	case "$pid" in
	'' | *[!0-9]*) return 1 ;; # no numeric PID signal => skip (safe direction)
	esac
	if kill -0 "$pid" 2>/dev/null; then
		return 1 # owner alive => skip
	fi
	return 0 # proven dead => reap
}

# Parse ownership from a VM name. Sets $creator_pid on success. The PID is the
# final hyphen-delimited component, so run IDs may contain hyphens without
# weakening the proof (mirrors parseParallelsWorkingName).
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

if ! command -v "$PRLCTL" >/dev/null 2>&1; then
	log "reaper: prlctl not found on PATH — nothing to do"
	exit 0
fi

reaped=0

# `prlctl list -a -o uuid,status,name` may fail if Parallels isn't running;
# a failed listing just means nothing to reap. Listed into a temp file (not
# piped straight into `while read`) so the loop runs in THIS shell, not a
# subshell — a piped loop would lose the $reaped count across iterations.
LIST_TMP=$(mktemp "${TMPDIR:-/tmp}/switchyard-reaper-list.XXXXXX")
trap 'rm -f "$LIST_TMP"' EXIT
"$PRLCTL" list -a -o uuid,status,name >"$LIST_TMP" 2>/dev/null

while IFS= read -r line; do
	uuid=$(printf '%s\n' "$line" | awk '{print $1}')
	status=$(printf '%s\n' "$line" | awk '{print $2}')
	name=$(printf '%s\n' "$line" | awk '{$1=""; $2=""; sub(/^[ \t]+/, ""); print}')
	case "$uuid" in
	'' | UUID) continue ;;
	esac
	if ! parse_owned_vm "$name"; then
		continue
	fi
	if ! owner_reapable "$creator_pid"; then
		continue
	fi
	case "$status" in
	[Ss]topped) ;;
	*) "$PRLCTL" stop "$uuid" --kill >/dev/null 2>&1 ;;
	esac
	if "$PRLCTL" delete "$uuid" >/dev/null 2>&1; then
		reaped=$((reaped + 1))
		log "reaper: removed VM $name ($uuid, dead owner pid $creator_pid)"
	fi
done <"$LIST_TMP"

# --- Report unrecorded golden-image snapshots (never delete) ---
#
# The golden image name is not derivable from a VM listing, so take it from the
# environment when present and otherwise from the sidecars themselves. When
# neither yields a name, say so rather than logging a clean result that was
# never actually checked.
GOLDEN_IMAGES=$(
	{
		[ -n "${SWITCHYARD_PARALLELS_GOLDEN_IMAGE:-}" ] &&
			printf '%s\n' "$SWITCHYARD_PARALLELS_GOLDEN_IMAGE"
		[ -d "$SIDECAR_DIR" ] &&
			sed -n 's/.*"goldenImage":"\([^"]*\)".*/\1/p' "$SIDECAR_DIR"/*.json \
				2>/dev/null
	} 2>/dev/null | sort -u
)

if [ -z "$GOLDEN_IMAGES" ]; then
	log "reaper: no golden image name available — snapshot check skipped"
else
	unrecorded=0
	for golden in $GOLDEN_IMAGES; do
		SNAP_TMP=$(mktemp "${TMPDIR:-/tmp}/switchyard-reaper-snap.XXXXXX")
		if ! "$PRLCTL" snapshot-list "$golden" -j >"$SNAP_TMP" 2>/dev/null; then
			log "reaper: could not list snapshots on $golden — check skipped"
			rm -f "$SNAP_TMP"
			continue
		fi
		# Verified against prlctl 26.4.1 (2026-08-26): the -j output is a map
		# keyed by brace-wrapped snapshot id, and each id key line precedes its
		# own "name" line. Track the last id seen and emit it when the name
		# matches.
		# Listed into a temp file, not piped: a piped `while read` runs in a
		# subshell and would lose the $unrecorded count across iterations, the
		# same reason the VM loop above uses a file.
		IDS_TMP=$(mktemp "${TMPDIR:-/tmp}/switchyard-reaper-ids.XXXXXX")
		awk -v want="$LINKED_SNAPSHOT_NAME" '
			/^[[:space:]]*"\{[^}]*\}"[[:space:]]*:/ {
				id = $0
				sub(/^[[:space:]]*"/, "", id)
				sub(/"[[:space:]]*:.*$/, "", id)
				next
			}
			/"name"[[:space:]]*:/ {
				name = $0
				sub(/^[^:]*:[[:space:]]*"/, "", name)
				sub(/",?[[:space:]]*$/, "", name)
				if (name == want && id != "") print id
			}
		' "$SNAP_TMP" >"$IDS_TMP"
		while IFS= read -r snapshot_id; do
			[ -n "$snapshot_id" ] || continue
			# Recorded means a sidecar this code wrote names the id.
			if grep -qF "$snapshot_id" "$SIDECAR_DIR"/*.json 2>/dev/null; then
				continue
			fi
			unrecorded=$((unrecorded + 1))
			log "reaper: UNRECORDED snapshot $snapshot_id on $golden — not deleted, needs human review"
		done <"$IDS_TMP"
		rm -f "$IDS_TMP"
		rm -f "$SNAP_TMP"
	done
	log "reaper: snapshot check done (unrecorded=$unrecorded)"
fi

log "reaper: done (vms=$reaped)"
exit 0
