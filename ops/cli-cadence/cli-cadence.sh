#!/bin/bash
# launchd entry point for the provider-CLI cadence. launchd starts jobs with a
# minimal PATH, so this sets the one the cadence's tools live on (Homebrew,
# uv/pipx under ~/.local/bin, npm globals) and runs the repo's own script.
#
# The repo path is rendered in by install-cli-cadence.sh. A launchd agent
# reading under ~/Documents needs Full Disk Access (macOS TCC); see
# ops/cli-cadence/README.md.
set -Eeuo pipefail

readonly REPO="${SWITCHYARD_REPO:-__SWITCHYARD_REPO__}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$REPO"
exec node ops/cli-cadence/cli-cadence.mjs --mode "${SWITCHYARD_CLI_CADENCE_MODE:-promote}" "$@"
