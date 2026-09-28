import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir as trackedTempDir } from "./helpers/tempdir.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionCutoverCli = join(projectRoot, "ops", "switchyard-cutover.mjs");
const workerBootstrap = join(
	projectRoot,
	"src",
	"switchyard",
	"dispatch",
	"worker-bootstrap.mjs",
);
const tempDirs = [];
function tempDir() {
	const path = trackedTempDir("switchyard-generation-test-");
	tempDirs.push(path);
	return path;
}
function cutoverFixture() {
	const root = tempDir();
	const roots = {
		project: join(root, "project"),
		plans: join(root, "plans"),
		agent: join(root, "agent"),
	};
	for (const path of Object.values(roots)) mkdirSync(path, { recursive: true });
	const cli = join(root, "switchyard-cutover.mjs");
	const source = readFileSync(productionCutoverCli, "utf8")
		.replace(
			'"/Users/dave/Documents/Projects/switchyard"',
			JSON.stringify(roots.project),
		)
		.replace(
			'"/Users/dave/Documents/Projects/.plans"',
			JSON.stringify(roots.plans),
		)
		.replace('"/Users/dave/.agent"', JSON.stringify(roots.agent));
	writeFileSync(cli, source);
	return { cli: realpathSync(cli), roots };
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.SWITCHYARD_GENERATION_MARKER;
});
describe("cutover transaction hashes and rollback", () => {
	it("verifies source drift, supports rollback dry-run, and refuses hash conflicts", () => {
		const dir = tempDir();
		const { cli: cutoverCli, roots } = cutoverFixture();
		const target = join(
			roots.project,
			"tests",
			`.cutover-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		mkdirSync(manifestDir, { recursive: true });
		mkdirSync(dirname(target), { recursive: true });
		try {
			writeFileSync(target, "before\n");
			mkdirSync(dirname(copy), { recursive: true });
			writeFileSync(copy, readFileSync(target));
			const pre = sha256("before\n");
			writeFileSync(target, "after\n");
			const post = sha256("after\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover",
					files: [
						{
							root: "project",
							path: relative(roots.project, target),
							preCutoverSha256: pre,
							postCutoverSha256: post,
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);

			const verifyPre = spawnSync(
				process.execPath,
				[cutoverCli, "verify", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.equal(verifyPre.status, 1);
			assert.match(verifyPre.stdout, /source_drift_count=1/);
			const dryRun = execFileSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.match(dryRun, /CUTOVER_ROLLBACK=dry-run\|actions=1/);
			assert.equal(readFileSync(target, "utf8"), "after\n");
			execFileSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
				{ encoding: "utf8" },
			);
			assert.equal(readFileSync(target, "utf8"), "before\n");

			writeFileSync(target, "after\n");
			writeFileSync(copy, "corrupt-backup\n");
			const badBackup = spawnSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
				{ encoding: "utf8" },
			);
			assert.equal(badBackup.status, 1);
			assert.match(badBackup.stdout, /backup-hash-mismatch/);
			assert.equal(
				readFileSync(target, "utf8"),
				"after\n",
				"a mismatched backup must be refused before target mutation",
			);
			writeFileSync(copy, "before\n");

			writeFileSync(target, "after\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover",
					files: [
						{
							root: "project",
							path: relative(roots.project, target),
							preCutoverSha256: pre,
							postCutoverSha256: post,
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);
			writeFileSync(target, "unrelated\n");
			assert.throws(
				() =>
					execFileSync(
						process.execPath,
						[cutoverCli, "rollback", "--manifest", manifest, "--apply"],
						{ encoding: "utf8" },
					),
				(error) => error.status === 1,
			);
			assert.equal(readFileSync(target, "utf8"), "unrelated\n");
		} finally {
			rmSync(target, { force: true });
		}
	});

	it("rejects target drift injected after rollback preflight", async () => {
		const dir = tempDir();
		const { cli: cutoverCli, roots } = cutoverFixture();
		const { rollback } = await import(
			`${pathToFileURL(cutoverCli).href}?test=${Date.now()}`
		);
		const target = join(
			roots.project,
			"tests",
			`.cutover-drift-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		mkdirSync(dirname(target), { recursive: true });
		try {
			writeFileSync(target, "before\n");
			writeFileSync(copy, "before\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover-drift",
					files: [
						{
							root: "project",
							path: relative(roots.project, target),
							preCutoverSha256: sha256("before\n"),
							postCutoverSha256: sha256("after\n"),
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);
			writeFileSync(target, "after\n");
			const result = rollback(manifest, true, {
				beforeMutation: () => writeFileSync(target, "drifted\n"),
			});
			assert.equal(result, 1);
			assert.equal(readFileSync(target, "utf8"), "drifted\n");
		} finally {
			rmSync(target, { force: true });
		}
	});

	it("refuses a corrupt backup during rollback dry-run preflight", () => {
		const dir = tempDir();
		const { cli: cutoverCli, roots } = cutoverFixture();
		const target = join(
			roots.project,
			"tests",
			`.cutover-dry-run-fixture-${process.pid}.txt`,
		);
		const manifestDir = join(dir, "transaction");
		const copy = join(manifestDir, "copies", "fixture.txt");
		const manifest = join(manifestDir, "manifest.json");
		mkdirSync(dirname(copy), { recursive: true });
		mkdirSync(dirname(target), { recursive: true });
		try {
			writeFileSync(target, "after\n");
			writeFileSync(copy, "corrupt-backup\n");
			writeFileSync(
				manifest,
				JSON.stringify({
					schemaVersion: 1,
					runId: "test-cutover-dry-run",
					files: [
						{
							root: "project",
							path: relative(roots.project, target),
							preCutoverSha256: sha256("before\n"),
							postCutoverSha256: sha256("after\n"),
							copyPath: relative(manifestDir, copy),
						},
					],
				}),
			);

			const result = spawnSync(
				process.execPath,
				[cutoverCli, "rollback", "--manifest", manifest],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 1);
			assert.match(result.stdout, /backup-hash-mismatch/);
			assert.doesNotMatch(result.stdout, /CUTOVER_ROLLBACK=dry-run\|actions=/);
			assert.equal(readFileSync(target, "utf8"), "after\n");
		} finally {
			rmSync(target, { force: true });
		}
	});
});
