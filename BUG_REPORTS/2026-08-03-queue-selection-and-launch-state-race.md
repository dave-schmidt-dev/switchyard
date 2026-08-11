# Bug report: dispatch selected a human-gated task and exposed a stale launch state

Date observed: 2026-08-03 (America/New_York; the run-store event timestamps are UTC)

## Summary

An implementation run for a downstream project was handed to Switchyard with a
plan task file containing 25 tasks. Every task was marked `pending`, including
a manual third-party-service administration task and tasks whose dependencies existed only
as prose (`Blocked by: ...`). Switchyard selected the first pending task and
started provider execution without a machine-readable check that the task was
automatable, unblocked, or intentionally selected.

During the same detached launch, the run record could report
`launcher_ready` after the worker had already claimed the run. This was a
separate Switchyard lifecycle race: the parent process waited 500 ms and then
unconditionally wrote `launcher_ready`, while `worker-bootstrap.mjs` could
write `running` during that window. A live provider child was observed while the
durable run state still described the older handshake phase.

## Reproduction context

- Project: a downstream application repository (path redacted)
- Tasks file: a generated plan task file for that project (name redacted)
- Invocation shape: `switchyard-dispatch launch <tasks-file> --project . --no-stop-on-failure`
- Observed run ID: `571cfe77-f398-47ae-b719-5b7963c671a4`
- The run was manually stopped and recovered after the mismatch was identified;
  this report does not claim the interrupted task completed.

## Expected behavior

1. The orchestrator should dispatch only tasks that are explicitly runnable:
   machine-actionable, dependency-satisfied, and within the selected scope.
2. A detached launch should expose a monotonic lifecycle state. Once the worker
   has advanced a run to `running`, the parent handshake must not move it back
   to `launcher_ready`.
3. Status should let an operator distinguish “parent launched” from “worker is
   actively executing” using durable state and liveness evidence together.

## Observed behavior and evidence

### Queue-selection failure

- Parsing the plan produced 25 task records.
- All 25 records had `Status: pending`.
- The queue parser recognizes task headings, status, description, files,
  timeout, and tier, but does not interpret `Blocked by` prose or a manual task
  kind.
- `getRunnableTasks()` treats both `pending` and `in progress` as runnable and
  does not require an explicit task-id selection.
- Therefore the first pending task was eligible to route even though it was a
  human/admin operation rather than an implementation task.

This is primarily a planning/queue-contract defect. The plan supplied an
ambiguous executable queue, and the dispatcher had no machine-readable way to
distinguish human-gated work from provider work. `--max-tasks 1` only limits
quantity; it does not make the first task safe.

### Detached lifecycle race

The parent path in `src/switchyard/dispatch/index.mjs` did this:

1. advance the run to `launching`;
2. spawn `worker-bootstrap.mjs`;
3. wait 500 ms;
4. unconditionally advance the run to `launcher_ready`.

The worker path in `src/switchyard/dispatch/worker-bootstrap.mjs` acquires the
run lock and advances the same record to `running` before invoking `runQueue`.
Those writes are concurrent. If the worker wins first, the parent's stale
`launcher_ready` write regresses the durable state. The incident showed the
corresponding symptom: a provider child was active while the run record still
reported the launcher handshake phase.

This is a Switchyard implementation bug, covered by INV-6. It is independent
of whether the plan's task selection was correct.

## Impact

- A provider can be spent on a task that requires a human action or is blocked
  on an unmet prerequisite.
- An operator can make an incorrect recovery decision from a stale lifecycle
  state. In particular, `launcher_ready` does not mean the worker has not
  started.
- `--no-stop-on-failure` does not address the selection problem; it changes
  failure continuation, not eligibility.

## Containment used for this incident

- The exact worker/container was stopped before it could be mistaken for a
  completed implementation.
- `switchyard-dispatch recover --run 571cfe77-f398-47ae-b719-5b7963c671a4`
  reclaimed one managed container and one managed volume and released the
  project lock.
- The project working tree was checked afterward; no Switchyard-applied
  implementation diff was accepted as a result of this interrupted run.

## Fix in this change

`markLauncherReadyIfLaunching()` now uses the run-store revision check and
re-reads the run after a write race. It publishes `launcher_ready` only while
the record is still `launching`; if the worker has already advanced the record,
the parent leaves that newer state unchanged. A regression test covers the
worker-owned `running` case.

## Follow-up required before broad plan dispatch

The queue contract still needs a deliberate design rather than heuristic
inference from descriptions. The next change should add:

- an explicit machine-readable task kind (`implementation`, `review`,
  `manual`/`human-gated`);
- machine-readable dependencies with fail-closed eligibility;
- an explicit task-id allowlist for a run, persisted in the detached run record;
- tests proving blocked, manual, and unselected tasks never route.

Until that exists, create a temporary tasks file containing only the verified
machine-runnable task(s), or mark human-gated/dependency-blocked entries
non-runnable before dispatch. Do not rely on `--max-tasks` as a safety filter.

## Verification notes

Research was skipped: this remediation touches only Switchyard's own run-store,
dispatch, tests, and project documentation; no external library/API behavior
was introduced or assumed.
