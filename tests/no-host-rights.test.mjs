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
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createWorkingContainer,
	execInWorkingContainer,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";
import { reapOwnManagedObjects } from "./helpers/lifecycle-fixture.mjs";

// Build the working container from a minimal, credential-less image so this
// test stays hermetic (no multi-GB agent image pull) and the host-isolation
// assertions below hold regardless of what the real agent image contains.
// createWorkingContainer's second parameter is the base image, not an agent
// container to mount from — the old --volumes-from coupling is gone.
const TEST_WORKING_IMAGE = "alpine:latest";
const TEST_PROJECT_PATH = "/tmp/switchyard-test-isolation-project";

// Task 1.5's roster loader (src/switchyard/roster/index.mjs) reads
// SWITCHYARD_ROSTER_PATH host-side only. The committed fixture (same one
// tests/roster-loader.test.mjs points the env var at) stands in for the real
// roster.json below so this INV-1 assertion runs against an actual file that
// exists on disk, not a placeholder path.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROSTER_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.fixture.json",
);

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

after(() => reapOwnManagedObjects());

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

// Task 1.7 (roster-unification plan): the roster read Task 1.5 added
// (src/switchyard/roster/index.mjs resolving SWITCHYARD_ROSTER_PATH) is
// host-side only — the loader runs in the host Node process before any
// container exists. This block extends the same two-way proof above
// (reachability probe + mount inspection) to that specific env var and file,
// so a future change that starts forwarding host env or bind-mounting the
// roster into a dispatched container fails this gate immediately. Only the
// RESOLVED control input (the model/selector a real dispatch picks after
// reading the roster — see adapter execute() functions' `--model` argv, e.g.
// claude.mjs) is allowed to cross inward; the roster path/file itself never
// should, exactly like the credential VALUES in
// lifecycle.mjs's PROVIDER_CREDENTIAL_PATHS never appear in argv.
describe("no host rights — roster path never enters a container (INV-1)", () => {
	let workingContainerName;
	let previousRosterPath;

	before(() => {
		// Set SWITCHYARD_ROSTER_PATH on the host before creating the container —
		// the same env var + real fixture file a live dispatch would have set —
		// so a regression that starts threading it through
		// createWorkingContainer (e.g. a new `-e SWITCHYARD_ROSTER_PATH=...` or
		// a bind mount added for "convenience") is caught against the actual
		// code path, not a hypothetical one.
		previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
		process.env.SWITCHYARD_ROSTER_PATH = ROSTER_FIXTURE_PATH;

		workingContainerName = createWorkingContainer(
			TEST_PROJECT_PATH,
			TEST_WORKING_IMAGE,
		);
	});

	after(() => {
		if (previousRosterPath === undefined) {
			delete process.env.SWITCHYARD_ROSTER_PATH;
		} else {
			process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
		}
		if (workingContainerName) {
			wipeWorkingContainer(workingContainerName);
		}
	});

	it("does not forward SWITCHYARD_ROSTER_PATH into the container's environment", () => {
		const out = execFileSync(
			"docker",
			["inspect", "--format", "{{json .Config.Env}}", workingContainerName],
			{ encoding: "utf8" },
		);
		const containerEnv = JSON.parse(out) ?? [];
		const rosterEnvEntry = containerEnv.find((entry) =>
			entry.startsWith("SWITCHYARD_ROSTER_PATH="),
		);
		strictEqual(
			rosterEnvEntry,
			undefined,
			`container env must never carry SWITCHYARD_ROSTER_PATH; found env: ${JSON.stringify(containerEnv)}`,
		);
	});

	it("does not bind-mount the roster.json file or its directory (no inbound file)", () => {
		const mounts = getMounts(workingContainerName);

		// Roster-specific direct proof: no mount's host Source is the roster
		// fixture path or a directory containing it.
		const rosterMount = mounts.find(
			(m) =>
				m.Source === ROSTER_FIXTURE_PATH ||
				ROSTER_FIXTURE_PATH.startsWith(`${m.Source}/`),
		);
		strictEqual(
			rosterMount,
			undefined,
			`no mount may bind the roster path or a directory containing it into the container; found: ${JSON.stringify(rosterMount)}`,
		);

		// Restates this file's general direct proof (zero bind mounts at all)
		// scoped to why it matters here: a bind is the only mechanism by which
		// the roster file could become an inbound file, so "no binds" already
		// forecloses it — asserted again so this describe block is a complete,
		// standalone gate for the roster-specific contract.
		const binds = mounts.filter((m) => m.Type === "bind");
		strictEqual(
			binds.length,
			0,
			`working container must have no host bind mount (roster file included); found: ${JSON.stringify(binds)}`,
		);
	});

	it("the roster.json file is not reachable/listable from inside the container", () => {
		strictEqual(
			existsInWorkingContainer(workingContainerName, ROSTER_FIXTURE_PATH),
			false,
			`roster fixture path ${ROSTER_FIXTURE_PATH} must not be reachable from the working container`,
		);
	});
});
