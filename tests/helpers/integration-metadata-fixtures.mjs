// Shared fixtures for the INV-2 git-apply metadata seam regressions.
//
// Each scenario spawns a real runner child process that imports the real
// integration module, shortens the metadata command timeout through the
// trusted test seam, and calls validateDiff or integrationGate while a fake
// `git` executable — itself a real subprocess — sits first on the runner's
// PATH. The fake can stall past SIGTERM, exit nonzero with plausible partial
// output, die by signal, or overflow the output bound. Only the runner
// child's environment is modified; the test process never touches PATH or
// the environment, so nothing leaks across suites. Every artifact lives in a
// tracked temp directory under $TMPDIR.

import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tempDir } from "./tempdir.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INTEGRATE_MODULE_URL = pathToFileURL(
	join(REPOSITORY_ROOT, "src", "switchyard", "integrate", "index.mjs"),
).href;
const DIFF_VALIDATION_MODULE_URL = pathToFileURL(
	join(
		REPOSITORY_ROOT,
		"src",
		"switchyard",
		"integrate",
		"diff-validation.mjs",
	),
).href;

const RESULT_MARKER = "===SWITCHYARD_METADATA_RESULT===";

// The fake git confirms its SIGTERM handler (marker file) before it stalls,
// so a timeout implementation that relied on SIGTERM would leave it alive
// and trip the scenario watchdog. Only the production SIGKILL can reap it.
// The direct child is what these scenarios prove dead; no claim is made
// about detached descendants.
const FAKE_GIT = `#!/usr/bin/env node
import { appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dir = process.env.SWITCHYARD_FAKE_GIT_DIR ?? "";
const isNumstat = argv.includes("--numstat");
const isSummary = argv.includes("--summary");
const mode = isNumstat
	? process.env.SWITCHYARD_FAKE_GIT_NUMSTAT ?? "ok"
	: isSummary
		? process.env.SWITCHYARD_FAKE_GIT_SUMMARY ?? "ok"
		: "unhandled";
const mark = (name, text) => {
	if (dir !== "") appendFileSync(join(dir, name), text);
};
const plausible = () => {
	if (isNumstat) {
		return process.env.SWITCHYARD_FAKE_GIT_NUMSTAT_OUTPUT ?? "1\\t1\\ttest.txt\\n";
	}
	return process.env.SWITCHYARD_FAKE_GIT_SUMMARY_OUTPUT ?? "";
};

process.on("SIGTERM", () => {
	mark("term", "term\\n");
});
mark(
	isNumstat ? "ready-numstat" : isSummary ? "ready-summary" : "ready-other",
	String(process.pid) + "\\n",
);
await new Promise((resolve) => {
	process.stdin.on("data", () => {});
	process.stdin.once("end", resolve);
	process.stdin.resume();
});
if (mode === "stall") {
	setInterval(() => {}, 1000);
} else if (mode === "overflow-stdout" || mode === "overflow-stderr") {
	const chunk = Buffer.alloc(1024 * 1024, mode === "overflow-stdout" ? 0x78 : 0x79);
	for (let index = 0; index < 9; index += 1) {
		writeSync(mode === "overflow-stdout" ? 1 : 2, chunk);
	}
	process.exit(0);
} else if (mode === "signal") {
	process.stdout.write(plausible());
	process.kill(process.pid, "SIGKILL");
} else if (mode.startsWith("nonzero")) {
	process.stdout.write(plausible());
	if (mode === "nonzero-corrupt") {
		process.stderr.write("error: corrupt patch at line 3\\n");
	}
	if (mode === "nonzero-conflict") {
		process.stderr.write("error: test.txt: patch does not apply\\n");
	}
	process.exit(1);
} else if (mode === "ok") {
	process.stdout.write(plausible());
	process.exit(0);
} else {
	process.exit(1);
}
`;

function buildRunner(scenario) {
	return `#!/usr/bin/env node
import { readFileSync } from "node:fs";

process.env.PATH = ${JSON.stringify(scenario.binDir + (scenario.fakeGitSpawnFailure ? "" : `:${process.env.PATH}`))};
process.env.SWITCHYARD_FAKE_GIT_DIR = ${JSON.stringify(scenario.markerDir)};
process.env.SWITCHYARD_FAKE_GIT_NUMSTAT = ${JSON.stringify(scenario.numstatMode)};
process.env.SWITCHYARD_FAKE_GIT_SUMMARY = ${JSON.stringify(scenario.summaryMode)};
process.env.SWITCHYARD_FAKE_GIT_NUMSTAT_OUTPUT = ${JSON.stringify(scenario.numstatOutput)};
process.env.SWITCHYARD_FAKE_GIT_SUMMARY_OUTPUT = ${JSON.stringify(scenario.summaryOutput)};
const integrate = await import(${JSON.stringify(INTEGRATE_MODULE_URL)});
const metadata = await import(${JSON.stringify(DIFF_VALIDATION_MODULE_URL)});
metadata.setMetadataCommandTimeoutForTests(${JSON.stringify(scenario.timeoutMs)});
const patch = readFileSync(${JSON.stringify(scenario.patchFile)}, "utf8");
let result;
if (${JSON.stringify(scenario.call)} === "integrationGate") {
	result = integrate.integrationGate(
		patch,
		${JSON.stringify(scenario.projectPath)},
		${JSON.stringify(scenario.gateOptions)},
	);
} else {
	result = integrate.validateDiff(patch, ${JSON.stringify(scenario.projectPath)});
}
process.stdout.write(\`\\n${RESULT_MARKER}\\n\${JSON.stringify(result)}\\n\`);
`;
}

// Records each fake git child's pid and whether it was still alive when the
// runner returned — before any cleanup — so tests can prove the production
// timeout reaped the direct child itself.
function readReadyPids(markerDir) {
	const entries = {};
	for (const [file, phase] of [
		["ready-numstat", "numstat"],
		["ready-summary", "summary"],
		["ready-other", "other"],
	]) {
		const markerPath = join(markerDir, file);
		if (!existsSync(markerPath)) continue;
		const pid = Number(readFileSync(markerPath, "utf8").trim());
		if (!Number.isInteger(pid) || pid <= 0) continue;
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		entries[phase] = { pid, alive };
	}
	return entries;
}

/**
 * Run one metadata scenario in an isolated runner child with an independent
 * outer watchdog. Resolves with the runner's exit status, its parsed result,
 * whether the watchdog fired, the fake git children's ready/reaped state,
 * and whether the fake git ever received a SIGTERM.
 */
export async function runMetadataScenario({
	patch,
	projectPath,
	numstatMode = "ok",
	summaryMode = "ok",
	numstatOutput = "1\t1\ttest.txt\n",
	summaryOutput = "",
	timeoutMs = 5000,
	call = "validateDiff",
	gateOptions = {},
	watchdogMs = 20000,
	fakeGitSpawnFailure = false,
}) {
	const dir = tempDir("switchyard-metadata-");
	const markerDir = join(dir, "markers");
	const binDir = join(dir, "bin");
	mkdirSync(markerDir);
	mkdirSync(binDir);
	const scriptPath = join(dir, "fake-git.mjs");
	writeFileSync(scriptPath, FAKE_GIT);
	writeFileSync(
		join(binDir, "git"),
		fakeGitSpawnFailure
			? "#!/switchyard-test-missing-interpreter\n"
			: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`,
		{ mode: 0o755 },
	);
	const patchFile = join(dir, "patch.diff");
	writeFileSync(patchFile, patch);
	const runnerPath = join(dir, "runner.mjs");
	writeFileSync(
		runnerPath,
		buildRunner({
			binDir,
			markerDir,
			numstatMode,
			summaryMode,
			numstatOutput,
			summaryOutput,
			timeoutMs,
			projectPath,
			patchFile,
			call,
			gateOptions,
			fakeGitSpawnFailure,
		}),
	);

	const child = spawn(process.execPath, [runnerPath], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	let watchdogFired = false;
	const watchdog = setTimeout(() => {
		watchdogFired = true;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The process group may already be gone.
		}
	}, watchdogMs);
	const exit = await new Promise((resolve) => {
		child.once("error", (error) =>
			resolve({ code: null, signal: null, error }),
		);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	clearTimeout(watchdog);

	// Unconditional process-group cleanup: a broken implementation can leave
	// a fake git child holding the runner's pipes open. The independent outer
	// watchdog and this cleanup both kill the whole isolated group.
	const readyPids = readReadyPids(markerDir);
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The process group may already be gone.
	}

	const markerIndex = stdout.indexOf(`\n${RESULT_MARKER}\n`);
	const result =
		markerIndex === -1
			? null
			: JSON.parse(stdout.slice(markerIndex + RESULT_MARKER.length + 2).trim());
	return {
		code: exit.code,
		signal: exit.signal,
		error: exit.error ?? null,
		stderr,
		result,
		watchdogFired,
		readyPids,
		nonmetadataGitInvoked: existsSync(join(markerDir, "ready-other")),
		termReceived: existsSync(join(markerDir, "term")),
	};
}

/** Snapshot the host project's HEAD, index, tracked, and untracked state. */
export function hostState(projectPath) {
	const run = (args) =>
		execFileSync("git", args, {
			cwd: projectPath,
			encoding: "utf8",
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
	const indexPath = run(["rev-parse", "--git-path", "index"]).trim();
	const absoluteIndexPath = indexPath.startsWith("/")
		? indexPath
		: join(projectPath, indexPath);
	const paths = run([
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
	])
		.split("\0")
		.filter(Boolean)
		.sort();
	const files = Object.fromEntries(
		paths.map((path) => {
			const absolutePath = join(projectPath, path);
			const stat = lstatSync(absolutePath);
			return [
				path,
				stat.isSymbolicLink()
					? {
							type: "symlink",
							mode: stat.mode & 0o777,
							target: readlinkSync(absolutePath),
						}
					: {
							type: "file",
							mode: stat.mode & 0o777,
							bytes: readFileSync(absolutePath).toString("base64"),
						},
			];
		}),
	);
	return {
		head: run(["rev-parse", "HEAD"]).trim(),
		index: readFileSync(absoluteIndexPath).toString("base64"),
		files,
	};
}
