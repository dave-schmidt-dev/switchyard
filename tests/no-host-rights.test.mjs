// INV-1 gate test: agents have no rights to the Mac host.
// Exercises lifecycle.mjs's own functions directly (createWorkingContainer /
// execInWorkingContainer), not raw docker calls, so a regression in the real
// code path a dispatch actually uses — not just "docker isolation works in
// general" — is caught.
//
// The contract is "no HOST rights", proven two ways:
//   1. Reachability probes — the host filesystem (/Users), the Docker socket,
//      and the host home directory are not listable from inside the container.
//   2. Mount inspection (the direct proof) — the container has NO bind mount at
//      all. A bind mount is the only mechanism by which a host path (the FS,
//      the docker.sock, a credential dir) can enter a container, so asserting
//      "no bind" is the real, robust expression of INV-1. The isolated named
//      `/project` volume is the only mount, verified positively.
//
// This replaced an earlier proxy that asserted `/root/.config` was absent —
// which was incidental, not INV-1's intent, and wrongly blocked provisioning
// cursor's credential (it legitimately lives under /root/.config). Provisioned
// in-container credentials are NOT a host right; a host bind mount is.

import { strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
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
// createWorkingContainer's second parameter is the base image, not an agent
// container to mount from — the old --volumes-from coupling is gone.
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

// The container's mount table, straight from the daemon. `.Mounts` is the
// authoritative record of everything bound/volumed into the container — the
// only place a host path could enter.
function getMounts(workingContainerName) {
	const out = execFileSync(
		"docker",
		["inspect", "--format", "{{json .Mounts}}", workingContainerName],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
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

	it("should not mount the host home directory", () => {
		strictEqual(
			existsInWorkingContainer(workingContainerName, homedir()),
			false,
			`host home directory ${homedir()} must not be reachable from the working container`,
		);
	});

	it("has no host bind mount; only the isolated /project volume (INV-1's real contract)", () => {
		const mounts = getMounts(workingContainerName);

		// The direct proof of "no host rights": a bind mount is the only way a
		// host path (the FS, docker.sock, a credential dir) enters a container,
		// so NONE may be a bind.
		const binds = mounts.filter((m) => m.Type === "bind");
		strictEqual(
			binds.length,
			0,
			`working container must have no host bind mount; found: ${JSON.stringify(binds)}`,
		);

		// Positive check: project code lives on an isolated named Docker volume,
		// not a host path — /project is real but confers no host rights.
		const project = mounts.find((m) => m.Destination === "/project");
		strictEqual(
			project?.Type,
			"volume",
			"/project must be an isolated named volume, not a host bind",
		);
	});
});
