#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOTS = Object.freeze({
	project: "/Users/dave/Documents/Projects/switchyard",
	plans: "/Users/dave/Documents/Projects/.plans",
	agent: "/Users/dave/.agent",
});

function hashFile(path) {
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadManifest(manifestPath) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (
		manifest.schemaVersion !== 1 ||
		!manifest.runId ||
		!Array.isArray(manifest.files)
	) {
		throw new Error("invalid cutover manifest");
	}
	return manifest;
}

function targetPath(file) {
	if (!Object.hasOwn(ROOTS, file.root) || typeof file.path !== "string") {
		throw new Error("manifest file is outside the declared roots");
	}
	if (isAbsolute(file.path) || file.path.split("/").includes("..")) {
		throw new Error("manifest file path is not relative");
	}
	const root = resolve(ROOTS[file.root]);
	const target = resolve(root, file.path);
	if (relative(root, target).startsWith("..")) {
		throw new Error("manifest file escapes its declared root");
	}
	return target;
}

function copyPath(manifestPath, file) {
	if (typeof file.copyPath !== "string" || isAbsolute(file.copyPath)) {
		throw new Error("manifest copy path must be relative");
	}
	const cutoverRoot = resolve(dirname(manifestPath));
	const copy = resolve(cutoverRoot, file.copyPath);
	if (relative(cutoverRoot, copy).startsWith("..")) {
		throw new Error("manifest copy path escapes the cutover directory");
	}
	return copy;
}

function verify(manifestPath, phase) {
	const manifest = loadManifest(manifestPath);
	const expectedKey =
		phase === "post" ? "postCutoverSha256" : "preCutoverSha256";
	const drift = [];
	for (const file of manifest.files) {
		const target = targetPath(file);
		const expected = file[expectedKey] ?? null;
		const actual = hashFile(target);
		if (actual !== expected) drift.push(`${file.root}:${file.path}`);
	}
	if (drift.length > 0) {
		console.log(
			`CUTOVER_VERIFY=refused|phase=${phase}|source_drift_count=${drift.length}`,
		);
		console.log(`CUTOVER_VERIFY_PATHS=${drift.join(",")}`);
		return 1;
	}
	console.log(
		`CUTOVER_VERIFY=ok|phase=${phase}|files=${manifest.files.length}`,
	);
	return 0;
}

function rollback(manifestPath, apply, { beforeMutation } = {}) {
	if (beforeMutation !== undefined && typeof beforeMutation !== "function") {
		throw new TypeError("beforeMutation must be a function");
	}
	const manifest = loadManifest(manifestPath);
	const conflicts = [];
	const actions = [];
	for (const file of manifest.files) {
		const target = targetPath(file);
		const current = hashFile(target);
		const expectedPost = file.postCutoverSha256 ?? null;
		const expectedPre = file.preCutoverSha256 ?? null;
		if (expectedPost === expectedPre) continue;
		if (current !== expectedPost) {
			conflicts.push(`${file.root}:${file.path}`);
			continue;
		}
		actions.push({ file, target, current });
	}
	if (conflicts.length > 0) {
		console.log(
			`CUTOVER_ROLLBACK=refused|reason=hash-conflict|count=${conflicts.length}`,
		);
		console.log(`CUTOVER_ROLLBACK_PATHS=${conflicts.join(",")}`);
		return 1;
	}

	const backupConflicts = [];
	for (const { file } of actions) {
		const expectedPre = file.preCutoverSha256 ?? null;
		if (
			expectedPre !== null &&
			hashFile(copyPath(manifestPath, file)) !== expectedPre
		) {
			backupConflicts.push(`${file.root}:${file.path}`);
		}
	}
	if (backupConflicts.length > 0) {
		console.log(
			`CUTOVER_ROLLBACK=refused|reason=backup-hash-mismatch|count=${backupConflicts.length}`,
		);
		console.log(`CUTOVER_ROLLBACK_PATHS=${backupConflicts.join(",")}`);
		return 1;
	}
	console.log(
		`CUTOVER_ROLLBACK=${apply ? "apply" : "dry-run"}|actions=${actions.length}`,
	);
	if (!apply) return 0;

	beforeMutation?.(actions);

	const quarantine = join(
		dirname(manifestPath),
		"rollback-quarantine",
		String(Date.now()),
	);
	for (const { file, target } of actions) {
		const expectedPre = file.preCutoverSha256 ?? null;
		if (hashFile(target) !== (file.postCutoverSha256 ?? null)) {
			console.log("CUTOVER_ROLLBACK=refused|reason=hash-conflict|count=1");
			console.log(`CUTOVER_ROLLBACK_PATHS=${file.root}:${file.path}`);
			return 1;
		}
		if (expectedPre === null) {
			// New transaction files are moved, never deleted, so the rollback is
			// recoverable even when a later review decides to keep one.
			const quarantined = join(quarantine, file.root, file.path);
			const parent = dirname(quarantined);
			if (!existsSync(parent))
				mkdirSync(parent, { recursive: true, mode: 0o700 });
			renameSync(target, quarantined);
			continue;
		}
		const temp = `${target}.${process.pid}.${Date.now()}.rollback.tmp`;
		const backup = copyPath(manifestPath, file);
		copyFileSync(backup, temp);
		try {
			if (hashFile(temp) !== expectedPre) {
				throw new Error(`backup changed during rollback: ${file.path}`);
			}
			if (hashFile(target) !== (file.postCutoverSha256 ?? null)) {
				unlinkSync(temp);
				console.log("CUTOVER_ROLLBACK=refused|reason=hash-conflict|count=1");
				console.log(`CUTOVER_ROLLBACK_PATHS=${file.root}:${file.path}`);
				return 1;
			}
			chmodSync(temp, statSync(backup).mode & 0o777);
			renameSync(temp, target);
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {}
			throw error;
		}
	}
	console.log(`CUTOVER_ROLLBACK=applied|actions=${actions.length}`);
	return 0;
}

function main(argv) {
	const command = argv[0];
	const manifestIndex = argv.indexOf("--manifest");
	const manifestPath = resolve(
		manifestIndex >= 0
			? argv[manifestIndex + 1]
			: join(SCRIPT_DIR, "manifest.json"),
	);
	if (!manifestPath || !existsSync(manifestPath)) {
		console.log("CUTOVER=refused|reason=manifest-missing");
		return 2;
	}
	if (command === "verify")
		return verify(manifestPath, argv.includes("--post") ? "post" : "pre");
	if (command === "rollback")
		return rollback(manifestPath, argv.includes("--apply"));
	console.log("CUTOVER=refused|reason=usage");
	return 2;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
	process.exitCode = main(process.argv.slice(2));
}

export { hashFile, loadManifest, rollback, targetPath, verify };
