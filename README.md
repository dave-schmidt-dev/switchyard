# switchyard

A containment-first Python dispatcher that routes coding tasks across subscription-backed agent CLIs (claude, agy, cursor, codex) inside disposable, per-provider sandboxes — built on the explicit assumption that any credential or source entering an execution environment may be stolen or disclosed, and confined accordingly.

**Status:** Phases 0-4 implemented (M1-M3). Runner now includes queue/checkpoint and concrete headless poll/`wait` supervision; remaining work is phased spread/integration completion.

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
| `src/switchyard/container/index.mjs` | Agent container lifecycle (Docker start/stop/exec). |
| `src/switchyard/sandbox/index.mjs` | Working container creation, project staging, wipe (INV-1/INV-3). |
| `src/switchyard/lifecycle/index.mjs` | Working container lifecycle via Docker volumes (INV-1/INV-3). |
| `src/switchyard/integrate/index.mjs` | Integration gate (INV-2): diff validation, `git apply`, path traversal blocking. |
| `src/switchyard/ledger/index.mjs` | Dispatch ledger (INV-4): JSONL append of provider/model/result per task. |
| `src/switchyard/adapter/claude.mjs` | Claude CLI adapter: dispatch, exec, diff capture. |
| `src/switchyard/adapter/codex.mjs` | Codex CLI adapter: dispatch, exec, diff capture, BWS-based auth injection. |
| `src/switchyard/runner/index.mjs` | Host-side queue runner with checkpoint/resume and headless poll/`wait` orchestration mode (`SWITCHYARD_ORCHESTRATOR_CMD`). |
| **Tests** | |
| `tests/router.test.mjs` | INV-4 + CR-2/CR-3 regression: spread, exhaust skip, absent tolerance, INV-5. |
| `tests/capability-match.test.mjs` | INV-5 gate: capability filter, tier ordering, model right-sizing. |
| `tests/integration-gate.test.mjs` | INV-2 gate: reviewed diff apply, suspicious path rejection. |
| `tests/no-host-rights.test.mjs` | INV-1 gate: host FS, Docker socket, credential isolation. |
| `tests/workspace-wipe.test.mjs` | INV-3 gate: working container wipe, agent container persistence. |

## Planning artifacts

- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20.md` — impulse-tier implementation plan (active: 18 tasks, 8 phases).
- `~/Documents/Projects/.plans/switchyard/switchyard-plan-implementation-engine-2026-07-20-tasks.md` — task board for the implementation engine.
- Supersedes the abandoned `switchyard-containment-architecture-2026-07-20` (adversary-defense) draft.

## Workflows

<Placeholder — fill in as implementation lands. Cover: dispatch a task, provision the topology, run the adversarial corpus, inspect a task's provenance, teardown, rollback.>

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment claims require adversarial proof.
