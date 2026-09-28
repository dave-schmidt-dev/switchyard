import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import {
	C3_BLOCK_RULES,
	C3_UNPROVEN_REASONS,
	classifyBlockedCidr,
	deriveC3Manifest,
	isC3UnprovenReason,
	probeTcp,
} from "./helpers/c3-manifest.mjs";

describe("C-3 manifest derivation", () => {
	it("names a distinct cause for each way a rule goes unproven", async () => {
		// One flat label list reported three different states as one cause. A
		// missing candidate is a coverage bug in this harness, an unreachable
		// one is an environment condition, and an unsound one means the probe
		// could have succeeded for a reason other than pf. The operator's next
		// action differs in each case.

		// (1) No candidate ever constructed: an override outside every blocked
		// range contributes to no rule, so all four go unproven for want of a
		// candidate rather than for want of a live host.
		const server = net.createServer((socket) => socket.end());
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		const noCandidate = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: `127.0.0.1:${port}` },
		});
		await noCandidate.close();
		await new Promise((resolve) => server.close(resolve));
		for (const entry of noCandidate.unproven) {
			strictEqual(
				entry.reason,
				C3_UNPROVEN_REASONS.NO_CANDIDATE,
				`${entry.label} should report a missing candidate`,
			);
		}

		// (2) A candidate in a blocked range that nothing answers at. Port 1 on
		// a documentation-range address is not listening anywhere.
		const unreachable = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: "192.168.255.254:1" },
		});
		await unreachable.close();
		const unreachableEntry = unreachable.unproven.find(
			(entry) => entry.label === "192.168.0.0/16",
		);
		strictEqual(
			unreachableEntry?.reason,
			C3_UNPROVEN_REASONS.UNREACHABLE,
			`expected an unreachable candidate, got ${JSON.stringify(unreachable.unproven)}`,
		);
		// The other three ranges still had no candidate at all, and must not
		// borrow this one's cause.
		strictEqual(
			unreachable.unproven.find((entry) => entry.label === "172.16.0.0/12")
				?.reason,
			C3_UNPROVEN_REASONS.NO_CANDIDATE,
		);

		// (3) A candidate that answers but cannot prove the rule: the C-3 anchor
		// passes the Parallels gateway on tcp/53, so a probe there is vacuous.
		const unsound = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: "10.211.55.1:53" },
		});
		await unsound.close();
		strictEqual(
			unsound.unproven.find((entry) => entry.label === "10.0.0.0/8")?.reason,
			C3_UNPROVEN_REASONS.UNSOUND,
		);
	});
	it("carries the cause per rule, so a partial manifest names the range it missed", async () => {
		const manifest = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: "192.168.255.254:1" },
		});
		await manifest.close();

		// Per rule, not per manifest: four labels, each with its own reason.
		deepStrictEqual(
			manifest.unproven.map((entry) => entry.label).sort(),
			C3_BLOCK_RULES.map((rule) => rule.label).sort(),
		);
		const reasons = new Set(manifest.unproven.map((entry) => entry.reason));
		ok(
			reasons.size > 1,
			`a manifest with mixed causes must not collapse them: ${JSON.stringify(manifest.unproven)}`,
		);
		for (const entry of manifest.unproven) {
			ok(entry.label, "every entry must name its range");
			ok(isC3UnprovenReason(entry.reason), `${entry.reason} is not a member`);
		}
	});
	it("keeps every unproven reason inside a closed set", () => {
		const members = Object.values(C3_UNPROVEN_REASONS);
		strictEqual(new Set(members).size, members.length);
		for (const member of members) {
			ok(isC3UnprovenReason(member));
			ok(/^[a-z][a-z0-9_]*$/.test(member), `${member} must be a bare member`);
		}
		for (const outsider of ["", null, undefined, "unknown", "no_candidate"]) {
			ok(!isC3UnprovenReason(outsider), `${outsider} must not be a member`);
		}
	});
	it("derives a manifest whose every blocked endpoint is classified, live, and distinct", async () => {
		const manifest = await deriveC3Manifest({ env: {} });
		try {
			strictEqual(manifest.derived, true);
			ok(manifest.listenerPort, "derivation must hold an ephemeral listener");
			// Coverage is deliberately NOT asserted non-empty: a host with no
			// Parallels adapter and no RFC1918 LAN legitimately proves nothing.
			// The VM gate makes that a failure; this file checks the invariants
			// that must hold whatever the network is.
			const values = manifest.blocked.map((endpoint) => endpoint.value);
			strictEqual(
				new Set(values).size,
				values.length,
				"endpoints must be distinct",
			);
			for (const endpoint of manifest.blocked) {
				strictEqual(classifyBlockedCidr(endpoint.host), endpoint.cidr);
				ok(
					await probeTcp(endpoint.host, endpoint.port),
					`${endpoint.value} was reported live but is not reachable`,
				);
			}
			// The Parallels shared gateway is passed for DNS and DHCP above the
			// blocks, so it must never appear as blocked-endpoint evidence.
			ok(
				!manifest.blocked.some((endpoint) => endpoint.host === "10.211.55.1"),
				"the DNS/DHCP-passed Parallels gateway must never be blocked evidence",
			);
			// Every rule is accounted for exactly once, and each unproven one
			// names its own cause rather than sharing a single label list.
			deepStrictEqual(
				[
					...manifest.coverage,
					...manifest.unproven.map((entry) => entry.label),
				].sort(),
				C3_BLOCK_RULES.map((rule) => rule.label).sort(),
			);
			for (const entry of manifest.unproven) {
				ok(
					isC3UnprovenReason(entry.reason),
					`${entry.label} carried ${JSON.stringify(entry.reason)}, which is not a closed-enum member`,
				);
			}
			strictEqual(manifest.reachable.value, "1.1.1.1:443");
			strictEqual(manifest.dnsName, "apple.com");
		} finally {
			await manifest.close();
		}
	});
});
it("drops an explicitly-overridden Parallels gateway instead of counting it as evidence", async () => {
	// The gateway is PASSED by the C-3 anchor, so it can never be blocked.
	// An env override must not be able to route around that filter.
	const manifest = await deriveC3Manifest({
		env: { SWITCHYARD_PARALLELS_C3_GATEWAY_ENDPOINT: "10.211.55.1:53" },
	});
	try {
		ok(
			!manifest.blocked.some((endpoint) => endpoint.host === "10.211.55.1"),
			"the C-3-passed gateway must never appear as blocked evidence",
		);
		const drop = manifest.dropped.find((entry) =>
			entry.value.startsWith("10.211.55.1:"),
		);
		ok(drop, "the overridden gateway must be reported as dropped");
		match(drop.reason, /passed by C-3 on tcp\/53/);
	} finally {
		await manifest.close();
	}
});
