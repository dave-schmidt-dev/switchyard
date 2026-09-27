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

	function scopedStatementKey(entry) {
		return JSON.stringify([entry.text, entry.scope]);
	}

	function carriedEntryKey(entry) {
		return entry.kind === "describe"
			? JSON.stringify([entry.kind, entry.scope])
			: JSON.stringify([entry.kind, entry.text, entry.scope]);
	}

	function carriedOrder(entries, baseEntries) {
		const byEntry = new Map();
		for (const [index, entry] of baseEntries.entries()) {
			const key = carriedEntryKey(entry);
			const indexes = byEntry.get(key) ?? [];
			indexes.push(index);
			byEntry.set(key, indexes);
		}
		let previous = -1;
		const used = new Set();
		for (const entry of entries) {
			const candidates = byEntry.get(carriedEntryKey(entry));
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
		const required = new Map();
		for (const entry of baseEntries) {
			if (entry.kind !== "non-test") continue;
			const key = scopedStatementKey(entry);
			if (fixtureCounts.has(key)) continue;
			const current = required.get(key) ?? { entry, count: 0 };
			current.count += 1;
			required.set(key, current);
		}
		for (const { entries } of partEntries) {
			const tests = entries.filter((entry) => entry.kind === "test");
			if (!tests.length) continue;
			for (const [key, { entry, count }] of required) {
				const applies = entry.scope.length
					? tests.some((test) =>
							entry.scope.every((title, i) => test.scope[i] === title),
						)
					: isHook(entry) ||
						entry.statementType === "ExpressionStatement" ||
						entry.statementKind === "let";
				if (!applies) continue;
				const actual = entries.filter(
					(item) =>
						item.kind === "non-test" && scopedStatementKey(item) === key,
				).length;
				if (actual !== count)
					return `${isHook(entry) ? "hook" : "state"} carried statement occurrence count differs in a part`;
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
			if (carried) {
				const key = JSON.stringify([source, []]);
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
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
				.map(scopedStatementKey),
		);
		const outputNonTests = multiset(
			partEntries.flatMap(({ entries }) =>
				entries
					.filter((entry) => entry.kind === "non-test")
					.map(scopedStatementKey),
			),
		);
		for (const [key, count] of baseNonTests)
			if (
				(outputNonTests.get(key) ?? 0) + (fixtureCounts.get(key) ?? 0) <
				count
			)
				fail(
					errors,
					"non-test carried statements do not cover the base multiset",
				);
		const baseDescribeScopes = new Set(
			baseEntries
				.filter((entry) => entry.kind === "describe")
				.map((entry) => JSON.stringify(entry.scope)),
		);
		for (const { file, entries } of partEntries) {
			for (const entry of entries.filter((item) => item.kind === "describe")) {
				if (!baseDescribeScopes.has(JSON.stringify(entry.scope)))
					fail(
						errors,
						`${relative(process.cwd(), file.path)}: describe scope differs from base`,
					);
			}
			for (const entry of entries.filter((item) => item.kind === "non-test")) {
				if (
					!baseEntries.some(
						(baseEntry) =>
							baseEntry.kind === "non-test" &&
							scopedStatementKey(baseEntry) === scopedStatementKey(entry),
					)
				)
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
