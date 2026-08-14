#!/bin/bash
# Measure, inside a macOS guest, where each of the six provider CLIs keeps its
# credentials and whether a tar-provisioned copy actually authenticates.
#
# This produces Task 1.3's credential table. It exists because the 11 entries in
# PROVIDER_CREDENTIAL_PATHS (src/switchyard/lifecycle/index.mjs) are Linux
# /root/... paths with no macOS meaning, and because "file-backed" does not
# imply "tar-provisionable": a CLI may bind its auth store to machine identity
# and reject a copy that arrives from elsewhere, which reads as file-backed and
# behaves as Keychain-backed. So the column is measured by running each
# provider's own auth check, never inferred from where a file happens to sit.
#
# Identity is the whole point. `prlctl exec` lands as root in the System domain
# while the provider CLIs run in the auto-login account's Aqua session, and the
# two see different Keychains. Every check below is therefore routed through
# `launchctl asuser <uid> sudo -iu <account>` -- the same form
# build-golden-image.sh's install_guest_tools uses -- and the script reports the
# uid, username, and launchd manager name it actually measured under, so a
# result taken in the wrong domain is visible rather than silently wrong.
#
# Nothing here reads or prints a credential value. Files are reported by path,
# size, and mode only, and the Keychain is enumerated with `security
# dump-keychain` WITHOUT -d, which lists item attributes and never secrets.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"

VM_NAME=""
PROVIDER_USER="switchyard"
PHASE="baseline"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: probe-guest-credentials.sh --vm NAME [--provider-user ACCOUNT]
                                  [--phase baseline|provisioned]

  --phase baseline     the guest has never been provisioned. Every provider is
                       expected to report unauthenticated; anything else means
                       the image shipped with a credential, which is a D-10
                       violation and a build defect.
  --phase provisioned  credentials have just been pushed into this throwaway
                       clone. A provider that now reports authenticated is
                       tar-provisionable yes; one that still reports
                       unauthenticated is tar-provisionable no, whatever its
                       storage shape looks like.

Run it against a throwaway clone, never the golden image: the provisioned phase
puts real credentials in the guest.
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --vm)
        [[ $# -ge 2 ]] || fail "--vm requires a value"
        VM_NAME="$2"
        shift 2
        ;;
      --provider-user)
        [[ $# -ge 2 ]] || fail "--provider-user requires a value"
        PROVIDER_USER="$2"
        shift 2
        ;;
      --phase)
        [[ $# -ge 2 ]] || fail "--phase requires a value"
        PHASE="$2"
        shift 2
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
  [[ -n "$VM_NAME" ]] || { usage; fail "--vm is required"; }
  [[ "$PROVIDER_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "unsafe provider user: $PROVIDER_USER"
  [[ "$PHASE" == baseline || "$PHASE" == provisioned ]] ||
    fail "--phase must be baseline or provisioned: $PHASE"
}

require_host_tools() {
  command -v prlctl >/dev/null 2>&1 || fail "missing host tool: prlctl"
  prlctl status "$VM_NAME" 2>/dev/null | grep -Eqi 'running' ||
    fail "VM is not running: $VM_NAME"
}

# The guest script is fed on stdin exactly as build-golden-image.sh does it, so
# nothing about the probe reaches a host argv or a host log.
probe_guest() {
  prlctl exec "$VM_NAME" /bin/bash -s <<EOF
set -Eeuo pipefail
provider_user='$PROVIDER_USER'
phase='$PHASE'
uid="\$(/usr/bin/id -u "\$provider_user")"
printf 'host-observed-uid=%s\n' "\$uid"
/bin/launchctl asuser "\$uid" /usr/bin/sudo -iu "\$provider_user" /bin/bash -s -- "\$phase" <<'PROBE_SCRIPT'
set -uo pipefail
phase="\$1"
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"

# macOS ships no timeout(1). perl does ship, and an alarm set before exec
# survives the exec, so this bounds a hung provider check without coreutils.
bounded() {
  local seconds="\$1"
  shift
  /usr/bin/perl -e 'alarm shift; exec @ARGV' "\$seconds" "\$@"
}

# --- identity, reported so a wrong-domain result cannot pass as a right one ---
printf '## identity\n'
printf 'user=%s uid=%s home=%s\n' "\$(/usr/bin/id -un)" "\$(/usr/bin/id -u)" "\$HOME"
# Aqua is the GUI login session. "System" means the check ran in the prlctl root
# domain instead, and every Keychain-backed answer below would be meaningless.
printf 'launchd-manager=%s\n' "\$(/bin/launchctl managername 2>/dev/null || printf 'unknown')"
printf 'phase=%s\n' "\$phase"

# --- credential artifacts: path, size, mode. Never contents. ---
printf '\n## files\n'
for candidate in \\
  .claude/.credentials.json .claude.json \\
  .codex/auth.json \\
  .gemini/antigravity-cli/antigravity-oauth-token \\
  .config/cursor/auth.json .cursor/cli-config.json \\
  .config/github-copilot/hosts.json .config/github-copilot/apps.json .copilot/config.json \\
  .config/gh/hosts.yml \\
  .local/share/opencode/auth.json; do
  path="\$HOME/\$candidate"
  if [[ -e "\$path" ]]; then
    printf 'present %s %s %s\n' "\$candidate" \\
      "\$(/usr/bin/stat -f '%z' "\$path")" "\$(/usr/bin/stat -f '%Sp' "\$path")"
  else
    printf 'absent  %s\n' "\$candidate"
  fi
done

# That candidate list is a translation of the Linux map and may simply be wrong
# about macOS. Enumerate the real directories too, so a store this script does
# not know about shows up instead of being silently missed.
printf '\n## directories\n'
for directory in .claude .codex .gemini .cursor .config/cursor \\
  .config/github-copilot .copilot .config/gh .local/share/opencode; do
  path="\$HOME/\$directory"
  [[ -d "\$path" ]] || { printf 'absent  %s\n' "\$directory"; continue; }
  /usr/bin/find "\$path" -maxdepth 2 -type f 2>/dev/null |
    while IFS= read -r found; do
      printf 'file    %s %s\n' "\${found#\$HOME/}" "\$(/usr/bin/stat -f '%z' "\$found")"
    done
done

# --- Keychain: attribute names only. No -d, so no secret can be printed. ---
# This is the column that decides copilot: its own login help says the token
# goes to "the system credential store" and only falls back to a plaintext file
# under ~/.copilot when no store is found. On macOS that store is this keychain.
printf '\n## keychain-services\n'
keychain="\$HOME/Library/Keychains/login.keychain-db"
if [[ -e "\$keychain" ]]; then
  # Bounded like the auth checks are: a locked keychain or an unexpected
  # authorization prompt would otherwise hang the whole prlctl exec, which has
  # no timeout of its own.
  bounded 30 /usr/bin/security dump-keychain "\$keychain" 2>/dev/null |
    /usr/bin/awk -F'"' '/"svce"<blob>=/ {print \$4}' |
    /usr/bin/sort -u |
    /usr/bin/sed 's/^/service /' ||
    printf 'service (dump failed or keychain locked)\n'
else
  printf 'service (no login keychain at %s)\n' "\$keychain"
fi

# --- auth checks: each provider's own, classified by output, not exit code ---
# Measured against the pinned CLIs on 2026-08-14: cursor-agent status and
# opencode auth list both EXIT 0 while logged out, so exit status alone is not a
# classifier -- reading it as one reports a logged-out CLI as ready, which is
# exactly the wrong "yes" this table exists to prevent.
#
# The unauthenticated signature of every row below is measured. The
# authenticated signature is measured only where it is the strict complement of
# the unauthenticated one (claude's JSON flag, agy's model list, opencode's
# credential count). For codex, cursor-agent, and copilot it is a best guess, so
# those may land as indeterminate on first authenticated run -- the raw evidence
# is printed for exactly that case, and the real string belongs in this table
# once seen.
printf '\n## auth\n'
classify() {
  local provider="\$1" unauth_re="\$2" auth_rule="\$3"
  shift 3
  local output status verdict
  output="\$(bounded 90 "\$@" 2>&1)"
  status=\$?
  verdict="indeterminate"
  if [[ "\$output" =~ \$unauth_re ]]; then
    verdict="unauthenticated"
  elif [[ "\$auth_rule" == exit0 ]]; then
    [[ \$status -eq 0 ]] && verdict="authenticated"
  elif [[ "\$output" =~ \$auth_rule ]]; then
    verdict="authenticated"
  fi
  printf '%s\t%s\texit=%s\n' "\$provider" "\$verdict" "\$status"
  # An indeterminate verdict is the one case a human has to read, so show the
  # evidence. These commands print account state, not credential values; bound
  # the excerpt anyway.
  if [[ "\$verdict" == indeterminate ]]; then
    printf '%s' "\$output" | /usr/bin/head -c 400 | /usr/bin/sed 's/^/  | /'
    printf '\n'
  fi
}

classify claude '"loggedIn": false' '"loggedIn": true' claude auth status
classify codex 'Not logged in' 'Logged in' codex login status
classify agy 'Please sign in' 'gemini-' agy models
classify cursor-agent 'Not logged in' 'Logged in|Email|Account' cursor-agent status
# copilot has no status subcommand at all -- login is its only auth verb -- so
# the check is a trivial dispatch, whose unauthenticated refusal is exact and
# measured. On the provisioned phase this one costs a real API call.
classify copilot 'No authentication information found' exit0 \\
  copilot -p 'reply with the single word ok' --allow-all-tools
classify opencode '0 credentials' '[1-9][0-9]* credentials' opencode auth list
PROBE_SCRIPT
EOF
}

main() {
  parse_args "$@"
  require_host_tools
  log "probing $VM_NAME as $PROVIDER_USER (phase: $PHASE)"
  probe_guest
  log "probe complete -- transcribe the ## auth block into Task 1.3's table"
  log "baseline: every provider must read unauthenticated (D-10)"
  log "provisioned: authenticated => tar-provisionable yes; anything else => no"
}

main "$@"
