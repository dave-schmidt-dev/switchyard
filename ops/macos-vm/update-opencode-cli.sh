#!/bin/bash
# Update only the pinned OpenCode npm CLI in an existing stopped Parallels VM.
#
# The host never receives or stores credentials. The guest command is fixed
# except for the three values read from the manifest, and it is delivered over
# prlctl stdin rather than an argv string.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"
readonly POLL_ATTEMPTS=30
readonly POLL_SECONDS=2
readonly TOOLS_EXEC_TIMEOUT_SECONDS=30
readonly UPDATE_EXEC_TIMEOUT_SECONDS=900
readonly HEARTBEAT_SECONDS=30

VM_NAME=""
CLI_MANIFEST=""
PACKAGE=""
VERSION=""
SHA256=""
STARTED=0

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage:
  update-opencode-cli.sh --vm NAME --cli-manifest PATH

The manifest must contain exactly one opencode|npm|opencode-ai|VERSION|SHA256
row. The named VM must be stopped before this script starts it.
EOF
}

require_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
}

validate_vm_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    fail "unsafe VM name: $1"
}

validate_manifest_path() {
  [[ "$1" == /* ]] || fail "manifest path must be absolute: $1"
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] ||
    fail "manifest path contains a line break"
  [[ "$1" != -* && -r "$1" && -f "$1" ]] ||
    fail "manifest path is not a readable regular file: $1"
}

parse_args() {
  local seen_vm=0 seen_manifest=0
  while (($#)); do
    case "$1" in
      --vm)
        ((seen_vm == 0)) || fail "duplicate --vm"
        require_value "$@"
        VM_NAME="$2"
        seen_vm=1
        shift 2
        ;;
      --cli-manifest)
        ((seen_manifest == 0)) || fail "duplicate --cli-manifest"
        require_value "$@"
        CLI_MANIFEST="$2"
        seen_manifest=1
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        usage
        fail "unknown argument: $1"
        ;;
    esac
  done

  ((seen_vm == 1)) || fail "--vm is required"
  ((seen_manifest == 1)) || fail "--cli-manifest is required"
  validate_vm_name "$VM_NAME"
  validate_manifest_path "$CLI_MANIFEST"
}

read_manifest() {
  local line provider kind ref detail hash extra
  local matches=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    IFS='|' read -r provider kind ref detail hash extra <<<"$line"
    [[ -z "${extra:-}" ]] || fail "malformed manifest row: $line"
    if [[ "$provider" == opencode ]]; then
      ((matches += 1))
      [[ "$kind" == npm && "$ref" == opencode-ai ]] ||
        fail "opencode row must be opencode|npm|opencode-ai|VERSION|SHA256"
      [[ "$detail" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
        fail "unsafe OpenCode version: $detail"
      [[ "$hash" =~ ^[0-9a-fA-F]{64}$ ]] ||
        fail "OpenCode row must contain a 64-character SHA-256"
      PACKAGE="$ref"
      VERSION="$detail"
      SHA256="$(printf '%s' "$hash" | tr '[:upper:]' '[:lower:]')"
    fi
  done < "$CLI_MANIFEST"

  ((matches == 1)) || fail "manifest must contain exactly one opencode row (found $matches)"
}

require_host_tools() {
  command -v prlctl >/dev/null 2>&1 || fail "missing host tool: prlctl"
  command -v sleep >/dev/null 2>&1 || fail "missing host tool: sleep"
}

run_bounded() {
  local timeout_seconds="$1"
  shift
  local pid elapsed=0 grace=0

  "$@" <&0 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if ((elapsed >= timeout_seconds)); then
      log "ERROR: command timed out after ${timeout_seconds}s: $*"
      kill -TERM "$pid" 2>/dev/null || true
      for ((grace = 0; grace < 5; grace += 1)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    ((elapsed == 0 || elapsed % HEARTBEAT_SECONDS == 0)) &&
      log "command still running (${elapsed}/${timeout_seconds}s): $*"
    sleep 1
    ((elapsed += 1))
  done
  if wait "$pid"; then
    return 0
  else
    return $?
  fi
}

status_is_stopped() {
  local status="$1" vm_name="$2" line
  if grep -Eiq 'running|suspend|paused' <<<"$status"; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(State[[:space:]]*:[[:space:]]*)?stopped[[:space:]]*$ ]]; then
      return 0
    fi
    [[ "$line" == "VM $vm_name exist stopped" ]] && return 0
  done <<<"$status"
  return 1
}

vm_status() {
  prlctl status "$VM_NAME" 2>/dev/null || true
}

wait_for_stopped() {
  local attempt status
  for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1)); do
    status="$(vm_status)"
    if status_is_stopped "$status" "$VM_NAME"; then
      return 0
    fi
    ((attempt == 1 || attempt % 5 == 0)) &&
      log "waiting for VM to stop (${attempt}/${POLL_ATTEMPTS})"
    sleep "$POLL_SECONDS"
  done
  return 1
}

stop_started_vm() {
  local stop_rc=0
  log "stopping VM"
  prlctl stop "$VM_NAME" >/dev/null 2>&1 || stop_rc=$?
  if ! wait_for_stopped; then
    log "ERROR: VM did not reach authoritative stopped state"
    return 1
  fi
  if ((stop_rc != 0)); then
    log "ERROR: prlctl stop failed (exit $stop_rc)"
    return "$stop_rc"
  fi
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if ((STARTED == 1)); then
    if stop_started_vm; then
      :
    else
      rc=$?
    fi
  fi
  exit "$rc"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

parse_args "$@"
read_manifest
require_host_tools

log "checking VM is stopped"
initial_status="$(vm_status)"
status_is_stopped "$initial_status" "$VM_NAME" ||
  fail "VM must be stopped before update (observed: ${initial_status:-no status})"

log "starting VM"
STARTED=1
if prlctl start "$VM_NAME" >/dev/null; then
  :
else
  start_rc=$?
  log "ERROR: could not start VM (exit $start_rc)"
  exit "$start_rc"
fi

log "waiting for guest Tools"
guest_ready=0
for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1)); do
  if run_bounded "$TOOLS_EXEC_TIMEOUT_SECONDS" prlctl exec "$VM_NAME" /bin/bash -lc ':'; then
    guest_ready=1
    log "guest Tools channel is ready"
    break
  fi
  ((attempt == 1 || attempt % 5 == 0)) &&
    log "waiting for guest Tools (${attempt}/${POLL_ATTEMPTS})"
  sleep "$POLL_SECONDS"
done
((guest_ready == 1)) || fail "guest Tools channel did not become ready"

log "installing $PACKAGE@$VERSION in the switchyard Aqua session"
run_bounded "$UPDATE_EXEC_TIMEOUT_SECONDS" prlctl exec "$VM_NAME" /bin/bash -s <<EOF
set -Eeuo pipefail
umask 077
readonly package='$PACKAGE'
readonly version='$VERSION'
readonly expected_sha256='$SHA256'
readonly provider_user='switchyard'
readonly provider_home='/Users/switchyard'
uid="\$(id -u "\$provider_user")"

/bin/launchctl asuser "\$uid" /usr/bin/sudo -H -u "\$provider_user" /usr/bin/env \
  "SWITCHYARD_OPENCODE_PACKAGE=\$package" \
  "SWITCHYARD_OPENCODE_VERSION=\$version" \
  "SWITCHYARD_OPENCODE_SHA256=\$expected_sha256" \
  /bin/bash -lc '
  set -Eeuo pipefail
  umask 077
  export HOME="/Users/switchyard"
  export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  workdir="\$(mktemp -d "\$HOME/.switchyard-opencode-update.XXXXXX")"
  cleanup_guest() {
    local rc=\$?
    trap - EXIT INT TERM
    rm -rf -- "\$workdir"
    exit "\$rc"
  }
  trap cleanup_guest EXIT
  trap "exit 130" INT
  trap "exit 143" TERM
  cd "\$workdir"
  tarball="\$(npm pack --silent "\$SWITCHYARD_OPENCODE_PACKAGE@\$SWITCHYARD_OPENCODE_VERSION")"
  [[ "\$tarball" =~ ^opencode-ai-[0-9A-Za-z.+_-]+\.tgz\$ ]] || {
    printf "unexpected npm pack output: %s\\n" "\$tarball" >&2
    exit 1
  }
  # This heredoc expands once on the host before the guest receives it. Avoid
  # an awk positional field reference here: an escaped backslash leaves that
  # positional parameter exposed to the host shell (for example, --vm).
  actual_sha256="\$(shasum -a 256 "\$tarball" | /usr/bin/cut -d " " -f 1)"
  [[ "\$actual_sha256" == "\$SWITCHYARD_OPENCODE_SHA256" ]] || {
    printf "npm tarball SHA-256 mismatch: expected %s, got %s\\n" "\$SWITCHYARD_OPENCODE_SHA256" "\$actual_sha256" >&2
    exit 1
  }
  npm install --global --allow-scripts=opencode-ai "\$tarball"
  installed_version="\$(opencode --version)"
  [[ "\$installed_version" == "\$SWITCHYARD_OPENCODE_VERSION" ]] || {
    printf "installed OpenCode version mismatch: expected %s, got %s\\n" "\$SWITCHYARD_OPENCODE_VERSION" "\$installed_version" >&2
    exit 1
  }
  printf "OpenCode %s installed and verified\\n" "\$installed_version"
'
EOF

log "guest update completed"
