import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveTargetIdentity } from "../roster/index.mjs";

const IDENTIFIER_DOMAIN = "switchyard.account.v1|";
const IDENTIFIER_HEX_LENGTH = 32; // 128 bits of a SHA-256 digest.
const HOST_KEY_BYTES = 32;
const HOST_KEY_FILENAME = "host-key";

const defaultAccountsRoot = resolve(homedir(), ".switchyard", "accounts");

/**
 * Root holding one directory per independently metered account. Overridable so
 * tests never touch the host's real accounts, following the
 * `SWITCHYARD_VM_ADMISSION_ROOT` precedent in the run store.
 * @returns {string}
 */
export function resolveAccountsRoot() {
	const envOverride = process.env.SWITCHYARD_ACCOUNT_ROOT;
	if (envOverride) return resolve(envOverride);
	return defaultAccountsRoot;
}

/**
 * Namespacing digest of a roster target id. Keyed rather than bare: the input
 * is a short owner-authored string, so an unkeyed digest would be trivially
 * reversible by dictionary and would disclose which subscriptions this host
 * holds to anyone who can list the directory.
 *
 * @param {string} targetId resolved roster target id, not a credential or CLI name
 * @param {Buffer} hostKey host-local namespacing key
 * @returns {string} 32 lowercase hex characters
 */
export function accountIdentifier(targetId, hostKey) {
	if (typeof targetId !== "string" || targetId.trim() === "") {
		throw new TypeError("account targetId must be non-empty text");
	}
	if (!Buffer.isBuffer(hostKey) || hostKey.length !== HOST_KEY_BYTES) {
		throw new TypeError(`account host key must be ${HOST_KEY_BYTES} bytes`);
	}
	return createHmac("sha256", hostKey)
		.update(`${IDENTIFIER_DOMAIN}${targetId}`)
		.digest("hex")
		.slice(0, IDENTIFIER_HEX_LENGTH);
}

/**
 * Read the host-local namespacing key, generating it on first use. The key is
 * never logged and never leaves this host: losing or rotating it renumbers
 * every account root, which is why callers must treat a read failure as a
 * fail-closed signal rather than minting a replacement.
 *
 * @param {{root?: string}} [options]
 * @returns {Buffer|null} the key, or null when it cannot be read or created
 */
/**
 * Whether an accounts root has already numbered accounts under a key it no
 * longer has. A root that does not exist, or holds nothing but staging debris,
 * is a genuine first use.
 * @param {string} root
 * @returns {boolean}
 */
function initializedWithoutKey(root) {
	let entries;
	try {
		entries = readdirSync(root);
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		// An unreadable root is not provably first use, so treat it as numbered.
		return true;
	}
	return entries.some(
		(entry) => !entry.startsWith(".") && !entry.startsWith(HOST_KEY_FILENAME),
	);
}

export function readHostKey(options = {}) {
	const root = resolve(options.root ?? resolveAccountsRoot());
	const keyPath = resolve(root, HOST_KEY_FILENAME);
	try {
		const existing = readFileSync(keyPath);
		if (existing.length !== HOST_KEY_BYTES) return null;
		return existing;
	} catch (error) {
		if (error?.code !== "ENOENT") return null;
	}
	try {
		// Generating a key is only safe when nothing has been numbered with the
		// old one. An accounts root that already holds account directories but
		// has lost its key would otherwise be silently renumbered, and a project
		// still using the old numbering would reserve against a different root
		// for the same subscription. Fail closed and let the owner decide.
		if (initializedWithoutKey(root)) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(root, 0o700);
		const generated = randomBytes(HOST_KEY_BYTES);
		// Write-then-rename so a concurrent reader never sees a short key, and
		// keep whichever key won the race rather than overwriting it.
		const staging = resolve(root, `${HOST_KEY_FILENAME}.${process.pid}.tmp`);
		writeFileSync(staging, generated, { mode: 0o600 });
		try {
			statSync(keyPath);
			return readHostKeyAfterRace(keyPath, staging);
		} catch (error) {
			if (error?.code !== "ENOENT") return null;
		}
		renameSync(staging, keyPath);
		return generated;
	} catch {
		return null;
	}
}

function readHostKeyAfterRace(keyPath, staging) {
	try {
		const winner = readFileSync(keyPath);
		return winner.length === HOST_KEY_BYTES ? winner : null;
	} catch {
		return null;
	} finally {
		try {
			renameSync(staging, `${staging}.discard`);
		} catch {
			// The staging file is inside the 0700 root; a failed cleanup is not
			// worth failing the resolution over.
		}
	}
}

/**
 * Resolve the account root for a provider selector, or null when the account
 * cannot be identified with certainty.
 *
 * Fail-closed is the whole point: an unreadable roster, an unresolved or
 * ambiguous selector, or an unreadable host key must send the caller back to
 * its project-local ledger. Minting a fresh identifier instead would be
 * indistinguishable from a genuinely new account and would let two projects
 * double-book one subscription.
 *
 * @param {unknown} providerName snapshot provider name to resolve through the roster
 * @param {{root?: string}} [options]
 * @returns {{root: string, targetId: string, identifier: string}|null}
 */
export function resolveAccountRoot(providerName, options = {}) {
	let identity = null;
	try {
		identity = resolveTargetIdentity(providerName);
	} catch {
		return null;
	}
	if (!identity?.targetId || identity.ambiguous) return null;
	const accountsRoot = resolve(options.root ?? resolveAccountsRoot());
	const hostKey = readHostKey({ root: accountsRoot });
	if (!hostKey) return null;
	const identifier = accountIdentifier(identity.targetId, hostKey);
	const root = resolve(accountsRoot, identifier);
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(root, 0o700);
	} catch {
		return null;
	}
	return Object.freeze({ root, targetId: identity.targetId, identifier });
}

/**
 * Constant-time comparison helper used by the tests to assert two identifiers
 * match without leaking a timing oracle into any future caller.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function identifiersMatch(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	if (left.length !== right.length) return false;
	return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

const SHARED_LEDGER_FLAG = "SWITCHYARD_SHARED_ACCOUNT_LEDGER";

/**
 * Whether this process coordinates reservations through shared account roots.
 *
 * Opt-in, and deliberately not the same control as `SWITCHYARD_ACCOUNT_ROOT`:
 * that one says *where* accounts live and exists so tests never touch the
 * host's real ones. Overloading it as the enable switch would mean any test
 * that redirected the location also silently turned shared accounting on.
 *
 * Default off keeps every project on its own ledger, byte-identical to the
 * behaviour before this existed, until the attended cutover.
 * @returns {boolean}
 */
function sharedAccountLedgerEnabled() {
	const value = process.env[SHARED_LEDGER_FLAG];
	return value === "1" || value === "true";
}

/**
 * Build the provider -> account root resolver the reservation ledger consumes,
 * or null when shared accounting is off. Resolution is cached per provider for
 * the life of the resolver: the roster is stable within a dispatch, and the
 * alternative is a roster read inside the reservation lock.
 *
 * @param {{root?: string, enabled?: boolean}} [options]
 * @returns {((provider: string) => string|null)|null}
 */
export function createAccountRootResolver(options = {}) {
	const enabled = options.enabled ?? sharedAccountLedgerEnabled();
	if (!enabled) return null;
	const cache = new Map();
	return (provider) => {
		if (typeof provider !== "string" || provider === "") return null;
		if (cache.has(provider)) return cache.get(provider);
		const account = resolveAccountRoot(provider, options);
		const root = account ? account.root : null;
		cache.set(provider, root);
		return root;
	};
}
