import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export function createTestChecker(shared) {
	const { fail, parse, resolveSpecifier, statementText, exportsOf } = shared;

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

	function testStructure(program, text, parentScope = []) {
		const entries = [];
		const visit = (body, scope) => {
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
					scope,
					call: name,
					statementType: statement.type,
					statementKind: statement.kind,
				};
				if (entry.kind === "describe") {
					entry.title = titleOf(statement, text);
					entry.scope = [...scope, entry.title];
				}
				entries.push(entry);
				if (entry.kind === "describe")
					visit(callbackBody(statement), entry.scope);
			}
		};
		visit(program.body, parentScope);
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
		const used = new Set();
		for (const entry of entries) {
			const candidates =
				entry.kind === "describe"
					? describeByTitle.get(entry.title)
					: byText.get(entry.text);
			if (!candidates) return false;
			const index = candidates.find(
				(candidate) => candidate >= previous && !used.has(candidate),
			);
			if (index === undefined) return false;
			used.add(index);
			previous = index;
		}
		return true;
	}

	function isHook(entry) {
		return /^(before|after)(Each|All)?$/u.test(entry.call ?? "");
	}

	function missingCarriedStatement(baseEntries, partEntries, fixtureCounts) {
		for (const { entries } of partEntries) {
			const tests = entries.filter((entry) => entry.kind === "test");
			if (!tests.length) continue;
			for (const entry of baseEntries.filter(
				(item) => item.kind === "non-test",
			)) {
				if (fixtureCounts.has(entry.text)) continue;
				const applies = entry.scope.length
					? tests.some((test) =>
							entry.scope.every((title, i) => test.scope[i] === title),
						)
					: isHook(entry) ||
						entry.statementType === "ExpressionStatement" ||
						entry.statementKind === "let";
				if (
					applies &&
					!entries.some(
						(item) =>
							item.kind === "non-test" &&
							item.text === entry.text &&
							JSON.stringify(item.scope) === JSON.stringify(entry.scope),
					)
				)
					return `${isHook(entry) ? "hook" : "state"} carried statement is missing from a part`;
			}
		}
		return null;
	}

	function fixtureCarriedCounts(options, base) {
		const counts = new Map();
		if (!options.fixture || !existsSync(resolve(options.fixture)))
			return counts;
		const path = resolve(options.fixture),
			text = readFileSync(path, "utf8");
		for (const statement of base.program.body) {
			const source = statementText(base.text, statement);
			const carried =
				text.includes(source) ||
				(isDirnameDeclaration(statement) &&
					[
						'const __dirname = resolve(fileURLToPath(import.meta.url), "..", "..");',
						'const __dirname = fileURLToPath(new URL("..", import.meta.url));',
					].some((rebased) => text.includes(rebased)));
			if (carried) counts.set(source, (counts.get(source) ?? 0) + 1);
		}
		return counts;
	}

	function fixtureImportsAreExported(
		file,
		fixturePath,
		fixtureExports,
		errors,
	) {
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
			if (!text.includes("import.meta") && !text.includes("__filename"))
				continue;
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
		const fixtureCounts = fixtureCarriedCounts(options, base);
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
		const baseNonTests = multiset(
			baseEntries
				.filter((entry) => entry.kind === "non-test")
				.map((entry) => entry.text),
		);
		const outputNonTests = multiset(
			partEntries.flatMap(({ entries }) =>
				entries
					.filter((entry) => entry.kind === "non-test")
					.map((entry) => entry.text),
			),
		);
		for (const [text, count] of baseNonTests)
			if (
				(outputNonTests.get(text) ?? 0) + (fixtureCounts.get(text) ?? 0) <
				count
			)
				fail(
					errors,
					"non-test carried statements do not cover the base multiset",
				);
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
		const missing = missingCarriedStatement(
			baseEntries,
			partEntries,
			fixtureCounts,
		);
		if (missing) fail(errors, missing);
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

	return checkTest;
}
