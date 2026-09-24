import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	cleanupSimpleWorktree,
	simpleQuarantinePath,
} from "../src/switchyard/simple/worktree-cleanup.mjs";

const TEST_PARENT = "/private/tmp";
const MARKER_NAME = ".switchyard-cleanup-owner.json";
const TEST_DIR_PREFIX = "switchyard-safe-remove-";
const SCRIPT_PATH = fileURLToPath(
	new URL("../scripts/safe-remove-worktree.py", import.meta.url),
);
const createdPaths = new Set();

function newFixturePath(suffix = "") {
	const path = join(TEST_PARENT, `${TEST_DIR_PREFIX}${randomUUID()}${suffix}`);
	createdPaths.add(path);
	return path;
}

function writeOwnerMarker(root, runId, nonce) {
	const markerPath = join(root, MARKER_NAME);
	writeFileSync(markerPath, JSON.stringify({ runId, nonce }), {
		flag: "wx",
		mode: 0o600,
	});
	chmodSync(markerPath, 0o600);
}

function createCandidate(root, runId, nonce) {
	mkdirSync(root, { mode: 0o700 });
	chmodSync(root, 0o700);
	writeOwnerMarker(root, runId, nonce);
	return lstatSync(root, { bigint: true });
}

function helperInput(root, identity, runId, nonce) {
	return JSON.stringify({
		quarantinePath: root,
		expectedDevice: identity.dev.toString(),
		expectedInode: identity.ino.toString(),
		runId,
		nonce,
	});
}

function runHelper(input) {
	return spawnSync("/usr/bin/python3", [SCRIPT_PATH], {
		encoding: "utf8",
		input,
		maxBuffer: 1_000_000,
	});
}

afterEach(() => {
	for (const path of createdPaths) {
		if (existsSync(path)) {
			rmSync(path, { force: true, recursive: true });
		}
	}
	createdPaths.clear();
});

describe("descriptor-anchored worktree removal", {
	skip: process.platform !== "darwin",
}, () => {
	it("quarantines and removes a stopped writer root with durable identity", async () => {
		const runId = `cleanup-js-${randomUUID()}`;
		const nonce = randomUUID();
		const root = newFixturePath();
		const quarantine = simpleQuarantinePath(nonce);
		createdPaths.add(quarantine);
		const identity = createCandidate(root, runId, nonce);
		writeFileSync(join(root, "artifact.txt"), "owned", { mode: 0o600 });
		const claim = {
			canonicalParent: TEST_PARENT,
			candidateChild: root.slice(TEST_PARENT.length + 1),
			path: root,
			device: identity.dev.toString(),
			inode: identity.ino.toString(),
			nonce,
		};
		const result = await cleanupSimpleWorktree(runId, claim, {
			writerStopped: true,
		});
		deepStrictEqual(result, { removed: true, path: quarantine, reason: null });
		strictEqual(existsSync(root), false);
		strictEqual(existsSync(quarantine), false);
	});

	it("retains an open quarantine and removes it after the handle closes", async () => {
		const runId = `cleanup-open-${randomUUID()}`;
		const nonce = randomUUID();
		const root = newFixturePath();
		const quarantine = simpleQuarantinePath(nonce);
		createdPaths.add(quarantine);
		const identity = createCandidate(root, runId, nonce);
		const file = join(root, "artifact.txt");
		writeFileSync(file, "owned", { mode: 0o600 });
		const claim = {
			canonicalParent: TEST_PARENT,
			candidateChild: root.slice(TEST_PARENT.length + 1),
			path: root,
			device: identity.dev.toString(),
			inode: identity.ino.toString(),
			nonce,
		};
		const fd = openSync(file, "r");
		try {
			const retained = await cleanupSimpleWorktree(runId, claim, {
				writerStopped: true,
			});
			strictEqual(retained.removed, false);
			strictEqual(retained.path, quarantine);
			strictEqual(existsSync(quarantine), true);
		} finally {
			closeSync(fd);
		}
		const stillRetained = await cleanupSimpleWorktree(
			runId,
			{
				...claim,
				candidateChild: basename(quarantine),
				path: quarantine,
			},
			{ writerStopped: true, postQuarantineCheck: async () => false },
		);
		strictEqual(stillRetained.reason, "recently_modified_or_unavailable");
		strictEqual(existsSync(quarantine), true);
		const removed = await cleanupSimpleWorktree(
			runId,
			{
				...claim,
				candidateChild: basename(quarantine),
				path: quarantine,
			},
			{ writerStopped: true },
		);
		strictEqual(removed.removed, true);
		strictEqual(existsSync(quarantine), false);
	});
	it("removes only the verified quarantine and does not follow symlinks", () => {
		const root = newFixturePath();
		const outsideFile = newFixturePath("-outside");
		const runId = "cleanup-success";
		const nonce = "nonce-success";
		const identity = createCandidate(root, runId, nonce);
		const nested = join(root, "one", "two");
		mkdirSync(nested, { recursive: true, mode: 0o700 });
		writeFileSync(join(nested, "artifact.txt"), "owned data", { mode: 0o600 });
		writeFileSync(outsideFile, "keep this sentinel", {
			flag: "wx",
			mode: 0o600,
		});
		symlinkSync(outsideFile, join(root, "outside-link"));

		const result = runHelper(helperInput(root, identity, runId, nonce));

		strictEqual(result.status, 0, result.stderr);
		deepStrictEqual(JSON.parse(result.stdout), {
			status: "removed",
			removedEntries: 4,
		});
		ok(result.stderr.includes("identity and ownership marker verified"));
		ok(result.stderr.includes("removed quarantine (4 entries)"));
		strictEqual(existsSync(root), false);
		strictEqual(readFileSync(outsideFile, "utf8"), "keep this sentinel");
	});

	it("refuses a swapped quarantine identity and preserves both directories", () => {
		const root = newFixturePath();
		const displaced = newFixturePath("-displaced");
		const runId = "cleanup-swap";
		const nonce = "nonce-swap";
		const originalIdentity = createCandidate(root, runId, nonce);
		writeFileSync(join(root, "original.txt"), "original", { mode: 0o600 });
		renameSync(root, displaced);
		createdPaths.add(displaced);

		mkdirSync(root, { mode: 0o700 });
		chmodSync(root, 0o700);
		writeOwnerMarker(root, runId, nonce);
		writeFileSync(join(root, "replacement.txt"), "replacement", {
			mode: 0o600,
		});
		const replacementIdentity = lstatSync(root, { bigint: true });
		ok(
			replacementIdentity.ino !== originalIdentity.ino,
			"the replacement must have a different inode",
		);

		const result = runHelper(helperInput(root, originalIdentity, runId, nonce));

		strictEqual(result.status, 1);
		ok(result.stderr.includes("device or inode does not match"));
		strictEqual(
			readFileSync(join(root, "replacement.txt"), "utf8"),
			"replacement",
		);
		strictEqual(
			readFileSync(join(displaced, "original.txt"), "utf8"),
			"original",
		);
		ok(existsSync(root));
	});

	it("refuses a marker symlink and leaves its target intact", () => {
		const root = newFixturePath();
		const outsideMarker = newFixturePath("-marker");
		mkdirSync(root, { mode: 0o700 });
		chmodSync(root, 0o700);
		writeFileSync(
			outsideMarker,
			JSON.stringify({ runId: "linked", nonce: "n" }),
			{
				mode: 0o600,
			},
		);
		symlinkSync(outsideMarker, join(root, MARKER_NAME));
		const identity = lstatSync(root, { bigint: true });

		const result = runHelper(helperInput(root, identity, "linked", "n"));

		strictEqual(result.status, 1);
		ok(result.stderr.includes("ownership marker cannot be opened safely"));
		ok(existsSync(root));
		strictEqual(
			readFileSync(outsideMarker, "utf8"),
			JSON.stringify({ runId: "linked", nonce: "n" }),
		);
	});

	it("rejects paths outside the direct /private/tmp child boundary", () => {
		const result = runHelper(
			JSON.stringify({
				quarantinePath: "/private/tmp/../tmp/not-owned",
				expectedDevice: "1",
				expectedInode: "2",
				runId: "path-boundary",
				nonce: "nonce-path",
			}),
		);

		strictEqual(result.status, 1);
		ok(result.stderr.includes("direct child of /private/tmp"));
	});

	it("requires canonical decimal strings for device and inode identities", () => {
		for (const expectedDevice of ["01", -1, 1]) {
			const result = runHelper(
				JSON.stringify({
					quarantinePath: "/private/tmp/not-created",
					expectedDevice,
					expectedInode: "2",
					runId: "identity-format",
					nonce: "nonce-format",
				}),
			);

			strictEqual(result.status, 1);
			ok(
				result.stderr.includes(
					"expectedDevice must be an unsigned decimal string",
				),
			);
		}
	});

	it("restores the ownership marker when final directory removal fails", () => {
		const runId = `cleanup-restore-${randomUUID()}`;
		const nonce = randomUUID();
		const root = newFixturePath();
		const identity = createCandidate(root, runId, nonce);
		const python = `
import importlib.util, json, os, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('safe_remove', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(sys.stdin.read())
name = module.validate_payload(payload)
marker = os.path.join(payload['quarantinePath'], module.OWNER_MARKER)
final_rmdir_attempts = []
def fail_final(name, dir_fd=None):
    assert name == os.path.basename(payload['quarantinePath'])
    assert not os.path.exists(marker), 'marker was not removed before final rmdir'
    final_rmdir_attempts.append(name)
    raise PermissionError('injected final failure')
with patch.object(os, 'rmdir', side_effect=fail_final):
    try:
        module.remove_verified_quarantine(payload, name)
    except module.RemovalError:
        pass
    else:
        raise AssertionError('removal unexpectedly succeeded')
print(len(final_rmdir_attempts), os.path.exists(marker))
`;
		const result = spawnSync("/usr/bin/python3", ["-c", python, SCRIPT_PATH], {
			encoding: "utf8",
			input: helperInput(root, identity, runId, nonce),
		});
		strictEqual(result.status, 0, result.stderr);
		strictEqual(result.stdout.trim(), "1 True");
		const retried = runHelper(helperInput(root, identity, runId, nonce));
		strictEqual(retried.status, 0, retried.stderr);
		strictEqual(existsSync(root), false);
	});
});
