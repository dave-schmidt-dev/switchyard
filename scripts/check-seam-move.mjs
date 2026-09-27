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
		"usage: check-seam-move.mjs --mode module --base <ref> --source <path> [--expect <manifest.json>] | --mode test --base <ref> --source <test file> --parts <paths> [--fixture <path>]",
	);
}

function argumentsFrom(argv) {
	const options = {
		expect: null,
		fixture: null,
		mode: null,
		base: null,
		parts: null,
		source: null,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (
			![
				"--mode",
				"--base",
				"--source",
				"--expect",
				"--parts",
				"--fixture",
			].includes(arg)
		)
			usage();
		const value = argv[++index];
		if (!value) usage();
		options[arg.slice(2)] = value;
	}
	if (
		!["module", "test"].includes(options.mode) ||
		!options.base ||
		!options.source
	)
		usage();
	if (options.mode === "module" && (options.parts || options.fixture)) usage();
	if (options.mode === "test" && (!options.parts || options.expect)) usage();
	const paths = [options.source, options.fixture].filter(Boolean);
	if (options.parts) {
		options.parts = options.parts.split(",").filter(Boolean);
		if (options.parts.length === 0) usage();
		paths.push(...options.parts);
	}
	for (const path of paths) {
		if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
			throw new Error("paths must be repository-relative");
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

function callName(statement) {
	if (statement?.type !== "ExpressionStatement") return null;
	const expression = statement.expression;
	if (expression?.type !== "CallExpression") return null;
	if (expression.callee.type === "Identifier") return expression.callee.name;
	if (
		expression.callee.type === "MemberExpression" &&
		expression.callee.object.type === "Identifier"
	)
		return expression.callee.object.name;
	return null;
}

function callbackBody(statement) {
	const callback = statement.expression.arguments?.[1];
	return callback?.body?.type === "BlockStatement" ? callback.body.body : [];
}

function titleOf(statement, text) {
	const title = statement.expression.arguments?.[0];
	if (typeof title?.value === "string") return title.value;
	if (title?.type === "TemplateLiteral" && title.expressions.length === 0)
		return title.quasis[0]?.value.cooked ?? title.quasis[0]?.value.raw;
	return title ? statementText(text, title) : null;
}

function testStructure(program, text) {
	const entries = [];
	const visit = (body) => {
		for (const statement of body) {
			if (statement.type === "ImportDeclaration") continue;
			const name = callName(statement);
			const entry = {
				kind: ["it", "test"].includes(name)
					? "test"
					: name === "describe"
						? "describe"
						: "non-test",
				text: statementText(text, statement),
			};
			if (entry.kind === "describe") entry.title = titleOf(statement, text);
			entries.push(entry);
			if (entry.kind === "describe") visit(callbackBody(statement));
		}
	};
	visit(program.body);
	return entries;
}

function multiset(values) {
	const counts = new Map();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function sameMultiset(left, right) {
	if (left.size !== right.size) return false;
	for (const [value, count] of left) {
		if (right.get(value) !== count) return false;
	}
	return true;
}

function indexBy(entries, key) {
	const indexes = new Map();
	for (const [index, entry] of entries.entries()) {
		const value = entry[key];
		const values = indexes.get(value) ?? [];
		values.push(index);
		indexes.set(value, values);
	}
	return indexes;
}

function carriedOrder(entries, baseEntries) {
	const byText = indexBy(baseEntries, "text");
	const describeByTitle = new Map();
	for (const [index, entry] of baseEntries.entries()) {
		if (entry.kind !== "describe") continue;
		const indexes = describeByTitle.get(entry.title) ?? [];
		indexes.push(index);
		describeByTitle.set(entry.title, indexes);
	}
	let previous = -1;
	for (const entry of entries) {
		const candidates =
			entry.kind === "describe"
				? describeByTitle.get(entry.title)
				: byText.get(entry.text);
		if (!candidates) return false;
		const index = candidates.find((candidate) => candidate >= previous);
		if (index === undefined) return false;
		previous = index;
	}
	return true;
}

function fixtureImportsAreExported(file, fixturePath, fixtureExports, errors) {
	for (const statement of file.program.body) {
		if (statement.type !== "ImportDeclaration") continue;
		if (
			resolveSpecifier(file.path, statement.source.value, [fixturePath]) !==
			fixturePath
		)
			continue;
		for (const specifier of statement.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") {
				fail(
					errors,
					`${relative(process.cwd(), file.path)}: fixture namespace import is not allowed`,
				);
				continue;
			}
			const imported =
				specifier.type === "ImportDefaultSpecifier"
					? "default"
					: (specifier.imported.name ?? specifier.imported.value);
			if (!fixtureExports.has(imported))
				fail(
					errors,
					`${relative(process.cwd(), file.path)}: fixture import ${imported} is not exported`,
				);
		}
	}
}

function isDirnameDeclaration(statement) {
	return (
		statement.type === "VariableDeclaration" &&
		statement.declarations.some((item) => item.id?.name === "__dirname")
	);
}

function allowedDirnameRebase(baseText, fixtureText) {
	const rewrites = [
		[
			'resolve(fileURLToPath(import.meta.url), "..")',
			'resolve(fileURLToPath(import.meta.url), "..", "..")',
		],
		[
			'fileURLToPath(new URL(".", import.meta.url))',
			'fileURLToPath(new URL("..", import.meta.url))',
		],
	];
	return rewrites.some(
		([from, to]) =>
			baseText.includes(from) && baseText.replace(from, to) === fixtureText,
	);
}

function checkFixturePins(options, base, fixture, errors) {
	if (
		!options.fixture ||
		!/^tests\/helpers\/[^/]+-fixtures\.mjs$/u.test(options.fixture)
	)
		return;
	for (const statement of fixture.program.body) {
		const text = statementText(fixture.text, statement);
		if (!text.includes("import.meta") && !text.includes("__filename")) continue;
		const rebased = base.program.body.some(
			(baseStatement) =>
				isDirnameDeclaration(baseStatement) &&
				isDirnameDeclaration(statement) &&
				allowedDirnameRebase(statementText(base.text, baseStatement), text),
		);
		if (!rebased)
			fail(
				errors,
				`${options.fixture}: fixture pin must be a sanctioned __dirname rebase`,
			);
	}
}

function checkTest(options) {
	const errors = [];
	const sourcePath = resolve(options.source);
	const baseText = execFileSync(
		"git",
		["show", `${options.base}:${options.source}`],
		{
			encoding: "utf8",
		},
	);
	const base = { text: baseText, program: parse(options.source, baseText) };
	const paths = [sourcePath, ...options.parts.map((path) => resolve(path))];
	const files = [];
	for (const path of paths) {
		if (!existsSync(path)) {
			fail(errors, `missing test part: ${relative(process.cwd(), path)}`);
			continue;
		}
		const text = readFileSync(path, "utf8");
		files.push({ path, text, program: parse(path, text) });
	}
	const baseEntries = testStructure(base.program, base.text);
	const partEntries = files.map((file) => ({
		file,
		entries: testStructure(file.program, file.text),
	}));
	const baseTests = baseEntries.filter((entry) => entry.kind === "test");
	const outputTests = partEntries.flatMap(({ entries }) =>
		entries.filter((entry) => entry.kind === "test"),
	);
	if (
		!sameMultiset(
			multiset(baseTests.map((entry) => entry.text)),
			multiset(outputTests.map((entry) => entry.text)),
		)
	)
		fail(errors, "it/test calls do not match the base multiset");
	const baseTitles = new Set(
		baseEntries
			.filter((entry) => entry.kind === "describe")
			.map((entry) => entry.title),
	);
	for (const { file, entries } of partEntries) {
		for (const entry of entries.filter((item) => item.kind === "describe")) {
			if (!baseTitles.has(entry.title))
				fail(
					errors,
					`${relative(process.cwd(), file.path)}: describe title differs from base`,
				);
		}
		for (const entry of entries.filter((item) => item.kind === "non-test")) {
			if (!baseEntries.some((baseEntry) => baseEntry.text === entry.text))
				fail(
					errors,
					`${relative(process.cwd(), file.path)}: repeated non-test statement differs from base`,
				);
		}
		if (!carriedOrder(entries, baseEntries))
			fail(
				errors,
				`${relative(process.cwd(), file.path)}: carried statements are out of source order`,
			);
	}
	if (options.fixture) {
		const fixturePath = resolve(options.fixture);
		if (!existsSync(fixturePath))
			fail(errors, `missing fixture: ${options.fixture}`);
		else {
			const text = readFileSync(fixturePath, "utf8");
			const fixture = {
				path: fixturePath,
				text,
				program: parse(fixturePath, text),
			};
			const fixtureExports = new Set(exportsOf(fixture.program));
			for (const file of files)
				fixtureImportsAreExported(file, fixturePath, fixtureExports, errors);
			checkFixturePins(options, base, fixture, errors);
		}
	}
	return errors;
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
	const baseImportSources = new Set(
		base.body
			.filter((statement) => statement.type === "ImportDeclaration")
			.map((statement) => statement.source.value),
	);
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
				!baseImportSources.has(specifier) &&
				(relative(root, imported).startsWith(`..${sep}`) ||
					imported === resolve(root, ".."))
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
	const options = argumentsFrom(process.argv.slice(2));
	const errors =
		options.mode === "module" ? checkModule(options) : checkTest(options);
	if (errors.length) {
		for (const error of errors) console.error(`seam-move: ${error}`);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`seam-move: ${error.message}`);
	process.exitCode = 1;
}
