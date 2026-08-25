// Unit gate for the C-3 manifest derivation used by tests/no-host-rights-vm.test.mjs.
//
// The VM gate itself only runs where Parallels does. This file locks the pure
// classification and verification logic everywhere, so a regression in "which
// CIDR does this address prove" cannot hide behind an unavailable VM.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
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
