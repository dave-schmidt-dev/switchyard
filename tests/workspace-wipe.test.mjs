// INV-3 gate test: working container is wiped at project end
// Exercises lifecycle.mjs's own functions directly (createWorkingContainer /
// wipeWorkingContainer / workingContainerExists), not raw docker calls, so a
// regression in the real code path — not just "docker works" — is caught.

import { strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	wipeWorkingContainer,
	workingContainerExists,
} from "../src/switchyard/lifecycle/index.mjs";

// A distinct test fixture name — never the real AGENT_CONTAINER_NAME — so
// this test can never touch a developer's actual standing agent container.
// createWorkingContainer's new optional agentContainerName parameter exists
// specifically to make this substitution possible.
const TEST_AGENT_CONTAINER = "switchyard-test-agent";
const TEST_PROJECT_PATH = "/tmp/switchyard-test-project";

describe("workspace wipe", () => {
	let workingContainerName;

	before(() => {
		try {
			execSync(`docker rm -f -v ${TEST_AGENT_CONTAINER}`, { stdio: "pipe" });
		} catch {
			// Ignore - fixture may not exist yet
		}
		execSync(
			`docker run -d --name ${TEST_AGENT_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
	});

	after(() => {
		if (workingContainerName) {
			try {
				execSync(
					`docker rm -f -v ${workingContainerName} && docker volume rm -f ${workingContainerName}-vol`,
					{ stdio: "pipe" },
				);
			} catch {
				// Ignore - already wiped by the test itself
			}
		}
		try {
			execSync(`docker rm -f -v ${TEST_AGENT_CONTAINER}`, { stdio: "pipe" });
		} catch {
			// Ignore
		}
	});

	it("createWorkingContainer creates a real container tied to the agent container", () => {
		workingContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_AGENT_CONTAINER,
		);

		strictEqual(
			typeof workingContainerName,
			"string",
			"createWorkingContainer should return the generated container name",
		);
		strictEqual(workingContainerExists(workingContainerName), true);
	});

	it("agent container is still present before wipe", () => {
		strictEqual(workingContainerExists(TEST_AGENT_CONTAINER), true);
	});

	it("wipeWorkingContainer removes the working container at project end", () => {
		// `docker stop` on a plain `sleep infinity` PID 1 ignores SIGTERM (no
		// signal handler), so this waits out the ~10s default grace period
		// before SIGKILL — expected, not a hang.
		const wiped = wipeWorkingContainer(workingContainerName);

		strictEqual(wiped, true);
		strictEqual(
			workingContainerExists(workingContainerName),
			false,
			"working container should be wiped",
		);
	});

	it("preserves agent container after working container wipe (INV-3: agent container is never the disposable unit)", () => {
		strictEqual(workingContainerExists(TEST_AGENT_CONTAINER), true);
	});
});

describe("workingContainerExists exact-name matching (substring-overlap regression)", () => {
	// Regression: `docker ps -a --filter name=X` is a SUBSTRING match, not
	// exact. The pre-fix implementation compared the filter's raw output
	// directly against workingContainerName — fine when only one container
	// matches, but when a second container's name contains the first as a
	// prefix, the unanchored filter returns BOTH names (newline-joined),
	// which never equals either name exactly. That produced a false
	// negative: workingContainerExists() reported an existing container as
	// absent purely because another differently-named container happened to
	// share its prefix. Reproduced concretely here with two real fixture
	// containers, neither of which is the real AGENT_CONTAINER_NAME.
	const SHORT_NAME = "switchyard-test-overlap-a";
	const LONG_NAME = "switchyard-test-overlap-a-longer";

	before(() => {
		for (const name of [SHORT_NAME, LONG_NAME]) {
			try {
				execSync(`docker rm -f -v ${name}`, { stdio: "pipe" });
			} catch {
				// Ignore - fixture may not exist yet
			}
		}
		execSync(
			`docker run -d --name ${SHORT_NAME} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
		execSync(`docker run -d --name ${LONG_NAME} alpine:latest sleep infinity`, {
			stdio: "inherit",
		});
	});

	after(() => {
		for (const name of [SHORT_NAME, LONG_NAME]) {
			try {
				execSync(`docker rm -f -v ${name}`, { stdio: "pipe" });
			} catch {
				// Ignore
			}
		}
	});

	it("finds the shorter container by its exact name even though a longer container's name contains it as a prefix", () => {
		strictEqual(
			workingContainerExists(SHORT_NAME),
			true,
			"an unanchored filter would return both names here and never equal SHORT_NAME exactly, misreporting it as absent",
		);
	});

	it("finds the longer container by its exact name", () => {
		strictEqual(workingContainerExists(LONG_NAME), true);
	});

	it("reports false for a name that is a real substring of an existing container but was never itself created", () => {
		strictEqual(
			workingContainerExists("switchyard-test-overlap"),
			false,
			"a name that only partially matches must not read as present",
		);
	});
});
