import { createHash } from "node:crypto";

import { applyReviewedDiff, getScopedFingerprint } from "./apply.mjs";

import {
	classifyApplyFailure,
	extractSummaryLines,
	extractTouchedPaths,
	normalizePatch,
	parseRenamePaths,
	validateDiff,
} from "./diff-validation.mjs";

function integrationGateUnsafe(diff, projectPath, options = {}) {
	const { allowedPaths = null, requiredPaths = null } = options;
	const declaredPaths = allowedPaths ?? requiredPaths;

	// Required-paths: empty diff check runs BEFORE patch normalization so we
	// don't accidentally re-terminate an empty string into "\n" and treat it
	// as a (weird) non-empty patch.
	if (
		declaredPaths !== null &&
		(!diff || typeof diff !== "string" || !diff.trim())
	) {
		return { success: false, message: "empty_required_diff" };
	}

	// `git apply` requires a newline-terminated patch. Adapter capture keeps
	// the provider's bytes intact; this compatibility normalizer only repairs
	// sources that arrive without a terminator. It is idempotent and preserves
	// valid one- and two-newline endings.
	const patch = normalizePatch(diff);

	// Files enforcement: check declared vs touched paths.
	// Runs BEFORE the structural checks in validateDiff; still calls
	// validateDiff afterward so structural errors compose (both sets of
	// errors are reported).
	if (declaredPaths !== null) {
		for (const p of declaredPaths) {
			if (
				typeof p === "string" &&
				(p.includes("=>") || p.includes("{") || p.includes("}"))
			) {
				return {
					success: false,
					message: "ambiguous_combined_rename_spelling",
					reasonKind: "ambiguous_combined_rename_spelling",
				};
			}
		}

		const { paths: touchedPaths, stderr: numstatStderr } = extractTouchedPaths(
			patch,
			projectPath,
		);
		if (touchedPaths === null) {
			return {
				success: false,
				message: "diff could not be parsed by git apply",
				reasonKind: classifyApplyFailure(numstatStderr),
			};
		}

		const summaryLines = extractSummaryLines(patch, projectPath);
		const renameSources = [];
		for (const line of summaryLines) {
			const paths = parseRenamePaths(line);
			if (paths) {
				renameSources.push(paths.old);
			}
		}

		const touchedForDeclaration = new Set([...touchedPaths, ...renameSources]);

		const declaredSet = new Set(declaredPaths);
		const missingPaths = (requiredPaths ?? []).filter(
			(p) => !touchedForDeclaration.has(p),
		);
		const extraPaths =
			allowedPaths !== null
				? [...touchedForDeclaration].filter((p) => !declaredSet.has(p))
				: touchedPaths.filter((p) => !declaredSet.has(p));

		if (missingPaths.length > 0) {
			const validation = validateDiff(patch, projectPath);
			const result = {
				success: false,
				message: "required_paths_missing",
				missingPaths,
			};
			if (!validation.safe) {
				result.structural_error = validation.reason;
			}
			return result;
		}

		if (extraPaths.length > 0) {
			const validation = validateDiff(patch, projectPath);
			const result = {
				success: false,
				message: "undeclared_paths_touched",
				extraPaths,
			};
			if (!validation.safe) {
				result.structural_error = validation.reason;
			}
			return result;
		}

		// Exact match — fall through to structural validation.
	}

	const validation = validateDiff(patch, projectPath);
	if (!validation.safe) {
		const result = {
			success: false,
			message: validation.reason ?? "Diff validation failed",
			credentialFlagged: validation.credentialFlagged === true,
		};
		if (typeof validation.reasonKind === "string") {
			result.reasonKind = validation.reasonKind;
		}
		return result;
	}

	const manifestsAreDeclared =
		declaredPaths !== null &&
		(validation.sensitivePaths ?? []).every((path) =>
			declaredPaths.includes(path),
		);
	if (
		validation.requiresReview &&
		!(options.allowSensitiveManifests === true && manifestsAreDeclared)
	) {
		return {
			success: false,
			message:
				"diff touches a build/execution manifest file and requires AllowManifests: true plus an explicit Files: declaration",
			reasonKind: "manifest_review_required",
			requiresReview: true,
			sensitivePaths: validation.sensitivePaths,
		};
	}

	// No-op detection: only for the common path (requiredPaths === null),
	// where touchedPaths isn't computed independently elsewhere in this
	// function. Scoped to touched-path content/state so pre-existing unrelated
	// dirty state in other files never triggers a false no-op report.
	let preFingerprint = "";
	if (declaredPaths === null) {
		preFingerprint = getScopedFingerprint(projectPath, validation.touchedPaths);
	}

	let intent = null;
	if (options.integrationIntent !== undefined) {
		const candidate = options.integrationIntent;
		if (
			!candidate ||
			typeof candidate !== "object" ||
			typeof candidate.acquire !== "function" ||
			typeof candidate.release !== "function" ||
			typeof candidate.persist !== "function" ||
			typeof candidate.complete !== "function" ||
			typeof candidate.read !== "function" ||
			!candidate.operation ||
			typeof candidate.operation.patchHash !== "string" ||
			candidate.operation.patchHash !==
				createHash("sha256").update(patch, "utf8").digest("hex") ||
			JSON.stringify(candidate.operation.paths) !==
				JSON.stringify(declaredPaths ?? [])
		) {
			return { success: false, message: "invalid_integration_intent" };
		}
		intent = candidate;
	}

	let applyResult;
	try {
		applyResult = applyReviewedDiff(
			patch,
			projectPath,
			intent,
			validation.touchedPaths,
		);
	} catch (error) {
		applyResult = {
			applied: false,
			reason: error.message,
			reasonKind: "integration_state_unknown",
		};
	}
	if (applyResult === true) {
		if (declaredPaths === null) {
			const postFingerprint = getScopedFingerprint(
				projectPath,
				validation.touchedPaths,
			);
			if (preFingerprint === postFingerprint) {
				return { success: false, message: "no_op_diff" };
			}
		}
		return { success: true, message: "Diff applied successfully" };
	}

	if (applyResult?.alreadyApplied) {
		return {
			success: true,
			message: "Diff already applied",
			alreadyApplied: true,
		};
	}

	const result = { success: false, message: "Diff apply failed" };
	if (applyResult && typeof applyResult.reason === "string") {
		result.reason = applyResult.reason;
	}
	if (applyResult && typeof applyResult.reasonKind === "string") {
		result.reasonKind = applyResult.reasonKind;
	}
	return result;
}

export function integrationGate(diff, projectPath, options = {}) {
	const result = integrationGateUnsafe(diff, projectPath, options);
	if (typeof options.dirtyOverlayReceiptHash === "string") {
		result.dirtyOverlayReceiptHash = options.dirtyOverlayReceiptHash;
	}
	return result;
}

export {
	validateExactPathSet,
	validateIntegratedCommitAncestry,
	validateIntegratedCommitPaths,
	validateNoTrackedPathOverlap,
} from "./commit-validation.mjs";

export {
	APPLY_CHECK_MAX_BUFFER,
	dequoteGitPath,
	manifestReviewPaths,
	validateDiff,
} from "./diff-validation.mjs";
