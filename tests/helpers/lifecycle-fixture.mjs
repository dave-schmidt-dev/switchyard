import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const FIXTURE_AGENT_NAME = "switchyard-test-fixture-agent";

function projectHash(projectPath) {
	return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

export function setupFixtureAgent() {
	try {
		execFileSync("docker", ["rm", "-f", FIXTURE_AGENT_NAME], { stdio: "pipe" });
	} catch {
		/* fixture may not exist yet */
	}
	execFileSync(
		"docker",
		[
			"run",
			"-d",
			"--name",
			FIXTURE_AGENT_NAME,
			"alpine:latest",
			"sleep",
			"infinity",
		],
		{ stdio: "inherit" },
	);
	return FIXTURE_AGENT_NAME;
}

export function teardownFixtureAgent() {
	try {
		execFileSync("docker", ["rm", "-f", "-v", FIXTURE_AGENT_NAME], {
			stdio: "pipe",
		});
	} catch {
		/* already gone */
	}
}

export function createTestWorkingContainer(projectPath, options = {}) {
	const {
		runId,
		image = "alpine:latest",
		labels: extraLabels = {},
		skipVolume = false,
	} = options;
	const containerName = `switchyard-test-${randomUUID().slice(0, 8)}`;

	if (runId && !skipVolume) {
		execFileSync(
			"docker",
			[
				"volume",
				"create",
				"--label",
				"com.zerodelta.switchyard.managed=true",
				"--label",
				`com.zerodelta.switchyard.run_id=${runId}`,
				"--label",
				`com.zerodelta.switchyard.project=${projectHash(projectPath)}`,
				`${containerName}-vol`,
			],
			{ stdio: "pipe" },
		);
	}

	const runArgs = ["run", "-d", "--name", containerName];

	if (runId) {
		runArgs.push(
			"--label",
			"com.zerodelta.switchyard.managed=true",
			"--label",
			`com.zerodelta.switchyard.run_id=${runId}`,
			"--label",
			`com.zerodelta.switchyard.project=${projectHash(projectPath)}`,
		);
		if (!skipVolume) {
			runArgs.push("-v", `${containerName}-vol:/project`);
		}
	}

	for (const [key, value] of Object.entries(extraLabels)) {
		runArgs.push("--label", `${key}=${value}`);
	}

	runArgs.push("-w", "/project", image, "sleep", "infinity");

	execFileSync("docker", runArgs, { stdio: "inherit" });
	return containerName;
}

export function getContainerLabels(containerName) {
	const out = execFileSync(
		"docker",
		["inspect", "--format", "{{json .Config.Labels}}", containerName],
		{ encoding: "utf8", stdio: "pipe" },
	);
	const parsed = JSON.parse(out || "null");
	return parsed || {};
}

export function createLabeledContainer(options = {}) {
	const {
		name,
		labels = {},
		image = "alpine:latest",
		cmd = ["sleep", "infinity"],
	} = options;
	const args = ["run", "-d", "--name", name];
	for (const [key, value] of Object.entries(labels)) {
		args.push("--label", `${key}=${value}`);
	}
	args.push(image, ...cmd);
	execFileSync("docker", args, { stdio: "inherit" });
	return name;
}

export function createLabeledVolume(options = {}) {
	const { name, labels = {} } = options;
	const args = ["volume", "create"];
	for (const [key, value] of Object.entries(labels)) {
		args.push("--label", `${key}=${value}`);
	}
	args.push(name);
	execFileSync("docker", args, { stdio: "inherit" });
	return name;
}

export function removeContainer(name) {
	try {
		execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

export function removeVolume(name) {
	try {
		execFileSync("docker", ["volume", "rm", "-f", name], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

export function containerExists(name) {
	try {
		const out = execFileSync(
			"docker",
			["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return out.trim() === name;
	} catch {
		return false;
	}
}

export function volumeExists(name) {
	try {
		const out = execFileSync(
			"docker",
			["volume", "ls", "-q", "--filter", `name=^${name}$`],
			{ encoding: "utf8", stdio: "pipe" },
		);
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

const LABEL_WORKER_PID = "com.zerodelta.switchyard.worker_pid";

/**
 * Reap every managed container + volume created by THIS test process, keyed on
 * the worker_pid label createWorkingContainer stamps (= process.pid). Register
 * in a Docker-touching suite's afterEach/after hook so working objects never
 * accumulate on the shared daemon between runs (David's "nothing accumulates"
 * invariant). PID-scoped, so it is safe under Node's parallel test-file
 * execution: a sibling test file runs in a different process and its objects
 * carry a different worker_pid, so this never touches them. Best-effort: any
 * docker failure is swallowed so teardown never fails a suite.
 * @returns {{containers: number, volumes: number}} counts reaped
 */
export function reapOwnManagedObjects() {
	const pidFilter = `label=${LABEL_WORKER_PID}=${process.pid}`;
	let containers = 0;
	let volumes = 0;
	try {
		const names = execFileSync("docker", ["ps", "-aq", "--filter", pidFilter], {
			encoding: "utf8",
			stdio: "pipe",
		})
			.trim()
			.split("\n")
			.filter(Boolean);
		for (const id of names) {
			if (removeContainer(id)) containers += 1;
		}
	} catch {
		/* best effort */
	}
	try {
		const vols = execFileSync(
			"docker",
			["volume", "ls", "-q", "--filter", pidFilter],
			{ encoding: "utf8", stdio: "pipe" },
		)
			.trim()
			.split("\n")
			.filter(Boolean);
		for (const name of vols) {
			if (removeVolume(name)) volumes += 1;
		}
	} catch {
		/* best effort */
	}
	return { containers, volumes };
}
