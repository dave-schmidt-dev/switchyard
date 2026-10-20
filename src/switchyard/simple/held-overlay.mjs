/** Persist overlay identity without bytes; restore only the exact original input. */
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateDiff } from "../integrate/index.mjs";
import { validateDirtyOverlayReceipt } from "../lifecycle/dirty-overlay.mjs";
import {
	assertOverlayPathSafe,
	normalizeOverlayPath,
} from "../lifecycle/overlay-paths.mjs";
import { git, MAX_CAPTURE_BYTES, requireGit, SECRET_PATHS } from "./args.mjs";
import { headAdvanceSafe } from "./head-advance.mjs";
import { declaredPathsAreClean, fileFingerprint } from "./overlay.mjs";

/** Strip private overlay bytes from the durable held receipt. */
export function persistHeldOverlay(overlay) {
	if (!overlay) return null;
	return {
		...overlay,
		paths: overlay.paths.map(({ bytes: _bytes, ...entry }) => entry),
	};
}

/** Restore and validate exactly the captured overlay; never mint a new identity. */
export function restoreHeldOverlay(projectPath, receipt) {
	const identity = receipt.dirtyOverlay;
	if (!identity) return null;
	const invalid = () =>
		Object.assign(new Error("held_overlay_invalid"), {
			code: "held_overlay_invalid",
		});
	if (
		receipt.schemaVersion !== 3 ||
		!Array.isArray(receipt.files) ||
		!Array.isArray(receipt.readOnlyInputs)
	)
		throw invalid();
	const expected = [...receipt.files, ...receipt.readOnlyInputs];
	if (
		!Array.isArray(identity.paths) ||
		identity.paths.length !== expected.length ||
		identity.paths.some((entry, i) => entry?.path !== expected[i]) ||
		new Set(expected).size !== expected.length
	)
		throw invalid();
	const paths = identity.paths.map((entry) => {
		if (
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0 ||
			entry.size > MAX_CAPTURE_BYTES ||
			Object.hasOwn(entry, "bytes")
		)
			throw invalid();
		if (normalizeOverlayPath(projectPath, entry.path) !== entry.path)
			throw invalid();
		assertOverlayPathSafe(projectPath, entry.path, {
			enforceTarPathLimit: false,
			secretPaths: SECRET_PATHS,
		});
		const path = resolve(projectPath, entry.path);
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.size !== entry.size
		)
			throw invalid();
		return { ...entry, bytes: readFileSync(path).toString("base64") };
	});
	const overlay = { ...identity, paths };
	const result = validateDirtyOverlayReceipt(projectPath, overlay, expected, {
		allowUnrelated: true,
		allowHeadAdvance: true,
		maxFileBytes: MAX_CAPTURE_BYTES,
		enforceTarPathLimit: false,
		secretPaths: SECRET_PATHS,
	});
	if (!result.ok) throw invalid();
	return overlay;
}

/** Why the held receipt no longer describes this tree, or null. */
export function heldInputStaleDetail(receipt, head, projectPath) {
	const { verifiedHead } = receipt;
	if (head !== verifiedHead) {
		if (
			git(projectPath, ["merge-base", "--is-ancestor", verifiedHead, head])
				.status !== 0
		)
			return "head_not_descendant";
		if (
			!headAdvanceSafe({
				projectPath,
				base: verifiedHead,
				head,
				paths: [...receipt.scopeFiles, ...receipt.readOnlyInputs],
			})
		)
			return "declared_path_committed";
		// Renames and copies are never detected, so a renamed or copied
		// executable shows as `create mode 100755` and refuses.
		const peerDiff = requireGit(
			projectPath,
			["diff", "--no-renames", "--binary", "--full-index", verifiedHead, head],
			"project_revision_unavailable",
			{ maxBuffer: MAX_CAPTURE_BYTES },
		);
		if (peerDiff.trim()) {
			const peer = validateDiff(peerDiff, projectPath);
			if (!peer.safe || peer.requiresReview) return "peer_history_unsafe";
		}
	}
	if (receipt.dirtyOverlay) {
		try {
			restoreHeldOverlay(projectPath, receipt);
		} catch {
			return "dirty_overlay_drift";
		}
	}
	const overlayPaths = new Set(
		receipt.dirtyOverlay?.paths.map((entry) => entry.path) ?? [],
	);
	const cleanPaths = receipt.scopeFiles.filter(
		(path) => !overlayPaths.has(path),
	);
	if (cleanPaths.length > 0 && !declaredPathsAreClean(projectPath, cleanPaths))
		return "declared_path_dirty";
	if (
		fileFingerprint(
			projectPath,
			receipt.dirtyOverlay
				? [...receipt.files, ...receipt.readOnlyInputs]
				: receipt.files,
		) !== receipt.declaredFingerprint
	)
		return "declared_path_changed";
	return null;
}
