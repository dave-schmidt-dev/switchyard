import {
	appendFileSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, sep } from "node:path";
import { linkPythonVenv, venvBaseInterpreterPrefix } from "./python-venv.mjs";

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
		args[0] !== ".venv/bin/python" ||
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
	try {
		if (
			!statSync(venv).isDirectory() ||
			!lstatSync(join(venv, "pyvenv.cfg")).isFile()
		)
			throw refused();
		const prefixes = venvBaseInterpreterPrefix(venv);
		if (prefixes.length === 0) throw refused();
		const python = realpathSync(join(venv, "bin", "python"));
		const executable = statSync(python);
		if (
			!executable.isFile() ||
			!(executable.mode & 0o111) ||
			![venv, ...prefixes.map((path) => realpathSync(path))].some((root) =>
				inside(python, root),
			)
		)
			throw refused();
		return venv;
	} catch (error) {
		if (error.code === "check_venv_outside_project") throw error;
		throw refused();
	}
}

/** The one ignored dependency entry must remain the exact trusted owner link. */
export function verifyPythonCheckLink(projectPath, clone) {
	try {
		const linked = join(clone, ".venv");
		return (
			lstatSync(linked).isSymbolicLink() &&
			realpathSync(linked) === ownerVenv(projectPath)
		);
	} catch {
		return false;
	}
}

/** Reject candidate-provided venv entries, then reuse P0 without broader grants. */
export function preparePythonChecks(projectPath, clone) {
	if (!verifyPythonManifests(projectPath, clone) || entry(join(clone, ".venv")))
		throw refused();
	ownerVenv(projectPath);
	const readOnlyPaths = linkPythonVenv(projectPath, clone);
	if (!verifyPythonCheckLink(projectPath, clone)) throw refused();
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
