// @test-phase: other
import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { buildGuardedPrompt } from "../src/switchyard/simple/guarded-prompt.mjs";

const BASE_OPTIONS = {
	promptText: "Fix the bug.",
	files: ["src/a.mjs", "src/b.mjs"],
};

test("no checks and no read-only inputs gives the original guarded prompt", () => {
	strictEqual(
		buildGuardedPrompt({ ...BASE_OPTIONS }),
		"Fix the bug.\n\nWork only in the current disposable checkout. Change only these writable files: src/a.mjs, src/b.mjs. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.",
	);
});

test("read-only inputs add the read-only notice", () => {
	strictEqual(
		buildGuardedPrompt({
			...BASE_OPTIONS,
			readOnlyInputs: ["docs/input.md"],
		}),
		"Fix the bug.\n\nWork only in the current disposable checkout. Change only these writable files: src/a.mjs, src/b.mjs. Read-only input paths (do not modify): docs/input.md. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.",
	);
});

test("checks add the acceptance check paragraph with both commands in order", () => {
	const prompt = buildGuardedPrompt({
		...BASE_OPTIONS,
		checks: ["ruff check .", "swiftlint --strict"],
	});
	const scopeSentence =
		"Fix the bug.\n\nWork only in the current disposable checkout. Change only these writable files: src/a.mjs, src/b.mjs. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.";
	strictEqual(
		prompt,
		`${scopeSentence}\n\nAfter you finish, these acceptance checks run against your candidate in an independent trusted checkout and must all pass. Write code that satisfies them, including formatting, import order, lint rules and types:\n- \`ruff check .\`\n- \`swiftlint --strict\``,
	);
	strictEqual(
		prompt.indexOf("- `ruff check .`") <
			prompt.indexOf("- `swiftlint --strict`"),
		true,
	);
});

test("an empty checks array adds nothing", () => {
	strictEqual(
		buildGuardedPrompt({ ...BASE_OPTIONS, checks: [] }),
		"Fix the bug.\n\nWork only in the current disposable checkout. Change only these writable files: src/a.mjs, src/b.mjs. Do not delegate, plan recursively, commit, push, access credentials, or change any other path.",
	);
});

const RED_PARAGRAPH =
	"These acceptance checks already fail on the unmodified checkout, before your change:\n- `ruff check .`\n- `swiftlint --strict`\nMake the failures your task is responsible for pass. Do not weaken, skip, or delete unrelated tests to turn a check green; if a pre-existing failure is outside your task and your declared files, leave it and finish the task.";

test("an empty red-at-baseline list leaves the checks prompt byte-identical", () => {
	const options = { ...BASE_OPTIONS, checks: ["ruff check ."] };
	strictEqual(
		buildGuardedPrompt({ ...options, redAtBaselineChecks: [] }),
		buildGuardedPrompt(options),
	);
});

test("red-at-baseline checks append one paragraph naming the commands in order", () => {
	const checks = ["ruff check .", "swiftlint --strict", "make test"];
	const base = buildGuardedPrompt({ ...BASE_OPTIONS, checks });
	const prompt = buildGuardedPrompt({
		...BASE_OPTIONS,
		checks,
		redAtBaselineChecks: ["ruff check .", "swiftlint --strict"],
	});
	strictEqual(prompt, `${base}\n\n${RED_PARAGRAPH}`);
});

test("red-at-baseline names without declared checks add nothing", () => {
	strictEqual(
		buildGuardedPrompt({
			...BASE_OPTIONS,
			redAtBaselineChecks: ["ruff check ."],
		}),
		buildGuardedPrompt({ ...BASE_OPTIONS }),
	);
});
