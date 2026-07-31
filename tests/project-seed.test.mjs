// seedProject test: the missing lifecycle step that puts the host project's
// committed tree into a fresh working container so an agent edits real code and
// captureDiff() has a git baseline to diff against. Before this, /project was
// an empty volume and every dispatch dead-ended at "success_no_diff", never
// reaching the integration gate (INV-2).
//
// The live portion exercises the real docker+git mechanism against a real
// working container built FROM the agent image (which carries git). It is
// skipped when that image isn't built, so the gate still passes on a host with
// only alpine — the full seed->edit->captureDiff->gate chain is additionally
// proven by the live capstone dispatch. The identifier-validation test always
// runs (no docker required).
//
// INV-1: seedProject moves bytes host->container over an in-memory tar Buffer
// via `docker cp` — no host path is bind-mounted. Only the committed HEAD tree
// crosses (git archive excludes .git), so host history never enters the
// disposable container. Fixtures use throwaway, non-secret content.

import { ok, strictEqual, throws } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	AGENT_IMAGE,
	imageExists,
} from "../src/switchyard/container/index.mjs";
import {
	commitWorkingTree,
	createWorkingContainer,
	execInWorkingContainer,
	seedProject,
	wipeWorkingContainer,
} from "../src/switchyard/lifecycle/index.mjs";
import { reapOwnManagedObjects } from "./helpers/lifecycle-fixture.mjs";

const SEED_SKIP = imageExists(AGENT_IMAGE)
	? false
	: `${AGENT_IMAGE} not built — skipping live seedProject test`;

after(() => reapOwnManagedObjects());

describe("seedProject copies the host committed tree into the working container", {
	skip: SEED_SKIP,
}, () => {
	let hostRepo;
	let working;

	before(() => {
		hostRepo = mkdtempSync(join(tmpdir(), "switchyard-seed-test-"));
		mkdirSync(join(hostRepo, "src"), { recursive: true });
		// A nested tracked file proves subdirectories seed correctly, and a
		// two-line body gives an agent edit something to diff against.
		writeFileSync(join(hostRepo, "src", "app.txt"), "one\ntwo\n", "utf8");
		writeFileSync(join(hostRepo, "README.md"), "# proj\n", "utf8");
		execFileSync("git", ["-C", hostRepo, "init", "-q"]);
		execFileSync("git", ["-C", hostRepo, "config", "user.email", "t@t.local"]);
		execFileSync("git", ["-C", hostRepo, "config", "user.name", "t"]);
		execFileSync("git", ["-C", hostRepo, "add", "-A"]);
		execFileSync("git", ["-C", hostRepo, "commit", "-q", "-m", "init"]);
		working = createWorkingContainer(hostRepo, AGENT_IMAGE);
		seedProject(working, hostRepo);
	});

	after(() => {
		if (working) {
			wipeWorkingContainer(working);
		}
		if (hostRepo) {
			rmSync(hostRepo, { recursive: true, force: true });
		}
	});

	it("reproduces the tracked files (including nested paths) inside /project", () => {
		strictEqual(
			execInWorkingContainer(working, "cat /project/src/app.txt"),
			"one\ntwo",
		);
		strictEqual(
			execInWorkingContainer(working, "cat /project/README.md"),
			"# proj",
		);
	});

	it("initializes /project as a git repo with a clean committed baseline", () => {
		// A clean baseline means a later agent edit surfaces as a diff, not as
		// the whole tree appearing new.
		strictEqual(
			execInWorkingContainer(working, "cd /project && git status --porcelain"),
			"",
		);
		ok(
			execInWorkingContainer(
				working,
				"cd /project && git rev-parse --is-inside-work-tree",
			).includes("true"),
		);
	});

	it("does not carry host .git history into the container (archive excludes it)", () => {
		// Exactly one commit — the container's own baseline — never the host's
		// history, because git archive HEAD sends only the tree.
		strictEqual(
			execInWorkingContainer(
				working,
				"cd /project && git rev-list --count HEAD",
			),
			"1",
		);
	});

	it("surfaces an in-container edit to a seeded tracked file as a git diff", () => {
		// Ties the seed to its purpose: after seeding, an edit to a tracked
		// file is visible to `git diff` — which is what captureDiff returns.
		execInWorkingContainer(working, "cd /project && echo three >> src/app.txt");
		const diff = execInWorkingContainer(working, "cd /project && git diff");
		ok(diff.includes("+three"), "the edit must appear in git diff");
	});
});

describe("seedProject rejects unsafe identifiers before any docker/git call", () => {
	it("throws on an unsafe working container name", () => {
		throws(
			() => seedProject("bad; rm -rf /", "/tmp/switchyard-seed-noop"),
			/unsafe characters/,
		);
	});

	it("commitWorkingTree throws on an unsafe working container name", () => {
		throws(() => commitWorkingTree("bad; rm -rf /"), /unsafe characters/);
	});
});

// Findings #1 (new files were invisible to captureDiff's plain `git diff`), #2
// (seed baseline dropped force-added-ignored files) and #3 (no baseline advance
// between tasks, so task 2's diff re-emitted task 1) — proven mechanically here
// against a real container without needing a provider. The live capstone proves
// the same chain end-to-end with a real agent.
describe("seed baseline + capture + commit lifecycle (findings #1/#2/#3)", {
	skip: SEED_SKIP,
}, () => {
	let hostRepo;
	let working;

	before(() => {
		hostRepo = mkdtempSync(join(tmpdir(), "switchyard-seedlc-"));
		mkdirSync(join(hostRepo, "build"), { recursive: true });
		writeFileSync(join(hostRepo, ".gitignore"), "build/\n", "utf8");
		writeFileSync(join(hostRepo, "build", "keep.txt"), "keep\n", "utf8");
		writeFileSync(join(hostRepo, "tracked.txt"), "one\n", "utf8");
		execFileSync("git", ["-C", hostRepo, "init", "-q"]);
		execFileSync("git", ["-C", hostRepo, "config", "user.email", "t@t.local"]);
		execFileSync("git", ["-C", hostRepo, "config", "user.name", "t"]);
		execFileSync("git", ["-C", hostRepo, "add", ".gitignore", "tracked.txt"]);
		// Force-add a tracked-but-ignored file: `git archive` includes it, so the
		// seed's baseline must too (finding #2), or later edits to it vanish.
		execFileSync("git", ["-C", hostRepo, "add", "-f", "build/keep.txt"]);
		execFileSync("git", ["-C", hostRepo, "commit", "-q", "-m", "init"]);
		working = createWorkingContainer(hostRepo, AGENT_IMAGE);
		seedProject(working, hostRepo);
	});

	after(() => {
		if (working) {
			wipeWorkingContainer(working);
		}
		if (hostRepo) {
			rmSync(hostRepo, { recursive: true, force: true });
		}
	});

	it("#2: seed baseline tracks a force-added-ignored file (git add -A -f)", () => {
		const tracked = execInWorkingContainer(
			working,
			"cd /project && git ls-files",
		).split("\n");
		ok(
			tracked.includes("build/keep.txt"),
			`baseline must track force-added build/keep.txt; got: ${tracked.join(",")}`,
		);
	});

	it("#1/#3: a new file is captured, and each commit isolates the next task's diff", () => {
		// #1: a brand-new file must surface in the staged capture — plain
		// `git diff` (the old captureDiff) would have missed it entirely.
		execInWorkingContainer(working, "cd /project && echo first > newA.txt");
		const cap1 = execInWorkingContainer(
			working,
			"cd /project && git add -A && git diff --cached HEAD",
		);
		ok(
			cap1.includes("newA.txt"),
			"a newly created file must appear in the staged capture",
		);

		// #3: committing task 1 advances the baseline, so task 2's capture shows
		// only its own new file — not newA.txt re-emitted (which would make the
		// host `git apply` reject task 2).
		commitWorkingTree(working);
		execInWorkingContainer(working, "cd /project && echo second > newB.txt");
		const cap2 = execInWorkingContainer(
			working,
			"cd /project && git add -A && git diff --cached HEAD",
		);
		ok(cap2.includes("newB.txt"), "task 2's own new file must appear");
		ok(
			!cap2.includes("newA.txt"),
			"committed task-1 file must NOT re-appear in task-2's capture (isolation)",
		);
	});
});
