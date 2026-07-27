// Credential-provisioning test (Task 14, extended to four providers in Task
// 26): provisionCredentials copies each provider's credential FILE from the
// standing agent container into a fresh working container so an authenticated
// CLI can actually run there. Exercises lifecycle.mjs's real function against
// real containers — the credential delivery a dispatch depends on, not a mock.
//
// Fixtures use alpine with DUMMY, non-secret file contents — never a real
// token — and assert:
//   - all five credential files (claude has two) land at the correct paths in
//     the working container, contents intact (the dummy sentinel round-trips);
//   - CRED-BLEED REGRESSION: the providers' sibling conversation/project state
//     (claude `projects/`+`sessions/`, codex `log/`, agy `conversations/`)
//     does NOT follow the credential file into the disposable container — only
//     the single auth file is copied, never the whole provider dir;
//   - a source with no credentials is a clean best-effort skip (returns 0,
//     fabricates nothing, never throws);
//   - an unsafe container name is rejected before any docker call runs
//     (INV-1 defense-in-depth via validateIdentifier).

import { strictEqual, throws } from "node:assert";
import { execSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import {
	createWorkingContainer,
	execInWorkingContainer,
	provisionCredentials,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";

const TEST_WORKING_IMAGE = "alpine:latest";

// DUMMY, non-secret sentinels — this test must never write a real credential.
const DUMMY_CRED = "dummy-not-a-real-credential";
const DUMMY_BLEED = "BLEED-must-not-be-copied";

// The credential FILES provisionCredentials copies, and the dest path
// each must land at in the working container (mirrors PROVIDER_CREDENTIAL_PATHS
// in lifecycle/index.mjs — kept here as the independent assertion of record).
const CREDENTIAL_FILES = [
	"/root/.claude/.credentials.json",
	"/root/.claude.json",
	"/root/.codex/auth.json",
	"/root/.gemini/antigravity-cli/antigravity-oauth-token",
	"/root/.config/cursor/auth.json",
	"/root/.config/github-copilot/hosts.json",
	"/root/.config/github-copilot/apps.json",
	"/root/.config/gh/hosts.yml",
	"/root/.config/opencode/auth.json",
	"/root/.config/opencode/config.json",
];

// Sibling state that shares each provider's dir but is NOT a credential — it
// must never bleed into the disposable working container.
const BLEED_FILES = [
	"/root/.claude/projects/history.json",
	"/root/.claude/sessions/session.json",
	"/root/.codex/log/codex.log",
	"/root/.gemini/antigravity-cli/conversations/conv.db",
	"/root/.config/github-copilot/logs/copilot.log",
	"/root/.config/opencode/logs/opencode.log",
];

// Seed a fake agent container with dummy credential files AND dummy bleed
// files, exactly at the real paths, so the copy's file-vs-dir behavior is
// exercised end to end. Never a real token.
function seedAgent(agentName) {
	const mkCred = CREDENTIAL_FILES.map(
		(p) => `mkdir -p "$(dirname ${p})" && printf %s "${DUMMY_CRED}" > ${p}`,
	).join(" && ");
	const mkBleed = BLEED_FILES.map(
		(p) => `mkdir -p "$(dirname ${p})" && printf %s "${DUMMY_BLEED}" > ${p}`,
	).join(" && ");
	execSync(`docker exec ${agentName} sh -c '${mkCred} && ${mkBleed}'`, {
		stdio: "inherit",
	});
}

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

describe("provisionCredentials copies every provider's credential file into the working container", () => {
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
		seedAgent(AGENT);
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

	it("copies all provider credential files and reports the count", () => {
		strictEqual(
			provisionCredentials(working, AGENT),
			CREDENTIAL_FILES.length,
			"all provider credential files should copy",
		);
	});

	it("each credential file lands at its correct path in the working container", () => {
		for (const path of CREDENTIAL_FILES) {
			strictEqual(
				existsInContainer(working, path),
				true,
				`credential file ${path} must land in the working container`,
			);
		}
	});

	it("copied content matches the source (dummy sentinel round-trips, not an empty file)", () => {
		strictEqual(
			execInWorkingContainer(working, "cat /root/.codex/auth.json"),
			DUMMY_CRED,
		);
	});

	it("does NOT copy sibling conversation/project state (cred-bleed regression)", () => {
		for (const path of BLEED_FILES) {
			strictEqual(
				existsInContainer(working, path),
				false,
				`sibling state ${path} must NOT bleed into the disposable working container`,
			);
		}
		// The credential dir itself is (re)created to hold the auth file, but it
		// must contain ONLY that file — the projects/ and sessions/ subtrees that
		// live alongside it in the agent container must not have come across.
		strictEqual(
			existsInContainer(working, "/root/.claude/projects"),
			false,
			"claude projects/ history must not bleed into the working container",
		);
	});
});

describe("provisionCredentials is best-effort when the source has no credentials", () => {
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
		strictEqual(provisionCredentials(working, AGENT_EMPTY), 0);
	});

	it("does not fabricate credential files in the working container", () => {
		strictEqual(
			existsInContainer(working, "/root/.claude.json"),
			false,
			"an absent source must be skipped, never invented",
		);
	});
});

describe("provisionCredentials rejects unsafe identifiers before any docker call", () => {
	it("throws on an unsafe working container name", () => {
		throws(
			() => provisionCredentials("bad; rm -rf /", "switchyard-agent"),
			/unsafe characters/,
		);
	});

	it("throws on an unsafe agent container name", () => {
		throws(
			() => provisionCredentials("switchyard-work-x", "bad name"),
			/unsafe characters/,
		);
	});
});
