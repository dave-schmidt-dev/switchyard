#!/usr/bin/env node

/** Warn about large source files and enforce the repository line ceiling. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const DEFAULT_TARGET = 500;
const DEFAULT_MAX_LINES = 800;
const DEFAULT_EXCEPTIONS_PATH = ".file-size-exceptions";
const CHECKED_SUFFIXES = [".mjs", ".js", ".sh", ".py"];

function countLines(contents) {
	return contents.length === 0
		? 0
		: contents.reduce((count, byte) => count + (byte === 10), 0) +
				Number(contents.at(-1) !== 10);
}

function appliesTo(path) {
	return CHECKED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

function parseExceptions(contents, source) {
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
	} catch {
		return {
			entries: new Map(),
			errors: [`${source}: exceptions file must be UTF-8`],
		};
	}
	const entries = new Map();
	const seen = new Set();
	const errors = [];
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(\S+):\s*(.*)$/.exec(line);
		if (!match) {
			errors.push(
				`${source}:${index + 1}: exception entry must be path: reason`,
			);
			continue;
		}
		const [, path, reason] = match;
		if (seen.has(path)) {
			errors.push(`${source}:${index + 1}: duplicate exception path ${path}`);
			continue;
		}
		seen.add(path);
		if (!reason) {
			errors.push(`${source}:${index + 1}: exception entry needs a reason`);
			continue;
		}
		if (/^\d+(?:\s|$)/.test(reason)) {
			errors.push(
				`${source}:${index + 1}: line caps are no longer supported; remove the cap`,
			);
			continue;
		}
		entries.set(path, reason);
	}
	return { entries, errors };
}

function runGit(args) {
	const result = spawnSync("git", args, { maxBuffer: 32 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`,
		);
	}
	return result.stdout;
}

function indexBlob(path) {
	return runGit(["cat-file", "blob", `:${path}`]);
}

function nullPaths(contents) {
	return contents.toString("utf8").split("\0").filter(Boolean);
}

function selectedPaths(mode, files) {
	if (mode === "all") {
		return {
			paths: nullPaths(runGit(["ls-files", "-z", "-co", "--exclude-standard"])),
			touched: new Set(),
		};
	}
	if (mode === "files") return { paths: files, touched: new Set(files) };
	const touched = new Set(
		nullPaths(
			runGit(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]),
		),
	);
	const exceptionsChanged =
		runGit(["diff", "--cached", "--name-only", "--", DEFAULT_EXCEPTIONS_PATH])
			.length > 0;
	return {
		paths: exceptionsChanged
			? nullPaths(runGit(["ls-files", "-z"]))
			: [...touched].sort(),
		touched,
	};
}

function loadExceptions(path, staged) {
	if (staged) {
		try {
			return parseExceptions(
				indexBlob(DEFAULT_EXCEPTIONS_PATH),
				DEFAULT_EXCEPTIONS_PATH,
			);
		} catch {
			return { entries: new Map(), errors: [] };
		}
	}
	if (!existsSync(path)) return { entries: new Map(), errors: [] };
	return parseExceptions(readFileSync(path), path);
}

function parseArguments(argv) {
	const options = {
		target: DEFAULT_TARGET,
		maxLines: DEFAULT_MAX_LINES,
		exceptionsPath: DEFAULT_EXCEPTIONS_PATH,
		mode: null,
		files: [],
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (["--target", "--max-lines", "--exceptions"].includes(arg)) {
			const value = argv[++index];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			if (arg === "--exceptions") options.exceptionsPath = value;
			else {
				if (!/^\d+$/.test(value) || Number(value) <= 0)
					throw new Error(`${arg} must be a positive integer`);
				options[arg === "--target" ? "target" : "maxLines"] = Number(value);
			}
		} else if (arg === "--all" || arg === "--staged") {
			if (options.mode)
				throw new Error(
					"provide exactly one of --staged, --all, or FILE arguments",
				);
			options.mode = arg.slice(2);
		} else if (arg.startsWith("-")) {
			throw new Error(`unknown argument ${arg}`);
		} else {
			options.files.push(arg);
		}
	}
	if (
		(options.mode && options.files.length > 0) ||
		(!options.mode && options.files.length === 0)
	) {
		throw new Error(
			"provide exactly one of --staged, --all, or FILE arguments",
		);
	}
	if (!options.mode) options.mode = "files";
	return options;
}

function checkFiles(paths, exceptions, options, touched) {
	const errors = [];
	for (const path of paths) {
		if (!appliesTo(path)) continue;
		let contents;
		try {
			if (options.mode === "staged") contents = indexBlob(path);
			else {
				if (!existsSync(path) || !statSync(path).isFile()) continue;
				contents = readFileSync(path);
			}
		} catch (error) {
			errors.push(`file-size: ${path}: ${error.message}`);
			continue;
		}
		const lineCount = countLines(contents);
		const exception = exceptions.get(path);
		if (lineCount > options.target && lineCount <= options.maxLines) {
			console.log(
				`file-size: ${path} has ${lineCount} lines (target ${options.target}); split it when a clean seam exists`,
			);
		}
		if (lineCount > options.maxLines && exception === undefined) {
			errors.push(
				`file-size: ${path} has ${lineCount} lines (maximum ${options.maxLines}); add a reasoned entry to ${options.exceptionsPath}`,
			);
		} else if (
			touched.has(path) &&
			lineCount > options.maxLines &&
			exception?.startsWith("legacy ")
		) {
			console.log(
				`file-size: ${path} is a legacy exception (${lineCount} lines); extract a clean seam from it in this piece of work`,
			);
		} else if (
			options.mode !== "all" &&
			exception !== undefined &&
			lineCount <= options.maxLines
		) {
			console.log(
				`file-size: ${path} has ${lineCount} lines (at or under ${options.maxLines}); remove its exception from ${options.exceptionsPath}`,
			);
		}
	}
	return errors;
}

function checkStaleExceptions(exceptions, maxLines, source) {
	const errors = [];
	for (const path of exceptions.keys()) {
		try {
			if (!statSync(path).isFile()) throw new Error("not a file");
			const lineCount = countLines(readFileSync(path));
			if (lineCount <= maxLines)
				errors.push(
					`file-size: ${path} has ${lineCount} lines (at or under ${maxLines}); remove its exception from ${source}`,
				);
		} catch (error) {
			if (error.code === "ENOENT" || error.message === "not a file")
				errors.push(
					`file-size: ${path} is missing; remove its exception from ${source}`,
				);
			else errors.push(`file-size: ${path}: ${error.message}`);
		}
	}
	return errors;
}

function main(argv) {
	const options = parseArguments(argv);
	const { paths, touched } = selectedPaths(options.mode, options.files);
	const { entries, errors } = loadExceptions(
		options.exceptionsPath,
		options.mode === "staged",
	);
	errors.push(...checkFiles(paths, entries, options, touched));
	if (options.mode === "all")
		errors.push(
			...checkStaleExceptions(
				entries,
				options.maxLines,
				options.exceptionsPath,
			),
		);
	for (const error of errors) console.error(error);
	return Number(errors.length > 0);
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	console.error(`file-size: ${error.message}`);
	process.exitCode = 1;
}
