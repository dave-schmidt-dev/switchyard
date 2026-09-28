import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { INTEGRATION_REFUSAL_KINDS } from "../src/switchyard/adapter/exec-error.mjs";
import { validateInvocationDescriptor } from "../src/switchyard/roster/index.mjs";
import {
	createEvent,
	createRouteHealthEvent,
	getRunRoot,
	initializeRun,
	readAuthorizedRunEvents,
	readEvents,
	readRun,
	updateRun,
} from "../src/switchyard/run-store/index.mjs";
import {
	makeOptions,
	TEST_ROOT,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
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
describe("event ordering", () => {
	it("keeps a route-health deferral observational instead of recording a failure", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "route_health_deferred",
			status: "Task task-1 deferred: route health trial unavailable",
			taskId: "task-1",
			provider: "codex",
			result: "route_health_deferred",
		});
		const run = await readRun(opts.runId);
		const [event] = await readEvents(opts.runId);
		strictEqual(run.lastFailure, null);
		strictEqual(event.event, "route_health_deferred");
		strictEqual(event.result, "route_health_deferred");
	});

	it("persists a closed host route-health binding and reads it from an authorised run root", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		const binding = {
			adapterContractId: "switchyard-route-health-v1",
			publicConfigurationEpoch: `sha256:${"a".repeat(64)}`,
			repairEpoch: 0,
			transportVerified: true,
			lifecycleVerified: true,
		};
		const descriptor = validateInvocationDescriptor(
			{
				target_id: "codex",
				model_ref: "fixture/codex-standard",
				selector: "fixture-codex-standard",
				effort: null,
				variant: null,
				invocation_args: [],
			},
			"codex",
		);
		await createRouteHealthEvent(
			opts.runId,
			{
				phase: "execution",
				event: "task_completed",
				status: "succeeded",
				taskId: "task-1",
				attempt: 1,
				resolvedTargetId: "codex",
				invocationDescriptor: descriptor,
				descriptorIdentity: descriptor.descriptor_identity,
				descriptorHarness: "codex",
				servedModelVerified: true,
			},
			binding,
		);
		const events = await readAuthorizedRunEvents(getRunRoot(opts.runId));
		deepStrictEqual(events[0].routeHealthBinding, {
			...binding,
			version: 1,
			producer: "run-store",
			runId: opts.runId,
			runRevision: 1,
		});
		await rejects(
			createEvent(opts.runId, {
				phase: "execution",
				event: "task_completed",
				status: "succeeded",
				routeHealthBinding: binding,
			}),
			/host producer/,
		);
		const eventsPath = resolve(getRunRoot(opts.runId), "events.jsonl");
		const forged = JSON.parse(readFileSync(eventsPath, "utf8"));
		forged.invocationDescriptor.selector = "forged-selector";
		writeFileSync(eventsPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
		await rejects(
			readAuthorizedRunEvents(getRunRoot(opts.runId)),
			/authorised route health event is invalid/,
		);
	});
	it("assigns monotonically increasing sequence numbers", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		const s1 = await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "task_started",
			status: "ok",
		});
		const s2 = await createEvent(opts.runId, {
			phase: "execution",
			event: "task_completed",
			status: "ok",
		});
		const s3 = await createEvent(opts.runId, {
			phase: "cleanup",
			event: "cleanup_started",
			status: "ok",
		});

		strictEqual(s1, 1);
		strictEqual(s2, 2);
		strictEqual(s3, 3);
	});

	it("includes extra context fields in the event entry", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_started",
			status: "ok",
			taskId: "task-1",
			provider: "claude",
			model: "sonnet",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(eventsPath, "utf8");
		const parsed = JSON.parse(content.trim().split("\n")[0]);

		strictEqual(parsed.schemaVersion, 1);
		strictEqual(parsed.sequence, 1);
		strictEqual(parsed.taskId, "task-1");
		strictEqual(parsed.provider, "claude");
		strictEqual(parsed.model, "sonnet");
	});

	it("persists only the closed progress envelope", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "execution_progress",
			status: "working",
			progress: {
				stage: "working",
				elapsedMs: 8,
				lastSubstantiveProgressAt: "2026-09-07T00:00:00.000Z",
				lastSubstantiveProgressAgeMs: 2,
				counters: { stdoutBytes: 4, polls: 2, progressEvents: 1 },
				outcome: "running",
				output: "SECRET_CANARY",
			},
		});
		const [event] = await readEvents(opts.runId);
		strictEqual(event.progress.schemaVersion, 1);
		strictEqual(event.progress.counters.stderrBytes, 0);
		strictEqual(JSON.stringify(event).includes("SECRET_CANARY"), false);
	});

	it("persists only valid VM-slot wait elapsed time", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "vm_slot_wait",
			status: "Waiting for VM admission capacity",
			elapsedMs: 12.5,
			unrelated: "SECRET_CANARY_unrelated_status_field",
		});
		for (const elapsedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await createEvent(opts.runId, {
				phase: "bootstrap",
				event: "vm_slot_wait",
				status: "Waiting for VM admission capacity",
				elapsedMs,
			});
		}
		await createEvent(opts.runId, {
			phase: "bootstrap",
			event: "another_status",
			status: "Other status",
			elapsedMs: 1,
		});

		const events = await readEvents(opts.runId);
		strictEqual(events[0].elapsedMs, 12.5);
		ok(!("unrelated" in events[0]));
		for (const event of events.slice(1)) {
			ok(!("elapsedMs" in event));
		}
		ok(!JSON.stringify(events).includes("SECRET_CANARY"));
	});

	it("sanitizes failure events before they are persisted", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task task-1 failed",
			taskId: "task-1",
			result: "execution_failed",
			errorKind: "provider_private_reason",
			error: "SECRET_CANARY_provider_error",
			output: "SECRET_CANARY_provider_output",
			reason: "SECRET_CANARY_provider_reason",
			partialDiffPath: "/Users/dave/project/.partial-diffs/task-1.diff",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const [event] = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		strictEqual(event.errorKind, "execution_failed");
		strictEqual(event.reasonCode, "execution_failed");
		strictEqual(
			event.reason,
			"Provider execution failed before a reviewed integration.",
		);
		for (const key of ["error", "output", "partialDiffPath"]) {
			ok(!(key in event), `raw event field ${key} must not persist`);
		}
		ok(!JSON.stringify(event).includes("SECRET_CANARY"));
	});

	it("persists integration failures with static diagnostics only", async () => {
		const opts = makeOptions();
		await initializeRun(opts);

		await createEvent(opts.runId, {
			phase: "integration",
			event: "task_failed",
			status: "Task task-1 failed",
			taskId: "task-1",
			result: "integration_failed",
			errorKind: "integration_failed",
			reason: "SECRET_CANARY_gate_message",
			error: "SECRET_CANARY_gate_error",
			output: "SECRET_CANARY_gate_output",
			partialDiff: "SECRET_CANARY_gate_diff",
			partialDiffPath: "/Users/dave/project/.partial-diffs/task-1.diff",
			artifactRef: "artifact:aaaaaaaaaaaaaaaaaaaaaaaa",
		});

		const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
		const [event] = (await readFile(eventsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		strictEqual(event.errorKind, "integration_failed");
		strictEqual(event.reasonCode, "integration_failed");
		strictEqual(
			event.reason,
			"The reviewed integration gate rejected the task result.",
		);
		ok(/^artifact:[a-f0-9]{24}$/.test(event.artifactRef));
		for (const key of ["error", "output", "partialDiff", "partialDiffPath"]) {
			ok(!(key in event), `raw event field ${key} must not persist`);
		}
		ok(!JSON.stringify(event).includes("SECRET_CANARY"));
	});

	it("carries an integration refusal kind through to events.jsonl and run.json", async () => {
		// Before this, every refusal arrived as the same static
		// `integration_failed`, so run eab7d23c's real cause (a manifest touched
		// without `AllowManifests: true`) was only recoverable by reading the
		// gate's source. The kind is a closed-enum member, so naming the cause
		// costs nothing on the INV-2 boundary.
		for (const kind of INTEGRATION_REFUSAL_KINDS) {
			const opts = makeOptions();
			await initializeRun(opts);

			await createEvent(opts.runId, {
				phase: "integration",
				event: "task_failed",
				status: "Task task-1 failed",
				taskId: "task-1",
				result: "integration_failed",
				errorKind: "integration_failed",
				diagnosticCode: kind,
				reason: "SECRET_CANARY_gate_message",
			});
			const current = await readRun(opts.runId);
			await updateRun(
				opts.runId,
				{
					lastFailure: {
						errorKind: "integration_failed",
						reasonCode: "integration_failed",
						reason: "The reviewed integration gate rejected the task result.",
						diagnosticCode: kind,
					},
				},
				current.revision,
			);

			const eventsPath = join(getRunRoot(opts.runId), "events.jsonl");
			const [event] = (await readFile(eventsPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			strictEqual(event.diagnosticCode, kind, `${kind} lost in events.jsonl`);
			ok(!JSON.stringify(event).includes("SECRET_CANARY"));

			const run = await readRun(opts.runId);
			strictEqual(
				run.lastFailure.diagnosticCode,
				kind,
				`${kind} lost in run.json`,
			);
			ok(!JSON.stringify(run.lastFailure).includes("/"));
		}
	});

	it("round-trips bounded diagnostic provenance without raw text", async () => {
		const opts = makeOptions();
		await initializeRun(opts);
		await createEvent(opts.runId, {
			phase: "execution",
			event: "task_failed",
			status: "Task task-1 failed",
			taskId: "task-1",
			result: "execution_failed",
			errorKind: "execution_failed",
			diagnosticCode: "provider_exit_nonzero",
			diagnosticOrigin: "adapter",
			diagnosticEvidenceAvailable: true,
			exitCode: 255,
			failurePhase: "provider_execution",
			reason: "SECRET_CANARY usage: does not persist",
		});
		const [event] = await readEvents(opts.runId);
		strictEqual(event.diagnosticOrigin, "adapter");
		strictEqual(event.diagnosticEvidenceAvailable, false);
		strictEqual(event.exitCode, 255);
		ok(!JSON.stringify(event).includes("SECRET_CANARY"));
		const stored = await readRun(opts.runId);
		strictEqual(stored.lastFailure.diagnosticOrigin, "adapter");
		strictEqual(stored.lastFailure.diagnosticEvidenceAvailable, false);
	});

	it("does not trust queue-preflight or worker-boot availability without retained evidence", async () => {
		for (const failurePhase of ["queue_preflight", "worker_boot"]) {
			const opts = makeOptions();
			await initializeRun(opts);
			await createEvent(opts.runId, {
				phase: "worker",
				event: "worker_boot_failed",
				status: "fatal",
				result: "launch_failed",
				errorKind: "launch_failed",
				diagnosticCode: "worker_boot_exception",
				diagnosticOrigin: "worker_boot",
				diagnosticEvidenceAvailable: true,
				failurePhase,
			});
			const [event] = await readEvents(opts.runId);
			strictEqual(event.diagnosticEvidenceAvailable, false, failurePhase);
		}
	});
});
