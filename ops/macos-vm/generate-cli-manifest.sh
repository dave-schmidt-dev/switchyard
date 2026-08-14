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

# Sources of record: docker/Dockerfile installs these same six CLIs from these
# same refs. A change there is a change here.
readonly CLAUDE_URL="https://claude.ai/install.sh"
readonly CODEX_URL="https://chatgpt.com/codex/install.sh"
readonly AGY_URL="https://antigravity.google/cli/install.sh"
readonly CURSOR_URL="https://cursor.com/install"
readonly COPILOT_PACKAGE="@github/copilot"
readonly OPENCODE_PACKAGE="opencode-ai"

OUT_PATH="${SCRIPT_DIR}/cli-manifest.txt"
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
Usage: generate-cli-manifest.sh [--out PATH]
                                [--copilot-version VERSION]
                                [--opencode-version VERSION]

Writes the six-row CLI manifest. npm versions default to whatever the registry
currently publishes as `latest`; pin them explicitly to reproduce an older
manifest. Use --out - to write to stdout instead of a file.
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
}

require_host_tools() {
  local tool
  for tool in curl npm shasum; do
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

script_row() {
  local provider="$1" url="$2" shell="$3"
  local destination="${WORK_DIR}/${provider}.installer"
  fetch_installer "$url" "$destination"
  local hash size
  hash="$(sha256_of "$destination")"
  size="$(wc -c <"$destination" | tr -d ' ')"
  log "${provider}: ${size} bytes from ${url}"
  printf '%s|script|%s|%s|%s\n' "$provider" "$url" "$shell" "$hash"
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
  printf '%s|npm|%s|%s|%s\n' "$provider" "$package" "$version" "$packed_hash"
}

emit_manifest() {
  cat <<'HEADER'
# CLI manifest for ops/macos-vm/build-golden-image.sh --cli-manifest
#
# Format: provider|kind|ref|detail|sha256
#   script rows: ref is the installer URL, detail is the interpreter, and the
#                hash covers the downloaded installer file.
#   npm rows:    ref is the package, detail is the pinned version, and the hash
#                covers the `npm pack` tarball -- which is the registry's own
#                published tarball, byte for byte.
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
  script_row claude "$CLAUDE_URL" bash
  script_row codex "$CODEX_URL" bash
  script_row agy "$AGY_URL" bash
  script_row cursor-agent "$CURSOR_URL" bash
  npm_row copilot "$COPILOT_PACKAGE" "$COPILOT_VERSION"
  npm_row opencode "$OPENCODE_PACKAGE" "$OPENCODE_VERSION"
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
