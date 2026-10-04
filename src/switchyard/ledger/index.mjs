import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	unlinkSync,
} from "node:fs";

import { appendFile, mkdir, readFile } from "node:fs/promises";

import { hostname } from "node:os";

import { join, resolve } from "node:path";

import { assertGenerationAllowed } from "../maintenance/index.mjs";

import { getStateRoot } from "../run-store/index.mjs";

import {
	retainedSegmentPaths,
	rotateLedgerIfNeeded,
	sanitizeDispatchEntry,
	sanitizeIntentEntry,
} from "./sanitize.mjs";

function resolveLedgerDir(runStorePath) {
	const root = runStorePath ?? getStateRoot();
	return resolve(root, "ledger");
}

function resolveLedgerPath(runStorePath) {
	return join(resolveLedgerDir(runStorePath), "dispatch-ledger.jsonl");
}

export async function recordDispatchToStore(data, runStorePath) {
	assertGenerationAllowed();
	const dir = resolveLedgerDir(runStorePath);
	await mkdir(dir, { recursive: true });

	const entry = {
		timestamp: new Date().toISOString(),
		host: hostname(),
		storeBacked: true,
		...sanitizeDispatchEntry(data),
	};

	const path = resolveLedgerPath(runStorePath);
	rotateLedgerIfNeeded(path);
	await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export async function recordExternalCompletionToStore(data, runStorePath) {
	assertGenerationAllowed();
	const dir = resolveLedgerDir(runStorePath);
	await mkdir(dir, { recursive: true });
	const fields = {
		reconciliationId: data?.reconciliationId,
		taskId: data?.taskId,
		...(data?.attempt === undefined ? {} : { attempt: data.attempt }),
		sourceRevision: data?.sourceRevision,
		integratedCommit: data?.integratedCommit,
		contractHash: data?.contractHash,
		providerSuccess: false,
		result: "external_completion_recorded",
	};
	if (
		Object.values(fields).some(
			(value) => (value === undefined || value === null) && value !== false,
		)
	)
		throw new Error("external completion ledger entry is incomplete");
	if (
		!/^[a-f0-9]{64}$/i.test(fields.reconciliationId) ||
		typeof fields.taskId !== "string" ||
		fields.taskId.length === 0 ||
		!Number.isSafeInteger(fields.sourceRevision) ||
		(fields.attempt !== undefined &&
			(!Number.isSafeInteger(fields.attempt) || fields.attempt < 1)) ||
		!/^[a-f0-9]{40,64}$/i.test(fields.integratedCommit) ||
		!/^[a-f0-9]{64}$/i.test(fields.contractHash)
	)
		throw new Error("external completion ledger entry is malformed");
	const path = resolveLedgerPath(runStorePath);
	const lockPath = `${path}.external-completion.lock`;
	let fd;
	let result;
	let cleanupError;
	try {
		fd = openSync(lockPath, "wx", 0o600);
		const entries = await readLedgerFromStore(runStorePath);
		const existing = entries.find(
			(entry) =>
				entry?.recordType === "external_completion" &&
				entry.reconciliationId === fields.reconciliationId,
		);
		if (existing) {
			const comparable = [
				"reconciliationId",
				"taskId",
				"attempt",
				"sourceRevision",
				"integratedCommit",
				"contractHash",
				"providerSuccess",
				"result",
			].every((key) => existing[key] === fields[key]);
			if (!comparable) {
				const error = new Error(
					"external completion ledger reconciliation ID mismatch",
				);
				error.code = "RECONCILIATION_LEDGER_MISMATCH";
				throw error;
			}
			result = { recorded: true, alreadyRecorded: true, entry: existing };
		} else {
			rotateLedgerIfNeeded(path);
			const entry = {
				timestamp: new Date().toISOString(),
				host: hostname(),
				storeBacked: true,
				recordType: "external_completion",
				...fields,
			};
			appendFileSync(path, `${JSON.stringify(entry)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			result = { recorded: true, alreadyRecorded: false, entry };
		}
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
			try {
				unlinkSync(lockPath);
			} catch (error) {
				if (error?.code !== "ENOENT") cleanupError = error;
			}
		}
	}
	if (cleanupError) throw cleanupError;
	return result;
}

export function recordDispatchIntentToStore(data, runStorePath) {
	assertGenerationAllowed();
	const dir = resolveLedgerDir(runStorePath);
	mkdirSync(dir, { recursive: true });
	const entry = {
		timestamp: new Date().toISOString(),
		storeBacked: true,
		...sanitizeIntentEntry(data),
	};
	const path = resolveLedgerPath(runStorePath);
	// Rotation is best-effort; the append below is NOT. This receipt is
	// synchronous by design and callers depend on it being durable before a
	// provider is invoked, so its failure must still propagate.
	rotateLedgerIfNeeded(path);
	appendFileSync(path, `${JSON.stringify(entry)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function readLedgerFromStore(runStorePath) {
	const path = resolveLedgerPath(runStorePath);
	const entries = [];
	// Oldest retained segment first, active file last, so a rotation boundary is
	// invisible to callers and chronological order is preserved across it.
	for (const candidate of [...retainedSegmentPaths(path), path]) {
		let content;
		try {
			content = await readFile(candidate, "utf8");
		} catch (e) {
			if (e.code === "ENOENT") continue;
			// A missing segment is normal; anything else on the ACTIVE file is
			// not, and must still surface.
			if (candidate === path) throw e;
			continue;
		}
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line));
			} catch (parseError) {
				console.error(
					`readLedgerFromStore: skipping malformed line: ${parseError.message}`,
				);
			}
		}
	}
	return entries;
}

export {
	getLedgerRotationFailures,
	readLedger,
	recordDispatch,
	resetLedgerRotationFailures,
} from "./sanitize.mjs";
