// Standalone-reaper ops contract tests.
//
// Verifies the launchd reaper artifacts (ops/switchyard-reaper.sh, the plist
// template, install/uninstall scripts) are present, syntactically valid, render
// a well-formed plist, and — critically — that the reaper's hardcoded VM-name
// prefix stays in sync with the source of truth in
// parallels-execution-backend.mjs. The reaper duplicates that prefix by
// necessity (it is a standalone shell script that reads no project code so it
// can run TCC-free from ~/Library); this parity test is what stops a rename
// there from silently disabling reaping.
//
// Deliberately does NOT run the reaper against the live daemon: that path reaps
// by PID liveness and could remove a sibling test file's fixtures under Node's
// parallel test-file execution. The reap logic itself is exercised by the
// recover suites.

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";

import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PARALLELS_LINKED_SNAPSHOT_NAME } from "../src/switchyard/lifecycle/parallels-execution-backend.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const OPS = resolve(PKG_ROOT, "ops");
const BACKEND = resolve(
	PKG_ROOT,
	"src/switchyard/lifecycle/parallels-execution-backend.mjs",
);

const REAPER = resolve(OPS, "switchyard-reaper.sh");
const SCRIPTS = [REAPER].concat(
	["install-reaper.sh", "uninstall-reaper.sh"].map((f) => resolve(OPS, f)),
);
const TEMPLATE = resolve(OPS, "com.zerodelta.switchyard.reaper.plist.template");

describe("standalone reaper ops artifacts", () => {
	it("ships all reaper scripts, executable", () => {
		for (const s of SCRIPTS) {
			ok(existsSync(s), `missing: ${s}`);
			accessSync(s, constants.X_OK);
		}
	});

	it("every reaper script passes `sh -n` syntax validation", () => {
		for (const s of SCRIPTS) {
			const r = spawnSync("sh", ["-n", s], { encoding: "utf8" });
			strictEqual(r.status, 0, `sh -n failed for ${s}: ${r.stderr}`);
		}
	});

	it("the reaper reads managed VM names only — never invokes node/project code", () => {
		const body = readFileSync(REAPER, "utf8");
		// The load-bearing TCC guarantee: with no node invocation the reaper
		// physically cannot execute project .mjs, so it needs nothing from the
		// ~/Documents-protected tree at runtime. (Prose comments may still name
		// the source file / ~/Documents to explain the design — that's why we
		// assert on the *absence of an interpreter*, not on path mentions.)
		ok(!/\bnode\b/.test(body), "reaper must not invoke node");
		ok(!/\bpython3?\b/.test(body), "reaper must not invoke python");
		// It must actually do the name-based reap. Invocations go through
		// $PRLCTL, which defaults to `prlctl` and is overridable so the
		// end-to-end tests below can stub it instead of reaching the daemon.
		ok(
			/PRLCTL="\$\{SWITCHYARD_REAPER_PRLCTL:-prlctl\}"/.test(body),
			"reaper must default its prlctl binary to prlctl",
		);
		ok(/"\$PRLCTL" list\s+-a/.test(body), "reaper must list managed VMs");
		ok(/kill -0/.test(body), "reaper must probe owner liveness via kill -0");
		ok(/"\$PRLCTL" delete/.test(body), "reaper must force-remove dead VMs");
	});

	it("reaper VM-name prefix stays in sync with parallels-execution-backend.mjs (parity guard)", () => {
		const reaper = readFileSync(REAPER, "utf8");
		const backend = readFileSync(BACKEND, "utf8");

		const srcPrefix = /PARALLELS_WORKING_PREFIX\s*=\s*"([^"]+)"/.exec(
			backend,
		)?.[1];
		ok(srcPrefix, "could not read PARALLELS_WORKING_PREFIX from backend");

		const reaperPrefix = /WORKING_PREFIX="([^"]+)"/.exec(reaper)?.[1];
		ok(reaperPrefix, "could not read WORKING_PREFIX from reaper");

		strictEqual(
			reaperPrefix,
			srcPrefix,
			"reaper WORKING_PREFIX drifted from backend PARALLELS_WORKING_PREFIX",
		);
	});

	it("plist template renders to a valid, placeholder-free plist", () => {
		const template = readFileSync(TEMPLATE, "utf8");
		for (const ph of ["__REAPER_SH__", "__REAPER_OUT__", "__REAPER_ERR__"]) {
			ok(template.includes(ph), `template must contain ${ph}`);
		}
		const rendered = template
			.replaceAll("__REAPER_SH__", "/tmp/switchyard-reaper.sh")
			.replaceAll("__REAPER_OUT__", "/tmp/out.log")
			.replaceAll("__REAPER_ERR__", "/tmp/err.log");
		ok(!/__[A-Z_]+__/.test(rendered), "rendered plist still has a placeholder");

		const lint = spawnSync("plutil", ["-lint", "-"], {
			input: rendered,
			encoding: "utf8",
		});
		if (lint.error) return; // plutil unavailable (non-macOS) — skip lint.
		strictEqual(lint.status, 0, `plutil -lint failed: ${lint.stdout}`);
	});

	it("install/uninstall target the same label and are idempotent", () => {
		const label = "com.zerodelta.switchyard.reaper";
		for (const f of ["install-reaper.sh", "uninstall-reaper.sh"]) {
			const body = readFileSync(resolve(OPS, f), "utf8");
			ok(body.includes(label), `${f} must reference ${label}`);
			ok(
				body.includes('bootout "$DOMAIN/$LABEL"'),
				`${f} must bootout before (re)install/remove (idempotent)`,
			);
		}
		ok(readFileSync(TEMPLATE, "utf8").includes(label));
	});
});

describe("reaper snapshot reporting", () => {
	const GOLDEN = "switchyard-golden-test";
	const ORPHAN = "{9f6e0d53-5e8c-4b99-916d-327f334f0899}";
	const RECORDED = "{aaaaaaaa-0000-4000-8000-000000000000}";
	// Predates the sidecar convention; the reaper must never name it.
	const FOREIGN = "{51f4e833-0daa-4088-8325-3cfa0c62290a}";

	// The real shape, captured from prlctl 26.4.1 on 2026-08-26. Parsing a
	// hand-simplified fixture would prove nothing about the live output.
	function snapshotListJson() {
		return `{
	"${FOREIGN}": {
	"name": "switchyard-golden-26-5",
	"date": "2026-08-13 16:22:24",
	"state": "poweroff",
	"current": false,
	"parent": ""
}
,
	"${ORPHAN}": {
	"name": "Snapshot for linked clone",
	"date": "2026-08-13 16:25:41",
	"state": "poweroff",
	"current": true,
	"parent": "${FOREIGN}"
}
,
	"${RECORDED}": {
	"name": "Snapshot for linked clone",
	"date": "2026-08-20 10:00:00",
	"state": "poweroff",
	"current": false,
	"parent": "${FOREIGN}"
}

}
`;
	}

	/**
	 * Run the reaper with a stubbed `prlctl` and a scratch HOME. No live daemon
	 * is contacted, so this cannot touch a sibling suite's fixtures.
	 */
	function runReaper({ sidecars = [] } = {}) {
		const root = tempDir("switchyard-reaper-");
		const binDir = join(root, "bin");
		const home = join(root, "home");
		const sidecarDir = join(
			home,
			".switchyard",
			"admission",
			"linked-snapshots",
		);
		mkdirSync(binDir, { recursive: true });
		mkdirSync(join(home, "Library", "Logs"), { recursive: true });
		mkdirSync(sidecarDir, { recursive: true });
		for (const [index, record] of sidecars.entries()) {
			writeFileSync(
				join(sidecarDir, `clone-${index}.json`),
				JSON.stringify(record),
				"utf8",
			);
		}

		const callLog = join(root, "prlctl-calls.log");
		writeFileSync(
			join(binDir, "prlctl"),
			`#!/bin/sh
printf '%s\\n' "$*" >>'${callLog}'
case "$1" in
	list) printf 'UUID STATUS NAME\\n' ;;
	snapshot-list) cat <<'SNAPJSON'
${snapshotListJson()}
SNAPJSON
		;;
esac
exit 0
`,
			{ mode: 0o755 },
		);

		const result = spawnSync("sh", [REAPER], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				// Explicit binary, not a PATH prepend: the reaper replaces PATH
				// outright, so a prepended stub dir would be dropped and this
				// test would reach the live daemon.
				SWITCHYARD_REAPER_PRLCTL: join(binDir, "prlctl"),
				SWITCHYARD_PARALLELS_GOLDEN_IMAGE: GOLDEN,
			},
		});
		const log = readFileSync(
			join(home, "Library", "Logs", "switchyard-reaper.log"),
			"utf8",
		);
		const calls = existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
		return { result, log, calls, root };
	}

	it("reports a matching snapshot that no sidecar accounts for", () => {
		const { result, log, root } = runReaper({
			sidecars: [{ goldenImage: GOLDEN, snapshotIds: [RECORDED] }],
		});
		strictEqual(result.status, 0, result.stderr);
		ok(
			log.includes(`UNRECORDED snapshot ${ORPHAN}`),
			`orphan must be reported, log was:\n${log}`,
		);
		ok(
			log.includes("unrecorded=1"),
			`exactly one unrecorded snapshot expected, log was:\n${log}`,
		);
		ok(
			!log.includes(RECORDED),
			"a snapshot a sidecar names must not be reported",
		);
		ok(
			!log.includes(FOREIGN),
			"a snapshot that is not a linked-clone parent must not be reported",
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("never deletes a snapshot it reports", () => {
		// The residue case is unreclaimable by design: code must not delete a
		// snapshot it did not record. Reporting is the entire remedy.
		const { calls, log, root } = runReaper();
		ok(log.includes(`UNRECORDED snapshot ${ORPHAN}`));
		ok(
			!/snapshot-delete/.test(calls),
			`no snapshot may be deleted, prlctl saw:\n${calls}`,
		);
		rmSync(root, { recursive: true, force: true });
	});

	it("says the check was skipped rather than reporting a clean result it never ran", () => {
		const root = tempDir("switchyard-reaper-");
		const binDir = join(root, "bin");
		const home = join(root, "home");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(join(home, "Library", "Logs"), { recursive: true });
		writeFileSync(
			join(binDir, "prlctl"),
			"#!/bin/sh\ncase \"$1\" in list) printf 'UUID STATUS NAME\\n' ;; esac\nexit 0\n",
			{ mode: 0o755 },
		);
		const result = spawnSync("sh", [REAPER], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				SWITCHYARD_REAPER_PRLCTL: join(binDir, "prlctl"),
				SWITCHYARD_PARALLELS_GOLDEN_IMAGE: "",
			},
		});
		strictEqual(result.status, 0, result.stderr);
		const log = readFileSync(
			join(home, "Library", "Logs", "switchyard-reaper.log"),
			"utf8",
		);
		ok(
			log.includes("snapshot check skipped"),
			`an unchecked run must say so, log was:\n${log}`,
		);
		ok(!log.includes("unrecorded="), "no count may be reported for no check");
		rmSync(root, { recursive: true, force: true });
	});

	it("linked-clone snapshot name stays in sync with the backend (parity guard)", () => {
		const reaper = readFileSync(REAPER, "utf8");
		const reaperName = /LINKED_SNAPSHOT_NAME="([^"]+)"/.exec(reaper)?.[1];
		ok(reaperName, "could not read LINKED_SNAPSHOT_NAME from reaper");
		// Compared against the imported constant, not a regex over the backend's
		// source: the reaper is the side that must duplicate the literal, so the
		// backend stays the single definition rather than a second string to
		// keep in step.
		strictEqual(
			reaperName,
			PARALLELS_LINKED_SNAPSHOT_NAME,
			"reaper LINKED_SNAPSHOT_NAME drifted from the backend constant",
		);
		ok(
			reaper.includes(
				`LINKED_SNAPSHOT_NAME="${PARALLELS_LINKED_SNAPSHOT_NAME}"`,
			),
			"the reaper must carry the literal verbatim",
		);
	});

	it("sidecar directory stays in sync with the backend (parity guard)", () => {
		const backend = readFileSync(BACKEND, "utf8");
		const reaper = readFileSync(REAPER, "utf8");
		ok(
			/join\(this\.snapshotSidecarRoot,\s*"linked-snapshots"\)/.test(backend),
			"backend no longer builds its sidecar dir as <root>/linked-snapshots",
		);
		const reaperDir = /SIDECAR_DIR="([^"]+)"/.exec(reaper)?.[1];
		ok(reaperDir, "could not read SIDECAR_DIR from reaper");
		ok(
			reaperDir.endsWith("/linked-snapshots"),
			`reaper SIDECAR_DIR drifted from the backend layout: ${reaperDir}`,
		);
		ok(
			reaperDir.includes(".switchyard/admission"),
			`reaper SIDECAR_DIR must sit under the VM admission root: ${reaperDir}`,
		);
	});
});
