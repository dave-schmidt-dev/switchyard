#!/usr/bin/env node

/** Verify that a module split carries top-level statements without semantic drift. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

const PURE_CALLEES = new Set([
	"Object.freeze",
	"Symbol",
	"Set",
	"Map",
	"WeakMap",
	"WeakSet",
	"Array.from",
	"String.raw",
	"RegExp",
	"Number",
	"BigInt",
]);

function fail(errors, message) {
	errors.push(message);
}

function usage() {
	throw new Error(
		"usage: check-seam-move.mjs --mode module --base <ref> --source <path> [--expect <manifest.json>]",
	);
}

function argumentsFrom(argv) {
	const options = { expect: null, mode: null, base: null, source: null };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!["--mode", "--base", "--source", "--expect"].includes(arg)) usage();
		const value = argv[++index];
		if (!value) usage();
		options[arg.slice(2)] = value;
	}
	if (options.mode !== "module" || !options.base || !options.source) usage();
	if (
		options.source.startsWith("/") ||
		options.source.split(/[\\/]/).includes("..")
	) {
		throw new Error("--source must be a repository-relative path");
	}
	return options;
}

function parse(path, text) {
	const result = parseSync(path, text, { sourceType: "module" });
	if (result.errors.length > 0) {
		throw new Error(`${path}: ${result.errors[0].message}`);
	}
	return result.program;
}

function normalized(text) {
	return text
		.split("\n")
		.map((line) => line.replace(/^[\t ]+/, ""))
		.join("\n");
}

function statementText(text, statement) {
	return normalized(text.slice(statement.start, statement.end));
}

function allowedAddedSyntax(statement) {
	return (
		statement.type === "ImportDeclaration" ||
		(statement.type === "ExportNamedDeclaration" && !statement.declaration)
	);
}

function importSource(statement) {
	return statement.type === "ImportDeclaration" ? statement.source.value : null;
}

function exportsOf(program) {
	const names = new Set();
	for (const statement of program.body) {
		if (statement.type === "ExportDefaultDeclaration") names.add("default");
		if (statement.type !== "ExportNamedDeclaration") continue;
		if (statement.declaration?.type === "VariableDeclaration") {
			for (const declaration of statement.declaration.declarations) {
				if (declaration.id.type === "Identifier")
					names.add(declaration.id.name);
			}
		} else if (statement.declaration?.id?.name)
			names.add(statement.declaration.id.name);
		for (const specifier of statement.specifiers) {
			names.add(specifier.exported?.name ?? specifier.exported?.value);
		}
	}
	return [...names].sort();
}

function sameArray(left, right) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function calleeName(callee) {
	if (callee.type === "Identifier") return callee.name;
	if (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.object.type === "Identifier"
	)
		return `${callee.object.name}.${callee.property.name}`;
	return null;
}

function impure(node) {
	let reason = null;
	const walk = (value) => {
		if (!value || typeof value !== "object" || reason) return;
		if (Array.isArray(value)) {
			for (const child of value) walk(child);
			return;
		}
		if (
			[
				"ArrowFunctionExpression",
				"FunctionExpression",
				"ClassExpression",
			].includes(value.type)
		)
			return;
		if (value.type === "CallExpression" || value.type === "NewExpression") {
			const name = calleeName(value.callee);
			if (!PURE_CALLEES.has(name)) reason = name ?? value.callee.type;
		}
		if (
			[
				"AssignmentExpression",
				"UpdateExpression",
				"AwaitExpression",
				"TaggedTemplateExpression",
				"YieldExpression",
			].includes(value.type)
		)
			reason = value.type;
		for (const [key, child] of Object.entries(value)) {
			if (!["type", "start", "end", "range", "loc"].includes(key)) walk(child);
		}
	};
	walk(node);
	return reason;
}

function effectful(statement) {
	const declaration =
		statement.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
	if (
		!declaration ||
		["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type)
	)
		return false;
	if (declaration.type === "ExpressionStatement") return true;
	if (declaration.type !== "VariableDeclaration") return false;
	return declaration.declarations.some((item) => impure(item.init));
}

function expectedTargets(source, expectPath) {
	if (!expectPath) return null;
	const manifest = JSON.parse(readFileSync(expectPath, "utf8"));
	const entry = manifest.sources?.[source] ?? manifest[source] ?? manifest;
	const targets = entry.targets ?? entry;
	if (Array.isArray(targets)) return targets;
	if (!targets || typeof targets !== "object") {
		throw new Error(`${expectPath}: expected targets for ${source}`);
	}
	return Object.keys(targets);
}

function resolveSpecifier(from, specifier, candidates) {
	if (!specifier?.startsWith(".")) return null;
	const absolute = resolve(dirname(from), specifier);
	for (const candidate of candidates) {
		if (resolve(candidate) === absolute) return candidate;
	}
	for (const suffix of [".mjs", ".js", "/index.mjs", "/index.js"]) {
		for (const candidate of candidates) {
			if (resolve(candidate) === `${absolute}${suffix}`) return candidate;
		}
	}
	return null;
}

function inferredTargets(source, facade) {
	const targets = new Set();
	const todo = [{ path: source, program: facade }];
	while (todo.length) {
		const current = todo.pop();
		for (const statement of current.program.body) {
			const specifier = importSource(statement);
			if (!specifier?.startsWith(".")) continue;
			const path = resolve(dirname(current.path), specifier);
			const candidates = [
				path,
				`${path}.mjs`,
				`${path}.js`,
				resolve(path, "index.mjs"),
			];
			const found = candidates.find((candidate) => existsSync(candidate));
			if (!found || found === resolve(source) || targets.has(found)) continue;
			targets.add(found);
			todo.push({
				path: found,
				program: parse(found, readFileSync(found, "utf8")),
			});
		}
	}
	return [...targets];
}

function checkModule(options) {
	const errors = [];
	const sourcePath = resolve(options.source);
	const baseText = execFileSync(
		"git",
		["show", `${options.base}:${options.source}`],
		{
			encoding: "utf8",
		},
	);
	const base = parse(options.source, baseText);
	const facadeText = readFileSync(sourcePath, "utf8");
	const facade = parse(options.source, facadeText);
	const configured = expectedTargets(options.source, options.expect);
	const targetPaths = (configured ?? inferredTargets(sourcePath, facade)).map(
		(path) => resolve(path),
	);
	const files = new Map([
		[sourcePath, { path: sourcePath, text: facadeText, program: facade }],
	]);
	for (const path of targetPaths) {
		if (!existsSync(path)) {
			fail(errors, `missing target: ${relative(process.cwd(), path)}`);
			continue;
		}
		files.set(path, {
			path,
			text: readFileSync(path, "utf8"),
			program: parse(path, readFileSync(path, "utf8")),
		});
	}
	const baseStatements = base.body.map((statement, index) => ({
		index,
		text: statementText(baseText, statement),
		effectful: effectful(statement),
	}));
	const remaining = new Map();
	for (const item of baseStatements) {
		const list = remaining.get(item.text) ?? [];
		list.push(item.index);
		remaining.set(item.text, list);
	}
	const carriedByFile = new Map();
	for (const [path, file] of files) {
		const carried = [];
		for (const statement of file.program.body) {
			const text = statementText(file.text, statement);
			const occurrences = remaining.get(text);
			if (occurrences?.length) carried.push(occurrences.shift());
			else if (!allowedAddedSyntax(statement)) {
				fail(
					errors,
					`${relative(process.cwd(), path)}: added non-carried declaration`,
				);
			}
			if (statement.type === "ExportAllDeclaration")
				fail(
					errors,
					`${relative(process.cwd(), path)}: export * is not allowed`,
				);
		}
		carriedByFile.set(path, carried);
		if (
			carried.some((value, index) => index > 0 && value < carried[index - 1])
		) {
			fail(
				errors,
				`${relative(process.cwd(), path)}: carried statements are out of source order`,
			);
		}
	}
	for (const item of baseStatements) {
		if ((remaining.get(item.text) ?? []).includes(item.index))
			fail(errors, `dropped statement ${item.index + 1}`);
	}
	for (const [text, indexes] of remaining) {
		if (indexes.length === 0) continue;
		if (!baseStatements.some((item) => item.text === text))
			fail(errors, "internal statement accounting failure");
	}
	const baseExports = exportsOf(base);
	const facadeExports = exportsOf(facade);
	if (!sameArray(baseExports, facadeExports))
		fail(errors, "façade export surface changed");
	const root = dirname(sourcePath);
	for (const [path, file] of files) {
		if (path === sourcePath) continue;
		for (const statement of file.program.body) {
			const specifier = importSource(statement);
			if (!specifier?.startsWith(".")) continue;
			const imported = resolve(dirname(path), specifier);
			if (
				relative(root, imported).startsWith(`..${sep}`) ||
				imported === resolve(root, "..")
			) {
				fail(
					errors,
					`${relative(process.cwd(), path)}: target imports outside ${relative(process.cwd(), root)}`,
				);
			}
		}
	}
	const graph = new Map();
	for (const [path, file] of files) {
		graph.set(
			path,
			file.program.body
				.filter((statement) => statement.type === "ImportDeclaration")
				.map((statement) =>
					resolveSpecifier(path, statement.source.value, [...files.keys()]),
				)
				.filter(Boolean),
		);
	}
	const seen = new Set();
	const active = new Set();
	const evaluation = [];
	const walk = (path) => {
		if (active.has(path)) {
			fail(errors, `import cycle includes ${relative(process.cwd(), path)}`);
			return;
		}
		if (seen.has(path)) return;
		seen.add(path);
		active.add(path);
		for (const child of graph.get(path) ?? []) walk(child);
		active.delete(path);
		evaluation.push(path);
	};
	walk(sourcePath);
	for (const target of targetPaths) {
		if (!seen.has(target))
			fail(errors, `unreachable target: ${relative(process.cwd(), target)}`);
	}
	const orderedEffects = [];
	for (const path of evaluation) {
		for (const index of carriedByFile.get(path) ?? []) {
			if (baseStatements[index].effectful) orderedEffects.push(index);
		}
	}
	if (
		orderedEffects.some(
			(value, index) => index > 0 && value < orderedEffects[index - 1],
		)
	) {
		fail(errors, "effectful statements are out of static ESM evaluation order");
	}
	return errors;
}

try {
	const errors = checkModule(argumentsFrom(process.argv.slice(2)));
	if (errors.length) {
		for (const error of errors) console.error(`seam-move: ${error}`);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`seam-move: ${error.message}`);
	process.exitCode = 1;
}
