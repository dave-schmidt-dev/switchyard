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
	classifyBlockedCidr,
	deriveC3Manifest,
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
		strictEqual(
			manifest.dropped[0].reason,
			"not an RFC1918 address C-3 blocks",
		);
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
			deepStrictEqual(
				[...manifest.coverage, ...manifest.unproven].sort(),
				C3_BLOCK_RULES.map((rule) => rule.label).sort(),
			);
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
