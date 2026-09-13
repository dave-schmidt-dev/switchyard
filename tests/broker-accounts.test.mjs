// Increment 6 (F3.2 shared account authority) gate test: account identity.
//
// The accounting unit is one independently metered target, not one login and
// not one CLI binary. `antigravity` and `antigravity-claude` are the same
// Google login but meter separately (measured 2026-09-12: weekly 78.2% left
// resetting 09-17 versus 52.3% left resetting 09-13), so they must land on
// different roots. Every case below fixes the accounts root to a tempdir: a
// case that forgets would write a host key into the real ~/.switchyard, so the
// root assertions check the tempdir prefix rather than just "not null".

import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
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
import { promisify } from "node:util";

import {
	accountIdentifier,
	createAccountRootResolver,
	identifiersMatch,
	readHostKey,
	resolveAccountRoot,
	resolveAccountsRoot,
} from "../src/switchyard/broker/accounts.mjs";
import { __resetRosterCacheForTests } from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ACCOUNTS_MODULE = new URL(
	"../src/switchyard/broker/accounts.mjs",
	import.meta.url,
).href;
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
	scratch = tempDir("switchyard-accounts-");
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

	it("refuses to renumber an accounts root whose key is gone", () => {
		const account = resolveAccountRoot("antigravity");
		ok(account);
		rmSync(join(scratch, "host-key"), { force: true });
		// A replacement key would renumber every account here, and a project
		// still holding the old numbering would reserve against a different root
		// for the same subscription.
		strictEqual(readHostKey(), null);
		strictEqual(resolveAccountRoot("antigravity"), null);
		ok(!existsSync(join(scratch, "host-key")));
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

	it("is on unless the shared-account flag opts out", () => {
		const previous = process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER;
		try {
			// Unset is the shipped configuration, so it is the one that has to
			// coordinate: an unset flag falling back to project-local ledgers
			// would silently restore the overdraft this increment closed.
			delete process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER;
			const resolver = createAccountRootResolver();
			ok(resolver);
			const root = resolver("antigravity");
			ok(root?.startsWith(resolve(scratch)));
			strictEqual(resolver("no-such-provider"), null);
			for (const optOut of ["0", "false"]) {
				process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER = optOut;
				strictEqual(createAccountRootResolver(), null);
			}
			process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER = "1";
			ok(createAccountRootResolver());
		} finally {
			if (previous === undefined) {
				delete process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER;
			} else {
				process.env.SWITCHYARD_SHARED_ACCOUNT_LEDGER = previous;
			}
		}
	});

	it("reports each provider that falls back to the project ledger once", () => {
		// Default-on makes silence the dangerous outcome: an unresolvable
		// provider reserves against its own ledger, which looks identical to
		// shared accounting working until two projects overdraw one account.
		const fallbacks = [];
		const resolver = createAccountRootResolver({
			onFallback: (provider) => fallbacks.push(provider),
		});
		ok(resolver("antigravity"));
		strictEqual(resolver("no-such-provider"), null);
		strictEqual(resolver("no-such-provider"), null);
		deepStrictEqual(fallbacks, ["no-such-provider"]);
	});

	it("publishes exactly one host key when first use races itself", async () => {
		// Two projects starting together is the norm on this host. A stat-then-
		// rename first use lets both see no key and both publish, and the loser
		// then numbers its accounts under a key no other process can read. The
		// processes are spawned together and barrier on a shared start time so
		// they contend for real rather than running one after another.
		const racingRoot = tempDir("switchyard-accounts-race-");
		try {
			const startAt = Date.now() + 750;
			const script = `
				import { readHostKey } from ${JSON.stringify(ACCOUNTS_MODULE)};
				while (Date.now() < ${startAt}) {}
				const key = readHostKey({ root: ${JSON.stringify(racingRoot)} });
				process.stdout.write(key === null ? "null" : key.toString("hex"));
			`;
			const results = await Promise.all(
				Array.from({ length: 8 }, () =>
					execFileAsync(process.execPath, [
						"--input-type=module",
						"-e",
						script,
					]),
				),
			);
			const keys = results.map((result) => result.stdout);
			const distinct = new Set(keys);
			strictEqual(distinct.size, 1, `racing keys diverged: ${[...distinct]}`);
			ok(!distinct.has("null"));
			// Every process agrees with what is actually on disk, and the staging
			// files the losers wrote are all cleaned up.
			strictEqual(
				readFileSync(join(racingRoot, "host-key")).toString("hex"),
				keys[0],
			);
			deepStrictEqual(readdirSync(racingRoot), ["host-key"]);
		} finally {
			rmSync(racingRoot, { recursive: true, force: true });
		}
	});

	it("fails closed when the host key cannot be read", () => {
		writeFileSync(join(scratch, "host-key"), Buffer.alloc(3), { mode: 0o600 });
		strictEqual(resolveAccountRoot("antigravity"), null);
		strictEqual(readdirSync(scratch).join(","), "host-key");
	});
});
