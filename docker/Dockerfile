# Standing agent container image (AGENT_IMAGE, built by buildAgentImage() in
# src/switchyard/container/index.mjs). Holds the provider CLIs only —
# NO project code and NO credentials baked in at build time. Auth happens at
# runtime via a real interactive OAuth login run once by a human directly
# against the *running* container (`npm run auth`, see
# src/switchyard/auth/index.mjs) — never a build-time ARG/ENV, and never a
# BWS-injected secret (TASKS.md Task 24 replaced the earlier
# BWS-credential-injection design with this).
#
# INV-1 (INVARIANTS.md): this image is the standing agent container's base —
# no host filesystem mounts, no host credentials, no project code.
#
# Pinned to linux/amd64 regardless of build host architecture: the provider
# CLIs' Linux support is most mature on amd64, and cursor-agent has
# documented ARM64 dynamic-linker issues on some distros (missing/mismatched
# libc6:arm64 / libgcc-s1:arm64). OrbStack and Docker Desktop both run amd64
# images transparently on Apple Silicon (Rosetta / QEMU), so this costs
# emulation overhead, not correctness.
#
# The platform is the only thing pinned here. Vendor CLI *versions* are
# deliberately not — decided and closed (David, 2026-08-13). Supply-chain
# integrity is a separate question and is already settled per installer below
# (five verify — claude against a GPG-signed manifest, codex/agy/copilot/
# opencode against an installer- or registry-internal checksum — and cursor's
# gap is an accepted risk bounded by INV-1). What version pinning would add is
# build reproducibility, and in this image it costs more than it buys: a CLI's
# bundled model catalog
# is what a container falls back to when it cannot fetch the live one (see the
# agy provisioning bug in TASKS.md), so freezing versions converts "the catalog
# is stale until the next rebuild" into "stale until someone edits this file" —
# a newly released model becomes undispatchable by default rather than by
# accident. Revisit only if a floating install actually breaks a build.
FROM --platform=linux/amd64 node:22-bookworm-slim

# git: every adapter's captureDiff() shells out to `git diff` inside the
# working container. curl/ca-certificates: fetch each vendor's installer.
# bash: four of the six provider CLIs (claude, codex, agy, cursor) install
# from `curl ... | bash` scripts; copilot and opencode come from the npm
# registry instead and need none of this. gnupg: verifies the GPG-signed
# release manifest for the Claude Code CLI install below (the only one of the
# four script-installed vendors that publishes one).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        bash \
        gnupg \
    && rm -rf /var/lib/apt/lists/*

# The four script-installed vendors drop their binaries under
# $HOME/.local/bin. The build runs as root, so that's /root/.local/bin. The
# two npm-installed CLIs land in npm's global prefix instead (/usr/local/bin
# on this base image), which is already on PATH.
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
# ~/.local/bin. Invoked by cursor.mjs directly as `cursor-agent` (no wrapper
# binary — see TASKS.md Task 24).
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
#
# Conscious risk acceptance (David, 2026-07-26, Task 20; re-checked against
# all six installers 2026-08-13): every other installer verifies integrity
# (claude: GPG-signed manifest; codex/agy: vendor-internal checksum,
# source-confirmed above; copilot/opencode: npm's sha512 `dist.integrity`,
# confirmed enforced below). Cursor is still the sole unverified one — that
# claim now covers six installers, not the four it was written against — and
# no vendor-published hash exists to pin to, so the
# residual supply-chain risk is ACCEPTED rather than mitigated, bounded by
# INV-1 -- not silently deferred. Revisit if Cursor ever publishes a
# checksum/signature for this artifact.
RUN curl https://cursor.com/install -fsS | bash \
    && cursor-agent --version

# --- GitHub Copilot CLI ---------------------------------------------------
# Installed globally from the npm registry. Invoked by copilot.mjs as
# `copilot`. The published package is only a loader (`npm-loader.js`); the
# actual binary arrives as a per-platform optional dependency, which on this
# image is `@github/copilot-linux-x64` nested under the launcher (verified in
# the built image, 2026-08-13). The integrity argument below therefore has to
# hold for that second tarball too, and it does — it is an ordinary registry
# package fetched by the same client under the same rules.
#
# Integrity case (b), npm variant — the registry client verifies internally.
# Every registry tarball carries a sha512 `dist.integrity` and npm fails the
# install closed on a mismatch; confirmed 2026-08-13 by tampering with a
# lockfile's integrity value and watching the install abort
# (`npm error code EINTEGRITY ... integrity checksum failed`), i.e. a real
# check that runs before anything is extracted. Same TOFU shape as codex/agy
# though: `npm install -g` has no lockfile, so the expected hash is resolved
# from the registry packument — the same host that serves the tarball.
#
# A stronger root exists and is NOT usable here, which is worth stating so it
# isn't re-investigated: both packages carry a `dist.signatures` entry signed
# by npm's registry ECDSA key (keyid
# SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U, published independently
# of the tarball at registry.npmjs.org/-/npm/v1/keys), and `npm audit
# signatures` does verify it — but that command refuses global installs
# outright (`npm error code EAUDITGLOBAL: does not support global packages`,
# confirmed 2026-08-13 against a scratch `--prefix` tree, so this is a hard
# refusal and not a flag we're missing). No Sigstore build provenance either:
# `dist.attestations` is absent on the launcher AND on the linux-x64 package
# that carries the actual binary. That was read straight from the registry,
# not inferred from an `npm audit signatures` run — the only tree available to
# audit locally was a darwin one, in which every linux platform package is an
# unmet optional dependency, so an audit there says nothing about what this
# image installs.
#
# So these two sit exactly where codex and agy sit — a real check with a TOFU
# trust root — and not where cursor sits, which has no check at all. Revisit
# if npm ever supports `audit signatures` for global installs, or if either
# vendor starts publishing provenance.
RUN npm install -g @github/copilot \
    && copilot --help > /dev/null

# --- OpenCode CLI ---------------------------------------------------------
# Installed globally from the npm registry. Invoked by opencode.mjs as
# `opencode`.
#
# Integrity case (b), npm variant — the same argument as the Copilot CLI block
# above, verified against this package at the same time (2026-08-13): sha512
# `dist.integrity` enforced by npm, `dist.signatures` present but unverifiable
# for a global install, no `dist.attestations`. See that block for the full
# reasoning rather than a second copy that can drift from it.
#
# Same nested-platform shape as copilot, and checked the same way: this
# package declares twelve per-platform optional dependencies, of which
# `opencode-linux-x64` and `opencode-linux-x64-baseline` are the two that land
# in this image (confirmed in the built image, 2026-08-13). Registry metadata
# for `opencode-linux-x64` was read directly and matches — signed, no
# provenance — so the argument covers the tarball holding the real binary and
# not just the launcher.
RUN npm install -g opencode-ai \
    && opencode --help > /dev/null

WORKDIR /
