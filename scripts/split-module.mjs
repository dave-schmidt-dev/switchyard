import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

function fail(message) {
	throw new Error(`split-module: ${message}`);
}
function usage() {
	fail(
		"usage: split-module.mjs [--mode module|test] --source <path> --spec <json-or-path>",
	);
}
function optionsFrom(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index];
		if (!["--mode", "--source", "--spec"].includes(option) || options[option])
			usage();
		const value = argv[++index];
		if (!value) usage();
		options[option] = value;
	}
	const mode = options["--mode"] ?? "module";
	if (
		!options["--source"] ||
		!options["--spec"] ||
		!["module", "test"].includes(mode)
	)
		usage();
	return {
		mode,
		source: options["--source"],
		spec: options["--spec"],
	};
}
function readSpec(value) {
	try {
		return JSON.parse(value);
	} catch {
		try {
			return JSON.parse(readFileSync(value, "utf8"));
		} catch (error) {
			fail(`cannot read --spec ${value}: ${error.message}`);
		}
	}
}
function parse(path, text) {
	const result = parseSync(path, text, { sourceType: "module" });
	if (result.errors.length) fail(`${path}: ${result.errors[0].message}`);
	return result.program;
}
function namesInPattern(pattern, names = []) {
	if (!pattern) return names;
	if (pattern.type === "Identifier") names.push(pattern.name);
	else if (pattern.type === "RestElement")
		namesInPattern(pattern.argument, names);
	else if (pattern.type === "AssignmentPattern")
		namesInPattern(pattern.left, names);
	else if (pattern.type === "ArrayPattern")
		for (const element of pattern.elements) namesInPattern(element, names);
	else if (pattern.type === "ObjectPattern")
		for (const property of pattern.properties)
			namesInPattern(property.value ?? property.argument, names);
	return names;
}
function declarationNames(statement) {
	const declaration =
		statement.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
	if (!declaration) return [];
	if (["FunctionDeclaration", "ClassDeclaration"].includes(declaration.type))
		return declaration.id ? [declaration.id.name] : [];
	if (declaration.type === "VariableDeclaration")
		return declaration.declarations.flatMap((item) => namesInPattern(item.id));
	if (statement.type === "ExportDefaultDeclaration") {
		const local = statement.declaration?.id?.name;
		return local ? ["default", local] : ["default"];
	}
	return [];
}
function exportedNames(statement) {
	if (statement.type === "ExportDefaultDeclaration") return ["default"];
	if (statement.type !== "ExportNamedDeclaration") return [];
	if (statement.declaration) return declarationNames(statement);
	return statement.specifiers.map(
		(specifier) => specifier.exported?.name ?? specifier.exported?.value,
	);
}
function importBindings(statement) {
	return statement.specifiers.map((specifier) => ({
		local: specifier.local.name,
		type: specifier.type,
		imported:
			specifier.type === "ImportSpecifier"
				? (specifier.imported.name ?? specifier.imported.value)
				: null,
	}));
}
function childKeys(node) {
	return Object.keys(node).filter(
		(key) => !["type", "start", "end", "range", "loc"].includes(key),
	);
}
function references(node, available) {
	const found = new Set();
	const visit = (value, locals = new Set()) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, locals);
			return;
		}
		if (value.type === "Identifier") {
			if (available.has(value.name) && !locals.has(value.name))
				found.add(value.name);
			return;
		}
		if (
			["ImportDeclaration", "ExportAllDeclaration"].includes(value.type) ||
			(value.type === "ExportNamedDeclaration" && !value.declaration)
		)
			return;
		if (
			[
				"FunctionDeclaration",
				"FunctionExpression",
				"ArrowFunctionExpression",
			].includes(value.type)
		) {
			const nested = new Set(locals);
			if (value.id) nested.add(value.id.name);
			for (const parameter of value.params ?? [])
				namesInPattern(parameter, []).forEach((name) => {
					nested.add(name);
				});
			for (const parameter of value.params ?? []) {
				if (parameter.type === "AssignmentPattern")
					visit(parameter.right, locals);
			}
			visit(value.body, nested);
			return;
		}
		if (["ClassDeclaration", "ClassExpression"].includes(value.type)) {
			visit(value.superClass, locals);
			const nested = new Set(locals);
			if (value.id) nested.add(value.id.name);
			visit(value.body, nested);
			return;
		}
		if (value.type === "BlockStatement") {
			const nested = new Set(locals);
			for (const statement of value.body) {
				if (statement.type === "VariableDeclaration") {
					for (const declaration of statement.declarations)
						for (const name of namesInPattern(declaration.id, []))
							nested.add(name);
				} else if (
					["FunctionDeclaration", "ClassDeclaration"].includes(
						statement.type,
					) &&
					statement.id
				)
					nested.add(statement.id.name);
			}
			for (const statement of value.body) visit(statement, nested);
			return;
		}
		if (value.type === "CatchClause") {
			const nested = new Set(locals);
			for (const name of namesInPattern(value.param, [])) nested.add(name);
			visit(value.body, nested);
			return;
		}
		if (value.type === "VariableDeclaration") {
			const nested = new Set(locals);
			for (const item of value.declarations)
				namesInPattern(item.id, []).forEach((name) => {
					nested.add(name);
				});
			for (const item of value.declarations) visit(item.init, nested);
			return;
		}
		if (value.type === "MemberExpression") {
			visit(value.object, locals);
			if (value.computed) visit(value.property, locals);
			return;
		}
		if (value.type === "Property" || value.type === "ObjectProperty") {
			if (value.computed) visit(value.key, locals);
			visit(value.value, locals);
			return;
		}
		if (
			value.type === "MethodDefinition" ||
			value.type === "PropertyDefinition"
		) {
			if (value.computed) visit(value.key, locals);
			visit(value.value, locals);
			return;
		}
		if (
			value.type === "LabeledStatement" ||
			value.type === "BreakStatement" ||
			value.type === "ContinueStatement"
		) {
			visit(value.body, locals);
			return;
		}
		for (const key of childKeys(value)) visit(value[key], locals);
	};
	visit(node);
	return found;
}
function directLetWrites(statement, letNames) {
	const writes = new Set();
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) return value.forEach(visit);
		if (
			[
				"FunctionDeclaration",
				"FunctionExpression",
				"ArrowFunctionExpression",
				"ClassDeclaration",
				"ClassExpression",
			].includes(value.type)
		)
			return;
		if (value.type === "AssignmentExpression")
			namesInPattern(value.left, []).forEach((name) => {
				if (letNames.has(name)) writes.add(name);
			});
		if (
			value.type === "UpdateExpression" &&
			value.argument?.type === "Identifier" &&
			letNames.has(value.argument.name)
		)
			writes.add(value.argument.name);
		for (const key of childKeys(value)) visit(value[key]);
	};
	visit(statement);
	return writes;
}
function statementText(source, statement) {
	return source.slice(statement.start, statement.end);
}
function siblingSpecifier(from, to) {
	let specifier = relative(dirname(from), to).split(sep).join("/");
	if (!specifier.startsWith(".")) specifier = `./${specifier}`;
	return specifier;
}
function renderedImport(specifier, bindings) {
	const defaults = bindings.filter(
		(item) => item.type === "ImportDefaultSpecifier",
	);
	const namespaces = bindings.filter(
		(item) => item.type === "ImportNamespaceSpecifier",
	);
	const named = bindings.filter((item) => item.type === "ImportSpecifier");
	const pieces = [];
	if (defaults.length) pieces.push(defaults[0].local);
	if (namespaces.length) pieces.push(`* as ${namespaces[0].local}`);
	if (named.length)
		pieces.push(
			`{ ${named
				.map((item) =>
					item.imported === item.local
						? item.imported
						: `${item.imported} as ${item.local}`,
				)
				.join(", ")} }`,
		);
	return `import ${pieces.join(", ")} from ${specifier};`;
}
function validNames(names) {
	return (
		Array.isArray(names) && names.every((name) => typeof name === "string")
	);
}
function targetEntry(spec, source) {
	const entry = spec.sources?.[source] ?? spec[source] ?? spec;
	if (!entry || typeof entry !== "object") fail("spec has no source entry");
	const rawTargets = entry.targets;
	if (!rawTargets || typeof rawTargets !== "object")
		fail("spec has no targets");
	const targets = new Map();
	for (const [path, raw] of Object.entries(rawTargets)) {
		const names = Array.isArray(raw) ? raw : raw?.names;
		if (!validNames(names)) fail(`target ${path} needs a names array`);
		targets.set(path, new Set(names));
	}
	const keeps = new Set(entry.facade?.keeps ?? []);
	if (![...keeps].every((name) => typeof name === "string"))
		fail("facade.keeps must be strings");
	return { targets, keeps };
}

function callName(statement) {
	if (statement?.type !== "ExpressionStatement") return null;
	const callee = statement.expression?.callee;
	if (statement.expression?.type !== "CallExpression") return null;
	if (callee.type === "Identifier") return callee.name;
	if (callee.type === "MemberExpression" && callee.object.type === "Identifier")
		return callee.object.name;
	return null;
}
function callTitle(statement, _text) {
	const value = statement.expression?.arguments?.[0];
	if (typeof value?.value === "string") return value.value;
	if (value?.type === "TemplateLiteral" && value.expressions.length === 0)
		return value.quasis[0]?.value.cooked ?? value.quasis[0]?.value.raw;
	return null;
}
function callbackBody(statement) {
	const body = statement.expression?.arguments?.[1]?.body;
	return body?.type === "BlockStatement" ? body : null;
}
function testKind(statement) {
	const declaration =
		statement?.type === "ExportNamedDeclaration"
			? statement.declaration
			: statement;
	if (
		["FunctionDeclaration", "ClassDeclaration", "VariableDeclaration"].includes(
			declaration?.type,
		)
	)
		return "declaration";
	const name = callName(statement);
	if (name === "describe" || name === "suite") return "describe";
	if (name === "it" || name === "test") return "test";
	if (/^(before|after)(Each|All)?$/u.test(name ?? "")) return "hook";
	return "other";
}
function testEntry(spec, source) {
	const entry = spec.tests?.[source] ?? spec[source] ?? spec;
	if (!entry || typeof entry !== "object") fail("spec has no test entry");
	if (!Array.isArray(entry.parts) || entry.parts.length === 0)
		fail("test spec needs parts");
	const fixture = entry.fixture ?? null;
	if (typeof fixture !== "object" || Array.isArray(fixture))
		fail("fixture must be an object");
	const fixtureNames = fixture?.names ?? [];
	if (!validNames(fixtureNames)) fail("fixture.names must be strings");
	const fixturePath = fixture?.path ?? fixture?.file ?? fixture?.target ?? null;
	if (fixtureNames.length && typeof fixturePath !== "string")
		fail("fixture.names needs fixture.path");
	const parts = entry.parts.map((part, index) => {
		const path = part?.path ?? part?.file ?? part?.target;
		if (typeof path !== "string" || !Array.isArray(part.items))
			fail(`part ${index + 1} needs path and items`);
		return { path, items: part.items };
	});
	const perPartState = entry.perPartState ?? [];
	const stateNames = Array.isArray(perPartState)
		? perPartState
		: (perPartState.names ?? []);
	if (!validNames(stateNames)) fail("perPartState must be names or { names }");
	return {
		parts,
		fixturePath,
		fixtureNames: new Set(fixtureNames),
		stateNames: new Set(stateNames),
	};
}
function normalizedItem(item) {
	if (typeof item === "string")
		return { title: item, tests: null, scoped: false };
	if (!item || typeof item !== "object")
		fail("part items must be describe titles");
	const title = item.title ?? item.describe ?? item.name;
	if (typeof title !== "string") fail("part item needs a describe title");
	if (item.tests !== undefined && !validNames(item.tests))
		fail(`describe ${title} tests must be strings`);
	return { title, tests: item.tests ?? null, scoped: item.scoped === true };
}
function importsForStatements(statements, imports, extraNames = new Set()) {
	const names = new Set(extraNames);
	for (const statement of statements)
		for (const name of references(statement, new Set(imports.keys())))
			names.add(name);
	const grouped = new Map();
	for (const name of names) {
		const record = imports.get(name);
		if (!record) continue;
		const bindings = grouped.get(record.statement) ?? [];
		bindings.push(record.binding);
		grouped.set(record.statement, bindings);
	}
	return [...grouped].map(([statement, bindings]) =>
		renderedImport(statement.source.raw, bindings),
	);
}
function validateOutputPath(path, label) {
	if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
		fail(`${label} path is invalid: ${path}`);
}
function writeOutput(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}
function splitDescribe(text, statement, item) {
	if (!item.tests) return statementText(text, statement);
	const body = callbackBody(statement);
	if (!body) fail(`describe ${item.title} has no block callback`);
	const wanted = new Set(item.tests);
	const children = body.body.filter((child) => {
		const kind = testKind(child);
		if (kind === "test") return wanted.has(callTitle(child, text));
		return item.scoped && kind !== "test";
	});
	for (const title of wanted) {
		if (
			!body.body.some(
				(child) =>
					testKind(child) === "test" && callTitle(child, text) === title,
			)
		)
			fail(`describe ${item.title} has no test ${title}`);
	}
	const prefix = text.slice(statement.start, body.start + 1);
	const suffix = text.slice(body.end - 1, statement.end);
	return `${prefix}\n${children.map((child) => statementText(text, child)).join("\n")}\n${suffix}`;
}
function splitTests({ source, spec }) {
	if (source.startsWith("/") || source.split(/[\\/]/).includes(".."))
		fail("source must be repository-relative");
	const text = readFileSync(source, "utf8");
	const program = parse(source, text);
	const config = testEntry(spec, source);
	for (const part of config.parts) validateOutputPath(part.path, "part");
	if (config.fixturePath) validateOutputPath(config.fixturePath, "fixture");
	const imports = new Map();
	for (const statement of program.body.filter(
		(item) => item.type === "ImportDeclaration",
	))
		for (const binding of importBindings(statement))
			imports.set(binding.local, { statement, binding });
	const top = program.body.filter(
		(statement) => statement.type !== "ImportDeclaration",
	);
	const byName = new Map();
	const lets = new Set();
	for (const statement of top) {
		const names = declarationNames(statement);
		for (const name of names) byName.set(name, statement);
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? statement.declaration
				: statement;
		if (
			declaration?.type === "VariableDeclaration" &&
			declaration.kind === "let"
		)
			for (const name of names) lets.add(name);
	}
	const available = new Set(byName.keys());
	const refsOf = (statement) => [...references(statement, available)];
	const state = new Set(
		top.filter((statement) => {
			const kind = testKind(statement);
			return (
				kind === "hook" ||
				kind === "other" ||
				declarationNames(statement).some(
					(name) => lets.has(name) || config.stateNames.has(name),
				)
			);
		}),
	);
	let grew = true;
	while (grew) {
		grew = false;
		for (const statement of top) {
			if (state.has(statement) || !declarationNames(statement).length) continue;
			if (refsOf(statement).some((name) => state.has(byName.get(name)))) {
				state.add(statement);
				grew = true;
			}
		}
	}
	const describes = new Map();
	for (const statement of top)
		if (["describe", "test"].includes(testKind(statement)))
			describes.set(callTitle(statement, text), statement);
	const fixtureStatements = new Set();
	for (const name of config.fixtureNames) {
		const statement = byName.get(name);
		if (!statement) fail(`fixture name ${name} is not a top-level declaration`);
		fixtureStatements.add(statement);
	}
	let fixtureGrew = true;
	while (fixtureGrew) {
		fixtureGrew = false;
		for (const statement of [...fixtureStatements])
			for (const name of refsOf(statement)) {
				const dependency = byName.get(name);
				if (
					dependency &&
					!fixtureStatements.has(dependency) &&
					!state.has(dependency)
				) {
					fixtureStatements.add(dependency);
					fixtureGrew = true;
				}
			}
	}
	const picked = new Map();
	for (const part of config.parts) {
		const selected = [];
		const selectedStatements = new Set();
		for (const rawItem of part.items) {
			const item = normalizedItem(rawItem);
			const statement = describes.get(item.title);
			if (!statement)
				fail(`part ${part.path} has no top-level describe ${item.title}`);
			if (selectedStatements.has(statement))
				fail(`part ${part.path} repeats ${item.title}`);
			selectedStatements.add(statement);
			if (!picked.has(statement) || item.tests === null)
				picked.set(statement, item.tests ? new Set(item.tests) : null);
			else for (const name of item.tests) picked.get(statement)?.add(name);
			selected.push({ statement, text: splitDescribe(text, statement, item) });
		}
		const needed = new Set(state);
		const roots = selected.map(({ statement }) => statement);
		let expanded = true;
		while (expanded) {
			expanded = false;
			for (const statement of [...roots, ...needed])
				for (const name of refsOf(statement)) {
					const dependency = byName.get(name);
					if (
						dependency &&
						!fixtureStatements.has(dependency) &&
						!needed.has(dependency) &&
						declarationNames(dependency).length
					) {
						needed.add(dependency);
						expanded = true;
					}
				}
		}
		const chunks = [
			...top
				.filter(
					(statement) =>
						needed.has(statement) && !fixtureStatements.has(statement),
				)
				.map((statement) => ({
					statement,
					text: statementText(text, statement),
				})),
			...selected,
		].sort((left, right) => left.statement.start - right.statement.start);
		const fixtureNamesUsed = new Set();
		for (const chunk of chunks)
			for (const name of refsOf(chunk.statement))
				if (config.fixtureNames.has(name)) fixtureNamesUsed.add(name);
		const fixtureImport =
			config.fixturePath && fixtureNamesUsed.size
				? `import { ${[...fixtureNamesUsed].join(", ")} } from ${JSON.stringify(siblingSpecifier(part.path, config.fixturePath))};`
				: null;
		const importStatements = chunks.map((chunk) => chunk.statement);
		const output = [
			...importsForStatements(importStatements, imports),
			fixtureImport,
			...chunks.map((chunk) => chunk.text),
		]
			.filter(Boolean)
			.join("\n");
		writeOutput(part.path, `${output}\n`);
	}
	if (config.fixturePath) {
		const fixtureOutput = [
			...importsForStatements([...fixtureStatements], imports),
			...top
				.filter((statement) => fixtureStatements.has(statement))
				.map((statement) => statementText(text, statement)),
			config.fixtureNames.size
				? `export { ${[...config.fixtureNames].join(", ")} };`
				: null,
		]
			.filter(Boolean)
			.join("\n");
		writeOutput(config.fixturePath, `${fixtureOutput}\n`);
	}
	const retained = top.flatMap((statement) => {
		if (!picked.has(statement)) return [statementText(text, statement)];
		const names = picked.get(statement);
		if (names === null) return [];
		const body = callbackBody(statement);
		const children = body.body.filter(
			(child) =>
				testKind(child) !== "test" || !names.has(callTitle(child, text)),
		);
		if (!children.some((child) => testKind(child) === "test")) return [];
		return [
			`${text.slice(statement.start, body.start + 1)}\n${children.map((child) => statementText(text, child)).join("\n")}\n${text.slice(body.end - 1, statement.end)}`,
		];
	});
	const hasTests = top.some((statement) => {
		if (!["describe", "test"].includes(testKind(statement))) return false;
		if (!picked.has(statement)) return true;
		const names = picked.get(statement);
		return (
			names !== null &&
			callbackBody(statement)?.body.some(
				(child) =>
					testKind(child) === "test" && !names.has(callTitle(child, text)),
			)
		);
	});
	const originalImports = program.body
		.filter((statement) => statement.type === "ImportDeclaration")
		.map((statement) => statementText(text, statement));
	writeOutput(
		source,
		hasTests ? `${[...originalImports, ...retained].join("\n")}\n` : "",
	);
}
function split({ source, spec }) {
	if (source.startsWith("/") || source.split(/[\\/]/).includes(".."))
		fail("source must be repository-relative");
	const text = readFileSync(source, "utf8");
	const program = parse(source, text);
	const { targets: targetNames, keeps } = targetEntry(spec, source);
	const sourcePath = resolve(source);
	const targets = new Map();
	for (const [path, names] of targetNames) {
		if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
			fail(`target path is invalid: ${path}`);
		const absolute = resolve(path);
		if (absolute === sourcePath) fail("target cannot be the source");
		targets.set(absolute, {
			path,
			names,
			statements: [],
			localNames: new Set(),
			exports: new Set(),
		});
	}
	const imports = program.body.filter(
		(statement) => statement.type === "ImportDeclaration",
	);
	const importNames = new Map(
		imports.flatMap((statement) =>
			importBindings(statement).map((binding) => [
				binding.local,
				{ statement, binding },
			]),
		),
	);
	const topStatements = program.body.filter(
		(statement) => statement.type !== "ImportDeclaration",
	);
	const homes = new Map();
	const lets = new Set();
	for (const statement of topStatements) {
		const names = declarationNames(statement);
		const declaration =
			statement.type === "ExportNamedDeclaration"
				? statement.declaration
				: statement;
		if (
			declaration?.type === "VariableDeclaration" &&
			declaration.kind === "let"
		)
			names.forEach((name) => {
				lets.add(name);
			});
		const chosen = new Set();
		for (const name of names)
			for (const [path, target] of targets)
				if (target.names.has(name)) chosen.add(path);
		if (chosen.size > 1)
			fail(`statement ${names.join(", ")} spans multiple targets`);
		const target =
			names.length &&
			!names.some((name) => keeps.has(name)) &&
			chosen.size === 1 &&
			names.every((name) => targets.get([...chosen][0]).names.has(name))
				? [...chosen][0]
				: null;
		for (const name of names) homes.set(name, target ?? sourcePath);
		statement._split = { names, target, writes: new Set() };
	}
	for (const statement of topStatements) {
		const writes = directLetWrites(statement, lets);
		statement._split.writes = writes;
		if (statement._split.target || !writes.size) continue;
		const destinations = new Set(
			[...writes].map((name) => homes.get(name)).filter(Boolean),
		);
		if (destinations.size > 1)
			fail(`let writer spans multiple targets: ${[...writes].join(", ")}`);
		if (destinations.size === 1) statement._split.target = [...destinations][0];
	}
	const facade = [];
	for (const statement of program.body) {
		if (statement.type === "ImportDeclaration") {
			facade.push(statementText(text, statement));
			continue;
		}
		const target = statement._split.target;
		if (!target) facade.push(statementText(text, statement));
		else {
			const output = targets.get(target);
			output.statements.push(statement);
			for (const name of statement._split.names) output.localNames.add(name);
			for (const name of exportedNames(statement)) output.exports.add(name);
		}
	}
	const allNames = new Set([...homes.keys(), ...importNames.keys()]);
	const needs = new Map(
		[...targets.keys(), sourcePath].map((path) => [path, new Set()]),
	);
	for (const [path, target] of targets)
		for (const statement of target.statements)
			for (const name of references(statement, allNames))
				needs.get(path).add(name);
	for (const statement of topStatements.filter((item) => !item._split.target))
		for (const name of references(statement, allNames))
			needs.get(sourcePath).add(name);
	const dependencyLines = new Map();
	const importsFor = (path) => {
		const bySource = new Map();
		const siblings = new Map();
		for (const name of needs.get(path)) {
			if (importNames.has(name)) {
				const { statement, binding } = importNames.get(name);
				const list = bySource.get(statement) ?? [];
				list.push(binding);
				bySource.set(statement, list);
				continue;
			}
			const home = homes.get(name);
			if (!home || home === path) continue;
			if (home === sourcePath)
				fail(
					`target ${relative(process.cwd(), path)} depends on façade name ${name}`,
				);
			const list = siblings.get(home) ?? [];
			list.push(name);
			siblings.set(home, list);
		}
		const lines = [];
		if (path !== sourcePath)
			for (const [statement, bindings] of bySource)
				lines.push(renderedImport(statement.source.raw, bindings));
		for (const [home, names] of siblings)
			lines.push(
				`import { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(siblingSpecifier(path, home))};`,
			);
		return lines;
	};
	for (const [path] of targets) dependencyLines.set(path, importsFor(path));
	const facadeSiblingImports = importsFor(sourcePath);
	const facadeTargetImports = [...targets.keys()].map(
		(path) => `import ${JSON.stringify(siblingSpecifier(sourcePath, path))};`,
	);
	const facadeExports = [];
	for (const [path, target] of targets) {
		const names = [...target.exports];
		if (names.length)
			facadeExports.push(
				`export { ${names.join(", ")} } from ${JSON.stringify(siblingSpecifier(sourcePath, path))};`,
			);
		const internal = [...target.localNames].filter(
			(name) => !target.exports.has(name),
		);
		if (internal.length)
			target.internalExports = `export { ${internal.join(", ")} };`;
	}
	for (const [path, target] of targets) {
		const output = [
			...dependencyLines.get(path),
			...target.statements.map((statement) => statementText(text, statement)),
			target.internalExports,
		]
			.filter(Boolean)
			.join("\n");
		writeFileSync(path, `${output}\n`);
	}
	writeFileSync(
		source,
		`${[...facade, ...facadeTargetImports, ...facadeSiblingImports, ...facadeExports].join("\n")}\n`,
	);
}
try {
	const options = optionsFrom(process.argv.slice(2));
	const input = { source: options.source, spec: readSpec(options.spec) };
	if (options.mode === "test") splitTests(input);
	else split(input);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
