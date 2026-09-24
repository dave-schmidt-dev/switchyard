# Switchyard beta feedback summary — 2026-09-24

This summary groups 38 feedback blocks (33 distinct texts) from recent Codex and Claude Code sessions. Session transcripts and source links remain in the local, gitignored feedback log. A reported failure is a lead until its run receipt or a regression test establishes the cause.

## What worked

- Bounded tasks completed through Antigravity, Codex, and Copilot. A Vibe review returned structured findings.
- Failed task worktrees often retained usable partial changes for review and salvage.
- Several reported failures released their writers and project locks cleanly.

## Product findings

| Area | Evidence from feedback | Next verification |
| --- | --- | --- |
| Declared checks | Multiple callers received `check_failed` with pass/fail status but no diagnostic output and had to rerun checks in retained worktrees. One legacy queue run was reported successful despite a failed declared lint check. | Reproduce the reported false success first. Then provide bounded, safe failure diagnostics without persisting raw output or secrets. |
| Exit accounting | Several callers saw `provider_exit_nonzero` after an observed zero exit or an empty result. The agy verdict path was fixed separately; these other reports need exact receipts. | Test zero-exit/no-diff and true nonzero outcomes for each affected route while retaining the observed process exit. |
| Manifest scope | `simple` refuses declared shell scripts and build manifests before provider start with `manifest_review_required`. The integration gate already has a declared-path review option. | Design an explicit reviewed opt-in for declared sensitive paths; keep undeclared files refused. |
| Caller diagnostics | Some `no_eligible`, unsafe-diff, provider exit, deadline, and fallback-contract failures lacked an actionable reason. | Inspect exact result and event records; surface closed reason codes and remedies without copying provider text. |
| Progress and limits | Long runs emitted repeated phase heartbeats with little indication of meaningful progress. A review was reported to exceed its stated deadline. Same-project work serialized behind the project lock. | Check milestone and timeout behavior against the specific routes. Preserve the project lock's ownership guarantees. |
| Check setup and coverage | Disposable checkouts sometimes lacked project dependencies or used a different toolchain baseline. Build-only checks missed lint and UI failures. | Make task contracts name required setup and project gates; treat a task's checks as narrower than full validation. |

Provider empty output, unrelated edits, and review findings of disputed quality also appeared. Those reports do not establish a shared provider defect. Failed or empty review calls remain unavailable evidence, not approval.
