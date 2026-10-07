/**
 * Read-only sandbox grants for path dependencies the project's own manifests
 * declare outside the project (owner decision 2026-10-06).
 *
 * Sources, read from the trusted project and never from a candidate clone:
 * - `pyproject.toml` `[tool.uv.sources]` entries with a `path` key;
 * - `package.json` `dependencies`/`devDependencies` values starting `file:`.
 *
 * A declared path is resolved against the project, then realpath'd. One that
 * stays inside the project needs no grant and is ignored. Any other is granted
 * only when it is a directory strictly inside the project's parent, no
 * component of the declared or resolved path is a dot-directory, and its top
 * level holds no credential file (`.env`, `.env.*`, `.netrc`, `id_*`). Every
 * other declared path refuses the checks with `check_dependencies_unverified`.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PTH_BYTES = 64 * 1024;
const PRINTABLE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]{1,128}$/u;

/** The error message names the dependency, never its path or contents. */
function refused(name) {
	const label = PRINTABLE_NAME.test(name) ? name : "(unprintable name)";
	return Object.assign(
		new Error(
			`check_dependencies_unverified: path dependency ${label} refused`,
		),
		{ code: "check_dependencies_unverified" },
	);
}

function within(root, path) {
	return path === root || path.startsWith(`${root}${sep}`);
}

function readSmallFile(path, limit) {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > limit) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Strip comments and fold multi-line strings out of TOML text so a header or
 * entry quoted inside a string never counts. Single-line strings stay intact.
 */
function tomlLogicalLines(text) {
	const lines = [];
	let line = "";
	let quote = null;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const triple = text.slice(index, index + 3);
		if (quote === '"""' || quote === "'''") {
			if (quote === '"""' && char === "\\") index += 1;
			else if (triple === quote) {
				while (text[index + 3] === quote[0]) index += 1;
				index += 2;
				quote = null;
				line += '""';
			}
		} else if (quote) {
			line += char;
			if (quote === '"' && char === "\\") line += text[++index] ?? "";
			else if (char === quote) quote = null;
			else if (char === "\n") return null;
		} else if (triple === '"""' || triple === "'''") {
			quote = triple;
			index += 2;
		} else if (char === '"' || char === "'") {
			quote = char;
			line += char;
		} else if (char === "#") {
			while (index + 1 < text.length && text[index + 1] !== "\n") index += 1;
		} else if (char === "\n") {
			lines.push(line.trim());
			line = "";
		} else line += char;
	}
	if (quote) return null;
	lines.push(line.trim());
	return lines;
}

/** Parse `{ key = "string" | 'string' | true | false, ... }` or return null. */
function inlineTable(text) {
	const source = text.trim();
	if (!source.startsWith("{") || !source.endsWith("}")) return null;
	const body = source.slice(1, -1);
	const table = {};
	const pair =
		/^\s*([A-Za-z0-9_-]+)\s*=\s*("[^"\\]*"|'[^']*'|true|false)\s*(?:,|$)/u;
	let rest = body;
	while (rest.trim()) {
		const match = pair.exec(rest);
		if (!match || Object.hasOwn(table, match[1])) return null;
		const value = match[2];
		table[match[1]] =
			value === "true" || value === "false"
				? value === "true"
				: value.slice(1, -1);
		rest = rest.slice(match[0].length);
	}
	return table;
}

/**
 * Path sources from `[tool.uv.sources]`. Accepted grammar, one entry per line:
 * a bare (`[A-Za-z0-9_-]+`) or simple double-quoted key, `=`, and a
 * single-line inline table whose values are basic strings without escapes,
 * literal strings or booleans. Comments are allowed. Any other spelling
 * (`[tool.uv.sources.<name>]` subtables, dotted keys, multi-line arrays or
 * tables, escaped strings) is not recognised and therefore receives no grant.
 */
export function uvPathSources(text) {
	const lines = tomlLogicalLines(text);
	if (!lines) return [];
	const sources = [];
	let inSources = false;
	for (const line of lines) {
		if (line.startsWith("[")) {
			inSources = /^\[\s*tool\s*\.\s*uv\s*\.\s*sources\s*\]$/u.test(line);
			continue;
		}
		if (!inSources) continue;
		const entry = /^([A-Za-z0-9_-]+|"[^"\\]*")\s*=\s*(\{.*\})$/u.exec(line);
		const table = entry && inlineTable(entry[2]);
		if (typeof table?.path !== "string") continue;
		sources.push({ name: entry[1].replace(/^"|"$/gu, ""), path: table.path });
	}
	return sources;
}

function npmFileSources(text) {
	let manifest;
	try {
		manifest = JSON.parse(text);
	} catch {
		return [];
	}
	const sources = [];
	for (const group of ["dependencies", "devDependencies"]) {
		const declared = manifest?.[group];
		if (!declared || typeof declared !== "object") continue;
		for (const [name, value] of Object.entries(declared))
			if (typeof value === "string" && value.startsWith("file:"))
				sources.push({ name, path: value.slice("file:".length) });
	}
	return sources;
}

function hasDotDirectory(path) {
	return path
		.split(/[\\/]/u)
		.some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

function credentialFile(name) {
	return (
		name === ".env" ||
		name.startsWith(".env.") ||
		name === ".netrc" ||
		name.startsWith("id_")
	);
}

/** Return the realpath to grant, null when no grant is needed, or throw. */
function acceptedPath(project, { name, path }) {
	if (!path || path.includes("\0")) throw refused(name);
	const declared = resolve(project, path);
	let real;
	try {
		real = realpathSync(declared);
	} catch {
		if (within(project, declared)) return null;
		throw refused(name);
	}
	if (within(project, real)) return null;
	const parent = dirname(project);
	// Checks that need no read of the target run first; the top-level listing
	// runs last, so a refused path such as ~/.ssh is never listed.
	let entries;
	try {
		if (!lstatSync(real).isDirectory()) throw refused(name);
		if (!real.startsWith(`${parent}${sep}`)) throw refused(name);
		if (hasDotDirectory(path) || hasDotDirectory(real)) throw refused(name);
		entries = readdirSync(real);
	} catch {
		throw refused(name);
	}
	if (entries.some(credentialFile)) throw refused(name);
	return real;
}

/**
 * Realpaths of the out-of-project path dependencies that `projectPath`'s own
 * root `pyproject.toml` and `package.json` declare, each safe to expose
 * read-only to the check sandbox. Throws `check_dependencies_unverified` for
 * any declared path outside the project that fails the acceptance rules.
 */
export function declaredPathDependencies(projectPath) {
	const project = realpathSync(projectPath);
	const pyproject = readSmallFile(
		join(project, "pyproject.toml"),
		MAX_MANIFEST_BYTES,
	);
	const npm = readSmallFile(join(project, "package.json"), MAX_MANIFEST_BYTES);
	const sources = [
		...(pyproject ? uvPathSources(pyproject) : []),
		...(npm ? npmFileSources(npm) : []),
	];
	const accepted = new Set();
	for (const source of sources) {
		const real = acceptedPath(project, source);
		if (real) accepted.add(real);
	}
	return [...accepted];
}

/**
 * Entries of single-line `.pth` files in the project's `.venv` whose named path
 * resolves to, or under, an accepted dependency. Other `.pth` files (import
 * hooks, the project's own editable install, undeclared paths) get nothing.
 */
export function venvPathEntries(projectPath, accepted) {
	if (!accepted.length) return [];
	const project = realpathSync(projectPath);
	let versions;
	let lib;
	try {
		const venv = realpathSync(join(project, ".venv"));
		if (!venv.startsWith(`${project}${sep}`)) return [];
		lib = join(venv, "lib");
		versions = readdirSync(lib);
	} catch {
		return [];
	}
	const entries = [];
	for (const version of versions) {
		if (!/^python3(?:\.\d+)?$/u.test(version)) continue;
		const site = join(lib, version, "site-packages");
		let names;
		try {
			names = readdirSync(site);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".pth")) continue;
			const lines = (readSmallFile(join(site, name), MAX_PTH_BYTES) ?? "")
				.split(/\r?\n/u)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#"));
			if (lines.length !== 1 || /^import[ \t]/u.test(lines[0])) continue;
			const named = isAbsolute(lines[0]) ? lines[0] : resolve(site, lines[0]);
			if (hasDotDirectory(named)) continue;
			let real;
			try {
				real = realpathSync(named);
			} catch {
				continue;
			}
			if (accepted.some((root) => within(root, real))) entries.push(named);
		}
	}
	return entries;
}

/**
 * The sandbox profile re-resolves every read path on each check, so a grant
 * is re-verified first: each accepted directory must still be its own realpath
 * and each `.pth` entry must still resolve inside one of them.
 */
export function pathDependenciesUnchanged(accepted, entries) {
	try {
		return (
			accepted.every((root) => realpathSync(root) === root) &&
			entries.every((entry) => {
				const real = realpathSync(entry);
				return accepted.some((root) => within(root, real));
			})
		);
	} catch {
		return false;
	}
}
