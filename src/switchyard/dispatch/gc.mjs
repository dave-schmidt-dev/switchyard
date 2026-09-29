import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getStateRoot,
	readRun,
	VALID_WORKTREE_STATES,
} from "../run-store/index.mjs";
import {
	scanSimpleWorktreeOpenHandles,
	simpleQuarantinePath,
} from "../simple/worktree-cleanup.mjs";
import { parseGcArgs, withStateRoot } from "./cli-args.mjs";
import { USAGE_GC } from "./cli-usage.mjs";
import {
	applyRecordedSimpleCleanup,
	assessGcRootBeforeOpenScan,
	isFixture,
} from "./gc-roots.mjs";

const GC_PRIVATE_BYTES_UNAVAILABLE = Object.freeze({
	bytes: null,
	measurable: false,
	unavailableReason: "private_bytes_unavailable",
});
async function defaultMeasureApfsPrivateBytes(
	paths,
	options = {},
	dependencies = {},
) {
	if (!paths || paths.length === 0) {
		return { status: "ok", roots: {} };
	}

	const scriptPath =
		dependencies.scriptPath ??
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"..",
			"scripts",
			"apfs-private-bytes.py",
		);

	const pythonBin = dependencies.pythonBin ?? "/usr/bin/python3";
	const timeoutMs = options.timeoutMs ?? 15_000;
	const termGraceMs = options.termGraceMs ?? 2_000;
	const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
	const maxFiles = options.maxFiles ?? 100_000;
	const stderrStream = dependencies.stderr ?? process.stderr;
	const spawnFn = dependencies.spawnFn ?? spawn;

	return new Promise((resolveResult) => {
		const useStdin = paths.length > 50;
		const args = [
			scriptPath,
			"--max-files",
			String(maxFiles),
			...(useStdin ? ["--stdin"] : paths),
		];

		let child;
		try {
			child = spawnFn(pythonBin, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			return resolveResult({ status: "error", error: err.message, roots: {} });
		}

		const stdoutChunks = [];
		let stdoutBytes = 0;
		let timedOut = false;
		let outputExceeded = false;
		let settled = false;
		let escalationTimer = null;

		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (escalationTimer) clearTimeout(escalationTimer);
			resolveResult(result);
		};

		const stopHelper = () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			escalationTimer ??= setTimeout(() => {
				try {
					if (!settled) child.kill("SIGKILL");
				} catch {}
			}, termGraceMs);
			escalationTimer.unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stopHelper();
		}, timeoutMs);

		child.stdin?.on?.("error", () => {});
		if (useStdin && child.stdin) {
			try {
				child.stdin.end(JSON.stringify(paths));
			} catch {}
		} else if (child.stdin) {
			try {
				child.stdin.end();
			} catch {}
		}

		if (child.stdout) {
			child.stdout.on("data", (chunk) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				stdoutBytes += bytes.length;
				if (stdoutBytes > maxOutputBytes) {
					outputExceeded = true;
					stopHelper();
					return;
				}
				stdoutChunks.push(bytes);
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (chunk) => {
				try {
					stderrStream.write(chunk);
				} catch {}
			});
		}

		child.on("error", (err) => {
			finish({ status: "error", error: err.message, roots: {} });
		});

		child.on("close", (code) => {
			if (outputExceeded) {
				return finish({ status: "output_exceeded", roots: {} });
			}
			if (timedOut) {
				return finish({ status: "timeout", roots: {} });
			}
			if (code !== 0) {
				return finish({ status: "error", exitCode: code, roots: {} });
			}
			try {
				const parsed = JSON.parse(
					Buffer.concat(stdoutChunks).toString("utf8").trim(),
				);
				finish(parsed);
			} catch (err) {
				finish({ status: "parse_error", error: err.message, roots: {} });
			}
		});
	});
}
async function collectGcInventory(options = {}, dependencies = {}) {
	const realpath = dependencies.realpathSync ?? realpathSync;
	const readDirectory = dependencies.readdir ?? readdir;
	const stat = dependencies.lstat ?? lstat;
	const canonicalParent = async (path, recorded = false) => {
		try {
			const canonical = realpath(path);
			if (
				!isAbsolute(canonical) ||
				(recorded && canonical !== path) ||
				!(await stat(canonical)).isDirectory() ||
				realpath(canonical) !== canonical
			)
				throw new Error();
			return canonical;
		} catch {
			throw new Error(
				"gc inventory unavailable: parent_canonicalization_failed",
			);
		}
	};
	const stateRoot = options.stateRoot ?? getStateRoot();
	const runsDir = resolve(stateRoot, "runs");
	const osTemp =
		typeof dependencies.tmpdir === "function"
			? dependencies.tmpdir()
			: (dependencies.tmpdir ?? tmpdir());
	const parents = new Set([await canonicalParent(osTemp)]);
	const records = new Map();
	const unavailableRoots = [];
	const readRunFn =
		dependencies.readRun ??
		((id) => withStateRoot(stateRoot, () => readRun(id)));

	let runEntries;
	try {
		runEntries = await readDirectory(runsDir, { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		runEntries = [];
	}
	for (const entry of runEntries) {
		if (!entry.isDirectory() || !/^[\w-]+$/.test(entry.name)) continue;
		let run;
		try {
			run = await readRunFn(entry.name);
		} catch {
			continue;
		}
		const wt = run?.worktree;
		if (
			typeof wt?.canonicalParent !== "string" ||
			!isAbsolute(wt.canonicalParent) ||
			typeof wt.candidateChild !== "string" ||
			!/^switchyard-(?:simple|quarantine)-/.test(wt.candidateChild) ||
			wt.candidateChild.includes("/") ||
			wt.candidateChild.includes("\\") ||
			!VALID_WORKTREE_STATES.has(wt.state)
		)
			continue;
		let parent;
		try {
			parent = await canonicalParent(wt.canonicalParent, true);
		} catch {
			// An old parent may have been removed or replaced. Preserve the
			// record without claiming that its child is absent.
			unavailableRoots.push({
				path: join(wt.canonicalParent, wt.candidateChild),
				canonicalParent: wt.canonicalParent,
				candidateChild: wt.candidateChild,
				classification: "unavailable",
				runId: run.runId,
				recordedState: wt.state,
				exists: null,
				...GC_PRIVATE_BYTES_UNAVAILABLE,
				unavailableReason: "parent_canonicalization_failed",
				deletionEligible: false,
				pathAmbiguity: true,
			});
			continue;
		}
		parents.add(parent);
		const path = join(parent, wt.candidateChild);
		records.set(path, [...(records.get(path) ?? []), run]);
		if (wt.state !== "removed" && typeof wt.nonce === "string") {
			try {
				const quarantine = simpleQuarantinePath(wt.nonce);
				if (
					quarantine !== path &&
					(dependencies.existsSync ?? existsSync)(quarantine)
				) {
					records.set(quarantine, [...(records.get(quarantine) ?? []), run]);
					parents.add("/private/tmp");
				}
			} catch {}
		}
	}

	const roots = [...unavailableRoots];
	const seen = new Set();
	for (const parent of parents) {
		// Recheck before enumeration; unreadable or replaced parents cannot prove absence.
		await canonicalParent(parent, true);
		const entries = await readDirectory(parent, { withFileTypes: true });
		for (const entry of entries) {
			if (
				!/^switchyard-(?:simple|quarantine)-/.test(entry.name) ||
				(!entry.isDirectory() && !entry.isSymbolicLink())
			)
				continue;
			const path = join(parent, entry.name);
			seen.add(path);
			let pathAmbiguity = true;
			try {
				pathAmbiguity =
					entry.isSymbolicLink() ||
					(await stat(path)).isSymbolicLink() ||
					realpath(path) !== path;
			} catch {
				// An unresolved child is unavailable, never silently canonicalized.
			}
			const claims = records.get(path) ?? [];
			const run = claims.length === 1 ? claims[0] : null;
			const conflictingClaims = claims.length > 1;
			const fixture = isFixture(
				entry.name,
				run,
				pathAmbiguity ? null : path,
				dependencies.existsSync ?? existsSync,
			);
			const classification = conflictingClaims
				? "conflicting-records"
				: fixture
					? "fixture"
					: run
						? run.worktree.state === "removed"
							? "removed-but-exists"
							: "recorded"
						: "unknown";
			roots.push({
				path,
				canonicalParent: parent,
				candidateChild: entry.name,
				classification,
				runId: run?.runId ?? null,
				...(conflictingClaims
					? { runIds: claims.map((claim) => claim.runId).sort() }
					: {}),
				recordedState: run?.worktree.state ?? null,
				exists: true,
				...GC_PRIVATE_BYTES_UNAVAILABLE,
				unavailableReason: conflictingClaims
					? "conflicting_records"
					: pathAmbiguity
						? "path_ambiguity"
						: "private_bytes_unavailable",
				deletionEligible: false,
				pathAmbiguity: pathAmbiguity || conflictingClaims,
			});
		}
	}
	for (const [path, claims] of records) {
		if (seen.has(path)) continue;
		const run = claims.length === 1 ? claims[0] : null;
		if (run?.worktree.state === "removed") continue;
		const conflictingClaims = claims.length > 1;
		roots.push({
			path,
			canonicalParent: claims[0].worktree.canonicalParent,
			candidateChild: claims[0].worktree.candidateChild,
			classification: conflictingClaims ? "conflicting-records" : "missing",
			runId: run?.runId ?? null,
			...(conflictingClaims
				? { runIds: claims.map((claim) => claim.runId).sort() }
				: {}),
			recordedState: run?.worktree.state ?? null,
			exists: conflictingClaims ? null : false,
			...GC_PRIVATE_BYTES_UNAVAILABLE,
			...(conflictingClaims
				? { unavailableReason: "conflicting_records" }
				: {}),
			deletionEligible: false,
			pathAmbiguity: conflictingClaims,
		});
	}
	roots.sort((a, b) => a.path.localeCompare(b.path));

	if (options.measureBytes) {
		const candidateRoots = roots.filter(
			(r) =>
				r.exists === true &&
				!r.pathAmbiguity &&
				r.canonicalParent &&
				r.candidateChild,
		);
		if (candidateRoots.length > 0) {
			const measureFn =
				dependencies.measurePrivateBytes ?? defaultMeasureApfsPrivateBytes;
			let measurementResult = null;
			try {
				measurementResult = await measureFn(
					candidateRoots.map((r) => r.path),
					options,
					dependencies,
				);
			} catch {
				measurementResult = { status: "error", roots: {} };
			}
			const measuredRoots = measurementResult?.roots ?? {};
			for (const root of candidateRoots) {
				const m = measuredRoots[root.path];
				if (m && m.measurable === true && typeof m.bytes === "number") {
					root.bytes = m.bytes;
					root.measurable = true;
					root.unavailableReason = null;
				} else {
					root.bytes = null;
					root.measurable = false;
					root.unavailableReason =
						m?.unavailableReason ?? "private_bytes_unavailable";
				}
			}
		}
	}
	if (options.checkEligibility) {
		const potentiallyEligible = [];
		for (const root of roots) {
			const claims = records.get(root.path) ?? [];
			const assessment = await assessGcRootBeforeOpenScan(
				root,
				claims.length === 1 ? claims[0] : null,
				dependencies,
			);
			root.deletionEligible = assessment.eligible;
			root.eligibilityReason = assessment.reason;
			if (assessment.eligible) potentiallyEligible.push(root);
		}
		if (potentiallyEligible.length > 0) {
			const scan = await (
				dependencies.scanOpenHandles ?? scanSimpleWorktreeOpenHandles
			)(
				potentiallyEligible.map((root) => root.path),
				dependencies.onStatus,
			);
			for (const root of potentiallyEligible) {
				if (!scan.complete || scan.openPaths.includes(root.path)) {
					root.deletionEligible = false;
					root.eligibilityReason = scan.complete
						? "open_handles"
						: "open_handle_scan_unavailable";
				}
			}
		}
	}

	const byClass = Object.fromEntries(
		[
			"recorded",
			"unknown",
			"fixture",
			"missing",
			"removed-but-exists",
			"unavailable",
			"conflicting-records",
		].map((name) => [name, { count: 0, ...GC_PRIVATE_BYTES_UNAVAILABLE }]),
	);

	let totalMeasuredBytes = 0;
	let allComplete = roots.length > 0;
	const classComplete = Object.fromEntries(
		Object.keys(byClass).map((name) => [name, true]),
	);

	for (const root of roots) {
		const cls = byClass[root.classification];
		cls.count += 1;
		if (root.measurable === true && typeof root.bytes === "number") {
			totalMeasuredBytes += root.bytes;
			cls.bytes = (cls.bytes ?? 0) + root.bytes;
		} else {
			allComplete = false;
			classComplete[root.classification] = false;
		}
	}
	for (const [name, cls] of Object.entries(byClass)) {
		if (cls.count > 0 && classComplete[name]) {
			cls.measurable = true;
			cls.unavailableReason = null;
		} else {
			cls.bytes = null;
			cls.measurable = false;
			cls.unavailableReason = "private_bytes_unavailable";
		}
	}

	return {
		schemaVersion: 1,
		canonicalParents: [...parents].sort(),
		roots,
		summary: {
			totalRoots: roots.length,
			byClass,
			totalBytes: allComplete ? totalMeasuredBytes : null,
			measurable: allComplete,
			unavailableReason: allComplete ? null : "private_bytes_unavailable",
		},
	};
}
async function handleGc(argv, dependencies = {}) {
	const { apply, help, stateRoot } = parseGcArgs(argv);
	if (help) {
		console.log(USAGE_GC);
		return;
	}

	const effectiveStateRoot = stateRoot ?? getStateRoot();
	return withStateRoot(effectiveStateRoot, async () => {
		const gcDependencies = {
			...dependencies,
			onStatus:
				dependencies.onStatus ?? ((event) => console.error(`[gc] ${event}`)),
		};
		console.error("[gc] Reading run records and direct temp children");
		const inventory = await collectGcInventory(
			{
				stateRoot: effectiveStateRoot,
				measureBytes: true,
				checkEligibility: true,
			},
			gcDependencies,
		);
		if (apply) {
			inventory.apply = { attempted: 0, removed: 0, results: [] };
			for (const root of inventory.roots.filter(
				(candidate) => candidate.deletionEligible,
			)) {
				console.error(`[gc] Checking recorded root ${root.runId}`);
				const result = await applyRecordedSimpleCleanup(root, gcDependencies);
				inventory.apply.attempted += 1;
				if (result.disposition === "removed") inventory.apply.removed += 1;
				inventory.apply.results.push(result);
			}
		}
		console.log(JSON.stringify(inventory));
		process.exitCode = 0;
		return inventory;
	});
}

export { collectGcInventory, defaultMeasureApfsPrivateBytes, handleGc };
