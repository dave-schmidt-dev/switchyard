import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import {
	linkPythonVenv,
	sharedVenvRoot,
	verifiedPythonVenv,
	verifySharedVenvRoot,
} from "./python-venv.mjs";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const PYTHON_MANIFESTS = [
	"pyproject.toml",
	"uv.lock",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
];

/** Only explicit relative Python files and simple, non-parametrized node ids. */
function isRelativePyTestPath(target) {
	if (typeof target !== "string") return false;
	const [path, ...nodes] = target.split("::");
	return (
		!path.startsWith("-") &&
		/^[A-Za-z0-9._/@+-]+\.py$/u.test(path) &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..") &&
		nodes.every((node) => /^[A-Za-z0-9_]+$/u.test(node))
	);
}

/** The sole Python Quick grammar; command size also applies to direct argv use. */
export function isPythonCheck(args) {
	if (
		!Array.isArray(args) ||
		args.some((arg) => typeof arg !== "string") ||
		args.join(" ").length > 300 ||
		(args[0] !== ".venv/bin/python" && !sharedVenvRoot(args[0])) ||
		args[1] !== "-m" ||
		args[2] !== "pytest"
	)
		return false;
	const targets = args[3] === "-q" ? args.slice(4) : args.slice(3);
	return (
		targets.length >= 1 &&
		targets.length <= 8 &&
		targets.every(isRelativePyTestPath)
	);
}

function entry(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
function inside(path, root) {
	return path.startsWith(`${root}${sep}`);
}
function refused(code = "setup_unavailable") {
	return Object.assign(new Error(code), { code });
}

/** Every supported manifest present on either side must be regular and identical. */
export function verifyPythonManifests(projectPath, clone) {
	try {
		for (const name of PYTHON_MANIFESTS) {
			const source = join(projectPath, name),
				candidate = join(clone, name);
			const left = entry(source),
				right = entry(candidate);
			if (!left && !right) continue;
			if (
				!left?.isFile() ||
				!right?.isFile() ||
				left.size > MAX_MANIFEST_BYTES ||
				left.size !== right.size ||
				!readFileSync(source).equals(readFileSync(candidate))
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Validate the owner interpreter before reusing the shared P0 grant proof. */
function ownerVenv(projectPath) {
	const project = realpathSync(projectPath);
	let venv;
	try {
		venv = realpathSync(join(project, ".venv"));
	} catch {
		throw refused();
	}
	if (!inside(venv, project)) throw refused("check_venv_outside_project");
	return verifiedPythonVenv(venv);
}

/** The one ignored dependency entry must remain the exact trusted owner link. */
export function verifyPythonCheckLink(projectPath, clone, sharedVenv = null) {
	try {
		const linked = join(clone, ".venv");
		return (
			lstatSync(linked).isSymbolicLink() &&
			realpathSync(linked) ===
				(sharedVenv ? verifySharedVenvRoot(sharedVenv) : ownerVenv(projectPath))
		);
	} catch {
		return false;
	}
}

/** Reject candidate-provided venv entries, then reuse P0 without broader grants. */
export function preparePythonChecks(projectPath, clone, sharedVenv = null) {
	if (!verifyPythonManifests(projectPath, clone) || entry(join(clone, ".venv")))
		throw refused();
	if (sharedVenv) verifySharedVenvRoot(sharedVenv);
	else ownerVenv(projectPath);
	const readOnlyPaths = linkPythonVenv(projectPath, clone, sharedVenv);
	if (!verifyPythonCheckLink(projectPath, clone, sharedVenv)) throw refused();
	appendFileSync(join(clone, ".git", "info", "exclude"), "\n/.venv\n");
	return readOnlyPaths;
}

/** Candidate-only imports and all Python/pytest caches stay in the runtime. */
export function pythonCheckEnv(clone, env, runtime) {
	return {
		...env,
		PYTHONPATH: `${join(clone, "src")}:${clone}`,
		PYTHONNOUSERSITE: "1",
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONPYCACHEPREFIX: join(runtime, "python-cache"),
		PYTEST_ADDOPTS: `-o cache_dir=${JSON.stringify(join(runtime, "pytest-cache"))} --basetemp=${JSON.stringify(join(runtime, "pytest-tmp"))}`,
		XDG_CACHE_HOME: join(runtime, "cache"),
	};
}

/** A bounded command is its declaration; one check set may read one shared venv. */
export function declaredSharedVenv(checks) {
	const roots = new Set(
		checks
			.filter(isPythonCheck)
			.map((args) => sharedVenvRoot(args[0]))
			.filter(Boolean),
	);
	if (
		roots.size > 1 ||
		(roots.size &&
			checks.some(
				(args) => isPythonCheck(args) && args[0] === ".venv/bin/python",
			))
	)
		throw refused();
	return [...roots][0] ?? null;
}
