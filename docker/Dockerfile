# Standing agent container image (AGENT_IMAGE, built by buildAgentImage() in
# src/switchyard/container/index.mjs). Holds the four provider CLIs only —
# NO project code and NO credentials baked in at build time. Auth happens at
# runtime via each adapter's authenticateX(), which injects BWS-sourced
# secrets through `docker exec -e` into the *running* container — never a
# build-time ARG/ENV.
#
# INV-1 (INVARIANTS.md): this image is the standing agent container's base —
# no host filesystem mounts, no host credentials, no project code.
#
# Pinned to linux/amd64 regardless of build host architecture: all four
# vendor CLIs' Linux support is most mature on amd64, and cursor-agent has
# documented ARM64 dynamic-linker issues on some distros (missing/mismatched
# libc6:arm64 / libgcc-s1:arm64). OrbStack and Docker Desktop both run amd64
# images transparently on Apple Silicon (Rosetta / QEMU), so this costs
# emulation overhead, not correctness.
FROM --platform=linux/amd64 node:22-bookworm-slim

# git: every adapter's captureDiff() shells out to `git diff` inside the
# working container. curl/ca-certificates: fetch each vendor's installer.
# bash: all four vendor installers are `curl ... | bash` scripts. gnupg:
# verifies the GPG-signed release manifest for the Claude Code CLI install
# below (the only one of the four vendors that publishes one).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        bash \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# All four vendor installers drop their binaries under $HOME/.local/bin.
# The build runs as root, so that's /root/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"

# --- Claude Code CLI ---------------------------------------------------
# Native installer: downloads a per-platform binary, no Node dependency at
# runtime. Invoked by claude.mjs as `claude`.
# Verified against code.claude.com/docs/en/setup (2026-07-21).
#
# Integrity case (a): install.sh's own check is TOFU only -- fetched
# https://downloads.claude.ai/claude-code-releases/bootstrap.sh (2026-07-21)
# and confirmed its expected SHA256 comes from a manifest.json pulled from
# the same downloads.claude.ai host as the binary, i.e. no independent trust
# root. But Anthropic separately documents a GPG-signed manifest ("Binary
# integrity and code signing" on code.claude.com/docs/en/setup, fetched
# 2026-07-21): manifest.json + detached manifest.json.sig signed by
# security@anthropic.com, fingerprint 31DD DE24 DDFA B679 F42D 7BD2 BAA9
# 29FF 1A7E CACE. Below we fetch that signed manifest, verify the signature
# and key fingerprint, then check the just-installed linux-x64 binary's
# SHA256 against it -- closing the TOFU gap. Fails the build closed on any
# mismatch. End-to-end flow validated against the real installed binary
# (2026-07-21) before adding it here.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version \
    && cd /tmp \
    && CLAUDE_VERSION="$(claude --version | awk '{print $1}')" \
    && CLAUDE_BIN="/root/.local/share/claude/versions/${CLAUDE_VERSION}" \
    && curl -fsSL https://downloads.claude.ai/keys/claude-code.asc | gpg --import \
    && CLAUDE_KEY_FPR="$(gpg --with-colons --fingerprint security@anthropic.com | awk -F: '$1=="fpr"{print $10; exit}')" \
    && [ "$CLAUDE_KEY_FPR" = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE" ] \
    && curl -fsSLO "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/manifest.json" \
    && curl -fsSLO "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/manifest.json.sig" \
    && gpg --verify manifest.json.sig manifest.json \
    && [ "$(sha256sum "$CLAUDE_BIN" | cut -d' ' -f1)" = "$(node -e "console.log(require('/tmp/manifest.json').platforms['linux-x64'].checksum)")" ] \
    && rm -f manifest.json manifest.json.sig \
    && echo "Claude Code ${CLAUDE_VERSION}: signed manifest + checksum verified"

# --- OpenAI Codex CLI ----------------------------------------------------
# Native installer script (alternative: `npm install -g @openai/codex`).
# Invoked by codex.mjs as `codex exec`.
# Verified against github.com/openai/codex README (2026-07-21).
#
# Integrity case (b): install.sh already verifies internally -- fetched the
# release install.sh (github.com/openai/codex/releases/latest/download/
# install.sh, redirects to a release-assets.githubusercontent.com asset,
# 2026-07-21) and read its source: it downloads a `codex-package_SHA256SUMS`
# asset, resolves the expected digest via the GitHub Releases API
# (api.github.com/repos/openai/codex/releases/tags/...), computes the
# downloaded archive's own SHA256, and exits non-zero on mismatch before
# extracting anything. No independent GPG signature, but the check is real
# and runs before use -- no further verification added.
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh \
    && codex --version

# --- Antigravity CLI (agy, formerly Gemini CLI) --------------------------
# Single compiled Go binary, no separate runtime. Invoked by agy.mjs as
# `agy --new-project --mode accept-edits ... --print <prompt>`.
# Verified against antigravity.google/docs/cli/install (2026-07-21).
#
# Integrity case (b): install.sh already verifies internally -- fetched
# https://antigravity.google/cli/install.sh (2026-07-21) and read its
# source: it fetches a JSON manifest over HTTPS from
# antigravity-cli-auto-updater-974169037036.us-central1.run.app containing
# a per-platform sha512, computes the downloaded payload's own SHA512
# (shasum -a 512 / sha512sum), and hard-exits ("Security Halt: ...") on
# mismatch before running the binary's install step -- this is what prints
# the "checksum verified" line in the build log. Caveat: the expected hash
# is TOFU from that same manifest host (not GPG-signed), and that host is a
# separate Cloud Run subdomain from antigravity.google, but the vendor's
# docs (antigravity.google/docs/cli/install) offer nothing stronger to pin
# to independently, so no further verification added.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && agy --version

# --- Cursor Agent CLI -----------------------------------------------------
# Official installer creates both `agent` and `cursor-agent` symlinks under
# ~/.local/bin. Invoked by cursor.mjs as `cursor-agent` (wrapped at runtime
# by the adapter's own `cursor-agent-authed` script).
# Verified against cursor.com/docs/cli/installation (2026-07-21).
#
# Accepted risk (neither a nor b): fetched the installer itself
# (https://cursor.com/install, 2026-07-21) and read its source -- it's a
# bare `curl ... | tar --strip-components=1 -xzf -` with no checksum,
# signature, or integrity check of any kind. Checked
# cursor.com/docs/cli/installation plus a web search for a published
# checksum/signature Cursor exposes for this artifact; found none. No
# reasonable verification path exists today. Accepted given INV-1 (no host
# rights at build time) -- a compromised installer here compromises only
# the disposable build environment.
RUN curl https://cursor.com/install -fsS | bash \
    && cursor-agent --version

WORKDIR /
