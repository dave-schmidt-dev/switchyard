#!/bin/bash
# Bring the host's provider CLIs to the versions pinned in the CLI manifest, the
# same pins update-guest-clis.sh applies inside the golden VM, so the host and
# the guest run one release of each CLI.
#
# Each CLI is updated with its own documented updater (see host_update below);
# the manifest stays the single pin. A CLI whose package manager cannot reach the
# pin (for example a Homebrew formula that lags the vendor) is reported and the
# script exits non-zero, never silently left behind. Lower the pin with
# generate-cli-manifest.sh in that case so both lanes can install it.
#
#   sync-host-clis.sh --cli-manifest PATH            update what differs, verify
#   sync-host-clis.sh --cli-manifest PATH --check    report only, change nothing
#   sync-host-clis.sh --cli-manifest PATH --only vibe [--only copilot]
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"
readonly UPDATE_TIMEOUT_SECONDS=900
readonly HEARTBEAT_SECONDS=30
readonly KNOWN_PROVIDERS=(claude codex agy cursor-agent copilot opencode vibe)

CLI_MANIFEST=""
CHECK_ONLY=0
ONLY=()

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
  sync-host-clis.sh --cli-manifest PATH [--check] [--only PROVIDER]...

Updates the host CLIs named by the manifest (all seven by default, or only the
repeatable --only PROVIDERs) to their pinned versions. --check reports host
versus pin and exits 1 on any difference without changing anything.
PROVIDER is one of: claude codex agy cursor-agent copilot opencode vibe.
EOF
}

is_known_provider() {
  local candidate="$1" known
  for known in "${KNOWN_PROVIDERS[@]}"; do
    [[ "$candidate" == "$known" ]] && return 0
  done
  return 1
}

parse_args() {
  while (($#)); do
    case "$1" in
      --cli-manifest)
        [[ $# -ge 2 && -n "$2" ]] || fail "missing value for --cli-manifest"
        CLI_MANIFEST="$2"
        shift 2
        ;;
      --only)
        [[ $# -ge 2 && -n "$2" ]] || fail "missing value for --only"
        is_known_provider "$2" || fail "unknown provider for --only: $2"
        ONLY+=("$2")
        shift 2
        ;;
      --check)
        CHECK_ONLY=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage
        fail "unknown argument: $1"
        ;;
    esac
  done
  [[ -n "$CLI_MANIFEST" ]] || fail "--cli-manifest is required"
  [[ "$CLI_MANIFEST" == /* && -f "$CLI_MANIFEST" && -r "$CLI_MANIFEST" ]] ||
    fail "manifest must be an absolute path to a readable file: $CLI_MANIFEST"
}

selected() {
  local provider="$1" only_match
  ((${#ONLY[@]})) || return 0
  for only_match in "${ONLY[@]}"; do
    [[ "$only_match" == "$provider" ]] && return 0
  done
  return 1
}

# Same version-token rule the guest scripts use, so host and guest compare alike.
extract_cli_version() {
  printf '%s\n' "$1" | awk '
    {
      for (i = 1; i <= NF; i++) {
        w = $i
        sub(/[^0-9A-Za-z]+$/, "", w)
        if (ver == "" && w ~ /^[0-9][0-9A-Za-z.+_-]*$/) {
          ver = w
        }
      }
    }
    END {
      if (ver != "") print ver
    }
  '
}

host_version() {
  local provider="$1" raw
  command -v "$provider" >/dev/null 2>&1 || return 0
  raw="$("$provider" --version </dev/null 2>&1 || true)"
  extract_cli_version "$raw"
}

# Runs a command with a wall-clock limit and a heartbeat so a long download is
# never a silent wait.
run_bounded() {
  local timeout_seconds="$1"
  shift
  local pid elapsed=0
  "$@" </dev/null >&2 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if ((elapsed >= timeout_seconds)); then
      log "ERROR: timed out after ${timeout_seconds}s: $*"
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    ((elapsed > 0 && elapsed % HEARTBEAT_SECONDS == 0)) &&
      log "still running (${elapsed}/${timeout_seconds}s): $*"
    sleep 1
    ((elapsed += 1))
  done
  wait "$pid"
}

# opencode is pinned on the host like everywhere else, from the same npm package
# the guest installs. Homebrew's formula tracks its own (2.x) line and cannot
# pin; an unattended `brew upgrade` moving it to 2.0.20 is what broke
# agent-headless on 2026-10-02. A Homebrew opencode would also own the same
# /opt/homebrew/bin/opencode link, so it must be removed first, by the owner.
opencode_brew_conflict() {
  brew list --formula opencode >/dev/null 2>&1
}

# The documented updater for each host install. Homebrew casks cannot pin, so
# they move to whatever brew publishes; the caller verifies the result against
# the pin. npm and uv can pin, so opencode and vibe land on exactly the pin.
host_update() {
  local provider="$1" version="$2"
  case "$provider" in
    claude) run_bounded "$UPDATE_TIMEOUT_SECONDS" brew upgrade --cask claude-code@latest ;;
    codex) run_bounded "$UPDATE_TIMEOUT_SECONDS" brew upgrade --cask codex ;;
    copilot) run_bounded "$UPDATE_TIMEOUT_SECONDS" copilot update ;;
    cursor-agent) run_bounded "$UPDATE_TIMEOUT_SECONDS" cursor-agent update ;;
    agy) run_bounded "$UPDATE_TIMEOUT_SECONDS" agy update ;;
    opencode)
      if opencode_brew_conflict; then
        log "ERROR: Homebrew's opencode formula is installed; it cannot hold the pin. Run: brew uninstall opencode"
        return 1
      fi
      run_bounded "$UPDATE_TIMEOUT_SECONDS" npm install --global "opencode-ai@$version"
      ;;
    vibe) run_bounded "$UPDATE_TIMEOUT_SECONDS" uv tool install --force "mistral-vibe==$version" ;;
    *) fail "no host updater for $provider" ;;
  esac
}

parse_args "$@"
for tool in brew npm uv; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing host tool: $tool"
done

mismatches=0
checked=0
while IFS='|' read -r provider kind ref detail hash version extra; do
  [[ -z "${provider:-}" || "$provider" == \#* ]] && continue
  is_known_provider "$provider" || fail "unknown provider in manifest: $provider"
  selected "$provider" || continue
  checked=$((checked + 1))
  current="$(host_version "$provider")"
  if [[ "$current" == "$version" ]]; then
    log "$provider $version ok"
    continue
  fi
  if ((CHECK_ONLY == 1)); then
    log "DRIFT $provider: host ${current:-absent}, pinned $version"
    mismatches=$((mismatches + 1))
    continue
  fi
  log "$provider: host ${current:-absent}, pinned $version; updating"
  host_update "$provider" "$version" || fail "$provider updater failed"
  current="$(host_version "$provider")"
  if [[ "$current" == "$version" ]]; then
    log "$provider $version ok"
  else
    log "DRIFT $provider: host ${current:-absent} after update, pinned $version (its package manager cannot reach the pin; lower the pin with generate-cli-manifest.sh)"
    mismatches=$((mismatches + 1))
  fi
done <"$CLI_MANIFEST"

((checked > 0)) || fail "no manifest rows selected"
if ((mismatches > 0)); then
  fail "$mismatches host CLI(s) differ from the pinned manifest"
fi
log "host CLIs match the pinned manifest"
