# Bug report: headless-worktree reports terminal failure while holding usable provider work

Date observed: 2026-09-04 (America/New_York)
Observed from: `scarecrow`, run `scarecrow-resume-unblocked-queue-2026-09-04`

## Summary

Three `headless-worktree` fallbacks ran. All three returned a terminal failure
result. Two of them had already produced a complete, contract-checks-passing
patch in `evidence/`, and one of those patches was salvaged by hand and shipped.
The third discarded the provider's work entirely because a check command failed.

The wrapper's terminal result therefore does not distinguish "the provider
failed" from "the provider succeeded and the captain-side integration failed",
and the operator only recovers the difference by knowing to look in `evidence/`.

## Confirmed outcomes

- **Task 1.2** — result `execution_failed`. The provider run had in fact
  succeeded: `accepted: true`, both contract checks passed, and
  `evidence/1.2.patch` was a complete diff confined to the manifest's
  `allowed_files`. The failure occurred *after* the provider, during
  integration. Root cause was captain-side (see "Delivery record" below), not
  provider-side. The patch was applied by hand after verifying `changed_paths`
  against the manifest and shipped as `430784a`.
- **Task 1.3** — result `captain_lease_invalid`, again post-provider, with the
  patch captured. In this case the captured patch was reviewed and *rejected* on
  its merits, so nothing was lost; but the loss would have been silent had the
  captain not gone looking.
- **Task 1.1** — result `dependency_missing`, raised from the contract's check
  command. **No patch was retained.** The provider's work was discarded together
  with the worktree, and the task had to be reimplemented from scratch.

All three were preceded by Switchyard dispatches to Vibe / `mistral-medium-3.5`,
which failed at the provider level with exit 255, exit 1, and `cli_usage_error`
respectively.

## Findings

### 1. Terminal result conflates provider failure with integration failure

`execution_failed` was returned for a run whose provider succeeded and whose
diff was complete. An operator reading only the result would conclude the
provider work needed redoing, and would redo it. Suggest a distinct result kind
for post-provider failures, and surfacing the retained artifact path in the
failure payload rather than only on disk.

### 2. A failing check discards the provider's diff

Task 1.1's check command failed, and the worktree was cleaned with no patch
retained. A check failure is exactly the case where the diff is most worth
keeping — it is the input to diagnosing whether the provider or the check is
wrong. Suggest retaining the diff on check failure, on the same content-free
terms as the existing artifact path.

### 3. Contract-side trap: `.venv`-relative check commands

The 1.1 contract's check invoked `.venv/bin/python`, which does not exist in a
fresh worktree; `_run_process` surfaced the `FileNotFoundError` as
`dependency_missing`. The obvious repair — an absolute path to the main tree's
venv — has a second, quieter hazard: that venv contains an editable-install
`.pth` pointing at the main tree, so a check running in a worktree imports the
main tree's copy of the package and reports on code that is not under test. The
working form was `/usr/bin/env PYTHONPATH=. <abs>/.venv/bin/python`.

This is arguably documentation rather than a defect, but it cost a full provider
cycle and the failure mode of the naive repair is a check that passes against
the wrong source.

### 4. Delivery-record schema is exact-key-set, and hand-authoring is the trap

`_validate_record` requires `set(record) == required` — 26 keys exactly, no
extras, none missing. The delivery record for this run had been hand-authored
and was never valid: it carried extra keys and was missing twelve. This is what
actually failed task 1.2's integration, and the error surfaced as a generic
integration failure rather than naming the offending keys.

The same defect exists in a second record on disk:
`scarecrow/.logs/captain/mac-capture-space-2026-09-03-delivery.json` has
`outcome: "complete"`, which is not in `TERMINAL_OUTCOMES`
(`completed`/`blocked`/`failed`/`cancelled`), and a key set that does not match.
So this is not a one-off typo — hand-authored records are being produced and are
passing unnoticed until an integration touches them.

Suggest: report the symmetric difference of the key sets in the validation
error, and provide a check that can be run against a record before dispatch
rather than at integration time.

### 5. Captain lease failure lands after the expensive part

Task 1.3's `captain_lease_invalid` is correct behavior — workers must not be
able to mint integration authority — but it was raised only after the provider
had run to completion. A dispatch-time preflight would fail the same run for the
same reason at a fraction of the cost.

Related mechanical note: `acquire_captain_lease` binds the lease to
`os.getpid()`, so a lease acquired in one short-lived process cannot be used by
the next. Acquiring and mutating in a single process works; splitting them
across two invocations does not, and the resulting error also reads as
`captain lease is not owned by caller`.

## Required follow-up

Nothing here is a data-loss or security issue. The ranked asks are (1) do not
discard a diff the provider produced, whatever the terminal result, and (2) make
the delivery-record validation error name the keys it rejected. Item 3 is a
documentation fix for contract authors. Items 4 and 5 are diagnosability.

The authorized native reimplementation of task 1.1 completed successfully and is
not evidence that the provider path would have.
