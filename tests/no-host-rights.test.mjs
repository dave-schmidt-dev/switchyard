// INV-1 gate test: agents have no rights to the Mac host
// Tests: from inside container, host FS / Docker socket / host creds are unreachable

import { strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { after, before, describe, it } from "node:test";

// Use a test container to verify isolation
const TEST_CONTAINER = "switchyard-test-isolation";

// Returns true if the path is listable inside the container, false if the
// `ls` invocation fails (path absent/inaccessible — the property we want).
// IMPORTANT: this must not be called from inside a try/catch that also
// contains the assertion — an assertion failure thrown alongside the
// command's own exception would otherwise be swallowed by that same catch
// block and silently reported as a pass (this bit us once already).
function existsInContainer(path) {
	try {
		execSync(`docker exec ${TEST_CONTAINER} ls ${path}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

describe("no host rights", () => {
	before(() => {
		try {
			execSync(`docker rm -f ${TEST_CONTAINER}`, { stdio: "inherit" });
		} catch {
			// Ignore
		}
		execSync(
			`docker run -d --name ${TEST_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
	});

	after(() => {
		try {
			execSync(`docker rm -f ${TEST_CONTAINER}`, { stdio: "inherit" });
		} catch {
			// Ignore
		}
	});

	it("should not access host filesystem", () => {
		strictEqual(
			existsInContainer("/Users"),
			false,
			"host filesystem must not be reachable from the container",
		);
	});

	it("should not access Docker socket", () => {
		strictEqual(
			existsInContainer("/var/run/docker.sock"),
			false,
			"Docker socket must not be reachable from the container",
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
				existsInContainer(path),
				false,
				`host credential path ${path} must not be reachable from the container`,
			);
		}
	});
});
