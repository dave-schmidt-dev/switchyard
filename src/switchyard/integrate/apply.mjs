import { spawnSync } from "node:child_process";

import { createHash } from "node:crypto";

import { lstatSync, readFileSync, readlinkSync } from "node:fs";

import { resolve } from "node:path";

import {
	APPLY_CHECK_MAX_BUFFER,
	classifyApplyFailure,
} from "./diff-validation.mjs";

export const APPLY_COMMAND_TIMEOUT_MS = 60000;

// Trusted test-only seam: shortens the apply command timeout so tests can
// exercise the SIGKILL path without waiting 60 seconds. Only values strictly
// shorter than the production bound are accepted, so the seam can never relax
// the bound; the production value is never read from the environment or from
// provider input.
let applyCommandTimeoutForTests = null;

export function setApplyCommandTimeoutForTests(timeoutMs) {
	if (timeoutMs === null) {
		applyCommandTimeoutForTests = null;
		return;
	}
	if (
		typeof timeoutMs !== "number" ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs >= APPLY_COMMAND_TIMEOUT_MS
	) {
		throw new Error(
			"apply command timeout seam accepts only timeouts shorter than the production bound",
		);
	}
	applyCommandTimeoutForTests = timeoutMs;
}

function applyCheckPasses(args, diff, projectPath) {
	const result = spawnSync("git", ["apply", ...args], {
		cwd: projectPath,
		input: diff,
		encoding: "utf8",
		maxBuffer: APPLY_CHECK_MAX_BUFFER,
		timeout: applyCommandTimeoutForTests ?? APPLY_COMMAND_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	return {
		ok: result.status === 0,
		stderr: typeof result.stderr === "string" ? result.stderr : "",
		timedOut: result.error?.code === "ETIMEDOUT",
	};
}

function proofEqual(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function scopedStateHash(projectPath, touchedPaths) {
	return createHash("sha256")
		.update(getScopedFingerprint(projectPath, touchedPaths), "utf8")
		.digest("hex");
}

export function applyReviewedDiff(diff, projectPath, intent, touchedPaths) {
	let lease = null;
	let released = false;
	const finish = (result) => {
		if (!intent || !lease || released) return result;
		released = true;
		try {
			intent.release(lease);
			return result;
		} catch (error) {
			return {
				applied: false,
				reason: `integration_state_unknown: ${error.message}`,
				reasonKind: "integration_state_unknown",
			};
		}
	};
	try {
		if (intent) {
			lease = intent.acquire(intent.operation);
			if (!lease)
				return finish({
					applied: false,
					reason: "integration lease unavailable",
					reasonKind: "integration_state_unknown",
				});
			const currentProof = intent.read(intent.operation, lease);
			if (currentProof) {
				if (!proofEqual(currentProof.operation, intent.operation))
					return finish({
						applied: false,
						reason: "integration intent displaced",
						reasonKind: "integration_state_unknown",
					});
				if (currentProof.status !== "completed")
					return finish({
						applied: false,
						reason: "integration_state_unknown",
						reasonKind: "integration_state_unknown",
					});
				if (
					currentProof.afterState !== scopedStateHash(projectPath, touchedPaths)
				)
					return finish({
						applied: false,
						reason: "completed integration state changed",
						reasonKind: "integration_state_unknown",
					});
				return finish({ alreadyApplied: true });
			}
		}
		// Non-mutating forward check: nothing touches the host until git
		// confirms the diff applies cleanly to the current tree.
		const forward = applyCheckPasses(["--check"], diff, projectPath);
		if (forward.ok) {
			if (intent) {
				const pending = {
					operation: structuredClone(intent.operation),
					status: "pending",
					beforeState: scopedStateHash(projectPath, touchedPaths),
				};
				if (
					!proofEqual(intent.persist(pending, lease), pending) ||
					!proofEqual(intent.read(intent.operation, lease), pending)
				) {
					return finish({
						applied: false,
						reason: "integration intent could not be durably persisted",
						reasonKind: "integration_state_unknown",
					});
				}
			}
			// Mutating apply runs exactly once, and only after the forward
			// check passed. stdio is captured (not inherited) so git's own
			// diagnostic on an unexpected failure is returned as `reason`
			// instead of leaking onto the caller's terminal.
			const result = spawnSync("git", ["apply"], {
				cwd: projectPath,
				input: diff,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: applyCommandTimeoutForTests ?? APPLY_COMMAND_TIMEOUT_MS,
				killSignal: "SIGKILL",
			});
			if (result.status === 0) {
				if (intent) {
					const existing = intent.read(intent.operation, lease);
					const completed = {
						...existing,
						status: "completed",
						afterState: scopedStateHash(projectPath, touchedPaths),
					};
					if (
						!proofEqual(intent.complete(completed, lease), completed) ||
						!proofEqual(intent.read(intent.operation, lease), completed)
					) {
						return finish({
							applied: false,
							reason: "integration_state_unknown",
							reasonKind: "integration_state_unknown",
						});
					}
				}
				return finish(true);
			}
			if (
				result.error?.code === "ETIMEDOUT" ||
				(result.status === null && result.signal === "SIGKILL")
			) {
				return finish({
					applied: false,
					reason: "git apply timed out",
					reasonKind: "integration_state_unknown",
				});
			}
			const stderr =
				typeof result.stderr === "string" ? result.stderr.trim() : "";
			return finish({
				applied: false,
				reason:
					stderr ||
					(result.error
						? `git apply failed to spawn: ${result.error.message}`
						: `git apply exited with status ${result.status}`),
			});
		}

		// A matching after-state cannot prove this operation applied: unrelated
		// edits can produce the same bytes. Only an exact, durable completion
		// record bound to this operation may make a retry idempotent.
		// A failed forward check usually means a genuine conflict, but git also
		// reports a truncated or malformed diff through this path. Surface which
		// one it was: classifyApplyFailure() only ever reports
		// "corrupt_patch" on git's own "corrupt patch"/"unrecognized input"
		// diagnostic text, not on any other failure. Surface git's own
		// `--check` diagnostic (e.g. "error: ... patch does not apply") as
		// `reason` so the caller gets actionable text, not just a bare
		// "Diff apply failed".
		return finish({
			applied: false,
			reason:
				(forward.timedOut
					? "git apply --check timed out"
					: forward.stderr.trim()) || "git apply --check rejected the diff",
			reasonKind: forward.timedOut
				? "conflict"
				: classifyApplyFailure(forward.stderr),
		});
	} catch (error) {
		return finish({
			applied: false,
			reason: error.message,
			reasonKind: intent ? "integration_state_unknown" : undefined,
		});
	}
}

export function getScopedFingerprint(projectPath, touchedPaths) {
	return touchedPaths
		.map((relativePath) => {
			const fullPath = resolve(projectPath, relativePath);
			try {
				const stats = lstatSync(fullPath);
				const mode = (stats.mode & 0o7777).toString(8);
				if (stats.isSymbolicLink()) {
					return `${relativePath}\0symlink:${mode}:${readlinkSync(fullPath)}`;
				}
				if (stats.isFile()) {
					const digest = createHash("sha256")
						.update(readFileSync(fullPath))
						.digest("hex");
					return `${relativePath}\0file:${mode}:${digest}`;
				}
				return `${relativePath}\0other:${mode}:${stats.size}`;
			} catch (error) {
				if (error?.code === "ENOENT") {
					return `${relativePath}\0missing`;
				}
				return `${relativePath}\0unreadable:${error?.code ?? "unknown"}`;
			}
		})
		.join("\n");
}
