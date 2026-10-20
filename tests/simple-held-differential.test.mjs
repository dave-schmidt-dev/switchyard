// @test-phase: other
// A held run whose red-at-baseline check passed differentially, applied after
// HEAD moved, with the real sandboxed check session: the recheck judges it
// against the receipt's base-tree baselines, a peer's new failing test still
// refuses, edited baselines refuse, and a receipt without them stays strict.

import { ok, strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readRun } from "../src/switchyard/run-store/run-records.mjs";
import { updateRunWithRetry } from "../src/switchyard/run-store/run-updates.mjs";
import { applyHeldIntegration } from "../src/switchyard/simple/held-apply.mjs";
import { runSimpleTask } from "../src/switchyard/simple/index.mjs";
import { commit, git } from "./helpers/held-integration-fixtures.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(
	tempDir("switchyard-held-differential-store-"),
	"runs",
);
const sandboxed = existsSync("/usr/bin/sandbox-exec");

const CHECK = "node --test tests/legacy.test.mjs tests/feature.test.mjs";
// Two unrelated tests that already fail on the base tree, and one that passes.
const LEGACY = `import { test } from "node:test";
import { strictEqual } from "node:assert";
test("host clock", () => strictEqual(1, 2));
test("host network", () => strictEqual("a", "b"));
test("still green", () => strictEqual(1, 1));
`;
const FEATURE = `import { test } from "node:test";
import { strictEqual } from "node:assert";
import { feature } from "../src/feature.mjs";
test("feature works", () => strictEqual(feature(), 42));
`;

function projectFixture() {
	const root = tempDir("switchyard-held-differential-repo-");
	const projectPath = join(root, "project");
	mkdirSync(join(projectPath, "tests"), { recursive: true });
	mkdirSync(join(projectPath, "src"));
	writeFileSync(join(projectPath, "tests", "legacy.test.mjs"), LEGACY);
	writeFileSync(
		join(projectPath, "src", "feature.mjs"),
		"export const feature = () => 0;\n",
	);
	git(projectPath, ["init", "-q"]);
	commit(projectPath);
	const promptPath = join(root, "prompt");
	writeFileSync(promptPath, "Make feature() return 42 and test it.");
	return { root, projectPath, promptPath };
}

/** Hold one task whose only check passes by differential acceptance. */
async function heldDifferential() {
	const repo = projectFixture();
	const result = await runSimpleTask(
		{
			...repo,
			capability: "standard",
			files: ["src/feature.mjs", "tests/feature.test.mjs"],
			checks: [CHECK],
			repairChecks: false,
			deadlineMs: Date.now() + 240_000,
			integrateMode: "hold",
		},
		{
			tmpdir: repo.root,
			route: () => ({ provider: "Codex (Spark)", reason: "priority_fill" }),
			resolveTargetIdentity: () => ({
				targetId: "codex",
				harnessKey: "codex",
				ambiguous: false,
			}),
			getInvocationDescriptor: () => ({
				target_id: "codex",
				selector: "gpt-5.3-codex-spark",
				invocation_args: [],
			}),
			assertFundedRoute: () => {},
			executeProvider: async ({ worktreePath }) => {
				writeFileSync(
					join(worktreePath, "src", "feature.mjs"),
					"export const feature = () => 42;\n",
				);
				writeFileSync(join(worktreePath, "tests", "feature.test.mjs"), FEATURE);
				return { success: true, writerLifecycle: "stopped" };
			},
		},
	);
	strictEqual(result.status, "succeeded", JSON.stringify(result));
	strictEqual(result.integration.state, "held");
	strictEqual(result.checkAcceptance, "differential");
	return { repo, result };
}

const apply = (repo, runId) =>
	applyHeldIntegration(
		{ projectPath: repo.projectPath, runId, deadlineMs: Date.now() + 240_000 },
		{ tmpdir: repo.root },
	);
const feature = (repo) =>
	readFileSync(join(repo.projectPath, "src", "feature.mjs"), "utf8");
const UNCHANGED = "export const feature = () => 0;\n";

function peerCommit(repo, path, text) {
	writeFileSync(join(repo.projectPath, path), text);
	commit(repo.projectPath, "peer");
}

// Rewrite the held receipt and name its new digest in the run record, as a
// writer of both would; only validation stands between it and the apply.
async function resign(result, edit) {
	const { receiptPath } = result.integration;
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	const bytes = `${JSON.stringify(edit(receipt))}\n`;
	writeFileSync(receiptPath, bytes);
	const record = await readRun(result.runId);
	await updateRunWithRetry(result.runId, {
		terminalSummary: {
			...record.terminalSummary,
			integration: {
				...record.terminalSummary.integration,
				receiptSha256: createHash("sha256").update(bytes).digest("hex"),
			},
		},
	});
}

test("a differentially accepted held run applies after an unrelated peer commit", {
	skip: !sandboxed,
}, async () => {
	const { repo, result } = await heldDifferential();
	const receipt = JSON.parse(
		readFileSync(result.integration.receiptPath, "utf8"),
	);
	strictEqual(receipt.schemaVersion, 2);
	const [stored] = receipt.differentialBaselines;
	strictEqual(stored.command, CHECK);
	ok(
		stored.tests.some(
			([id, status]) =>
				id === "tests/legacy.test.mjs::host clock" && status === "failed",
		),
		JSON.stringify(stored),
	);
	peerCommit(repo, "NOTES.txt", "peer note\n");
	const applied = await apply(repo, result.runId);
	strictEqual(applied.ok, true, JSON.stringify(applied));
	strictEqual(applied.recheck, "passed");
	strictEqual(feature(repo), "export const feature = () => 42;\n");
});

test("a peer commit that adds a failing test still refuses the held apply", {
	skip: !sandboxed,
}, async () => {
	const { repo, result } = await heldDifferential();
	peerCommit(
		repo,
		"tests/legacy.test.mjs",
		`${LEGACY}test("peer regression", () => strictEqual(2, 3));\n`,
	);
	const refused = await apply(repo, result.runId);
	strictEqual(refused.reason, "held_recheck_failed", JSON.stringify(refused));
	strictEqual(refused.detail, "check_failed");
	strictEqual(refused.differentialReason, "new_failure");
	strictEqual(feature(repo), UNCHANGED);
});

test("edited baselines in the receipt are refused before any recheck", {
	skip: !sandboxed,
}, async () => {
	const { repo, result } = await heldDifferential();
	peerCommit(repo, "NOTES.txt", "peer note\n");
	const { receiptPath } = result.integration;
	const original = readFileSync(receiptPath, "utf8");
	// Marking the peer's failures as baseline ones without the record's digest.
	writeFileSync(receiptPath, original.replace('"passed"', '"failed"'));
	const unsigned = await apply(repo, result.runId);
	strictEqual(unsigned.reason, "held_receipt_invalid");
	strictEqual(unsigned.detail, "receipt_digest_mismatch");
	writeFileSync(receiptPath, original);
	await resign(result, (receipt) => {
		receipt.differentialBaselines[0].tests[0].push(true);
		return receipt;
	});
	const malformed = await apply(repo, result.runId);
	strictEqual(malformed.reason, "held_receipt_invalid");
	strictEqual(malformed.detail, "differential_baselines_invalid");
	strictEqual(feature(repo), UNCHANGED);
});

for (const version of [1, 2]) {
	test(`a schema-${version} receipt without baselines rechecks strictly`, {
		skip: !sandboxed,
	}, async () => {
		const { repo, result } = await heldDifferential();
		await resign(result, ({ differentialBaselines, ...receipt }) => ({
			...receipt,
			schemaVersion: version,
			...(version === 2 ? { differentialBaselines: [] } : {}),
		}));
		peerCommit(repo, "NOTES.txt", "peer note\n");
		const refused = await apply(repo, result.runId);
		strictEqual(refused.reason, "held_recheck_failed", JSON.stringify(refused));
		strictEqual(refused.detail, "check_failed");
		strictEqual(refused.differentialReason, undefined);
		strictEqual(feature(repo), UNCHANGED);
	});
}
