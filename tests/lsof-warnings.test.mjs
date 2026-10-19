// @test-phase: other
import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { parseLsofResult as parseOrphanLsof } from "../scripts/simple-orphan-collector-scan.mjs";
import { parseLsofResult as parseSweepLsof } from "../scripts/sweep-temp-dirs.mjs";
import { lsofListingComplete } from "../src/switchyard/util/lsof-warnings.mjs";

// Verbatim stderr of `lsof -nP -F pfn -d cwd` on 2026-10-19 while a Time
// Machine backup had its SMB share mounted. Every Switchyard check then failed
// check_group_unconfirmed, and the temp sweeps refused to run.
const MOUNT =
	"/Volumes/.timemachine/truenas._smb._tcp.local./3A0605F9-B95A-48E9-9457-E60B98B36577/timemachine";
const block = (mount, type = "smbfs", dev = "3600000a") =>
	`lsof: WARNING: can't stat() ${type} file system ${mount}\n      Output information may be incomplete.\n      assuming "dev=${dev}" from mount table\n`;
const TIME_MACHINE = block(MOUNT);
const TEMP = "/private/var/folders/ab/cd/T";

describe("lsofListingComplete", () => {
	it("accepts empty stderr with or without a scope", () => {
		for (const stderr of ["", undefined, null]) {
			strictEqual(lsofListingComplete(stderr, []), true);
			strictEqual(lsofListingComplete(stderr, [TEMP]), true);
		}
	});

	it("accepts an unstattable mount unrelated to the scope", () => {
		strictEqual(lsofListingComplete(TIME_MACHINE, [TEMP]), true);
		strictEqual(
			lsofListingComplete(TIME_MACHINE + block("/Volumes/nas", "nfs"), [
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
			strictEqual(lsofListingComplete(TIME_MACHINE, [scope]), false, scope);
		strictEqual(lsofListingComplete(TIME_MACHINE, [TEMP, "/Volumes"]), false);
	});

	it("compares whole path segments, including names with spaces", () => {
		const spaced = block("/Volumes/My Backup");
		strictEqual(lsofListingComplete(spaced, [TEMP]), true);
		strictEqual(lsofListingComplete(spaced, ["/Volumes/My Backup/x"]), false);
		strictEqual(lsofListingComplete(spaced, ["/Volumes/My Backups"]), true);
		strictEqual(
			lsofListingComplete(block("/Volumes/Back"), ["/Volumes/Backup"]),
			true,
		);
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
			Buffer.from(TIME_MACHINE),
		])
			strictEqual(lsofListingComplete(stderr, [TEMP]), false, String(stderr));
	});

	it("never accepts a warning without a scope", () => {
		strictEqual(lsofListingComplete(TIME_MACHINE, []), false);
	});
});

describe("temp sweeps during a Time Machine backup", () => {
	const stdout = `p1\nn${TEMP}/switchyard-x/f\nn*:*\n`;
	for (const [name, parse] of [
		["sweep-temp-dirs", parseSweepLsof],
		["simple-orphan-collector", parseOrphanLsof],
	])
		it(`${name} keeps the listing for a scope off the unstattable mount`, () => {
			const result = { status: 0, stdout, stderr: TIME_MACHINE };
			deepStrictEqual(parse(result, [TEMP]), [`${TEMP}/switchyard-x/f`]);
			strictEqual(parse(result), null);
			strictEqual(parse(result, ["/Volumes"]), null);
		});
});
