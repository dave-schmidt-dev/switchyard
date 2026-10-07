import { ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	parseSimpleArgs,
	SimpleUsageError,
} from "../src/switchyard/simple/args.mjs";
import { validateCheckCommand } from "../src/switchyard/simple/check-validation.mjs";
import { handleSimple } from "../src/switchyard/simple/cli.mjs";
import { classifySimpleErrorKind } from "../src/switchyard/simple/reliability.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// handleSimple writes invocation failure records; keep them out of the real
// state root.
process.env.SWITCHYARD_RUN_STORE_ROOT ??= tempDir("simple-cli-state-");

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const PROJECT_PATH = "/Users/switchyard/project";
const GRAMMAR_PREFIX =
	"--check uses unsupported shell grammar ($(...), backticks, unbalanced quote or $/backslash in command position): ";

function rejection(command) {
	try {
		validateCheckCommand(command, PROJECT_PATH);
	} catch (error) {
		return error;
	}
	throw new Error(`expected rejection: ${command}`);
}

function createFixture() {
	const root = realpathSync(tempDir("simple-check-validation-"));
	const projectPath = join(root, "project");
	mkdirSync(projectPath);
	writeFileSync(join(projectPath, "src.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: projectPath });
	execFileSync("git", ["add", "-A"], { cwd: projectPath });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Switchyard Tests",
			"-c",
			"user.email=switchyard@example.invalid",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: projectPath },
	);
	const promptPath = join(root, "prompt.txt");
	writeFileSync(promptPath, "Change src.txt\n");
	return { projectPath, promptPath };
}

function dispatchArgs(fixture) {
	return [
		fixture.promptPath,
		"--project",
		fixture.projectPath,
		"--capability",
		"standard",
		"--file",
		"src.txt",
		"--deadline",
		"1970-01-01T00:10:00Z",
	];
}

function parseRejection(argv) {
	try {
		parseSimpleArgs(argv, { now: () => 1_000 });
	} catch (error) {
		return error;
	}
	throw new Error("expected parseSimpleArgs to throw");
}

describe("simple check validation", () => {
	it("rejects shell expansion with the exact usage message", () => {
		const command = "git log --format='%H' $(pwd)";
		const error = rejection(command);
		ok(error instanceof SimpleUsageError);
		strictEqual(error.message, `${GRAMMAR_PREFIX}${command}`);
	});

	it("rejects backticks, unbalanced quotes and command-position escapes", () => {
		for (const command of ["echo `pwd`", "echo 'unterminated", "\\make lint"]) {
			const error = rejection(command);
			ok(error instanceof SimpleUsageError, command);
			strictEqual(
				error.message,
				`${GRAMMAR_PREFIX}${command.slice(0, 80)}`,
				command,
			);
		}
	});

	it("truncates the grammar message to the first 80 characters", () => {
		const command = `echo $(pwd) ${"x".repeat(120)}`;
		const error = rejection(command);
		ok(error instanceof SimpleUsageError);
		strictEqual(error.message, `${GRAMMAR_PREFIX}${command.slice(0, 80)}`);
	});

	it("rejects absolute host paths outside the clone", () => {
		for (const word of [
			"/tmp/host-check.sh",
			"/Users/switchyard/bin/check.sh",
			"/var/folders/ab/T/check.sh",
			"/private/var/folders/ab/T/check.sh",
		]) {
			const error = rejection(word);
			strictEqual(error.code, "check_out_of_clone_exec", word);
			ok(error.message.includes(word), word);
		}
		const error = rejection("bash /tmp/host-check.sh");
		strictEqual(error.code, "check_out_of_clone_exec");
		ok(error.message.includes("/tmp/host-check.sh"));
	});

	it("accepts project .venv and node_modules absolute paths", () => {
		validateCheckCommand(
			`${PROJECT_PATH}/.venv/bin/python -m pytest`,
			PROJECT_PATH,
		);
		validateCheckCommand(
			`${PROJECT_PATH}/node_modules/.bin/mocha`,
			PROJECT_PATH,
		);
	});

	it("rejects denied host tools", () => {
		for (const [command, tool] of [
			["xcodebuild test -scheme App", "xcodebuild test"],
			["simctl list devices", "simctl"],
			["xcrun simctl boot 1234", "xcrun simctl"],
			["codesign -s identity App.app", "codesign"],
			["security find-identity -v", "security"],
		]) {
			const error = rejection(command);
			strictEqual(error.code, "check_tool_denied", command);
			ok(error.message.includes(tool), command);
		}
	});

	it("rejects absolute /usr/bin toolchain paths and suggests the bare name", () => {
		for (const name of ["git", "python3", "make", "swiftc", "xcrun"]) {
			const error = rejection(`/usr/bin/${name} --version`);
			strictEqual(error.code, "check_tool_denied", name);
			ok(error.message.includes(`(${name})`), name);
		}
	});

	it("accepts supported relative check commands", () => {
		for (const command of [
			".venv/bin/python -m pytest",
			"node --test tests/x.test.mjs",
			"make lint",
			"xcrun swiftc -parse check.swift",
			"xcodebuild -version",
		]) {
			validateCheckCommand(command, PROJECT_PATH);
		}
	});

	it("classifies both rejection codes as validation failures", () => {
		for (const code of ["check_out_of_clone_exec", "check_tool_denied"]) {
			strictEqual(
				classifySimpleErrorKind(code, "preflight"),
				"validation_failed",
			);
		}
	});

	it("rejects unsupported shell grammar at --check parse", () => {
		const fixture = createFixture();
		const error = parseRejection([
			...dispatchArgs(fixture),
			"--check",
			"echo $(pwd)",
		]);
		ok(error instanceof SimpleUsageError);
	});

	it("rejects an out-of-clone baseline check at parse", () => {
		const fixture = createFixture();
		const error = parseRejection([
			...dispatchArgs(fixture),
			"--check",
			"make lint",
			"--baseline-check",
			"/tmp/outside.sh",
		]);
		strictEqual(error.code, "check_out_of_clone_exec");
		ok(error.message.includes("/tmp/outside.sh"));
	});

	it("reports a coded rejection as invalid_invocation with its preflight code", async () => {
		const fixture = createFixture();
		let result;
		let stderr = "";
		await handleSimple(
			[...dispatchArgs(fixture), "--check", "/tmp/outside.sh"],
			{
				now: () => 1_000,
				signalProcess: new EventEmitter(),
				writeStderr: (text) => {
					stderr += text;
				},
				writeResult: (value) => {
					result = JSON.parse(value);
				},
			},
		);
		strictEqual(result.failureReason, "invalid_invocation");
		strictEqual(result.errorKind, "validation_failed");
		strictEqual(result.preflightCode, "check_out_of_clone_exec");
		ok(result.usageError.includes("/tmp/outside.sh"));
		ok(stderr.includes("/tmp/outside.sh"));
	});
});
