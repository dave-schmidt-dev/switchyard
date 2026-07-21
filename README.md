# switchyard

A containment-first Node.js dispatcher that routes coding tasks across subscription-backed agent CLIs (Claude, Codex, with Agy/Cursor/Vibe/Copilot on the roadmap) inside disposable, per-provider sandboxes — built on the explicit assumption that any credential or source entering an execution environment may be stolen or disclosed, and confined accordingly.

**Status:** Phases 0-5 implemented and test-covered (89/89 `npm test`), but not fully wired end-to-end. `src/switchyard/sandbox/index.mjs` and `src/switchyard/lifecycle/index.mjs` are two competing, unfinished, unused implementations of the working-container lifecycle (`TASKS.md` Task 8); the runner never calls the container/auth lifecycle functions it imports the adapters from (`TASKS.md` Task 9). `npm run validate`'s `deadcode` step reports both honestly.

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
| `src/switchyard/sandbox/index.mjs` | Working container creation/wipe — **unused, unfinished** (bind-mounts a host temp dir; file-copy step is a stub). Superseded by `lifecycle/index.mjs`; see `TASKS.md` Task 8. |
| `src/switchyard/lifecycle/index.mjs` | Working container lifecycle via Docker-managed volumes — **unused**, not yet wired into the runner. See `TASKS.md` Task 8. |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): diff validation, `git apply`, path traversal blocking. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): JSONL append of provider/model/result per task. |
| `src/switchyard/adapter/shell-safety.mjs` | Shared shell-interpolation guards (`validateIdentifier`, `validateEnvName`) used by both provider adapters. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch (prompt over stdin), diff capture, BWS-based auth injection. |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch (prompt over stdin), diff capture, BWS-based auth injection. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). |
| **Tests** | |
| `tests/capability-match.test.mjs` | INV-5 gate: capability filter, tier ordering, model right-sizing. |
| `tests/classifier.test.mjs` | Keyword-based task tier classifier unit tests. |
| `tests/claude-adapter.test.mjs` | Container-backed Claude CLI dispatch and diff capture tests. |
| `tests/claude-auth.test.mjs` | INV-1 regression: no host cred copy, no secret-in-argv, shell-injection guard, prompt-injection regression. |
| `tests/codex-adapter.test.mjs` | Container-backed Codex CLI dispatch and diff capture tests. |
| `tests/codex-auth.test.mjs` | INV-1 regression: no host cred copy, no secret-in-argv, shell-injection guard, prompt-injection regression. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/ledger.test.mjs` | INV-4 dispatch ledger recording and querying unit tests. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: host FS, Docker socket, credential isolation (generic Docker behavior — see `TASKS.md` Task 8). |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5. |
| `tests/runner.test.mjs` | Queue parsing, serial dispatch, checkpoint/resume, stopOnFailure/gate-failure handling, headroom-routing mechanism, and orchestrator CLI integration tests. |
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

- `SWITCHYARD_ORCHESTRATOR_CMD`: Path to executable command (e.g. `switchyard-orchestrator`) for external job supervision when using `createCliOrchestrator`.

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment claims require adversarial proof.
