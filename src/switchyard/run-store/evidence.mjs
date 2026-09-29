import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isOutcomeEvent, OUTCOME_EVENT_MAX_BYTES } from "../outcome/schema.mjs";
import { APPROVED_EVENT_KEYS } from "./constants.mjs";
import { SchemaError, validateRunId } from "./errors.mjs";
import {
	isSafeDescriptorReceipt,
	validateRouteHealthBinding,
} from "./receipt-validation.mjs";
import { readRun } from "./run-records.mjs";
import { inspectEventLog } from "./run-updates.mjs";
import { validateRun } from "./validate-run.mjs";
export async function readEvents(runId) {
	validateRunId(runId);
	const log = await inspectEventLog(runId);
	const run = await readRun(runId);
	if (log.ceiling !== run.lastEventSequence)
		throw new SchemaError("event sequence ceiling is unresolved");
	return log.events;
}
export async function readAuthorizedRunEvidence(runRoot) {
	if (typeof runRoot !== "string" || !isAbsolute(runRoot)) {
		throw new SchemaError("authorised run root must be absolute");
	}
	const root = resolve(runRoot);
	let rootStat;
	try {
		rootStat = await lstat(root);
	} catch (error) {
		throw new SchemaError(
			error?.code === "ENOENT"
				? "authorised run root missing"
				: "authorised run root unreadable",
		);
	}
	if (
		!rootStat.isDirectory() ||
		rootStat.isSymbolicLink() ||
		rootStat.uid !== process.getuid() ||
		(rootStat.mode & 0o077) !== 0
	) {
		throw new SchemaError("authorised run root is not owner-only");
	}
	const eventsPath = resolve(root, "events.jsonl");
	const runPath = resolve(root, "run.json");
	let runStat;
	try {
		runStat = await lstat(runPath);
	} catch {
		throw new SchemaError("authorised run projection missing");
	}
	if (
		!runStat.isFile() ||
		runStat.isSymbolicLink() ||
		runStat.uid !== process.getuid() ||
		(runStat.mode & 0o077) !== 0 ||
		runStat.size > 1024 * 1024
	) {
		throw new SchemaError("authorised run projection is not owner-only");
	}
	let run;
	try {
		run = JSON.parse(await readFile(runPath, "utf8"));
		validateRun(run);
	} catch {
		throw new SchemaError("authorised run projection is invalid");
	}
	let eventStat;
	try {
		eventStat = await lstat(eventsPath);
	} catch (error) {
		if (error?.code === "ENOENT") return { run, events: [] };
		throw new SchemaError("authorised events are unreadable");
	}
	if (
		!eventStat.isFile() ||
		eventStat.isSymbolicLink() ||
		eventStat.uid !== process.getuid() ||
		(eventStat.mode & 0o077) !== 0 ||
		eventStat.size > 4 * 1024 * 1024
	) {
		throw new SchemaError("authorised events are not owner-only");
	}
	const raw = await readFile(eventsPath, "utf8");
	const lines = raw.split("\n").filter(Boolean);
	if (lines.length > 10_000)
		throw new SchemaError("authorised events exceed limit");
	let sequence = 0;
	const events = lines.map((line) => {
		if (Buffer.byteLength(line, "utf8") + 1 > OUTCOME_EVENT_MAX_BYTES)
			throw new SchemaError("authorised event exceeds limit");
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			throw new SchemaError("authorised event contains invalid JSON");
		}
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			Object.keys(event).some((key) => !APPROVED_EVENT_KEYS.has(key)) ||
			!Number.isSafeInteger(event.sequence) ||
			event.sequence !== sequence + 1
		) {
			throw new SchemaError("authorised event schema is invalid");
		}
		sequence = event.sequence;
		if (
			(event.stage !== undefined || event.outcomeId !== undefined) &&
			!isOutcomeEvent(event)
		)
			throw new SchemaError("authorised typed outcome is invalid");
		if (event.routeHealthBinding !== undefined)
			validateRouteHealthBinding(event.routeHealthBinding);
		if (
			event.routeHealthBinding !== undefined &&
			(event.routeHealthBinding.runId !== run.runId ||
				event.routeHealthBinding.runRevision > run.revision ||
				event.phase !== "execution" ||
				![
					"task_completed",
					"task_failed",
					"provider_attempt_terminal",
				].includes(event.event) ||
				!run.orderedTaskIds.includes(event.taskId) ||
				!event.invocationDescriptor ||
				!isSafeDescriptorReceipt(
					event.invocationDescriptor,
					event.descriptorHarness,
				) ||
				event.invocationDescriptor.descriptor_identity !==
					event.descriptorIdentity ||
				event.invocationDescriptor.target_id !== event.resolvedTargetId)
		)
			throw new SchemaError("authorised route health event is invalid");
		return event;
	});
	if (sequence !== run.lastEventSequence)
		throw new SchemaError(
			"authorised event sequence does not match run projection",
		);
	return { run, events };
}
export async function readAuthorizedRunEvents(runRoot) {
	return (await readAuthorizedRunEvidence(runRoot)).events;
}
