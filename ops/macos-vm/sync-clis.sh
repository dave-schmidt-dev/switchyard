#!/bin/bash
# One entry point for keeping provider CLIs in sync across the host and the
# golden VM, against the pinned manifest (ops/macos-vm/cli-manifest.txt).
#
#   sync-clis.sh --check   report host and guest versus the pins; exit 1 on drift
#   sync-clis.sh           update the host, then the guest, then re-verify both
#
# Regenerate the manifest first (generate-cli-manifest.sh) when a vendor ships a
# new release; the pins are the only place a CLI version is decided.
set -Eeuo pipefail
IFS=$'\n\t'

readonly HERE="$(cd "$(dirname "$0")" && pwd)"
readonly MANIFEST="$HERE/cli-manifest.txt"
readonly VM_NAME="${SWITCHYARD_GOLDEN_VM:-switchyard-golden-6}"

case "${1:-}" in
  --check)
    "$HERE/sync-host-clis.sh" --cli-manifest "$MANIFEST" --check
    "$HERE/update-guest-clis.sh" --vm "$VM_NAME" --cli-manifest "$MANIFEST" --check
    ;;
  "")
    "$HERE/sync-host-clis.sh" --cli-manifest "$MANIFEST"
    "$HERE/update-guest-clis.sh" --vm "$VM_NAME" --cli-manifest "$MANIFEST"
    ;;
  *)
    printf 'Usage: sync-clis.sh [--check]\n' >&2
    exit 2
    ;;
esac
