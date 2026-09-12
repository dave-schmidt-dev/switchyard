// Increment 6 (F3.2 shared account authority) gate test: account identity.
//
// The accounting unit is one independently metered target, not one login and
// not one CLI binary. `antigravity` and `antigravity-claude` are the same
// Google login but meter separately (measured 2026-09-12: weekly 78.2% left
// resetting 09-17 versus 52.3% left resetting 09-13), so they must land on
// different roots. Every case below fixes the accounts root to a tempdir: a
// case that forgets would write a host key into the real ~/.switchyard, so the
// root assertions check the tempdir prefix rather than just "not null".

import { notStrictEqual, ok, strictEqual } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	accountIdentifier,
	identifiersMatch,
	readHostKey,
	resolveAccountRoot,
	resolveAccountsRoot,
} from "../src/switchyard/broker/accounts.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "fixtures", "roster.fixture.json");
const DUAL_FIXTURE_PATH = resolve(
	__dirname,
	"fixtures",
	"roster.dual-agy.fixture.json",
);

const previousRosterPath = process.env.SWITCHYARD_ROSTER_PATH;
const previousAccountRoot = process.env.SWITCHYARD_ACCOUNT_ROOT;

let scratch = "";
let ambiguousRosterPath = "";

function useRoster(path) {
	process.env.SWITCHYARD_ROSTER_PATH = path;
	__resetRosterCacheForTests();
}

before(() => {
	ambiguousRosterPath = join(
		tmpdir(),
		`switchyard-accounts-ambiguous-${process.pid}.json`,
	);
	// Both agy targets enabled: "agy" then names two live targets, which is the
	// ambiguity the resolver must refuse rather than guess through.
	const roster = JSON.parse(readFileSync(DUAL_FIXTURE_PATH, "utf8"));
	roster.targets.antigravity.enabled = true;
	writeFileSync(ambiguousRosterPath, JSON.stringify(roster), "utf8");
});

after(() => {
	if (previousRosterPath === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = previousRosterPath;
	}
	__resetRosterCacheForTests();
	rmSync(ambiguousRosterPath, { force: true });
});

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "switchyard-accounts-"));
	process.env.SWITCHYARD_ACCOUNT_ROOT = scratch;
	useRoster(FIXTURE_PATH);
});

afterEach(() => {
	if (previousAccountRoot === undefined) {
		delete process.env.SWITCHYARD_ACCOUNT_ROOT;
	} else {
		process.env.SWITCHYARD_ACCOUNT_ROOT = previousAccountRoot;
	}
	rmSync(scratch, { recursive: true, force: true });
});

describe("account identity", () => {
	it("derives a stable 128-bit identifier from the target id", () => {
		const key = randomBytes(32);
		const first = accountIdentifier("antigravity", key);
		strictEqual(first.length, 32);
		ok(/^[0-9a-f]{32}$/.test(first));
		ok(identifiersMatch(first, accountIdentifier("antigravity", key)));
	});

	it("keys the digest so the directory name does not disclose the subscription", () => {
		const key = randomBytes(32);
		const bare = createHash("sha256")
			.update("switchyard.account.v1|antigravity")
			.digest("hex")
			.slice(0, 32);
		notStrictEqual(accountIdentifier("antigravity", key), bare);
		notStrictEqual(
			accountIdentifier("antigravity", key),
			accountIdentifier("antigravity", randomBytes(32)),
		);
	});

	it("separates two targets that share one login", () => {
		const key = randomBytes(32);
		notStrictEqual(
			accountIdentifier("antigravity", key),
			accountIdentifier("antigravity-claude", key),
		);
	});

	it("rejects a key that is not 32 bytes", () => {
		let threw = false;
		try {
			accountIdentifier("antigravity", randomBytes(16));
		} catch {
			threw = true;
		}
		strictEqual(threw, true);
	});
});

describe("host key", () => {
	it("generates one key on first use and reuses it", () => {
		const first = readHostKey();
		ok(first);
		strictEqual(first.length, 32);
		const keyPath = join(scratch, "host-key");
		strictEqual(statSync(keyPath).mode & 0o777, 0o600);
		strictEqual(statSync(scratch).mode & 0o777, 0o700);
		strictEqual(readHostKey().equals(first), true);
	});

	it("fails closed when the stored key is the wrong length", () => {
		writeFileSync(join(scratch, "host-key"), randomBytes(8), { mode: 0o600 });
		strictEqual(readHostKey(), null);
	});
});

describe("account root", () => {
	it("resolves a per-target root under the configured accounts root", () => {
		strictEqual(resolveAccountsRoot(), resolve(scratch));
		const account = resolveAccountRoot("antigravity");
		ok(account);
		strictEqual(account.targetId, "antigravity");
		ok(account.root.startsWith(resolve(scratch)));
		strictEqual(account.root, join(resolve(scratch), account.identifier));
		strictEqual(statSync(account.root).mode & 0o777, 0o700);
		strictEqual(Object.hasOwn(account, "hostKey"), false);
	});

	it("gives two targets sharing one login two roots", () => {
		useRoster(DUAL_FIXTURE_PATH);
		const one = resolveAccountRoot("antigravity");
		const other = resolveAccountRoot("antigravity-claude");
		ok(one);
		ok(other);
		notStrictEqual(one.root, other.root);
	});

	it("fails closed on an unknown selector without creating a root", () => {
		strictEqual(resolveAccountRoot("no-such-provider"), null);
		strictEqual(resolveAccountRoot(null), null);
		strictEqual(readdirSync(scratch).length, 0);
	});

	it("fails closed when a harness alias names two live targets", () => {
		useRoster(ambiguousRosterPath);
		strictEqual(resolveAccountRoot("agy"), null);
		strictEqual(readdirSync(scratch).length, 0);
	});

	it("fails closed when the roster cannot be read", () => {
		useRoster(join(scratch, "missing-roster.json"));
		strictEqual(resolveAccountRoot("antigravity"), null);
	});

	it("fails closed when the host key cannot be read", () => {
		writeFileSync(join(scratch, "host-key"), Buffer.alloc(3), { mode: 0o600 });
		strictEqual(resolveAccountRoot("antigravity"), null);
		strictEqual(readdirSync(scratch).join(","), "host-key");
	});
});
