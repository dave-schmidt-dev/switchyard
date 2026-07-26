// Credential-provisioning test (Task 14): provisionClaudeCredentials copies
// the standing agent container's claude credentials into a fresh working
// container so an authenticated CLI can actually run there. Exercises
// lifecycle.mjs's real function against real containers — the credential
// delivery a dispatch depends on, not a mock.
//
// Fixtures use alpine with DUMMY, non-secret file contents — never a real
// token — and assert:
//  - both claude credential paths land in the working container, contents
//    intact (the dummy sentinel round-trips);
//  - a source with no credentials is a clean best-effort skip (returns 0,
//    fabricates nothing, never throws);
//  - an unsafe container name is rejected before any docker call runs
//    (INV-1 defense-in-depth via validateIdentifier).

import { strictEqual, throws } from "node:assert";
import { execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	execInWorkingContainer,
	provisionClaudeCredentials,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";

const TEST_WORKING_IMAGE = "alpine:latest";

// DUMMY, non-secret sentinels — this test must never write a real credential.
const DUMMY_CREDS = "dummy-not-a-real-credential";
const DUMMY_CONFIG = "dummy-not-a-real-config";

// True if `path` exists inside the container, false if `test -e` exits non-zero
// (absent). Kept outside any try/catch that also holds an assertion, so an
// assertion failure can't be swallowed by this catch and misreported as a pass.
function existsInContainer(containerName, path) {
	try {
		execInWorkingContainer(containerName, `test -e ${path}`);
		return true;
	} catch {
		return false;
	}
}

describe("provisionClaudeCredentials copies claude credentials into the working container", () => {
	const AGENT = "switchyard-test-cred-agent";
	const PROJECT = "/tmp/switchyard-test-cred-project";
	let working;

	before(() => {
		try {
			execSync(`docker rm -f -v ${AGENT}`, { stdio: "pipe" });
		} catch {
			// Ignore - fixture may not exist yet
		}
		execSync(
			`docker run -d --name ${AGENT} ${TEST_WORKING_IMAGE} sleep infinity`,
			{ stdio: "inherit" },
		);
		// Seed DUMMY claude credentials into the fake agent container: the dir
		// form (/root/.claude/.credentials.json) and the root-level file form
		// (/root/.claude.json), the two shapes provisionClaudeCredentials copies.
		execSync(
			`docker exec ${AGENT} sh -c 'mkdir -p /root/.claude && ` +
				`printf %s "${DUMMY_CREDS}" > /root/.claude/.credentials.json && ` +
				`printf %s "${DUMMY_CONFIG}" > /root/.claude.json'`,
			{ stdio: "inherit" },
		);
		working = createWorkingContainer(PROJECT, TEST_WORKING_IMAGE);
	});

	after(() => {
		if (working) {
			wipeWorkingContainer(working);
		}
		try {
			execSync(`docker rm -f -v ${AGENT}`, { stdio: "pipe" });
		} catch {
			// Ignore
		}
	});

	it("copies both claude credential paths and reports the count", () => {
		strictEqual(
			provisionClaudeCredentials(working, AGENT),
			2,
			"both /root/.claude and /root/.claude.json should copy",
		);
	});

	it("the credential files are present inside the working container", () => {
		strictEqual(
			existsInContainer(working, "/root/.claude/.credentials.json"),
			true,
			"/root/.claude/.credentials.json must land in the working container",
		);
		strictEqual(
			existsInContainer(working, "/root/.claude.json"),
			true,
			"/root/.claude.json must land in the working container",
		);
	});

	it("copied content matches the source (dummy sentinel round-trips, not an empty file)", () => {
		strictEqual(
			execInWorkingContainer(working, "cat /root/.claude.json"),
			DUMMY_CONFIG,
		);
	});
});

describe("provisionClaudeCredentials is best-effort when the source has no credentials", () => {
	const AGENT_EMPTY = "switchyard-test-cred-agent-empty";
	const PROJECT = "/tmp/switchyard-test-cred-empty-project";
	let working;

	before(() => {
		try {
			execSync(`docker rm -f -v ${AGENT_EMPTY}`, { stdio: "pipe" });
		} catch {
			// Ignore - fixture may not exist yet
		}
		execSync(
			`docker run -d --name ${AGENT_EMPTY} ${TEST_WORKING_IMAGE} sleep infinity`,
			{ stdio: "inherit" },
		);
		working = createWorkingContainer(PROJECT, TEST_WORKING_IMAGE);
	});

	after(() => {
		if (working) {
			wipeWorkingContainer(working);
		}
		try {
			execSync(`docker rm -f -v ${AGENT_EMPTY}`, { stdio: "pipe" });
		} catch {
			// Ignore
		}
	});

	it("returns 0 and does not throw when no credentials exist to copy", () => {
		strictEqual(provisionClaudeCredentials(working, AGENT_EMPTY), 0);
	});

	it("does not fabricate credential files in the working container", () => {
		strictEqual(
			existsInContainer(working, "/root/.claude.json"),
			false,
			"an absent source must be skipped, never invented",
		);
	});
});

describe("provisionClaudeCredentials rejects unsafe identifiers before any docker call", () => {
	it("throws on an unsafe working container name", () => {
		throws(
			() => provisionClaudeCredentials("bad; rm -rf /", "switchyard-agent"),
			/unsafe characters/,
		);
	});

	it("throws on an unsafe agent container name", () => {
		throws(
			() => provisionClaudeCredentials("switchyard-work-x", "bad name"),
			/unsafe characters/,
		);
	});
});
