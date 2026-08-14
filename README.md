# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, Agy, Cursor, Copilot, Opencode) inside disposable, per-provider sandboxes. Threat model: **accident-containment, not adversary defense** — a coding agent that misbehaves (a runaway loop, a destructive command, a confused tool call) is confined to a throwaway container with no rights to the Mac host, rather than treated as a motivated attacker actively engineering an escape. The risk it exists to bound is mishap, not a targeted breakout.

**Status:** Phases 0-5 (provider dispatch engine) and the dispatch-reliability-consolidation Phases 1-5 (run store, diagnostics, labeled Docker lifecycle, Files enforcement, detached CLI, crash recovery) are implemented and test-covered; the full gate (`npm run validate` — lint + dead-code + tests) is green. **All six providers are wired end-to-end and proven live against the real agent image**: working containers are built `FROM ${AGENT_IMAGE}` (this dropped the earlier broken `FROM alpine:latest` + `--volumes-from` design, which shared no filesystem so the provider CLIs were unreachable — `HISTORY.md`'s 2026-07-26 Task 14 entry), so all six provider CLIs + git resolve on PATH inside them; every provider's credential *files* are provisioned container→container without touching host disk; and each of the six adapters (claude, codex, agy, cursor, copilot, opencode) has been live-verified to apply a real change captured as a `git diff` in a container (`HISTORY.md`'s 2026-07-26 Tasks 25/26). All six adapters perform real credential checks via `hasNonTrivialCredential()` alongside liveness checks. INV-1 is now expressed as its real contract — a working container has **no host bind mount** (the only mechanism by which a host FS path, the Docker socket, or a host credential dir could enter), verified via `docker inspect` — rather than the earlier incidental `/root/.config`-absence proxy that had constrained provisioning to claude only (`HISTORY.md`'s 2026-07-26 Task 26). The full **queue dispatch chain** is proven live end-to-end through both the synchronous and detached paths: a 2-task capstone seeds a working container from the host repo's committed tree (`seedProject`: `git archive HEAD` → in-memory tar → `docker cp`, no bind mount), runs real agent edits, captures the diff *staged* (so newly created files are included, not silently lost as `success_no_diff`), lands both tasks on the host through the reviewed, Files-target-enforcing integration gate, commits the container baseline between tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes the container (INV-3) — with the detached path (`launch` → `status` → `result` → `recover`) additionally proven to reach a clean terminal state, release every run lease and project lock, and leave no exact-labeled Docker object behind. Dispatch a queue synchronously with **`npm run dispatch -- <tasks.md> --project <path>`**, or detached with **`node src/switchyard/dispatch/index.mjs launch <tasks.md> --project <path>`**; check auth read-only (never a login) with **`npm run auth:check`**, or **`npm run auth:check:live`** to make each provider answer a real request.

The 2026-08-04 capability-reliability checkpoint adds explicit `RequiredCapability` and `Executor` placement, durable queue selection/dependency/external-blocker diagnostics, target-aware route provenance, and sanitized auth/integration failure metadata across task results, checkpoints, ledgers, events, and detached status/result. Its quota tranche now recognizes only provider-scoped, sanitized Agy and Cursor failure signatures, persists static `quota_exhausted` metadata, and gives an owned working container one crash-safe same-task retry: the canonical target is durably quarantined, the container is reset before reroute, exact allowlists remain in force, and status/result reconcile the checkpoint's transition state. Generic 4xx/429/rate-limit text, auth/integration failures, caller-owned containers, unknown targets, and the latent orchestrator path remain non-retryable. The evidence was collected at the provider boundary without persisting raw output or spending quota to manufacture exhaustion; the standing container's credential status remains an independent operational check.

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
| `package.json` | Node.js/ESM project config, biome + knip + husky devDependencies; `prepare` installs the git hooks on `npm install`. Test scripts serialize the three files that have shown Docker-daemon contention flakes: `test:docker` runs `dispatch-cli`, `lifecycle-recovery`, and `detached-dispatch` at `--test-concurrency=1`, and `test:other` dynamically derives every other `tests/*.test.mjs` — the three named files are an **exclusion** list, not an inclusion list, so a new test file runs by default. The split serializes only the recorded contention files; other container-backed tests (adapter dispatch, the INV-1/INV-3 gates) remain in `test:other` by design, so it is not a guarantee that nothing else touches Docker. `test` chains both (every test file exactly once); `validate` chains lint + deadcode + test. |
| `.husky/pre-commit`, `.husky/pre-push` | Git hooks (husky, wired by the `prepare` script). `pre-commit` runs `npm run lint`; `pre-push` runs `npm run validate`. Both call the named script instead of restating its steps so a hook cannot drift from the gate. See [Git hooks](#git-hooks). |
| `biome.json` | Biome linter/formatter config. |
| `knip.json` | Dead code / unused dependency detection. |
| `docker/Dockerfile` | Agent image build context: installs all six provider CLIs + git onto a pinned base, built to `switchyard-agent:latest` (the image every working container is derived from). |
| `ops/macos-vm/build-golden-image.sh` | Reproducible Parallels golden-image hardening recipe for the native macOS execution lane. |
| `ops/macos-vm/generate-cli-manifest.sh`, `ops/macos-vm/cli-manifest.txt` | Generator and its output: the pinned six-row installer manifest the golden-image build hash-verifies inside the guest. Public refs and digests only. |
| `ops/macos-vm/probe-guest-credentials.sh` | Measures, inside a guest and in the provider's Aqua session, where each of the six CLIs keeps credentials and whether a tar-provisioned copy actually authenticates. Prints no credential values. |
| **Source modules** | |
| `src/switchyard/router/index.mjs` | Provider selection: snapshot-backed spread routing, blind fallback, INV-4 compliance. Survivors of the exclude/only/capability/availability checks partition into three pools before a winner is picked: a **ranked pool** (roster `implementor_priority` set — the drain-to-0%-first "cheap implementor" waterfall) wins outright over a **spread pool** (every unranked provider, unchanged highest-headroom selection) whenever it's non-empty, which in turn wins over a **last-resort pool** (Cursor's `ap`/API window alone, gated by the ordinary `DEFAULT_FLOOR`). Ranked candidates are matched strictly by lowest `implementor_priority` number (never compared by headroom across ranks), with same-priority ties broken by the same scorer the spread pool's headroom ties use. `reason` reports which pool won: `priority_fill`, `spread`, or `last_resort_fallback`. Cursor's `ac`/`ap` snapshot windows are matched by `w.id`, never pooled or averaged. |
| `src/switchyard/router/scorer.mjs` | Capacity scoring: FNV-1a hash, mulberry32 PRNG, deterministic jitter. |
| `src/switchyard/roster/index.mjs` | Provider capability definitions and INV-5 capability filter, now loaded from the canonical `~/.agent/roster.json` default (resolved via `os.homedir()`), overridable by `SWITCHYARD_ROSTER_PATH`, lazy-loaded + memoized; a missing or malformed roster at the resolved path (override or default) fails loud on load — never a silent fallback to an empty or wrong roster. Preserves all pre-roster exports for backward-compatible caller interface. Dispatch records include provenance: roster identity (schema version + routing-stable sha) + resolved target/harness/selector. Low-capability lane eligibility (e.g. `opencode-go`) is entirely roster-driven through `passesCapabilityFilter` — there is no separate hardcoded spread ratio; INV-4's most-headroom spread still governs *which* eligible lane wins, cost never overrides it. `passesCapabilityFilter` throws on an unrecognized required capability rather than silently treating it as the lowest capability. Multiple targets may share a harness; the Gemini Antigravity target is enabled (re-enabled 2026-08-13 on Gemini 3.7 Flash) but holds no `dispatch_qualified` receipt, so it is roster-qualified and automatically ineligible at the same time, and Vibe is an enabled OpenCode-backed implementation target keyed by its exact `Vibe` snapshot name in the same state. The Antigravity Claude target remains eligible through `agy`. `codex-spark` is a further such precedent: a second, low-ceiling `codex`-harness target keyed by its exact `Codex (Spark)` snapshot name, enabled alongside the incumbent `codex` target but not yet automatically eligible until it earns its own current `dispatch_qualified` descriptor. Provider-specific effort/variant vocabularies and declarative adapter argv mappings are validated at the adapter boundary and forwarded verbatim only from the exact routed descriptor; unsupported intent remains disabled instead of crossing CLI labels. Automatic routing requires a current exact `dispatch_qualified` descriptor, so an enabled target without promoted evidence remains unavailable. `evaluateRealRosterCoherence()` and `npm run roster:coherence` require current exact `dispatch_qualified` descriptors for the low/standard/high automatic baseline and explicitly report missing canary evidence; Gemini Antigravity, Cursor, and Vibe are enabled but each still require their own current descriptor evidence before automatic dispatch. `resolveTargetId(identifier)` and the router's `providerMatches(identifier, name)` helper (`router/index.mjs`) retain target-id-aware matching for `--exclude-provider`/`--only-provider`, so an explicit selector cannot force a disabled target into routing. `getImplementorPriority(providerName)` exposes a target's optional `implementor_priority` (positive integer, lower drains first) the same snapshot-name-then-harness lookup way as `getCapabilityClass`/`getModelForCapability`, returning `null` for the unranked default — the router's priority-fill waterfall (see `router/index.mjs` above) is the sole consumer. |
| `src/switchyard/roster/classifier.mjs` | Keyword-based task-capability classifier (high/standard/low). |
| `src/switchyard/container/index.mjs` | Standing **agent** container lifecycle (Docker start/stop/exec). Wired into the runner's dispatch path; its image is the base every working container is built from. Also owns the authoritative `docker info`/`orb info` daemon preflight with a 5-second timeout and explicit binary-missing, daemon-unreachable, and other-exec-error classifications, plus `getPlatformInfo()`: host-vs-image Docker architecture comparison (Node `os.arch()` naming normalized against Docker's before comparing, so an amd64 host running an amd64 image doesn't false-positive a mismatch), surfaced as `platformInfo` in the dispatch status/result envelope; documents its own Rosetta limitation. |
| `src/switchyard/lifecycle/index.mjs` | **Working** container lifecycle, wired into the runner's real dispatch path: builds each per-project container `FROM ${AGENT_IMAGE}` on a Docker-managed `/project` volume (no host bind — INV-1), provisions all six providers' credential files container→container, **seeds** the container from the host repo's committed tree so `captureDiff` has a baseline (`seedProject`), **commits** the container baseline between queued tasks so multi-task diffs stay isolated (`commitWorkingTree`), and wipes at project end (INV-3). The sole surviving implementation after `sandbox/index.mjs` was deleted. |
| `src/switchyard/lifecycle/execution-backend.mjs` | `ExecutionBackend` contract and the behavior-preserving `DockerExecutionBackend`; the seam is defined before later backend/call-site conversion work. |
| `src/switchyard/lifecycle/parallels-execution-backend.mjs` | Task 4.1 Parallels lifecycle: UUID-backed clone/boot/destroy, Aqua readiness polling, exact-prefix PID reclamation, and golden-image safety refusals. No ownership sidecar is used. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): structural diff validation (`git apply --numstat`/`--summary`, not a content blocklist), path-escape/symlink/executable-file rejection, and explicit `allowSensitiveManifests` review for build/CI manifests, package manifests, and lockfiles. The runner accepts that opt-in only when `AllowManifests: true` and every manifest path is declared in the task's `Files:` list; an undeclared package or lock artifact is rejected by the exact allowlist before apply. Reviewed apply is via stdin. Apply is idempotent: a non-mutating `git apply --check` runs first, and when it fails a `--reverse --check` probe treats an already-applied diff as a successful no-op (`{alreadyApplied: true}`) with no mutating apply; a genuinely conflicting (or corrupt) diff fails with git's captured stderr as the `reason` and a `reasonKind` of `corrupt_patch` vs `conflict`. Patch normalization only adds a missing final newline and preserves valid one- and two-newline endings. The reviewed-gate contract is unchanged. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): the sanitized project-local intent receipt is authoritative and must complete before any provider execution/launch; outcome records are appended to the project-local store and projected to the legacy global ledger on a best-effort basis. Projection failures use bounded classifications and never change the authoritative launch gate. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateModelArg`) used by all six provider adapters. |
| `src/switchyard/adapter/prompt-guardrails.mjs` | Shared provider prompt guardrail: providers are told not to invoke package managers or modify undeclared manifests/lockfiles; the integration gate remains authoritative. |
| `src/switchyard/adapter/exec-error.mjs` | `describeExecError()`: turns a thrown `execFileSync` error from a NON-timeout provider failure into a diagnosable result — surfaces the provider CLI's own captured stdout/stderr instead of Node's generic "Command failed: docker exec…" wrapper, and recognizes an expired/failed auth session as a distinct `errorKind: "auth_expired"` with an actionable `docker exec -it` re-auth hint (`reauthHintFor`). Used by all six adapters' catch blocks; the timeout path is untouched (keeps `error.message` so `ETIMEDOUT` still classifies correctly). Two further kinds are classified only from provider-scoped, sanitized signatures and ranked below auth: `quota_exhausted`, and `model_unavailable` for a model the provider CLI refuses to resolve at all (added 2026-08-14 — agy fetches its model catalog live and falls back **silently** to the list compiled into the binary when that fetch does not succeed, so a fetch failure arrives disguised as an unknown model, otherwise indistinguishable from a model that ran and failed). `PERSISTED_ERROR_KINDS` is the closed vocabulary all three belong to; the provider's own words never cross the persistence boundary, so a new kind is the only channel a new cause can travel through. `auth/liveness.mjs` forwards this classification verbatim as its probe `kind`. |
| `src/switchyard/adapter/constants.mjs` | `PROVIDER_EXECUTION_TIMEOUT_MS` (30 minutes) — the shared host-side `execFileSync` kill timeout used by all six adapters as a default, overridable per task via `- **Timeout:**`; centralized so `runner/index.mjs` can compute an accurate `task_routed` deadline instead of drifting from a value duplicated per adapter. |
| `src/switchyard/adapter/orphan-kill.mjs` | Best-effort in-container process cleanup after a host-side `ETIMEDOUT`: `docker exec` does not forward host signals into the container's PID namespace, so each adapter calls this to kill whatever it started (`kill -TERM -1` then `kill -KILL -1`, sparing PID 1 — the container's keep-alive process) before the runner captures a diff. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, real credential check (`/root/.claude/.credentials.json`, persisted by `claude auth login`). |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch via `codex exec` (prompt over stdin), diff capture, real credential check (`/root/.codex/auth.json`, persisted by `codex login --device-auth`). |
| `src/switchyard/adapter/agy.mjs` | Antigravity (Agy) CLI adapter: dispatch (prompt via `--print` flag, not stdin — the CLI can't read it for this purpose), diff capture, real credential check (`/root/.gemini/antigravity-cli/antigravity-oauth-token`, persisted by agy's auto-triggered Google OAuth flow). |
| `src/switchyard/adapter/cursor.mjs` | Cursor Agent adapter: dispatch invokes `cursor-agent` directly, diff capture, real credential check via `cursor-agent status` text (persisted by `cursor-agent login`). |
| `src/switchyard/adapter/copilot.mjs` | Copilot CLI adapter: dispatch invokes `copilot`, diff capture, and an opaque credential-file check at `/root/.copilot/config.json` (the current device-flow store). |
| `src/switchyard/adapter/opencode.mjs` | Opencode CLI adapter: dispatch invokes `opencode`, diff capture, real credential check (`/root/.config/opencode`). |
| `src/switchyard/auth/index.mjs` | Walks a human through authenticating every provider that isn't already authenticated, by running each one's real interactive OAuth login inside the standing agent container. Run the walkthrough via `npm run auth`; `npm run auth:check` (`reportProviderStatus`) reports read-only per-provider status without ever attempting a login, and `npm run auth:check:live` adds one real request per provider. Presence is not liveness — a credential file survives an expired session, which is why the walkthrough itself now gates its login on a live probe (`auth/liveness.mjs`) rather than on the file. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). Wires all six adapters; `route()` is restricted to whichever adapters are actually present. Seeds, commits between tasks, and wipes the working container it creates — owns the container-wipe logic INV-3 governs (INV-3's area map includes this module). Parses `Type:` (`implementation` by default or `review`), requires `Files:` for implementation tasks, and parses `AllowManifests: true` as the explicit sensitive-manifest opt-in; the integration gate rejects any diff that doesn't exactly match the declared target paths (rename/delete included). Also parses an optional `Timeout:` field overriding `PROVIDER_EXECUTION_TIMEOUT_MS` per task; on a timeout the runner captures the diff as a review artifact instead of discarding it (never through the integration gate — see "Timeout Handling"). A tasks file that parses to 0 tasks fails closed (throws with the file path, detected heading count, and expected format) rather than silently reporting a 0/0 success, and always writes an auditable checkpoint first; a run also always leaves a final checkpoint on disk even when it reaches 0 runnable tasks without entering the per-task loop. The per-task checkpoint/result block — including failed/timed-out bookkeeping, on both the sync and orchestrator paths — is saved to disk **before** the working-container commit/reset, so a commit crash or external kill mid-commit can never leave a completed task outside the durable checkpoint; a commit/reset failure then halts the run (`halted_after_commit_failure`/`halted_after_reset_failure`) instead of dispatching the next task against a container with an unadvanced or un-reset baseline. Verified `quota_exhausted` failures on an owned container enter a checkpoint-authoritative, target-specific quarantine state, reset before one reroute, and never consume a second logical `maxTasks` slot; resume reconstructs an interrupted quarantine transition before selecting a target. Emits a `task_routed` event/callback (`{taskId, provider, model, deadline}`) synchronously right after routing, before the blocking (up to `PROVIDER_EXECUTION_TIMEOUT_MS`-long) adapter call. Fires a new `onContainerReady` callback unconditionally right after `workingContainerName` is resolved (both the freshly-created and pre-supplied-name branches), surfacing it into the run record. The authoritative project-local intent receipt is written synchronously before adapter execution or awaited before orchestrator launch; only outcome projections to the local/legacy ledgers are non-blocking/best-effort. `runQueue` and `runQueueWithOrchestrator` carry the same `only` and `exclude` provider filters into their route calls; the orchestrator context also carries the available adapter set. |
| `src/switchyard/dispatch/index.mjs` | CLI over `runQueue` with five subcommands: `run` (synchronous, `npm run dispatch -- <tasks.md> --project <path> [--max-tasks\|--checkpoint\|--no-stop-on-failure\|--exclude-provider\|--only-provider]`), `launch` (spawns a detached worker and returns immediately, same options), `status`/`result` (poll a run by id, read-only), and `recover` (reclaims orphaned Docker objects and stale project locks). `--only-provider`/`--provider` and `--exclude-provider` are mutually exclusive (throws a `UsageError` if both are given). Exits 2 on bad invocation / 1 if any task failed (`run` and `recover` both exit 1 on any failure). `status` exits 0 on success, 3 when the run id is not found, 4 on corrupt/unsupported run state; `result` adds 5 when the run is not yet terminal, and exits 1 unless the terminal run succeeded with cleanup complete. `status`/`result` share a `deriveTelemetryFields(run, events, checkpointState)` helper that derives the aggregate stall-detection fields and overlay the checkpoint's `quarantinedTargetIds`, in-flight retry state, and monotonic transition ID — see "Detached Dispatch and Recovery" below for the full field list. The synchronous `run` subcommand acquires the exclusive project lock before queue execution and releases it (ownership-checked) on every terminal path, so a second concurrent `run` against the same project fails fast instead of racing the checkpoint file. Its pre-dispatch retention sweep (`applyRetention`, incl. malformed-record quarantine) runs before synchronous dispatch; the detached `launch` worker performs the same schema-only quarantine sweep during bootstrap. Also owns `releaseOrphanedProjectLocks()` (direct-scan recovery for parseable, dead, `projectPath`-bearing locks — see `run-store/index.mjs` below). |
| `src/switchyard/dispatch/worker-bootstrap.mjs` | The detached child process a `launch` spawns. Verifies the worker nonce and host git fingerprint match what `launch` recorded (mismatch = exit 3/4, refuses to run against a different checkout), claims the run lease, advances state to `running`, runs `runQueue` synchronously, then writes the terminal state via `updateRunWithRetry` and releases the run lease and project lock on every path — success, task failure, and crash. Its fire-and-forget event callbacks (`onTaskStart`, `onTaskRouted`, `onResult`, `onCheckpointSaved`, and retry-state projection) also go through `updateRunWithRetry` rather than a fixed-revision `updateRun`: `onTaskStart` and `onTaskRouted` fire microseconds apart (routing is synchronous, ahead of the blocking adapter call), so a fixed revision would let one silently lose the race and drop `activeTaskId` or `activeTaskProvider`/`Model`/`Deadline` from `status`. All callbacks additionally chain onto a module-scope `writeChain` promise at fire time (not just `updateRunWithRetry`'s per-call retry), so submission-order write ordering is guaranteed even when two callbacks' internal `readRun()`s could otherwise resolve out of order — `updateRunWithRetry` alone prevents a write from being lost, not from landing out of order. `writeFatalEvent` constructs a real `Diagnostics` instance and emits the actual `Error` object (not `.message`), so secret-bearing error text is redacted before it reaches `events.jsonl`; awaits `Diagnostics.emit()` (now async) before `process.exit(1)`. Reads `run.excludeProviders` and passes it into `runQueue({ exclude })`. |
| `src/switchyard/run-store/index.mjs` | Versioned, file-backed run state under `.logs/switchyard/runs/<runId>/{run.json,events.jsonl}`. Writes are atomic (unique tmp path per write, never a fixed/shared one) and optimistic-concurrency checked (`updateRun` throws `RevisionError` on a stale `expectedRevision`); concurrent `updateRun` calls for the same run are serialized through an in-process per-runId queue, so a losing writer gets an honest error instead of silently clobbering another writer's data. `updateRunWithRetry` re-reads and retries on conflict for a caller whose write must win. `validateRun` type-checks every run-record field, including active task telemetry and the sanitized retry projection (`quarantinedTargetIds`, `retryState`, `retryTransitionId`), rejecting a wrong-typed write with `SchemaError` rather than corrupting `run.json` silently. Also owns run leases (`acquireRunLock`/`releaseRunLock`/`renewRunLock`/`isRunLockExpired`), launch locks (dedup concurrent launches against the same task file), and project locks (`acquireProjectLock`/`releaseProjectLock`/`releaseProjectLockIfOwnedBy`, one active run per project — lock bodies now carry `projectPath`, not just `{runId, createdAt}`, so an orphaned lock whose run directory is gone can still be identified) plus retention (`applyRetention`), which now returns `{deletedCount, quarantined}` and quarantines malformed run records (invalid JSON, unsupported schema version, `SchemaError` validation failures) — an atomic rename to `.quarantine/<runId>/`, never deletion, on every sweep (`dryRun` suppresses only valid-run deletion, never quarantine); destinations are collision-safe (a pre-existing `.quarantine/<name>` is never overwritten — a unique suffixed destination is allocated instead) and reported as a raw on-disk `destination` plus a separately sanitized `destinationDisplay` safe for logs/terminal; reasons are static strings (only `SchemaError`'s own non-content-derived message — raw error or file content never appears). Runs that fail to read for non-validation reasons — absent `run.json` (ENOENT, e.g. a concurrent `initializeRun` mid-flight), EACCES, EIO — are conservatively left in place and re-skipped, since none of those signals proves corruption. |
| `src/switchyard/dispatch/remediate-orphaned-locks.mjs` | Standalone, human-confirmed CLI for reclaiming project locks a `releaseOrphanedProjectLocks()` scan can't safely auto-reclaim (unparseable body, missing `projectPath`, or `projectPath`-known-but-run-record-gone). Not wired into `dispatch/index.mjs`'s subcommand table. Always resolves candidates fresh from disk, prints the full candidate set (hash, age, recovered `projectPath`) before touching anything, and requires explicit interactive confirmation per lock — every removal still goes through the existing ownership-checked `releaseProjectLockIfOwnedBy`. Run with `--dry-run` first, then a bare interactive run: `node src/switchyard/dispatch/remediate-orphaned-locks.mjs [--dry-run]`. |
| `src/switchyard/diagnostics/index.mjs` | Safe event/error channel for the run store's `events.jsonl`: serializes an `Error` to an allowlisted field set (`name`, `message`, `code`, `phase`, `taskId`, `provider`, `model`, `exitStatus`) and redacts any string matching the `SECRET_CANARY_` test pattern, so a diagnostic event can never leak a secret into the durable log. |
| **Tests** | |
| `tests/capability-match.test.mjs` | INV-5 gate: capability filter, capability ordering, model right-sizing. |
| `tests/classifier.test.mjs` | Keyword-based task capability classifier unit tests. |
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
| `tests/auth-check.test.mjs` | `ensureProvidersAuthenticated` + `reportProviderStatus` (the read-only `auth:check`) unit tests via injected fake providers (no real Docker needed), including regressions for a provider's `runLogin()`/`isAuthenticated()` throwing without aborting the rest, and that the read-only report never triggers a login. Liveness gating (a present-but-dead credential must trigger the login; a quota-exhausted provider must not) lives here too. |
| `tests/auth-liveness.test.mjs` | The liveness probe's decision logic through its `run` seam: what counts as an answer (a positive `OK`, with the echoed prompt stripped first), what an expired session vs. a timeout is classified as, and that all six providers carry an empirically-confirmed invocation. |
| `tests/shell-safety.test.mjs` | Unit tests for the shared `validateIdentifier`/`validateModelArg` shell-interpolation guards used by all six adapters. |
| `tests/container.test.mjs` | `getPlatformInfo()` host-vs-image architecture comparison: Node/Docker naming normalization (no false mismatch on an amd64 host running an amd64 image), correct mismatch on an arm64 host running an amd64 image, explicit `execFn`/timeout/args-array injection, graceful degrade (never throws) on a probe failure. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: exercises the real `createWorkingContainer` and asserts the working container has no host FS mount, no Docker socket, and no host credential paths. |
| `tests/credential-provision.test.mjs` | Exercises the real `provisionCredentials` container→container copy for all six providers with dummy non-secret sentinels: every credential file round-trips to its correct path, sibling conversation/project state does **not** bleed into the working container (cred-bleed regression), an absent source is a clean no-fabrication skip, and an unsafe container name is rejected before any docker call. |
| `tests/project-seed.test.mjs` | Exercises the real `seedProject`/`commitWorkingTree` against a live working container: the host committed tree (incl. nested and force-added-ignored files) reproduces inside `/project` with a clean single-commit baseline, a newly created file surfaces in the staged capture (finding #1), and committing between tasks isolates the next task's diff (finding #3). Identifier-validation cases always run without Docker. |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5, adapter-availability filtering, blind fallback. Also covers the implementor-priority waterfall: a ranked provider beating a higher-headroom unranked one, strict waterfall order across multiple ranks regardless of headroom, the ranked 0% floor (vs the unranked 5% `DEFAULT_FLOOR`), Cursor's un-pooled `ac`/`ap` split (`ac` ranked, `ap` last-resort-only, each gated by its own floor), the `priority_fill`/`last_resort_fallback` reasons, and a same-priority tie-break via the scorer (against a dedicated fixture, `roster.priority-tiebreak.fixture.json`, so it can't collide with the shared fixture's other headroom-based assertions). |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume (atomic writes), stopOnFailure/gate-failure handling, headroom-routing mechanism, seed/commit/wipe lifecycle wiring + call order, per-task commit for multi-task isolation, progress hooks (including `onTaskRouted`/`task_routed` firing before the blocking adapter call), orchestrator CLI integration, orchestrator status/result error guards, fail-closed 0-task parse (both `runQueue` and `runQueueWithOrchestrator`), and always-leaves-a-checkpoint on a 0-runnable-task completion. |
| `tests/dispatch-cli.test.mjs` | `parseDispatchArgs` unit tests (no Docker): valid invocation + defaults, `--help`, `--max-tasks`/`--checkpoint`/`--no-stop-on-failure`, and each rejection path (missing tasks/`--project`, non-file tasks, non-git project, non-positive `--max-tasks`). |
| `tests/scorer.test.mjs` | FNV-1a hash, mulberry32 PRNG, and scoring logic unit tests. |
| `tests/workspace-wipe.test.mjs` | INV-3 gate: exercises the real `wipeWorkingContainer` — the working container is wiped, the standing agent container survives. Labeled-lifecycle regressions: managed-label presence on containers/volumes, exact-name matching (substring-overlap regression), idempotent repeated wipe. |
| `tests/run-store.test.mjs` | INV-6 gate: atomic writes (unique tmp path per write, no shared-path ENOENT collisions under 40 concurrent writers), revision-checked `updateRun` (throws `RevisionError` on mismatch, serializes racing same-revision callers so exactly one wins), `updateRunWithRetry`'s authoritative write surviving a losing race, two concurrent `updateRunWithRetry` callers touching different fields both surviving (the `onTaskStart`/`onTaskRouted` race regression), run leases, launch locks, project locks (including `releaseProjectLockIfOwnedBy`'s ownership check and `projectPath` presence in newly acquired locks), `validateRun` rejecting wrong-typed telemetry fields, `releaseOrphanedProjectLocks()`'s direct-scan recovery (a live run's lock untouched, unparseable/no-`projectPath`/missing-run-record locks never auto-reclaimed), and retention. |
| `tests/worker-bootstrap-write-chain.test.mjs` | `writeChain` causal-ordering regression: interleaves two tasks' callbacks (`onTaskStart`/`onTaskRouted`/`onResult`/`onCheckpointSaved`) against a real run-store and asserts `activeTaskId` is never observed null/stale while a later task is actively running — exercises the actual race (two `updateRunWithRetry` calls whose internal `readRun()`s could resolve out of order), not just the happy path. |
| `tests/remediate-orphaned-locks.test.mjs` | `remediate-orphaned-locks.mjs` CLI regression: candidate resolution always fresh from disk, pre-`projectPath` lock shape recovered via the run record and confirmed against the lock's expected filename hash, no removal without explicit confirmation, ownership check still enforced at deletion time. |
| `tests/detached-dispatch.test.mjs` | End-to-end `launch`/`status`/`result`/`recover` CLI regression: nonce and host-fingerprint verification, terminal-state project-lock release, `recover` reclaiming stale locks from dead/terminal runs via `isWorkerLive` without touching a lock owned by a different currently-active run, the `status`/`result` envelope's `workerLive`/`activeTaskProvider`/`activeTaskModel`/`activeTaskDeadline` fields for live, ghost (dead pid), and non-running runs, and both `--exclude-provider` and `--only-provider` working identically on the foreground and detached worker paths (each proven against a real two-provider snapshot fixture through the actual detached worker, not mocked). |
| `tests/lifecycle-recovery.test.mjs` | `recoverManagedObjects` crash-matrix regression: 5 crash points (pre-claim, pre-container, post-create, mid-integration, mid-cleanup), orphaned container/volume reclamation, bounded recovery. |
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
installs the six provider CLIs without authentication, pins
the requested iOS runtime, disables the guest clipboard agent, and loads the
guest-side C-3 pf anchor. It restarts before the final Aqua, transport,
clipboard, pf, memory, and network assertions.

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
ops/macos-vm/generate-cli-manifest.sh                 # refresh all six rows
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
backend uses. Without it the image ships six CLIs that are present on disk and
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

The verdicts are recorded in `ops/macos-vm/tar-provision-manifest.json`, which is
what the macOS queue preflight admits on. Override it with
`SWITCHYARD_MACOS_TAR_PROVISION_MANIFEST` after re-measuring against a different
image; a manifest that is absent or unparseable rejects every provider rather
than guessing.

Vendor documentation, for contrast with what was measured:
[Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started),
[Codex auth storage](https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs),
[Antigravity CLI auth](https://antigravity.google/docs/cli-install),
[Cursor authentication](https://docs.cursor.com/en/cli/reference/authentication),
[Copilot credential storage](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli),
[OpenCode providers](https://opencode.ai/docs/providers).

### Execution backend contract

The lifecycle backend seam is defined by `ExecutionBackend`: `DockerExecutionBackend` supplies Docker's command prefix, workspace creation/destruction, tar transfer, managed-object listing, and process inspection. `execArgv(workspaceId, {cwd})` has no mode or session parameter. Honoring `cwd` is each backend's obligation; `prlctl exec` has no working-directory field and enters a different launchd domain from the Aqua domain required by the provider.


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
/bin/bash -lc ...`, with an explicit `cd <cwd>` shim. This is intentionally the
measured Aqua-session route; the earlier LaunchAgent/`launchctl bootstrap` D-5
requirement was withdrawn because it could not provide the provider's stdin,
incremental output, exit status, or killable process handle.

Large tar transfers use a one-shot host-memory HTTP endpoint over the Parallels
host-only address. The guest's baked C-3 pf anchor contains a nested
`switchyard-transfer/*` anchor; each transfer loads one exact host/port pass
rule, then flushes it in a `finally` path. Tar bytes never enter `prlctl exec`
stdin and are never written to host disk. The VM credential hop reads only the
five measured-provisionable stores from the standing Docker vault into memory,
one file at a time, and the backend owns the destination allowlist so a caller
can pick from the measured layout but never name a path. A provider whose layout
is only partly present in the vault fails before anything reaches the guest:
Claude needs two files, and a half-provisioned home reads as authenticated and
is not. `cursor-agent` fails closed before execution rather than being reported
authenticated from the vault alone.

Because the VM workspace is created before routing picks a provider, all five
are seeded at creation time and each adapter's own auth check decides at exec —
the same contract the Docker lane has. A provider the vault was never logged in
to is reported, not swallowed, since a silently unauthenticated guest is
indistinguishable from a working one until a task dies at exec.

### macOS queue admission and provider preflight

Select the native queue substrate explicitly:

```sh
npm run dispatch -- <tasks.md> --project <path> --platform macos
```

Before a macOS workspace or VM slot is created, Switchyard reads one routing
snapshot for every non-terminal capability tier and requires at least one
funded, adapter-available, tar-provisionable provider for each tier. The
verified evidence is `ops/macos-vm/tar-provision-manifest.json`, which records
the guest measurement above one provider at a time, with the check that produced
each verdict. Point `SWITCHYARD_MACOS_TAR_PROVISION_MANIFEST` (or the equivalent
injected runner dependency) at your own after re-measuring against a different
image; the minimal accepted shape is:

```json
{"verified":true,"providers":["codex","opencode"]}
```

An unverified or unparseable manifest, a missing snapshot, or an unsatisfied
tier fails closed before admission. This is a launch gate only: quota can drain
while the queue runs, so passing preflight does not guarantee every later task.
Until the shipped manifest existed there was nothing to point at and the default
macOS path rejected every provider with `tar_provisionability_unverified`.
Docker queues retain their existing preflight no-op.

### Running Tests and Linting

**Prerequisite — Docker daemon (OrbStack).** The container-backed tests (adapter dispatch, and the INV-1 `no-host-rights` / INV-3 `workspace-wipe` gates) shell out to real `docker run`/`docker exec`, so the daemon must be up or those tests fail with `Command failed: docker run ...`. This project uses **OrbStack** as the Docker runtime (plan decision D-2). If it isn't running, start it before running the suite:

```bash
open -a OrbStack   # start OrbStack if the daemon isn't already up
until docker info >/dev/null 2>&1; do sleep 1; done   # wait for readiness
```

The pure-logic tests (router, roster, classifier, ledger, integration-gate, shell-safety) run without Docker; only the container-backed ones require it.

Execute the full suite of node unit and integration gate tests:

```bash
npm test          # test:docker (serialized), then test:other (dynamic) — all 44 files, each exactly once
npm run validate  # lint + deadcode + npm test + real-roster coherence
npm run roster:coherence  # read-only gate; requires current dispatch_qualified evidence
```

`test:docker` runs the three files that have shown Docker-contention flakes (`tests/dispatch-cli.test.mjs`, `tests/lifecycle-recovery.test.mjs`, `tests/detached-dispatch.test.mjs`) at `--test-concurrency=1`, so they never contend for the daemon with each other or with `test:other` (which runs after them); `test:other` dynamically derives every remaining `tests/*.test.mjs` at default concurrency. Other container-backed tests (adapter dispatch, the INV-1/INV-3 gates) intentionally remain in `test:other` — the split serializes the recorded contention files, not all Docker usage. The three named files are an exclusion list, not an inclusion list — a new test file runs by default unless it later shows Docker contention of its own.

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

**These hooks are the whole enforcement story — there is no CI, by decision (2026-08-14), not by omission.** A GitHub runner could not exercise the container-backed gates against OrbStack, and this is a solo repo. The accepted cost: hooks are bypassable with `--no-verify`, and a fresh clone has none until `npm install` runs `prepare`. Run `npm install` before your first commit.

`pre-push` is safe without Docker. Every container-backed test guards on `isContainerRuntimeAvailable()` (or a `docker info` probe) and degrades to `describe.skip`, so a stopped daemon costs coverage, not a failed push — but a green push with OrbStack down has *not* exercised the container gates. Start OrbStack before pushing anything that touches them.

When checking a gate from a script or a terminal, do not pipe it: `npm run validate 2>&1 | tail -60` reports **tail's** exit status, not the gate's. That is what hid the red build. Redirect to a file and check `$?`, or read `$pipestatus[1]` in zsh (`${PIPESTATUS[0]}` is the bash spelling and expands to nothing under zsh).

### Provider Authentication

There is no headless auto-login: every provider's real login step requires a human to complete a browser or device-code OAuth consent. `npm run auth` checks each provider's real credential state and, for any that aren't authenticated, opens its real interactive login inside the standing agent container so you can complete it live:

```bash
npm run auth
```

For each unauthenticated provider it runs (attached to your terminal, so follow the prompts — visit a URL, paste a code, approve in a browser):

| Provider | Run from a host terminal |
|---|---|
| claude | `docker exec -it switchyard-agent claude auth login` (subscription auth, not `--console`/API billing) |
| codex | `docker exec -it switchyard-agent codex login --device-auth` (device-code flow) |
| agy | `docker exec -it switchyard-agent agy --print hi` (triggers OAuth when needed) |
| cursor | `docker exec -it -e NO_OPEN_BROWSER=1 switchyard-agent cursor-agent login` |
| copilot | `docker exec -it switchyard-agent copilot login` |
| opencode | `docker exec -it switchyard-agent opencode auth login` |

A completed login persists to the provider CLI's own credential store inside the standing agent container (which is never wiped, unlike working containers — INV-3), so it holds across many tasks — you do not re-authenticate per dispatch. Exits non-zero if any provider is still unauthenticated when it finishes.

**Caveat: provider OAuth sessions expire (on the order of days), so re-auth is periodic, not truly one-time.** `npm run auth` checks each credential's *presence and substance* (the file exists and isn't a trivial stub), **not** its *liveness* against the provider's API — a real validity check would need an unreliable in-container network round-trip. So an expired-but-still-present token reads as authenticated and `npm run auth` will **skip** re-login for it. When a session has actually expired, force a fresh login directly against the standing agent container — e.g. `docker exec -it switchyard-agent claude auth login` — from a **real terminal** (an interactive `-it` exec needs a TTY, which a non-interactive/piped shell can't allocate).

Working containers (where real dispatches actually run) are built `FROM ${AGENT_IMAGE}`, so they carry the agent container's provider binaries directly (`HISTORY.md`'s 2026-07-26 Task 14). Credentials are provisioned as a separate container→container step: every provider's credential *files* (files only, not whole directories — so no conversation/project state bleeds into a disposable container) are copied into each working container, so a real end-to-end dispatch works today for **all six** providers, each live-verified to apply a `git diff` in a container (`HISTORY.md`'s 2026-07-26 Tasks 25/26).

### Queue Dispatching and Orchestration

The host-side runner parses markdown task queues and dispatches tasks serially through the router, adapters, and integration gate. It seeds a working container from the project's committed tree, routes each task by usage headroom, runs the provider CLI headless inside the container, returns the diff to the host only through the reviewed integration gate (INV-2), commits the container baseline between tasks, and wipes the container at the end (INV-3). All six container adapters execute commands with a 30-minute default execution timeout (`PROVIDER_EXECUTION_TIMEOUT_MS`, `1,800,000` ms) and 128 MB `maxBuffer` to prevent ENOBUFS errors and premature process termination on complex tasks — overridable per task via `- **Timeout:**` (see below). On a timeout, the adapter kills the orphaned in-container process (`docker exec` does not forward host signals into the container) and the runner still captures whatever diff exists at that point as a review artifact — see "Timeout handling" below.

The thin CLI wraps `runQueue` for standalone use (the `--project` must be a git repo — its committed HEAD seeds each working container):

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

Each task declares `- **Executor:** native | switchyard | human`. `switchyard` implementation tasks must also declare `- **Files:**` (comma-separated project-relative paths), which is enforced at the integration gate: a diff that touches any path outside the declared allowlist — or fails to touch a declared path — is rejected, not silently accepted. Native and human tasks are never provider-routed and may omit `Files:`; review tasks are also exempt. A working tree is committed only on a task's success and reset on failure/rejection, so a bad diff never bleeds into the next task's baseline. The task's checkpoint entry (result + `completedTaskIds`) is saved to disk *before* that commit/reset runs, so a commit crash or external kill mid-commit can never leave a completed task outside the durable checkpoint; and a commit/reset failure halts the run (`halted_after_commit_failure`/`halted_after_reset_failure`) rather than dispatching the next task against a container with an unadvanced or un-reset baseline — a later invocation on a fresh container skips the checkpointed task and continues.

Each task's optional `- **Timeout:**` field (e.g. `90m`, `45s`, `2h` — a unit suffix is required, same as `Files:` rejecting ambiguous input) overrides `PROVIDER_EXECUTION_TIMEOUT_MS` for that task only, bounded to [1s, 24h] as a typo guard rather than a policy cap.

Each task's optional `- **RequiredCapability:**` field (`high` | `standard` | `low`) declares its INV-5 required capability up front. A declared capability always wins; explicit `high` or `low` declarations must include a non-empty `- **RequiredCapabilityJustification:**` field, and an unrecognized value fails loud (`parseRequiredCapabilityField`/`resolveTaskRequiredCapability`, `src/switchyard/runner/index.mjs`) before dispatch. Omit the capability field to use the standard lane. The keyword classifier remains available for legacy direct callers, but is not used as a queue-routing fallback.

Queue selection is explicit and durable. `--task-id` selects only named tasks, while `Blocked by` dependencies and `External blockers` are validated before routing; native, human, unselected, externally blocked, and dependency-blocked tasks never reach a provider. A versioned `runOptions` record persists selection, `maxTasks`, checkpoint, stop-on-failure, and provider filters. The `queueIdentity` binds the run/checkpoint to canonical task content, the dependency/blocker graph, project revision, and normalized run options, so resume and detached worker state fail closed on a mismatch. `status` and `result` expose matching sanitized counts and static reasons for selection and gating, plus route target identity and snapshot diagnostics (`resolvedTargetId`, `snapshotStatus`, `snapshotMtime`, and `snapshotAgeMsAtRoute`).

Dispatch attempts record provider, model, resolved target, required capability, roster provenance, result, and safe failure metadata consistently across task results, checkpoints, events, both ledgers, and detached `status`/`result` envelopes. Auth and integration failures use closed-enum `errorKind`/reason codes and opaque artifact references; raw provider output, prompts, file contents, host paths, patches, and gate text are not persisted. Integration failures remain terminal and do not trigger provider fallback. Quota exhaustion is classified only from provider-scoped, sanitized evidence and is persisted as the static `quota_exhausted` kind, and an unresolvable provider model on the same terms as the static `model_unavailable` kind; the owned-container retry path quarantines one exact target, resets before rerouting, and fails closed on ambiguous identity, reset failure, caller-owned containers, and untrusted orchestrator results. No live provider call is used to manufacture exhaustion, and the standing container's credential status remains a separate operational fact.

Automatic descriptor eligibility has a separate qualification contract. `probe_qualified` proves only read-only harness access; `dispatch_qualified` must identify the exact target, model, effort/variant, and validated invocation arguments. Selector-only legacy qualification keys remain readable for compatibility but never authorize automatic routing, the strict descriptor, or coherence paths. The loader applies the same 30-day freshness rule as `rosterlib.smoke` and invalidates qualified evidence on selector, CLI-version, wrapper-version, or credential-profile drift. `temporarily_unavailable`, `not_transmittable`, `stale`, malformed, and wrong-argv receipts fail closed. A nested atomic promotion receipt is checked when present; descriptor-keyed records are themselves treated as the v1 promotion receipt. The router requires an exact descriptor before selecting an automatic target, and each adapter validates and forwards only that descriptor's declared argv fragment. Wrapper or CLI changes therefore require an ordered requalification: refresh the signature, run the probe, complete a dispatch qualification for the exact descriptor, then promote the receipt.

Each task's optional `- **Type:**` field is `implementation` by default or `review`. Review tasks use the normal required-capability candidate ladder; `Type: review` adds no separate reviewer route or role flag. Only `switchyard` implementation tasks require `- **Files:**`; native and human implementation tasks may omit it, while review tasks remain exempt. For switchyard implementation tasks that touch a sensitive build or CI manifest, `- **AllowManifests:** true` is required in addition to listing that manifest in `Files:`. Either condition alone is rejected by the integration gate.

### Timeout Handling

A task that overruns its timeout is not silently discarded. On `ETIMEDOUT`, the adapter kills the orphaned in-container process before returning — `docker exec` does not forward host signals into the container's PID namespace, so the host-side kill alone would otherwise leave it running unsupervised — then `executeTask` still captures the container's current diff (`result: "execution_timed_out"`, `timedOut: true`). This diff is **never** passed through the integration gate (INV-2: it may be mid-edit or broken, and the gate is the only reviewed door back to the host), so it can never auto-apply as if the task had succeeded. It is persisted instead as a plain review artifact — `<checkpointPath>.partial-diffs/<taskId>.diff` locally, and copied into the run's `artifacts/` directory by the detached worker so it appears in `result`'s `artifactRefs` — for a human to review and apply manually if the work is salvageable.

The orphan-kill step (`adapter/orphan-kill.mjs`) also clears a stale `/project/.git/index.lock` left behind if the killed process was itself mid `git add`/`git commit` — empirically confirmed to otherwise make the diff-capture `git add -A` fail and silently return `null`, losing the whole partial diff via its catch-all. Safe specifically because it runs after every in-container process has already been force-killed, so nothing can still legitimately hold the lock. If the rescue attempt still recovers nothing (no edits were made before the kill, or capture failed anyway), `runQueue` emits a distinct `partial_diff_capture_failed` status event and records `partialDiffPath: null` in checkpoint.json, rather than letting a failed rescue collapse silently into the generic `task_failed`.

### Detached Dispatch and Recovery

`launch` starts a task queue in a detached child process and returns immediately with a `runId`, instead of blocking the caller for the full run (useful under a harness with a bounded command timeout). The lifecycle is `launch` → poll `status` → `result` → (if needed) `recover`:

```bash
node src/switchyard/dispatch/index.mjs launch tasks.md --project /path/to/repo [--exclude-provider <name> | --only-provider <name>]
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
#     "platformInfo" (host-vs-image Docker architecture comparison, always populated),
#     "queueIdentity", "queueDiagnostics" (sanitized selected/runnable/human-gated/
#     dependency-blocked/external-blocked counts and static reasons), "lastFailure", ...}

node src/switchyard/dispatch/index.mjs result <run-id> --json
# => adds terminalSummary (totalTasks/runnableTasks/processedTasks/completedTaskIds/failedCount) and artifactRefs
#    (same telemetry fields as status, above)

node src/switchyard/dispatch/index.mjs recover [--run <run-id>]
# => reclaims orphaned managed containers/volumes, and project locks held by a
#    run that is already terminal or whose worker process is no longer alive
```

Before running, `launch` records the worker's launch nonce and the project's current host git fingerprint (`git rev-parse HEAD` + `git status --porcelain`) in the run; `worker-bootstrap.mjs` re-verifies both on start and refuses to run (exit 3/4) if either has changed, so a worker never executes against a checkout other than the one it was launched against. Every terminal path — success, a failed task, or a crash — releases the run's lease and its project lock (a project allows only one active run at a time), and `recover` is the backstop for anything a hard kill (`SIGKILL`, host reboot) leaves behind: it only releases a lock it can prove is unowned by a live, still-active run, so recovering a stale run can never yank the lock out from under a different run that's genuinely still in progress.

`--exclude-provider <name>` (repeatable, works identically on `run` and `launch`) keeps the router from ever selecting that provider for the rest of the run. On the detached path the flag is persisted onto the run record at `launch` time and read back by `worker-bootstrap.mjs` — the worker process only receives `--state-root`/`--run-id`/`--nonce` on its own argv, so every other run parameter (this one included) has to reach it via the run record, not a CLI flag.

`--only-provider <name>` / `--provider <name>` (repeatable aliases accumulating into one allowlist; works identically on `run` and `launch`) is the inverse: routing is restricted to exactly the named provider(s), everything else is skipped. Mutually exclusive with `--exclude-provider` — passing both throws a `UsageError` before either reaches the router. Threaded through the exact same seam as `--exclude-provider` end to end (`dispatch/index.mjs` CLI parsing → the detached path's run-record persistence/read-back in `worker-bootstrap.mjs` → `runQueue`/`executeTask`'s `context.only` → `route()`'s `only` option), and reuses the same target-id-aware `providerMatches()` matching (a roster target id, a harness name, or a raw snapshot display name all work). Motivating case: pin dispatch to a specific subset (e.g. `claude` + `agy`) without hand-excluding every other provider one at a time.

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

For the class of project lock orphaned on 2026-07-27 (predating `projectPath`), a separate standalone script handles one-time cleanup with a human in the loop:

```bash
node src/switchyard/dispatch/remediate-orphaned-locks.mjs --dry-run   # inspect the candidate set first
node src/switchyard/dispatch/remediate-orphaned-locks.mjs             # interactive, confirms before each removal
```

It recovers `projectPath` for the pre-`projectPath` lock shape from the run's own record, confirms it by recomputing the lock's expected filename hash against the file on disk, and still enforces the existing ownership-checked `releaseProjectLockIfOwnedBy` at the moment of deletion. This installation's own 6 locks from 2026-07-27 were, as it turned out, already cleared by the time this tool was built — see `HISTORY.md`'s 2026-07-31 entry — so `--dry-run` here now correctly reports zero candidates; the tool remains the safe path for the next time this class of lock turns up.

#### Scheduled reaping (idle autoclean)

A working container/volume orphaned by a hard kill is reclaimed on the next dispatch (the pre-run sweep), by an interactive `recover`, and by the SIGTERM/SIGINT owned-container handler. For truly hands-off cleanup during long idle stretches, an optional launchd LaunchAgent runs a **standalone reaper** hourly (and at login):

```bash
sh ops/install-reaper.sh     # install/reload the com.zerodelta.switchyard.reaper LaunchAgent (idempotent)
sh ops/uninstall-reaper.sh   # remove it
launchctl kickstart gui/$(id -u)/com.zerodelta.switchyard.reaper   # run once now
# log: ~/Library/Logs/switchyard-reaper.log
```

`ops/switchyard-reaper.sh` reclaims liveness **purely from Docker labels** — it reads each managed object's `worker_pid` label and probes it with `kill -0`, force-removing (`docker rm -f -v`) only a proven-dead owner's objects. It reads no run store and no project code, which is deliberate: a background launchd agent cannot read the project tree under `~/Documents` without a Full Disk Access grant (macOS TCC), so the installer copies the reaper to `~/Library/Application Support/switchyard/` and it needs **no privilege grant** to run. Because it shares INV-3's PID-liveness rule, it is safe to run concurrently with live dispatches (a live owner's PID is always signalable, so its objects are skipped) and it never touches the standing `switchyard-agent` container (unmanaged, so outside the `managed=true` filter). The label strings it hardcodes are kept in sync with `src/switchyard/lifecycle/index.mjs` by a parity assertion in `tests/reaper-script.test.mjs`. It is intentionally narrower than `recover`: a legacy object with no `worker_pid` label is skipped (the safe direction), left for interactive/pre-dispatch `recover`.

### Environment Variables

- `SWITCHYARD_ROSTER_PATH`: Optional override for the provider/harness capability roster file (`roster.json`). When unset (or empty), the loader resolves the canonical default `~/.agent/roster.json` via `os.homedir()`. Fail-loud loading is preserved: a missing or malformed roster at the resolved path (override or default) throws on load — there is never a silent fallback to an empty or wrong roster.
- `SWITCHYARD_ORCHESTRATOR_CMD`: Path to executable command (e.g. `switchyard-orchestrator`) for external job supervision when using `createCliOrchestrator`. If the orchestrator cannot run a task on the selected provider, the task remains incomplete and will retry against the same provider on every resume (no capability-discovery protocol exists to break the retry loop).
- `SWITCHYARD_RUN_STORE_ROOT`: Override for the run-store directory (`runs/`, `locks/`, and `.quarantine/` live under it; default `<project>/.logs/switchyard`). Primarily a test-isolation override; the detached worker sets it from its `--state-root`, and `remediate-orphaned-locks.mjs` honors it the same way.
- `SWITCHYARD_LEDGER_PATH`: Override for the legacy dispatch-ledger file path (default `~/.logs/switchyard/dispatch-ledger.jsonl`), resolved lazily at each read/write so tests can redirect it per run — mirrors the `SWITCHYARD_ROSTER_PATH`/`SWITCHYARD_RUN_STORE_ROOT` pattern.

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment invariants are backed by gate tests that exercise the real boundary against live containers (INV-1's `no-host-rights`, INV-3's `workspace-wipe`), not by assertion alone.
