# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, Agy, Cursor, Copilot, Opencode) inside disposable working VMs. Threat model: **accident-containment, not adversary defense** — a coding agent that misbehaves (a runaway loop, a destructive command, a confused tool call) is confined to a throwaway VM with no rights to the Mac host, rather than treated as a motivated attacker actively engineering an escape. The risk it exists to bound is mishap, not a targeted breakout.

**Status:** Phases 0-5 (provider dispatch engine) and the dispatch-reliability-consolidation Phases 1-5 (run store, diagnostics, VM workspace lifecycle, Files enforcement, detached CLI, crash recovery) are implemented and test-covered; the full gate (`npm run validate` — lint + dead-code + tests) is green. **macOS/Parallels is the sole execution backend** (`ParallelsExecutionBackend`) — the earlier Docker lane was fully removed 2026-08-19 (`HISTORY.md`). All seven adapters (claude, codex, agy, cursor, copilot, opencode, vibe) dispatch through it: a working VM is cloned from the golden image, seeded from the host repo's committed tree over the tar-transport seam (`seedProjectWithBackend`: `git archive HEAD` → in-memory tar → `pushTar`, no host bind mount), and the adapter runs inside it. Provider auth is **baked into the golden image** rather than provisioned at task time — a provider logs in once, in-guest, as the non-admin `switchyard` account, and that credential state survives cloning where proven. Current queue admission is `codex`, OpenCode Go, and Vibe: Codex uses clone-surviving OAuth, OpenCode Go uses a fixed one-dispatch BWS API-key bridge, and Vibe reads a `MISTRAL_API_KEY` baked into the golden image's guest keychain (`ai.mistral.vibe`), which survives cloning. Vibe/mistral-medium-3.5 was qualified at `standard` on 2026-09-01 (see below); the lane was previously labelled GLM-5.2, which the Vibe account is not entitled to. Additional providers require their own qualification. INV-1 is expressed as its real contract: a working VM has **no host filesystem mount and no host credentials** — Parallels host-guest sharing is explicitly disabled for every managed VM, asserted by `tests/no-host-rights-vm.test.mjs`. The **queue dispatch chain** (seed → route → adapter dispatch → integration gate → per-task commit/reset → VM wipe at project end, INV-3) is exercised end-to-end through both the synchronous and detached paths, with the detached path (`launch` → `status` → `result` → `recover`) additionally proven to reach a clean terminal state, release every run lease and project lock, and leave no VM behind matching the reserved `switchyard-work-<runId>-<creatorPid>` namespace. Dispatch a queue synchronously with **`npm run dispatch -- <tasks.md> --project <path>`**, or detached with **`node src/switchyard/dispatch/index.mjs launch <tasks.md> --project <path>`**; check auth read-only (never a login) with **`npm run auth:check`**, or **`npm run auth:check:live`** to probe each probeable provider (probeability is decided by `authMode`, not by OAuth: only the BWS API-key lane is unprobed, and keychain-backed Vibe is probed); qualify clone survival with **`node src/switchyard/auth/index.mjs --clone`** (optionally with **`--receipt <path>`** to persist a sanitized qualification receipt) to verify that credentials survive cloning in a disposable managed clone before queue admission; the OpenCode Go BWS lane remains intentionally unprobed by these auth commands.

The Vibe lane is qualified as of 2026-09-01, at `mistral-medium-3.5` rather than the GLM-5.2 label it carried until then. The 2026-08-31 canary that failed at provider execution had been dispatched against a GLM selector the Vibe account is not entitled to; every GLM spelling silently resolved to `mistral-medium-3.5` at the provider, so the label never described what ran — and that attempt therefore exercised the same underlying route the 2026-09-01 canary later qualified.

Projects may opt into VM-only lifecycle hooks with a committed `switchyard.hooks.json`. Each phase (`after_create`, `before_run`, `after_run`, `before_remove`) is an argv array, never shell text; failures are fatal unless explicitly `"on_failure": "ignore"`. `after_create` rejects any tracked or unignored artifact it leaves behind, so dependency caches must be gitignored. Example: `{ "timeout_ms": 300000, "after_create": { "argv": ["npm", "ci"] }, "after_run": { "argv": ["npm", "test"] } }`.

**Current macOS admission:** `codex`, OpenCode Go, and Vibe are qualified. Vibe holds a `standard` `dispatch_qualified` receipt for `mistral-medium-3.5` (`sha256:0ab7279a…`) from the 2026-09-01 dispatch canary, which routed `Vibe/mistral-medium-3.5` and wrote its marker file. The earlier GLM-5.2 label was never entitled on this account and is retired. The 2026-08-31 failure at provider execution (`exitCode` 255, output unclassifiable, no file written) was a prior attempt on this same underlying route, not on a different one — the GLM selector it wore resolved to `mistral-medium-3.5` at the provider — and its cause was never established; the qualified 2026-09-01 canary supersedes it. Enablement still is not qualification: an unpromoted target carries no evidence that its route works. OpenCode Go uses its fixed, one-dispatch BWS API-key bridge and does not participate in the OAuth walkthrough; Vibe is probeable and authenticates from the image's guest keychain. `switchyard-golden-6` is the validated Xcode-capable image.

The 2026-08-04 capability-reliability checkpoint adds explicit `RequiredCapability` and `Executor` placement, durable queue selection/dependency/external-blocker diagnostics, target-aware route provenance, and sanitized auth/integration failure metadata across task results, checkpoints, ledgers, events, and detached status/result. Its quota tranche now recognizes only provider-scoped, sanitized Agy and Cursor failure signatures, persists static `quota_exhausted` metadata, and gives an owned working VM one crash-safe same-task retry: the canonical target is durably quarantined, the VM is reset before reroute, exact allowlists remain in force, and status/result reconcile the checkpoint's transition state. Generic 4xx/429/rate-limit text, auth/integration failures, caller-owned VMs, unknown targets, and the latent orchestrator path remain non-retryable. The evidence was collected at the provider boundary without persisting raw output or spending quota to manufacture exhaustion; each provider's credential status remains an independent operational check.

## Priorities (in order)

1. **Containment & isolation (security).** The sandbox boundary *is* the product. A misbehaving in-VM workload must never reach the macOS host, the LAN, cloud metadata, or another provider's environment.
2. **Correctness of the trust-boundary data plane.** Sanitized allowlist export, quarantined normalized import, and a complete provenance record for every task — the host must never open un-normalized hostile output.
3. **Provable containment.** The boundary is *proven*, not assumed: the INV-1 gate (`tests/no-host-rights-vm.test.mjs`) asserts that a working VM has no host filesystem mount and no host credentials — containment against a misbehaving agent, verified, not a claim to withstand a targeted attacker.
4. **Observability & auditability.** Every task records which repository snapshot, base image, provider-credential identity, patch, and validation result belonged to it.

## Layout

| Path | Purpose |
|---|---|
| `README.md` | This file. |
| `INVARIANTS.md` | System-contract charter (closed-loop). Committed. |
| `HISTORY.md` | Meaningful changes, bugs, remediation, regression notes. (local, gitignored) |
| `TASKS.md` | Per-project task tracking. (local, gitignored) |
| `LICENSE` | MIT. |
| `package.json` | Node.js/ESM project config, biome + knip + husky devDependencies; `prepare` installs the git hooks on `npm install`. Test scripts serialize the files that have shown Parallels/`prlctl`-daemon contention flakes: `test:serial` runs `dispatch-cli`, `detached-dispatch`, `no-host-rights-vm`, and `workspace-wipe-vm` at `--test-concurrency=1`, and `test:other` dynamically derives every other `tests/*.test.mjs` — the named files are an **exclusion** list, not an inclusion list, so a new test file runs by default. `test` runs both phases **unconditionally** via `scripts/run-test-phases.mjs` (every test file exactly once); it deliberately does not chain them with `&&`, because a legitimately-red `test:serial` gate would otherwise short-circuit and hide the entire second phase. `validate` chains lint + deadcode + test. |
| `scripts/run-test-phases.mjs` | Test-phase runner behind `npm test`. Runs `test:serial` then `test:other` unconditionally, inherits stdio so each phase streams live rather than buffering, prints a `Test phase summary: <phase> (exit N), ...` line, and exits with the first non-zero phase status. Exports an injectable `runPhases({phases, run, log})` so the aggregation is tested (`tests/test-phase-aggregation.test.mjs`) without invoking the real suite. |
| `.husky/pre-commit`, `.husky/pre-push` | Git hooks (husky, wired by the `prepare` script). `pre-commit` runs `npm run lint`; `pre-push` runs `npm run validate`. Both call the named script instead of restating its steps so a hook cannot drift from the gate. See [Git hooks](#git-hooks). |
| `biome.json` | Biome linter/formatter config. |
| `knip.json` | Dead code / unused dependency detection. |
| `ops/macos-vm/build-golden-image.sh` | Reproducible Parallels golden-image hardening recipe for the native macOS execution lane. |
| `ops/macos-vm/generate-cli-manifest.sh`, `ops/macos-vm/cli-manifest.txt` | Generator and its output: the pinned seven-row installer manifest the golden-image build hash-verifies inside the guest. Public refs and digests only. |
| `ops/macos-vm/probe-guest-credentials.sh` | Measures, inside a guest and in the provider's Aqua session, where each of the six CLIs keeps credentials and whether a tar-provisioned copy actually authenticates. Prints no credential values. |
| **Source modules** | |
| `src/switchyard/router/index.mjs` | Provider selection: snapshot-backed spread routing, blind fallback, INV-4 compliance. Survivors of the exclude/only/capability/availability checks partition into three pools before a winner is picked: a **ranked pool** (roster `implementor_priority` set — the drain-to-0%-first "cheap implementor" waterfall) wins outright over a **spread pool** (every unranked provider, unchanged highest-headroom selection) whenever it's non-empty, which in turn wins over a **last-resort pool** (Cursor's `ap`/API window alone, gated by the ordinary `DEFAULT_FLOOR`). Ranked candidates are matched strictly by lowest `implementor_priority` number (never compared by headroom across ranks), with same-priority ties broken by the same scorer the spread pool's headroom ties use. `reason` reports which pool won: `priority_fill`, `spread`, or `last_resort_fallback`. Cursor's `ac`/`ap` snapshot windows are matched by `w.id`, never pooled or averaged. |
| `src/switchyard/broker/` | Production selection, reservation, and execution boundary used by both foreground and detached queues. It binds exact route identity, uses project-local ledgers and fail-closed snapshots, and permits only the separately qualified quota retry without lowering required capability; generic provider, transient, timeout, launch, and integration failures are terminal and never trigger peer-provider fallback. |
| `src/switchyard/dispatch/disposition.mjs` | Pure, fail-closed projection of durable run evidence into legacy actions plus the additive caller direction (`repair_input`, `advance_authorized_fallback`, `recover_and_retry`, `retry_launch`, `wait`, `complete`, or `stop`); stage-specific `clone_hardening_failed` and `workspace_prepare_failed` outcomes project to contract repair and never authorize provider retry. |
| `src/switchyard/dispatch/run-finalization.mjs` | Idempotent terminalization and cleanup-state persistence for normal completion, handled failures, fatal worker exits, and dead-worker recovery. |
| `src/switchyard/run-store/run-liveness.mjs` | Shared liveness classification used by detached status and state-root recovery to distinguish live, startup grace, dead, terminal-clean, and unknown evidence. |
| **Queue API note** | Both `dispatch run` and the detached worker now await `runQueueAsync`; references below to the retained synchronous `runQueue` describe compatibility behavior, not the production entry points. |
| **Recovery and capture note** | Synchronous and detached capture preserve detailed stage outcomes instead of collapsing failures into empty diffs. Lock/recovery errors use closed diagnostic codes; recovery-claim reservations are byte-bound, attributable, visible to remediation, and ownership-safe. Fatal persistence is redacted and conservative, while cleanup persistence failures stop the run in recovery-required state. |
| `src/switchyard/router/scorer.mjs` | Capacity scoring: FNV-1a hash, mulberry32 PRNG, deterministic jitter. |
| `src/switchyard/roster/index.mjs` | Provider capability definitions and INV-5 capability filter, loaded from the canonical `~/.agent/roster.json` default (resolved via `os.homedir()`), overridable by `SWITCHYARD_ROSTER_PATH`, lazy-loaded + memoized; a missing or malformed roster fails loud. Dispatch records include roster and exact invocation provenance. Low-capability eligibility is entirely roster-driven; INV-4's headroom spread governs which eligible lane wins. Multiple targets may share a harness. Provider-specific effort/variant vocabularies and declarative adapter argv mappings are validated at the boundary and forwarded only from the exact routed descriptor; OpenCode supports an omitted variant as an empty argv fragment and the explicit labels its CLI advertises, including `thinking`. Automatic routing requires a current exact `dispatch_qualified` descriptor, so configured targets without promoted evidence remain unavailable. `evaluateRealRosterCoherence()` and `npm run roster:coherence` report the authoritative current eligibility rather than duplicating time-sensitive state here. Target-id-aware matching for explicit include/exclude selectors cannot force a disabled target into routing. `getImplementorPriority(providerName)` exposes the optional roster rank used by the router's priority-fill waterfall. |
| `src/switchyard/roster/classifier.mjs` | Capability-enum validation plus fail-loud compatibility exports for the retired keyword inference entry points. |
| `src/switchyard/lifecycle/index.mjs` | `seedProjectWithBackend()`: seeds a workspace from the host repo's committed tree (`git archive HEAD` → in-memory tar → `pushTar`, no host mount — INV-1) over any `ExecutionBackend`, then runs the baseline `git init`/commit through the same backend so `captureDiff` has something to diff against. Also re-exports `execution-backend.mjs` and `parallels-execution-backend.mjs` as the module's public surface. Per-task commit/reset (isolating multi-task diffs, INV-3 wipe at project end) lives in `runner/index.mjs`'s `createQueueBackend`, not here. |
| `src/switchyard/lifecycle/execution-backend.mjs` | `ExecutionBackend`: the abstract contract every workspace execution substrate implements (`create`, `execArgv`, `pushTar`/`pullTar`, `destroy`, `listManaged`, ...). `ParallelsExecutionBackend` is the sole concrete implementation. `execArgv(workspaceId, {cwd})` takes the complete command vector and has no mode or session parameter; honoring `cwd` is the backend's obligation since `prlctl exec` has no working-directory field and enters a different launchd domain from the Aqua domain a provider must run in. |
| `src/switchyard/lifecycle/parallels-execution-backend.mjs` | Task 4.1 Parallels lifecycle: UUID-backed clone/boot/destroy, Aqua readiness polling, exact-prefix PID reclamation, and golden-image safety refusals. No ownership sidecar is used. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): structural diff validation (`git apply --numstat`/`--summary`, not a content blocklist), path-escape/symlink/executable-file rejection, and explicit `allowSensitiveManifests` review for build/CI manifests, package manifests, and lockfiles. The runner accepts that opt-in only when `AllowManifests: true` and every manifest path is declared in the task's `Files:` list; an undeclared package or lock artifact is rejected by the exact allowlist before apply. Reviewed apply is via stdin. Apply is idempotent: a non-mutating `git apply --check` runs first, and when it fails a `--reverse --check` probe treats an already-applied diff as a successful no-op (`{alreadyApplied: true}`) with no mutating apply; a genuinely conflicting (or corrupt) diff fails with git's captured stderr as the `reason` and a `reasonKind` of `corrupt_patch` vs `conflict`. Patch normalization only adds a missing final newline and preserves valid one- and two-newline endings. The reviewed-gate contract is unchanged. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): the sanitized project-local intent receipt is authoritative and must complete before any provider execution/launch; outcome records are appended to the project-local store and projected to the legacy global ledger on a best-effort basis. Projection failures use bounded classifications and never change the authoritative launch gate. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateModelArg`) used by all seven provider adapters. |
| `src/switchyard/adapter/prompt-guardrails.mjs` | Shared provider prompt guardrail: providers are told not to invoke package managers or modify undeclared manifests/lockfiles; the integration gate remains authoritative. |
| `src/switchyard/adapter/exec-error.mjs` | `describeExecError()`: turns a thrown `execFileSync` error from a NON-timeout provider failure into a diagnosable transient result and classifies auth, quota, and unavailable-model failures. `classifyProviderDiagnostic()` converts provider output into a content-free closed code; durable failure metadata may additionally retain only an allowlisted exit code, signal, and failure phase. Raw provider output, prompts, paths, and thrown messages never cross the persistence boundary. `auth/liveness.mjs` forwards the closed classification as its probe `kind`. |
| `src/switchyard/adapter/constants.mjs` | `PROVIDER_EXECUTION_TIMEOUT_MS` (30 minutes) — the shared host-side `execFileSync` kill timeout used by all seven adapters as a default, overridable per task via `- **Timeout:**`; centralized so `runner/index.mjs` can compute an accurate `task_routed` deadline instead of drifting from a value duplicated per adapter. |
| `src/switchyard/adapter/orphan-kill.mjs` | Best-effort process cleanup after a host-side `ETIMEDOUT`: killing the host-side client doesn't forward the signal into whatever it started, so each adapter calls this to kill it (`kill -TERM -1` then `kill -KILL -1`, sparing PID 1) before the runner captures a diff. Prefers a supplied `ExecutionBackend`'s own `cleanupProviderProcess()` (`ParallelsExecutionBackend` implements it via guest exec); a hardcoded `docker exec`-based path remains only as the fallback for a backend that doesn't provide one. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, real credential check (`/root/.claude/.credentials.json`, persisted by `claude auth login`). |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch via `codex exec` (prompt over stdin), diff capture, real credential check (`/root/.codex/auth.json`, persisted by `codex login --device-auth`). |
| `src/switchyard/adapter/agy.mjs` | Antigravity (Agy) CLI adapter: dispatch (prompt via `--print` flag, not stdin — the CLI can't read it for this purpose), diff capture, real credential check (`/root/.gemini/antigravity-cli/antigravity-oauth-token`, persisted by agy's auto-triggered Google OAuth flow). |
| `src/switchyard/adapter/cursor.mjs` | Cursor Agent adapter: dispatch invokes `cursor-agent` directly, diff capture, real credential check via `cursor-agent status` text (persisted by `cursor-agent login`). |
| `src/switchyard/adapter/copilot.mjs` | Copilot CLI adapter: dispatch invokes `copilot`, diff capture, and an opaque credential-file check at `/root/.copilot/config.json` (the current device-flow store). |
| `src/switchyard/adapter/opencode.mjs` | Opencode CLI adapter: dispatch invokes `opencode`, diff capture, real credential check (`/root/.config/opencode`). |
| `src/switchyard/auth/index.mjs` | Walks a human through authenticating every provider that isn't already authenticated, by booting the golden image and running each one's real interactive OAuth login directly inside it (there is no standing credential VM to attach to — every command boots the golden image, does its work, and stops it again). Run the walkthrough via `npm run auth`; `npm run auth:check` (`reportProviderStatus`) reports read-only per-provider status without ever attempting a login, and `npm run auth:check:live` adds one real request per probeable provider. `node src/switchyard/auth/index.mjs --clone [--receipt <path>]` (`qualifyCloneAuth` / `runCloneCheck`) executes read-only clone qualification by creating one disposable managed clone, probing every OAuth provider via presence-plus-live checks, emitting safe progress to stderr and terminal summary to stdout, optionally persisting a sanitized terminal qualification receipt (`schemaVersion`, `providers` with `name`, `authenticated`, `live`, and optional `authMode`, plus a static `errorKind`), and always destroying the clone. OpenCode Go and Mistral use ephemeral BWS API-key dispatches, so live auth check and clone qualification report those lanes as unprobed and exit non-zero rather than claiming they were exercised. Presence is not liveness — a credential file survives an expired session, which is why the walkthrough itself now gates its login on a live probe (`auth/liveness.mjs`) rather than on the file. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). Wires all seven adapters; `route()` is restricted to whichever adapters are actually present. `createQueueBackend` seeds the working VM, commits/resets its baseline between tasks, and wipes it at project end — owns the workspace-wipe logic INV-3 governs (INV-3's area map includes this module). Parses `Type:` (`implementation` by default or `review`), requires `Files:` for implementation tasks, and parses `AllowManifests:` (`true` authorizes declared manifest changes, `false` acts as an explicit no-op omission; non-boolean values fail closed); the integration gate rejects any diff that doesn't exactly match the declared target paths (rename/delete included). Also parses an optional `Timeout:` field overriding `PROVIDER_EXECUTION_TIMEOUT_MS` per task; on a timeout the runner captures the diff as a review artifact instead of discarding it (never through the integration gate — see "Timeout Handling"). A tasks file that parses to 0 tasks fails closed (throws with the file path, detected heading count, and expected format) rather than silently reporting a 0/0 success, and always writes an auditable checkpoint first; a run also always leaves a final checkpoint on disk even when it reaches 0 runnable tasks without entering the per-task loop. The per-task checkpoint/result block — including failed/timed-out bookkeeping, on both the sync and orchestrator paths — is saved to disk **before** the working-VM commit/reset, so a commit crash or external kill can never leave a completed task outside the durable checkpoint; a commit/reset failure then halts the run (`halted_after_commit_failure`/`halted_after_reset_failure`) instead of dispatching the next task against a VM with an unadvanced or un-reset baseline. Verified `quota_exhausted` failures on an owned VM enter a checkpoint-authoritative, target-specific quarantine state, reset before one reroute, and never consume a second logical `maxTasks` slot; resume reconstructs an interrupted quarantine transition before selecting a target. Generic provider/transient/timeout/launch failures are terminal and do not peer-fallback. Emits a `task_routed` event/callback (`{taskId, provider, model, deadline}`) synchronously right after routing, before the blocking (up to `PROVIDER_EXECUTION_TIMEOUT_MS`-long) adapter call. Fires a new `onContainerReady` callback unconditionally right after `workingContainerName` is resolved (both the freshly-created and pre-supplied-name branches), surfacing it into the run record. The authoritative project-local intent receipt is written synchronously before adapter execution or awaited before orchestrator launch; only outcome projections to the local/legacy ledgers are non-blocking/best-effort. `runQueue` and `runQueueWithOrchestrator` carry the same `only` and `exclude` provider filters into their route calls; the orchestrator context also carries the available adapter set. |
| `src/switchyard/dispatch/index.mjs` | CLI over `runQueue` with five subcommands: `run` (synchronous, `npm run dispatch -- <tasks.md> --project <path> [--max-tasks\|--checkpoint\|--no-stop-on-failure\|--exclude-provider\|--only-provider]`), `launch` (spawns a detached worker and returns immediately, same options; opens `<runRoot>/boot-stderr.log` mode 0600 and passes the fd as the child's stderr, falling back to `stdio: "ignore"` if the open fails, because a diagnostics file must never be able to fail a launch), `status`/`result` (poll a run by id, read-only), and `recover` (reclaims orphaned VM workspaces and stale project locks). `--only-provider`/`--provider` and `--exclude-provider` are mutually exclusive (throws a `UsageError` if both are given). Exits 2 on bad invocation / 1 if any task failed (`run` and `recover` both exit 1 on any failure). `status` exits 0 on success, 3 when the run id is not found, 4 on corrupt/unsupported run state; `result` adds 5 when the run is not yet terminal, and exits 1 unless the terminal run succeeded with cleanup complete. `status`/`result` share a `deriveTelemetryFields(run, events, checkpointState)` helper that derives the aggregate stall-detection fields and overlay the checkpoint's `quarantinedTargetIds`, in-flight retry state, and monotonic transition ID — see "Detached Dispatch and Recovery" below for the full field list. The synchronous `run` subcommand acquires the exclusive project lock before queue execution and releases it (ownership-checked) on every terminal path, so a second concurrent `run` against the same project fails fast instead of racing the checkpoint file. Its pre-dispatch retention sweep (`applyRetention`, incl. malformed-record quarantine) runs before synchronous dispatch; the detached `launch` worker performs the same schema-only quarantine sweep during bootstrap. Also owns recovery orchestration: candidate-run reconciliation plus the state-root lock/claim scan (`releaseOrphanedProjectLocks()` and `reconcileProjectLockClaims()`), both using shared liveness and ownership checks (see `run-store/index.mjs` below). |
| `src/switchyard/dispatch/worker-bootstrap.mjs` | The detached child process a `launch` spawns. Verifies the worker nonce and host git fingerprint match what `launch` recorded (mismatch = exit 3/4, refuses to run against a different checkout), and retains `boot-stderr.log` through every pre-provider failure, unlinking it synchronously at the adapter boundary (inside `onTaskRouted`, immediately before the blocking adapter call) and on a run that reaches no runnable task — unlink rather than truncate, because the inherited descriptor lives as long as the worker does, so an unlinked path sends every post-provider byte to an anonymous inode reclaimed at exit instead of letting runner-phase output land in a file (INV-2). Claims the run lease, advances state to `running`, runs `runQueue` synchronously, then writes the terminal state through the shared `finalizeRun` (`run-finalization.mjs`) and releases the run lease and project lock on every path — success, task failure, and crash. Its fire-and-forget event callbacks (`onTaskStart`, `onTaskRouted`, `onResult`, `onCheckpointSaved`, and retry-state projection) also go through `updateRunWithRetry` rather than a fixed-revision `updateRun`: `onTaskStart` and `onTaskRouted` fire microseconds apart (routing is synchronous, ahead of the blocking adapter call), so a fixed revision would let one silently lose the race and drop `activeTaskId` or `activeTaskProvider`/`Model`/`Deadline` from `status`. All callbacks additionally chain onto a module-scope `writeChain` promise at fire time (not just `updateRunWithRetry`'s per-call retry), so submission-order write ordering is guaranteed even when two callbacks' internal `readRun()`s could otherwise resolve out of order — `updateRunWithRetry` alone prevents a write from being lost, not from landing out of order. `writeFatalEvent` never forwards the error object at all: it maps the failure to a closed diagnostic code (recognized checkpoint-identity code, worker-boot stage code, or `worker_boot_exception`), runs it through `sanitizeFailureMetadata`, and finalizes through `finalizeRun`, so no provider- or host-derived text can reach `events.jsonl`; a run that cannot be read or mutated falls back to a fixed categorical diagnostic instead. Reads `run.excludeProviders` and passes it into `runQueue({ exclude })`. |
| `src/switchyard/run-store/index.mjs` | Versioned, file-backed run state under `.logs/switchyard/runs/<runId>/{run.json,events.jsonl}`, alongside `artifacts/` and the boot-phase-scoped `boot-stderr.log` (see `dispatch/index.mjs`). Writes are atomic (unique tmp path per write, never a fixed/shared one) and optimistic-concurrency checked (`updateRun` throws `RevisionError` on a stale `expectedRevision`); concurrent `updateRun` calls for the same run are serialized through an in-process per-runId queue, so a losing writer gets an honest error instead of silently clobbering another writer's data. `updateRunWithRetry` re-reads and retries on conflict for a caller whose write must win. `validateRun` type-checks every run-record field, including active task telemetry and the sanitized retry projection (`quarantinedTargetIds`, `retryState`, `retryTransitionId`), rejecting a wrong-typed write with `SchemaError` rather than corrupting `run.json` silently. Also owns run leases (`acquireRunLock`/`releaseRunLock`/`renewRunLock`/`isRunLockExpired`), launch locks (dedup concurrent launches against the same task file), and project locks (`acquireProjectLock`/`releaseProjectLock`/`releaseProjectLockIfOwnedBy`, one active run per project — lock bodies now carry `projectPath`, not just `{runId, createdAt}`, so an orphaned lock whose run directory is gone can still be identified) plus retention (`applyRetention`), which now returns `{deletedCount, quarantined}` and quarantines malformed run records (invalid JSON, unsupported schema version, `SchemaError` validation failures) — an atomic rename to `.quarantine/<runId>/`, never deletion, on every sweep (`dryRun` suppresses only valid-run deletion, never quarantine); destinations are collision-safe (a pre-existing `.quarantine/<name>` is never overwritten — a unique suffixed destination is allocated instead) and reported as a raw on-disk `destination` plus a separately sanitized `destinationDisplay` safe for logs/terminal; reasons are static strings (only `SchemaError`'s own non-content-derived message — raw error or file content never appears). Runs that fail to read for non-validation reasons — absent `run.json` (ENOENT, e.g. a concurrent `initializeRun` mid-flight), EACCES, EIO — are conservatively left in place and re-skipped, since none of those signals proves corruption. |
| `src/switchyard/dispatch/remediate-orphaned-locks.mjs` | Standalone, human-confirmed CLI for reclaiming project locks a `releaseOrphanedProjectLocks()` scan can't safely auto-reclaim (unparseable body, missing `projectPath`, or `projectPath`-known-but-run-record-gone). Not wired into `dispatch/index.mjs`'s subcommand table. Always resolves candidates fresh from disk, prints the full candidate set (hash, age, recovered `projectPath`) before touching anything, and requires explicit interactive confirmation per lock — every removal still goes through the existing ownership-checked `releaseProjectLockIfOwnedBy`. Run with `--dry-run` first, then a bare interactive run: `node src/switchyard/dispatch/remediate-orphaned-locks.mjs [--dry-run]`. |
| `src/switchyard/diagnostics/index.mjs` | Safe event/error channel for the run store's `events.jsonl`: serializes an `Error` to an allowlisted field set (`name`, `message`, `code`, `phase`, `taskId`, `provider`, `model`, `exitStatus`) and redacts any string matching the `SECRET_CANARY_` test pattern, so a diagnostic event can never leak a secret into the durable log. |
| **Tests** | |
| `tests/capability-match.test.mjs` | INV-5 gate: capability filter, capability ordering, model right-sizing. |
| `tests/capability-enum.test.mjs` | Capability-enum validation and retired-classifier fail-loud compatibility tests. |
| `tests/claude-adapter.test.mjs` | Claude CLI dispatch and diff capture tests. |
| `tests/claude-auth.test.mjs` | Shell-injection guard, prompt-injection regression, credential-validity check. |
| `tests/codex-adapter.test.mjs` | Codex CLI dispatch and diff capture tests. |
| `tests/codex-auth.test.mjs` | Shell-injection guard, prompt-injection regression, credential-validity check, `codex exec` subcommand-shape check. |
| `tests/agy-adapter.test.mjs` | Agy CLI dispatch and diff capture tests. |
| `tests/agy-auth.test.mjs` | Same regression shape as codex-auth, adapted for agy's `--print`-flag prompt delivery and display-name model strings. |
| `tests/cursor-adapter.test.mjs` | Cursor Agent dispatch and diff capture tests. |
| `tests/cursor-auth.test.mjs` | Same regression shape, plus checks of `isCursorAuthenticated()`'s `cursor-agent status --format json` `isAuthenticated`-boolean signal (positive, negative, missing-binary, and malformed/empty-output fail-closed cases). |
| `tests/copilot-adapter.test.mjs` | Copilot CLI dispatch and diff capture tests. |
| `tests/copilot-auth.test.mjs` | Shell-injection guard and credential-validity check for Copilot CLI. |
| `tests/opencode-adapter.test.mjs` | Opencode CLI dispatch and diff capture tests. |
| `tests/opencode-auth.test.mjs` | Shell-injection guard and credential-validity check for Opencode CLI. |
| `tests/auth-check.test.mjs` | `ensureProvidersAuthenticated` + `reportProviderStatus` (the read-only `auth:check`), liveness gating, and `qualifyCloneAuth` / `runCloneCheck` (read-only `--clone` qualification and `--receipt` persistence) unit tests via injected fake providers, including regressions for a provider's `runLogin()`/`isAuthenticated()` throwing without aborting the rest, cleanup on failure, sanitized receipt redaction, and fail-closed reporting without Parallels. |
| `tests/auth-liveness.test.mjs` | The liveness probe's decision logic through its `run` seam: what counts as an answer (a positive `OK`, with the echoed prompt stripped first), what an expired session vs. a timeout is classified as, and that all seven providers carry an empirically-confirmed invocation. |
| `tests/shell-safety.test.mjs` | Unit tests for the shared `validateIdentifier`/`validateModelArg` shell-interpolation guards used by all seven adapters. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights-vm.test.mjs` | INV-1 gate: exercises a real Parallels working VM and asserts it has no host FS mount and no host credential paths. |
| `tests/workspace-wipe-vm.test.mjs` | INV-3 gate: exercises the real VM lifecycle — reclamation touches only exact-prefix-named VMs owned by a proven-dead creator PID, and a normal destroy stops and deletes the owned VM. |
| `tests/parallels-backend.test.mjs` | `ParallelsExecutionBackend` unit/live-gated tests: clone/boot/destroy, Aqua readiness polling, exact-prefix PID reclamation, golden-image safety refusals, stage-specific clone-hardening/workspace-preparation diagnostics, and host-side SDK job-misfire tolerance: bounded retry at `_call` and inside the separate bulk-transfer helper process, the `retry: false` opt-out, the classified failure metadata, and the structural reason paid provider work stays off that route -- adapters execute through the `execArgv` descriptor, which never calls prlctl. |
| `tests/macos-vm-ops.test.mjs` | macOS/Parallels VM operation tests (`prlctl` argument shaping, guest exec transport). |
| `tests/reaper-script.test.mjs` | Standalone launchd reaper (`ops/switchyard-reaper.sh`) regression: reads only managed VM names via `prlctl` (never project code), and a parity guard keeping its `WORKING_PREFIX` in sync with `PARALLELS_WORKING_PREFIX` in `parallels-execution-backend.mjs`. |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5, adapter-availability filtering, blind fallback. Also covers the implementor-priority waterfall: a ranked provider beating a higher-headroom unranked one, strict waterfall order across multiple ranks regardless of headroom, the ranked 0% floor (vs the unranked 5% `DEFAULT_FLOOR`), Cursor's un-pooled `ac`/`ap` split (`ac` ranked, `ap` last-resort-only, each gated by its own floor), the `priority_fill`/`last_resort_fallback` reasons, and a same-priority tie-break via the scorer (against a dedicated fixture, `roster.priority-tiebreak.fixture.json`, so it can't collide with the shared fixture's other headroom-based assertions). |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume (atomic writes), stopOnFailure/gate-failure handling, deterministic no-peer-fallback behavior, headroom-routing mechanism, seed/commit/wipe lifecycle wiring + call order, per-task commit for multi-task isolation, progress hooks (including `onTaskRouted`/`task_routed` firing before the blocking adapter call), orchestrator CLI integration, orchestrator status/result error guards, fail-closed 0-task parse (both `runQueue` and `runQueueWithOrchestrator`), and always-leaves-a-checkpoint on a 0-runnable-task completion. |
| `tests/dispatch-cli.test.mjs` | `parseDispatchArgs` unit tests: valid invocation + defaults, `--help`, `--max-tasks`/`--checkpoint`/`--no-stop-on-failure`, and each rejection path (missing tasks/`--project`, non-file tasks, non-git project, non-positive `--max-tasks`). |
| `tests/scorer.test.mjs` | FNV-1a hash, mulberry32 PRNG, and scoring logic unit tests. |
| `tests/run-store.test.mjs` | INV-6 gate: atomic writes (unique tmp path per write, no shared-path ENOENT collisions under 40 concurrent writers), revision-checked `updateRun` (throws `RevisionError` on mismatch, serializes racing same-revision callers so exactly one wins), `updateRunWithRetry`'s authoritative write surviving a losing race, two concurrent `updateRunWithRetry` callers touching different fields both surviving (the `onTaskStart`/`onTaskRouted` race regression), run leases, launch locks, project locks (including `releaseProjectLockIfOwnedBy`'s ownership check and `projectPath` presence in newly acquired locks), `validateRun` rejecting wrong-typed telemetry fields, `releaseOrphanedProjectLocks()` and `reconcileProjectLockClaims()` recovery (shared liveness, live/startup-grace/unknown/malformed/missing-run locks retained, stale claims released once), and retention. |
| `tests/worker-bootstrap-write-chain.test.mjs` | `writeChain` causal-ordering regression: interleaves two tasks' callbacks (`onTaskStart`/`onTaskRouted`/`onResult`/`onCheckpointSaved`) against a real run-store and asserts `activeTaskId` is never observed null/stale while a later task is actively running — exercises the actual race (two `updateRunWithRetry` calls whose internal `readRun()`s could resolve out of order), not just the happy path. |
| `tests/worker-bootstrap-fatal-metadata.test.mjs` | `writeFatalEvent`'s closed-code precedence: which diagnostic code wins when a prlctl misfire, a boot-stage error and a checkpoint-identity error are all in play, and when the resulting `exitCode`/`signal` are attached or withheld. The test imports `buildFatalFailure` from `worker-bootstrap.mjs`, so its assertions exercise the production metadata composition directly. |
| `tests/remediate-orphaned-locks.test.mjs` | `remediate-orphaned-locks.mjs` CLI regression: candidate resolution always fresh from disk, pre-`projectPath` lock shape recovered via the run record and confirmed against the lock's expected filename hash, no removal without explicit confirmation, ownership check still enforced at deletion time. |
| `tests/detached-dispatch.test.mjs` | End-to-end `launch`/`status`/`result`/`recover` CLI regression: nonce and host-fingerprint verification, terminal-state project-lock release, fatal/stage-specific worker-boot evidence and redaction, `recover` reclaiming stale locks from dead/terminal runs via `isWorkerLive` without touching a lock owned by a different currently-active run, the `status`/`result` envelope's `workerLive`/`activeTaskProvider`/`activeTaskModel`/`activeTaskDeadline` fields for live, ghost (dead pid), and non-running runs, and both `--exclude-provider` and `--only-provider` working identically on the foreground and detached worker paths (each proven against a real two-provider snapshot fixture through the actual detached worker, not mocked). |
| `tests/diagnostics.test.mjs` | `Diagnostics` event/error serialization: allowlisted field extraction, `SECRET_CANARY_` redaction, async `emit()` resolving once every sink has settled (a synchronously-throwing sink can't skip the rest). |
| `tests/roster-loader.test.mjs` | Roster loader path resolution: an unset/empty `SWITCHYARD_ROSTER_PATH` resolves to the canonical `~/.agent/roster.json` default (hermetically — the loader's homedir is pointed at a temp fixture, never the real file), an explicit env override wins, and a missing/malformed-JSON/structurally-invalid roster at the resolved path (override or default) fails loud. Also covers the preserved interface against a committed synthetic fixture. Includes `getImplementorPriority` unit coverage: the fixture's three ranked targets resolve their declared rank, every unranked target and an unknown provider name resolve to `null`. |
| `tests/fixtures/roster.fixture.json` | Synthetic test roster with 7 providers, varying capability/qualification/enabled states, used by roster-loader.test.mjs and other roster-aware tests. Three targets (`antigravity`, `copilot-student`, `cursor-pro`) carry `implementor_priority` (1/2/3) for the implementor-priority-waterfall-routing tests. |
| `tests/fixtures/roster.priority-tiebreak.fixture.json` | Dedicated synthetic roster for the same-priority ranked tie-break test only: two `agy`-harness targets (mirroring the dual-agy shape) both set `implementor_priority: 1`, disambiguated by `snapshot_name`. Kept separate from `roster.dual-agy.fixture.json` because that fixture's own tests assert headroom-based winner flips between the two buckets, which a priority tie would break. |
| `tests/provenance.test.mjs` | Dispatch provenance: `computeRosterSha` pure-function properties (excludes qualifications, reflects catalog/target changes), six-field provenance attachment on all dispatch paths, roster sha stability across simulated smoke runs, `recordDispatchToStore` parity, and default runner dual-ledger wiring (ordered best-effort sync writes, awaited orchestrator writes, failure handling, and explicit recorder overrides). |
| `tests/router-rightsizing.test.mjs` | Router INV-5 property tests through `route()`: right-sized models per capability class, capability filtering preventing below-required-capability routing even with headroom advantage. |
| `tests/harness-registry-drift.test.mjs` | Drift regression: every enabled ~/.agent/roster.json target names a registered harness adapter (one per file under `src/switchyard/adapter/*.mjs`). Scope: only enabled targets; reads real roster file. |
| `tests/router-usage-provider.test.mjs` | Mapping regression: every enabled ~/.agent/roster.json target's `usage_provider` (or `harness` default) normalizes to a gradus provider name. Reads real roster file against committed GRADUS_PROVIDER_DISPLAY_NAMES. Also asserts the live roster keeps the two `codex`-harness targets (`codex`, `codex-spark`) resolving to distinct target ids, guarded by an explicit both-enabled precondition so the block cannot pass vacuously; the behavioural lock on `providerMatches()` itself is the `--only-provider codex` case in `tests/router.test.mjs`, which drives the real helper through `route({only})` against a both-targets-enabled fixture roster. |
| `tests/runner-adapter-harness.test.mjs` | SelectAdapter must normalize provider display name to harness key before adapter lookup (regression: display name "OpenCode Go" → harness "opencode" → adapter invocation, not unsupported_provider). |

## Planning artifacts

- `~/Documents/Projects/.plans/switchyard/switchyard-capability-reliability-2026-08-04.md` — closed after the Phase 6 quota capstone; the terminal disposition is recorded in the plan header, `HISTORY.md`, and the unique planning metrics record.
- `~/Documents/Projects/.plans/switchyard/switchyard-capability-reliability-2026-08-04-tasks.md` — reconciled 22-task board for the closed checkpoint.
- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20.md` — CLOSED 2026-07-21; historical implementation-engine plan.
- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20-tasks.md` — historical task board for the closed implementation-engine plan.
- Supersedes the abandoned `switchyard-containment-architecture-2026-07-20` (adversary-defense) draft.

## Workflows

### Native macOS golden image

`ops/macos-vm/build-golden-image.sh` hardens the existing Task 1.1 Parallels VM
in place. It requires a host-staged Xcode VM with Homebrew, an interactive
administrator build session for Homebrew's Node package, and explicit network
probe inputs. The script sets headless startup and 16 GiB memory, creates a
generated non-admin `switchyard` provider account, enables passwordless
automation mode, configures the provider Aqua session to remain unlocked,
installs the seven provider CLIs without authentication, pins
the requested iOS runtime, disables the guest clipboard agent, and loads the
guest-side C-3 pf anchor. It restarts before the final Aqua, transport,
clipboard, pf, memory, and network assertions.

Those assertions run when the image is *built*, but the posture is consumed when
a clone is *dispatched*, and the two drifted apart once: a Parallels Guest Tools
refresh inside the golden on 2026-08-21 restored the package-owned
`com.parallels.copypaste` LaunchAgent the build had renamed away, and every clone
taken afterwards synced the host pasteboard into the guest. A build-time check
cannot catch post-build drift, so `create()` now enforces the clipboard teardown
on each clone — `launchctl bootout`, `launchctl disable`, `pkill` — and then
proves the label is unloaded and no `prlcopypaste` is running before the provider
user is let in. A clone that stays clipboard-capable fails to create rather than
dispatching. The golden-image repair is still owed; this removes the drift from
the dispatch path, it does not replace the fix.

It also pins XcodeGen, and asserts it by **using** it rather than by its version
string. Two shipped images carried a Homebrew Cellar holding `bin` and nothing
else — no `share/xcodegen/SettingPresets` — which reports the pinned version
correctly while generating projects with an empty `PRODUCT_NAME` and
`SWIFT_VERSION` that `xcodebuild` cannot build. The build now requires the
preset tree, repairs by removing the Cellar directory before installing (brew
keys "installed" off the prefix, and the broken directory has no receipt, so
`brew reinstall` can no-op against exactly that state), and generates a
throwaway project to assert a non-empty product name. Apply the same rule to
anything added here: a check that proves a tool is present does not prove it
works.

Provider installers are supplied through a pinned, externally reviewed
manifest; the script will not use an unpinned `curl | shell` or an unversioned
npm install. Each non-comment row is
`provider|kind|ref|detail|sha256`, with `kind` set to `script` or `npm`,
`detail` set to `bash`/`sh` for scripts or an exact npm version, and `sha256`
set to the downloaded installer or npm tarball digest. The manifest must have
one row for each of `claude`, `codex`, `agy`, `cursor-agent`, `copilot`, and
`opencode`; every artifact is downloaded, hashed, and installed on each build.

The manifest is committed at `ops/macos-vm/cli-manifest.txt` and regenerated by
`ops/macos-vm/generate-cli-manifest.sh` — it holds only public refs and digests,
never a credential. It is a point-in-time pin. The two npm rows are pinned to a
version and independently verifiable: `npm pack` writes the registry's own
tarball byte for byte, and the generator refuses to emit a row unless that hash
matches a separately downloaded `dist.tarball`. The four script rows install
from **unversioned** vendor endpoints whose content can change without notice,
so the hash is the only thing holding them still. When a vendor does ship a new
installer, the in-guest `shasum -c` fails the build closed; regenerate, review
the diff, and commit it. Never hand-edit a hash to make a build pass.

```sh
ops/macos-vm/generate-cli-manifest.sh                 # refresh all seven rows
ops/macos-vm/generate-cli-manifest.sh --out -         # preview without writing
```

Example using the measured Parallels addresses:

```sh
ops/macos-vm/build-golden-image.sh --vm macOS \
  --simulator-runtime-version 26.5 \
  --cli-manifest ops/macos-vm/cli-manifest.txt \
  --blocked-endpoint 10.211.55.2:22 \
  --blocked-endpoint 192.168.1.49:22 \
  --blocked-endpoint 192.168.1.1:443 \
  --blocked-endpoint 10.211.55.6:22 \
  --reachable-endpoint 1.1.1.1:443 \
  --dns-name apple.com
```

**The C-3 anchor's rule order is the property that matters, not its contents.**
pf takes the first `quick` match, so a pass that sits below a block is dead
text. The three RFC1918 `block drop` rules carry no direction, which means they
also drop packets addressed *to* the guest's own `10.211.55.x` — including the
inbound DHCP OFFER. The anchor therefore passes DHCP in **both** directions
above those blocks, and the build asserts the ordering by comparing line numbers
in the *loaded* ruleset rather than trusting the file on disk. Without it, every
task-time clone comes up dead: each clone gets a fresh MAC and so needs a full
handshake, not the stateful unicast renewal the build VM does. The build VM
cannot catch this on its own — it already holds a lease from before pf was
loaded — which is exactly why the second independent build exists.

**The provider CLIs are only useful if a login shell can find them.** They
install into the provider account's `~/.local/bin`, which no default macOS login
PATH contains, so the build registers that directory with `path_helper` via
`/etc/paths.d/switchyard`. The installer's own `command -v` sweep cannot catch a
regression here — it runs inside a heredoc that exports the directory, so it
passes either way. The assertion that matters runs after the final restart,
through the same `sudo -u <account> /bin/bash -lc` identity the execution
backend uses. Without it the image ships seven CLIs that are present on disk and
unreachable by name, and every provider exec fails with `command not found`.

**Anything with shell metacharacters must reach the guest over stdin.**
`prlctl exec` reparses a script supplied as an argv element, so a pipe,
redirect, or quoted word does not survive. `guest_exec` is for single commands
only; `guest_exec_script` is the stdin channel. The execution backend solves the
same problem by shell-quoting the script argument.

The auto-login password is generated and consumed only inside the guest. The
only deliberate plaintext-equivalent persistence is `/etc/kcpassword`: it is a
disposable, non-admin, guest-only credential shared by image clones. It is
never sourced from BWS, reused from the host, printed, or written to an
artifact. The encoder uses macOS's repeating 11-byte XOR key and padded binary
format; a cold boot must land in an unlocked provider Aqua session. If those
conditions stop being true, rebuild the image.

Task 1.3 reproducibility recipe: start from a stopped Task 1.2 substrate, create
an independent disposable VM, run the same command above against the new VM, then
create a second disposable clone from that build. On the second clone, assert a
`prlctl exec` round-trip, the pinned `xcodebuild -version`, the pinned iOS runtime
from `xcrun simctl list runtimes`, a trivial `xcodebuild` fixture build, and a
booted device from `xcrun simctl boot`. Keep provider checks in the Aqua identity;
`prlctl exec` itself is root in the System domain:

```sh
# Omit --linked for an independent full clone.
prlctl clone <stopped-base> --name <build-2>
ops/macos-vm/build-golden-image.sh --vm <build-2> \
  --simulator-runtime-version 26.5 \
  --cli-manifest ops/macos-vm/cli-manifest.txt \
  --blocked-endpoint 10.211.55.2:22 \
  --blocked-endpoint 192.168.1.49:22 \
  --blocked-endpoint 192.168.1.1:443 \
  --blocked-endpoint 10.211.55.6:22 \
  --reachable-endpoint 1.1.1.1:443 --dns-name apple.com
prlctl clone <build-2> --name <check-2>
```

`ops/macos-vm/probe-guest-credentials.sh` produces the credential half of that
gate. Run it twice against a throwaway clone — once before provisioning and once
after — and the difference is the answer:

```sh
ops/macos-vm/probe-guest-credentials.sh --vm <check-2> --phase baseline
ops/macos-vm/probe-guest-credentials.sh --vm <check-2> --phase provisioned
```

Baseline must report every provider unauthenticated; anything else means the
image shipped a credential. After provisioning, a provider whose own auth check
reports authenticated is tar-provisionable **yes**, and one that does not is
**no** regardless of where its files sit — some CLIs bind their store to machine
identity, and `copilot` says outright that it prefers the system credential
store (the login Keychain on macOS) over a file. The probe enters the provider's
Aqua session through `launchctl asuser <uid> sudo -iu <account>` and prints the
launchd manager name it measured under, because `prlctl exec` is root in the
`System` domain and the two see different Keychains. It reports credential files
by path, size, and mode only, and enumerates the Keychain **without** `-d`, so
no secret can reach its output. Classification reads each CLI's output rather
than its exit status: `cursor-agent status` and `opencode auth list` both exit 0
while logged out.

A **full** clone is required, not a linked one. An earlier attempt at this gate
used a linked clone, which reported `GuestTools: state=not_installed` and so had
no `prlctl exec` channel at all. Full clones carry working Guest Tools, and they
are not the expensive option they sound like: APFS clonefile produced a 185 GB
clone in **0.28–0.34 s** consuming zero additional disk.

#### macOS provider credential locations

Measured 2026-08-14 in a full clone of the second independent build, not derived
from vendor documentation. The route in the fourth column is mandatory for every
check: `prlctl exec` lands as root in the `System` domain, while the provider
runs in the auto-login Aqua session, and the two see different Keychains.
Attribution is per file — each file was moved aside and the provider's own check
re-run — so every **Yes** names the file that actually decides the verdict.

| Provider | Credential files, relative to the provider's home | Tar-provisionable | Auth-check identity route | Evidence |
|---|---|---:|---|---|
| Claude | `.claude/.credentials.json` **and** `.claude.json` | Yes | `launchctl asuser <UID> sudo -iu <provider>` | Both are required. Either alone reports `"loggedIn": false, "authMethod": "none"`; together, `"loggedIn": true, "authMethod": "claude.ai"`. |
| Codex | `.codex/auth.json` | Yes | same | Removing it yields `Not logged in`. |
| Antigravity/Gemini | `.gemini/antigravity-cli/antigravity-oauth-token` | Yes | same | File-backed despite appearances: `agy` *writes* a `gemini` login-Keychain entry after authenticating, yet still fails without the token file. Keychain presence is not evidence of Keychain backing. |
| Cursor | none found | **No** | same | The measured no. With `.config/cursor/auth.json`, `.cursor/cli-config.json`, and `.cursor/agent-cli-state.json` all in place, `cursor-agent status` still reports `Not logged in`, and no cursor service appears in the login Keychain. File-backed in shape, machine-bound in behavior. |
| Copilot | `.copilot/config.json` | Yes | same | This falsified the standing prediction. `copilot login --help` advertises the system credential store — the login Keychain on macOS — and copilot was called the most likely Keychain-backed **No**. It is file-backed and a copy works. |
| OpenCode | `.local/share/opencode/auth.json` | Yes | same | Removing it yields `0 credentials`, at exit status 0. |

These measurements record whether a provider's login *can* survive tar-based
provisioning at all, historically. The live macOS queue gate no longer reads
this table directly — it admits a provider only once its golden-image-baked
login is proven to survive cloning by its own clone-survival test (see
"macOS queue admission and provider preflight" below).

Vendor documentation, for contrast with what was measured:
[Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started),
[Codex auth storage](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs),
[Antigravity CLI auth](https://antigravity.google/docs/cli-install),
[Cursor authentication](https://docs.cursor.com/en/cli/reference/authentication),
[Copilot credential storage](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli),
[OpenCode providers](https://opencode.ai/docs/providers).

### Execution backend contract

The lifecycle backend seam is defined by `ExecutionBackend`: an abstract contract for workspace creation/destruction, tar transfer, managed-object listing, and process inspection. `ParallelsExecutionBackend` (below) is the sole concrete implementation. `execArgv(workspaceId, {cwd})` has no mode or session parameter. Honoring `cwd` is each backend's obligation; `prlctl exec` has no working-directory field and enters a different launchd domain from the Aqua domain required by the provider.


### Parallels lifecycle backend (Task 4.1)

`ParallelsExecutionBackend` uses only the reserved VM namespace
`switchyard-work-<runId>-<creatorPid>`. The VM's Parallels UUID is the runtime
handle; the name remains the ownership proof. Reclamation touches only names
with that exact prefix and a valid embedded PID, and only after that PID is
proven dead. It writes no sidecar ownership file.

The backend creates a full-copy clone by default, boots by UUID, and polls
`prlctl exec <uuid> launchctl print gui/<UID>` until the Aqua domain exists or a
bounded timeout names the missing domain. A linked clone is considered only when
`measureLinkedClone()` has produced a receipt for that exact golden image with
positive disk usage and finite clone-to-boot time. The real golden-image probe
on 2026-08-13 had no usable Guest Tools channel, so full-copy is the active
measured path. Destroy tries a graceful `prlctl stop` and falls back to
`prlctl stop <uuid> --kill` before deleting the VM. Partial creates roll back
through the same stop/delete path.

The backend refuses to boot the golden image while any owned clone exists. When
a measured linked clone is used, it tracks and removes the linked-parent
snapshot before teardown completes. VM calls, time, sleeping, disk measurement,
and PID liveness are injectable for hermetic tests and smoke runs.

### Parallels data plane (Task 4.2)

VM execution uses `prlctl exec <uuid> launchctl asuser <UID> sudo -u <provider>
/usr/bin/env HOME=… USER=… LOGNAME=… /bin/bash -lc '<base64 decode>'`. This is
intentionally the measured Aqua-session route; the earlier
LaunchAgent/`launchctl bootstrap` D-5 requirement was withdrawn because it could
not provide the provider's stdin, incremental output, exit status, or killable
process handle.

Three properties of `prlctl exec` shape that command line, and all three were
measured against a live guest rather than assumed. **Do not simplify any of them
away.**

- *It does not pass an argument vector through.* It joins the arguments with
  spaces and the guest applies exactly one round of shell parsing. So the
  backend builds the entire vector in one place — `_buildAquaExecArgs` takes the
  command's `argv` and returns the finished `prlctl` arguments. It is not a
  prefix for callers to append to; a transport that never sees the whole vector
  cannot quote it.
- *It enters the guest with `HOME=/`,* and macOS sudoers preserves that across
  `sudo -u`. `sudo -H` does not override it. Left alone, Bun-based providers try
  to `mkdir /.cache` on the read-only system volume. The `env` assignments are
  therefore *ahead of* `bash -lc`, not inside the script: `-l` sources
  `/etc/profile` and `$HOME/.bash_profile` first, so anything set inside the
  script would arrive after the profile had already read the wrong home.
- *It cannot carry a byte above 0x7F.* Any multi-byte character corrupts the
  command line the guest rebuilds, and it surfaces as
  `unexpected EOF while looking for matching '` rather than as mangled text —
  one em dash in a code comment was enough to stop a provider from starting. The
  guest script therefore crosses base64-encoded, so only the base64 alphabet is
  ever on the wire. The decode runs in a command substitution, which is what
  keeps the provider's stdin, stdout, stderr and exit status inherited.

The one value that cannot be inside the payload is the bulk-transfer URL, since
its port is not known until the helper has bound it. It crosses as a validated
plaintext `KEY=value` argument that the guest script substitutes.

The host is the size limit, not the guest: `spawnSync` hits macOS `ARG_MAX`
between a 683 KB and a 1.33 MB argument vector, and base64 inflates the payload
by 4/3, so the usable prompt ceiling is roughly 500 KB.

**Never orphan a `prlctl` process.** Do not wrap a `prlctl` call in a short
`timeout`, and do not kill a shell, harness, or agent turn that is blocked in
one. prlctl 26.4.1 segfaults when a signal reaches it after its parent has
exited: it jumps to address 0 through `_sigtramp` while blocked in
`QWaitCondition::wait` inside `ParallelsVirtualizationSDK` — measured
2026-08-14 17:33:00, pid 10735, five minutes into an operation whose parent had
already gone. That is a Parallels defect, and the fix on our side is not to
provoke it. These operations are long by nature: a full clone of the golden
image runs for minutes, and an in-guest `xcodebuild` runs longer. Bound them by
making the operation smaller, never by killing it partway. If a call must run
unattended, launch it detached and poll for its result rather than capping it.
An interrupted clone is the orphan INV-3 reclamation has to sweep, and that
sweep only fires for a creator PID it can prove dead.

switchyard itself fails closed on a prlctl that dies this way — `execFileSync`
throws, the `spawnSync` path treats the `null` status of a signal death as a
failure, and the async transfer path reports `code ?? signal`. Nothing books a
crashed transport as success.

Large tar transfers use a one-shot host-memory HTTP endpoint over the Parallels
host-only address. The guest's baked C-3 pf anchor contains a nested
`switchyard-transfer/*` anchor; each transfer loads one exact host/port pass
rule, then flushes it in a `finally` path. Tar bytes never enter `prlctl exec`
stdin and are never written to host disk.

There is no runtime credential-provisioning step. Provider auth is baked into
the golden image once, in-guest, by a human completing that provider's real
OAuth flow as the non-admin `switchyard` account, and every task-time clone
inherits that authenticated state directly (proven for `codex` via a real
clone-survival test — see `HISTORY.md`). `ParallelsExecutionBackend` still
exposes an unused compatibility `provisionCredentials()` primitive
(destination-allowlisted per provider, all-or-nothing per file, so a
half-provisioned home can never read as authenticated), but the default queue
backend does not call it — routing
instead admits only a provider on the golden-image-verified allowlist (see
"macOS queue admission and provider preflight" below), and each adapter's own
auth check still decides at exec time. A provider whose golden-image login was
never completed is reported, not swallowed, since a silently unauthenticated
guest is indistinguishable from a working one until a task dies at exec.

### macOS queue admission and provider preflight

macOS/Parallels is the only queue substrate; `--platform macos` is the default
and the CLI rejects any other value:

```sh
SWITCHYARD_PARALLELS_GOLDEN_IMAGE=<golden-vm-name> \
SWITCHYARD_PARALLELS_AQUA_UID=<uid> \
npm run dispatch -- <tasks.md> --project <path>
```

`SWITCHYARD_PARALLELS_GOLDEN_IMAGE` is required and has no default — a macOS
queue without it fails closed, because guessing at which VM to clone is not a
safe default. `SWITCHYARD_PARALLELS_AQUA_UID` is the auto-login account's uid
(`503` on the reference image, where the provider account is `switchyard`);
`SWITCHYARD_PARALLELS_PROVIDER_USER` overrides the account name. Both come from
the image `ops/macos-vm/build-golden-image.sh` produced — read them off the
guest with `id -u <account>` rather than assuming, since a rebuilt image can
allocate a different uid.

Before a working VM is created, `preflightMacosQueue()` (`router/index.mjs`)
reads one routing snapshot for every non-terminal capability tier and requires
at least one funded, adapter-available provider per tier that is also on the
**golden-image-verified allowlist** (`GOLDEN_IMAGE_VERIFIED_PROVIDERS`,
currently `["codex", "opencode-go", "vibe"]`). Probeable providers are
added only after their clone-survival test proves the golden image's baked-in
credential state — an OAuth session for Codex, a guest-keychain API key for
Vibe; OpenCode Go is admitted from its separate bounded BWS-bridge
qualification. A provider with quota and an
available adapter but no clone-survival proof is rejected
(`not_golden_image_verified`), not admitted on the assumption that it works.
This is a launch gate only: quota can drain while the queue runs, so passing
preflight does not guarantee every later task.

### Running Tests and Linting

**No hard prerequisite.** Most tests are pure-logic and need nothing installed. The live-VM gates (INV-3's `workspace-wipe-vm`, `parallels-backend`, and INV-1's `no-host-rights-vm`) probe for Parallels, a stopped golden image, and a free shared VM slot. There are exactly **two** VM slots because Apple's Virtualization.framework permits at most two concurrently running macOS guests per host; the count mirrors that platform ceiling and is not tunable. The slot locks live under `~/.switchyard/admission/`, so the pool is host-global: a dispatch running in any other session or project holds one of the same two slots, and `acquireVmSlot` fails fast rather than queueing. All of them still degrade to a recorded `skip` when a prerequisite is unavailable, so `npm test` stays safe on a machine with no Parallels VM. What changed for INV-1's `no-host-rights-vm` is narrower than "hard gate": its C-3 endpoint manifest is now derived and host-verified per run instead of read from `SWITCHYARD_PARALLELS_C3_*` env vars, and an empty manifest **fails** rather than skipping, so it holds on any network this Mac attaches to. Note that `SWITCHYARD_PARALLELS_AQUA_UID` is still a skip prerequisite: any non-interactive context that does not source the shell profile skips INV-1 silently. A skip costs coverage of the real boundary, not a red build; run `npm test` with the golden image available at least once per meaningful change to INV-1 or INV-3's lifecycle paths.

Execute the full suite of node unit and integration gate tests:

```bash
npm test          # test:serial (serialized), then test:other (dynamic) — both run unconditionally; exit = first non-zero phase
npm run validate  # lint + deadcode + npm test + real-roster coherence
npm run roster:coherence  # read-only gate; requires current dispatch_qualified evidence
```

`test:serial` runs the files that have shown Parallels/`prlctl`-daemon contention flakes (`tests/dispatch-cli.test.mjs`, `tests/detached-dispatch.test.mjs`, `tests/no-host-rights-vm.test.mjs`, `tests/workspace-wipe-vm.test.mjs`) at `--test-concurrency=1`, so they never contend with each other or with `test:other` (which runs after them); `test:other` dynamically derives every remaining `tests/*.test.mjs` at default concurrency. The named files are an exclusion list, not an inclusion list — a new test file runs by default unless it later shows contention of its own.

Run code quality check with Biome:

```bash
npm run lint
```

#### Git hooks

Husky installs two hooks from `.husky/`, wired by the `prepare` script on `npm install`:

| Hook | Runs | Why here |
| --- | --- | --- |
| `pre-commit` | `npm run lint` | Fast enough to sit in front of every commit. |
| `pre-push` | `npm run validate` | Lint, deadcode, the full suite, and roster coherence — the heavy gate, once per push. |

The hooks invoke the named scripts rather than restating their steps, so they cannot drift from the gate. That drift is the failure they exist to stop: `knip` went red at `a4138a5` and three commits landed on top of it before anyone ran `validate` by hand.

**These hooks are the whole enforcement story — there is no CI, by decision (2026-08-14), not by omission.** A GitHub runner could not exercise the live-VM gates against a real Parallels golden image, and this is a solo repo. The accepted cost: hooks are bypassable with `--no-verify`, and a fresh clone has none until `npm install` runs `prepare`. Run `npm install` before your first commit.

`pre-push` is safe without Parallels running. Every live-VM test guards on a Parallels/golden-image/VM-slot availability probe and degrades to a recorded skip, so a machine with no VM infra costs coverage, not a failed push — but a green push with no golden image booted has *not* exercised the live-VM gates. Boot the golden image before pushing anything that touches them.

When checking a gate from a script or a terminal, do not pipe it: `npm run validate 2>&1 | tail -60` reports **tail's** exit status, not the gate's. That is what hid the red build. Redirect to a file and check `$?`, or read `$pipestatus[1]` in zsh (`${PIPESTATUS[0]}` is the bash spelling and expands to nothing under zsh).

### Provider Authentication

There is no headless auto-login: every provider's real login step requires a human to complete a browser or device-code OAuth consent. `npm run auth` boots the golden image, checks each provider's real credential state, and for any that aren't authenticated (or answer live as expired) runs its real interactive login directly inside the booted guest so you can complete it live, then stops the image again:

```bash
npm run auth
```

For each provider that needs it (attached to your terminal, so follow the prompts — visit a URL, paste a code, approve in a browser): claude (`claude auth login`, subscription auth, not `--console`/API billing; copy the browser's **Authentication code** back into the terminal because browser authorization alone cannot complete login inside the VM), codex (`codex login --device-auth`, device-code flow), agy (plain `agy`, which starts its OAuth flow), cursor (`cursor-agent login`, no browser auto-open in-guest), and copilot (`copilot login --device-code`, forced device-code flow because a host browser cannot reach a guest-local loopback callback). OpenCode Go and Mistral do **not** use this walkthrough: their fixed BWS consumers inject API keys only into a disposable provider subprocess at dispatch time, and `npm run auth` skips their irrelevant OAuth prompt.

A completed login persists into the golden image's own disk, so every future clone inherits it (see "Parallels data plane" above) — you do not re-authenticate per dispatch, and you do not log in per working VM. Exits non-zero if any provider is still unauthenticated when it finishes.

**Caveat: provider OAuth sessions expire (on the order of days), so re-auth is periodic, not truly one-time.** Unlike a plain presence check, `npm run auth` gates login on a *live* probe (`auth/liveness.mjs`) — it re-checks `state.live` after a completed login too, so a login that "succeeds" but leaves an unusable session is not reported as fixed. Re-run `npm run auth` whenever a session may have expired; it will skip only a provider it can currently prove live.

Check auth status without attempting a login via `npm run auth:check`, or run `npm run auth:check:live` to probe each probeable provider against a booted golden image.

To qualify clone survival for queue admission, run the read-only clone qualification command:

```bash
node src/switchyard/auth/index.mjs --clone [--receipt <path>]
```

This creates one disposable full clone from the golden image, runs presence and live probes against every probeable provider inside the running guest (every provider whose `authMode` is not the BWS `ephemeral_api_key_dispatch` lane — which includes keychain-backed Vibe, not only the OAuth ones), reports BWS API-key lanes as unprobed, emits progress events to stderr and the terminal summary to stdout, and always destroys the clone in a finally block. Full cloning is required because Apple-VZ linked clones boot without a usable Guest Tools channel; APFS clonefile keeps the full-clone path fast and space-efficient. When invoked with `--receipt <path>`, it atomically writes a sanitized terminal qualification receipt to `<path>` after success or handled failure. The receipt contains only allowlisted fields: fixed `schemaVersion` (1), `providers` array (with provider `name`, boolean `authenticated`, boolean or null `live`, and optional `authMode` label), and a static terminal `errorKind` (`null` on success, `"clone_qualification_failed"`, or `"clone_execution_failed"`). The receipt never contains provider failure reasons, raw command output, credential values, workspace IDs, or VM names. It enforces a fail-closed admission boundary: the command exits non-zero (exit code 1) if any provider is unauthenticated, fails its live probe, or is an unprobed BWS lane.

Working VMs inherit the golden image's provider binaries and baked-in credential state directly through cloning — no per-VM credential step. Real full-clone dispatch canaries cover Codex and Vibe; Vibe's 2026-09-01 canary qualified `mistral-medium-3.5` at `standard` after the earlier GLM-5.2 label was found to be an entitlement the account does not hold. OpenCode Go uses its separate BWS bridge, and the remaining OAuth-backed providers require their own clone-survival proof (see "macOS queue admission and provider preflight" above).

### Queue Dispatching and Orchestration

The host-side runner parses markdown task queues and dispatches tasks serially through the router, adapters, and integration gate. It seeds a working VM from the project's committed tree, routes each task by usage headroom, runs the provider CLI headless inside the VM, returns the diff to the host only through the reviewed integration gate (INV-2), commits/resets the VM's baseline between tasks, and wipes the VM at the end (INV-3). All seven adapters execute commands with a 30-minute default execution timeout (`PROVIDER_EXECUTION_TIMEOUT_MS`, `1,800,000` ms) and 128 MB `maxBuffer` to prevent ENOBUFS errors and premature process termination on complex tasks — overridable per task via `- **Timeout:**` (see below). On a timeout, the adapter kills the orphaned in-VM process (the host-side kill alone doesn't forward the signal into it — see `adapter/orphan-kill.mjs` above) and the runner still captures whatever diff exists at that point as a review artifact — see "Timeout handling" below.

The thin CLI wraps `runQueue` for standalone use (the `--project` must be a git repo — its committed HEAD seeds each working VM):

```bash
npm run dispatch -- tasks.md --project /path/to/repo
# options: --max-tasks <n>  --checkpoint <path>  --no-stop-on-failure
#          --exclude-provider <name>  (repeatable — never route to this provider;
#          matches case-insensitively against both lowercase harness keys, e.g. "claude",
#          and the usage snapshot's title-cased provider names, e.g. "Claude")
#          --only-provider <name> / --provider <name>  (repeatable, aliases that
#          accumulate into one list — restrict routing to only these providers;
#          same target-id/harness-name/snapshot-name matching as --exclude-provider,
#          mutually exclusive with it)
```

Or call it programmatically:

```javascript
import { runQueue, runQueueWithOrchestrator } from './src/switchyard/runner/index.mjs';

// Standard queue runner with local checkpoint/resume (synchronous).
// Without `dependencies`, this uses the real router + live adapters — the
// working VM (workingContainerName) must already exist and have the
// provider CLI reachable inside it.
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

Each task declares `- **Executor:** native | switchyard | human`. `switchyard` implementation tasks must also declare `- **Files:**` (comma-separated project-relative paths), which is enforced at the integration gate: a diff that touches any path outside the declared allowlist — or fails to touch a declared path — is rejected, not silently accepted. Native and human tasks are never provider-routed and may omit `Files:`; review tasks are also exempt. A working tree is committed only on a task's success and reset on failure/rejection, so a bad diff never bleeds into the next task's baseline. The task's checkpoint entry (result + `completedTaskIds`) is saved to disk *before* that commit/reset runs, so a commit crash or external kill mid-commit can never leave a completed task outside the durable checkpoint; and a commit/reset failure halts the run (`halted_after_commit_failure`/`halted_after_reset_failure`) rather than dispatching the next task against a VM with an unadvanced or un-reset baseline — a later invocation on a fresh VM skips the checkpointed task and continues.

Each task's optional `- **Timeout:**` field (e.g. `90m`, `45s`, `2h` — a unit suffix is required, same as `Files:` rejecting ambiguous input) overrides `PROVIDER_EXECUTION_TIMEOUT_MS` for that task only, bounded to [1s, 24h] as a typo guard rather than a policy cap.

Each task's `- **RequiredCapability:**` field (`high` | `standard` | `low`) declares its INV-5 required capability up front. A declared capability always wins; explicit `high` or `low` declarations must include a non-empty `- **RequiredCapabilityJustification:**` field, and an unrecognized value fails loud (`parseRequiredCapabilityField`/`resolveTaskRequiredCapability`, `src/switchyard/runner/index.mjs`) before dispatch. Newly authored queues declare the field explicitly. Omission resolves to `standard` only to keep legacy queues readable. Description-based classifier entrypoints are retired and fail loud rather than inferring a route.

Queue selection is explicit and durable. `--task-id` selects only named tasks, while `Blocked by` dependencies and `External blockers` are validated before routing; native, human, unselected, externally blocked, and dependency-blocked tasks never reach a provider. A versioned `runOptions` record persists selection, `maxTasks`, checkpoint, stop-on-failure, and provider filters. The `queueIdentity` binds the run/checkpoint to canonical task content, the dependency/blocker graph, project revision, and normalized run options, so resume and detached worker state fail closed on a mismatch. `status` and `result` expose matching sanitized counts and static reasons for selection and gating, plus route target identity and snapshot diagnostics (`resolvedTargetId`, `snapshotStatus`, `snapshotMtime`, and `snapshotAgeMsAtRoute`).

Dispatch attempts record provider, model, resolved target, required capability, roster provenance, result, and safe failure metadata consistently across task results, checkpoints, events, both ledgers, and detached `status`/`result` envelopes. Failures retain closed-enum `errorKind`, `diagnosticCode`, numeric exit code, allowlisted signal, failure phase, static reason codes, and opaque artifact references; raw provider output, prompts, file contents, host paths, patches, and gate text are not persisted. Integration failures remain terminal and do not trigger provider fallback. Generic provider, transient, timeout, launch, and other prose cannot authorize a peer-provider retry; that path is closed until an explicit reviewed error-kind allowlist is populated. Quota exhaustion is classified only from provider-scoped, sanitized evidence and is persisted as the static `quota_exhausted` kind, and an unresolvable provider model on the same terms as the static `model_unavailable` kind; the owned-VM retry path quarantines one exact target, resets before rerouting, and fails closed on ambiguous identity, reset failure, caller-owned VMs, and untrusted orchestrator results. No live provider call is used to manufacture exhaustion, and each provider's credential status remains a separate operational fact.

An artifact reference is evidence of a captured non-empty diff, not proof that a provider completed successfully. A timeout may retain a partial diff for review; an integration rejection with no eligible diff has no artifact. The shared `headless-worktree` fallback also rejects malformed contracts before allocating a worktree or writing a receipt, so it currently has neither artifact nor durable fallback record. Treat a missing artifact as unavailable work evidence, never as success; the content-free failure-receipt follow-up is tracked in `TASKS.md`.

Automatic descriptor eligibility has a separate qualification contract. `probe_qualified` proves only read-only harness access; `dispatch_qualified` must identify the exact target, model, effort/variant, and validated invocation arguments. Selector-only legacy qualification keys remain readable for compatibility but never authorize automatic routing, the strict descriptor, or coherence paths. The loader applies the same 30-day freshness rule as `rosterlib.smoke` and invalidates qualified evidence on selector, CLI-version, wrapper-version, or credential-profile drift. `temporarily_unavailable`, `not_transmittable`, `stale`, malformed, and wrong-argv receipts fail closed. A nested atomic promotion receipt is checked when present; descriptor-keyed records are themselves treated as the v1 promotion receipt. The router requires an exact descriptor before selecting an automatic target, and each adapter validates and forwards only that descriptor's declared argv fragment. Wrapper or CLI changes therefore require an ordered requalification: refresh the signature, run the probe, complete a dispatch qualification for the exact descriptor, then promote the receipt.

Each task's optional `- **Type:**` field is `implementation` by default or `review`. Review tasks use the normal required-capability candidate ladder; `Type: review` adds no separate reviewer route or role flag. Only `switchyard` implementation tasks require `- **Files:**`; native and human implementation tasks may omit it, while review tasks remain exempt. For switchyard implementation tasks that touch a sensitive build or CI manifest, `- **AllowManifests:** true` is required in addition to listing that manifest in `Files:`. Either condition alone is rejected by the integration gate. An explicit `- **AllowManifests:** false` is accepted as an explicit no-op (behaving identically to omitting the field, granting no manifest authority), while non-boolean values fail closed at parse time.

### Timeout Handling

A task that overruns its timeout is not silently discarded. On `ETIMEDOUT`, the adapter kills the orphaned in-VM process before returning — the host-side kill alone doesn't forward the signal into whatever the provider CLI started, so the process would otherwise keep running unsupervised — then `executeTask` still captures the VM's current diff (`result: "execution_timed_out"`, `timedOut: true`). This diff is **never** passed through the integration gate (INV-2: it may be mid-edit or broken, and the gate is the only reviewed door back to the host), so it can never auto-apply as if the task had succeeded. It is persisted instead as a plain review artifact — `<checkpointPath>.partial-diffs/<taskId>.diff` locally, and copied into the run's `artifacts/` directory by the detached worker so it appears in `result`'s `artifactRefs` — for a human to review and apply manually if the work is salvageable.

The orphan-kill step (`adapter/orphan-kill.mjs`) also clears a stale `/project/.git/index.lock` left behind if the killed process was itself mid `git add`/`git commit` — empirically confirmed to otherwise make the diff-capture `git add -A` fail and silently return `null`, losing the whole partial diff via its catch-all. Safe specifically because it runs after every in-VM process has already been force-killed, so nothing can still legitimately hold the lock. If the rescue attempt still recovers nothing (no edits were made before the kill, or capture failed anyway), `runQueue` emits a distinct `partial_diff_capture_failed` status event and records `partialDiffPath: null` in checkpoint.json, rather than letting a failed rescue collapse silently into the generic `task_failed`.

### Detached Dispatch and Recovery

`launch` starts a task queue in a detached child process and returns immediately with a `runId`, instead of blocking the caller for the full run (useful under a harness with a bounded command timeout). The lifecycle is `launch` → poll `status` → `result` → (if needed) `recover`:

At cleanup start, the worker awaits durable `cleanupState: pending` persistence and propagates a write failure to the runner for truthful diagnostics; the teardown `finally` path still destroys the owned VM.

```bash
node src/switchyard/dispatch/index.mjs launch tasks.md --project /path/to/repo [--exclude-provider <name> | --only-provider <name>]
# => {"runId": "...", "state": "launcher_ready", "statusCommand": "...", "resultCommand": "..."}

node src/switchyard/dispatch/index.mjs status <run-id> --json
# => {"state": "running" | "succeeded" | "failed", "completedCount", "failedCount",
#     "workerLive" (signal-0 probe of the worker pid; null unless state is "running" —
#       distinguishes active work from a killed/ghost worker without shelling out to `ps`),
#     "activeTaskId", "activeTaskProvider", "activeTaskModel",
#     "activeTaskDeadline" (ISO timestamp, routed-at + PROVIDER_EXECUTION_TIMEOUT_MS),
#     -- aggregate stall-detection telemetry (added 2026-07-30, see "Stall-detection telemetry" below) --
#     "queueStartedAt", "elapsedMs", "totalTaskCount", "runningCount", "pendingCount",
#     "lastCompletionAt", "elapsedSinceLastCompletionMs", "activeTaskAgeMs", "activeTaskRemainingMs",
#     "providerProcessDetected" (guest `ps` presence probe, null unless state is "running"),
#     "queueIdentity", "queueDiagnostics" (sanitized selected/runnable/human-gated/
#     dependency-blocked/external-blocked counts and static reasons), "lastFailure", ...}

node src/switchyard/dispatch/index.mjs result <run-id> --json
# => adds terminalSummary (totalTasks/runnableTasks/processedTasks/completedTaskIds/failedCount) and artifactRefs
#    (same telemetry fields as status, above)

node src/switchyard/dispatch/index.mjs recover [--run <run-id>] [--state-root <path>]
# => reclaims orphaned managed VM workspaces and reconciles project locks and
#    recovery claims under the selected durable state root
```

Before running, `launch` records the worker's launch nonce and the project's current host git fingerprint (`git rev-parse HEAD` + `git status --porcelain`) in the run; `worker-bootstrap.mjs` re-verifies both on start and refuses to run (exit 3/4) if either has changed, so a worker never executes against a checkout other than the one it was launched against. Every terminal path — success, a failed task, or a crash — releases the run's lease and its project lock (a project allows only one active run at a time), and `recover` is the backstop for anything a hard kill (`SIGKILL`, host reboot) leaves behind: it only releases a lock it can prove is unowned by a live, still-active run, so recovering a stale run can never yank the lock out from under a different run that's genuinely still in progress.

`status` and terminal `result` add a bounded `disposition` object without changing existing fields or exit codes. Synchronous `run --json` emits exactly one terminal result-compatible envelope on success or failure; if no terminal record is readable it emits a pre-initialization envelope with `runId`, `stateRoot`, `statusCommand`, and `resultCommand` all null. Its stdout and stderr never include raw exception text. Without `--json`, a durable synchronous failure names its run ID. Legacy actions remain `monitor`, `defer`, `recover`, `repair_contract`, `target_failed`, `complete`, and `stop`. The projection is pure over validated durable evidence and uses this precedence: typed pre-initialization contract/lock facts; `recovery_required` or failed cleanup; pending cleanup while the worker is live or in startup grace; terminal cleanup incomplete with a dead worker (recover only when a state-root-bound command is present); live/startup-grace run progress (`retry_in_progress` when retry state is present, otherwise `run_in_progress`); a live project-lock owner; a dead nonterminal worker or expired launch (recover only with a required recovery command); successful terminal completion; closed contract diagnostics; exact descriptor-bound target failure; and finally fail-closed `stop` for missing or ambiguous evidence. Recovery commands are state-root-bound (`--state-root <path>`), and `target_failed` supplies only deduplicated, sorted, capped target IDs from existing descriptor-bound evidence; it never authorizes or selects a provider fallback. `result` retains exit 5 and no envelope for nonterminal runs.

The disposition schema is additive and closed:

```json
{"disposition":{"version":1,"action":"monitor|defer|recover|repair_contract|target_failed|complete|stop","direction":"repair_input|advance_authorized_fallback|recover_and_retry|retry_launch|wait|complete|stop","reasonCode":"closed_code","diagnosticCode":null,"taskId":null,"blockingRunId":null,"recoveryCommand":null,"failedTargetIds":[],"failedTargetIdsTruncated":false}}
```

`direction` is a pure total function of `(action, reasonCode, diagnosticCode)` in `baseDisposition`; an unenumerated tuple returns `stop`.

| Closed direction | Exact mapping |
|---|---|
| `repair_input` | Contract repair, or a target failure classified as required/undeclared/empty/no-op/seed/manifest/patch/conflict input evidence. |
| `advance_authorized_fallback` | A target failure classified as provider execution, exhaustion, cleanup, or diff-capture failure. This is run-local evidence only: it does not claim capacity exhaustion, authorize or select a route, or invoke a fallback. |
| `recover_and_retry` | Legacy `recover` with a state-root-bound recovery command; after recovery the caller re-enters normal preflight. |
| `retry_launch` | A terminal lock diagnostic without fresh holder classification; rerun normal launch preflight without acting on a stored holder identity. |
| `wait` | Legacy `monitor` or holder-aware pre-initialization `defer`. |
| `complete` | Legacy terminal `complete`. |
| `stop` | Authentication, containment refusal, recovery/cleanup failure, insufficient evidence, or any unknown tuple. |

| Evidence, in precedence order | Disposition |
|---|---|
| Typed pre-initialization contract failure | `repair_contract / invalid_invocation`, `queue_empty`, or `queue_identity_invalid` |
| Live/startup-grace project-lock owner | `defer / project_lock_owner_live` with `blockingRunId` |
| Proven-dead project-lock owner with a state-root-bound recovery command | `recover / project_lock_owner_dead` |
| Lock ownership unresolved, or dead owner without a recovery command | `stop / project_lock_ownership_unresolved` or `insufficient_evidence` |
| `recovery_required` or cleanup failed | `stop / recovery_incomplete` |
| Cleanup pending and worker `live` or `startup_grace` | `monitor / cleanup_in_progress` |
| Terminal cleanup incomplete and worker `dead`, with a recovery command | `recover / cleanup_incomplete` |
| Nonterminal worker `live` or `startup_grace`, with retry state | `monitor / retry_in_progress` |
| Nonterminal worker `live` or `startup_grace`, without retry state | `monitor / run_in_progress` |
| Dead nonterminal worker or expired null-PID launch, with a recovery command | `recover / worker_dead` |
| Succeeded with complete cleanup | `complete / run_succeeded` |
| Failed terminal record with a closed contract diagnostic | `repair_contract / <diagnosticCode>` |
| Exact descriptor-bound provider/integration target failure | `target_failed / <diagnosticCode-or-reasonCode>` |
| Terminal cleanup incomplete or dead-run recovery without a usable command | `stop / cleanup_incomplete` or `insufficient_evidence` |
| Missing, corrupt, ambiguous, or insufficient evidence | `stop / insufficient_evidence` |

Terminal `result` summaries retain their existing counts and add one closed `outcome`: `completed_work`, `no_runnable_work`, `failed_work`, `failed_before_work`, `recovered_dead_worker`, or `unknown_failure`. New terminal writes identify `terminalizedBy` as `worker` or `dead_worker_recovery`; missing or invalid historical evidence maps conservatively to `unknown_failure`. A recovery attempt writes `recovery_required`/`cleanupState: failed` when VM, lock, or ownership cleanup remains unresolved, which projects to `stop / recovery_incomplete` rather than another automatic loop.

`--exclude-provider <name>` (repeatable, works identically on `run` and `launch`) keeps the router from ever selecting that provider for the rest of the run. On the detached path the flag is persisted onto the run record at `launch` time and read back by `worker-bootstrap.mjs` — the worker process only receives `--state-root`/`--run-id`/`--nonce` on its own argv, so every other run parameter (this one included) has to reach it via the run record, not a CLI flag.

`--only-provider <name>` / `--provider <name>` (repeatable aliases accumulating into one allowlist; works identically on `run` and `launch`) is the inverse: routing is restricted to exactly the named provider(s), everything else is skipped. Mutually exclusive with `--exclude-provider` — passing both throws a `UsageError` before either reaches the router. Threaded through the exact same seam as `--exclude-provider` end to end (`dispatch/index.mjs` CLI parsing → the detached path's run-record persistence/read-back in `worker-bootstrap.mjs` → `runQueue`/`executeTask`'s `context.only` → `route()`'s `only` option), and reuses the same target-id-aware `providerMatches()` matching (a roster target id, a harness name, or a raw snapshot display name all work). Motivating case: pin dispatch to a specific subset (e.g. `claude` + `agy`) without hand-excluding every other provider one at a time.

#### Stall-detection telemetry

Added after a live multi-hour dispatch run produced only one completed task with no aggregate throughput signal to detect the stall from outside — a live provider process read as "progress" when nothing was actually completing. `status`/`result` now derive (`deriveTelemetryFields`, shared by both envelope builders so they can't drift):

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
| `providerProcessDetected` | Boolean guest `ps` presence probe (`probeProviderProcess`, via the execution backend's `inspectProcess`) for the active provider's binary inside the working VM; `null` unless `state === "running"`; never throws — degrades to `null` on a probe failure. Raw `ps` output never crosses into the envelope. |

`~/.agent/skills/switchyard/SKILL.md` documents interpretive guidance for these fields (e.g. when `elapsedSinceLastCompletionMs` should be treated as an actionable stall signal) for an orchestrating agent reading `status` output.

#### Lock Remediation

`acquireProjectLock` writes `projectPath` into a project lock's body. Recovery first reconciles recovery claims, then scans every on-disk project lock under the selected state root, while the candidate-run pass remains as a complementary path. Both use the shared `terminal_clean`/`live`/`startup_grace`/`dead`/`unknown` classifier and ownership-checked release; only a parseable lock with a resolvable `projectPath` and an eligible terminal or dead run is auto-reclaimed. Claims are atomically renamed before deletion, revalidated, and never overwrite a replacement lock. Unparseable, missing-projectPath, missing-run, live, startup-grace, unknown, and cleanup-failed records remain for human confirmation.

For the class of project lock orphaned on 2026-07-27 (predating `projectPath`), a separate standalone script handles one-time cleanup with a human in the loop:

```bash
node src/switchyard/dispatch/remediate-orphaned-locks.mjs --dry-run   # inspect the candidate set first
node src/switchyard/dispatch/remediate-orphaned-locks.mjs             # interactive, confirms before each removal
```

It recovers `projectPath` for the pre-`projectPath` lock shape from the run's own record, confirms it by recomputing the lock's expected filename hash against the file on disk, and still enforces the existing ownership-checked `releaseProjectLockIfOwnedBy` at the moment of deletion. This installation's own 6 locks from 2026-07-27 were, as it turned out, already cleared by the time this tool was built — see `HISTORY.md`'s 2026-07-31 entry — so `--dry-run` here now correctly reports zero candidates; the tool remains the safe path for the next time this class of lock turns up.

#### Scheduled reaping (idle autoclean)

A working VM orphaned by a hard kill is reclaimed on the next dispatch (the pre-run sweep), by an interactive `recover`, and by the SIGTERM/SIGINT owned-VM handler. For truly hands-off cleanup during long idle stretches, an optional launchd LaunchAgent runs a **standalone reaper** hourly (and at login):

```bash
sh ops/install-reaper.sh     # install/reload the com.zerodelta.switchyard.reaper LaunchAgent (idempotent)
sh ops/uninstall-reaper.sh   # remove it
launchctl kickstart gui/$(id -u)/com.zerodelta.switchyard.reaper   # run once now
# log: ~/Library/Logs/switchyard-reaper.log
```

`ops/switchyard-reaper.sh` reclaims liveness **purely from the managed VM name** — it runs `prlctl list -a`, parses each VM's name against the reserved `switchyard-work-<runId>-<creatorPid>` prefix, and probes the embedded PID with `kill -0`, force-removing (`prlctl stop --kill` then `prlctl delete`) only a proven-dead owner's VM. It reads no run store and no project code, which is deliberate: a background launchd agent cannot read the project tree under `~/Documents` without a Full Disk Access grant (macOS TCC), so the installer copies the reaper to `~/Library/Application Support/switchyard/` and it needs **no privilege grant** to run. Because it shares INV-3's PID-liveness rule, it is safe to run concurrently with live dispatches (a live owner's PID is always signalable, so its VM is skipped) and it never touches the golden image or any VM whose name doesn't match the reserved prefix. Its hardcoded `WORKING_PREFIX` is kept in sync with `PARALLELS_WORKING_PREFIX` in `src/switchyard/lifecycle/parallels-execution-backend.mjs` by a parity assertion in `tests/reaper-script.test.mjs`. It is intentionally narrower than `recover`: a VM whose name doesn't parse against the reserved prefix is skipped (the safe direction), left for interactive/pre-dispatch `recover`.

### Environment Variables

- `SWITCHYARD_ROSTER_PATH`: Optional override for the provider/harness capability roster file (`roster.json`). When unset (or empty), the loader resolves the canonical default `~/.agent/roster.json` via `os.homedir()`. Fail-loud loading is preserved: a missing or malformed roster at the resolved path (override or default) throws on load — there is never a silent fallback to an empty or wrong roster.
- `SWITCHYARD_ORCHESTRATOR_CMD`: Path to executable command (e.g. `switchyard-orchestrator`) for external job supervision when using `createCliOrchestrator`. If the orchestrator cannot run a task on the selected provider, the task remains incomplete and will retry against the same provider on every resume (no capability-discovery protocol exists to break the retry loop).
- `SWITCHYARD_RUN_STORE_ROOT`: Override for the run-store directory (`runs/`, `locks/`, and `.quarantine/` live under it; default `<project>/.logs/switchyard`). Primarily a test-isolation override; the detached worker sets it from its `--state-root`, and `remediate-orphaned-locks.mjs` honors it the same way.
- `SWITCHYARD_LEDGER_PATH`: Override for the legacy dispatch-ledger file path (default `~/.logs/switchyard/dispatch-ledger.jsonl`), resolved lazily at each read/write so tests can redirect it per run — mirrors the `SWITCHYARD_ROSTER_PATH`/`SWITCHYARD_RUN_STORE_ROOT` pattern.

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment invariants are backed by gate tests that exercise the real boundary against a live Parallels VM (INV-1's `no-host-rights-vm`, INV-3's `workspace-wipe-vm`), not by assertion alone.
