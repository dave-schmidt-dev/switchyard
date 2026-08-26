// Unit gate for the C-3 manifest derivation used by tests/no-host-rights-vm.test.mjs.
//
// The VM gate itself only runs where Parallels does. This file locks the pure
// classification and verification logic everywhere, so a regression in "which
// CIDR does this address prove" cannot hide behind an unavailable VM.

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";

import {
	C3_BLOCK_RULES,
	C3_CANDIDATE_SOUNDNESS,
	C3_UNPROVEN_REASONS,
	classifyBlockedCidr,
	classifyCandidateSoundness,
	deriveC3Manifest,
	hostAddresses,
	isC3UnprovenReason,
	parseEndpoint,
	parseEndpoints,
	probeTcp,
} from "./helpers/c3-manifest.mjs";

describe("C-3 manifest derivation", () => {
	it("classifies an address into the pf block rule it would prove", () => {
		strictEqual(classifyBlockedCidr("10.211.55.2"), "10.0.0.0/8");
		strictEqual(classifyBlockedCidr("172.20.10.3"), "172.16.0.0/12");
		strictEqual(classifyBlockedCidr("192.168.1.53"), "192.168.0.0/16");
		strictEqual(classifyBlockedCidr("169.254.1.1"), "169.254.0.0/16");
		// Exact inclusive edges of the 172.16/12 range: a `>` vs `>=` regression
		// on either bound would only show up at these two second octets.
		strictEqual(classifyBlockedCidr("172.16.0.0"), "172.16.0.0/12");
		strictEqual(classifyBlockedCidr("172.31.255.255"), "172.16.0.0/12");
	});

	it("refuses addresses no C-3 rule blocks, so they cannot pass vacuously", () => {
		// Hotel CGNAT and public addresses are outside every block rule; probing
		// them would assert nothing about the guest's posture.
		strictEqual(classifyBlockedCidr("100.72.3.9"), null);
		strictEqual(classifyBlockedCidr("1.1.1.1"), null);
		strictEqual(classifyBlockedCidr("127.0.0.1"), null);
		// 172.32/12 is outside the private range despite the shared first octet.
		strictEqual(classifyBlockedCidr("172.32.0.1"), null);
		strictEqual(classifyBlockedCidr("172.15.0.1"), null);
		// Full CGNAT range (100.64.0.0/10): no C-3 rule matches first octet 100,
		// at either edge.
		strictEqual(classifyBlockedCidr("100.64.0.0"), null);
		strictEqual(classifyBlockedCidr("100.127.255.255"), null);
		// Shares the first octet with 169.254/16 but not the second: an
		// over-broad "o[0] === 169" rule would wrongly block this.
		strictEqual(classifyBlockedCidr("169.1.1.1"), null);
	});

	it("rejects malformed addresses instead of guessing a rule", () => {
		for (const value of [
			"",
			"10.1.1",
			"10.1.1.1.1",
			"10.1.1.256",
			"nope",
			null,
			10,
		]) {
			strictEqual(
				classifyBlockedCidr(value),
				null,
				`expected null for ${value}`,
			);
		}
	});

	it("declares every pf block rule the golden image installs", () => {
		deepStrictEqual(
			C3_BLOCK_RULES.map((rule) => rule.label),
			["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
		);
	});

	it("parses endpoints and rejects out-of-range ports", () => {
		deepStrictEqual(parseEndpoint(" 10.0.0.1:443 "), {
			value: "10.0.0.1:443",
			host: "10.0.0.1",
			port: "443",
		});
		strictEqual(parseEndpoint("10.0.0.1:0"), null);
		strictEqual(parseEndpoint("10.0.0.1:70000"), null);
		strictEqual(parseEndpoint("10.0.0.1"), null);
		strictEqual(parseEndpoint(undefined), null);
		deepStrictEqual(
			parseEndpoints("10.0.0.1:443, 10.0.0.2:80, junk").map((e) => e.value),
			["10.0.0.1:443", "10.0.0.2:80"],
		);
		deepStrictEqual(parseEndpoints(""), []);
	});

	it("holds the exact port bounds instead of an approximate range", () => {
		// 1 and 65535 are the inclusive edges; 0 and 65536 are one step outside.
		strictEqual(parseEndpoint("10.0.0.1:1").port, "1");
		strictEqual(parseEndpoint("10.0.0.1:65535").port, "65535");
		strictEqual(parseEndpoint("10.0.0.1:65536"), null);
		// Non-numeric ports fail the pattern entirely rather than coercing.
		strictEqual(parseEndpoint("10.0.0.1:abc"), null);
		strictEqual(parseEndpoint("10.0.0.1:44a"), null);
	});

	it("rejects empty and hostless endpoint strings", () => {
		strictEqual(parseEndpoint(""), null);
		strictEqual(parseEndpoint("   "), null);
		strictEqual(parseEndpoint(":443"), null);
		deepStrictEqual(parseEndpoints(",,"), []);
	});

	it("splits on the LAST colon, because the host pattern also allows ':'", () => {
		// A surprising but real consequence of the host character class: this is
		// not rejected as malformed, it parses with host "10.0.0.1:443" and port
		// "80". classifyBlockedCidr fails it closed downstream (an extra
		// ":443" segment does not survive Number() on a dotted-quad octet), so
		// this is not exploitable -- but it means parseEndpoint alone does not
		// guarantee a clean host.
		deepStrictEqual(parseEndpoint("10.0.0.1:443:80"), {
			value: "10.0.0.1:443:80",
			host: "10.0.0.1:443",
			port: "80",
		});
		strictEqual(
			classifyBlockedCidr(parseEndpoint("10.0.0.1:443:80").host),
			null,
		);
	});

	it("resolves false and destroys the socket when the connect attempt times out", async (t) => {
		// A genuine hung connect cannot be produced locally without touching a
		// real external host or the pf firewall (both disallowed here), so the
		// collaborator is substituted to drive probeTcp's own timeout handler
		// deterministically. ".invalid" is reserved by RFC 2606 to never
		// resolve, documenting that no real connection is attempted.
		const connectCalls = [];
		const timeoutHandlers = [];
		const destroyed = [];
		t.mock.method(net, "connect", (options) => {
			const index = connectCalls.push(options) - 1;
			destroyed[index] = 0;
			return {
				on(event, handler) {
					if (event === "timeout") timeoutHandlers[index] = handler;
					return this;
				},
				destroy() {
					destroyed[index] += 1;
				},
			};
		});

		const pending = probeTcp("host.invalid", "9", 5);
		strictEqual(connectCalls.length, 1, "probeTcp must call net.connect");
		timeoutHandlers[0]();
		strictEqual(await pending, false);
		strictEqual(destroyed[0], 1, "a timed-out socket must be destroyed");
		strictEqual(connectCalls[0].port, 9, "port must be coerced to a number");
		strictEqual(connectCalls[0].timeout, 5);

		const pendingDefault = probeTcp("host.invalid", "9");
		timeoutHandlers[1]();
		await pendingDefault;
		strictEqual(
			connectCalls[1].timeout,
			2500,
			"the default timeout is the value the VM gate relies on",
		);
	});

	it("drops an override the host cannot reach rather than trusting it", async () => {
		// Port 1 on a private address with nothing listening: live-verification
		// must reject it, because `! nc -z` against it would pass for free.
		const manifest = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: "10.255.255.254:1" },
		});
		await manifest.close();
		strictEqual(manifest.derived, false);
		strictEqual(manifest.blocked.length, 0);
		deepStrictEqual(manifest.coverage, []);
		strictEqual(manifest.dropped[0].reason, "unreachable from the host");
	});

	it("drops a live override that no C-3 rule blocks", async () => {
		const server = net.createServer((socket) => socket.end());
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		ok(await probeTcp("127.0.0.1", port), "fixture listener must be live");
		const manifest = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: `127.0.0.1:${port}` },
		});
		await manifest.close();
		await new Promise((resolve) => server.close(resolve));
		strictEqual(manifest.blocked.length, 0);
		// Not "RFC1918": C3_BLOCK_RULES also covers 169.254.0.0/16, which is
		// link-local, so the old wording misdescribed the rule set.
		strictEqual(
			manifest.dropped[0].reason,
			"outside every CIDR range C-3 blocks",
		);
		strictEqual(manifest.dropped[0].cidr, null);
		strictEqual(manifest.dropped[0].unsound, false);
	});

	it("will not prove a rule from a host-owned address alone", async () => {
		// probeTcp runs on the HOST, so a host-owned candidate's connection
		// rides loopback: it proves the listener is alive and says nothing about
		// whether the guest had a route. The guest probe is `! nc -z`, so a
		// guest with no route fails and the failure reads as proof of a block pf
		// never performed.
		const own = [...hostAddresses()].find(
			(ip) => classifyBlockedCidr(ip) && !ip.startsWith("10.211.55."),
		);
		ok(own, "this host must own a blocked-range address for this test");

		const server = net.createServer((socket) => socket.end());
		await new Promise((resolve) => server.listen(0, own, resolve));
		const { port } = server.address();
		ok(await probeTcp(own, port), "fixture listener must be live");

		const manifest = await deriveC3Manifest({
			env: { SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS: `${own}:${port}` },
		});
		await manifest.close();
		await new Promise((resolve) => server.close(resolve));

		strictEqual(
			manifest.blocked.length,
			0,
			"a host-owned candidate must not become guest evidence",
		);
		ok(!manifest.coverage.includes(classifyBlockedCidr(own)));
		const entry = manifest.unproven.find(
			(u) => u.label === classifyBlockedCidr(own),
		);
		strictEqual(entry?.reason, C3_UNPROVEN_REASONS.UNSOUND);
		const drop = manifest.dropped.find((d) => d.value === `${own}:${port}`);
		strictEqual(drop.soundness, C3_CANDIDATE_SOUNDNESS.HOST_OWNED);
		ok(/loopback/.test(drop.reason), `reason must say why: ${drop.reason}`);
	});

	it("will not prove a rule from a link-local self-assigned address", () => {
		// The sharpest case: attach any NIC with no DHCP server and macOS
		// self-assigns a 169.254 address. 169.254.0.0/16 is one of the four
		// blocked ranges, so the host can "prove" it blocked without the guest
		// ever having had a route there.
		const soundness = classifyCandidateSoundness(
			{ host: "169.254.13.37" },
			{ gateway: "10.211.55.1", hostAddresses: new Set(["169.254.13.37"]) },
		);
		strictEqual(soundness, C3_CANDIDATE_SOUNDNESS.LINK_LOCAL);
		// Link-local wins over host-owned: naming it as merely host-owned would
		// hide the reason it can never be routed.
		strictEqual(classifyBlockedCidr("169.254.13.37"), "169.254.0.0/16");
	});

	it("reports a guest-routable candidate as proven when its probe is blocked", () => {
		const context = {
			gateway: "10.211.55.1",
			hostAddresses: new Set(["10.211.55.2", "192.168.1.54"]),
		};
		// The guest's own subnet, derived from the passed gateway rather than a
		// device name: the guest reaches it over its own adapter.
		strictEqual(
			classifyCandidateSoundness({ host: "10.211.55.2" }, context),
			C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE,
		);
		// A real third party the host does not own.
		strictEqual(
			classifyCandidateSoundness({ host: "192.168.1.1" }, context),
			C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE,
		);
		// A host address on some other network is not.
		strictEqual(
			classifyCandidateSoundness({ host: "192.168.1.54" }, context),
			C3_CANDIDATE_SOUNDNESS.HOST_OWNED,
		);
	});

	it("keeps every blocked endpoint sound, so coverage rests on nothing else", async () => {
		const manifest = await deriveC3Manifest({ env: {} });
		try {
			for (const endpoint of manifest.blocked) {
				strictEqual(
					endpoint.soundness,
					C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE,
					`${endpoint.value} is unsound evidence and must not be in the manifest`,
				);
			}
			// Anything dropped for soundness must say which kind it was.
			for (const drop of manifest.dropped.filter((d) => d.unsound)) {
				ok(
					Object.values(C3_CANDIDATE_SOUNDNESS).includes(drop.soundness) ||
						drop.soundness === undefined,
					`${drop.value} carried ${JSON.stringify(drop.soundness)}`,
				);
			}
		} finally {
			await manifest.close();
		}
	});

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
