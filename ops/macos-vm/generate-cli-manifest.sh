#!/bin/bash
# Regenerate the CLI manifest consumed by build-golden-image.sh --cli-manifest.
#
# The manifest is a point-in-time pin, not a vendor guarantee. Four of the six
# providers install from an unversioned HTTPS installer URL whose content the
# vendor can change at any moment; when that happens the recorded hash stops
# matching and the golden-image build fails closed at the shasum check inside
# the guest. That is the intended behaviour: the fix is to re-run this script,
# review the diff, and commit the new hashes -- never to edit a hash by hand to
# make a build pass.
#
# The two npm rows are stronger. `npm pack` of a published version writes the
# registry's own tarball bytes verbatim, so this script hashes the packed
# tarball AND independently hashes the registry's advertised dist.tarball, and
# refuses to emit a row unless the two agree. That row type is therefore
# verifiable by anyone against the public registry, without trusting this
# machine. The four script rows carry no such independent witness -- they attest
# only to what this host downloaded at generation time.
set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_NAME="$(basename "$0")"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Sources of record for the pinned provider CLIs. A ref change here changes the
# golden-image installer contract.
readonly CLAUDE_URL="https://claude.ai/install.sh"
readonly CODEX_URL="https://chatgpt.com/codex/install.sh"
readonly AGY_URL="https://antigravity.google/cli/install.sh"
readonly CURSOR_URL="https://cursor.com/install"
readonly COPILOT_PACKAGE="@github/copilot"
readonly OPENCODE_PACKAGE="opencode-ai"
readonly VIBE_FORMULA="mistral-vibe"
readonly VIBE_VERSION="2.24.5"
readonly VIBE_SOURCE_URL="https://files.pythonhosted.org/packages/a9/53/30c20ad3726fbb7876d8aaf92a86cd0ebaa5eb84a0e3e2f1a899057ff4c2/mistral_vibe-2.24.5.tar.gz"

OUT_PATH="${SCRIPT_DIR}/cli-manifest.txt"
CLAUDE_VERSION=""
CODEX_VERSION=""
COPILOT_VERSION=""
OPENCODE_VERSION=""
WORK_DIR=""

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*" >&2
}

fail() {
  log "ERROR: $*"
  exit 1
}

cleanup() {
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

usage() {
  cat >&2 <<'USAGE'
Usage: generate-cli-manifest.sh --claude-version VERSION
                                --codex-version VERSION
                                [--out PATH]
                                [--copilot-version VERSION]
                                [--opencode-version VERSION]

Writes the seven-row CLI manifest. claude and codex versions are required.
npm versions default to whatever the registry currently publishes as `latest`;
pin them explicitly to reproduce an older manifest. Use --out - to write to
stdout instead of a file.
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out)
        [[ $# -ge 2 ]] || fail "--out requires a value"
        OUT_PATH="$2"
        shift 2
        ;;
      --claude-version)
        [[ $# -ge 2 ]] || fail "--claude-version requires a value"
        CLAUDE_VERSION="$2"
        shift 2
        ;;
      --codex-version)
        [[ $# -ge 2 ]] || fail "--codex-version requires a value"
        CODEX_VERSION="$2"
        shift 2
        ;;
      --copilot-version)
        [[ $# -ge 2 ]] || fail "--copilot-version requires a value"
        COPILOT_VERSION="$2"
        shift 2
        ;;
      --opencode-version)
        [[ $# -ge 2 ]] || fail "--opencode-version requires a value"
        OPENCODE_VERSION="$2"
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

  [[ -n "$CLAUDE_VERSION" ]] || fail "--claude-version is required"
  [[ "$CLAUDE_VERSION" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid claude version: $CLAUDE_VERSION"
  [[ -n "$CODEX_VERSION" ]] || fail "--codex-version is required"
  [[ "$CODEX_VERSION" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid codex version: $CODEX_VERSION"
  [[ -z "$COPILOT_VERSION" || "$COPILOT_VERSION" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid copilot version: $COPILOT_VERSION"
  [[ -z "$OPENCODE_VERSION" || "$OPENCODE_VERSION" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid opencode version: $OPENCODE_VERSION"
}

require_host_tools() {
  local tool
  for tool in curl npm shasum python3; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing host tool: $tool"
  done
}

sha256_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Downloads with the same curl posture install_guest_tools uses in the guest, so
# what is hashed here is what the guest will fetch and verify there.
fetch_installer() {
  local url="$1" destination="$2"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    -o "$destination" "$url" ||
    fail "installer download failed: $url"
  [[ -s "$destination" ]] || fail "installer download was empty: $url"
}

extract_cursor_version() {
  local installer="$1"
  local versions=()
  local v
  while IFS= read -r v; do
    [[ -n "$v" ]] && versions+=("$v")
  done < <(grep -o -E 'downloads\.cursor\.com/lab/[^/]+' "$installer" 2>/dev/null | sed -E 's|^downloads\.cursor\.com/lab/||' | sort -u || true)
  if ((${#versions[@]} != 1)); then
    fail "expected exactly one distinct cursor version in installer, found ${#versions[@]}"
  fi
  local version="${versions[0]}"
  [[ "$version" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid cursor version extracted: $version"
  printf '%s\n' "$version"
}

extract_agy_version() {
  local installer="$1"
  local base_url
  base_url="$(grep -E 'DOWNLOAD_BASE_URL=' "$installer" 2>/dev/null | sed -E 's/.*DOWNLOAD_BASE_URL=["'\'']([^"'\'']+)["'\''].*/\1/' || true)"
  [[ -n "$base_url" && "$base_url" == https://* ]] ||
    fail "could not read DOWNLOAD_BASE_URL from agy installer"

  local manifest_url="${base_url%/}/manifests/darwin_arm64.json"
  local manifest_file="${WORK_DIR}/agy-manifest.json"
  fetch_installer "$manifest_url" "$manifest_file"

  local version
  version="$(python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        d = json.load(f)
    v = d.get("version")
    if isinstance(v, str) and v:
        print(v)
    else:
        sys.exit(1)
except Exception:
    sys.exit(1)
' "$manifest_file" 2>/dev/null || true)"

  [[ -n "$version" && "$version" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "agy manifest version is absent or malformed"
  printf '%s\n' "$version"
}

script_row() {
  local provider="$1" url="$2" shell="$3"
  local version="${4:-}"
  local destination="${WORK_DIR}/${provider}.installer"
  fetch_installer "$url" "$destination"
  local hash size
  hash="$(sha256_of "$destination")"
  size="$(wc -c <"$destination" | tr -d ' ')"
  if [[ -z "$version" ]]; then
    case "$provider" in
      cursor-agent)
        version="$(extract_cursor_version "$destination")"
        ;;
      agy)
        version="$(extract_agy_version "$destination")"
        ;;
      *)
        fail "missing version for script provider: $provider"
        ;;
    esac
  fi
  [[ "$version" =~ ^[0-9][0-9A-Za-z.+_-]*$ ]] ||
    fail "invalid version for $provider: $version"
  log "${provider}: ${size} bytes from ${url} (version ${version})"
  printf '%s|script|%s|%s|%s|%s\n' "$provider" "$url" "$shell" "$hash" "$version"
}

resolve_npm_version() {
  local package="$1" pinned="$2" version
  if [[ -n "$pinned" ]]; then
    printf '%s\n' "$pinned"
    return 0
  fi
  version="$(npm view "$package" version 2>/dev/null | tr -d '[:space:]')" ||
    fail "could not resolve latest version: $package"
  [[ -n "$version" ]] || fail "registry returned no version for: $package"
  printf '%s\n' "$version"
}

# Hashes the tarball `npm pack` produces, then independently hashes the tarball
# the registry advertises, and requires the two to be identical. A mismatch
# means the local npm rewrote the artifact (or the registry moved underneath
# us); either way the row is not trustworthy and must not be emitted.
npm_row() {
  local provider="$1" package="$2" pinned="$3"
  local version
  version="$(resolve_npm_version "$package" "$pinned")"

  local pack_dir="${WORK_DIR}/pack-${provider}"
  mkdir -p "$pack_dir"
  local tarball_name
  tarball_name="$(npm pack --silent --pack-destination "$pack_dir" "${package}@${version}")" ||
    fail "npm pack failed: ${package}@${version}"
  tarball_name="$(printf '%s\n' "$tarball_name" | tail -n 1 | tr -d '[:space:]')"
  local packed="${pack_dir}/${tarball_name}"
  [[ -s "$packed" ]] || fail "npm pack produced no tarball: ${package}@${version}"
  local packed_hash
  packed_hash="$(sha256_of "$packed")"

  local dist_url
  dist_url="$(npm view "${package}@${version}" dist.tarball 2>/dev/null | tr -d '[:space:]')" ||
    fail "could not read dist.tarball: ${package}@${version}"
  [[ "$dist_url" == https://* ]] || fail "dist.tarball is not HTTPS: ${package}@${version}"
  local registry_copy="${WORK_DIR}/${provider}.registry.tgz"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    -o "$registry_copy" "$dist_url" ||
    fail "registry tarball download failed: $dist_url"
  local registry_hash
  registry_hash="$(sha256_of "$registry_copy")"

  [[ "$packed_hash" == "$registry_hash" ]] ||
    fail "npm pack and the registry tarball disagree for ${package}@${version}"

  log "${provider}: ${package}@${version} verified against the registry tarball"
  printf '%s|npm|%s|%s|%s|%s\n' "$provider" "$package" "$version" "$packed_hash" "$version"
}

brew_row() {
  local provider="$1" formula="$2" version="$3" url="$4"
  local source="${WORK_DIR}/${provider}.source"
  fetch_installer "$url" "$source"
  log "${provider}: ${formula}@${version} source verified"
  printf '%s|brew|%s|%s|%s|%s\n' "$provider" "$formula" "$version" "$(sha256_of "$source")" "$version"
}

emit_manifest() {
  cat <<'HEADER'
# CLI manifest for ops/macos-vm/build-golden-image.sh --cli-manifest
#
# Format: provider|kind|ref|detail|sha256|version
#   script rows: ref is the installer URL, detail is the interpreter, the hash
#                covers the downloaded installer file, and version is the pinned
#                release version. Script rows now pin the release version, not
#                just installer bytes.
#   npm rows:    ref is the package, detail is the pinned version, the hash
#                covers the `npm pack` tarball -- which is the registry's own
#                published tarball, byte for byte -- and version equals detail.
#   brew rows:   ref is the formula, detail is the pinned version, the hash
#                covers the formula source archive, and version equals detail.
#
# GENERATED BY generate-cli-manifest.sh. Do not hand-edit a hash. If the build
# fails its in-guest shasum check, the vendor changed the artifact: regenerate,
# review the diff, and commit it.
#
# The four script refs are unversioned endpoints. Their content is not pinned by
# anything except the hash on the row, and the vendor is free to change it
# without notice. The two npm refs are version-pinned and independently
# checkable against the public registry.
HEADER
  printf '\n'
  script_row claude "$CLAUDE_URL" bash "$CLAUDE_VERSION"
  script_row codex "$CODEX_URL" bash "$CODEX_VERSION"
  script_row agy "$AGY_URL" bash
  script_row cursor-agent "$CURSOR_URL" bash
  npm_row copilot "$COPILOT_PACKAGE" "$COPILOT_VERSION"
  npm_row opencode "$OPENCODE_PACKAGE" "$OPENCODE_VERSION"
  brew_row vibe "$VIBE_FORMULA" "$VIBE_VERSION" "$VIBE_SOURCE_URL"
}

main() {
  parse_args "$@"
  require_host_tools
  WORK_DIR="$(mktemp -d)"

  local rendered="${WORK_DIR}/manifest.txt"
  emit_manifest >"$rendered"

  if [[ "$OUT_PATH" == "-" ]]; then
    cat "$rendered"
  else
    mv "$rendered" "$OUT_PATH"
    log "wrote $OUT_PATH"
  fi
}

main "$@"
