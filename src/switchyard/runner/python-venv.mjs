import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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
export function linkPythonVenv(projectPath, clonePath) {
	const venv = join(projectPath, ".venv");
	if (!existsSync(venv)) return [];
	const resolved = realpathSync(venv);
	if (!resolved.startsWith(`${realpathSync(projectPath)}/`))
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
