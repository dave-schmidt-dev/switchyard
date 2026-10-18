/**
 * Automatic `dispatch_qualified` receipt renewal after a succeeded simple run.
 *
 * A receipt expires after 30 days. A succeeded dispatch is better evidence than
 * a canary, so the finished run asks the single roster writer
 * (`~/.agent/bin/roster renew`) to restart the clock for the descriptor it just
 * ran. Whether a receipt renews is `rosterlib.renew`'s decision; this module
 * only triggers it and never turns a bookkeeping failure into a failed run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRosterPath } from "../roster/schema.mjs";
import { getRunRoot } from "../run-store/index.mjs";

const RENEWAL_TIMEOUT_MS = 30_000;
const RENEWAL_PROGRESS_MS = 5_000;

function runRoster(cli, args, { timeoutMs, progressMs, report }) {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		// Its own process group, so a timeout reaps the CLI and its children.
		const child = spawn(cli, args, {
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const progress = setInterval(
			() => report("dispatch: receipt renewal still running"),
			progressMs,
		);
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			child.stdout.destroy();
			child.stderr.destroy();
			finish(null);
		}, timeoutMs);
		const finish = (status) => {
			if (settled) return;
			settled = true;
			clearInterval(progress);
			clearTimeout(timer);
			resolvePromise({ status, stdout, stderr });
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
	});
}

/**
 * Renew the receipt a succeeded simple run re-earned.
 *
 * @param {string|null|undefined} runId - The succeeded run; no run, no call.
 * @param {(line: string) => void} report - Progress sink (stderr).
 * @param {object} [options]
 * @param {string} [options.rosterPath] - Roster the dispatch routed from, so a
 *   scaffold or fixture roster is the only file renewal can touch.
 * @param {(runId: string) => string} [options.runRoot] - Run directory lookup.
 * @param {number} [options.timeoutMs] - Hard bound on the roster CLI.
 * @param {number} [options.progressMs] - Interval for still-running reports.
 * @returns {Promise<void>}
 */
export async function renewDispatchReceipts(runId, report, options = {}) {
	if (!runId) return;
	const cli = resolve(homedir(), ".agent", "bin", "roster");
	if (!existsSync(cli)) return;
	const runRecord = join((options.runRoot ?? getRunRoot)(runId), "run.json");
	if (!existsSync(runRecord)) return;
	const renewal = await runRoster(
		cli,
		["renew", runRecord, "--file", options.rosterPath ?? resolveRosterPath()],
		{
			timeoutMs: options.timeoutMs ?? RENEWAL_TIMEOUT_MS,
			progressMs: options.progressMs ?? RENEWAL_PROGRESS_MS,
			report,
		},
	);
	if (renewal.status !== 0) {
		const detail = (renewal.stderr || renewal.stdout || "")
			.trim()
			.split("\n")
			.pop();
		report(
			`dispatch: receipt renewal skipped (${detail || "roster renew failed"})`,
		);
		return;
	}
	for (const line of renewal.stdout.trim().split("\n")) {
		if (line.startsWith("renewed")) report(`dispatch: ${line}`);
	}
}
