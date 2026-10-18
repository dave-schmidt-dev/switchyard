# Bug report: `simple` ran 11.7 h past a 29-minute deadline; check probe treated a version string as an executable

Date observed: 2026-10-14 22:01 to 2026-10-15 09:56 EDT
Observed from: `hermes` (UPG-3 Phase 2), routing run `upg3-dade9555`, Switchyard 0.3.0
Evidence: `~/Documents/Projects/.plans/hermes/upg3-task-2.{1,2}.result.json` and `.progress.log`

## 1. `--deadline` not enforced (high)

- Run `simple-19592032-5a96-43bc-a295-2a1cc6b4b521`, task identity `e092f7d2…`, target `opencode-go`, capability standard.
- Dispatched 2026-10-15T02:14:46Z with `--deadline` about 29 minutes ahead and `--estimate-minutes 8`; `deadlineFit.fits: true`, `deadlineMs: 1792032226000`.
- Terminal at about 13:56Z: `elapsedMs: 42074993` (11.7 h), `providerReliability.timedOut: false`, `cancelled: false`, `exitCode: 0`.
- The progress log holds 1015 consecutive `phase=execute` lines, then `route_health`, `diff capture_started`, `salvage_retained`, `terminal failed`.
- Result: `failureReason: unsafe_diff`, `diffRejectionRule: integration_state_unknown`, `diffRejectionPaths: []`, while `changedFiles` listed exactly the 7 declared files. The final stderr line was `failure log unavailable (EPERM)`.
- Unverified hypothesis: the `opencode-go` route talks to the long-lived `opencode serve --service` process, so aborting or timing out the client does not end the server-side session, and nothing enforces `deadlineMs` around the execute phase as a whole.

Requests:
- Enforce the caller deadline as a hard wall-clock bound over the whole attempt, so the terminal result is `timedOut: true` once the deadline passes.
- Once integration has refused on `integration_state_unknown` with an empty path list, name the step that was unknown.

## 2. Retained partial recorded but missing, and no supported way to close it (high)

- The same result reports `partialWorktree: …/switchyard-simple-a823902e-…/worktree` and `salvage_retained`, but the directory did not exist at 10:00 EDT. The provider's diff is lost.
- `routing-run close-pending` refused with `project_lock_held` until `remediate-orphaned-locks --confirm` removed the dead-worker lock (category `project-lock-cleanup-failed-dead`). It then refused with `partial_work_retained`, because the run record still says `worktree.state: "retained"`.
- `recover --run simple-19592032-…` reports `disposition: missing, reason: worktree_missing` and changes nothing. `release-partial` cannot run because the pending attempt has no `partialWorktree` in `attempts`.
- The routing run therefore keeps `pendingAttempt` forever. The workaround is to abandon the routing-run ID.

Requests:
- When `recover` proves `worktree_missing` with the worker not running, reconcile the record (or let `close-pending` accept that proof) so the pending attempt can close as `lifecycle_recovered`.
- Do not report `salvage_retained` unless the retained path exists at terminal time.

## 3. Check-setup probe used a version string as the executable (medium)

- Run `simple-90efbb95-8499-40e7-9b35-9c2e23945ebc`, target `antigravity`, task `c97de9dd…`: `failureReason: ENOENT`, `failurePhase: prepare`, `checkSetupStep: probe_environment`, `checkSetupSyscall: lstat`, `checkSetupExecutable: "26.11.1"`, `causeCode: check_setup_failed`.
- The checks were `./run_tests.sh -q -k briefing_feeds`, `! grep -rn feedparser etc/hermes/scripts/*.py` and `./run_tests.sh -q`. None contains `26.11.1`, so the value appears to come from environment or tool-version resolution, not from the check command. Likely area: `simple/check-session.mjs` prepare/probe (around `markStep("probe_environment")` and `readinessExecutableBasename`).
- The same attempt was classified `baseline_failed`. That wording blames the project baseline for what was a Switchyard environment failure.

Request: resolve probe executables from the check command words only, never a version string, and classify a probe ENOENT as `environment_failure` rather than `baseline_failed`.

## 4. Earlier attempt in the same run: `check_failed` with passing checks (low, needs confirmation)

- Run `simple-6f9cee95-66e9-43c4-a364-1557287caf8d` (opencode-go, task `c97de9dd…`) ended `check_failed` with the cause unknown (`owner: unknown`).
- In the retained worktree, all three declared checks passed when the captain ran them (`24 passed`, the negated grep exited 0, and the full suite reported `521 passed`).
- Suspect the `! grep …` check (shell negation plus glob) is not run through a shell in the check sandbox. If so, `--help` should say that checks are argv, not shell.

## Captain-side note

The captain had no outer bound on the background dispatch. That is fixed on the caller side and is not part of this report.
