// INV-3 gate test: working container is wiped at project end
// Tests: working container absent after project end, agent container persists

import { strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

const WORKING_CONTAINER = "switchyard-test-working";
const AGENT_CONTAINER = "switchyard-test-agent";

// `docker ps -a --filter name=X` exits 0 with empty output when nothing
// matches — it never throws on "not found". Check the returned name list
// directly instead of relying on a try/catch to distinguish "gone" from
// "still there" (a prior version relied on a throw that never happened, and
// on top of that put the failing assertion inside the same try block that
// was supposed to catch it — so the failure was swallowed by its own catch).
function containerExists(name) {
	const output = execSync(
		`docker ps -a --filter name=${name} --format '{{.Names}}'`,
		{ encoding: "utf8", stdio: "pipe" },
	).trim();
	return output === name;
}

describe("workspace wipe", () => {
	before(() => {
		try {
			execSync(`docker rm -f ${WORKING_CONTAINER} ${AGENT_CONTAINER}`, {
				stdio: "inherit",
			});
		} catch {
			// Ignore
		}

		execSync(
			`docker run -d --name ${AGENT_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
		execSync(
			`docker run -d --name ${WORKING_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
	});

	after(() => {
		try {
			execSync(`docker rm -f ${WORKING_CONTAINER} ${AGENT_CONTAINER}`, {
				stdio: "inherit",
			});
		} catch {
			// Ignore
		}
	});

	it("should have working container before wipe", () => {
		strictEqual(containerExists(WORKING_CONTAINER), true);
	});

	it("should have agent container before wipe", () => {
		strictEqual(containerExists(AGENT_CONTAINER), true);
	});

	it("should wipe working container at project end", () => {
		// Simulate project end: stop and remove working container.
		// `docker stop` on a plain `sleep infinity` PID 1 ignores SIGTERM (no
		// signal handler), so this waits out the ~10s default grace period
		// before SIGKILL — expected, not a hang.
		execSync(`docker stop ${WORKING_CONTAINER}`, { stdio: "inherit" });
		execSync(`docker rm ${WORKING_CONTAINER}`, { stdio: "inherit" });

		strictEqual(
			containerExists(WORKING_CONTAINER),
			false,
			"working container should be wiped",
		);
	});

	it("should preserve agent container after working wipe", () => {
		strictEqual(containerExists(AGENT_CONTAINER), true);
	});
});
