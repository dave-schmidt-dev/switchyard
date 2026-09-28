import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeStagedSnapshot } from "../scripts/check-contract-gates.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

function git(root, args, options = {}) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		...options,
	});
}

test("captures a complete staged snapshot larger than Node's default buffer", () => {
	const fixture = tempDir("switchyard-large-staged-diff-");
	git(fixture, ["init", "-q"]);
	git(fixture, ["config", "user.email", "test@example.invalid"]);
	git(fixture, ["config", "user.name", "Gate Test"]);
	const payload = join(fixture, "payload.txt");
	writeFileSync(payload, "baseline\n");
	git(fixture, ["add", "payload.txt"]);
	git(fixture, ["commit", "-qm", "fixture"]);

	const utf8Line = "stage-safe-utf8-é-漢-\u{1f680}\n";
	writeFileSync(payload, `${utf8Line.repeat(80_000)}end\n`);
	git(fixture, ["add", "payload.txt"]);

	const stagedPatch = git(fixture, [
		"diff",
		"--cached",
		"--binary",
		"--no-ext-diff",
	]);
	ok(Buffer.byteLength(stagedPatch, "utf8") > 1024 * 1024);
	const snapshot = computeStagedSnapshot(fixture);
	strictEqual(snapshot.head, git(fixture, ["rev-parse", "HEAD"]).trim());
	strictEqual(
		snapshot.indexTree,
		`sha256:${createHash("sha256")
			.update(git(fixture, ["ls-files", "-s", "-z"]))
			.digest("hex")}`,
	);
	strictEqual(
		snapshot.stagedDigest,
		`sha256:${createHash("sha256").update(stagedPatch).digest("hex")}`,
	);
	deepStrictEqual(snapshot.paths, ["payload.txt"]);
});
