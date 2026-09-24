import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUARANTINE_PARENT = "/private/tmp";
const MARKER = ".switchyard-cleanup-owner.json";
const MAX_LSOF_BYTES = 32 * 1024 * 1024;
const HELPER = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../scripts/safe-remove-worktree.py",
);

export function simpleQuarantinePath(nonce) {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			nonce ?? "",
		)
	) {
		throw new Error("invalid cleanup nonce");
	}
	return join(QUARANTINE_PARENT, `switchyard-quarantine-${nonce}`);
}

function proveRoot(path, claim, runId) {
	if (
		!claim ||
		!/^[0-9]+$/.test(claim.device ?? "") ||
		!/^[0-9]+$/.test(claim.inode ?? "")
	) {
		throw new Error("worktree identity missing");
	}
	if (realpathSync(dirname(path)) !== dirname(path))
		throw new Error("worktree parent changed");
	const root = lstatSync(path, { bigint: true });
	if (
		!root.isDirectory() ||
		root.isSymbolicLink() ||
		realpathSync(path) !== path ||
		root.dev.toString() !== claim.device ||
		root.ino.toString() !== claim.inode ||
		Number(root.uid) !== process.getuid()
	)
		throw new Error("worktree identity changed");
	const markerPath = join(path, MARKER);
	const marker = lstatSync(markerPath);
	if (
		!marker.isFile() ||
		marker.isSymbolicLink() ||
		marker.uid !== process.getuid() ||
		(marker.mode & 0o177) !== 0 ||
		marker.size > 4096
	)
		throw new Error("worktree marker invalid");
	const contents = JSON.parse(readFileSync(markerPath, "utf8"));
	if (
		Object.keys(contents).sort().join(",") !== "nonce,runId" ||
		contents.runId !== runId ||
		contents.nonce !== claim.nonce
	)
		throw new Error("worktree marker mismatch");
}

export function verifySimpleWorktreeClaim(path, claim, runId) {
	try {
		proveRoot(path, claim, runId);
		return true;
	} catch {
		return false;
	}
}

function command(
	commandName,
	args,
	{
		input = null,
		maxBytes = MAX_LSOF_BYTES,
		timeoutMs = 20_000,
		onStatus = () => {},
	} = {},
) {
	return new Promise((resolveResult) => {
		let child;
		try {
			child = spawn(commandName, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			resolveResult({ ok: false, reason: error.code ?? "spawn_failed" });
			return;
		}
		let output = "";
		let bytes = 0;
		let timedOut = false;
		let exceeded = false;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(progress);
			resolveResult(value);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, timeoutMs);
		const progress = setInterval(() => {
			try {
				onStatus("cleanup_scan_running");
			} catch {}
		}, 5_000);
		child.stdin?.on("error", () => {});
		child.stdin?.end(input ?? "");
		child.stdout?.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > maxBytes) {
				exceeded = true;
				try {
					child.kill("SIGKILL");
				} catch {}
			} else output += chunk.toString("utf8");
		});
		child.stderr?.on("data", () => {
			try {
				onStatus("cleanup_helper_progress");
			} catch {}
		});
		child.on("error", (error) =>
			finish({ ok: false, reason: error.code ?? "process_error" }),
		);
		child.on("close", (code) =>
			finish(
				timedOut
					? { ok: false, reason: "timeout" }
					: exceeded
						? { ok: false, reason: "output_limit" }
						: {
								ok: code === 0,
								reason: code === 0 ? null : "process_exit_nonzero",
								output,
							},
			),
		);
	});
}

export async function scanSimpleWorktreeOpenHandles(
	paths,
	onStatus = () => {},
) {
	onStatus("cleanup_scan_started");
	const scan = await command("/usr/sbin/lsof", ["-nP", "-Fn"], { onStatus });
	if (!scan.ok) return { complete: false, openPaths: [] };
	const openPaths = new Set();
	for (const line of scan.output.split("\n")) {
		if (line.startsWith("n")) {
			const name = line.slice(1);
			for (const path of paths) {
				if (
					name === path ||
					name.startsWith(`${path}/`) ||
					name.startsWith(`${path} (`)
				)
					openPaths.add(path);
			}
		}
	}
	return { complete: true, openPaths: [...openPaths] };
}

async function noOpenHandles(path, onStatus) {
	const scan = await scanSimpleWorktreeOpenHandles([path], onStatus);
	return scan.complete && scan.openPaths.length === 0;
}

/** Remove only one exact recorded root after its provider/check group is gone. */
export async function cleanupSimpleWorktree(
	runId,
	claim,
	{
		writerStopped = false,
		onStatus = () => {},
		postQuarantineCheck = null,
	} = {},
) {
	let path = claim?.path ?? null;
	const retained = (reason) => ({ removed: false, path, reason });
	if (!writerStopped) return retained("writer_stop_unconfirmed");
	try {
		if (path !== resolve(claim.canonicalParent, claim.candidateChild))
			throw new Error("worktree path mismatch");
		const quarantine = simpleQuarantinePath(claim.nonce);
		const originalExists = (() => {
			try {
				lstatSync(path);
				return true;
			} catch (error) {
				if (error.code === "ENOENT") return false;
				throw error;
			}
		})();
		const quarantineExists = (() => {
			try {
				lstatSync(quarantine);
				return true;
			} catch (error) {
				if (error.code === "ENOENT") return false;
				throw error;
			}
		})();
		if (path !== quarantine && originalExists && quarantineExists)
			throw new Error("original and quarantine both exist");
		if (path === quarantine && originalExists) {
			proveRoot(path, claim, runId);
		} else if (originalExists) {
			proveRoot(path, claim, runId);
			if (realpathSync(QUARANTINE_PARENT) !== QUARANTINE_PARENT)
				throw new Error("quarantine parent changed");
			onStatus("cleanup_quarantine_started");
			renameSync(path, quarantine);
			path = quarantine;
		} else if (quarantineExists) {
			path = quarantine;
		} else {
			throw new Error("recorded root missing");
		}
		proveRoot(path, claim, runId);
		if (!(await noOpenHandles(path, onStatus)))
			return retained("open_handles_or_scan_unavailable");
		if (postQuarantineCheck && !(await postQuarantineCheck(path)))
			return retained("recently_modified_or_unavailable");
		// Recheck the exact root and marker immediately before the bounded helper.
		proveRoot(path, claim, runId);
		onStatus("cleanup_remove_started");
		const removal = await command("/usr/bin/python3", [HELPER], {
			input: JSON.stringify({
				quarantinePath: path,
				expectedDevice: claim.device,
				expectedInode: claim.inode,
				runId,
				nonce: claim.nonce,
			}),
			maxBytes: 1024 * 1024,
			timeoutMs: 120_000,
			onStatus,
		});
		if (!removal.ok) return retained("guarded_removal_failed");
		const result = JSON.parse(removal.output);
		if (result.status !== "removed")
			return retained("guarded_removal_unconfirmed");
		return { removed: true, path, reason: null };
	} catch {
		return retained("worktree_identity_or_quarantine_unavailable");
	}
}
