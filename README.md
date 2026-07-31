# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, Agy, Cursor, Copilot, Opencode) inside disposable, per-provider sandboxes. Threat model: **accident-containment, not adversary defense** — a coding agent that misbehaves (a runaway loop, a destructive command, a confused tool call) is confined to a throwaway container with no rights to the Mac host, rather than treated as a motivated attacker actively engineering an escape. The risk it exists to bound is mishap, not a targeted breakout.

**Status:** Phases 0-5 (provider dispatch engine) and the dispatch-reliability-consolidation Phases 1-5 (run store, diagnostics, labeled Docker lifecycle, Files enforcement, detached CLI, crash recovery) are implemented and test-covered; the full gate (`npm run validate` — lint + dead-code + tests) is green. **All six providers are wired end-to-end and proven live against the real agent image**: working containers are built `FROM ${AGENT_IMAGE}` (this dropped the earlier broken `FROM alpine:latest` + `--volumes-from` design, which shared no filesystem so the provider CLIs were unreachable — `TASKS.md` Task 14), so all six provider CLIs + git resolve on PATH inside them; every provider's credential *files* are provisioned container→container without touching host disk; and each of the six adapters (claude, codex, agy, cursor, copilot, opencode) has been live-verified to apply a real change captured as a `git diff` in a container (`TASKS.md` Tasks 25, 26). All six adapters perform real credential checks via `hasNonTrivialCredential()` alongside liveness checks. INV-1 is now expressed as its real contract — a working container has **no host bind mount** (the only mechanism by which a host FS path, the Docker socket, or a host credential dir could enter), verified via `docker inspect` — rather than the earlier incidental `/root/.config`-absence proxy that had constrained provisioning to claude only (`TASKS.md` Task 26). The full **queue dispatch chain** is proven live end-to-end through both the synchronous and detached paths: a 2-task capstone seeds a working container from the host repo's committed tree (`seedProject`: `git archive HEAD` → in-memory tar → `docker cp`, no bind mount), runs real agent edits, captures the diff *staged* (so newly created files are included, not silently lost as `success_no_diff`), lands both tasks on the host through the reviewed, Files-target-enforcing integration gate, commits the container baseline between tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes the container (INV-3) — with the detached path (`launch` → `status` → `result` → `recover`) additionally proven to reach a clean terminal state, release every run lease and project lock, and leave no exact-labeled Docker object behind. Dispatch a queue synchronously with **`npm run dispatch -- <tasks.md> --project <path>`**, or detached with **`node src/switchyard/dispatch/index.mjs launch <tasks.md> --project <path>`**; check auth read-only (never a login) with **`npm run auth:check`**.

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
| `src/switchyard/container/index.mjs` | Standing **agent** container lifecycle (Docker start/stop/exec). Wired into the runner's dispatch path; its image is the base every working container is built from. Also owns `getPlatformInfo()`: host-vs-image Docker architecture comparison (Node `os.arch()` naming normalized against Docker's before comparing, so an amd64 host running an amd64 image doesn't false-positive a mismatch), surfaced as `platformInfo` in the dispatch status/result envelope; documents its own Rosetta limitation. |
| `src/switchyard/lifecycle/index.mjs` | **Working** container lifecycle, wired into the runner's real dispatch path: builds each per-project container `FROM ${AGENT_IMAGE}` on a Docker-managed `/project` volume (no host bind — INV-1), provisions all six providers' credential files container→container, **seeds** the container from the host repo's committed tree so `captureDiff` has a baseline (`seedProject`), **commits** the container baseline between queued tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes at project end (INV-3). The sole surviving implementation after `sandbox/index.mjs` was deleted. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): structural diff validation (`git apply --numstat`/`--summary`, not a content blocklist), path-escape/symlink/executable-file rejection, `allowSensitiveManifests`-gated review for build/CI manifests, `git apply` via stdin. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): JSONL append of provider/model/result per task. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateModelArg`) used by all six provider adapters. |
| `src/switchyard/adapter/constants.mjs` | `PROVIDER_EXECUTION_TIMEOUT_MS` (30 minutes) — the shared host-side `execFileSync` kill timeout used by all six adapters as a default, overridable per task via `- **Timeout:**`; centralized so `runner/index.mjs` can compute an accurate `task_routed` deadline instead of drifting from a value duplicated per adapter. |
| `src/switchyard/adapter/orphan-kill.mjs` | Best-effort in-container process cleanup after a host-side `ETIMEDOUT`: `docker exec` does not forward host signals into the container's PID namespace, so each adapter calls this to kill whatever it started (`kill -TERM -1` then `kill -KILL -1`, sparing PID 1 — the container's keep-alive process) before the runner captures a diff. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, real credential check (`/root/.claude/.credentials.json`, persisted by `claude auth login`). |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch via `codex exec` (prompt over stdin), diff capture, real credential check (`/root/.codex/auth.json`, persisted by `codex login --device-auth`). |
| `src/switchyard/adapter/agy.mjs` | Antigravity (Agy) CLI adapter: dispatch (prompt via `--print` flag, not stdin — the CLI can't read it for this purpose), diff capture, real credential check (`/root/.gemini/antigravity-cli/antigravity-oauth-token`, persisted by agy's auto-triggered Google OAuth flow). |
| `src/switchyard/adapter/cursor.mjs` | Cursor Agent adapter: dispatch invokes `cursor-agent` directly, diff capture, real credential check via `cursor-agent status` text (persisted by `cursor-agent login`). |
| `src/switchyard/adapter/copilot.mjs` | Copilot CLI adapter: dispatch invokes `copilot`, diff capture, real credential check (`/root/.config/github-copilot`). |
| `src/switchyard/adapter/opencode.mjs` | Opencode CLI adapter: dispatch invokes `opencode`, diff capture, real credential check (`/root/.config/opencode`). |
| `src/switchyard/auth/index.mjs` | Walks a human through authenticating every provider that isn't already authenticated, by running each one's real interactive OAuth login inside the standing agent container. Run the walkthrough via `npm run auth`; `npm run auth:check` (`reportProviderStatus`) reports read-only per-provider status without ever attempting a login. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). Wires all six adapters; `route()` is restricted to whichever adapters are actually present. Seeds, commits between tasks, and wipes the working container it creates — owns the container-wipe logic INV-3 governs (INV-3's area map includes this module). Parses the `Files:` field per task; the integration gate rejects any diff that doesn't exactly match the declared target paths (rename/delete included). Also parses an optional `Timeout:` field overriding `PROVIDER_EXECUTION_TIMEOUT_MS` per task; on a timeout the runner captures the diff as a review artifact instead of discarding it (never through the integration gate — see "Timeout Handling"). A tasks file that parses to 0 tasks fails closed (throws with the file path, detected heading count, and expected format) rather than silently reporting a 0/0 success, and always writes an auditable checkpoint first; a run also always leaves a final checkpoint on disk even when it reaches 0 runnable tasks without entering the per-task loop. Emits a `task_routed` event/callback (`{taskId, provider, model, deadline}`) synchronously right after routing, before the blocking (up to `PROVIDER_EXECUTION_TIMEOUT_MS`-long) adapter call. Fires a new `onContainerReady` callback unconditionally right after `workingContainerName` is resolved (both the freshly-created and pre-supplied-name branches), surfacing it into the run record. `runQueue`'s `exclude` option (provider names to never route to) threads into both `executeTask`'s and `executeTaskWithOrchestrator`'s `context.route({..., exclude})` calls — see `--exclude-provider` below. |
| `src/switchyard/dispatch/index.mjs` | CLI over `runQueue` with five subcommands: `run` (synchronous, `npm run dispatch -- <tasks.md> --project <path> [--max-tasks\|--checkpoint\|--no-stop-on-failure\|--exclude-provider]`), `launch` (spawns a detached worker and returns immediately, same options), `status`/`result` (poll a run by id, read-only), and `recover` (reclaims orphaned Docker objects and stale project locks). Exits 2 on bad invocation / 1 if any task failed. `status`/`result` share a `deriveTelemetryFields(run, events, checkpointState)` helper that derives the aggregate stall-detection fields — see "Detached Dispatch and Recovery" below for the full field list. Also owns `releaseOrphanedProjectLocks()` (direct-scan recovery for parseable, dead, `projectPath`-bearing locks — see `run-store/index.mjs` below). |
| `src/switchyard/dispatch/worker-bootstrap.mjs` | The detached child process a `launch` spawns. Verifies the worker nonce and host git fingerprint match what `launch` recorded (mismatch = exit 3/4, refuses to run against a different checkout), claims the run lease, advances state to `running`, runs `runQueue` synchronously, then writes the terminal state via `updateRunWithRetry` and releases the run lease and project lock on every path — success, task failure, and crash. Its fire-and-forget event callbacks (`onTaskStart`, `onTaskRouted`, `onResult`, `onCheckpointSaved`) also go through `updateRunWithRetry` rather than a fixed-revision `updateRun`: `onTaskStart` and `onTaskRouted` fire microseconds apart (routing is synchronous, ahead of the blocking adapter call), so a fixed revision would let one silently lose the race and drop `activeTaskId` or `activeTaskProvider`/`Model`/`Deadline` from `status`. All four callbacks additionally chain onto a module-scope `writeChain` promise at fire time (not just `updateRunWithRetry`'s per-call retry), so submission-order write ordering is guaranteed even when two callbacks' internal `readRun()`s could otherwise resolve out of order — `updateRunWithRetry` alone prevents a write from being lost, not from landing out of order. `writeFatalEvent` constructs a real `Diagnostics` instance and emits the actual `Error` object (not `.message`), so secret-bearing error text is redacted before it reaches `events.jsonl`; awaits `Diagnostics.emit()` (now async) before `process.exit(1)`. Reads `run.excludeProviders` and passes it into `runQueue({ exclude })`. |
| `src/switchyard/run-store/index.mjs` | Versioned, file-backed run state under `.logs/switchyard/runs/<runId>/{run.json,events.jsonl}`. Writes are atomic (unique tmp path per write, never a fixed/shared one) and optimistic-concurrency checked (`updateRun` throws `RevisionError` on a stale `expectedRevision`); concurrent `updateRun` calls for the same run are serialized through an in-process per-runId queue, so a losing writer gets an honest error instead of silently clobbering another writer's data. `updateRunWithRetry` re-reads and retries on conflict for a caller whose write must win. `validateRun` type-checks every run-record field, including `activeTaskStartedAt`/`lastCompletionAt`/`workingContainerName`, rejecting a wrong-typed write with `SchemaError` rather than corrupting `run.json` silently. Also owns run leases (`acquireRunLock`/`releaseRunLock`/`renewRunLock`/`isRunLockExpired`), launch locks (dedup concurrent launches against the same task file), and project locks (`acquireProjectLock`/`releaseProjectLock`/`releaseProjectLockIfOwnedBy`, one active run per project — lock bodies now carry `projectPath`, not just `{runId, createdAt}`, so an orphaned lock whose run directory is gone can still be identified) plus retention (`applyRetention`). |
| `src/switchyard/dispatch/remediate-orphaned-locks.mjs` | Standalone, human-confirmed CLI for reclaiming project locks a `releaseOrphanedProjectLocks()` scan can't safely auto-reclaim (unparseable body, missing `projectPath`, or `projectPath`-known-but-run-record-gone). Not wired into `dispatch/index.mjs`'s subcommand table. Always resolves candidates fresh from disk, prints the full candidate set (hash, age, recovered `projectPath`) before touching anything, and requires explicit interactive confirmation per lock — every removal still goes through the existing ownership-checked `releaseProjectLockIfOwnedBy`. Run with `--dry-run` first, then a bare interactive run: `node src/switchyard/dispatch/remediate-orphaned-locks.mjs [--dry-run]`. |
| `src/switchyard/diagnostics/index.mjs` | Safe event/error channel for the run store's `events.jsonl`: serializes an `Error` to an allowlisted field set (`name`, `message`, `code`, `phase`, `taskId`, `provider`, `model`, `exitStatus`) and redacts any string matching the `SECRET_CANARY_` test pattern, so a diagnostic event can never leak a secret into the durable log. |
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
| `tests/container.test.mjs` | `getPlatformInfo()` host-vs-image architecture comparison: Node/Docker naming normalization (no false mismatch on an amd64 host running an amd64 image), correct mismatch on an arm64 host running an amd64 image, explicit `execFn`/timeout/args-array injection, graceful degrade (never throws) on a probe failure. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: exercises the real `createWorkingContainer` and asserts the working container has no host FS mount, no Docker socket, and no host credential paths. |
| `tests/credential-provision.test.mjs` | Exercises the real `provisionCredentials` container→container copy for all six providers with dummy non-secret sentinels: every credential file round-trips to its correct path, sibling conversation/project state does **not** bleed into the working container (cred-bleed regression), an absent source is a clean no-fabrication skip, and an unsafe container name is rejected before any docker call. |
| `tests/project-seed.test.mjs` | Exercises the real `seedProject`/`commitWorkingTree` against a live working container: the host committed tree (incl. nested and force-added-ignored files) reproduces inside `/project` with a clean single-commit baseline, a newly created file surfaces in the staged capture (finding #1), and committing between tasks isolates the next task's diff (finding #3). Identifier-validation cases always run without Docker. |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5, adapter-availability filtering, blind fallback. |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume (atomic writes), stopOnFailure/gate-failure handling, headroom-routing mechanism, seed/commit/wipe lifecycle wiring + call order, per-task commit for multi-task isolation, progress hooks (including `onTaskRouted`/`task_routed` firing before the blocking adapter call), orchestrator CLI integration, orchestrator status/result error guards, fail-closed 0-task parse (both `runQueue` and `runQueueWithOrchestrator`), and always-leaves-a-checkpoint on a 0-runnable-task completion. |
| `tests/dispatch-cli.test.mjs` | `parseDispatchArgs` unit tests (no Docker): valid invocation + defaults, `--help`, `--max-tasks`/`--checkpoint`/`--no-stop-on-failure`, and each rejection path (missing tasks/`--project`, non-file tasks, non-git project, non-positive `--max-tasks`). |
| `tests/scorer.test.mjs` | FNV-1a hash, mulberry32 PRNG, and scoring logic unit tests. |
| `tests/workspace-wipe.test.mjs` | INV-3 gate: exercises the real `wipeWorkingContainer` — the working container is wiped, the standing agent container survives. Labeled-lifecycle regressions: managed-label presence on containers/volumes, exact-name matching (substring-overlap regression), idempotent repeated wipe. |
| `tests/run-store.test.mjs` | INV-6 gate: atomic writes (unique tmp path per write, no shared-path ENOENT collisions under 40 concurrent writers), revision-checked `updateRun` (throws `RevisionError` on mismatch, serializes racing same-revision callers so exactly one wins), `updateRunWithRetry`'s authoritative write surviving a losing race, two concurrent `updateRunWithRetry` callers touching different fields both surviving (the `onTaskStart`/`onTaskRouted` race regression), run leases, launch locks, project locks (including `releaseProjectLockIfOwnedBy`'s ownership check and `projectPath` presence in newly acquired locks), `validateRun` rejecting wrong-typed telemetry fields, `releaseOrphanedProjectLocks()`'s direct-scan recovery (a live run's lock untouched, unparseable/no-`projectPath`/missing-run-record locks never auto-reclaimed), and retention. |
| `tests/worker-bootstrap-write-chain.test.mjs` | `writeChain` causal-ordering regression: interleaves two tasks' callbacks (`onTaskStart`/`onTaskRouted`/`onResult`/`onCheckpointSaved`) against a real run-store and asserts `activeTaskId` is never observed null/stale while a later task is actively running — exercises the actual race (two `updateRunWithRetry` calls whose internal `readRun()`s could resolve out of order), not just the happy path. |
| `tests/remediate-orphaned-locks.test.mjs` | `remediate-orphaned-locks.mjs` CLI regression: candidate resolution always fresh from disk, pre-`projectPath` lock shape recovered via the run record and confirmed against the lock's expected filename hash, no removal without explicit confirmation, ownership check still enforced at deletion time. |
| `tests/detached-dispatch.test.mjs` | End-to-end `launch`/`status`/`result`/`recover` CLI regression: nonce and host-fingerprint verification, terminal-state project-lock release, `recover` reclaiming stale locks from dead/terminal runs via `isWorkerLive` without touching a lock owned by a different currently-active run, the `status`/`result` envelope's `workerLive`/`activeTaskProvider`/`activeTaskModel`/`activeTaskDeadline` fields for live, ghost (dead pid), and non-running runs, and `--exclude-provider` working identically on the foreground and detached worker paths. |
| `tests/lifecycle-recovery.test.mjs` | `recoverManagedObjects` crash-matrix regression: 5 crash points (pre-claim, pre-container, post-create, mid-integration, mid-cleanup), orphaned container/volume reclamation, bounded recovery. |
| `tests/diagnostics.test.mjs` | `Diagnostics` event/error serialization: allowlisted field extraction, `SECRET_CANARY_` redaction, async `emit()` resolving once every sink has settled (a synchronously-throwing sink can't skip the rest). |

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

The host-side runner parses markdown task queues and dispatches tasks serially through the router, adapters, and integration gate. It seeds a working container from the project's committed tree, routes each task by usage headroom, runs the provider CLI headless inside the container, returns the diff to the host only through the reviewed integration gate (INV-2), commits the container baseline between tasks, and wipes the container at the end (INV-3). All six container adapters execute commands with a 30-minute default execution timeout (`PROVIDER_EXECUTION_TIMEOUT_MS`, `1,800,000` ms) and 128 MB `maxBuffer` to prevent ENOBUFS errors and premature process termination on complex tasks — overridable per task via `- **Timeout:**` (see below). On a timeout, the adapter kills the orphaned in-container process (`docker exec` does not forward host signals into the container) and the runner still captures whatever diff exists at that point as a review artifact — see "Timeout handling" below.

The thin CLI wraps `runQueue` for standalone use (the `--project` must be a git repo — its committed HEAD seeds each working container):

```bash
npm run dispatch -- tasks.md --project /path/to/repo
# options: --max-tasks <n>  --checkpoint <path>  --no-stop-on-failure
#          --exclude-provider <name>  (repeatable — never route to this provider)
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

Each task's `- **Files:**` field (comma-separated paths) is enforced at the integration gate: a diff that touches any path outside the declared allowlist — or fails to touch a declared path — is rejected, not silently accepted. A working tree is committed only on a task's success and reset on failure/rejection, so a bad diff never bleeds into the next task's baseline.

Each task's optional `- **Timeout:**` field (e.g. `90m`, `45s`, `2h` — a unit suffix is required, same as `Files:` rejecting ambiguous input) overrides `PROVIDER_EXECUTION_TIMEOUT_MS` for that task only, bounded to [1s, 24h] as a typo guard rather than a policy cap.

### Timeout Handling

A task that overruns its timeout is not silently discarded. On `ETIMEDOUT`, the adapter kills the orphaned in-container process before returning — `docker exec` does not forward host signals into the container's PID namespace, so the host-side kill alone would otherwise leave it running unsupervised — then `executeTask` still captures the container's current diff (`result: "execution_timed_out"`, `timedOut: true`). This diff is **never** passed through the integration gate (INV-2: it may be mid-edit or broken, and the gate is the only reviewed door back to the host), so it can never auto-apply as if the task had succeeded. It is persisted instead as a plain review artifact — `<checkpointPath>.partial-diffs/<taskId>.diff` locally, and copied into the run's `artifacts/` directory by the detached worker so it appears in `result`'s `artifactRefs` — for a human to review and apply manually if the work is salvageable.

The orphan-kill step (`adapter/orphan-kill.mjs`) also clears a stale `/project/.git/index.lock` left behind if the killed process was itself mid `git add`/`git commit` — empirically confirmed to otherwise make the diff-capture `git add -A` fail and silently return `null`, losing the whole partial diff via its catch-all. Safe specifically because it runs after every in-container process has already been force-killed, so nothing can still legitimately hold the lock. If the rescue attempt still recovers nothing (no edits were made before the kill, or capture failed anyway), `runQueue` emits a distinct `partial_diff_capture_failed` status event and records `partialDiffPath: null` in checkpoint.json, rather than letting a failed rescue collapse silently into the generic `task_failed`.

### Detached Dispatch and Recovery

`launch` starts a task queue in a detached child process and returns immediately with a `runId`, instead of blocking the caller for the full run (useful under a harness with a bounded command timeout). The lifecycle is `launch` → poll `status` → `result` → (if needed) `recover`:

```bash
node src/switchyard/dispatch/index.mjs launch tasks.md --project /path/to/repo [--exclude-provider <name>]
# => {"runId": "...", "state": "launcher_ready", "statusCommand": "...", "resultCommand": "..."}

node src/switchyard/dispatch/index.mjs status <run-id> --json
# => {"state": "running" | "succeeded" | "failed", "completedCount", "failedCount",
#     "workerLive" (signal-0 probe of the worker pid; null unless state is "running" —
#       distinguishes active work from a killed/ghost worker without shelling out to `docker top`),
#     "activeTaskId", "activeTaskProvider", "activeTaskModel",
#     "activeTaskDeadline" (ISO timestamp, routed-at + PROVIDER_EXECUTION_TIMEOUT_MS),
#     -- aggregate stall-detection telemetry (added 2026-07-30, see "Stall-detection telemetry" below) --
#     "queueStartedAt", "elapsedMs", "totalTaskCount", "runningCount", "pendingCount",
#     "lastCompletionAt", "elapsedSinceLastCompletionMs", "activeTaskAgeMs", "activeTaskRemainingMs",
#     "providerProcessDetected" (docker-top presence probe, null unless state is "running"),
#     "platformInfo" (host-vs-image Docker architecture comparison, always populated), ...}

node src/switchyard/dispatch/index.mjs result <run-id> --json
# => adds terminalSummary (totalTasks/runnableTasks/processedTasks/completedTaskIds/failedCount) and artifactRefs
#    (same telemetry fields as status, above)

node src/switchyard/dispatch/index.mjs recover [--run <run-id>]
# => reclaims orphaned managed containers/volumes, and project locks held by a
#    run that is already terminal or whose worker process is no longer alive
```

Before running, `launch` records the worker's launch nonce and the project's current host git fingerprint (`git rev-parse HEAD` + `git status --porcelain`) in the run; `worker-bootstrap.mjs` re-verifies both on start and refuses to run (exit 3/4) if either has changed, so a worker never executes against a checkout other than the one it was launched against. Every terminal path — success, a failed task, or a crash — releases the run's lease and its project lock (a project allows only one active run at a time), and `recover` is the backstop for anything a hard kill (`SIGKILL`, host reboot) leaves behind: it only releases a lock it can prove is unowned by a live, still-active run, so recovering a stale run can never yank the lock out from under a different run that's genuinely still in progress.

`--exclude-provider <name>` (repeatable, works identically on `run` and `launch`) keeps the router from ever selecting that provider for the rest of the run. On the detached path the flag is persisted onto the run record at `launch` time and read back by `worker-bootstrap.mjs` — the worker process only receives `--state-root`/`--run-id`/`--nonce` on its own argv, so every other run parameter (this one included) has to reach it via the run record, not a CLI flag.

#### Stall-detection telemetry

Added after a live multi-hour dispatch run produced only one completed task with no aggregate throughput signal to detect the stall from outside — a live Docker process read as "progress" when nothing was actually completing. `status`/`result` now derive (`deriveTelemetryFields`, shared by both envelope builders so they can't drift):

| Field | Meaning |
|---|---|
| `queueStartedAt` | `run.createdAt` — when the run was initialized. |
| `elapsedMs` | Wall-clock time since `queueStartedAt`. |
| `totalTaskCount` | Total tasks in the queue (`orderedTaskIds.length`). |
| `runningCount` | `1` while a task is actively routed (`activeTaskId != null`), else `0`. |
| `pendingCount` | Tasks not yet completed, derived from the same checkpoint state `runQueue` itself consults — correctly excludes tasks a prior process already finished on a resumed run, unlike a flat `orderedTaskIds.length` minus this-run's-own-event-count. |
| `lastCompletionAt` | Timestamp of the most recent successful (`task_completed`) task — never set by a `task_failed` outcome. |
| `elapsedSinceLastCompletionMs` | **The actual stall signal**: `now - (lastCompletionAt ?? queueStartedAt)`. Grows only while nothing is finishing, independent of total elapsed time — the field the motivating incident had no equivalent of. |
| `activeTaskAgeMs` | `now - activeTaskStartedAt`, `null` once `activeTaskId` clears (completion/terminal/crash) — not gated on `activeTaskStartedAt` itself, which is never cleared. |
| `activeTaskRemainingMs` | Display-only, derived from the existing per-task `activeTaskDeadline`. Not a scheduling guarantee and not a new plan-level deadline — Switchyard enforces no wall-clock plan deadline anywhere. |
| `providerProcessDetected` | Boolean `docker top` presence probe for the active provider's binary inside the working container; `null` unless `state === "running"`; never throws (5000ms timeout, catches Docker-level failure). Raw `ps` output never crosses into the envelope. |
| `platformInfo` | `{mismatch, hostArch, imageArch, note}` — host-vs-image Docker architecture comparison, always populated regardless of run state. |

`~/.agent/skills/switchyard/SKILL.md` documents interpretive guidance for these fields (e.g. when `elapsedSinceLastCompletionMs` should be treated as an actionable stall signal) for an orchestrating agent reading `status` output.

#### Lock Remediation

`acquireProjectLock` writes `projectPath` into a project lock's body (in addition to the pre-existing `{runId, createdAt}`), and `releaseOrphanedProjectLocks()` (used internally by `recover`) reconciles any *parseable* lock's `projectPath` against known run liveness, even when the run's own directory has been pruned — closing the gap where `recover`'s existing `candidateIds`-driven scan can't reach a lock whose run record no longer exists. This scan never touches an unparseable lock body or a lock missing `projectPath` (a launch lock, or a project lock predating this change) — those can't be proven dead, so they're never auto-reclaimed.

For the 6 project locks orphaned on 2026-07-27 (predating `projectPath`), a separate standalone script handles the one-time cleanup with a human in the loop:

```bash
node src/switchyard/dispatch/remediate-orphaned-locks.mjs --dry-run   # inspect the candidate set first
node src/switchyard/dispatch/remediate-orphaned-locks.mjs             # interactive, confirms before each removal
```

It recovers `projectPath` for the pre-`projectPath` lock shape from the run's own record, confirms it by recomputing the lock's expected filename hash against the file on disk, and still enforces the existing ownership-checked `releaseProjectLockIfOwnedBy` at the moment of deletion. **Not yet run against this installation's live orphaned locks** — see `TASKS.md`.

### Environment Variables

- `SWITCHYARD_ORCHESTRATOR_CMD`: Path to executable command (e.g. `switchyard-orchestrator`) for external job supervision when using `createCliOrchestrator`. If the orchestrator cannot run a task on the selected provider, the task remains incomplete and will retry against the same provider on every resume (no capability-discovery protocol exists to break the retry loop).

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment invariants are backed by gate tests that exercise the real boundary against live containers (INV-1's `no-host-rights`, INV-3's `workspace-wipe`), not by assertion alone.
