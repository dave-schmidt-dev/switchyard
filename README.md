# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, Agy, Cursor, Copilot, Opencode) inside disposable, per-provider sandboxes. Threat model: **accident-containment, not adversary defense** — a coding agent that misbehaves (a runaway loop, a destructive command, a confused tool call) is confined to a throwaway container with no rights to the Mac host, rather than treated as a motivated attacker actively engineering an escape. The risk it exists to bound is mishap, not a targeted breakout.

**Status:** Phases 0-5 implemented and test-covered; the full gate (`npm run validate` — lint + dead-code + tests) is green. **All six providers are wired end-to-end and proven live against the real agent image**: working containers are built `FROM ${AGENT_IMAGE}` (this dropped the earlier broken `FROM alpine:latest` + `--volumes-from` design, which shared no filesystem so the provider CLIs were unreachable — `TASKS.md` Task 14), so all six provider CLIs + git resolve on PATH inside them; every provider's credential *files* are provisioned container→container without touching host disk; and each of the six adapters (claude, codex, agy, cursor, copilot, opencode) has been live-verified to apply a real change captured as a `git diff` in a container (`TASKS.md` Tasks 25, 26). All six adapters perform real credential checks via `hasNonTrivialCredential()` alongside liveness checks. INV-1 is now expressed as its real contract — a working container has **no host bind mount** (the only mechanism by which a host FS path, the Docker socket, or a host credential dir could enter), verified via `docker inspect` — rather than the earlier incidental `/root/.config`-absence proxy that had constrained provisioning to claude only (`TASKS.md` Task 26). The full **queue dispatch chain** is now proven live end-to-end: a 2-task capstone seeds a working container from the host repo's committed tree (`seedProject`: `git archive HEAD` → in-memory tar → `docker cp`, no bind mount), runs real agent edits, captures the diff *staged* (so newly created files are included, not silently lost as `success_no_diff`), lands both tasks on the host through the reviewed integration gate, commits the container baseline between tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes the container (INV-3). Dispatch a queue with **`npm run dispatch -- <tasks.md> --project <path>`**; check auth read-only (never a login) with **`npm run auth:check`**.

## Priorities (in order)

1. **Containment & isolation (security).** The sandbox boundary *is* the product. A misbehaving in-container workload must never reach the macOS host, the LAN, cloud metadata, the Docker socket, or another provider's environment.
2. **Correctness of the trust-boundary data plane.** Sanitized allowlist export, quarantined normalized import, and a complete provenance record for every task — the host must never open un-normalized hostile output.
3. **Provable containment.** The boundary is *proven*, not assumed: the INV-1 gate (`tests/no-host-rights.test.mjs`) asserts that neither the standing agent container nor the working container can reach the host filesystem, the Docker socket, or host credentials — containment against a misbehaving agent, verified, not a claim to withstand a targeted attacker.
4. **Observability & auditability.** Every task records which repository snapshot, base image, provider-credential identity, patch, and validation result belonged to it.

## Layout

| Path | Purpose |
|---|---|
| `README.md` | This file. |
| `INVARIANTS.md` | System-contract charter (closed-loop). Committed. |
| `HISTORY.md` | Meaningful changes, bugs, remediation, regression notes. (local, gitignored) |
| `TASKS.md` | Per-project task tracking. (local, gitignored) |
| `LICENSE` | MIT. |
| `package.json` | Node.js/ESM project config, biome + knip devDependencies. |
| `biome.json` | Biome linter/formatter config. |
| `knip.json` | Dead code / unused dependency detection. |
| `docker/Dockerfile` | Agent image build context: installs all six provider CLIs + git onto a pinned base, built to `switchyard-agent:latest` (the image every working container is derived from). |
| **Source modules** | |
| `src/switchyard/router/index.mjs` | Provider selection: snapshot-backed spread routing, blind fallback, INV-4 compliance. |
| `src/switchyard/router/scorer.mjs` | Capacity scoring: FNV-1a hash, mulberry32 PRNG, deterministic jitter. |
| `src/switchyard/roster/index.mjs` | Provider capability definitions and INV-5 capability filter. |
| `src/switchyard/roster/classifier.mjs` | Keyword-based task-tier classifier (high/standard/low). |
| `src/switchyard/container/index.mjs` | Standing **agent** container lifecycle (Docker start/stop/exec). Wired into the runner's dispatch path; its image is the base every working container is built from. |
| `src/switchyard/lifecycle/index.mjs` | **Working** container lifecycle, wired into the runner's real dispatch path: builds each per-project container `FROM ${AGENT_IMAGE}` on a Docker-managed `/project` volume (no host bind — INV-1), provisions all six providers' credential files container→container, **seeds** the container from the host repo's committed tree so `captureDiff` has a baseline (`seedProject`), **commits** the container baseline between queued tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes at project end (INV-3). The sole surviving implementation after `sandbox/index.mjs` was deleted. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): structural diff validation (`git apply --numstat`/`--summary`, not a content blocklist), path-escape/symlink/executable-file rejection, `allowSensitiveManifests`-gated review for build/CI manifests, `git apply` via stdin. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): JSONL append of provider/model/result per task. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateModelArg`) used by all six provider adapters. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, real credential check (`/root/.claude/.credentials.json`, persisted by `claude auth login`). |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch via `codex exec` (prompt over stdin), diff capture, real credential check (`/root/.codex/auth.json`, persisted by `codex login --device-auth`). |
| `src/switchyard/adapter/agy.mjs` | Antigravity (Agy) CLI adapter: dispatch (prompt via `--print` flag, not stdin — the CLI can't read it for this purpose), diff capture, real credential check (`/root/.gemini/antigravity-cli/antigravity-oauth-token`, persisted by agy's auto-triggered Google OAuth flow). |
| `src/switchyard/adapter/cursor.mjs` | Cursor Agent adapter: dispatch invokes `cursor-agent` directly, diff capture, real credential check via `cursor-agent status` text (persisted by `cursor-agent login`). |
| `src/switchyard/adapter/copilot.mjs` | Copilot CLI adapter: dispatch invokes `copilot`, diff capture, real credential check (`/root/.config/github-copilot`). |
| `src/switchyard/adapter/opencode.mjs` | Opencode CLI adapter: dispatch invokes `opencode`, diff capture, real credential check (`/root/.config/opencode`). |
| `src/switchyard/auth/index.mjs` | Walks a human through authenticating every provider that isn't already authenticated, by running each one's real interactive OAuth login inside the standing agent container. Run the walkthrough via `npm run auth`; `npm run auth:check` (`reportProviderStatus`) reports read-only per-provider status without ever attempting a login. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). Wires all six adapters; `route()` is restricted to whichever adapters are actually present. Seeds, commits between tasks, and wipes the working container it creates. |
| `src/switchyard/dispatch/index.mjs` | Thin `parseArgs` CLI over `runQueue` (`npm run dispatch -- <tasks.md> --project <path> [--max-tasks|--checkpoint|--no-stop-on-failure]`): validates args, prints per-task progress (INV-1: no silent waits), exits 2 on bad invocation / 1 if any task failed. |
| **Tests** | |
| `tests/capability-match.test.mjs` | INV-5 gate: capability filter, tier ordering, model right-sizing. |
| `tests/classifier.test.mjs` | Keyword-based task tier classifier unit tests. |
| `tests/claude-adapter.test.mjs` | Container-backed Claude CLI dispatch and diff capture tests. |
| `tests/claude-auth.test.mjs` | Shell-injection guard, prompt-injection regression, real-container credential-validity check. |
| `tests/codex-adapter.test.mjs` | Container-backed Codex CLI dispatch and diff capture tests. |
| `tests/codex-auth.test.mjs` | Shell-injection guard, prompt-injection regression, real-container credential-validity check, `codex exec` subcommand-shape check. |
| `tests/agy-adapter.test.mjs` | Container-backed Agy CLI dispatch and diff capture tests. |
| `tests/agy-auth.test.mjs` | Same regression shape as codex-auth, adapted for agy's `--print`-flag prompt delivery and display-name model strings. |
| `tests/cursor-adapter.test.mjs` | Container-backed Cursor Agent dispatch and diff capture tests. |
| `tests/cursor-auth.test.mjs` | Same regression shape, plus real-container checks of `isCursorAuthenticated()`'s `cursor-agent status --format json` `isAuthenticated`-boolean signal (positive, negative, missing-binary, and malformed/empty-output fail-closed cases). |
| `tests/copilot-adapter.test.mjs` | Container-backed Copilot CLI dispatch and diff capture tests. |
| `tests/copilot-auth.test.mjs` | Shell-injection guard and credential-validity check for Copilot CLI. |
| `tests/opencode-adapter.test.mjs` | Container-backed Opencode CLI dispatch and diff capture tests. |
| `tests/opencode-auth.test.mjs` | Shell-injection guard and credential-validity check for Opencode CLI. |
| `tests/auth-check.test.mjs` | `ensureProvidersAuthenticated` + `reportProviderStatus` (the read-only `auth:check`) unit tests via injected fake providers (no real Docker needed), including regressions for a provider's `runLogin()`/`isAuthenticated()` throwing without aborting the rest, and that the read-only report never triggers a login. |
| `tests/shell-safety.test.mjs` | Unit tests for the shared `validateIdentifier`/`validateModelArg` shell-interpolation guards used by all six adapters. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: exercises the real `createWorkingContainer` and asserts the working container has no host FS mount, no Docker socket, and no host credential paths. |
| `tests/credential-provision.test.mjs` | Exercises the real `provisionCredentials` container→container copy for all six providers with dummy non-secret sentinels: every credential file round-trips to its correct path, sibling conversation/project state does **not** bleed into the working container (cred-bleed regression), an absent source is a clean no-fabrication skip, and an unsafe container name is rejected before any docker call. |
| `tests/project-seed.test.mjs` | Exercises the real `seedProject`/`commitWorkingTree` against a live working container: the host committed tree (incl. nested and force-added-ignored files) reproduces inside `/project` with a clean single-commit baseline, a newly created file surfaces in the staged capture (finding #1), and committing between tasks isolates the next task's diff (finding #3). Identifier-validation cases always run without Docker. |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5, adapter-availability filtering, blind fallback. |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume (atomic writes), stopOnFailure/gate-failure handling, headroom-routing mechanism, seed/commit/wipe lifecycle wiring + call order, per-task commit for multi-task isolation, progress hooks, orchestrator CLI integration, and orchestrator status/result error guards. |
| `tests/dispatch-cli.test.mjs` | `parseDispatchArgs` unit tests (no Docker): valid invocation + defaults, `--help`, `--max-tasks`/`--checkpoint`/`--no-stop-on-failure`, and each rejection path (missing tasks/`--project`, non-file tasks, non-git project, non-positive `--max-tasks`). |
| `tests/scorer.test.mjs` | FNV-1a hash, mulberry32 PRNG, and scoring logic unit tests. |
| `tests/workspace-wipe.test.mjs` | INV-3 gate: exercises the real `wipeWorkingContainer` — the working container is wiped, the standing agent container survives. |

## Planning artifacts

- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20.md` — impulse-tier implementation plan (active: 18 tasks, 8 phases).
- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20-tasks.md` — task board for the implementation engine.
- Supersedes the abandoned `switchyard-containment-architecture-2026-07-20` (adversary-defense) draft.

## Workflows

### Running Tests and Linting

**Prerequisite — Docker daemon (OrbStack).** The container-backed tests (adapter dispatch, and the INV-1 `no-host-rights` / INV-3 `workspace-wipe` gates) shell out to real `docker run`/`docker exec`, so the daemon must be up or those tests fail with `Command failed: docker run ...`. This project uses **OrbStack** as the Docker runtime (plan decision D-2). If it isn't running, start it before running the suite:

```bash
open -a OrbStack   # start OrbStack if the daemon isn't already up
until docker info >/dev/null 2>&1; do sleep 1; done   # wait for readiness
```

The pure-logic tests (router, roster, classifier, ledger, integration-gate, shell-safety) run without Docker; only the container-backed ones require it.

Execute the full suite of node unit and integration gate tests:

```bash
npm test
```

Run code quality check with Biome:

```bash
npm run lint
```

### Provider Authentication

There is no headless auto-login: every provider's real login step requires a human to complete a browser or device-code OAuth consent. `npm run auth` checks each provider's real credential state and, for any that aren't authenticated, opens its real interactive login inside the standing agent container so you can complete it live:

```bash
npm run auth
```

For each unauthenticated provider it runs (attached to your terminal, so follow the prompts — visit a URL, paste a code, approve in a browser):

| Provider | Real login command |
|---|---|
| claude | `claude auth login` (subscription auth, not `--console`/API billing) |
| codex | `codex login --device-auth` (device-code flow, no local browser needed) |
| agy | no explicit subcommand — running it unauthenticated auto-triggers a Google OAuth flow |
| cursor | `NO_OPEN_BROWSER=1 cursor-agent login` |
| copilot | `copilot auth login` |
| opencode | `opencode auth login` |

A completed login persists to the provider CLI's own credential store inside the standing agent container (which is never wiped, unlike working containers — INV-3), so it holds across many tasks — you do not re-authenticate per dispatch. Exits non-zero if any provider is still unauthenticated when it finishes.

**Caveat: provider OAuth sessions expire (on the order of days), so re-auth is periodic, not truly one-time.** `npm run auth` checks each credential's *presence and substance* (the file exists and isn't a trivial stub), **not** its *liveness* against the provider's API — a real validity check would need an unreliable in-container network round-trip. So an expired-but-still-present token reads as authenticated and `npm run auth` will **skip** re-login for it. When a session has actually expired, force a fresh login directly against the standing agent container — e.g. `docker exec -it switchyard-agent claude auth login` — from a **real terminal** (an interactive `-it` exec needs a TTY, which a non-interactive/piped shell can't allocate).

Working containers (where real dispatches actually run) are built `FROM ${AGENT_IMAGE}`, so they carry the agent container's provider binaries directly (`TASKS.md` Task 14, done). Credentials are provisioned as a separate container→container step: every provider's credential *files* (files only, not whole directories — so no conversation/project state bleeds into a disposable container) are copied into each working container, so a real end-to-end dispatch works today for **all six** providers, each live-verified to apply a `git diff` in a container (`TASKS.md` Tasks 25, 26).

### Queue Dispatching and Orchestration

The host-side runner parses markdown task queues and dispatches tasks serially through the router, adapters, and integration gate. It seeds a working container from the project's committed tree, routes each task by usage headroom, runs the provider CLI headless inside the container, returns the diff to the host only through the reviewed integration gate (INV-2), commits the container baseline between tasks, and wipes the container at the end (INV-3). All six container adapters execute commands with a 30-minute execution timeout (`1,800,000` ms) and 128 MB `maxBuffer` to prevent ENOBUFS errors and premature process termination on complex tasks.

The thin CLI wraps `runQueue` for standalone use (the `--project` must be a git repo — its committed HEAD seeds each working container):

```bash
npm run dispatch -- tasks.md --project /path/to/repo
# options: --max-tasks <n>  --checkpoint <path>  --no-stop-on-failure
```

Or call it programmatically:

```javascript
import { runQueue, runQueueWithOrchestrator } from './src/switchyard/runner/index.mjs';

// Standard queue runner with local checkpoint/resume (synchronous).
// Without `dependencies`, this uses the real router + live Docker adapters —
// the working container must already exist and have an agent CLI inside it.
// In tests, inject `dependencies` to stub route, adapters, and integrationGate.
const summary = runQueue({
  tasksFilePath: '/path/to/tasks.md',
  projectPath: '/path/to/project',
  workingContainerName: 'switchyard-work-1',
  checkpointPath: '.switchyard-checkpoint.json', // optional
});

// Headless orchestrator mode — async; requires SWITCHYARD_ORCHESTRATOR_CMD to
// be set, or throws immediately. Pass `dependencies.orchestrator` in tests.
// export SWITCHYARD_ORCHESTRATOR_CMD=/path/to/orchestrator
const orchSummary = await runQueueWithOrchestrator({
  tasksFilePath: '/path/to/tasks.md',
  projectPath: '/path/to/project',
  workingContainerName: 'switchyard-work-1',
});
```

### Environment Variables

- `SWITCHYARD_ORCHESTRATOR_CMD`: Path to executable command (e.g. `switchyard-orchestrator`) for external job supervision when using `createCliOrchestrator`. If the orchestrator cannot run a task on the selected provider, the task remains incomplete and will retry against the same provider on every resume (no capability-discovery protocol exists to break the retry loop).

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment invariants are backed by gate tests that exercise the real boundary against live containers (INV-1's `no-host-rights`, INV-3's `workspace-wipe`), not by assertion alone.
