# Bug report: an annotated task status silently reads as not-done, and boot-phase failures leave no failure record

Date observed: 2026-08-21 (America/New_York; run-store event timestamps are UTC)

## Summary

Six Switchyard runs were dispatched from a downstream Apple release project over
one session. None reached a reviewed integration. Three distinct problems account
for them, and the first two cost the most time because each presented as a
different failure than it was.

1. **A task status carrying a human annotation is treated as not-done, and the
   resulting failure names an unrelated task.** Marking a completed task
   `done (native/standard fallback, commit 12bd6b7)` — a form that reads as
   unambiguously complete to a person and that nothing in the tasks-file contract
   forbids — caused a dependent task to fail selection with
   `dependency-blocked:1.1`. The annotation is the entire cause; the dependency
   was in fact satisfied.
2. **A failure during worker boot leaves `run.json.lastFailure` as `null`.** For
   the three runs that died in boot, the run record — the obvious place to look,
   and what `status` surfaces — carried no failure at all. The cause existed only
   in `events.jsonl` as a `worker_boot_failed` event. A run that failed for a
   knowable reason is indistinguishable, from the run record, from one that failed
   for no recorded reason.
3. **Provider authentication and execution failures accounted for the rest**, with
   two of them requiring interactive re-authentication that an unattended run
   cannot perform.

## Evidence

Run store: `<downstream-project>/.logs/switchyard/runs/`.

| Run | Terminal event | `run.json.lastFailure` |
| --- | --- | --- |
| `949a0d68` | `worker_boot_failed` — `TaskSelectionError: task selection failed: dependency-blocked:1.1`, `taskId: 1.2` | `null` |
| `fa068030` | same as above | `null` |
| `64ec9d93` | `worker_boot_failed` — `macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE` | `null` |
| `8b7671f5` | `broker_execution execution_failed` | `errorKind: execution_failed`, `failurePhase: provider_execution` |
| `290d0233` | `execution task_failed`, then `checkpoint state_reset` | `errorKind: auth_expired` |
| `bbdedcbb` | same as above | `errorKind: auth_expired` |

Separately, `run.json.status` read as absent/null on all six records, including
the ones that reached provider execution.

## Problem 1: annotated status

`src/switchyard/runner/index.mjs:342-350` builds the completed set with an exact
literal comparison:

```js
if (String(task.status ?? "").trim().toLowerCase() === "done") {
    done.add(task.id);
}
```

`trim()` and `toLowerCase()` establish an expectation that surface variation is
tolerated, which makes the strictness past that point surprising rather than
obviously intentional. The same comparison recurs at `:358`, `:401`, `:1599`, and
`:1703`.

The reported error is the second problem with this. `dependency-blocked:1.1`
names task 1.1 — the task whose status was *correct and complete* — while the
malformed thing is 1.1's status string and the failing selection is 1.2. An
operator reads that message as "1.1 is not finished", re-checks 1.1, finds it
finished, and has no next step. It took two failed runs to find.

Suggested fix, in preference order:

- Parse a status as its leading token, so `done (commit abc1234)` is `done` and
  annotation is a supported affordance rather than a silent trap. This is what
  the annotation form already implies to every human reader.
- Failing that, **reject** an unrecognized status at load time with an error that
  quotes the offending string and its task id — `task 1.1: unrecognized status
  "done (native/standard fallback, commit 12bd6b7)"; expected one of pending, in
  progress, done, blocked`. Silently reclassifying it as not-done is the worst of
  the three options.
- Either way, `dependency-blocked` should name the dependency's actual status:
  `dependency-blocked: 1.2 requires 1.1, whose status is "..."`.

The workaround adopted downstream was to move every annotation onto a separate
`- **StatusNote:**` line and keep the status field a bare literal. That works, but
it is a convention no reader of the tasks-file contract would infer.

## Problem 2: invisible boot failures

For `949a0d68`, `fa068030`, and `64ec9d93`, `lastFailure` is `null` while
`events.jsonl` holds a fully specified error object with `name`, `message`, and in
two cases a `code` and `taskId`. The information exists and is simply not
promoted to the record operators read.

Suggested fix: write `lastFailure` from the `worker_boot_failed` path with the
same shape used for provider failures, giving boot errors an `errorKind` of their
own (`task_selection_failed`, `environment_incomplete`) so a caller can branch on
it without string-matching a message. Also populate `run.json.status` on terminal
transitions.

## Problem 3: environment discoverability

`64ec9d93` died on `macos queue requires SWITCHYARD_PARALLELS_GOLDEN_IMAGE`. The
full set eventually needed was:

```
SWITCHYARD_PARALLELS_GOLDEN_IMAGE=switchyard-golden-6
SWITCHYARD_PARALLELS_AQUA_UID=503
SWITCHYARD_RUN_STORE_ROOT=<project>/.logs/switchyard   # required by `status`, separately
```

These were discovered one failed run at a time, each error naming only the next
missing variable. A preflight that validates the whole environment for the
selected queue before creating a container, and reports every missing variable at
once, would collapse that to a single attempt. `SWITCHYARD_RUN_STORE_ROOT` is a
sharper case: `status` cannot find runs the launcher just wrote without it, so the
default disagrees with itself between two commands in the same workflow.

## Impact

Four of six runs failed for reasons unrelated to the work being dispatched. The
downstream project fell back to native execution for the whole session under its
documented fallback ladder. No task was reclassified and no work was lost, but the
delegation contract's priority-1 provider pool went entirely unused.

## Not claimed here

The two `auth_expired` runs and `8b7671f5`'s `execution_failed` are reported as
observations only. `execution_failed` arrived with sanitized events and empty
artifacts, so this report makes no claim about its cause.
