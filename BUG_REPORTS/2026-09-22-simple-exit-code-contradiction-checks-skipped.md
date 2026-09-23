# Bug report: `simple` reports provider_exit_nonzero while the lifecycle records exit 0, and skips checks

Date observed: 2026-09-22 21:37 EDT
Observed from: `scarecrow`, task `8.1-fix-meter-flood` (standard, 4-file scope, `--dirty-overlay`, 2 `--check`s)
Run: `simple-7d12c02a-e06b-48f4-9b0c-936a575b6519-84c2491a-4dab-4021-a06e-a4f75fdd477c`, provider Antigravity, elapsed 821 s

## Summary

Update 2026-09-23: R9 fixed the exit-code contradiction in the current `simple`
path. An `agy` process exit of 0 now remains exit 0; its parsed output gets a
separate `providerVerdictCode` (`agy_success`, `agy_non_success`, or
`agy_unparseable`). Regression cases for all three outputs confirm diff capture
and checks continue after exit 0. After checkpoint review, a non-success or
unparseable verdict now retains the checked diff and fails before host
integration; the observed process exit remains 0. A live R9 dispatch reproduced the original
contradiction before this fix (`providerLifecycle.exitCode: 0` with
`provider_exit_nonzero`). The historical Scarecrow run's exact output has not
been recovered. The early zero-byte `--json-out` file and missing stderr
failure line remain open observations outside R9's scope.

1. The result JSON has `status: failed`, `failureReason: provider_exit_nonzero`, and `failurePhase: execute`.
   In the same file, `providerLifecycle` has `exitCode: 0`, `terminalStatus: exited`,
   `terminationReason: completed`, and `silenceObserved: false`. One of the two is wrong.
2. `checks` is `[]`. Neither `--check` command ran, so the caller cannot tell a broken diff
   from a working one without rerunning the checks by hand.
3. `partialWorktree` held a complete, scoped diff (2 files, +260/-88). The captain salvaged
   it; on the host it passed the pytest check (55 passed), and the Mac gate was then run
   to settle the Swift side.
4. `--json-out` created the result file at dispatch time with 0 bytes. It stays empty until the
   terminal write, so a consumer that tests for existence rather than size reads it too early.
5. The dispatch wrapper exited 1 (`SWITCHYARD_EXIT=1`) with no stderr line naming the failure.

## Follow-up observation 2026-09-23 11:14 EDT (scarecrow R6a)

Run `simple-ef809da8-b1ba-4a4f-a097-31ec9c970983-7f5475bd-e2bb-4cd7-85fc-83d9bcea7738`, target `antigravity-claude`, ran for 166 s.
- `providerLifecycle.exitCode` was 0 and `providerVerdictCode` was `agy_non_success`.
- The run ended with `failureReason: empty_diff` and `errorKind: policy_violation`.
- `outputs` was `[]`, and the run directory held only `run.json` and `events.jsonl`.
- The agy `status` value and its message were not persisted anywhere, so the caller cannot tell whether this was a refusal, an auth or quota problem, or a model that gave up.

Expected: persist the provider's final status and message (bounded, redacted) in the result or the run directory whenever the verdict is not success.

Also: `--only-provider cursor` fails at route with `local_adapter_unavailable`. `cursor` is listed in `SIMPLE_PROVIDERS` but has no entry in `SIMPLE_TARGET_ADAPTERS`, so `--help` advertises a provider that can never route.

Also: `--only-provider antigravity` (gemini-3.8-flash-high, standard slot) failed at route in 27 ms with the generic `no_eligible`. That is the mixed or non-ceiling skip bucket, so the result does not name the skip reason (exhausted floor, excluded, no windows, and so on), and `route-health/` held no record for it. Expected: surface the specific skip reason for a pinned provider.

Also: the check failures in the R5 and R3 runs (2026-09-23) persisted only `{"index": 1, "status": "failed"}`, with no exit code and no output tail. Diagnosing them meant rerunning each check by hand in the retained worktree (a Mac xcodebuild gate took about 1 min; a pytest set took 18 s). Expected: persist the exit code and a bounded, redacted output tail per failed check.

## Expected

- `failureReason` agrees with `providerLifecycle`. If the adapter saw a non-zero status that
  the lifecycle did not, record both values and say which one decided the result.
- When the provider exits 0 and the worktree has an in-scope diff, run the checks and report
  them. Do not fail before the check phase.
- Write the result file atomically (temp file, then rename), or only at the terminal write.

## Follow-up 2026-09-23 12:15 — retained worktrees are never reaped

- `$TMPDIR` holds 241 `switchyard-simple-*` directories totalling 12 GB, dated 2026-09-19 to 2026-09-23, across projects. Successful runs appear to leave theirs too, not only `salvage_retained` ones.
- Scarecrow's two salvage dirs (`switchyard-simple-eDp9ZR` R5, `switchyard-simple-hSrplv` R3) are now redundant (content committed in scarecrow `e905772`) and were left in place for this report.
- Want: reap on success; a TTL or `switchyard-dispatch gc` for salvage dirs, with the run id recorded so an owner can tell which are still needed.
