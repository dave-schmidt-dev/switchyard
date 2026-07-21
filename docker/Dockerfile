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
# bash: all four vendor installers are `curl ... | bash` scripts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        bash \
    && rm -rf /var/lib/apt/lists/*

# All four vendor installers drop their binaries under $HOME/.local/bin.
# The build runs as root, so that's /root/.local/bin.
ENV PATH="/root/.local/bin:${PATH}"

# --- Claude Code CLI ---------------------------------------------------
# Native installer: downloads a per-platform binary, no Node dependency at
# runtime. Invoked by claude.mjs as `claude`.
# Verified against code.claude.com/docs/en/setup (2026-07-21).
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version

# --- OpenAI Codex CLI ----------------------------------------------------
# Native installer script (alternative: `npm install -g @openai/codex`).
# Invoked by codex.mjs as `codex exec`.
# Verified against github.com/openai/codex README (2026-07-21).
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh \
    && codex --version

# --- Antigravity CLI (agy, formerly Gemini CLI) --------------------------
# Single compiled Go binary, no separate runtime. Invoked by agy.mjs as
# `agy --new-project --mode accept-edits ... --print <prompt>`.
# Verified against antigravity.google/docs/cli/install (2026-07-21).
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && agy --version

# --- Cursor Agent CLI -----------------------------------------------------
# Official installer creates both `agent` and `cursor-agent` symlinks under
# ~/.local/bin. Invoked by cursor.mjs as `cursor-agent` (wrapped at runtime
# by the adapter's own `cursor-agent-authed` script).
# Verified against cursor.com/docs/cli/installation (2026-07-21).
RUN curl https://cursor.com/install -fsS | bash \
    && cursor-agent --version

WORKDIR /
