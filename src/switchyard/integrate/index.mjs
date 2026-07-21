// Integration module - reviewed integration gate
// INV-2: Code returns to Mac only through explicit reviewed gate
// Implements git apply of approved diffs

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";

const SCratch_DIR = join(cwd(), ".switchyard-scratch");

/**
 * Apply a diff to the host after review.
 * INV-2: This is the only path for agent output to reach host files
 * @param {string} diff The git diff to apply
 * @param {string} projectPath Target project path
 * @returns {boolean} true if apply succeeded
 */
export function applyReviewedDiff(diff, projectPath) {
	try {
		// Write diff to temp file
		const diffPath = join(SCratch_DIR, "reviewed.diff");
		mkdirSync(dirname(diffPath), { recursive: true });
		writeFileSync(diffPath, diff, "utf8");

		// Apply with git apply in the project directory
		const result = spawnSync("git", ["apply", diffPath], {
			cwd: projectPath,
			stdio: "inherit",
		});

		// Clean up temp file
		rmSync(diffPath, { force: true });

		return result.status === 0;
	} catch (error) {
		console.error("Failed to apply reviewed diff:", error.message);
		return false;
	}
}

/**
 * Validate that a diff is safe to apply.
 * Checks for path traversal, file type changes, etc.
 * @param {string} diff The git diff to validate
 * @returns {boolean} true if diff appears safe
 */
export function validateDiff(diff) {
	// Check for path traversal attempts
	if (
		diff.includes("../") ||
		diff.includes("/etc/") ||
		diff.includes("/root/")
	) {
		console.error("Diff contains suspicious paths");
		return false;
	}

	// Check for credential file modifications
	const credentialPatterns = [
		".env",
		"credentials",
		"secrets",
		"api_key",
		"token",
		"password",
	];

	for (const pattern of credentialPatterns) {
		if (diff.toLowerCase().includes(pattern)) {
			console.error(`Diff modifies credential-related file: ${pattern}`);
			return false;
		}
	}

	return true;
}

/**
 * Full integration gate: validate then apply.
 * INV-2: The single door between sandbox and host
 * @param {string} diff The git diff from agent
 * @param {string} projectPath Target project path
 * @returns {{success: boolean, message: string}} Result
 */
export function integrationGate(diff, projectPath) {
	if (!validateDiff(diff)) {
		return { success: false, message: "Diff validation failed" };
	}

	if (applyReviewedDiff(diff, projectPath)) {
		return { success: true, message: "Diff applied successfully" };
	}

	return { success: false, message: "Diff apply failed" };
}
