# Bug report: integrationGate reports `no_op_diff` for a real change when a touched path is already dirty

Date identified: 2026-08-10 (America/New_York)

Provenance: found by **static review**, during the expanded (round-2) external
review of the macOS VM execution backend plan. This is **not** an observed
production incident — no run is claimed to have hit it. The defect is
established by reading the code and the existing test, both cited below.

Invariant: **INV-2** — "Code returns to the Mac only through the explicit,
reviewed integration step." Gate test: `tests/integration-gate.test.mjs`.

## Summary

`integrationGate` decides whether an applied diff was a semantic no-op by
comparing `git status --porcelain`, scoped to the diff's touched paths, before
and after `git apply`. Porcelain status reports a **state letter**, not file
content. If a touched path is *already modified* before the gate runs, its
status is ` M <path>` both before and after a genuine, non-overlapping edit, so
the two snapshots compare equal and the gate returns `no_op_diff`.

The result is the worst pairing available: **the host file is really modified,
and Switchyard durably books an integration failure.** Queue accounting then
disagrees with the working tree.

## Affected code

`src/switchyard/integrate/index.mjs:618-632`:

```js
	let preStatus = "";
	if (requiredPaths === null) {
		preStatus = getScopedStatus(projectPath, validation.touchedPaths);
	}

	const applyResult = applyReviewedDiff(patch, projectPath);
	if (applyResult === true) {
		if (requiredPaths === null) {
			const postStatus = getScopedStatus(projectPath, validation.touchedPaths);
			if (preStatus === postStatus) {
				return { success: false, message: "no_op_diff" };
			}
		}
		return { success: true, message: "Diff applied successfully" };
	}
```

The comment directly above says the scoping exists "so pre-existing unrelated
dirty state in other files never triggers a false no-op report." That reasoning
is correct for *other* files and is what the existing test covers. It does not
hold for dirty state in a **touched** file, which is the case this report is
about.

## Reproduction

1. `git commit` a file `target.txt` with contents `a\nb\nc\n`.
2. Modify it on disk so it is dirty but do **not** stage or commit —
   e.g. append a line, giving status ` M target.txt`.
3. Apply a structurally valid diff through `integrationGate` that makes a real,
   non-overlapping content change to `target.txt` (one that `git apply`
   accepts against the dirty working-tree content).
4. Observe: `target.txt` on disk has genuinely changed, and `integrationGate`
   returns `{ success: false, message: "no_op_diff" }`.

Both snapshots are ` M target.txt`; the content change is invisible to the
comparison.

## Expected behavior

A diff that produces a real content change to a touched path must return
`{ success: true }` regardless of whether that path was dirty beforehand. No-op
detection must compare **content**, not porcelain state — for example by
comparing a hash of the touched paths' contents (or `git diff` output for those
paths) before and after apply, rather than the status letters.

## Existing test coverage and the gap

`tests/integration-gate.test.mjs:452-481` — "detects a no-op diff (hunks net to
zero content change) even with unrelated dirty state" — commits both
`target.txt` and `other.txt`, dirties **`other.txt`** (a path the diff does not
touch), and asserts `no_op_diff` for a genuinely no-op hunk.

That test pins the *opposite* case: dirty state in an **untouched** file. There
is no test in which a **touched** file is dirty at gate time. The regression
test for this bug must dirty `target.txt` itself and assert `success: true` for
a real change.

## Severity and scope

High. It is a false negative on the single sanctioned host-write path, and it
fails in the direction that corrupts bookkeeping rather than the direction that
merely blocks work. Note the inverse case is *not* affected: a genuine no-op on
a clean touched path is still correctly detected.

Not fixed here. Filed separately rather than folded into the macOS VM execution
backend plan, which is unrelated work; absorbing it there would have hidden a
shipped-code defect inside a spike.
