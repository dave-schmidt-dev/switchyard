// @test-phase: other
import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	strictEqual,
	throws,
} from "node:assert";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_PHASES,
	defaultRun,
	runPhases,
} from "../scripts/run-test-phases.mjs";
import {
	readTestManifest,
	runLane,
	TEST_PHASES,
} from "../scripts/test-manifest.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON_PATH = resolve(PKG_ROOT, "package.json");

describe("test phase aggregation runner", () => {
	it("derives every lane from one pragma per file and pins the serial and property sets", () => {
		const manifest = readTestManifest(PKG_ROOT);
		deepStrictEqual(manifest.errors, []);
		const all = readdirSync(resolve(PKG_ROOT, "tests"))
			.filter((name) => name.endsWith(".test.mjs"))
			.map((name) => `tests/${name}`)
			.sort();
		deepStrictEqual(manifest.files, all);
		const lanes = TEST_PHASES.flatMap((phase) => manifest.phases[phase]);
		strictEqual(new Set(lanes).size, lanes.length, "lanes must be disjoint");
		deepStrictEqual([...lanes].sort(), all);
		deepStrictEqual(manifest.phases.properties, [
			"tests/mutation-properties.test.mjs",
			"tests/outcome-properties.test.mjs",
		]);
		for (const path of [
			"tests/sandbox-canary.test.mjs",
			"tests/sandbox-canary-install.test.mjs",
			"tests/runner-python-quick-checks-host.test.mjs",
		])
			ok(manifest.phases.serial.includes(path), `serial lane: ${path}`);
		strictEqual(
			createHash("sha256")
				.update(
					JSON.stringify({
						serial: manifest.phases.serial,
						properties: manifest.phases.properties,
					}),
				)
				.digest("hex"),
			// 2026-10-18 (S9): the 82 serial and 2 property files moved from the
			// package.json lists to per-file pragmas; the sets were diffed equal.
			// test:other is every remaining file, so a new file needs no re-pin.
			// (O1 steps 5-7): 38 serial files left with the deleted detached,
			// queue and VM modules; none moved lanes, leaving 44 serial files.
			"3e55cce5b3b9f2965d9b32f237d76952b2ee5d1429852d4c14defacf32097664",
		);
	});

	it("runs each lane as one bounded node --test child under a hermetic env", () => {
		for (const [lane, concurrency] of [
			["serial", "--test-concurrency=1"],
			["other", "--test-concurrency=2"],
		]) {
			let call;
			const status = runLane(lane, {
				root: PKG_ROOT,
				extraArgs: ["--test-name-pattern=x"],
				env: { PATH: process.env.PATH, HOME: "/nonexistent-owner-home" },
				spawn(command, args, options) {
					call = { command, args, options };
					ok(existsSync(options.env.HOME));
					ok(existsSync(options.env.TMPDIR));
					return { status: 0 };
				},
			});
			strictEqual(status, 0);
			strictEqual(call.command, process.execPath);
			const files = readTestManifest(PKG_ROOT).phases[lane];
			deepStrictEqual(call.args, [
				"--test",
				concurrency,
				"--test-reporter=tap",
				"--test-name-pattern=x",
				...files,
			]);
			strictEqual(call.options.stdio, "inherit");
			notStrictEqual(call.options.env.HOME, "/nonexistent-owner-home");
			strictEqual(existsSync(call.options.env.HOME), false, "env removed");
		}
	});

	it("refuses a lane before spawning when a test file lacks its pragma", () => {
		const root = tempDir("switchyard-manifest-");
		try {
			mkdirSync(resolve(root, "tests"));
			writeFileSync(
				resolve(root, "tests/a.test.mjs"),
				"// @test-phase: serial\n",
			);
			writeFileSync(resolve(root, "tests/b.test.mjs"), "import 'x';\n");
			writeFileSync(
				resolve(root, "tests/c.test.mjs"),
				"// @test-phase: fast\n",
			);
			const logs = [];
			let spawned = false;
			const status = runLane("other", {
				root,
				log: (line) => logs.push(line),
				spawn() {
					spawned = true;
					return { status: 0 };
				},
			});
			strictEqual(status, 1);
			strictEqual(spawned, false);
			deepStrictEqual(
				logs.map((line) => line.split(":")[1].trim()),
				["tests/b.test.mjs", "tests/c.test.mjs"],
			);
			strictEqual(runLane("properties", { root, log: () => {} }), 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps package.json lane scripts on the generated manifest", () => {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
		strictEqual(
			pkg.scripts["test:serial"],
			"node scripts/test-manifest.mjs --run serial",
		);
		strictEqual(
			pkg.scripts["test:other"],
			"node scripts/test-manifest.mjs --run other",
		);
	});

	it("cleans the isolated account directory after a process error", () => {
		let accountDirectory;
		throws(
			() =>
				defaultRun("test:serial", {
					env: {},
					spawn(_command, _args, options) {
						accountDirectory = options.env.SWITCHYARD_ACCOUNT_ROOT;
						return { error: new Error("phase spawn failed") };
					},
				}),
			/phase spawn failed/u,
		);
		ok(accountDirectory);
		strictEqual(existsSync(accountDirectory), false);
	});

	it("keeps live serial phase stdio inherited and returns the phase status", () => {
		let spawnOptions;
		const status = defaultRun("test:serial", {
			spawn: (_command, _args, options) => {
				spawnOptions = options;
				return { status: 0, stdout: "", stderr: "" };
			},
		});
		strictEqual(spawnOptions.stdio, "inherit");
		strictEqual(status, 0);
	});

	it("executes both phases and reports the failed phase for either failure order", () => {
		for (const failedPhase of DEFAULT_PHASES) {
			const executed = [];
			const logs = [];
			const status = runPhases({
				run(phase) {
					executed.push(phase);
					return phase === failedPhase ? 9 : 0;
				},
				log: (message) => logs.push(message),
			});
			deepStrictEqual(executed, DEFAULT_PHASES);
			strictEqual(status, 9);
			ok(logs[0].includes(`${failedPhase} (exit 9)`));
		}
	});

	it("proves the second phase still runs when the first phase exits non-zero", () => {
		const executed = [];
		const phases = ["test:serial", "test:other"];
		const logs = [];

		const exitCode = runPhases({
			phases,
			run(phase) {
				executed.push(phase);
				if (phase === "test:serial") {
					return 1;
				}
				return 0;
			},
			log(msg) {
				logs.push(msg);
			},
		});

		deepStrictEqual(executed, ["test:serial", "test:other"]);
		strictEqual(exitCode, 1);
	});

	it("proves the aggregated status is the first non-zero phase status, and 0 only when every phase exits 0", () => {
		// All phases exit 0 -> 0
		const allPass = runPhases({
			phases: ["phase-a", "phase-b"],
			run: () => 0,
			log: () => {},
		});
		strictEqual(allPass, 0);

		// First phase fails (status 2), second succeeds (status 0) -> returns 2
		const firstFails = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-a" ? 2 : 0),
			log: () => {},
		});
		strictEqual(firstFails, 2);

		// First phase succeeds (status 0), second fails (status 3) -> returns 3
		const secondFails = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-b" ? 3 : 0),
			log: () => {},
		});
		strictEqual(secondFails, 3);

		// Both phases fail with different codes (status 4 then status 5) -> returns first non-zero (4)
		const bothFail = runPhases({
			phases: ["phase-a", "phase-b"],
			run: (phase) => (phase === "phase-a" ? 4 : 5),
			log: () => {},
		});
		strictEqual(bothFail, 4);

		// Multiple phases: third phase fails
		const multiPhase = runPhases({
			phases: ["p1", "p2", "p3", "p4"],
			run: (phase) => (phase === "p3" ? 7 : 0),
			log: () => {},
		});
		strictEqual(multiPhase, 7);
	});

	it("asserts the summary output contains an exit status entry for test:serial and one for test:other", () => {
		const logs = [];
		runPhases({
			phases: ["test:serial", "test:other"],
			run: (phase) => (phase === "test:serial" ? 0 : 1),
			log: (msg) => logs.push(msg),
		});

		strictEqual(logs.length, 1);
		const summary = logs[0];

		ok(
			summary.includes("test:serial"),
			`summary must contain test:serial entry: ${summary}`,
		);
		ok(
			summary.includes("test:other"),
			`summary must contain test:other entry: ${summary}`,
		);
		ok(
			/test:serial[^\n,]*(?:exit\s+0|\b0\b)/.test(summary),
			`summary must report exit status for test:serial: ${summary}`,
		);
		ok(
			/test:other[^\n,]*(?:exit\s+1|\b1\b)/.test(summary),
			`summary must report exit status for test:other: ${summary}`,
		);
	});

	it("defaults to DEFAULT_PHASES (test:serial and test:other)", () => {
		deepStrictEqual(DEFAULT_PHASES, ["test:serial", "test:other"]);

		const executed = [];
		runPhases({
			run: (phase) => {
				executed.push(phase);
				return 0;
			},
			log: () => {},
		});

		deepStrictEqual(executed, ["test:serial", "test:other"]);
	});

	it("verifies package.json test script equals node scripts/run-test-phases.mjs and contains no &&", () => {
		const rawPkg = readFileSync(PACKAGE_JSON_PATH, "utf8");
		const pkg = JSON.parse(rawPkg);

		strictEqual(
			pkg.scripts.test,
			"node scripts/run-test-phases.mjs",
			"package.json test script must equal 'node scripts/run-test-phases.mjs'",
		);
		ok(
			!pkg.scripts.test.includes("&&"),
			"package.json test script must not contain '&&'",
		);
		ok(
			typeof pkg.scripts["test:serial"] === "string" &&
				pkg.scripts["test:serial"].length > 0,
			"test:serial script must remain defined",
		);
		ok(
			typeof pkg.scripts["test:other"] === "string" &&
				pkg.scripts["test:other"].length > 0,
			"test:other script must remain defined",
		);
	});
});
