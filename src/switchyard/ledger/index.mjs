// Ledger module - dispatch logging
// INV-4: Every dispatch records provider + model + result

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { getStateRoot } from "../run-store/index.mjs";

const LOG_DIR = join(homedir(), ".logs", "switchyard");
const LEDGER_PATH = join(LOG_DIR, "dispatch-ledger.jsonl");

/**
 * Ensure log directory exists.
 */
function ensureLogDir() {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch (error) {
		if (error?.code !== "EEXIST") {
			throw error;
		}
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
		const entries = [];
		for (const line of content.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line));
			} catch (parseError) {
				console.error(
					`readLedger: skipping malformed line: ${parseError.message}`,
				);
			}
		}
		return entries;
	} catch {
		return [];
	}
}

function resolveLedgerDir(runStorePath) {
	const root = runStorePath ?? getStateRoot();
	return resolve(root, "ledger");
}

function resolveLedgerPath(runStorePath) {
	return join(resolveLedgerDir(runStorePath), "dispatch-ledger.jsonl");
}

/**
 * Record a dispatch entry to the project-local run-store ledger.
 *
 * @param {object} data
 * @param {string} data.provider
 * @param {string} data.model
 * @param {string} data.taskId
 * @param {string} data.result
 * @param {string} [data.reason]
 * @param {number} [data.percentLeft]
 * @param {string} [runStorePath] - defaults to getStateRoot()
 * @returns {Promise<void>}
 */
export async function recordDispatchToStore(data, runStorePath) {
	const dir = resolveLedgerDir(runStorePath);
	await mkdir(dir, { recursive: true });

	const entry = {
		timestamp: new Date().toISOString(),
		host: hostname(),
		storeBacked: true,
		...data,
	};

	const path = resolveLedgerPath(runStorePath);
	await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Read all entries from the project-local run-store ledger.
 *
 * @param {string} [runStorePath] - defaults to getStateRoot()
 * @returns {Promise<Array>} Array of dispatch entries
 */
export async function readLedgerFromStore(runStorePath) {
	const path = resolveLedgerPath(runStorePath);
	try {
		const content = await readFile(path, "utf8");
		const entries = [];
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
		return entries;
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}
