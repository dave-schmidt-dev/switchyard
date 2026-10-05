// INV-2 gate test: bounded git apply subprocesses (Task 2.2).
// Verifies that git apply check and mutating subprocesses are bounded by
// APPLY_COMMAND_TIMEOUT_MS (60s) with SIGKILL on expiry, and that the
// trusted test seam setApplyCommandTimeoutForTests enables testing timeout
// handling within shortened bounds.
// - Timed-out check returns not-ok with existing non-mutating reasonKind (conflict).
// - Timed-out mutating apply returns applied: false with reasonKind: "integration_state_unknown"
//   and does not complete the intent.

import { ok, strictEqual, throws } from "node:assert";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	APPLY_COMMAND_TIMEOUT_MS,
	applyReviewedDiff,
	setApplyCommandTimeoutForTests,
} from "../src/switchyard/integrate/apply.mjs";
import { normalizePatch } from "../src/switchyard/integrate/diff-validation.mjs";
import { integrationGate } from "../src/switchyard/integrate/index.mjs";
import {
	buildDiff,
	commitFile,
	initRepo,
} from "./helpers/integration-gate-fixtures.mjs";
import { sourceText } from "./helpers/source-text.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const REAL_GIT = process.env.PATH.split(delimiter)
	.map((dir) => join(dir, "git"))
	.find((candidate) => {
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

describe("apply command timeout seam", () => {
	afterEach(() => {
		setApplyCommandTimeoutForTests(null);
	});

	it("pins the documented 60-second per-command production timeout", () => {
		strictEqual(APPLY_COMMAND_TIMEOUT_MS, 60000);
	});

	it("accepts only timeouts strictly shorter than the production bound", () => {
		setApplyCommandTimeoutForTests(1500);
		setApplyCommandTimeoutForTests(null);
		for (const invalid of [
			APPLY_COMMAND_TIMEOUT_MS,
			APPLY_COMMAND_TIMEOUT_MS + 1,
			0,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"1500",
			true,
			false,
		]) {
			throws(() => setApplyCommandTimeoutForTests(invalid));
		}
	});

	it("never reads the timeout from the environment or provider input", () => {
		const source = sourceText("src/switchyard/integrate/apply.mjs");
		ok(
			!source.includes("process.env"),
			"the apply seam must not be env-controlled",
		);
	});
});

describe("git apply subprocess timeout bounds", () => {
	let projectPath;
	let shimDir;
	let binDir;
	const originalPath = process.env.PATH;

	beforeEach(() => {
		projectPath = initRepo();
		commitFile(projectPath, "test.txt", "original content\n");

		shimDir = tempDir("switchyard-apply-shim-");
		binDir = join(shimDir, "bin");
		mkdirSync(binDir);

		// The PATH-shimmed git forwards ordinary and metadata commands to the real git,
		// but sleeps when asked to simulate a stalled check or mutating apply subprocess.
		const shimScript = `#!/bin/sh
real_git=${JSON.stringify(REAL_GIT)}
is_apply=0
is_check=0
is_meta=0

for arg in "$@"; do
	if [ "$arg" = "apply" ]; then
		is_apply=1
	elif [ "$arg" = "--check" ]; then
		is_check=1
	elif [ "$arg" = "--numstat" ] || [ "$arg" = "--summary" ]; then
		is_meta=1
	fi
done

if [ "$is_apply" = "1" ] && [ "$is_check" = "1" ] && [ "$SWITCHYARD_TEST_SLEEP_APPLY_CHECK" = "1" ]; then
	trap '' TERM
	exec sleep 30
fi

if [ "$is_apply" = "1" ] && [ "$is_check" = "0" ] && [ "$is_meta" = "0" ] && [ "$SWITCHYARD_TEST_SLEEP_APPLY_MUTATING" = "1" ]; then
	trap '' TERM
	exec sleep 30
fi

exec "$real_git" "$@"
`;
		writeFileSync(join(binDir, "git"), shimScript, { mode: 0o755 });
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env.SWITCHYARD_TEST_SLEEP_APPLY_CHECK;
		delete process.env.SWITCHYARD_TEST_SLEEP_APPLY_MUTATING;
		setApplyCommandTimeoutForTests(null);
		rmSync(projectPath, { recursive: true, force: true });
	});

	function createModifiedDiff() {
		const diff = buildDiff(projectPath, (dir) => {
			writeFileSync(join(dir, "test.txt"), "modified content\n", "utf8");
		});
		execSync("git checkout -- test.txt", { cwd: projectPath, stdio: "pipe" });
		return diff;
	}

	it("applies cleanly when execution finishes within the timeout bound", () => {
		const diff = createModifiedDiff();
		process.env.PATH = `${binDir}:${originalPath}`;
		setApplyCommandTimeoutForTests(5000);

		const result = integrationGate(diff, projectPath);
		strictEqual(result.success, true);
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"modified content\n",
		);
	});

	it("makes the check return a typed timeout reason within the shortened bound via integrationGate", () => {
		const diff = createModifiedDiff();
		process.env.PATH = `${binDir}:${originalPath}`;
		process.env.SWITCHYARD_TEST_SLEEP_APPLY_CHECK = "1";
		setApplyCommandTimeoutForTests(200);

		const startTime = Date.now();
		const result = integrationGate(diff, projectPath);
		const elapsed = Date.now() - startTime;

		ok(
			elapsed < 10000,
			`check timeout must fire promptly within shortened bound, took ${elapsed}ms`,
		);
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "conflict");
		strictEqual(result.reason, "git apply --check timed out");
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"original content\n",
			"timed-out check must not mutate the host",
		);
	});

	it("makes direct applyReviewedDiff return a typed timeout reason on stalled check", () => {
		const diff = createModifiedDiff();
		process.env.PATH = `${binDir}:${originalPath}`;
		process.env.SWITCHYARD_TEST_SLEEP_APPLY_CHECK = "1";
		setApplyCommandTimeoutForTests(200);

		const startTime = Date.now();
		const result = applyReviewedDiff(diff, projectPath, null, ["test.txt"]);
		const elapsed = Date.now() - startTime;

		ok(
			elapsed < 10000,
			`direct check timeout must fire promptly, took ${elapsed}ms`,
		);
		strictEqual(result.applied, false);
		strictEqual(result.reasonKind, "conflict");
		strictEqual(result.reason, "git apply --check timed out");
		strictEqual(
			readFileSync(join(projectPath, "test.txt"), "utf8"),
			"original content\n",
		);
	});

	it("mutating apply returns integration_state_unknown and preserves pre-apply intent status via integrationGate", () => {
		const diff = createModifiedDiff();
		const normalized = normalizePatch(diff);
		process.env.PATH = `${binDir}:${originalPath}`;
		process.env.SWITCHYARD_TEST_SLEEP_APPLY_MUTATING = "1";
		setApplyCommandTimeoutForTests(200);

		let stored = null;
		let completeCalled = false;
		const operation = {
			patchHash: createHash("sha256").update(normalized, "utf8").digest("hex"),
			paths: ["test.txt"],
		};
		const intent = {
			operation,
			acquire: () => ({ token: "lease-mutating" }),
			release: () => {},
			persist: (proof) => {
				stored = structuredClone(proof);
				return proof;
			},
			complete: (proof) => {
				completeCalled = true;
				stored = structuredClone(proof);
				return proof;
			},
			read: () => (stored ? structuredClone(stored) : null),
		};

		const startTime = Date.now();
		const result = integrationGate(diff, projectPath, {
			requiredPaths: ["test.txt"],
			integrationIntent: intent,
		});
		const elapsed = Date.now() - startTime;

		ok(
			elapsed < 10000,
			`mutating apply timeout must fire promptly within shortened bound, took ${elapsed}ms`,
		);
		strictEqual(result.success, false);
		strictEqual(result.reasonKind, "integration_state_unknown");
		strictEqual(result.reason, "git apply timed out");
		strictEqual(
			completeCalled,
			false,
			"intent.complete must not be called when mutating apply times out",
		);
		strictEqual(
			stored?.status,
			"pending",
			"intent status must equal its pre-apply value (pending)",
		);
		strictEqual(intent.read()?.status, "pending");
	});

	it("mutating apply returns integration_state_unknown on direct applyReviewedDiff without intent", () => {
		const diff = createModifiedDiff();
		process.env.PATH = `${binDir}:${originalPath}`;
		process.env.SWITCHYARD_TEST_SLEEP_APPLY_MUTATING = "1";
		setApplyCommandTimeoutForTests(200);

		const startTime = Date.now();
		const result = applyReviewedDiff(diff, projectPath, null, ["test.txt"]);
		const elapsed = Date.now() - startTime;

		ok(elapsed < 10000);
		strictEqual(result.applied, false);
		strictEqual(result.reasonKind, "integration_state_unknown");
		strictEqual(result.reason, "git apply timed out");
	});

	it("mutating apply preserves intent status on direct applyReviewedDiff with intent", () => {
		const diff = createModifiedDiff();
		const normalized = normalizePatch(diff);
		process.env.PATH = `${binDir}:${originalPath}`;
		process.env.SWITCHYARD_TEST_SLEEP_APPLY_MUTATING = "1";
		setApplyCommandTimeoutForTests(200);

		let stored = null;
		let completeCalled = false;
		const operation = {
			patchHash: createHash("sha256").update(normalized, "utf8").digest("hex"),
			paths: ["test.txt"],
		};
		const intent = {
			operation,
			acquire: () => ({ token: "lease-direct" }),
			release: () => {},
			persist: (proof) => {
				stored = structuredClone(proof);
				return proof;
			},
			complete: (proof) => {
				completeCalled = true;
				stored = structuredClone(proof);
				return proof;
			},
			read: () => (stored ? structuredClone(stored) : null),
		};

		const startTime = Date.now();
		const result = applyReviewedDiff(normalized, projectPath, intent, [
			"test.txt",
		]);
		const elapsed = Date.now() - startTime;

		ok(elapsed < 10000);
		strictEqual(result.applied, false);
		strictEqual(result.reasonKind, "integration_state_unknown");
		strictEqual(result.reason, "git apply timed out");
		strictEqual(completeCalled, false);
		strictEqual(stored?.status, "pending");
	});
});
