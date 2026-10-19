#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	computeContractSnapshot,
	writeExecutionRecord,
} from "./check-contract-gates.mjs";
import {
	holdRunScratchRoot,
	withHermeticTestEnv,
} from "./hermetic-test-env.mjs";

export const DEFAULT_PHASES = ["test:serial", "test:other"];
const PROPERTY_FILES = Object.freeze([
	"package.json",
	"package-lock.json",
	"scripts/run-test-phases.mjs",
	"tests/outcome-properties.test.mjs",
	"tests/mutation-properties.test.mjs",
	"src/switchyard/outcome/schema.mjs",
	"src/switchyard/lifecycle/mutation-protocol.mjs",
]);
const HISTORICAL_MUTATIONS = Object.freeze({
	"retry-budget": Object.freeze({
		property: "retry-budgets",
		source: "src/switchyard/lifecycle/mutation-protocol.mjs",
		needle: "attempt <= normalizedPolicy.maxAttempts;",
		replacement: "attempt < normalizedPolicy.maxAttempts;",
	}),
	"state-safety": Object.freeze({
		property: "mutation-state-safety",
		source: "src/switchyard/lifecycle/mutation-protocol.mjs",
		needle: 'state: record.outcome === "failed" ? "failed" : "uncertain",',
		replacement: 'state: "completed",',
	}),
});

/** Derive a candidate-specific, reproducible digest without reading secrets. */
export function derivePropertyCandidateDigest(root = process.cwd()) {
	const digest = createHash("sha256");
	for (const relative of PROPERTY_FILES) {
		const path = join(root, relative);
		digest.update(relative, "utf8");
		if (existsSync(path)) digest.update(readFileSync(path));
	}
	return `sha256:${digest.digest("hex")}`;
}

export function propertySeedFromDigest(digest) {
	const hex = String(digest)
		.replace(/^sha256:/u, "")
		.slice(0, 8);
	return Number.parseInt(hex || "1", 16) >>> 0;
}

function propertyDiagnosticPath(root) {
	return join(root, "property-diagnostic.json");
}

function resolveCandidateBase(root) {
	const explicitBase = process.env.SWITCHYARD_CANDIDATE_BASE;
	let base = explicitBase;
	if (!base) {
		try {
			execFileSync(
				"git",
				["diff", "--quiet", "HEAD", "--", ...PROPERTY_FILES],
				{ cwd: root, stdio: "ignore" },
			);
			base = "HEAD^";
		} catch (error) {
			if (error?.status !== 1)
				throw new Error("candidate_base_selection_failed");
			base = "HEAD";
		}
	}
	const resolved = execFileSync(
		"git",
		["rev-parse", "--verify", `${base}^{commit}`],
		{
			cwd: root,
			encoding: "utf8",
		},
	).trim();
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", resolved, head], {
			cwd: root,
			stdio: "ignore",
		});
	} catch {
		throw new Error("candidate_base_not_ancestor");
	}
	for (const relative of PROPERTY_FILES) {
		const currentPath = join(root, relative);
		const current = existsSync(currentPath) ? readFileSync(currentPath) : null;
		let baseline = null;
		try {
			baseline = execFileSync("git", ["show", `${resolved}:${relative}`], {
				cwd: root,
			});
		} catch {
			// A newly added relevant file differs from a base that lacks it.
		}
		if (
			current === null
				? baseline !== null
				: baseline === null || !current.equals(baseline)
		)
			return resolved;
	}
	throw new Error("candidate_base_not_different");
}

function materializeSources(root, revision, { mutation = null } = {}) {
	const tempRoot = mkdtempSync(join(tmpdir(), "switchyard-parent-properties-"));
	const sourceFiles = [
		"src/switchyard/outcome/schema.mjs",
		"src/switchyard/lifecycle/mutation-protocol.mjs",
	];
	try {
		for (const relative of sourceFiles) {
			const target = join(tempRoot, relative);
			mkdirSync(dirname(target), { recursive: true });
			const source = revision
				? execFileSync("git", ["show", `${revision}:${relative}`], {
						cwd: root,
					})
				: readFileSync(join(root, relative));
			writeFileSync(target, source);
		}
		if (mutation) {
			const sourcePath = join(tempRoot, mutation.source);
			const source = readFileSync(sourcePath, "utf8");
			if (!source.includes(mutation.needle))
				throw new Error(`mutation_needle_missing:${mutation.source}`);
			writeFileSync(
				sourcePath,
				source.replaceAll(mutation.needle, mutation.replacement),
			);
		}
		for (const relative of [
			"tests/outcome-properties.test.mjs",
			"tests/mutation-properties.test.mjs",
		]) {
			const target = join(tempRoot, relative);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(root, relative), target);
		}
		symlinkSync(
			join(root, "node_modules"),
			join(tempRoot, "node_modules"),
			"dir",
		);
		return { root: tempRoot, revision };
	} catch (error) {
		rmSync(tempRoot, { force: true, recursive: true });
		throw error;
	}
}

function parentDigest(root) {
	const digest = createHash("sha256");
	for (const relative of [
		"src/switchyard/outcome/schema.mjs",
		"src/switchyard/lifecycle/mutation-protocol.mjs",
		"tests/outcome-properties.test.mjs",
		"tests/mutation-properties.test.mjs",
	]) {
		digest.update(relative, "utf8");
		digest.update(readFileSync(join(root, relative)));
	}
	return `sha256:${digest.digest("hex")}`;
}

function replayParent({ root, seed, testArgs }) {
	let materialized;
	try {
		const revision = resolveCandidateBase(root);
		materialized = materializeSources(root, revision);
		const digest = parentDigest(materialized.root);
		const diagnostic = propertyDiagnosticPath(materialized.root);
		const {
			SWITCHYARD_PROPERTY_MUTATION: _mutation,
			SWITCHYARD_PARENT_DIGEST: _parentDigest,
			SWITCHYARD_PARENT_PROPERTY_STATUS: _parentStatus,
			...parentEnvironment
		} = process.env;
		const result = withHermeticTestEnv(
			{
				...parentEnvironment,
				SWITCHYARD_PROPERTY_SEED: String(seed),
				SWITCHYARD_CANDIDATE_DIGEST: digest,
				SWITCHYARD_PROPERTY_DIAGNOSTIC_FILE: diagnostic,
				SWITCHYARD_PARENT_REPLAY: "1",
			},
			(env) =>
				spawnSync(
					process.execPath,
					[
						"--test",
						"tests/outcome-properties.test.mjs",
						"tests/mutation-properties.test.mjs",
						...testArgs,
					],
					{ cwd: materialized.root, stdio: "inherit", env },
				),
		);
		return {
			status: result.error ? 1 : (result.status ?? 1),
			digest,
			revision: materialized.revision,
		};
	} catch (error) {
		return {
			status: null,
			digest: null,
			revision: null,
			error: error?.code ?? error?.message ?? "parent_replay_failed",
		};
	} finally {
		if (materialized)
			rmSync(materialized.root, { force: true, recursive: true });
	}
}

function runHistoricalMutation({ root, mutation, seed, testArgs, diagnostic }) {
	let materialized;
	try {
		materialized = materializeSources(root, null, { mutation });
		const result = withHermeticTestEnv(
			{
				...Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => key !== "SWITCHYARD_PROPERTY_MUTATION",
					),
				),
				SWITCHYARD_PROPERTY_SEED: String(seed),
				SWITCHYARD_PROPERTY_DIAGNOSTIC_FILE: diagnostic,
			},
			(env) =>
				spawnSync(
					process.execPath,
					[
						"--test",
						"tests/outcome-properties.test.mjs",
						"tests/mutation-properties.test.mjs",
						...testArgs,
					],
					{ cwd: materialized.root, stdio: "inherit", env },
				),
		);
		return { status: result.error ? 1 : (result.status ?? 1), error: null };
	} catch (error) {
		return {
			status: 1,
			error: error?.message ?? "mutation_materialization_failed",
		};
	} finally {
		if (materialized)
			rmSync(materialized.root, { force: true, recursive: true });
	}
}

function runPropertyTests({ root = process.cwd(), spawn = spawnSync } = {}) {
	const candidateDigest = derivePropertyCandidateDigest(root);
	const suppliedSeed = process.env.SWITCHYARD_PROPERTY_SEED;
	const seed =
		suppliedSeed === undefined
			? propertySeedFromDigest(candidateDigest)
			: Number.parseInt(suppliedSeed, 10) >>> 0;
	const testArgs = process.argv.slice(3);
	const diagnosticRoot = mkdtempSync(
		join(tmpdir(), "switchyard-property-diagnostic-"),
	);
	const diagnosticPath = join(diagnosticRoot, "property-diagnostic.json");
	console.log(`Property test candidate: ${candidateDigest}`);
	console.log(`Property test seed: ${seed}`);
	console.log("Property test cases: 1000 per invariant");
	const mutationName = process.env.SWITCHYARD_PROPERTY_MUTATION;
	const mutation = mutationName ? HISTORICAL_MUTATIONS[mutationName] : null;
	let mutationError = null;
	let result;
	if (mutationName && !mutation) {
		mutationError = `unknown_historical_mutation:${mutationName}`;
		result = { status: 1 };
	} else if (mutation) {
		result = runHistoricalMutation({
			root,
			mutation,
			seed,
			testArgs,
			diagnostic: diagnosticPath,
		});
		mutationError = result.error;
	} else {
		result = withHermeticTestEnv(
			{
				...process.env,
				SWITCHYARD_PROPERTY_SEED: String(seed),
				SWITCHYARD_CANDIDATE_DIGEST: candidateDigest,
				SWITCHYARD_PROPERTY_DIAGNOSTIC_FILE: diagnosticPath,
			},
			(env) =>
				spawn(
					process.execPath,
					[
						"--test",
						"tests/outcome-properties.test.mjs",
						"tests/mutation-properties.test.mjs",
						...testArgs,
					],
					{ stdio: "inherit", env },
				),
		);
	}
	const status = mutationError ? 1 : result.error ? 1 : (result.status ?? 1);
	if (status !== 0) {
		const parent = mutationError
			? { status: null, digest: null, revision: null, error: mutationError }
			: replayParent({ root, seed, testArgs });
		let diagnostic = null;
		try {
			diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
		} catch {
			// The child output remains authoritative when no structured record exists.
		}
		const parentPassed = parent.status === 0;
		console.error(
			JSON.stringify({
				schemaVersion: 1,
				type: "property-attribution",
				candidateDigest,
				parentDigest: parent.digest,
				candidateStatus: "failed",
				parentStatus:
					parent.status === null
						? "unresolved"
						: parent.status === 0
							? "passed"
							: "failed",
				attribution:
					mutationError || parent.status === null
						? "unresolved"
						: parentPassed
							? "introduced-by-candidate"
							: "pre-existing",
				seed,
				replay:
					diagnostic?.replay ??
					`SWITCHYARD_PROPERTY_SEED=${seed} npm run test:properties`,
				path: diagnostic?.path ?? "unknown",
				parentRevision: parent.revision,
				parentError: parent.error ?? null,
			}),
		);
	}
	rmSync(diagnosticRoot, { force: true, recursive: true });
	return status;
}

export function defaultRun(
	phase,
	{ spawn = spawnSync, env = process.env } = {},
) {
	const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawn(npmCmd, ["run", phase], { stdio: "inherit", env });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

export function runPhases({
	phases = DEFAULT_PHASES,
	run = defaultRun,
	log = console.log,
} = {}) {
	const results = [];
	for (const phase of phases) {
		const res = run(phase);
		const rawStatus =
			typeof res === "number" ? res : (res?.status ?? (res ? 0 : 1));
		const status = Number.isInteger(rawStatus) ? rawStatus : 1;
		results.push({ phase, status });
	}

	const summary = `Test phase summary: ${results
		.map((r) => `${r.phase} (exit ${r.status})`)
		.join(", ")}`;
	log(summary);

	const firstNonZero = results.find((r) => r.status !== 0);
	runPhases.lastResults = results;
	return firstNonZero ? firstNonZero.status : 0;
}

if (
	process.argv[1] &&
	(fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
		(existsSync(process.argv[1]) &&
			import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href))
) {
	holdRunScratchRoot();
	if (process.argv[2] === "--properties") process.exit(runPropertyTests());
	const snapshot = computeContractSnapshot(process.cwd());
	const normalStatus = runPhases();
	const propertyStatus = runPropertyTests();
	runPhases.lastResults = [
		...(runPhases.lastResults ?? []),
		{ phase: "test:properties", status: propertyStatus },
	];
	const status = normalStatus !== 0 ? normalStatus : propertyStatus;
	writeExecutionRecord(runPhases.lastResults ?? [], {
		root: process.cwd(),
		snapshot,
	});
	process.exit(status);
}
