/** Stable, non-reversible identity for one CLI task across renamed routing runs. */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";

const MAX_PROMPT_BYTES = 256 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const fail = (code) => {
	throw Object.assign(new Error(code), { code });
};

export function validateTaskIdentityId(value) {
	if (typeof value !== "string" || !TASK_ID.test(value))
		fail("invalid_task_id");
}

function promptDigest(path) {
	let fd;
	try {
		const before = lstatSync(path);
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.size === 0 ||
			before.size > MAX_PROMPT_BYTES
		)
			fail("routing_task_identity_source_unavailable");
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const actual = fstatSync(fd);
		if (
			!actual.isFile() ||
			before.dev !== actual.dev ||
			before.ino !== actual.ino ||
			before.size !== actual.size
		)
			fail("routing_task_identity_source_unavailable");
		const bytes = readFileSync(fd);
		if (bytes.length !== actual.size)
			fail("routing_task_identity_source_unavailable");
		return createHash("sha256").update(bytes).digest("hex");
	} catch (error) {
		if (error?.code?.startsWith("routing_")) throw error;
		fail("routing_task_identity_source_unavailable");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function stableScope(options) {
	const sorted = (values) => [...values].sort();
	return {
		capability: options.capability ?? null,
		files: sorted(options.files ?? []),
		allowManifests: sorted(options.allowManifests ?? []),
		readOnlyInputs: sorted(options.readOnlyInputs ?? []),
		dirtyOverlay: options.dirtyOverlay === true,
		reportMode: options.reportMode ?? null,
		checks: options.checks ?? [],
		baselineChecks: options.baselineChecks ?? [],
		format: options.format ?? null,
		repairChecks: options.repairChecks !== false,
	};
}

export function routingTaskIdentityHash(options, project, origin) {
	if (!options.promptPath && options.taskId === undefined) return null;
	let identity;
	if (options.taskId !== undefined && options.taskId !== null) {
		validateTaskIdentityId(options.taskId);
		identity = { kind: "explicit", id: options.taskId };
	} else {
		identity = {
			kind: "prompt-scope",
			promptHash: promptDigest(options.promptPath),
			scope: stableScope(options),
		};
	}
	return createHash("sha256")
		.update(JSON.stringify({ version: 1, project, origin, identity }))
		.digest("hex");
}
