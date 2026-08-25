# Bug report: timeout cleanup evidence and pre-allocation fallback failures

Date observed: 2026-08-25 (America/New_York)

## Confirmed outcomes

- `c98c0c27-eb6b-46e9-8cba-5e8f1acc50f4` reached the 30-minute provider limit.
  Its event stream recorded provider cleanup failure and its terminal result was
  `execution_timed_out_cleanup_failed`; the detached run retained
  `artifacts/1.1.diff` for review.
- `c05a9060-20a4-4c4d-8f1b-7bf9fb005e71` ended `integration_failed`. No eligible
  non-empty diff existed to retain, so it correctly has no artifact.
- The shared `headless-worktree` fallback returns `contract_invalid` before
  allocating a worktree. Its current failure result contains only a static error
  kind, so no durable receipt or artifact is available for that pre-execution
  failure.

## Required follow-up

Keep the timeout cleanup investigation separate from artifact semantics. Add a
sanitized, content-free receipt for `headless-worktree` pre-allocation failures;
it must contain no prompt, provider output, diff, or filesystem path. Both items
are tracked in `TASKS.md`. The authorized native fallback completed the scoped
small guards and is not evidence that either provider path succeeded.
