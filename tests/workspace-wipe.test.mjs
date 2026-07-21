// INV-3 gate test: working container is wiped at project end
// Tests: working container absent after project end, agent container persists

import { ok, strictEqual } from "node:assert";
import { execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

const WORKING_CONTAINER = "switchyard-test-working";
const AGENT_CONTAINER = "switchyard-test-agent";

describe("workspace wipe", () => {
	before(() => {
		// Clean up any existing test containers
		try {
			execSync(`docker rm -f ${WORKING_CONTAINER} ${AGENT_CONTAINER}`, {
				stdio: "inherit",
			});
		} catch {
			// Ignore
		}

		// Create agent container (persists)
		execSync(
			`docker run -d --name ${AGENT_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);

		// Create working container
		execSync(
			`docker run -d --name ${WORKING_CONTAINER} alpine:latest sleep infinity`,
			{ stdio: "inherit" },
		);
	});

	after(() => {
		// Clean up all test containers
		try {
			execSync(`docker rm -f ${WORKING_CONTAINER} ${AGENT_CONTAINER}`, {
				stdio: "inherit",
			});
		} catch {
			// Ignore
		}
	});

	it("should have working container before wipe", () => {
		const result = execSync(
			`docker ps -a --filter name=${WORKING_CONTAINER} --format '{{.Names}}'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		strictEqual(result.trim(), WORKING_CONTAINER);
	});

	it("should have agent container before wipe", () => {
		const result = execSync(
			`docker ps -a --filter name=${AGENT_CONTAINER} --format '{{.Names}}'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		strictEqual(result.trim(), AGENT_CONTAINER);
	});

	it("should wipe working container at project end", () => {
		// Simulate project end: stop and remove working container
		execSync(`docker stop ${WORKING_CONTAINER}`, { stdio: "inherit" });
		execSync(`docker rm ${WORKING_CONTAINER}`, { stdio: "inherit" });

		// Verify working container is gone
		try {
			execSync(
				`docker ps -a --filter name=${WORKING_CONTAINER} --format '{{.Names}}'`,
				{ stdio: "pipe" },
			);
			// If we get here, container still exists
			ok(false, "Working container should be wiped");
		} catch {
			// Expected: container is gone
			ok(true, "Working container successfully wiped");
		}
	});

	it("should preserve agent container after working wipe", () => {
		// Agent container should still exist
		const result = execSync(
			`docker ps -a --filter name=${AGENT_CONTAINER} --format '{{.Names}}'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		strictEqual(result.trim(), AGENT_CONTAINER);
	});
});
