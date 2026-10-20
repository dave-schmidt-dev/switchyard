import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

/** Refusals carry only the closed code the check session persists. */
function refused(code) {
	return Object.assign(new Error(code), { code });
}

/**
 * A project venv is an explicit dependency input: the checker clone links to
 * the trusted interpreter instead of copying it, and a venv whose real path
 * leaves the project is refused rather than exposed to the sandbox. Returns
 * the read-only roots the sandbox may observe, the resolved venv first.
 */
export function linkPythonVenv(projectPath, clonePath, sharedVenv = null) {
	const venv = sharedVenv ?? join(projectPath, ".venv");
	if (sharedVenv) verifySharedVenvRoot(sharedVenv);
	if (!existsSync(venv)) return [];
	const resolved = realpathSync(venv);
	if (!sharedVenv && !resolved.startsWith(`${realpathSync(projectPath)}/`))
		throw refused("check_venv_outside_project");
	const linked = join(clonePath, ".venv");
	if (!existsSync(linked)) symlinkSync(resolved, linked);
	return [resolved, ...venvBaseInterpreterPrefix(resolved)];
}

/**
 * A venv's bin/python links to its base interpreter (uv, pyenv, Homebrew or
 * python.org), which lives outside the project; the sandbox may read and exec
 * that one interpreter prefix, named by pyvenv.cfg `home`, and nothing beside
 * it. A prefix directly under `/` or `/usr` is too broad to grant, and a
 * symlinked `home` grants both the real prefix and its declared alias.
 */
export function venvBaseInterpreterPrefix(venv) {
	let declared;
	let home;
	try {
		const config = readFileSync(join(venv, "pyvenv.cfg"), "utf8");
		declared = /^home\s*=\s*(.+?)\s*$/mu.exec(config)?.[1];
		if (!declared || !isAbsolute(declared)) return [];
		home = realpathSync(declared);
	} catch {
		return [];
	}
	if (!readdirSync(home).some((name) => /^python3(\.\d+)?$/u.test(name)))
		return [];
	const prefix = dirname(home);
	if (prefix === "/" || prefix === "/usr") return [];
	const alias = dirname(declared);
	return alias === prefix ? [prefix] : [prefix, alias];
}

/** Syntactic declaration only: portable parsing never queries the host account. */
export function sharedVenvRoot(executable) {
	if (typeof executable !== "string" || !isAbsolute(executable)) return null;
	const parts = executable.split("/");
	if (
		parts
			.slice(1)
			.some(
				(part) =>
					!/^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$/u.test(part) &&
					part !== ".venvs",
			)
	)
		return null;
	if (
		parts.at(-4) !== ".venvs" ||
		parts.at(-2) !== "bin" ||
		parts.at(-1) !== "python" ||
		parts.length < 6
	)
		return null;
	return dirname(dirname(executable));
}

/** Bind the declared root to this account, without following a shared-root alias. */
export function verifySharedVenvRoot(venv, home = userInfo().homedir) {
	try {
		const parent = join(realpathSync(home), ".venvs");
		if (
			dirname(venv) !== parent ||
			!lstatSync(parent).isDirectory() ||
			!lstatSync(venv).isDirectory() ||
			realpathSync(venv) !== venv
		)
			throw refused("setup_unavailable");
		return verifiedPythonVenv(venv);
	} catch {
		throw refused("setup_unavailable");
	}
}

/** Existing project-venv executable/base-prefix proof, shared by both forms. */
export function verifiedPythonVenv(venv) {
	try {
		if (
			!statSync(venv).isDirectory() ||
			!lstatSync(join(venv, "pyvenv.cfg")).isFile()
		)
			throw refused("setup_unavailable");
		const prefixes = venvBaseInterpreterPrefix(venv);
		if (prefixes.length === 0) throw refused("setup_unavailable");
		const python = realpathSync(join(venv, "bin", "python"));
		const executable = statSync(python);
		if (
			!executable.isFile() ||
			!(executable.mode & 0o111) ||
			![venv, ...prefixes.map((path) => realpathSync(path))].some((root) =>
				python.startsWith(`${root}${sep}`),
			)
		)
			throw refused("setup_unavailable");
		return venv;
	} catch {
		throw refused("setup_unavailable");
	}
}

/** Recheck identity and interpreter proof before and after a shared check. */
export function sharedVenvReadProof(venv, home = userInfo().homedir) {
	const snapshot = () => {
		verifySharedVenvRoot(venv, home);
		return JSON.stringify([
			...[
				venv,
				join(venv, "pyvenv.cfg"),
				realpathSync(join(venv, "bin", "python")),
				...venvBaseInterpreterPrefix(venv),
			].map((path) => {
				const stat = statSync(path);
				return [path, stat.dev, stat.ino];
			}),
			readFileSync(join(venv, "pyvenv.cfg"), "utf8"),
		]);
	};
	const initial = snapshot();
	return {
		readOnlyPaths: [venv, ...venvBaseInterpreterPrefix(venv)],
		verify() {
			if (snapshot() !== initial) throw refused("setup_unavailable");
		},
	};
}
