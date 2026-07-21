// Ledger module - dispatch logging
// INV-4: Every dispatch records provider + model + result

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".logs", "switchyard");
const LEDGER_PATH = join(LOG_DIR, "dispatch-ledger.jsonl");

/**
 * Ensure log directory exists.
 */
function ensureLogDir() {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch {
		// Directory may already exist
	}
}

/**
 * Record a dispatch to the ledger.
 * INV-4: records provider + model + result for each dispatch
 *
 * @param {object} dispatch
 * @param {string} dispatch.provider Provider name
 * @param {string} dispatch.model Model name
 * @param {string} dispatch.taskId Task identifier
 * @param {string} dispatch.result Dispatch result status
 * @param {string} [dispatch.reason] Routing reason
 * @param {number} [dispatch.percentLeft] Provider percent left at dispatch time
 */
export function recordDispatch(dispatch) {
	ensureLogDir();

	const entry = {
		timestamp: new Date().toISOString(),
		host: hostname(),
		...dispatch,
	};

	appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read all ledger entries.
 * @returns {Array} Array of dispatch entries
 */
export function readLedger() {
	try {
		const content = readFileSync(LEDGER_PATH, "utf8");
		return content
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}
