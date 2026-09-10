#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_GATE_STATUSES = Object.freeze([
	"not-run",
	"executed",
	"skipped",
	"failed",
]);
export const CONTRACT_GATE_RECEIPT_VERSION = 1;
export const CONTRACT_GATE_EXECUTION_VERSION = 1;
export const DEFAULT_RECEIPT_PATH = ".logs/contract-gates/receipt.json";
export const DEFAULT_EXECUTION_PATH = ".logs/contract-gates/execution.json";

function fail(code, details = {}) {
	const error = new Error(code);
	error.code = code;
	Object.assign(error, details);
	throw error;
}

function parseList(value) {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) fail("contract_gate_list_invalid");
		return parsed.map((entry) => String(entry).trim()).filter(Boolean);
	}
	return trimmed
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Parse the contract-gate declarations embedded in INVARIANTS.md. */
export function parseContractGateManifest(text) {
	if (typeof text !== "string" || !text.includes("<!-- contract-gates/v1")) {
		fail("contract_gate_manifest_missing");
	}
	const section = text.match(
		/<!-- contract-gates\/v1[\s\S]*?-->([\s\S]*?)<!-- \/contract-gates\/v1 -->/u,
	)?.[1];
	if (!section) fail("contract_gate_manifest_invalid");
	const gates = [];
	const headings = [
		...section.matchAll(/^### Contract gate: ([a-z0-9-]+)\s*$/gmu),
	];
	for (let index = 0; index < headings.length; index += 1) {
		const body = section.slice(
			headings[index].index + headings[index][0].length,
			headings[index + 1]?.index ?? section.length,
		);
		const areaLine = body.match(/^area:\s*(.+)$/mu)?.[1];
		const testLine = body.match(/^gate_test:\s*(.+)$/mu)?.[1];
		if (!areaLine || !testLine) fail("contract_gate_declaration_incomplete");
		let areas;
		try {
			areas = parseList(areaLine);
		} catch (error) {
			fail("contract_gate_area_invalid", { cause: error });
		}
		const tests = parseList(testLine);
		if (areas.length === 0 || tests.length === 0) {
			fail("contract_gate_declaration_empty");
		}
		gates.push({ id: headings[index][1], areas, tests });
	}
	if (gates.length === 0) fail("contract_gate_declarations_missing");
	const ids = new Set();
	for (const gate of gates) {
		if (ids.has(gate.id)) fail("contract_gate_duplicate", { gate: gate.id });
		ids.add(gate.id);
	}
	return gates;
}

export function loadContractGateManifest(root = process.cwd()) {
	return parseContractGateManifest(
		readFileSync(resolve(root, "INVARIANTS.md"), "utf8"),
	);
}

/** Parse the observation-only contract_gates block from ledger.yaml. */
export function parseLedgerGateMapping(text) {
	if (typeof text !== "string") fail("ledger_gate_mapping_invalid");
	const block = text.match(/^contract_gates:\s*\n([\s\S]*)$/mu)?.[1] ?? "";
	const mapping = {};
	for (const line of block.split(/\r?\n/u)) {
		const match = line.match(
			/^\s{2}([a-z0-9-]+):\s*\{gate_test_status:\s*([a-z-]+)\s*\}\s*$/u,
		);
		if (match) mapping[match[1]] = match[2];
	}
	return mapping;
}

export function loadLedgerGateMapping(root = process.cwd()) {
	return parseLedgerGateMapping(
		readFileSync(resolve(root, "ledger.yaml"), "utf8"),
	);
}

export function testRunnerCoverage(root = process.cwd()) {
	const packageJson = JSON.parse(
		readFileSync(resolve(root, "package.json"), "utf8"),
	);
	const serialScript = packageJson.scripts?.["test:serial"] ?? "";
	const otherScript = packageJson.scripts?.["test:other"] ?? "";
	const serial = new Set(
		[...serialScript.matchAll(/tests\/[A-Za-z0-9._/-]+\.test\.mjs/gu)].map(
			(match) => match[0],
		),
	);
	const excludedFromOther = new Set(
		[...otherScript.matchAll(/\|tests\/([A-Za-z0-9._/-]+\.test\.mjs)/gu)].map(
			(match) => `tests/${match[1]}`,
		),
	);
	const dynamicOther = otherScript.includes("tests/*.test.mjs");
	const covered = new Set(serial);
	if (dynamicOther) {
		for (const entry of readdirSync(resolve(root, "tests"), {
			withFileTypes: true,
		})) {
			if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
				const path = `tests/${entry.name}`;
				if (!excludedFromOther.has(path)) covered.add(path);
			}
		}
	}
	return { serial, covered };
}

function pathMatches(pattern, candidate) {
	const normalizedPattern = pattern.replaceAll("\\", "/");
	const normalizedCandidate = candidate.replaceAll("\\", "/");
	if (normalizedPattern.endsWith("/**")) {
		const prefix = normalizedPattern.slice(0, -3);
		return (
			normalizedCandidate === prefix ||
			normalizedCandidate.startsWith(`${prefix}/`)
		);
	}
	let expression = "";
	for (let index = 0; index < normalizedPattern.length; index += 1) {
		const char = normalizedPattern[index];
		if (char === "*") {
			if (normalizedPattern[index + 1] === "*") {
				expression += ".*";
				index += 1;
			} else expression += "[^/]*";
		} else expression += char.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
	}
	return new RegExp(`^${expression}$`, "u").test(normalizedCandidate);
}

export function ownersForPaths(manifest, paths) {
	const normalizedPaths = paths.map((path) => path.replaceAll("\\", "/"));
	return manifest.filter((gate) =>
		gate.areas.some((area) =>
			normalizedPaths.some((path) => pathMatches(area, path)),
		),
	);
}

export function suitesForOwners(owners) {
	return [...new Set(owners.flatMap((owner) => owner.tests))].sort();
}

export function validateContractGateMapping({
	manifest,
	ledger,
	root = process.cwd(),
}) {
	const errors = [];
	const ids = new Set(manifest.map((gate) => gate.id));
	for (const gate of manifest) {
		for (const area of gate.areas) {
			const literal = area.endsWith("/**") ? area.slice(0, -3) : area;
			const rootPath = resolve(root);
			const resolvedArea = resolve(root, literal);
			if (
				resolvedArea !== rootPath &&
				!resolvedArea.startsWith(`${rootPath}/`)
			) {
				errors.push(`owner_out_of_scope:${gate.id}:${area}`);
			} else if (area.includes("*")) {
				try {
					statSync(resolve(root, literal));
				} catch {
					errors.push(`owner_missing:${gate.id}:${area}`);
				}
			} else {
				try {
					readFileSync(resolve(root, literal));
				} catch {
					errors.push(`owner_missing:${gate.id}:${area}`);
				}
			}
		}
		for (const test of gate.tests) {
			if (!/^tests\/[A-Za-z0-9._/-]+\.test\.mjs$/u.test(test)) {
				errors.push(`test_path_invalid:${gate.id}:${test}`);
				continue;
			}
			try {
				readFileSync(resolve(root, test));
			} catch {
				errors.push(`test_path_stale:${gate.id}:${test}`);
			}
		}
	}
	const coverage = testRunnerCoverage(root);
	for (const gate of manifest) {
		for (const test of gate.tests) {
			if (!coverage.covered.has(test)) {
				errors.push(`test_suite_omitted_from_runner:${gate.id}:${test}`);
			}
		}
	}
	for (const id of ids) {
		if (!Object.hasOwn(ledger, id)) errors.push(`ledger_mapping_missing:${id}`);
		else if (!CONTRACT_GATE_STATUSES.includes(ledger[id]))
			errors.push(`ledger_status_invalid:${id}`);
	}
	for (const id of Object.keys(ledger)) {
		if (!ids.has(id)) errors.push(`ledger_mapping_unmapped:${id}`);
	}
	if (errors.length) fail("contract_gate_mapping_invalid", { errors });
	return true;
}

export function readGit(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function computeStagedSnapshot(root = process.cwd()) {
	const head = readGit(root, ["rev-parse", "HEAD"]).trim();
	// `git write-tree` creates an index lock even though it is logically a
	// read. Gate checks also run in read-only worktrees, so hash the complete
	// index listing instead. The staged patch digest below binds the actual
	// staged bytes and modes.
	const indexEntries = readGit(root, ["ls-files", "-s", "-z"]);
	const indexTree = `sha256:${createHash("sha256").update(indexEntries).digest("hex")}`;
	const names = readGit(root, ["diff", "--cached", "--name-only", "-z"])
		.split("\0")
		.filter(Boolean);
	const stagedPatch = readGit(root, [
		"diff",
		"--cached",
		"--binary",
		"--no-ext-diff",
	]);
	const stagedDigest = `sha256:${createHash("sha256").update(stagedPatch).digest("hex")}`;
	return { head, indexTree, stagedDigest, paths: names };
}

export function computeContractSnapshot(root = process.cwd()) {
	const staged = computeStagedSnapshot(root);
	const manifestHash = `sha256:${createHash("sha256")
		.update(readFileSync(resolve(root, "INVARIANTS.md")))
		.digest("hex")}`;
	return { ...staged, manifestHash };
}

export function validateExecutionSnapshot(execution, snapshot) {
	const expected = execution?.snapshot;
	if (!expected || typeof expected !== "object")
		fail("contract_gate_execution_snapshot_missing");
	for (const field of ["head", "indexTree", "stagedDigest", "manifestHash"]) {
		if (expected[field] !== snapshot[field])
			fail("contract_gate_execution_snapshot_stale", { field });
	}
	if (
		JSON.stringify(expected.paths ?? []) !==
		JSON.stringify(snapshot.paths ?? [])
	)
		fail("contract_gate_execution_snapshot_stale", { field: "paths" });
	return true;
}

export function assertContractSnapshotUnchanged(before, after) {
	for (const field of ["head", "indexTree", "stagedDigest", "manifestHash"]) {
		if (after[field] !== before[field])
			fail("contract_gate_snapshot_changed_after_suites", { field });
	}
	if (JSON.stringify(after.paths ?? []) !== JSON.stringify(before.paths ?? []))
		fail("contract_gate_snapshot_changed_after_suites", { field: "paths" });
	return true;
}

export function readExecutionRecord(path) {
	const record = JSON.parse(readFileSync(path, "utf8"));
	if (
		record?.schemaVersion !== CONTRACT_GATE_EXECUTION_VERSION ||
		typeof record.suites !== "object"
	) {
		fail("contract_gate_execution_invalid");
	}
	return record;
}

export function validateExecution({
	manifest,
	execution,
	changedPaths = null,
}) {
	const owners = changedPaths
		? ownersForPaths(manifest, changedPaths)
		: manifest;
	const requiredSuites = suitesForOwners(owners);
	const errors = [];
	for (const suite of requiredSuites) {
		const status = execution.suites?.[suite]?.status;
		if (!status) errors.push(`suite_omitted:${suite}`);
		else if (status === "skipped") errors.push(`suite_skipped:${suite}`);
		else if (status !== "executed")
			errors.push(`suite_not_executed:${suite}:${status}`);
	}
	if (errors.length)
		fail("contract_gate_execution_invalid", { errors, owners, requiredSuites });
	return { owners, requiredSuites };
}

export function writeContractReceipt({
	root = process.cwd(),
	execution,
	receiptPath = DEFAULT_RECEIPT_PATH,
	changedPaths = null,
	now = new Date().toISOString(),
}) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	const snapshot = computeContractSnapshot(root);
	validateExecutionSnapshot(execution, snapshot);
	const paths = changedPaths ?? snapshot.paths;
	if (JSON.stringify(paths) !== JSON.stringify(execution.snapshot.paths ?? []))
		fail("contract_gate_execution_snapshot_stale", { field: "paths" });
	const selected = validateExecution({
		manifest,
		execution,
		changedPaths: paths,
	});
	const receipt = {
		schemaVersion: CONTRACT_GATE_RECEIPT_VERSION,
		kind: "contract-gate-receipt",
		createdAt: now,
		snapshot: execution.snapshot,
		manifestHash: execution.snapshot.manifestHash,
		head: snapshot.head,
		indexTree: snapshot.indexTree,
		stagedDigest: snapshot.stagedDigest,
		changedPaths: paths,
		owners: selected.owners.map((owner) => owner.id),
		suites: Object.fromEntries(
			selected.requiredSuites.map((suite) => [suite, "executed"]),
		),
	};
	const destination = resolve(root, receiptPath);
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, {
		mode: 0o600,
	});
	return receipt;
}

export function validateReceipt({
	root = process.cwd(),
	receiptPath = DEFAULT_RECEIPT_PATH,
}) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	const receipt = JSON.parse(readFileSync(resolve(root, receiptPath), "utf8"));
	if (
		receipt?.schemaVersion !== CONTRACT_GATE_RECEIPT_VERSION ||
		receipt.kind !== "contract-gate-receipt"
	)
		fail("contract_gate_receipt_invalid");
	const contractSnapshot = computeContractSnapshot(root);
	validateExecutionSnapshot(receipt, contractSnapshot);
	for (const field of ["head", "indexTree", "stagedDigest"]) {
		if (receipt[field] !== contractSnapshot[field])
			fail("contract_gate_receipt_stale", { field });
	}
	const manifestHash = contractSnapshot.manifestHash;
	if (receipt.manifestHash !== manifestHash)
		fail("contract_gate_receipt_stale", { field: "manifestHash" });
	if (
		JSON.stringify(receipt.changedPaths ?? []) !==
		JSON.stringify(contractSnapshot.paths)
	)
		fail("contract_gate_receipt_stale", { field: "changedPaths" });
	const selected = validateExecution({
		manifest,
		execution: {
			suites: Object.fromEntries(
				Object.entries(receipt.suites ?? {}).map(([suite, status]) => [
					suite,
					{ status },
				]),
			),
		},
		changedPaths: contractSnapshot.paths,
	});
	return { receipt, ...selected };
}

export function discoverTestFiles(root = process.cwd()) {
	const packageJson = JSON.parse(
		readFileSync(resolve(root, "package.json"), "utf8"),
	);
	const serial = [
		...(packageJson.scripts?.["test:serial"] ?? "").matchAll(
			/tests\/[A-Za-z0-9._/-]+\.test\.mjs/gu,
		),
	].map((match) => match[0]);
	const all = readdirSync(resolve(root, "tests"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
		.map((entry) => `tests/${entry.name}`);
	return {
		serial: [...new Set(serial)],
		other: all.filter((path) => !serial.includes(path)),
	};
}

export function executionRecordFromPhases(
	results,
	root = process.cwd(),
	snapshot = computeContractSnapshot(root),
) {
	const files = discoverTestFiles(root);
	const coverage = testRunnerCoverage(root);
	const statuses = new Map(
		results.map((result) => [
			result.phase,
			result.status === 0 ? "executed" : "failed",
		]),
	);
	const suites = {};
	for (const path of files.serial)
		suites[path] = {
			status: coverage.covered.has(path)
				? (statuses.get("test:serial") ?? "not-run")
				: "not-run",
			phase: "test:serial",
		};
	for (const path of files.other)
		suites[path] = {
			status: coverage.covered.has(path)
				? (statuses.get("test:other") ?? "not-run")
				: "not-run",
			phase: "test:other",
		};
	return {
		schemaVersion: CONTRACT_GATE_EXECUTION_VERSION,
		createdAt: new Date().toISOString(),
		snapshot,
		phases: Object.fromEntries(
			results.map((result) => [result.phase, result.status]),
		),
		suites,
	};
}

export function writeExecutionRecord(
	results,
	{
		root = process.cwd(),
		executionPath = DEFAULT_EXECUTION_PATH,
		snapshot = computeContractSnapshot(root),
	} = {},
) {
	const destination = resolve(root, executionPath);
	mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
	const record = executionRecordFromPhases(results, root, snapshot);
	writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, {
		mode: 0o600,
	});
	return record;
}

export function statusReport({
	root = process.cwd(),
	executionPath = DEFAULT_EXECUTION_PATH,
}) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	let execution;
	try {
		execution = readExecutionRecord(resolve(root, executionPath));
	} catch {
		execution = { suites: {} };
	}
	const snapshot = computeContractSnapshot(root);
	const selected = ownersForPaths(manifest, snapshot.paths);
	const required = suitesForOwners(selected);
	return {
		changedPaths: snapshot.paths,
		owners: selected.map((owner) => owner.id),
		suites: Object.fromEntries(
			required.map((suite) => [
				suite,
				execution.suites?.[suite]?.status ?? "not-run",
			]),
		),
	};
}

/** Classify one node:test TAP stream without treating an all-skipped file as executed. */
export function parseTapOutcome(output, exitCode) {
	const tests = Number(output.match(/^# tests (\d+)$/mu)?.[1] ?? 0);
	const passed = Number(output.match(/^# pass (\d+)$/mu)?.[1] ?? 0);
	const skipped = Number(output.match(/^# skipped (\d+)$/mu)?.[1] ?? 0);
	if (exitCode !== 0) return { status: "failed", tests, passed, skipped };
	if (tests === 0 || (skipped > 0 && passed === 0)) {
		return { status: "skipped", tests, passed, skipped };
	}
	return { status: "executed", tests, passed, skipped };
}

function runSuiteWithTap(root, suite) {
	return new Promise((resolveResult) => {
		const child = spawn(
			process.execPath,
			["--test", "--test-reporter=tap", suite],
			{
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
				env: Object.fromEntries(
					Object.entries(process.env).filter(
						([key]) => key !== "NODE_TEST_CONTEXT",
					),
				),
			},
		);
		let output = "";
		const forward = (chunk, stream) => {
			const text = chunk.toString();
			stream.write(text);
			output = `${output}${text}`.slice(-2 * 1024 * 1024);
		};
		child.stdout.on("data", (chunk) => forward(chunk, process.stdout));
		child.stderr.on("data", (chunk) => forward(chunk, process.stderr));
		child.on("error", () =>
			resolveResult({ status: "failed", reason: "launch_failed" }),
		);
		child.on("close", (code) => resolveResult(parseTapOutcome(output, code)));
	});
}

/** Execute the suites selected by the current staged production boundary. */
export async function runContractSuites({
	root = process.cwd(),
	log = console.error,
} = {}) {
	const manifest = loadContractGateManifest(root);
	const ledger = loadLedgerGateMapping(root);
	validateContractGateMapping({ manifest, ledger, root });
	const snapshot = computeContractSnapshot(root);
	const owners = ownersForPaths(manifest, snapshot.paths);
	const requiredSuites = suitesForOwners(owners.length > 0 ? owners : manifest);
	const suites = {};
	for (const suite of requiredSuites) {
		suites[suite] = await runSuiteWithTap(root, suite);
	}
	const after = computeContractSnapshot(root);
	assertContractSnapshotUnchanged(snapshot, after);
	const execution = {
		schemaVersion: CONTRACT_GATE_EXECUTION_VERSION,
		createdAt: new Date().toISOString(),
		snapshot,
		phases: {
			"test:contracts": Object.values(suites).every(
				(entry) => entry.status === "executed",
			)
				? 0
				: 1,
		},
		suites,
	};
	mkdirSync(dirname(resolve(root, DEFAULT_EXECUTION_PATH)), {
		recursive: true,
		mode: 0o700,
	});
	writeFileSync(
		resolve(root, DEFAULT_EXECUTION_PATH),
		`${JSON.stringify(execution, null, 2)}\n`,
		{ mode: 0o600 },
	);
	if (execution.phases["test:contracts"] !== 0) {
		log("contract gates: one or more mapped suites failed");
		return execution;
	}
	writeContractReceipt({ root, execution, changedPaths: snapshot.paths });
	return execution;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
	const root = process.cwd();
	const mode = process.argv.includes("--status")
		? "status"
		: process.argv.includes("--run")
			? "run"
			: process.argv.includes("--validate")
				? "validate"
				: "mapping";
	try {
		if (mode === "mapping")
			validateContractGateMapping({
				manifest: loadContractGateManifest(root),
				ledger: loadLedgerGateMapping(root),
				root,
			});
		else if (mode === "status")
			console.log(JSON.stringify(statusReport({ root }), null, 2));
		else if (mode === "run" || mode === "validate") {
			const execution = await runContractSuites({ root });
			if (execution.phases["test:contracts"] !== 0) process.exitCode = 1;
			else
				console.log("contract gates: mapped suites executed; receipt written");
		}
	} catch (error) {
		console.error(
			`contract gates: ${error.code ?? "failed"}${error.errors ? ` ${error.errors.join(",")}` : ""}`,
		);
		process.exitCode = 1;
	}
}
