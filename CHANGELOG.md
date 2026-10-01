# Changelog

Noteworthy changes follow [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Versions follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html); the compatibility contract is in [README.md](README.md).

## [Unreleased]

### Added

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

- A baseline acceptance check that fails before the provider starts no longer marks the target failed for the simple routing run; the attempt is recorded `skipped`, so later tasks in that run can still use the target.
- Simple dispatch now records a provider's real exit code, signal and timeout in `providerReliability` instead of `null` when the provider itself exits non-zero, and classifies Vibe's own upstream error block for 401/403 (`auth_expired`) and 404 (`model_unavailable`) as well as the 402 budget case, reading the status only from Vibe's own error block. 429 and 5xx stay unclassified.
- VM provider qualification no longer fails a passing canary. `dispatch run --json` prints a run-status envelope, so the script now reads the task result from the run checkpoint, proves cleanup from durable run evidence (succeeded run, `cleanupState: complete`, allocated VM gone from Parallels) and keeps the run store out of the fixture repo's changed-path check.
- Fixed implementor-priority lookup ignoring an exact target id. A target that shares a harness with an earlier target (`vibe-code` beside `vibe`) resolved to no priority, so the simple routing run dropped it and failed with `routing_selection_invalid`; an exact target id now resolves to its own roster entry.
- Fixed the routing-run lifecycle check comparing a `lastFailure.result` field that real run records never persist. Every failed attempt therefore stayed pending with no failed target recorded, so the waterfall never excluded a failed provider and later tasks stopped with `pending_attempt_exists`. It now compares `errorKind`, and the test fixture uses the real record shape.
- Removed Vibe's `--max-turns 12` cap from the simple bridge and the VM adapter. Vibe exited 1 at the cap even after writing correct edits, so the run was recorded as a provider failure.
- Removed the local Vibe and OpenCode Go bridge's 64-request ceiling and added durable, content-free outcome records for each proxy request.

- Simple routing runs now retain failed-target exclusions across tasks in the same project/run, preventing repeated attempts against a failed target.

### Changed

- Tier-1 routing is now pace-aware: it picks the eligible tier-1 target furthest ahead of pace (Gradus `pace_delta`), with roster order only breaking ties, instead of draining tier 1 in roster order.
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
