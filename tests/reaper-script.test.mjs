// Standalone-reaper ops contract tests.
//
// Verifies the launchd reaper artifacts (ops/switchyard-reaper.sh, the plist
// template, install/uninstall scripts) are present, syntactically valid, render
// a well-formed plist, and — critically — that the reaper's hardcoded Docker
// label strings stay in sync with the source of truth in lifecycle/index.mjs.
// The reaper duplicates those labels by necessity (it is a standalone shell
// script that reads no project code so it can run TCC-free from ~/Library); this
// parity test is what stops a rename there from silently disabling reaping.
//
// Deliberately does NOT run the reaper against the live daemon: that path reaps
// by PID liveness and could remove a sibling test file's fixtures under Node's
// parallel test-file execution. The reap logic itself is exercised by the
// recover suites.

import { ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const OPS = resolve(PKG_ROOT, "ops");
const LIFECYCLE = resolve(PKG_ROOT, "src/switchyard/lifecycle/index.mjs");

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

	it("the reaper reads Docker labels only — never invokes node/project code", () => {
		const body = readFileSync(REAPER, "utf8");
		// The load-bearing TCC guarantee: with no node invocation the reaper
		// physically cannot execute project .mjs, so it needs nothing from the
		// ~/Documents-protected tree at runtime. (Prose comments may still name
		// the source file / ~/Documents to explain the design — that's why we
		// assert on the *absence of an interpreter*, not on path mentions.)
		ok(!/\bnode\b/.test(body), "reaper must not invoke node");
		ok(!/\bpython3?\b/.test(body), "reaper must not invoke python");
		// It must actually do the label-based reap.
		ok(/docker\s+ps\s+-aq/.test(body), "reaper must list managed containers");
		ok(/kill -0/.test(body), "reaper must probe owner liveness via kill -0");
		ok(
			/docker rm -f -v/.test(body),
			"reaper must force-remove dead containers",
		);
	});

	it("reaper label strings stay in sync with lifecycle/index.mjs (parity guard)", () => {
		const reaper = readFileSync(REAPER, "utf8");
		const lifecycle = readFileSync(LIFECYCLE, "utf8");

		// Source of truth in lifecycle: LABEL_MANAGED includes "=true"; strip it
		// to the bare key. LABEL_WORKER_PID is already the bare key.
		const srcManaged = /LABEL_MANAGED\s*=\s*"([^"]+)"/
			.exec(lifecycle)?.[1]
			?.replace(/=true$/, "");
		const srcPid = /LABEL_WORKER_PID\s*=\s*"([^"]+)"/.exec(lifecycle)?.[1];
		ok(srcManaged, "could not read LABEL_MANAGED from lifecycle");
		ok(srcPid, "could not read LABEL_WORKER_PID from lifecycle");

		const reaperManaged = /MANAGED_LABEL="([^"]+)"/.exec(reaper)?.[1];
		const reaperPid = /PID_LABEL="([^"]+)"/.exec(reaper)?.[1];
		ok(reaperManaged, "could not read MANAGED_LABEL from reaper");
		ok(reaperPid, "could not read PID_LABEL from reaper");

		strictEqual(
			reaperManaged,
			srcManaged,
			"reaper MANAGED_LABEL drifted from lifecycle LABEL_MANAGED",
		);
		strictEqual(
			reaperPid,
			srcPid,
			"reaper PID_LABEL drifted from lifecycle LABEL_WORKER_PID",
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
