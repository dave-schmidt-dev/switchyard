#!/bin/bash
# Build the reproducible Parallels golden image used by the macOS backend.
#
# The VM must already contain the Task 1.1 macOS base and host-staged Xcode.
# This script deliberately generates the disposable auto-login password inside
# the guest. It is never placed in a host argument, log, artifact, or BWS.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"
readonly MEMORY_MB=16384
readonly MEMORY_BYTES=$((MEMORY_MB * 1024 * 1024))
readonly XCODEGEN_VERSION="2.46.0"
readonly PF_ANCHOR="com.apple/switchyard-c3"
readonly PF_RULES="/etc/pf.anchors/switchyard-c3"
readonly PF_LOADER="/usr/local/sbin/switchyard-pf-load"
readonly PF_PLIST="/Library/LaunchDaemons/com.zerodelta.switchyard.pf.plist"

VM_NAME=""
PROVIDER_USER="switchyard"
SIMULATOR_RUNTIME_VERSION=""
GATEWAY="10.211.55.1"
BLOCKED_ENDPOINTS=()
REACHABLE_ENDPOINTS=()
DNS_NAME=""
CLI_MANIFEST=""
CLI_MANIFEST_B64=""

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
  build-golden-image.sh --vm NAME --simulator-runtime-version VERSION \
    --cli-manifest PATH \
    --blocked-endpoint HOST:PORT [--blocked-endpoint HOST:PORT ...] \
    --reachable-endpoint HOST:PORT [--reachable-endpoint HOST:PORT ...] \
    --dns-name NAME

The blocked endpoints must cover both host addresses, the LAN gateway, and a
guest/VM-subnet address. The reachable endpoints must cover outbound internet.
The script configures the existing Task 1.1 base VM in place.
EOF
}

require_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "missing value for $1"
}

validate_identifier() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
    fail "unsafe provider account name: $1"
}

validate_ip() {
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
    fail "expected an IPv4 address, got: $1"
  local octet
  IFS=. read -r -a octets <<<"$1"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || fail "IPv4 octet is out of range: $1"
  done
}

validate_dns_name() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$ ]] ||
    fail "unsafe DNS name: $1"
}

validate_endpoint() {
  local endpoint="$1" host port
  [[ "$endpoint" == *:* ]] || fail "expected HOST:PORT endpoint: $endpoint"
  host="${endpoint%:*}"
  port="${endpoint##*:}"
  [[ "$host" =~ ^[A-Za-z0-9._-]+$ ]] || fail "unsafe endpoint host: $host"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] && ((port > 0 && port < 65536)) ||
    fail "invalid endpoint port: $port"
}

parse_args() {
  while (($#)); do
    case "$1" in
      --vm)
        require_value "$@"
        VM_NAME="$2"
        shift 2
        ;;
      --provider-user)
        require_value "$@"
        PROVIDER_USER="$2"
        shift 2
        ;;
      --simulator-runtime-version)
        require_value "$@"
        SIMULATOR_RUNTIME_VERSION="$2"
        shift 2
        ;;
      --cli-manifest)
        require_value "$@"
        CLI_MANIFEST="$2"
        shift 2
        ;;
      --gateway)
        require_value "$@"
        GATEWAY="$2"
        shift 2
        ;;
      --blocked-endpoint)
        require_value "$@"
        BLOCKED_ENDPOINTS+=("$2")
        shift 2
        ;;
      --reachable-endpoint)
        require_value "$@"
        REACHABLE_ENDPOINTS+=("$2")
        shift 2
        ;;
      --dns-name)
        require_value "$@"
        DNS_NAME="$2"
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

  [[ -n "$VM_NAME" ]] || fail "--vm is required"
  [[ -n "$SIMULATOR_RUNTIME_VERSION" ]] ||
    fail "--simulator-runtime-version is required"
  [[ "$SIMULATOR_RUNTIME_VERSION" =~ ^[0-9]+([.][0-9]+){1,2}$ ]] ||
    fail "runtime version must be numeric, got: $SIMULATOR_RUNTIME_VERSION"
  [[ -n "$DNS_NAME" ]] || fail "--dns-name is required"
  [[ -n "$CLI_MANIFEST" && -r "$CLI_MANIFEST" ]] ||
    fail "--cli-manifest must name a readable pinned CLI manifest"
  ((${#BLOCKED_ENDPOINTS[@]} >= 4)) ||
    fail "at least four --blocked-endpoint values are required"
  ((${#REACHABLE_ENDPOINTS[@]} >= 1)) ||
    fail "at least one --reachable-endpoint value is required"

  validate_identifier "$PROVIDER_USER"
  validate_ip "$GATEWAY"
  validate_dns_name "$DNS_NAME"
  for endpoint in "${BLOCKED_ENDPOINTS[@]}" "${REACHABLE_ENDPOINTS[@]}"; do
    validate_endpoint "$endpoint"
  done
  validate_cli_manifest
  CLI_MANIFEST_B64="$(/usr/bin/base64 < "$CLI_MANIFEST" | /usr/bin/tr -d '\n')"
}

validate_cli_manifest() {
  local line provider kind ref detail hash extra
  local seen=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    IFS='|' read -r provider kind ref detail hash extra <<<"$line"
    [[ -n "$provider" && -n "$kind" && -n "$ref" && -n "$detail" && -n "$hash" && -z "${extra:-}" ]] ||
      fail "invalid CLI manifest row (expected provider|kind|ref|detail|sha256): $line"
    [[ " $seen " != *" $provider "* ]] || fail "duplicate CLI manifest provider: $provider"
    seen+=" $provider"
    case "$provider:$kind" in
      claude:script|codex:script|agy:script|cursor-agent:script)
        [[ "$ref" =~ ^https://[A-Za-z0-9._/~:+?=%-]+$ ]] ||
          fail "CLI manifest script URL must be HTTPS: $provider"
        [[ "$detail" == bash || "$detail" == sh ]] ||
          fail "CLI manifest shell must be bash or sh: $provider"
        ;;
      copilot:npm|opencode:npm)
        [[ "$ref" =~ ^(@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$ ]] ||
          fail "CLI manifest npm package is unsafe: $provider"
        [[ "$detail" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
          fail "CLI manifest npm version is unsafe: $provider"
        ;;
      *)
        fail "unsupported CLI manifest provider/kind: $provider/$kind"
        ;;
    esac
    [[ "$hash" =~ ^[0-9a-fA-F]{64}$ ]] ||
      fail "CLI manifest hash must be a 64-character SHA-256: $provider"
  done < "$CLI_MANIFEST"

  local expected
  for expected in claude codex agy cursor-agent copilot opencode; do
    [[ " $seen " == *" $expected "* ]] ||
      fail "CLI manifest is missing provider: $expected"
  done
}

require_host_tools() {
  local tool
  for tool in prlctl prlsrvctl pbcopy pbpaste osascript base64; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing host tool: $tool"
  done
}

guest_exec() {
  # The command is supplied as an argv element, not interpolated into a host
  # shell. The generated password is created only inside guest_exec_script.
  prlctl exec "$VM_NAME" /bin/bash -lc "$1"
}

guest_exec_script() {
  prlctl exec "$VM_NAME" /bin/bash -s
}

wait_for_exec() {
  local attempt
  for attempt in {1..60}; do
    if guest_exec ':' >/dev/null 2>&1; then
      log "guest Tools channel is ready"
      return 0
    fi
    ((attempt % 5 == 0)) && log "waiting for guest Tools channel (${attempt}/60)"
    sleep 2
  done
  fail "guest Tools channel did not become ready"
}

stop_vm() {
  log "stopping VM before host-side configuration"
  local stop_pid=""
  local vm_id=""
  local vm_pids=""
  prlctl stop "$VM_NAME" >/dev/null 2>&1 &
  stop_pid=$!
  for attempt in {1..15}; do
    if ! kill -0 "$stop_pid" 2>/dev/null; then
      wait "$stop_pid" 2>/dev/null || true
      stop_pid=""
      break
    fi
    sleep 1
  done
  if [[ -n "$stop_pid" ]] && kill -0 "$stop_pid" 2>/dev/null; then
    log "normal VM shutdown stalled; forcing stop"
    kill -KILL "$stop_pid" 2>/dev/null || true
    wait "$stop_pid" 2>/dev/null || true
  fi
  for attempt in {1..30}; do
    if prlctl status "$VM_NAME" 2>/dev/null | grep -Eqi 'stopped|suspended'; then
      return 0
    fi
    if ((attempt == 1 || attempt % 5 == 0)); then
      prlctl stop "$VM_NAME" --kill >/dev/null 2>&1 || true
    fi
    if ((attempt == 5)); then
      vm_id="$(prlctl list -i "$VM_NAME" 2>/dev/null | awk '/^ID:/ {print $2}')"
      if [[ "$vm_id" =~ ^\{[0-9a-fA-F-]+\}$ ]]; then
        vm_pids="$(ps -axo pid=,command= | awk -v id="$vm_id" \
          '$0 ~ /prl_macvm_app/ && index($0, id) {print $1}')"
        for vm_pid in $vm_pids; do
          kill -KILL "$vm_pid" 2>/dev/null || true
        done
      fi
    fi
    sleep 1
  done
  fail "VM did not stop: $VM_NAME"
}

start_vm() {
  log "starting VM in headless mode"
  prlctl start "$VM_NAME" >/dev/null
  wait_for_exec
}

wait_for_provider_user() {
  local attempt
  for attempt in {1..60}; do
    if guest_exec "/usr/bin/id -u '$PROVIDER_USER'" >/dev/null 2>&1; then
      log "provider user is ready"
      return 0
    fi
    ((attempt % 5 == 0)) && log "waiting for provider user (${attempt}/60)"
    sleep 2
  done
  fail "provider user did not become ready: $PROVIDER_USER"
}

configure_host() {
  log "enabling Parallels headless mode and pinning ${MEMORY_MB} MiB"
  prlsrvctl set --headless-mode-feature on >/dev/null
  stop_vm
  prlctl set "$VM_NAME" --startup-view headless >/dev/null
  prlctl set "$VM_NAME" --memsize "$MEMORY_MB" >/dev/null
  prlctl set "$VM_NAME" --shf-host-defined off >/dev/null
}

configure_guest() {
  log "configuring guest account, automation mode, CLIs, clipboard, and pf"
  guest_exec_script <<EOF
set -Eeuo pipefail
IFS=$'\n\t'

provider_user='$PROVIDER_USER'
gateway='$GATEWAY'
runtime_version='$SIMULATOR_RUNTIME_VERSION'
pf_anchor='$PF_ANCHOR'
pf_rules='$PF_RULES'
pf_loader='$PF_LOADER'
pf_plist='$PF_PLIST'

guest_log() {
  printf '[guest] %s\\n' "\$*" >&2
}

guest_fail() {
  guest_log "ERROR: \$*"
  exit 1
}

[[ "\$(id -u)" == 0 ]] || guest_fail "guest configuration requires root"
[[ "\$(/usr/bin/fdesetup status 2>&1)" == *"FileVault is Off"* ]] ||
  guest_fail "FileVault must be off for unattended auto-login"
command -v /usr/sbin/sysadminctl >/dev/null || guest_fail "sysadminctl missing"
command -v /usr/bin/perl >/dev/null || guest_fail "perl is required for kcpassword encoding"

console_user="\$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
console_uid="\$(/usr/bin/stat -f%u /dev/console 2>/dev/null || true)"
[[ -n "\$console_user" && "\$console_user" != root && "\$console_uid" != 0 ]] ||
  guest_fail "an existing interactive build user is required for Homebrew packages"
if [[ -x /opt/homebrew/bin/brew ]]; then
  brew_path=/opt/homebrew
elif [[ -x /usr/local/bin/brew ]]; then
  brew_path=/usr/local
else
  guest_fail "Homebrew is required in the Task 1.1 base VM"
fi
if ! /bin/launchctl asuser "\$console_uid" /usr/bin/sudo -iu "\$console_user" \\
  /bin/bash -lc "test -x '\$brew_path/bin/node'"; then
  /usr/sbin/dseditgroup -o checkmember -m "\$console_user" admin 2>/dev/null | /usr/bin/grep -q '^yes' ||
    guest_fail "existing console user is not an administrator"
  guest_log "installing Node through the existing administrator build session"
  /bin/launchctl asuser "\$console_uid" /usr/bin/sudo -iu "\$console_user" \\
    /usr/bin/env NONINTERACTIVE=1 "\$brew_path/bin/brew" install node
fi
if ! /bin/launchctl asuser "\$console_uid" /usr/bin/sudo -iu "\$console_user" \\
  "\$brew_path/bin/xcodegen" --version 2>/dev/null |
  /usr/bin/grep -Fq "Version: ${XCODEGEN_VERSION}"; then
  guest_log "installing pinned XcodeGen ${XCODEGEN_VERSION} through the existing administrator build session"
  /bin/launchctl asuser "\$console_uid" /usr/bin/sudo -iu "\$console_user" \\
    /usr/bin/env NONINTERACTIVE=1 "\$brew_path/bin/brew" install xcodegen
fi
/bin/launchctl asuser "\$console_uid" /usr/bin/sudo -iu "\$console_user" \\
  "\$brew_path/bin/xcodegen" --version |
  /usr/bin/grep -Fq "Version: ${XCODEGEN_VERSION}" ||
  guest_fail "XcodeGen version is not pinned to ${XCODEGEN_VERSION}"

# The password is generated and consumed inside this guest shell. It is never
# an argument to prlctl, never printed, and never copied to a host artifact.
password="\$(/usr/bin/openssl rand -hex 32)"
if /usr/bin/id "\$provider_user" >/dev/null 2>&1; then
  # Tahoe's sysadminctl reset path may request a secure-token unlock even
  # when this root guest shell is already authenticated. dscl performs the
  # local-directory reset without an interactive prompt.
  /usr/bin/dscl . -passwd "/Users/\$provider_user" "\$password" >/dev/null
else
  /usr/sbin/sysadminctl -addUser "\$provider_user" -fullName "Switchyard Provider" -password "\$password" >/dev/null
fi
/usr/bin/dscl . -create "/Users/\$provider_user" UserShell /bin/zsh
/usr/sbin/dseditgroup -o edit -d "\$provider_user" admin >/dev/null 2>&1 || true
if /usr/sbin/dseditgroup -o checkmember -m "\$provider_user" admin 2>/dev/null | /usr/bin/grep -q '^yes'; then
  guest_fail "provider account remains an administrator"
fi

# kcpassword is a deliberate, bounded exception: this disposable password is
# generated here, authenticates only this guest, belongs to a non-admin user,
# and is shared by clones of this image. If any condition changes, rebuild the
# image instead of reusing or rotating this credential in a running VM.
umask 077
/usr/bin/defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "\$provider_user"
/usr/bin/defaults write /Library/Preferences/com.apple.loginwindow autoLoginUserScreenLocked -bool false
/usr/bin/printf '%s' "\$password" |
  /usr/bin/perl -0777 -e '
    my \$password = <STDIN>;
    my @key = (0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f);
    my \$padding = 12 - (length(\$password) % 12);
    \$padding = 12 if \$padding == 0;
    \$password .= "\\0" x \$padding;
    for (my \$i = 0; \$i < length(\$password); \$i++) {
      print chr(ord(substr(\$password, \$i, 1)) ^ \$key[\$i % scalar(@key)]);
    }
  ' > /etc/kcpassword
/usr/sbin/chown root:wheel /etc/kcpassword
/bin/chmod 600 /etc/kcpassword
unset password

guest_log "enabling unauthenticated automation mode"
if [[ ! -e /var/db/com.apple.dt.automationmode/no-auth-required ]]; then
  /usr/bin/automationmodetool enable-automationmode-without-authentication </dev/null >/dev/null
fi

guest_log "installing guest-side clipboard and C-3 pf hardening"
if [[ "\$console_uid" =~ ^[0-9]+$ && "\$console_uid" != 0 ]]; then
  /bin/launchctl bootout "gui/\$console_uid/com.parallels.copypaste" >/dev/null 2>&1 || true
fi
if [[ -e /Library/LaunchAgents/com.parallels.copypaste.plist ]]; then
  /bin/mv /Library/LaunchAgents/com.parallels.copypaste.plist \\
    /Library/LaunchAgents/com.parallels.copypaste.plist.switchyard-disabled
fi

umask 022
/usr/bin/install -d -o root -g wheel -m 755 /etc/pf.anchors /usr/local/sbin /Library/LaunchDaemons
/bin/cat > "\$pf_rules" <<PFEOF
anchor "switchyard-transfer/*"
pass  out quick on en0 proto udp from any to \$gateway port 53
pass  out quick on en0 proto tcp from any to \$gateway port 53
pass  out quick on en0 proto udp from any to \$gateway port 67
block drop quick on en0 from any to 10.0.0.0/8
block drop quick on en0 from any to 172.16.0.0/12
block drop quick on en0 from any to 192.168.0.0/16
block drop quick on en0 from any to 169.254.0.0/16
pass  out quick on en0 from any to any
PFEOF
/usr/sbin/chown root:wheel "\$pf_rules"
/bin/chmod 644 "\$pf_rules"
/bin/cat > "\$pf_loader" <<'LOADEREOF'
#!/bin/sh
set -eu
if ! /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q 'Status: Enabled'; then
  /sbin/pfctl -E >/dev/null
fi
/sbin/pfctl -a com.apple/switchyard-c3 -f /etc/pf.anchors/switchyard-c3 >/dev/null
LOADEREOF
/usr/sbin/chown root:wheel "\$pf_loader"
/bin/chmod 755 "\$pf_loader"
/bin/cat > "\$pf_plist" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zerodelta.switchyard.pf</string>
  <key>ProgramArguments</key>
  <array><string>\$pf_loader</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLISTEOF
/usr/sbin/chown root:wheel "\$pf_plist"
/bin/chmod 644 "\$pf_plist"
/bin/launchctl bootout system/com.zerodelta.switchyard.pf >/dev/null 2>&1 || true
/bin/launchctl bootstrap system "\$pf_plist"
/bin/launchctl kickstart -k system/com.zerodelta.switchyard.pf
guest_log "guest configuration complete"
EOF
}

install_guest_tools() {
  log "installing unauthenticated provider CLIs in the provider Aqua identity"
  guest_exec_script <<EOF
set -Eeuo pipefail
provider_user='$PROVIDER_USER'
runtime_version='$SIMULATOR_RUNTIME_VERSION'
cli_manifest_b64='$CLI_MANIFEST_B64'
uid="\$(/usr/bin/id -u "\$provider_user")"
manifest_path='/tmp/switchyard-cli-manifest'
/usr/bin/printf '%s' "\$cli_manifest_b64" | /usr/bin/base64 -D > "\$manifest_path"
/bin/chmod 644 "\$manifest_path"
trap '/bin/rm -f "\$manifest_path"' EXIT
/bin/launchctl asuser "\$uid" /usr/bin/sudo -iu "\$provider_user" /bin/bash -s -- "\$manifest_path" <<'INSTALL_SCRIPT'
set -Eeuo pipefail
export NONINTERACTIVE=1
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"
manifest_path="\$1"
tmp_dir="\$(/usr/bin/mktemp -d "\$HOME/.switchyard-cli.XXXXXX")"
trap '/bin/rm -rf "\$tmp_dir"' EXIT

install_script_cli() {
  local provider="\$1" url="\$2" shell="\$3" expected="\$4"
  local installer="\$tmp_dir/\$provider-installer"
  /usr/bin/curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \\
    --output "\$installer" "\$url"
  printf '%s  %s\\n' "\$expected" "\$installer" | /usr/bin/shasum -a 256 -c - >/dev/null
  /bin/chmod 700 "\$installer"
  case "\$shell" in
    bash) /bin/bash "\$installer" >/dev/null ;;
    sh) /bin/sh "\$installer" >/dev/null ;;
    *) printf '[guest] ERROR: invalid installer shell for %s\\n' "\$provider" >&2; exit 1 ;;
  esac
}

install_npm_cli() {
  local provider="\$1" package="\$2" version="\$3" expected="\$4"
  local tarball
  npm config set prefix "\$HOME/.local"
  tarball="\$(npm pack --silent --pack-destination "\$tmp_dir" "\${package}@\${version}" | /usr/bin/tail -n 1)"
  [[ "\$tarball" != */* && -f "\$tmp_dir/\$tarball" ]] || {
    printf '[guest] ERROR: npm pack did not return a safe artifact for %s\\n' "\$provider" >&2
    exit 1
  }
  printf '%s  %s\\n' "\$expected" "\$tmp_dir/\$tarball" | /usr/bin/shasum -a 256 -c - >/dev/null
  if [[ "\$package" == opencode-ai ]]; then
    npm install --global "\$tmp_dir/\$tarball" --allow-scripts=opencode-ai >/dev/null
  else
    npm install --global "\$tmp_dir/\$tarball" >/dev/null
  fi
}

while IFS='|' read -r provider kind ref detail expected extra; do
  [[ -z "\${provider:-}" || "\$provider" == \#* ]] && continue
  [[ -z "\${extra:-}" && "\$expected" =~ ^[0-9a-fA-F]{64}$ ]] || {
    printf '[guest] ERROR: malformed pinned CLI manifest row\\n' >&2
    exit 1
  }
  case "\$kind" in
    script) install_script_cli "\$provider" "\$ref" "\$detail" "\$expected" ;;
    npm) install_npm_cli "\$provider" "\$ref" "\$detail" "\$expected" ;;
    *) printf '[guest] ERROR: unsupported pinned CLI kind: %s\\n' "\$kind" >&2; exit 1 ;;
  esac
done < "\$manifest_path"
for provider in claude codex agy cursor-agent copilot opencode; do
  command -v "\$provider" >/dev/null 2>&1 || {
    printf '[guest] ERROR: pinned CLI is absent after installation: %s\\n' "\$provider" >&2
    exit 1
  }
done
INSTALL_SCRIPT
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
/usr/bin/xcode-select -s "\$DEVELOPER_DIR"
/usr/bin/xcodebuild -runFirstLaunch >/dev/null
if ! /usr/bin/xcrun simctl list runtimes | /usr/bin/grep -Fq "iOS \$runtime_version"; then
  /usr/bin/xcodebuild -downloadPlatform iOS -buildVersion "\$runtime_version" >/dev/null
fi
/usr/bin/xcrun simctl list runtimes | /usr/bin/grep -Fq "iOS \$runtime_version" ||
  { printf '[guest] ERROR: pinned iOS runtime is absent: %s\\n' "\$runtime_version" >&2; exit 1; }
EOF
}

restart_and_assert() {
  log "restarting VM before posture assertions"
  stop_vm
  start_vm
  wait_for_provider_user
  install_guest_tools
  log "restarting once more so final assertions cover the completed image"
  stop_vm
  start_vm
  wait_for_provider_user

  log "asserting restarted guest posture"
  guest_exec_script <<EOF
set -Eeuo pipefail
provider_user='$PROVIDER_USER'
expected_memory_bytes='$MEMORY_BYTES'
pf_anchor='$PF_ANCHOR'
developer_dir='/Applications/Xcode.app/Contents/Developer'

fail_guest() {
  printf '[guest] ERROR: %s\\n' "\$*" >&2
  exit 1
}

/usr/sbin/dseditgroup -o checkmember -m "\$provider_user" admin 2>/dev/null | /usr/bin/grep -q '^yes' &&
  fail_guest "provider account is an administrator"
# The outer sudo only enters the provider identity; the inner invocation is
# the actual no-password check performed as that non-admin user.
/usr/bin/sudo -n -u "\$provider_user" /usr/bin/sudo -n true >/dev/null 2>&1 &&
  fail_guest "provider account can sudo without authentication"
[[ "\$(/usr/bin/stat -f%Su /dev/console)" == "\$provider_user" ]] ||
  fail_guest "auto-login did not create the provider Aqua session"
/usr/bin/defaults read /Library/Preferences/com.apple.loginwindow |
  /usr/bin/grep -Eq 'autoLoginUserScreenLocked = 0;' ||
  fail_guest "auto-login session is configured to lock immediately"
uid="\$(/usr/bin/id -u "\$provider_user")"
/bin/launchctl print "gui/\$uid" >/dev/null || fail_guest "Aqua launchd domain is absent"
/usr/bin/automationmodetool | /usr/bin/grep -q 'DOES NOT REQUIRE user authentication' ||
  fail_guest "automation mode still requires authentication"
/bin/test ! -e /Library/LaunchAgents/com.parallels.copypaste.plist ||
  fail_guest "Parallels clipboard LaunchAgent is present"
/bin/launchctl print "gui/\$uid/com.parallels.copypaste" >/dev/null 2>&1 &&
  fail_guest "Parallels clipboard service is loaded"
/bin/test "\$(/usr/sbin/sysctl -n hw.memsize)" = "\$expected_memory_bytes" ||
  fail_guest "guest memory does not match ${MEMORY_MB} MiB"
/usr/bin/xcode-select -p | /usr/bin/grep -Fxq "\$developer_dir" ||
  fail_guest "active developer directory is not the pinned Xcode"
/sbin/pfctl -s info | /usr/bin/grep -q 'Status: Enabled' || fail_guest "pf is disabled"
/sbin/pfctl -a "\$pf_anchor" -sr | /usr/bin/grep -q 'block drop quick on en0' ||
  fail_guest "C-3 pf anchor is not loaded"
printf '[guest] restarted posture assertions passed\\n' >&2
EOF

  prlctl list -i "$VM_NAME" | grep -Eq "memory size=${MEMORY_MB}Mb auto=off" ||
    fail "Parallels did not persist explicit memory sizing"
  prlctl list -i "$VM_NAME" | grep -Eq 'Host defined sharing: Off' ||
    fail "host-defined shared folders are enabled"
  guest_exec ':' >/dev/null || fail "prlctl exec round-trip failed after restart"
  assert_network_posture
  assert_clipboard_isolation
}

assert_network_posture() {
  log "asserting guest-side C-3 network probes"
  local script endpoint host port
  script='set -Eeuo pipefail
probe_blocked() {
  local endpoint="$1"
  local host="${endpoint%:*}" port="${endpoint##*:}"
  if /usr/bin/nc -G 3 -w 3 -z "$host" "$port" >/dev/null 2>&1; then
    printf "reachable blocked endpoint: %s\\n" "$endpoint" >&2
    exit 1
  fi
}
probe_reachable() {
  local endpoint="$1"
  local host="${endpoint%:*}" port="${endpoint##*:}"
  local attempt
  for attempt in {1..30}; do
    if /usr/bin/nc -G 5 -w 5 -z "$host" "$port" >/dev/null 2>&1; then
      return 0
    fi
    printf "waiting for reachable endpoint (%s/30): %s\\n" "$attempt" "$endpoint" >&2
    sleep 2
  done
  printf "unreachable internet endpoint: %s\\n" "$endpoint" >&2
  exit 1
}
'
  for endpoint in "${BLOCKED_ENDPOINTS[@]}"; do
    script+="probe_blocked '$endpoint'\n"
  done
  for endpoint in "${REACHABLE_ENDPOINTS[@]}"; do
    script+="probe_reachable '$endpoint'\n"
  done
  script+="/usr/bin/dscacheutil -q host -a name '$DNS_NAME' | /usr/bin/grep -q '^ip_address:'\n"
  printf '%b\n' "$script" | guest_exec_script || fail "C-3 probe table failed"
  log "C-3 probe table passed"
}

assert_clipboard_isolation() {
  local sentinel='switchyard-clipboard-sentinel'
  local original_clipboard=''
  local probe_status=0
  log "asserting clipboard isolation with a fresh host sentinel"
  original_clipboard="$(pbpaste 2>/dev/null || true)"
  printf '%s' "$sentinel" | pbcopy
  if guest_exec_script <<EOF
set +e
uid="\$(/usr/bin/id -u "$PROVIDER_USER")"
/usr/bin/perl -e 'alarm 10; exec @ARGV' /bin/launchctl asuser "\$uid" \
  /usr/bin/sudo -u "$PROVIDER_USER" /usr/bin/pbpaste 2>/dev/null |
  /usr/bin/grep -Fq "$sentinel"
status=\$?
if ((status == 0)); then
  exit 1
fi
exit 0
EOF
  then
    :
  else
    probe_status=1
  fi
  printf '%s' "$original_clipboard" | pbcopy
  ((probe_status == 0)) || fail "host clipboard sentinel reached guest"
  log "clipboard sentinel was not visible in guest"
}

main() {
  parse_args "$@"
  require_host_tools
  configure_host
  start_vm
  configure_guest
  restart_and_assert
  log "golden image build and restarted posture checks passed"
}

main "$@"
