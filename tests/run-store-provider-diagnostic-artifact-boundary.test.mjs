import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	createEvent,
	getRunRoot,
	getStateRoot,
	initializeRun,
	persistDiagnosticArtifact,
	readEvents,
	readRun,
	resolveDiagnosticArtifact,
	SchemaError,
	updateRun,
	updateRunWithRetry,
} from "../src/switchyard/run-store/index.mjs";
import { TEST_ROOT, VM_ADMISSION_ROOT } from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
describe("provider diagnostic artifact boundary", () => {
	it("stores bounded digest/count metadata and resolves only opaque refs", async () => {
		const runId = `diagnostic-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		const ref = await persistDiagnosticArtifact(runId, {
			stdoutBytes: 12,
			stderrBytes: 4,
			stdoutDigest: `sha256:${"a".repeat(64)}`,
			stderrDigest: `sha256:${"b".repeat(64)}`,
			diagnosticKind: "auth_required",
		});
		strictEqual(ref, `diagnostic:${ref.slice("diagnostic:".length)}`);
		const resources = join(getRunRoot(runId), "resources");
		strictEqual((await stat(resources)).mode & 0o777, 0o700);
		const artifact = await resolveDiagnosticArtifact(runId, ref);
		strictEqual(artifact.kind, "provider_diagnostic");
		strictEqual(artifact.diagnosticKind, "auth_required");
		strictEqual(artifact.diagnosticCode, undefined);
		strictEqual(Object.keys(artifact).includes("secret"), false);
		for (const diagnosticKind of [
			"auth_required",
			"usage_exhausted",
			"model_unsupported",
			"permission_denied",
			"network_unreachable",
			"cli_usage_error",
		]) {
			const kindRef = await persistDiagnosticArtifact(runId, {
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: `sha256:${"a".repeat(64)}`,
				stderrDigest: `sha256:${"b".repeat(64)}`,
				diagnosticKind,
			});
			const kindArtifact = await resolveDiagnosticArtifact(runId, kindRef);
			strictEqual(kindArtifact.diagnosticKind, diagnosticKind);
			strictEqual(kindArtifact.diagnosticCode, undefined);
		}
		const current = await readRun(runId);
		await updateRun(
			runId,
			{
				state: "failed",
				lastFailure: {
					errorKind: "execution_failed",
					reasonCode: "execution_failed",
					reason: "Provider execution failed before a reviewed integration.",
					diagnosticRef: `diagnostic:${"f".repeat(32)}`,
					diagnosticEvidenceAvailable: true,
				},
			},
			current.revision,
		);
		const projectedFailure = (await readRun(runId)).lastFailure;
		strictEqual(projectedFailure.diagnosticRef, undefined);
		strictEqual(projectedFailure.diagnosticEvidenceAvailable, false);
		chmodSync(getRunRoot(runId), 0o755);
		strictEqual(await resolveDiagnosticArtifact(runId, ref), null);
		chmodSync(getRunRoot(runId), 0o700);
		chmodSync(resources, 0o755);
		strictEqual(await resolveDiagnosticArtifact(runId, ref), null);
		chmodSync(resources, 0o700);
		strictEqual(await resolveDiagnosticArtifact(runId, "diagnostic:bad"), null);
		strictEqual(
			await persistDiagnosticArtifact(runId, {
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: "bad",
				stderrDigest: `sha256:${"b".repeat(64)}`,
			}),
			null,
		);
		strictEqual(
			await persistDiagnosticArtifact(runId, {
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: `sha256:${"a".repeat(64)}`,
				stderrDigest: `sha256:${"b".repeat(64)}`,
				extra: "rejected",
			}),
			null,
		);
		strictEqual(
			await persistDiagnosticArtifact(runId, {
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: `sha256:${"a".repeat(64)}`,
				stderrDigest: `sha256:${"b".repeat(64)}`,
				diagnosticCode: "auth_required",
			}),
			null,
		);
		strictEqual(
			await persistDiagnosticArtifact(runId, {
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: `sha256:${"a".repeat(64)}`,
				stderrDigest: `sha256:${"b".repeat(64)}`,
				diagnosticKind: "auth_required",
				diagnosticCode: "cli_usage_error",
			}),
			null,
		);
		const token = "d".repeat(32);
		const destination = join(resources, `provider-diagnostic-${token}.json`);
		writeFileSync(
			destination,
			JSON.stringify({
				schemaVersion: 1,
				kind: "provider_diagnostic",
				diagnosticKind: "not_closed",
				stdoutBytes: 1,
				stderrBytes: 1,
				stdoutDigest: `sha256:${"a".repeat(64)}`,
				stderrDigest: `sha256:${"b".repeat(64)}`,
			}),
			{ mode: 0o600 },
		);
		strictEqual(
			await resolveDiagnosticArtifact(runId, `diagnostic:${token}`),
			null,
		);
		const directoryToken = "f".repeat(32);
		mkdirSync(join(resources, `provider-diagnostic-${directoryToken}.json`));
		strictEqual(
			await resolveDiagnosticArtifact(runId, `diagnostic:${directoryToken}`),
			null,
		);
		chmodSync(destination, 0o644);
		strictEqual(
			await resolveDiagnosticArtifact(runId, `diagnostic:${token}`),
			null,
		);
		const symlinkToken = "e".repeat(32);
		const symlinkPath = join(
			resources,
			`provider-diagnostic-${symlinkToken}.json`,
		);
		symlinkSync(destination, symlinkPath);
		strictEqual(
			await resolveDiagnosticArtifact(runId, `diagnostic:${symlinkToken}`),
			null,
		);
	});
});
describe("review-result projection", () => {
	it("persists only the sanitized review projection", async () => {
		const runId = `review-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await createEvent(runId, {
			phase: "execution",
			event: "task_completed",
			status: "Task 1.1 completed",
			taskId: "1.1",
			result: "review_completed",
			reviewResult: {
				verdict: "clean",
				findings: [],
				comments: ["safe"],
				transcript: "SECRET_CANARY",
			},
		});
		const run = await readRun(runId);
		strictEqual(run.lastReviewResult.sourceMutationCount, 0);
		strictEqual(JSON.stringify(run).includes("SECRET_CANARY"), false);
		const events = await readEvents(runId);
		strictEqual(events[0].reviewResult.sourceMutationCount, 0);
	});

	it("rejects an untrusted direct lastReviewResult update", async () => {
		const runId = `review-invalid-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		const current = await readRun(runId);
		await rejects(
			updateRun(
				runId,
				{
					lastReviewResult: {
						schemaVersion: 1,
						status: "available",
						verdict: "clean",
						findings: [],
						comments: [],
						findingCount: 0,
						commentCount: 0,
						sourceMutationCount: 0,
						transcript: "SECRET_CANARY",
					},
				},
				current.revision,
			),
			(error) => error instanceof SchemaError,
		);
		await rejects(
			updateRun(
				runId,
				{
					lastReviewResult: {
						schemaVersion: 1,
						status: "available",
						verdict: "findings",
						findings: [
							{
								severity: undefined,
								summary: "Missing canonical severity",
								path: "src/example.mjs",
							},
						],
						comments: [],
						findingCount: 1,
						commentCount: 0,
						sourceMutationCount: 0,
					},
				},
				current.revision,
			),
			(error) => error instanceof SchemaError,
		);
		strictEqual(
			JSON.stringify(await readRun(runId)).includes("SECRET_CANARY"),
			false,
		);
	});

	it("persists changes_requested with comments through createEvent and finalizes as succeeded", async () => {
		const runId = `review-changes-${randomUUID()}`;
		await initializeRun({
			runId,
			tasksFilePath: "/tmp/tasks.md",
			projectPath: "/tmp/project",
			orderedTaskIds: ["1.1"],
			initialHostFingerprint: "test-fingerprint",
			workerNonce: randomUUID(),
			launchArgs: [],
		});
		await createEvent(runId, {
			phase: "execution",
			event: "task_completed",
			status: "Task 1.1 completed",
			taskId: "1.1",
			result: "review_completed",
			reviewResult: {
				verdict: "changes_requested",
				comments: ["Handle the empty response"],
			},
		});
		const run = await readRun(runId);
		ok(run.lastReviewResult, "lastReviewResult must be persisted");
		strictEqual(run.lastReviewResult.status, "available");
		strictEqual(run.lastReviewResult.verdict, "clean");
		strictEqual(run.lastReviewResult.findingCount, 0);
		strictEqual(run.lastReviewResult.commentCount, 1);
		deepStrictEqual(run.lastReviewResult.comments, [
			"Handle the empty response",
		]);

		const events = await readEvents(runId);
		strictEqual(events.length, 1);
		ok(events[0].reviewResult);
		strictEqual(events[0].reviewResult.status, "available");
		strictEqual(events[0].reviewResult.verdict, "clean");
		deepStrictEqual(events[0].reviewResult.comments, [
			"Handle the empty response",
		]);

		const finalized = await updateRunWithRetry(runId, { state: "succeeded" });
		strictEqual(finalized.state, "succeeded");
		strictEqual(finalized.lastReviewResult.status, "available");
		strictEqual(finalized.lastReviewResult.verdict, "clean");

		const onDisk = await readRun(runId);
		strictEqual(onDisk.state, "succeeded");
		strictEqual(onDisk.lastReviewResult.status, "available");
		strictEqual(onDisk.lastReviewResult.verdict, "clean");
		deepStrictEqual(onDisk.lastReviewResult.comments, [
			"Handle the empty response",
		]);
	});
});
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
describe("getStateRoot", () => {
	it("returns an absolute path ending in .logs/switchyard by default", () => {
		const saved = process.env.SWITCHYARD_RUN_STORE_ROOT;
		delete process.env.SWITCHYARD_RUN_STORE_ROOT;
		try {
			const root = getStateRoot();
			strictEqual(resolve(root), root);
			ok(
				root.endsWith(`${sep}.logs${sep}switchyard`),
				`${root} should end with .logs/switchyard, got ${root}`,
			);
		} finally {
			if (saved) process.env.SWITCHYARD_RUN_STORE_ROOT = saved;
		}
	});

	it("returns the env override path when SWITCHYARD_RUN_STORE_ROOT is set", () => {
		const root = getStateRoot();
		strictEqual(resolve(root), root);
		ok(
			root.endsWith(`${sep}store`),
			`${root} should end with store (the env override)`,
		);
	});
});
