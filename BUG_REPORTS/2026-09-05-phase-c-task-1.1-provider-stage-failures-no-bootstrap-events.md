# Bug report: two consecutive runs fail at the provider stage with only two events recorded

Date observed: 2026-09-05 22:41 and 22:43 EDT
Observed from: `fairaday_labs`, Phase C Task 1.1 (low, two-file schema widening), runs
`dd183690-8e39-49fd-9f5d-3c290f242f02` (Vibe glm-5.2-low) and
`1f7367b4-4f40-4a19-839d-b37ca4144304` (OpenCode Go opencode-go/mimo-v2.5, Vibe excluded on a fresh checkpoint)
State root: `<fairaday_labs>/.logs/switchyard`

## Summary

1. Run `dd183690`: `task_failed` at 02:41:46Z (63 s after queue start) with
   `diagnosticCode: provider_exit_nonzero`, `exitCode 1`, `failurePhase: provider_execution`,
   `diagnosticOrigin: adapter`, `diagnosticEvidenceAvailable: true`. `events.jsonl` holds only
   two events (`task_failed`, `run_failed`); there is no `aqua_ready`, `container_created`,
   `task_routed`, or provider start event, so the trail cannot show what the adapter saw.
   `run.json.startedAt` and `finishedAt` are both null on a failed run.
2. Run `1f7367b4`: `task_failed` at 02:43:16Z (34 s) with `errorKind: diff_capture_failed`,
   `reason: "Diff capture failed."`, no exit code, no phase. Same two-event trail.
3. A third attempt before these (`ca56b2e4`) failed in 9 ms with
   `checkpoint_queue_identity_mismatch` because `--exclude-provider` changes the queue identity
   while the default checkpoint path stays the same; the CLI should say that a new checkpoint
   path is needed (or derive one) instead of `repair_contract`.
4. Earlier, the first dispatch failed with `queue_contract_invalid` for a directory-only Files
   entry (`verifications/`); the human report line named the task and reason, but the `--json`
   envelope carried no message, only `reasonCode`.

## Impact

Task 1.1 was a two-file, DB-free, low-capability task. The captain followed the manifest
fallback to headless-worktree after two provider-stage failures totalling under two minutes.
None of the three failures produced adapter evidence in the run directory, so the captain
cannot tell a provider outage from a Switchyard defect. Where `diagnosticEvidenceAvailable`
is true, the run directory should contain (or point at) the stderr tail.

## Requests

- Persist the adapter stderr tail (or a path to it) in `events.jsonl`/`run.json` when
  `diagnosticEvidenceAvailable` is true.
- Emit the bootstrap events (`aqua_ready`, `container_created`, `task_routed`) before a
  provider-stage failure so the trail shows how far the run got.
- Put the human diagnostic message into the `--json` envelope for contract failures.
- Treat `--exclude-provider` on an existing checkpoint as a new queue identity with a clear
  message, or key the checkpoint on the identity.

## Recurrence: Task 2.1 (2026-09-06 02:52Z)

Same task file, fresh checkpoint (`...tasks.md.checkpoint.p2.json`), default queue, `--task-id 2.1`.
Run `209eadc6-e7f1-4b4a-bbb8-174186002761` in `fairaday_labs/.logs/switchyard/runs/`: Parallels VM
booted (`switchyard-work-209eadc6-...macvm`), first event is `task_failed` at sequence 1
(provider Vibe, `zhipu/glm-5.2-high`, `provider_exit_nonzero`, `failurePhase: provider_execution`)
after 371 s, then `run_failed`. Again no bootstrap or provider-start events precede the failure,
and `resources/` holds only the Parallels allocation intent. Disposition `advance_authorized_fallback`;
the task was routed to headless-worktree/standard per the authorization manifest.
Three consecutive Phase C dispatches (1.1 twice, 2.1 once) have now failed at provider stage with
no diagnostic evidence surfaced in the project state root, so the priority-1 pool has yielded no work.

## Recurrence: Task 2.2 (2026-09-06 03:09Z and 03:16Z)

- Run `1c32a2fb`: `checkpoint_queue_identity_mismatch` on `...checkpoint.p2.json` after the task
  file's Status lines changed, plus `dependencyBlocked: 1` because Task 2.1 (integrated through
  headless-worktree, not Switchyard) was neither in `completedTaskIds` nor marked done. There is no
  documented way to mark a task complete in a checkpoint from outside Switchyard; setting
  `Status: done` in the task file works for the dependency gate but `workflow-validate
  --switchyard-ready` rejects it ("switchyard task Status must be 'pending' or 'in progress'").
- Run `3f221960` (fresh `.p3.json`): VM booted, Vibe `zhipu/glm-5.2-high` `provider_exit_nonzero`
  at sequence 1, ~6 min, no bootstrap events, no diagnostic evidence in `resources/`. Fourth
  consecutive provider-stage failure with the same signature.

## Recurrence: Task 3.1 (2026-09-06 03:24Z and 03:31Z)

- Reusing `.p3.json` with `--task-id 3.1` gave `checkpoint_queue_identity_mismatch`: the queue
  identity includes the selected task ids, so every `--task-id` invocation needs its own checkpoint
  path. Neither `--help` nor the failure envelope says so.
- Fresh `.p3-3.1.json`: Vibe `provider_exit_nonzero` again (fifth consecutive provider-stage
  failure, same signature, ~6 min each). Routed to headless-worktree/standard.

## Recurrence: Task 3.2 (2026-09-06 03:36Z)

Fresh `.p4-3.2.json`, `--task-id 3.2`: Vibe `provider_exit_nonzero` at sequence 1 in under two
minutes. Sixth consecutive provider-stage failure; routed to headless-worktree/standard.

## Recurrence: Task 4.2 (2026-09-06 03:52Z)

Fresh `.p5-4.2.json`, `--task-id 4.2` (capability low, docs only): Vibe (descriptor
`sha256:bfb64bc6...`) failed with `diff_capture_failed` and the run disposition was `stop` /
`insufficient_evidence`, so the `--json` envelope offered no fallback direction even though the
authorization manifest lists headless-worktree/low. Seventh consecutive Phase C dispatch with no
integrated work from the Switchyard pool. Routed to headless-worktree/low by the captain.

Follow-up: the headless-worktree/low fallback for 4.2 (salvage
`4.2.55652359e0794e5b9db6c4c8d80bfcf9`) returned `empty_change_set`; the worker claimed the task
file "omits all exact find/replacement text", which is false (the `[Task 4.2 details]` block
carries every find/replace pair verbatim). The captain applied the five edits natively and
committed 6af34db. Phase C closed with zero integrated work from the Switchyard pool across
seven dispatches; every task landed through headless-worktree salvage or native fallback.

## Recurrence: Phase D+E Task 1.1 canary (2026-09-06 15:05Z, Switchyard HEAD 1c742b1)

Task file `phase-de-tier2-engine-board-labs-2026-09-06-tasks.md` (11 tasks: 8 standard, 2 high, 1 low),
fresh checkpoint `...checkpoint.1.1.json`, `--task-id 1.1` (standard).

- `launch` (run `f3bb4612`): `worker_boot_failed` at sequence 1, `errorKind: environment_incomplete`,
  `failurePhase: queue_preflight`, `diagnosticEvidenceAvailable: true`, but `boot-stderr.log` is empty
  and the `--json` envelope says only "The selected queue environment did not pass preflight." with
  disposition `repair_contract` / `environment_incomplete`, which points at the host.
- `run` (run `0f7f47ea`, foreground) shows the real cause: `macOS queue provider preflight failed: high:
  no_golden_image_verified_provider_with_quota_headroom (... Codex: no_quota_headroom, everything else
  below_required_capability)`. The selected task is standard. `preflightMacosQueue`
  (`src/switchyard/router/index.mjs` ~472-484) builds `taskTiers` from every non-terminal switchyard task
  in the file and never consults `selectedTaskIds`, which the runner does pass (`runner/index.mjs` ~8314).
  So one high task anywhere in a queue blocks every `--task-id` run of a standard task.

Requests: filter preflight tiers by `selectedTaskIds` (and `maxTasks`) when given; surface the preflight
detail string in the `launch` envelope and `boot-stderr.log` (the `run` path prints it, the `launch` path
loses it). Disposition: eighth consecutive dispatch with no Switchyard work; Phase D+E routed to
headless-worktree per plan decision 19.

## Recurrence: wwpis access-reset build, Phase 1 (2026-09-06 14:53Z to 15:00Z)

Observed from `wwpis` (`<wwpis>/.logs/switchyard`), task file
`.plans/wwpis/2026-09-06-access-reset-and-onboarding-tasks.md`, seven Phase 1 tasks selected by `--task-id`.

- Run `4ab29e95`: bootstrap events present this time (`aqua_ready`, `container_created`, `task_routed` to Vibe
  `zhipu/glm-5.2-low`), provider ran 39 s, `execution_failed` exit 1, failure diff capture empty, then
  `task_base_validate failed` and `task_base_release_failed` ("immutable base release uncertain; recovery
  required"), queue halted with `diff_capture_failed`. `recover --run` reclaimed nothing and released nothing.
- Run `e5436f8d` (`--exclude-provider vibe`, same checkpoint path): `checkpoint_queue_identity_mismatch`, as
  documented above. Checkpoint set aside manually.
- Run `91e981d0` (`--exclude-provider vibe`): routed to OpenCode Go `opencode-go/mimo-v2.5`, provider exited 1
  within one second of `execution_started`, diff capture `transport_failed`, base released cleanly, run failed.
- Run `6b837fcd` (`--only-provider codex`, fresh checkpoint): `worker_boot_failed` `environment_incomplete`
  at `queue_preflight` (Codex is not an eligible target for this project's queue).
- Ledger across all projects shows no successful Switchyard integration since 2026-09-04 (Copilot); every
  dispatch on 2026-09-05 and 2026-09-06 failed at provider stage (Vibe, OpenCode Go) with no adapter evidence
  in the state root.
- The manifest fallback `headless-worktree/low` then failed at provider start because the Codex account
  usage limit is exhausted until 2026-09-11 (`provider.stderr` in the salvage bundle), so the build advanced to
  native child workers.

Additional request: `switchyard-dispatch launch` accepted a task file whose native task carried a directory-only
`Files` entry only after it was removed; `workflow-validate --switchyard-ready` had passed the same file. The two
validators disagree on directory entries and on wildcards; one of them should own that rule.

## Recurrence: opencode-go roster canary + old-model control (2026-09-10 12:45Z–12:58Z)

Observed from `~/.agent/tools/canary` (state root `~/.agent/tools/canary/work/project/.logs/switchyard`),
while promoting new `opencode-go` slots (DeepSeek V4.1 Flash, `opencode-go/deepseek-flash`).

- Run `3ece30ba`: failed ~1.5 s after routing with `provider_exit_nonzero` / `failurePhase:
  provider_execution` / `diagnosticEvidenceAvailable: false`, and **no bootstrap events at all** —
  the two-event trail of the original report. A sibling run `1bbc2d36` a few seconds later failed at
  `queue_preflight` with `vm_host_service_degraded`, so the host dispatcher was transiently unhealthy.
- Host health then verified by hand: `prl_disp_service` running, `prlsrvctl info` clean, and the exact
  readiness command the backend issues (`prlctl list -a -o uuid,status,name`, see
  `src/switchyard/lifecycle/parallels-execution-backend.mjs` `probeHostReadiness`) returned five VMs
  in 0.14 s. `remediate-orphaned-locks --dry-run` found nothing.
- Run `dc15e73b` (12:52:34Z–12:53:58Z), same new descriptor
  `sha256:47355b8fbc7c9cc8916c79c02179e057333669628df4f563f88fa6a1249ab8b9`
  (`opencode-go/deepseek-flash`, `--variant low`): this time the bootstrap trail **is** present —
  `worker_started`, `run_started`, `queue_preflight succeeded`, Parallels allocation intent written —
  and the provider ran ~38 s inside the VM before `process_completed failed` →
  `execution_failed` (`evidenceAvailable: false`) → `artifact_capture` (diff, `captured: false`) →
  `integration_evidence_unavailable` → `task_postcondition rejected` → `run_failed`
  (`diff_capture_failed`). `resources/` holds only the allocation intent; no provider stderr anywhere.
- **Control run `ec493783` (12:57:51Z–12:58:35Z)**: identical dispatch with
  `SWITCHYARD_ROSTER_PATH` pointing at a copy of the live roster whose `opencode-go.low` slot was
  reverted to the *previous* model, `opencode-go/mimo-v2.5`, descriptor
  `sha256:3e05eaa3ac9c8d515bb27264c07bdcde2430936550dbe967b2d7d388657e4f28` — which still carries a
  **real, non-scaffolded `dispatch_qualified` receipt** in `~/.agent/roster.json` from 2026-08-16
  (no scaffold was needed or used). It failed the same way: bootstrap events present,
  `provider_exit_nonzero`, `exitCode 1`, `failurePhase: provider_execution`,
  `diagnosticEvidenceAvailable: false`, `run_failed` / `execution_failed`, in ~44 s.

**Conclusion:** in-VM OpenCode Go dispatch is broken independently of the model. The control uses the
exact descriptor that was successfully promoted on 2026-08-16, so this is not new-model fallout and
not a roster problem — it matches this report's `1f7367b4` (2026-09-05, mimo, `diff_capture_failed`,
34 s) and `91e981d0` (2026-09-06, mimo, exit 1 within a second). Five days on, still no adapter
stderr is retained, so the actual provider error remains unknown. The first request in this report —
persist the adapter stderr tail — is what blocks diagnosis; nothing else can be concluded from the
run directory.

Side effect: `opencode-go` now has no `dispatch_qualified` receipt for either live slot, so
`evaluateRealRosterCoherence` reports it ineligible for automatic routing at both `low` and
`standard`. The prior `low` eligibility was a within-30-day receipt on a route that had in fact been
failing since at least 2026-09-05.
