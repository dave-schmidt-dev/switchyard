#!/bin/bash
# Install the Mistral API key into the standing agent container's OpenCode
# credential store, sourced from BWS.
#
#   bws-secret-exec switchyard-opencode-mistral --
#
# Pinned executable for the `switchyard-opencode-mistral` broker consumer
# (~/Documents/Projects/bws/bws-secret-exec.py). The broker resolves
# MISTRAL_API_KEY from BWS and `execve`s this script with that single variable
# in its environment; it receives no BWS_ACCESS_TOKEN, no BWS_PROJECT_ID, and
# no other project secret. Editing this file changes its SHA-256 and the broker
# then refuses to run it until the pin is updated — that is the point, so do not
# work around it.
#
# WHY THIS EXISTS
#
# `npm run auth` walks a human through a real interactive login for every
# provider whose credential is an OAuth session. Mistral is not one of those:
# OpenCode stores it as a bare API key, so the "interactive login" degenerates
# into pasting a secret at a terminal. That paste is the thing David's hard
# rules forbid, and it is also what left the container holding a stale key while
# the host held a working one (2026-08-13: `vibe` routed for the first time and
# then died on `Unauthorized: {"detail":"Invalid API Key"}`, with the identical
# call succeeding on the host).
#
# SCOPE, AND HOW IT RELATES TO THE REJECTED BUILD-TIME DESIGN
#
# docker/Dockerfile states the image carries NO credentials and that auth happens
# at runtime against the *running* container — "never a build-time ARG/ENV, and
# never a BWS-injected secret". That rejection is about baking a secret into an
# image layer, where it would persist in a distributable artifact and outlive any
# session. This script does not do that. It writes to the same runtime store
# `npm run auth` writes to, in the same standing container, at the same point in
# the lifecycle — only the source of the value differs (BWS instead of a human
# paste). The image is untouched. If that distinction is ever judged too fine,
# the fix is to delete this consumer, not to widen it.
#
# README.md:488 still governs what happens downstream: a provider credential
# inside an execution environment is treated as already compromised, which is why
# the working container that receives a copy of this key is disposable.
#
# HANDLING
#
# The value is never echoed, never interpolated into a command line, and never
# written to a host path. It reaches the container on stdin — not `docker exec -e`,
# which would place it in the exec's environment where a later `docker inspect`
# could surface it, and not argv, which is world-readable via `ps` for the life of
# the call. Failure messages name the step, never the value.

set -euo pipefail

: "${MISTRAL_API_KEY:?not set; run via bws-secret-exec switchyard-opencode-mistral}"

CONTAINER="${SWITCHYARD_AGENT_CONTAINER:-switchyard-agent}"
AUTH_PATH="/root/.local/share/opencode/auth.json"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  echo "set-opencode-mistral-key: container '$CONTAINER' is not running" >&2
  exit 1
fi

# Merge rather than replace: the same file holds github-copilot, opencode and
# opencode-go credentials, and rewriting it wholesale would silently de-authorize
# three other providers to fix one. Written via a temp file + rename so an
# interrupted write cannot leave a truncated auth.json behind, and chmod'd
# explicitly because writeFileSync's mode argument only applies when it creates
# the file.
printf '%s' "$MISTRAL_API_KEY" | docker exec -i "$CONTAINER" node -e '
const fs = require("fs");
const path = process.argv[1];
let key = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { key += chunk; });
process.stdin.on("end", () => {
  key = key.trim();
  if (!key) { console.error("empty key on stdin"); process.exit(1); }
  let store = {};
  if (fs.existsSync(path)) store = JSON.parse(fs.readFileSync(path, "utf8"));
  const before = store.mistral && store.mistral.key;
  store.mistral = { type: "api", key };
  const tmp = path + ".tmp";
  fs.mkdirSync(require("path").dirname(path), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, path);
  console.log(before === key ? "mistral key unchanged" : "mistral key written");
});
' "$AUTH_PATH"

# Liveness, not presence. A credential file that exists satisfies
# `npm run auth:check` — only a real call says whether the key still works, which
# is exactly the distinction that hid this failure until a canary dispatched.
echo "set-opencode-mistral-key: verifying with a live call..." >&2
verify_status=0
verify_output=$(docker exec "$CONTAINER" sh -c \
  'cd /tmp && opencode run --variant high --model mistral/mistral-medium-latest "reply with the single word OK" 2>&1') \
  || verify_status=$?

# Redact before anything is printed. This is the only place the script emits text
# it did not author, and a provider diagnostic that echoed the credential back
# would otherwise land in a terminal or a log. Bash parameter expansion, not sed,
# so the value never becomes another process's argv.
verify_output=${verify_output//"$MISTRAL_API_KEY"/[redacted]}

if printf '%s' "$verify_output" | grep -qi "unauthorized\|invalid api key"; then
  echo "set-opencode-mistral-key: key was installed but Mistral rejected it" >&2
  exit 1
fi

# Positive assertion, not merely the absence of the one error string I thought of.
# A network failure, an opencode crash, a retired model, or an empty reply all
# leave that grep unmatched, so checking only for rejection would print "verified"
# for a call that never reached Mistral — the same presence-for-liveness
# substitution this whole script exists to stop making one layer up.
if [ "$verify_status" -ne 0 ] \
  || ! printf '%s' "$verify_output" | grep -qE '(^|[^A-Za-z])[Oo][Kk]([^A-Za-z]|$)'; then
  echo "set-opencode-mistral-key: key installed, but the live call did not confirm it (exit ${verify_status})" >&2
  echo "--- opencode output (key redacted) ---" >&2
  printf '%s\n' "$verify_output" >&2
  exit 1
fi
echo "set-opencode-mistral-key: verified" >&2
