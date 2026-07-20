# switchyard

A containment-first Python dispatcher that routes coding tasks across subscription-backed agent CLIs (claude, agy, cursor, codex) inside disposable, per-provider sandboxes — built on the explicit assumption that any credential or source entering an execution environment may be stolen or disclosed, and confined accordingly.

**Status:** scaffolded, pre-implementation.

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

## Planning artifacts

- `~/Documents/Projects/.plans/switchyard/switchyard-containment-architecture-2026-07-20.md` — warp-tier implementation plan (in progress: steps 1–7 of the seed architecture as 5 milestones).
- Seed architecture doc: sacrificial execution architecture for coordinating subscription-backed coding agents.

## Workflows

<Placeholder — fill in as implementation lands. Cover: dispatch a task, provision the topology, run the adversarial corpus, inspect a task's provenance, teardown, rollback.>

## Conventions

- All files self-contained under this directory.
- Secrets in BWS. Never committed. Provider credentials injected into an execution environment are treated as **already compromised**.
- Update `HISTORY.md` alongside every meaningful change. Bug entries cite the files touched (`- files: path/a.py, path/b.ts`).
- Tests verify real behavior — no smoke-only "did it run" checks. Containment claims require adversarial proof.
