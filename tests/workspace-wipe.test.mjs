// INV-3 gate test: working container is wiped at project end
// Exercises lifecycle.mjs's own functions directly (createWorkingContainer /
// wipeWorkingContainer / workingContainerExists), not raw docker calls, so a
// regression in the real code path — not just "docker works" — is caught.

import { strictEqual } from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	listManagedContainers,
	listManagedVolumes,
	wipeWorkingContainer,
	workingContainerExists,
} from "../src/switchyard/lifecycle/index.mjs";

// A distinct agent-container fixture — never the real AGENT_CONTAINER_NAME —
// so this test can never touch a developer's actual standing agent container.
// createWorkingContainer no longer mounts from it (the --volumes-from coupling
// is gone), but it stands in here as "the container that must survive a
// working-container wipe": INV-3 requires wiping a working container to never
// remove the standing agent container, and the persistence assertions below
// guard exactly that.
const TEST_AGENT_CONTAINER = "switchyard-test-agent";
// The working container is built from this minimal image — see the INV-1 test
// for why alpine keeps these container tests hermetic.
const TEST_WORKING_IMAGE = "alpine:latest";
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

	it("createWorkingContainer creates a real container from the given image", () => {
		workingContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_WORKING_IMAGE,
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
		// signal handler), so this waits out the default grace period before
		// SIGKILL — expected, not a hang.
		const result = wipeWorkingContainer(workingContainerName);

		strictEqual(result.verified, true);
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

describe("labeled container creation", () => {
	const TEST_RUN_ID = "test-run-1";
	const TEST_PROJECT = "/tmp/switchyard-label-test-project";
	const TEST_WORKING_IMAGE = "alpine:latest";
	let labeledContainerName;

	before(() => {
		labeledContainerName = createWorkingContainer(
			TEST_PROJECT,
			TEST_WORKING_IMAGE,
			{ runId: TEST_RUN_ID },
		);
	});

	after(() => {
		if (labeledContainerName) {
			try {
				execFileSync("docker", ["rm", "-f", "-v", labeledContainerName], {
					stdio: "pipe",
				});
			} catch {
				/* ignore */
			}
			try {
				execFileSync(
					"docker",
					["volume", "rm", "-f", `${labeledContainerName}-vol`],
					{ stdio: "pipe" },
				);
			} catch {
				/* ignore */
			}
		}
	});

	it("container has managed label", () => {
		const info = JSON.parse(
			execFileSync(
				"docker",
				[
					"inspect",
					"--format",
					"{{json .Config.Labels}}",
					labeledContainerName,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		strictEqual(
			info["com.zerodelta.switchyard.managed"],
			"true",
			"container must carry the managed=true label",
		);
	});

	it("container has run_id label", () => {
		const info = JSON.parse(
			execFileSync(
				"docker",
				[
					"inspect",
					"--format",
					"{{json .Config.Labels}}",
					labeledContainerName,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		strictEqual(
			info["com.zerodelta.switchyard.run_id"],
			TEST_RUN_ID,
			"container must carry the correct run_id label",
		);
	});

	it("container has project label (12-char hex hash)", () => {
		const info = JSON.parse(
			execFileSync(
				"docker",
				[
					"inspect",
					"--format",
					"{{json .Config.Labels}}",
					labeledContainerName,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		const ph = info["com.zerodelta.switchyard.project"];
		strictEqual(typeof ph, "string", "project label must be a string");
		strictEqual(ph.length, 12, "project hash must be 12 hex chars");
		strictEqual(
			/^[0-9a-f]{12}$/.test(ph),
			true,
			"project hash must be lowercase hex",
		);
	});

	it("volume has managed label", () => {
		const info = JSON.parse(
			execFileSync(
				"docker",
				[
					"volume",
					"inspect",
					"--format",
					"{{json .Labels}}",
					`${labeledContainerName}-vol`,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		strictEqual(
			info?.["com.zerodelta.switchyard.managed"],
			"true",
			"volume must carry the managed=true label",
		);
	});

	it("volume has run_id label", () => {
		const info = JSON.parse(
			execFileSync(
				"docker",
				[
					"volume",
					"inspect",
					"--format",
					"{{json .Labels}}",
					`${labeledContainerName}-vol`,
				],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		strictEqual(
			info?.["com.zerodelta.switchyard.run_id"],
			TEST_RUN_ID,
			"volume must carry the correct run_id label",
		);
	});

	it("listManagedContainers returns labeled container", () => {
		const containers = listManagedContainers();
		const found = containers.find((c) => c.name === labeledContainerName);
		strictEqual(
			typeof found,
			"object",
			"labeled container must appear in list",
		);
		strictEqual(found.runId, TEST_RUN_ID);
		strictEqual(typeof found.project, "string");
		strictEqual(typeof found.status, "string");
	});

	it("listManagedVolumes returns labeled volume", () => {
		const volumes = listManagedVolumes();
		const found = volumes.find((v) => v.name === `${labeledContainerName}-vol`);
		strictEqual(typeof found, "object", "labeled volume must appear in list");
		strictEqual(found.runId, TEST_RUN_ID);
	});

	it("backward compat: createWorkingContainer without options still works and has no labels", () => {
		const name = createWorkingContainer(TEST_PROJECT, TEST_WORKING_IMAGE);
		strictEqual(typeof name, "string");
		strictEqual(workingContainerExists(name), true);

		// Verify no switchyard labels are present
		const info = JSON.parse(
			execFileSync(
				"docker",
				["inspect", "--format", "{{json .Config.Labels}}", name],
				{ encoding: "utf8", stdio: "pipe" },
			),
		);
		strictEqual(
			info === null || info["com.zerodelta.switchyard.managed"] === undefined,
			true,
			"unlabeled container must not carry managed label",
		);

		// Clean up
		try {
			execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "pipe" });
		} catch {
			/* ignore */
		}
		try {
			execFileSync("docker", ["volume", "rm", "-f", `${name}-vol`], {
				stdio: "pipe",
			});
		} catch {
			/* ignore */
		}
	});
});

describe("idempotent wipe", () => {
	const TEST_PROJECT_PATH = "/tmp/switchyard-test-project";
	const TEST_WORKING_IMAGE = "alpine:latest";
	let wipeContainerName;

	before(() => {
		wipeContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_WORKING_IMAGE,
		);
	});

	after(() => {
		if (wipeContainerName) {
			try {
				execFileSync("docker", ["rm", "-f", "-v", wipeContainerName], {
					stdio: "pipe",
				});
			} catch {
				/* ignore */
			}
			try {
				execFileSync(
					"docker",
					["volume", "rm", "-f", `${wipeContainerName}-vol`],
					{ stdio: "pipe" },
				);
			} catch {
				/* ignore */
			}
		}
	});

	it("wipe returns structured outcome fields", () => {
		const result = wipeWorkingContainer(wipeContainerName);
		strictEqual(typeof result.containerRemoved, "boolean");
		strictEqual(typeof result.volumeRemoved, "boolean");
		strictEqual(typeof result.verified, "boolean");
		strictEqual(result.verified, true);
	});

	it("repeated wipe does not throw", () => {
		// First wipe consumed the container; second wipe must succeed (idempotent)
		let threw = false;
		try {
			const result = wipeWorkingContainer(wipeContainerName);
			// After first wipe, container/volume already gone — verified should be true
			strictEqual(result.verified, true);
		} catch {
			threw = true;
		}
		strictEqual(
			threw,
			false,
			"second wipe must not throw when container is already gone",
		);
	});
});
