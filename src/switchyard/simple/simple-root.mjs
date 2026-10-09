import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

/**
 * Resolves the temp base a simple run allocates under: an injected
 * `dependencies.tmpdir` (function or path) or the process temp directory.
 */
export function simpleTempBase(dependencies = {}) {
	return typeof dependencies.tmpdir === "function"
		? dependencies.tmpdir()
		: (dependencies.tmpdir ?? tmpdir());
}

/**
 * Chooses the disposable root for one simple run.
 * @returns {{canonicalParent: string, candidateChild: string, candidatePath: string}}
 */
export function allocateSimpleRoot(dependencies = {}) {
	const canonicalParent = realpathSync(simpleTempBase(dependencies));
	const candidateChild = `switchyard-simple-${randomUUID()}`;
	return {
		canonicalParent,
		candidateChild,
		candidatePath: join(canonicalParent, candidateChild),
	};
}

/**
 * Test-seam removal used when a test injects provider or check doubles without
 * a cleanup double. Production never reaches it: `handleSimple` injects none
 * of `rmSync`, `executeProvider`, or `runCheck`.
 */
export function removeInjectedTestRoot(
	worktreeRoot,
	canonicalParent,
	dependencies = {},
) {
	const safeParent =
		canonicalParent ?? realpathSync(simpleTempBase(dependencies));
	if (!worktreeRoot.startsWith(`${safeParent}${sep}`))
		throw new Error("unsafe workspace root");
	(dependencies.rmSync ?? rmSync)(worktreeRoot, {
		recursive: true,
		force: true,
	});
}
