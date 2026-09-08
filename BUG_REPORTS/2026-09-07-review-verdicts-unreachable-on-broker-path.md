# Bug report: every review task dispatched through the broker returned no verdict

Date observed: 2026-09-07
Observed from: switchyard itself, while implementing Task 5.1 of the
`switchyard-consolidated-reliability-2026-09-07` delivery
Introduced by: `44c5bce` (Task 3.2, "Add first-class review results")
Fixed by: `9e9a6b7`, `d4b2edb`

## Summary

Task 3.2 gave review work a closed, sanitized result schema and made the runner branch on it.
Three defects shipped with it, and two gate-escaped red test files hid all three.

1. **The verdict could not cross the broker.** `runner/index.mjs` reads
   `brokerExecution.reviewResult`, but two bounded shapes between the adapter and that read drop
   the field: `createBrokerAdapterLauncher`'s return in the runner, and the broker executor's
   frozen success and failure returns. Every review task dispatched through `runQueueAsync` --
   the production async path -- therefore resolved to `unavailable("missing")` and terminated
   `review_unavailable` with `success: false`, whatever the provider actually concluded.
2. **Review work bypassed failure classification.** The review branch sits ahead of the
   `!execution.success` path on all three execution paths, and `survivingProviderFields` carries
   neither `diagnosticCode`, `exitCode` nor `failurePhase`. A review task that hit a CLI usage
   error, a timeout or a quota wall lost its sanitized Task 3.1 diagnostics and was never
   quarantined, retried or re-routed -- it looked like a review with nothing to say. The spec
   branches review before *integration*, not before classification; the never-emitted
   `provider_failed` and `timeout` members of `UNAVAILABLE_REASONS` are the design's own evidence.
3. **knip went red** on five exported-but-unread review-result bounds.

## Why no gate caught it

`tests/runner-broker-production.test.mjs` was red at 18 of 27 from `44c5bce` onward, and
`tests/broker-executor.test.mjs` was red on its allowlist-drift guard. Neither file appears in
Task 3.2's declared Files or quick checks. `runner-broker-production` is also absent from the
Phase 3 and Phase 4 gates; it appears only in the Phase 1 and Phase 5 gates and in Task 3.3,
which is still pending. Nothing that ran was capable of failing. The seven commits since were
never pushed, so the pre-push hook -- which exists precisely because a red knip once let three
commits land on top of it -- never ran either.

`tests/broker-executor.test.mjs` deserves specific credit: it derives the required field set by
regex over the runner source and asserts the executor's shape carries all of it. It named
`reviewResult` and `output` exactly. It was simply never executed by a gate that gated anything.

## Recurrence

This is the third instance of one failure mode: a field added to the runner's read of the broker
result, and not to the executor's frozen allowlist. `servedModelVerified` was the first,
`completionContinuationProof` the second (2026-09-06, Phase 4), `reviewResult` the third. The
comments left behind by the first two repairs are in the file, directly above the line the third
one needed.

**Addendum, 2026-09-07 (Task 5.1 review).** There was a fourth drop point on the same field, one
layer further out, and this report missed it: the detached worker's two terminal event shapes in
`src/switchyard/dispatch/worker-bootstrap.mjs` (`task_completed` at :799, `task_failed` at :820)
also omitted `reviewResult`. So even after the broker path was repaired, any review task dispatched
through `launch` -- the detached path, not just `runQueueAsync` -- still surfaced no verdict on its
terminal event or in the run projection. The synchronous path at `dispatch/index.mjs:1074` had
carried the field correctly the whole time, which is why the gap survived three repairs: every
prior fix and every prior test looked at the shapes between the adapter and the runner, and this
one is between the runner and the event. Found by an external reviewer, not by a gate. Fixed in
`325285f` with a test parameterized over both terminal shapes; the failure branch was verified as
a real regression by deleting the line and watching only the failed case fail.

The count is now four, and the fourth was in a file none of the three earlier repairs touched.
The generalization the first three suggested -- "check the executor's allowlist" -- was too narrow.
The actual rule is that `reviewResult` has to survive **every** hop from provider to reader, and
nothing enumerates those hops.

## Requests

- Any task that adds a `brokerExecution.<field>` read must declare `tests/broker-executor.test.mjs`
  in its Files and quick checks. The guard already exists; the gate wiring is what keeps failing.
- A test file that a gate does not run is not coverage. Adding a test file to a task's Files list
  should be mechanically checked against the phase gate that follows it.
- Consider collapsing the two bounded shapes between the adapter and the runner into one. The
  duplication is what makes this class recur: a field has to be added in two allowlists and read
  in a third, and only the third is where anyone is looking.
- Add one test that walks a review verdict end to end on each of the three execution paths --
  sync, broker, detached -- and asserts the same verdict arrives at the reader. Four instances in
  two days is enough evidence that per-hop allowlist review does not catch this class.
