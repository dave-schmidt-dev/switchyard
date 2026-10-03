import {
	accessSync,
	closeSync,
	constants,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const PACKAGE_MANAGERS = new Set([
	"npx",
	"npm",
	"pnpm",
	"pnpx",
	"yarn",
	"bun",
	"bunx",
]);
const SHELL_WRAPPERS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"eval",
	"env",
	"command",
	"exec",
	"sudo",
	"xargs",
	"nice",
	"nohup",
	"timeout",
	"if",
	"then",
	"else",
	"elif",
	"for",
	"while",
	"until",
	"do",
	"case",
	"function",
	"time",
	"!",
]);
const BIN_NAME = /^[A-Za-z0-9_-]+$/u;

function manifest(path) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
		throw new Error("invalid_manifest");
	return JSON.parse(readFileSync(path, "utf8"));
}

function bins(entry, packageName) {
	if (typeof entry?.bin === "string")
		return { [basename(packageName)]: entry.bin };
	return entry?.bin &&
		typeof entry.bin === "object" &&
		!Array.isArray(entry.bin)
		? entry.bin
		: {};
}

function inside(root, path) {
	return path.startsWith(`${root}${sep}`);
}

function declaredVersionMatches(declaration, version) {
	if (declaration === version) return true;
	const range = /^(\^|~)(\d+)\.(\d+)\.(\d+)$/u.exec(declaration ?? "");
	const locked = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
	if (!range || !locked) return false;
	const minimum = range.slice(2).map(Number);
	const actual = locked.slice(1).map(Number);
	const difference = actual.findIndex((part, index) => part !== minimum[index]);
	if (difference >= 0 && actual[difference] < minimum[difference]) return false;
	const fixed =
		range[1] === "~" ? 2 : minimum[0] > 0 ? 1 : minimum[1] > 0 ? 2 : 3;
	return actual.slice(0, fixed).every((part, index) => part === minimum[index]);
}

function localBinary(worktreePath, name, lock) {
	const root = realpathSync(worktreePath);
	const declared = manifest(join(root, "package.json"));
	if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages?.[""])
		return null;
	const owners = Object.entries(lock.packages).filter(
		([path, entry]) =>
			/^node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(path) &&
			Object.hasOwn(bins(entry, path.slice("node_modules/".length)), name),
	);
	if (owners.length !== 1) return null;
	const [packagePath, pinned] = owners[0];
	const packageName = packagePath.slice("node_modules/".length);
	const groups = ["dependencies", "devDependencies", "optionalDependencies"];
	const declarations = groups.filter((group) =>
		Object.hasOwn(declared[group] ?? {}, packageName),
	);
	if (
		declarations.length !== 1 ||
		pinned.link === true ||
		!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/u.test(pinned.version ?? "")
	)
		return null;
	const group = declarations[0];
	if (declared[group][packageName] !== lock.packages[""][group]?.[packageName])
		return null;
	if (!declaredVersionMatches(declared[group][packageName], pinned.version))
		return null;
	const modules = realpathSync(join(root, "node_modules"));
	const packageRoot = realpathSync(join(root, packagePath));
	if (!inside(root, modules) || !inside(modules, packageRoot)) return null;
	const installed = manifest(join(packageRoot, "package.json"));
	if (installed.name !== packageName || installed.version !== pinned.version)
		return null;
	const target = bins(installed, packageName)[name];
	if (
		typeof target !== "string" ||
		isAbsolute(target) ||
		target.split("/").includes("..") ||
		target !== bins(pinned, packageName)[name]
	)
		return null;
	const resolved = realpathSync(resolve(packageRoot, target));
	if (!inside(packageRoot, resolved) || !lstatSync(resolved).isFile())
		return null;
	if (realpathSync(join(modules, ".bin", name)) !== resolved) return null;
	accessSync(resolved, constants.X_OK);
	// Use the current Node runtime rather than a shebang's PATH lookup.
	const header = Buffer.alloc(200);
	const fd = openSync(resolved, "r");
	try {
		readSync(fd, header, 0, header.length, 0);
	} finally {
		closeSync(fd);
	}
	const shebang = header.toString("utf8").split("\n")[0];
	return /^#!.*\bnode(?:\s|$)/u.test(shebang)
		? { command: process.execPath, args: [resolved] }
		: { command: resolved, args: [] };
}

/** Identify command positions without interpreting shell expansion or wrappers. */
export function commandWords(command) {
	if (/\$\(|`/u.test(command)) return null;
	const tokens = [];
	let word = "";
	let quote = null;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = null;
			else word += char;
		} else if (char === "'" || char === '"') quote = char;
		else if (/\s/u.test(char) || /[;&|(){}]/u.test(char)) {
			if (word) tokens.push(word);
			word = "";
			if (/[;&|(){}\n\r]/u.test(char)) tokens.push(null);
		} else word += char;
	}
	if (quote) return null;
	if (word) tokens.push(word);
	const commands = [];
	let expectingCommand = true;
	for (const token of tokens) {
		if (token === null) expectingCommand = true;
		else if (expectingCommand && !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
			if (/[$\\]/u.test(token)) return null;
			if (
				["if", "then", "else", "elif", "while", "until", "do", "!"].includes(
					token,
				) ||
				token.startsWith(">") ||
				token.startsWith("<")
			)
				continue;
			commands.push(token);
			expectingCommand = false;
		}
	}
	return commands;
}

/** Resolve package checks only from a declared, matching local lock installation. */
export function resolveCheckExecution(command, worktreePath) {
	const commands = commandWords(command);
	if (!commands) return { kind: "rejected" };
	let lock = null;
	try {
		lock = manifest(join(worktreePath, "package-lock.json"));
	} catch {}
	const declaredBin = Object.entries(lock?.packages ?? {}).some(
		([path, entry]) =>
			commands.some((word) =>
				Object.hasOwn(bins(entry, path.slice("node_modules/".length)), word),
			),
	);
	const packageLaunch = commands.some(
		(word) =>
			PACKAGE_MANAGERS.has(basename(word)) ||
			word.includes("node_modules/.bin/"),
	);
	const wrapper = commands.some((word) => SHELL_WRAPPERS.has(basename(word)));
	const wrapperPackageMention =
		wrapper &&
		command
			.replace(/["']/gu, "")
			.split(/[\s;&|(){}]+/u)
			.some(
				(word) =>
					PACKAGE_MANAGERS.has(basename(word)) ||
					word.includes("node_modules/.bin/") ||
					Object.entries(lock?.packages ?? {}).some(([path, entry]) =>
						Object.hasOwn(
							bins(entry, path.slice("node_modules/".length)),
							word,
						),
					),
			);
	if (!packageLaunch && !declaredBin && !wrapperPackageMention)
		return { kind: "shell" };
	// Package launches have a deliberately tiny argv grammar; shell wrappers,
	// assignments, substitutions, scripts and manager options are unsupported.
	if (!/^[A-Za-z0-9._/@:+= -]+$/u.test(command)) return { kind: "rejected" };
	const args = command.trim().split(/ +/u);
	let tool;
	if (args[0] === "npx") {
		args.shift();
		tool = args.shift();
	} else if (args[0] === "npm" && args[1] === "exec" && args[2] === "--") {
		args.splice(0, 3);
		tool = args.shift();
	} else if (
		/^(?:\.\/)?node_modules\/\.bin\/[A-Za-z0-9_-]+$/u.test(args[0] ?? "")
	) {
		tool = basename(args.shift());
	} else if (declaredBin) tool = args.shift();
	if (!BIN_NAME.test(tool ?? "")) return { kind: "rejected" };
	try {
		const binary = localBinary(worktreePath, tool, lock);
		return binary
			? {
					kind: "local",
					command: binary.command,
					args: [...binary.args, ...args],
				}
			: { kind: "rejected" };
	} catch {
		return { kind: "rejected" };
	}
}
