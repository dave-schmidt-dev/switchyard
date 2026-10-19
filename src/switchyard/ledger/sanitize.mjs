import { renameSync, rmSync, statSync } from "node:fs";

const DEFAULT_LEDGER_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_LEDGER_SEGMENTS = 5;

let ledgerRotationWarned = false;

function ledgerMaxBytes() {
	const raw = Number(process.env.SWITCHYARD_LEDGER_MAX_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEDGER_MAX_BYTES;
}

function ledgerSegments() {
	const raw = Number(process.env.SWITCHYARD_LEDGER_SEGMENTS);
	return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LEDGER_SEGMENTS;
}

function segmentPath(path, index) {
	return `${path}.${index}`;
}

export function retainedSegmentPaths(path) {
	const paths = [];
	for (let index = ledgerSegments(); index >= 1; index -= 1) {
		paths.push(segmentPath(path, index));
	}
	return paths;
}

function noteRotationFailure(error) {
	if (ledgerRotationWarned) return;
	ledgerRotationWarned = true;
	console.warn(
		`switchyard: dispatch ledger rotation failed (${error?.code ?? "unknown"}); the ledger will keep growing but this run is unaffected`,
	);
}

export function rotateLedgerIfNeeded(path) {
	try {
		if (statSync(path).size < ledgerMaxBytes()) return;
	} catch (error) {
		// Nothing written yet is the normal first-call case, not a failure.
		if (error?.code !== "ENOENT") noteRotationFailure(error);
		return;
	}
	try {
		const keep = ledgerSegments();
		// Drop the oldest segment, then shift every survivor down one slot.
		rmSync(segmentPath(path, keep), { force: true });
		for (let index = keep - 1; index >= 1; index -= 1) {
			try {
				renameSync(segmentPath(path, index), segmentPath(path, index + 1));
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		// Rename rather than copy-and-truncate: an in-flight reader keeps a
		// consistent view and no entry can be observed twice or lost.
		renameSync(path, segmentPath(path, 1));
	} catch (error) {
		noteRotationFailure(error);
	}
}
