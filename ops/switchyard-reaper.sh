#!/bin/sh
# Switchyard standalone reaper (label-only, project-code-free).
#
# Reclaims proven-dead working containers + named volumes by reading liveness
# straight off each object's own Docker labels — the `worker_pid` the creating
# process stamped — and probing it with `kill -0`. It reads NO project code and
# NO run store, so it runs from a launchd LaunchAgent under ~/Library without
# any Full Disk Access / TCC grant (a background agent cannot read the project
# tree under ~/Documents; this reaper never needs to).
#
# This is the standalone counterpart to `switchyard-dispatch recover`. It is
# deliberately NARROWER than recover: it only reaps objects that carry a
# `worker_pid` label (every object created since the PID-label change does), and
# it SKIPS any object with no PID signal (the safe direction — a legacy no-pid
# orphan is left for interactive/pre-dispatch `recover`, never force-removed
# blind). It shares INV-3's guarantee: force-remove ONLY a proven-dead owner's
# objects; a live owner (live PID) is always skipped.
#
# Label strings below MUST match src/switchyard/lifecycle/index.mjs. A parity
# test (tests/reaper-script.test.mjs) asserts they stay in sync so a rename
# there can't silently disable this reaper.
set -u

# --- Label source of truth (kept in sync by the parity test) ---
MANAGED_LABEL="com.zerodelta.switchyard.managed"
PID_LABEL="com.zerodelta.switchyard.worker_pid"

# launchd starts jobs with a minimal PATH; docker (OrbStack) lives here.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

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

if ! command -v docker >/dev/null 2>&1; then
	log "reaper: docker not found on PATH — nothing to do"
	exit 0
fi

# OrbStack may be stopped; a failed listing just means nothing to reap.
containers=$(docker ps -aq --filter "label=$MANAGED_LABEL=true" 2>/dev/null || true)
volumes=$(docker volume ls -q --filter "label=$MANAGED_LABEL=true" 2>/dev/null || true)

reaped_c=0
reaped_v=0

# Containers first, so a named working volume is no longer in-use when the
# volume pass runs (docker rm -f -v only removes ANON volumes, not our named
# ${name}-vol).
for id in $containers; do
	pid=$(docker inspect --format "{{index .Config.Labels \"$PID_LABEL\"}}" "$id" 2>/dev/null || echo "")
	if owner_reapable "$pid"; then
		if docker rm -f -v "$id" >/dev/null 2>&1; then
			reaped_c=$((reaped_c + 1))
			log "reaper: removed container $id (dead owner pid ${pid:-none})"
		fi
	fi
done

for v in $volumes; do
	pid=$(docker volume inspect --format "{{index .Labels \"$PID_LABEL\"}}" "$v" 2>/dev/null || echo "")
	if owner_reapable "$pid"; then
		if docker volume rm -f "$v" >/dev/null 2>&1; then
			reaped_v=$((reaped_v + 1))
			log "reaper: removed volume $v (dead owner pid ${pid:-none})"
		fi
	fi
done

log "reaper: done (containers=$reaped_c volumes=$reaped_v)"
exit 0
