// INV-1 gate test: agents have no rights to the Mac host
// Exercises lifecycle.mjs's own functions directly (createWorkingContainer /
// execInWorkingContainer), not raw docker calls, so a regression in the real
// code path a dispatch actually uses — not just "docker isolation works in
// general" — is caught.

import { strictEqual } from "node:assert";
import { homedir } from "node:os";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	execInWorkingContainer,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";

// Build the working container from a minimal, credential-less image so this
// test stays hermetic (no multi-GB agent image pull) and the host-isolation
// assertions below hold regardless of what the real agent image contains.
// createWorkingContainer's second parameter is now the base image, not an
// agent container to mount from — the old --volumes-from coupling is gone.
const TEST_WORKING_IMAGE = "alpine:latest";
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
		workingContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_WORKING_IMAGE,
		);
	});

	after(() => {
		if (workingContainerName) {
			wipeWorkingContainer(workingContainerName);
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
