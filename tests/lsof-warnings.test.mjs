// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseLsofResult as parseOrphanLsof } from "../scripts/simple-orphan-collector-scan.mjs";
import { parseLsofResult as parseSweepLsof } from "../scripts/sweep-temp-dirs.mjs";
import { lsofListingComplete } from "../src/switchyard/util/lsof-warnings.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

// Verbatim stderr of `lsof -nP -F pfn -d cwd` on 2026-10-19 while a Time
// Machine backup had its SMB share mounted. Every Switchyard check then failed
// check_group_unconfirmed, and the temp sweeps refused to run.
const MOUNT =
	"/Volumes/.timemachine/truenas._smb._tcp.local./3A0605F9-B95A-48E9-9457-E60B98B36577/timemachine";
const block = (mount, type = "smbfs", dev = "3600000a") =>
	`lsof: WARNING: can't stat() ${type} file system ${mount}\n      Output information may be incomplete.\n      assuming "dev=${dev}" from mount table\n`;
const TIME_MACHINE = block(MOUNT);
const TEMP = "/private/var/folders/ab/cd/T";
// The local data volume, as the scope roots below are taken to sit on.
const LOCAL_DEV = 0x100000e;
const complete = (stderr, scopeRoots, deviceOf = () => LOCAL_DEV) =>
	lsofListingComplete(stderr, scopeRoots, { deviceOf });

describe("lsofListingComplete", () => {
	it("accepts empty stderr with or without a scope", () => {
		for (const stderr of ["", undefined, null]) {
			strictEqual(complete(stderr, []), true);
			strictEqual(complete(stderr, [TEMP]), true);
		}
	});

	it("accepts an unstattable mount unrelated to the scope", () => {
		strictEqual(complete(TIME_MACHINE, [TEMP]), true);
		strictEqual(
			complete(TIME_MACHINE + block("/Volumes/nas", "nfs", "3600000b"), [
				TEMP,
				"/Users/someone/project",
			]),
			true,
		);
	});

	it("refuses a mount that is, contains, or sits inside a scope root", () => {
		for (const scope of [
			MOUNT,
			`${MOUNT}/Backups.backupdb`,
			"/Volumes",
			"/Volumes/.timemachine",
			"/",
		])
			strictEqual(complete(TIME_MACHINE, [scope]), false, scope);
		strictEqual(complete(TIME_MACHINE, [TEMP, "/Volumes"]), false);
	});

	it("refuses a mount on a scope root's device under another spelling", () => {
		// /System/Volumes/Data is firmlinked to /private/var: no shared prefix.
		const dataVolume = block(
			"/System/Volumes/Data",
			"apfs",
			LOCAL_DEV.toString(16),
		);
		strictEqual(complete(dataVolume, [TEMP]), false);
		strictEqual(
			complete(dataVolume, [TEMP], () => 0x1000012),
			true,
		);
	});

	it("refuses when a scope root's device cannot be read", () => {
		strictEqual(
			complete(TIME_MACHINE, [TEMP], () => null),
			false,
		);
		strictEqual(
			lsofListingComplete(TIME_MACHINE, ["/nonexistent/switchyard-scope"]),
			false,
		);
	});

	it("compares whole path segments, including names with spaces", () => {
		const spaced = block("/Volumes/My Backup");
		strictEqual(complete(spaced, [TEMP]), true);
		strictEqual(complete(spaced, ["/Volumes/My Backup/x"]), false);
		strictEqual(complete(spaced, ["/Volumes/My Backups"]), true);
		strictEqual(complete(block("/Volumes/Back"), ["/Volumes/Backup"]), true);
	});

	it("reads any other stderr as incomplete", () => {
		for (const stderr of [
			`${TIME_MACHINE}lsof: WARNING: can't stat() 1 file\n`,
			`${TIME_MACHINE}\n`,
			"lsof: WARNING: can't stat() 1 file\n",
			"Output information may be incomplete.\n",
			"lsof: WARNING: can't stat() smbfs file system /Volumes/x\n      Output information may be incomplete.\n",
			'lsof: WARNING: can\'t stat() smbfs file system relative/x\n      Output information may be incomplete.\n      assuming "dev=1" from mount table\n',
			TIME_MACHINE.replace("      Output", "    Output"),
			TIME_MACHINE.replace("dev=3600000a", "dev=36zz"),
			Buffer.from(TIME_MACHINE),
		])
			strictEqual(complete(stderr, [TEMP]), false, String(stderr));
	});

	it("never accepts a warning without a scope", () => {
		strictEqual(complete(TIME_MACHINE, []), false);
	});
});

describe("temp sweeps during a Time Machine backup", () => {
	const scope = realpathSync(tempDir("switchyard-lsof-scope-"));
	const held = join(scope, "switchyard-x", "f");
	const stdout = `p1\nn${held}\nn*:*\n`;
	const ownDevice = (statSync(scope).dev >>> 0).toString(16);
	for (const [name, parse] of [
		["sweep-temp-dirs", parseSweepLsof],
		["simple-orphan-collector", parseOrphanLsof],
	])
		it(`${name} keeps the listing for a scope off the unstattable mount`, () => {
			const result = { status: 0, stdout, stderr: TIME_MACHINE };
			deepStrictEqual(parse(result, [scope]), [held]);
			strictEqual(parse(result), null);
			strictEqual(parse(result, ["/Volumes"]), null);
			const sameDevice = block("/System/Volumes/Data", "apfs", ownDevice);
			strictEqual(parse({ ...result, stderr: sameDevice }, [scope]), null);
		});
});
