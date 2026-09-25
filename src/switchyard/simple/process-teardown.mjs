import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

const PROBE_TIMEOUT_MS = 1_500;
const MAX_SCOPE_PROCESSES = 64;

function processGroupPresent(pgid) {
	if (!Number.isSafeInteger(pgid) || pgid <= 0) return null;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		return null;
	}
}

async function waitForProcessGroupExit(pgid, timeoutMs, onProgress) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const present = processGroupPresent(pgid);
		if (present === false) return true;
		onProgress?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return processGroupPresent(pgid) === false;
}

async function settleProcessGroup(pgid, onProgress) {
	const present = processGroupPresent(pgid);
	if (present === false) return "stopped";
	if (present === null) {
		return (await waitForProcessGroupExit(pgid, 5_000, onProgress))
			? "stopped"
			: "unavailable";
	}
	try {
		process.kill(-pgid, "SIGTERM");
	} catch (error) {
		if (error?.code === "ESRCH") return "stopped";
		return (await waitForProcessGroupExit(pgid, 5_000, onProgress))
			? "stopped"
			: "unavailable";
	}
	if (await waitForProcessGroupExit(pgid, 1_000, onProgress)) return "stopped";
	try {
		process.kill(-pgid, "SIGKILL");
	} catch (error) {
		if (error?.code === "ESRCH") return "stopped";
		return (await waitForProcessGroupExit(pgid, 4_000, onProgress))
			? "stopped"
			: "unavailable";
	}
	return (await waitForProcessGroupExit(pgid, 4_000, onProgress))
		? "stopped"
		: "unavailable";
}

function listWorktreeHolders(worktreePath, pid = null) {
	let scopePath;
	try {
		scopePath = realpathSync(worktreePath);
	} catch {
		return null;
	}
	const args = ["-nP", "-F", "pfn"];
	if (pid !== null) args.push("-a", "-p", String(pid));
	args.push("-d", "cwd");
	let result;
	try {
		result = spawnSync("lsof", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: PROBE_TIMEOUT_MS,
			killSignal: "SIGKILL",
			maxBuffer: 4 * 1024 * 1024,
			env: {
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				LANG: "C",
				LC_ALL: "C",
			},
		});
	} catch {
		return null;
	}
	if (
		result.error ||
		result.signal ||
		typeof result.stdout !== "string" ||
		/incomplete|warning/iu.test(result.stderr ?? "")
	)
		return null;
	if (result.status === 1 && result.stdout.trim() === "") return [];
	if (result.status !== 0) return null;
	const holders = new Set();
	let currentPid = null;
	for (const line of result.stdout.split(/\r?\n/u)) {
		if (line.startsWith("p")) {
			const value = line.slice(1);
			if (!/^[1-9]\d{0,8}$/u.test(value)) return null;
			currentPid = Number(value);
		} else if (line.startsWith("n") && currentPid !== null) {
			const cwd = line.slice(1);
			if (cwd === scopePath || cwd.startsWith(`${scopePath}${sep}`))
				holders.add(currentPid);
		}
	}
	if (holders.size > MAX_SCOPE_PROCESSES) return null;
	return [...holders];
}

function processIdentity(pid) {
	let result;
	try {
		result = spawnSync(
			"ps",
			["-o", "lstart=", "-o", "stat=", "-p", String(pid)],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: PROBE_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 4096,
				env: {
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					LANG: "C",
					LC_ALL: "C",
				},
			},
		);
	} catch {
		return null;
	}
	if (result.error || result.signal || typeof result.stdout !== "string")
		return null;
	if (result.status === 1 && result.stdout.trim() === "") return false;
	if (result.status !== 0) return null;
	const fields = result.stdout.trim().split(/\s+/u);
	if (fields.length < 6) return null;
	const startText = fields.slice(0, 5).join(" ");
	const startedAt = Date.parse(startText);
	if (!Number.isFinite(startedAt)) return null;
	return { startedAt, stamp: startText, state: fields[5] };
}

function isScopeMember(pid, worktreePath) {
	const holders = listWorktreeHolders(worktreePath, pid);
	if (holders === null) return null;
	return holders.includes(pid);
}

function sameProcess(pid, stamp, launchedAt) {
	const current = processIdentity(pid);
	if (current === false) return false;
	if (current === null) return null;
	return (
		current.stamp === stamp &&
		current.startedAt >= launchedAt - 1_000 &&
		current.startedAt <= Date.now() + 1_000
	);
}

async function waitForScopedProcessesExit(
	processes,
	worktreePath,
	launchedAt,
	timeoutMs,
	onProgress,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let remaining = false;
		for (const { pid, stamp } of processes) {
			const same = sameProcess(pid, stamp, launchedAt);
			if (same === null) return null;
			if (!same) continue;
			const member = isScopeMember(pid, worktreePath);
			if (member === null) return null;
			if (!member) continue;
			const current = processIdentity(pid);
			if (current === null) return null;
			if (current && current.stamp === stamp && !/^Z/u.test(current.state))
				remaining = true;
		}
		if (!remaining) return true;
		onProgress?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

async function settleScopedProcesses(worktreePath, launchedAt, onProgress) {
	if (
		typeof worktreePath !== "string" ||
		!Number.isFinite(launchedAt) ||
		!isAbsolute(worktreePath)
	)
		return "unavailable";
	onProgress?.();
	const pids = listWorktreeHolders(worktreePath);
	if (pids === null) return "unavailable";
	const candidates = [];
	for (const pid of pids) {
		if (pid <= 1 || pid === process.pid) continue;
		const identity = processIdentity(pid);
		if (identity === null) return "unavailable";
		if (identity === false || /^Z/u.test(identity.state)) continue;
		if (
			identity.startedAt < launchedAt - 1_000 ||
			identity.startedAt > Date.now() + 1_000
		)
			continue;
		const member = isScopeMember(pid, worktreePath);
		if (member === null) return "unavailable";
		if (member) candidates.push({ pid, stamp: identity.stamp });
	}
	if (candidates.length === 0) return "stopped";
	for (const candidate of candidates) {
		const same = sameProcess(candidate.pid, candidate.stamp, launchedAt);
		if (same === null) return "unavailable";
		if (!same) continue;
		const member = isScopeMember(candidate.pid, worktreePath);
		if (member === null) return "unavailable";
		if (!member) continue;
		try {
			process.kill(candidate.pid, "SIGTERM");
		} catch (error) {
			if (error?.code !== "ESRCH") return "unavailable";
		}
	}
	const termResult = await waitForScopedProcessesExit(
		candidates,
		worktreePath,
		launchedAt,
		300,
		onProgress,
	);
	if (termResult === null) return "unavailable";
	if (termResult) return "stopped";
	for (const candidate of candidates) {
		const same = sameProcess(candidate.pid, candidate.stamp, launchedAt);
		if (same === null) return "unavailable";
		if (!same) continue;
		const member = isScopeMember(candidate.pid, worktreePath);
		if (member === null) return "unavailable";
		if (!member) continue;
		try {
			process.kill(candidate.pid, "SIGKILL");
		} catch (error) {
			if (error?.code !== "ESRCH") return "unavailable";
		}
	}
	const killResult = await waitForScopedProcessesExit(
		candidates,
		worktreePath,
		launchedAt,
		1_500,
		onProgress,
	);
	return killResult === true ? "stopped" : "unavailable";
}

/** Settle both the writer process group and new processes still in its worktree. */
export async function settleSimpleWriterProcesses({
	processGroupId,
	processScopePath,
	launchedAt,
	onProgress,
}) {
	const groupState = await settleProcessGroup(processGroupId, onProgress);
	const scopeState = processScopePath
		? await settleScopedProcesses(processScopePath, launchedAt, onProgress)
		: "stopped";
	return groupState === "stopped" && scopeState === "stopped"
		? "stopped"
		: "unavailable";
}
