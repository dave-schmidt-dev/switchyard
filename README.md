# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, Agy, Cursor, with Vibe/Copilot on the roadmap) inside disposable, per-provider sandboxes — built on the explicit assumption that any credential or source entering an execution environment may be stolen or disclosed, and confined accordingly.

**Status:** Phases 0-5 implemented and test-covered (198/198 `npm test`), but not fully wired end-to-end. Agent/working container lifecycle is wired into the real runner dispatch path (`src/switchyard/lifecycle/index.mjs`, the sole surviving implementation after `sandbox/index.mjs` was deleted) and `npm run validate`'s `deadcode` step is clean. The real remaining gap: working containers are built `FROM alpine:latest` with `--volumes-from` the agent container, but the agent container shares no volumes and the four provider CLIs live only in `AGENT_IMAGE`'s filesystem layers — so a real dispatch's `docker exec` can't find them yet (`TASKS.md` Task 14). All four adapters perform real credential checks via `hasNonTrivialCredential()` in addition to liveness checks (`TASKS.md` Task 15, completed).

## Priorities (in order)

1. **Containment & isolation (security).** The sandbox boundary *is* the product. A hostile in-container workload must never reach the macOS host, the LAN, cloud metadata, the Docker socket, or another provider's environment.
2. **Correctness of the trust-boundary data plane.** Sanitized allowlist export, quarantined normalized import, and a complete provenance record for every task — the host must never open un-normalized hostile output.
3. **Adversarial testability.** The boundary is *proven* with canary-credential exfiltration tests (creds escape; host/LAN/metadata do not), not assumed.
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
| `docker/.gitkeep` | Placeholder for Docker image build context. |
| **Source modules** | |
| `src/switchyard/router/index.mjs` | Provider selection: snapshot-backed spread routing, blind fallback, INV-4 compliance. |
| `src/switchyard/router/scorer.mjs` | Capacity scoring: FNV-1a hash, mulberry32 PRNG, deterministic jitter. |
| `src/switchyard/roster/index.mjs` | Provider capability definitions and INV-5 capability filter. |
| `src/switchyard/roster/classifier.mjs` | Keyword-based task-tier classifier (high/standard/low). |
| `src/switchyard/container/index.mjs` | Agent container lifecycle (Docker start/stop/exec). Not yet called by the runner (`TASKS.md` Task 9). |
| `src/switchyard/lifecycle/index.mjs` | Working container lifecycle via Docker-managed volumes — **unused**, not yet wired into the runner. See `TASKS.md` Task 8. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): structural diff validation (`git apply --numstat`/`--summary`, not a content blocklist), path-escape/symlink/executable-file rejection, `allowSensitiveManifests`-gated review for build/CI manifests, `git apply` via stdin. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): JSONL append of provider/model/result per task. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateModelArg`) used by all four provider adapters. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, real credential check (`/root/.claude/.credentials.json`, persisted by `claude auth login`). |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch via `codex exec` (prompt over stdin), diff capture, real credential check (`/root/.codex/auth.json`, persisted by `codex login --device-auth`). |
| `src/switchyard/adapter/agy.mjs` | Antigravity (Agy) CLI adapter: dispatch (prompt via `--print` flag, not stdin — the CLI can't read it for this purpose), diff capture, real credential check (`/root/.gemini/antigravity-cli/antigravity-oauth-token`, persisted by agy's auto-triggered Google OAuth flow). |
| `src/switchyard/adapter/cursor.mjs` | Cursor Agent adapter: dispatch invokes `cursor-agent` directly, diff capture, real credential check via `cursor-agent status` text (persisted by `cursor-agent login`). |
| `src/switchyard/auth/index.mjs` | Walks a human through authenticating every provider that isn't already authenticated, by running each one's real interactive OAuth login inside the standing agent container. Run directly via `npm run auth`. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). Wires all four adapters; `route()` is restricted to whichever adapters are actually present. |
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
| `tests/auth-check.test.mjs` | `ensureProvidersAuthenticated` unit tests via injected fake providers (no real Docker needed), including regressions for a provider's `runLogin()`/`isAuthenticated()` throwing without aborting the rest of the walkthrough. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: host FS, Docker socket, credential isolation (generic Docker behavior — see `TASKS.md` Task 8). |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5, adapter-availability filtering, blind fallback. |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume (atomic writes), stopOnFailure/gate-failure handling, headroom-routing mechanism, orchestrator CLI integration, and orchestrator status/result error guards. |
| `tests/scorer.test.mjs` | FNV-1a hash, mulberry32 PRNG, and scoring logic unit tests. |
| `tests/workspace-wipe.test.mjs` | INV-3 gate: working container wipe, agent container persistence (generic Docker behavior — see `TASKS.md` Task 8). |

## Planning artifacts

- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20.md` — impulse-tier implementation plan (active: 18 tasks, 8 phases).
- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20-tasks.md` — task board for the implementation engine.
- Supersedes the abandoned `switchyard-containment-architecture-2026-07-20` (adversary-defense) draft.

## Workflows

### Running Tests and Linting

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

A completed login persists to the provider CLI's own credential store inside the standing agent container (which is never wiped, unlike working containers — INV-3), so this is a one-time step per provider, not per task. Exits non-zero if any provider is still unauthenticated when it finishes.

This one-time-per-provider guarantee currently only covers the standing agent container itself — working containers (where real dispatches actually run) don't yet share the agent container's provider binaries or credentials (see Task 14 in `TASKS.md`), so a real end-to-end dispatch isn't possible until that's resolved.

### Queue Dispatching and Orchestration

The host-side runner parses markdown task queues and dispatches tasks serially through the router, adapters, and integration gate:

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
- Tests verify real behavior — no smoke-only "did it run" checks. Containment claims require adversarial proof.
