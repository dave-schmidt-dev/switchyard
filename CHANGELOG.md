# Changelog

Noteworthy changes follow [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html); the compatibility contract is in [README.md](README.md).

## [Unreleased]

### Added

- Simple dispatch can run Claude Code (`--only-provider claude-code`, Haiku 4.5, Sonnet 5.5 or Opus 5.5 with an explicit effort) in a native Seatbelt sandbox on its own subscription login. It is never chosen automatically, and auth, missing-model and usage-limit failures are classified for routing.
- `switchyard-dispatch routing-run release-partial --task-id <id> [--discard]` frees a retained partial worktree after the captain salvages it, so the routing run can continue without losing its failure memory. It verifies the worktree claim and refuses symlinks, a held project lock or ambiguous cleanup.
- A failed simple check now keeps its last 16 KiB of output and stderr under the run's owner-only `check-evidence/` directory (`<attempt>-<check position>.log`, attempt 0 is the baseline), and the result carries only that path. Diff rejections report a closed reason kind and up to five bounded, control-character-free paths.
- Simple run records now move to `running` with `startedAt` when the provider starts and record a throttled heartbeat, instead of staying `created` until integration.
- Simple routing logs every failed attempt and every non-complete stop to `<stateRoot>/failure-log/failures.jsonl` (allowlisted fields only, rotated, best-effort), and `switchyard-dispatch routing-run failures [--since <RFC3339>] [--json]` groups them by fingerprint for periodic routing and provider tuning.

### Removed

- The `gc` and `reconcile-completion` operator subcommands, with their helpers (`apfs-private-bytes.py`, the external-completion reconciliation modules) and tests. `recover` keeps the shared root-cleanup logic. `backend-health`, `remediate-orphaned-locks` and `health attest-repair` stay: each has a live caller or contract.
- The seam-move and module-split refactor tooling (`check:seams`, `split:module`, their scripts and tests, and the direct `oxc-parser` devDependency).
- The orphaned Docker-era `ops/set-opencode-mistral-key.sh`.

### Security

- Host git calls on a provider-writable disposable clone pin `core.fsmonitor`, `core.hooksPath`, `diff.external`, `core.attributesFile` and `core.commitGraph`, and the clone's `.git` control state is snapshotted before the provider runs and verified, case-insensitively, before every host git read. Tampered, unreadable or redirected control state (hooks, config, alternates, http-alternates, replace refs) fails closed as `unsafe_diff` with diagnostic `git_control_tampered` and a closed-enum `gitControlTamper {kind, area}`; a trusted shared-clone detach is accepted.

### Changed

- Biome now fails on unused imports, variables and function parameters; existing unused imports and exports were removed.
- Simple routing now separates hard and soft failures. Failed checks, empty diffs, provider errors, provider-phase environment failures and scope rejections move on to the next eligible tier 1 or tier 2 target (up to four attempts per task) instead of stopping the run; baseline, cleanup, cancellation, input, lock and run-store failures still stop. `native_required` reports whether capacity or task failures exhausted the targets, and every answer lists retained partial worktrees.

### Fixed

- Integration `git apply` check and apply subprocesses stop after 60 seconds (SIGKILL). A timed-out check reports `conflict`; a timed-out mutating apply reports `integration_state_unknown`.
- A simple run that hits its deadline now reports the files the provider changed so far.
- `simple --json` failures carry a sanitized `usageError` or `preflightCode` instead of a bare failure.
- An uncertain idempotent project-lock release is retried once when the holder is provably dead or is the current process. `remediate-orphaned-locks` reports `release_uncertain` truthfully and refuses when ownership cannot be confirmed; a live foreign holder is never released.
- Native launcher failure messages no longer include provider stderr excerpts.
- The bulk-transfer helper tolerates a `prlctl` child that exits before reading its stdin (EPIPE/ECONNRESET) and leaves the outcome to the bounded retry.
- Broker, provider-lifecycle and quick-check fixtures wait on observable events instead of wall-clock sleeps, so they hold under parallel host load.
- Dispatch checks no longer hang or fail on process-group cleanup, `/bin/sh` scripts or temp-path resolution: the quick-check sandbox now lets a check signal processes in its own sandbox, read the `/private/var/select` shell link, and read metadata on the `/var`, `/tmp` and `/etc` links.
- Integration now rejects incomplete Git metadata and stops stalled metadata checks after 30 seconds, preventing unsafe acceptance and indefinite waits.

## [0.3.0] - 2026-10-02

### Added

- Routing-run inspection now reports bounded failure ownership/actions and verified attempt versus unique-task success totals, with missing linked evidence and cleanup reported separately.

- `vibe-code` now runs in the VM queue lane as well as the simple lane: it is a golden-image verified provider, both capability classes hold `dispatch_qualified` receipts from real VM canaries, and `provider-qualification.mjs` accepts `--lane simple|vm` to force the VM canary for a simple-compatible target.
- Add a closed version-1 `providerReliability` diagnostic to simple terminal results, including cause, phase, bounded process/check evidence, baseline and diff outcomes, and one-repair status without provider output or prompt content.
- Add opt-in pre-provider baseline checks and one bounded acceptance-check repair to simple dispatch, plus optional queue-task `Baseline checks` and `Repair checks` declarations. Queue repair checks must be a subset of `Quick checks`, and acceptance reruns the complete declared set after correction. Synchronous queue repair refuses an unresolved started enforce-mode half-open claim; shadow/no-claim repair remains available, and asynchronous repair waits for matched terminal evidence and settled health.
- Keep route-health decisions in shadow mode by default, with explicit queue or simple-path enforcement controls that can only suppress an otherwise eligible route.
- Add offline target inventory and exact-descriptor planning for representative qualification; execution remains explicit and never promotes a descriptor automatically.
- Simple dispatch classifies a Vibe HTTP 402 budget-exhausted error (Mistral `billing_*_budget_exhausted`) as the trusted `quota_exhausted` diagnostic instead of a generic provider exit, so route health can apply its provider cooldown.
- Add a `vibe-code` simple-lane target that runs native headless `vibe -p` on Vibe's keychain login inside a Seatbelt sandbox, so it bills the Included Vibe Code allowance while `vibe` keeps spending the API allowance. The bridge and its broker pin are unchanged.
- Add `ops/macos-vm/update-guest-clis.sh`, an in-place updater for the golden VM's provider CLIs that keeps guest logins, checks each CLI against the pinned manifest, reinstalls only the ones that differ, and fails closed unless every `--version` matches. Bump the manifest to claude 2.1.285, codex 0.159.2, agy 1.2.14, cursor-agent 2026.09.28, copilot 1.0.89, opencode 1.18.30 and vibe 2.25.0.
- Add `ops/macos-vm/sync-host-clis.sh` and `ops/macos-vm/sync-clis.sh` (`npm run cli:sync`, `npm run cli:check`) so the host and the golden VM run the same manifest-pinned CLI releases, and add `--check` to the guest updater. The manifest now pins opencode 1.18.30 (the Homebrew formula's release) and vibe 2.25.0 on both lanes.

### Fixed

- Mocked queue regression tests use deterministic availability rather than live provider quota.
- Simple acceptance checks now run in fresh disposable checkers outside the provider workspace, with offline provisioning of unchanged locked Node dependencies and fail-closed refusal when required tools or cache entries are unavailable.
- Guarded Vibe, Vibe Code, and OpenCode launchers refuse unavailable sandbox environments before provider or broker start.
- Failed simple runs persist terminal failure and cleanup intent before destructive cleanup, including a final disposition when no clone was allocated. A stopped checkout with corrected changes is retained when the one allowed repair still fails acceptance.
- New typed environment, contract, check, cancellation, cleanup and unknown failures no longer poison routing provider memory. Retries share a logical task identity and exclude failed targets immediately; environment failures stop without automatic replay.

- Simple project-lock conflicts report live-holder deferral or a proven-dead holder’s exact recovery command; unknown ownership stops without launching a provider.
- Isolate system Python cleanup helpers from caller paths, environment and startup hooks.
- Persist failed cleanup and retained-worktree details when simple-run finalization fails.
- Simple runs persist bounded route-time snapshot, candidate pace and exclusion evidence, refreshed when health admission requires rerouting.
- Package acceptance checks use only matching lock-installed local tools; missing or ambiguous dependencies and unsupported npm forms fail closed instead of resolving cached or downloaded binaries.
- Provider deadline kills retain the distinct `provider_deadline_exceeded` reliability cause and timeout/signal evidence.
- Restore the OpenCode Go simple bridge with a hash-verified official 1.18.30 runtime isolated from host V2, preserving proxy-only containment and exact approved low/max model variants. Both existing BWS executable trust pins now match the tested bridge following owner approval; earlier live canaries predate this runtime restoration.
- A baseline acceptance check that fails before the provider starts no longer marks the target failed for the simple routing run; the attempt is recorded `skipped`, so later tasks in that run can still use the target.
- Simple dispatch now records a provider's real exit code, signal and timeout in `providerReliability` instead of `null` when the provider itself exits non-zero, and classifies Vibe's own upstream error block for 401/403 (`auth_expired`) and 404 (`model_unavailable`) as well as the 402 budget case, reading the status only from Vibe's own error block. 429 and 5xx stay unclassified.
- VM provider qualification no longer fails a passing canary. `dispatch run --json` prints a run-status envelope, so the script now reads the task result from the run checkpoint, proves cleanup from durable run evidence (succeeded run, `cleanupState: complete`, allocated VM gone from Parallels) and keeps the run store out of the fixture repo's changed-path check.
- Fixed implementor-priority lookup ignoring an exact target id. A target that shares a harness with an earlier target (`vibe-code` beside `vibe`) resolved to no priority, so the simple routing run dropped it and failed with `routing_selection_invalid`; an exact target id now resolves to its own roster entry.
- Fixed the routing-run lifecycle check comparing a `lastFailure.result` field that real run records never persist. Every failed attempt therefore stayed pending with no failed target recorded, so the waterfall never excluded a failed provider and later tasks stopped with `pending_attempt_exists`. It now compares `errorKind`, and the test fixture uses the real record shape.
- Removed Vibe's `--max-turns 12` cap from the simple bridge and the VM adapter. Vibe exited 1 at the cap even after writing correct edits, so the run was recorded as a provider failure.
- Removed the local Vibe and OpenCode Go bridge's 64-request ceiling and added durable, content-free outcome records for each proxy request.

- Simple routing runs now retain failed-target exclusions across tasks in the same project/run, preventing repeated attempts against a failed target.

### Changed

- Bound `test:other` to two file workers; contract coverage runs all selected suites in one serial aggregate with existing coverage thresholds preserved.
- Tier-1 routing is now pace-aware: it picks the eligible tier-1 target furthest ahead of pace (Gradus `pace_delta`), with roster order only breaking ties and a target with no measured pace ranked below any measured one, instead of draining tier 1 in roster order.
- Simple dispatch now runs its one-shot acceptance-check repair by default: after a failing check the provider gets one scoped correction within the original deadline. Pass `--no-repair-checks` to disable it; `--repair-checks` is still accepted.
- Simple dispatch now tells the provider which acceptance checks will run against its result, so it can satisfy lint, formatting and type rules it previously never saw. Prompt construction moved to `src/switchyard/simple/guarded-prompt.mjs`.
- The command-facing simple path now exhausts eligible tier 1 and tier 2 capacity before an authorized native fallback. An actual-start receipt latches the run to native for later tasks; every task still needs its own exact authorization. The legacy queue waterfall is unchanged.

## [0.2.2] - 2026-09-28

### Changed

- Partition the remaining contract test families into bounded files while preserving registrations, scoped hooks, runtime leaf results and incident mutation coverage.

- Partition the production runner into 44 ownership modules while retaining its public queue facade API.

- Split queue task parsing, checkpoints, reconciliation, routing, and result support into bounded runner modules while preserving the queue API.

- Split dispatch arguments, handlers, execution, launch, status/results, recovery, and collection into bounded modules while preserving the CLI API.

- Split run persistence, receipts, events, locks, evidence, checkpoints, and retention into bounded modules while preserving the run-store API.

- Split source modules around error classification, authentication, integration validation, routing, lifecycle overlays, roster descriptors, and orphan scanning while preserving public entrypoints.

- Split runner, dispatch CLI, and detached-dispatch coverage into 55, 24, and 18 flat test files; keep VM-sensitive test execution explicit and TAP-reported.

### Fixed

- Keeps fixture-only contract execution nonzero in each detached-dispatch part while preserving the original VM skips.

- Contract gates handle large staged refactor patches with a bounded Git-output buffer, preserving complete snapshot digests.

- Test splitting preserves generated registrations, scope, source order, hooks, and initialization effects. Unsupported partial registration shapes are rejected before writing output.
- Split test files copy the helpers and imports referenced by their selected tests, avoiding dependencies used only by unselected tests.
