// INV-1 gate test: agents have no rights to the Mac host
// Exercises lifecycle.mjs's own functions directly (createWorkingContainer /
// execInWorkingContainer), not raw docker calls, so a regression in the real
// code path a dispatch actually uses — not just "docker isolation works in
// general" — is caught.

import { strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	execInWorkingContainer,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";

// A distinct test fixture name — never the real AGENT_CONTAINER_NAME — so
// this test can never touch a developer's actual standing agent container.
const TEST_AGENT_CONTAINER = "switchyard-test-agent-isolation";
const TEST_PROJECT_PATH = "/tmp/switchyard-test-isolation-project";

// Returns true if the path is listable inside the container, false if the
// command fails (path absent/inaccessible — the property we want).
// IMPORTANT: this must not be called from inside a try/catch that also
// contains the assertion — an assertion failure thrown alongside the
// command's own exception would otherwise be swallowed by that same catch
// block and silently reported as a pass (this bit us once already).
function existsInWorkingContainer(workingContainerName, path) {
	try {
		execInWorkingContainer(workingContainerName, `ls ${path}`);
		return true;
	} catch {
		return false;
	}
}

describe("no host rights", () => {
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

		workingContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_AGENT_CONTAINER,
		);
	});

	after(() => {
		if (workingContainerName) {
			wipeWorkingContainer(workingContainerName);
		}
		try {
			execSync(`docker rm -f -v ${TEST_AGENT_CONTAINER}`, { stdio: "pipe" });
		} catch {
			// Ignore
		}
	});

	it("should not access host filesystem", () => {
		strictEqual(
			existsInWorkingContainer(workingContainerName, "/Users"),
			false,
			"host filesystem must not be reachable from the working container",
		);
	});

	it("should not access Docker socket", () => {
		strictEqual(
			existsInWorkingContainer(workingContainerName, "/var/run/docker.sock"),
			false,
			"Docker socket must not be reachable from the working container",
		);
	});

	it("should not access host credentials", () => {
		const credPaths = [
			"/root/.ssh",
			"/root/.gitconfig",
			"/root/.config",
			homedir(),
		];

		for (const path of credPaths) {
			strictEqual(
				existsInWorkingContainer(workingContainerName, path),
				false,
				`host credential path ${path} must not be reachable from the working container`,
			);
		}
	});
});
