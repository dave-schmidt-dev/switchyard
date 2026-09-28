import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function normalize(text) {
	return text
		.split("\n")
		.map((line) => line.replace(/^[\t ]+/, ""))
		.join("\n");
}

function digest(text) {
	return createHash("sha256").update(normalize(text)).digest("hex");
}

function isLiteral(node) {
	if (!node) return false;
	if (node.type === "Literal") return true;
	if (node.type === "TemplateLiteral") return node.expressions.length === 0;
	if (node.type === "ArrayExpression")
		return node.elements.every((element) => element && isLiteral(element));
	if (node.type !== "ObjectExpression") return false;
	return node.properties.every(
		(property) =>
			["Property", "ObjectProperty"].includes(property.type) &&
			property.kind === "init" &&
			!property.computed &&
			!property.method &&
			isLiteral(property.value),
	);
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

function directTestCall(statement) {
	const expression = statement?.expression;
	return (
		expression?.type === "CallExpression" &&
		expression.callee.type === "Identifier" &&
		["it", "test"].includes(expression.callee.name)
	);
}

function callTitle(statement) {
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

function isTestFactory(statement) {
	if (statement?.type !== "ForOfStatement" || statement.await) return false;
	const declaration = statement.left;
	if (
		declaration?.type !== "VariableDeclaration" ||
		declaration.kind !== "const" ||
		declaration.declarations.length !== 1 ||
		declaration.declarations[0].id.type !== "Identifier" ||
		declaration.declarations[0].init ||
		statement.right?.type !== "ArrayExpression" ||
		!statement.right.elements.every((element) => element && isLiteral(element))
	)
		return false;
	const body =
		statement.body?.type === "BlockStatement" ? statement.body.body : [];
	return body.length === 1 && directTestCall(body[0]);
}

function registrationCallee(callee) {
	if (callee?.type === "Identifier") return callee.name;
	if (callee?.type === "MemberExpression")
		return registrationCallee(callee.object);
	return null;
}

function isRegistrationCall(node) {
	return (
		node?.type === "CallExpression" &&
		["it", "test"].includes(registrationCallee(node.callee))
	);
}

function isFunction(node) {
	return [
		"FunctionDeclaration",
		"FunctionExpression",
		"ArrowFunctionExpression",
	].includes(node?.type);
}

function containsRegistration(node) {
	if (!node || typeof node !== "object") return false;
	if (isRegistrationCall(node)) return true;
	if (isFunction(node)) return false;
	if (
		node.type === "CallExpression" &&
		node.arguments.some(
			(argument) => isFunction(argument) && containsRegistration(argument.body),
		)
	)
		return true;
	return Object.entries(node).some(([key, value]) => {
		if (["loc", "start", "end", "range", "raw"].includes(key)) return false;
		if (Array.isArray(value)) return value.some(containsRegistration);
		return containsRegistration(value);
	});
}

function hasUnsupportedRegistration(statement) {
	if (directTestCall(statement) || isTestFactory(statement)) return false;
	return containsRegistration(statement);
}

function testEntry(spec, source, fail, validNames) {
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

function normalizedItem(item, fail, validNames) {
	if (typeof item === "string")
		return { title: item, tests: null, scoped: false, factories: [] };
	if (!item || typeof item !== "object")
		fail("part items must be describe titles");
	const title = item.title ?? item.describe ?? item.name;
	if (typeof title !== "string") fail("part item needs a describe title");
	if (item.tests !== undefined && !validNames(item.tests))
		fail(`describe ${title} tests must be strings`);
	if (!Array.isArray(item.factories ?? []))
		fail(`describe ${title} factories must be an array`);
	const factories = (item.factories ?? []).map((factory) => {
		if (
			!factory ||
			!Number.isInteger(factory.start) ||
			factory.start < 0 ||
			typeof factory.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/u.test(factory.sha256)
		)
			fail(`describe ${title} factory needs start and sha256`);
		return { start: factory.start, sha256: factory.sha256 };
	});
	return {
		title,
		tests: item.tests ?? (factories.length ? [] : null),
		scoped: item.scoped === true,
		factories,
	};
}

function selectorKey(selector) {
	return `${selector.start}:${selector.sha256}`;
}

function factorySelector(text, statement) {
	return {
		start: statement.start,
		sha256: digest(text.slice(statement.start, statement.end)),
	};
}

function isPotentialEffect(node) {
	if (!node || typeof node !== "object") return false;
	if (Array.isArray(node)) return node.some(isPotentialEffect);
	if (
		[
			"FunctionDeclaration",
			"FunctionExpression",
			"ArrowFunctionExpression",
		].includes(node.type)
	)
		return false;
	if (
		[
			"CallExpression",
			"NewExpression",
			"AwaitExpression",
			"YieldExpression",
			"AssignmentExpression",
			"UpdateExpression",
		].includes(node.type)
	)
		return true;
	return Object.entries(node)
		.filter(([key]) => !["type", "start", "end", "range", "loc"].includes(key))
		.some(([, value]) => isPotentialEffect(value));
}

function splitDescribe(text, statement, item, fail) {
	if (!item.tests && item.factories.length === 0)
		return {
			text: text.slice(statement.start, statement.end),
			nodes: [statement],
		};
	const body = callbackBody(statement);
	if (!body) fail(`describe ${item.title} has no block callback`);
	if (item.tests !== null && body.body.some(hasUnsupportedRegistration))
		fail(
			`describe ${item.title} has an unsupported registration shape; move the complete describe`,
		);
	const wanted = new Set(item.tests ?? []);
	const factories = new Map();
	for (const child of body.body) {
		if (!isTestFactory(child)) continue;
		factories.set(selectorKey(factorySelector(text, child)), child);
	}
	const selectedFactories = new Set();
	for (const selector of item.factories) {
		const factory = factories.get(selectorKey(selector));
		if (!factory)
			fail(`describe ${item.title} has no matching factory selector`);
		if (selectedFactories.has(factory))
			fail(`describe ${item.title} repeats a factory selector`);
		selectedFactories.add(factory);
	}
	for (const title of wanted) {
		if (
			!body.body.some(
				(child) => testKind(child) === "test" && callTitle(child) === title,
			)
		)
			fail(`describe ${item.title} has no direct test ${title}`);
	}
	const nodes = body.body.filter((child) => {
		if (isTestFactory(child)) return selectedFactories.has(child);
		const kind = testKind(child);
		if (kind === "test") return wanted.has(callTitle(child));
		return item.scoped && kind !== "test";
	});
	const prefix = text.slice(statement.start, body.start + 1);
	const suffix = text.slice(body.end - 1, statement.end);
	return {
		text: `${prefix}\n${nodes.map((child) => text.slice(child.start, child.end)).join("\n")}\n${suffix}`,
		nodes,
	};
}

export function splitTests({ source, spec, shared }) {
	const {
		declarationNames,
		fail,
		importBindings,
		parse,
		references,
		renderedImport,
		siblingSpecifier,
		statementText,
		validNames,
	} = shared;
	if (source.startsWith("/") || source.split(/[\\/]/).includes(".."))
		fail("source must be repository-relative");
	const text = readFileSync(source, "utf8");
	const program = parse(source, text);
	const config = testEntry(spec, source, fail, validNames);
	const validateOutputPath = (path, label) => {
		if (path.startsWith("/") || path.split(/[\\/]/).includes(".."))
			fail(`${label} path is invalid: ${path}`);
	};
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
	for (const statement of top)
		if (
			testKind(statement) === "other" &&
			hasUnsupportedRegistration(statement)
		)
			fail("top-level unsupported registration shape cannot be split");
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
	const importNames = new Set(imports.keys());
	const importRefsOf = (statement) => [...references(statement, importNames)];
	const state = new Set(
		top.filter((statement) => {
			const kind = testKind(statement);
			return (
				kind === "hook" ||
				(kind === "other" && !isTestFactory(statement)) ||
				declarationNames(statement).some(
					(name) => lets.has(name) || config.stateNames.has(name),
				) ||
				(!["describe", "test"].includes(kind) &&
					!isTestFactory(statement) &&
					isPotentialEffect(statement))
			);
		}),
	);
	let grew = true;
	while (grew) {
		grew = false;
		for (const statement of [...state])
			for (const name of refsOf(statement)) {
				const dependency = byName.get(name);
				if (dependency && !state.has(dependency)) {
					state.add(dependency);
					grew = true;
				}
			}
	}
	const describes = new Map();
	for (const statement of top)
		if (["describe", "test"].includes(testKind(statement)))
			describes.set(callTitle(statement), statement);
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
	const claimedFactories = new Map();
	for (const part of config.parts) {
		const selected = [];
		const selectedStatements = new Set();
		for (const rawItem of part.items) {
			const item = normalizedItem(rawItem, fail, validNames);
			const statement = describes.get(item.title);
			if (!statement)
				fail(`part ${part.path} has no top-level describe ${item.title}`);
			if (selectedStatements.has(statement))
				fail(`part ${part.path} repeats ${item.title}`);
			selectedStatements.add(statement);
			const rendered = splitDescribe(text, statement, item, fail);
			for (const factory of rendered.nodes.filter(isTestFactory)) {
				if (claimedFactories.has(factory))
					fail(
						`factory selector already belongs to ${claimedFactories.get(factory)}`,
					);
				claimedFactories.set(factory, part.path);
			}
			const existing = picked.get(statement) ?? {
				tests: new Set(),
				factories: new Set(),
				all: false,
			};
			if (item.tests === null) existing.all = true;
			else for (const title of item.tests) existing.tests.add(title);
			for (const factory of rendered.nodes.filter(isTestFactory))
				existing.factories.add(factory);
			picked.set(statement, existing);
			selected.push({ statement, ...rendered });
		}
		const needed = new Set(state);
		const roots = selected.flatMap((entry) => entry.nodes);
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
					refs: refsOf(statement),
					imports: importRefsOf(statement),
				})),
			...selected.map((entry) => ({
				...entry,
				refs: entry.nodes.flatMap(refsOf),
				imports: [
					...importRefsOf(entry.statement.expression.callee),
					...entry.nodes.flatMap(importRefsOf),
				],
			})),
		].sort((left, right) => left.statement.start - right.statement.start);
		const names = new Set(chunks.flatMap((chunk) => chunk.imports));
		const importsByStatement = new Map();
		for (const name of names) {
			const record = imports.get(name);
			if (!record) continue;
			const bindings = importsByStatement.get(record.statement) ?? [];
			bindings.push(record.binding);
			importsByStatement.set(record.statement, bindings);
		}
		const fixtureNamesUsed = new Set(
			chunks
				.flatMap((chunk) => chunk.refs)
				.filter((name) => config.fixtureNames.has(name)),
		);
		const fixtureImport =
			config.fixturePath && fixtureNamesUsed.size
				? `import { ${[...fixtureNamesUsed].join(", ")} } from ${JSON.stringify(siblingSpecifier(part.path, config.fixturePath))};`
				: null;
		const output = [
			...[...importsByStatement].map(([statement, bindings]) =>
				renderedImport(statement.source.raw, bindings),
			),
			fixtureImport,
			...chunks.map((chunk) => chunk.text),
		]
			.filter(Boolean)
			.join("\n");
		mkdirSync(dirname(part.path), { recursive: true });
		writeFileSync(part.path, `${output}\n`);
	}
	if (config.fixturePath) {
		const fixtureOutput = [
			...(() => {
				const names = new Set([...fixtureStatements].flatMap(importRefsOf));
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
			})(),
			...top
				.filter((statement) => fixtureStatements.has(statement))
				.map((statement) => statementText(text, statement)),
			config.fixtureNames.size
				? `export { ${[...config.fixtureNames].join(", ")} };`
				: null,
		]
			.filter(Boolean)
			.join("\n");
		mkdirSync(dirname(config.fixturePath), { recursive: true });
		writeFileSync(config.fixturePath, `${fixtureOutput}\n`);
	}
	const retained = top.flatMap((statement) => {
		const selected = picked.get(statement);
		if (!selected) return [statementText(text, statement)];
		if (selected.all) return [];
		const body = callbackBody(statement);
		const children = body.body.filter(
			(child) =>
				!(testKind(child) === "test" && selected.tests.has(callTitle(child))) &&
				!(isTestFactory(child) && selected.factories.has(child)),
		);
		if (
			!children.some(
				(child) => testKind(child) === "test" || isTestFactory(child),
			)
		)
			return [];
		return [
			`${text.slice(statement.start, body.start + 1)}\n${children.map((child) => text.slice(child.start, child.end)).join("\n")}\n${text.slice(body.end - 1, statement.end)}`,
		];
	});
	const hasTests = retained.some((statement) =>
		/\b(?:it|test)\s*\(/u.test(statement),
	);
	const originalImports = program.body
		.filter((statement) => statement.type === "ImportDeclaration")
		.map((statement) => statementText(text, statement));
	writeFileSync(
		source,
		hasTests ? `${[...originalImports, ...retained].join("\n")}\n` : "",
	);
}

export const testFactorySelector = factorySelector;
