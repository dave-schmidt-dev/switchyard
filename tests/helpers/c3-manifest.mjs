// Runtime derivation of the C-3 endpoint manifest for the INV-1 VM gate.
//
// The golden image's C-3 anchor blocks RFC1918 CIDR RANGES, not named hosts
// (ops/macos-vm/build-golden-image.sh). So the manifest does not need this
// Mac's home-network addresses -- it needs a LIVE listener inside each blocked
// range. Two of the four ranges have no live target from any host, so the gate
// records which rules it actually proved rather than implying full coverage.
//
// Every blocked candidate is verified reachable FROM THE HOST at the exact
// host:port the guest will probe. probe_blocked() is `! nc -z`, so a dead
// address passes vacuously; an unverified endpoint is not evidence.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

// Mirrors the `block drop quick on en0` rules in the golden image's pf anchor.
export const C3_BLOCK_RULES = [
	{ label: "10.0.0.0/8", test: (o) => o[0] === 10 },
	{
		label: "172.16.0.0/12",
		test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31,
	},
	{ label: "192.168.0.0/16", test: (o) => o[0] === 192 && o[1] === 168 },
	{ label: "169.254.0.0/16", test: (o) => o[0] === 169 && o[1] === 254 },
];

// The Parallels shared-network gateway is explicitly PASSED for DNS and DHCP
// above the blocks, so it can never serve as blocked-endpoint evidence.
//
// The value is read from the image build script rather than repeated here. A
// literal could not be cross-checked against the image's build-time
// `--gateway`, so on an image built with a non-default gateway the
// passed-gateway probe targeted an address the guest never uses and the
// resulting verdict was about the wrong host.
const BUILD_SCRIPT = fileURLToPath(
	new URL("../../ops/macos-vm/build-golden-image.sh", import.meta.url),
);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The gateway the golden image's C-3 anchor passes.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.buildScriptPath]
 * @returns {{gateway: string, derived: string|null, configured: string|null}}
 * @throws when the build script's default and an explicit override disagree,
 *   or when neither yields a usable address. Preferring either one silently
 *   would produce a verdict about a host nobody asked about.
 */
export function resolveC3Gateway({
	env = process.env,
	buildScriptPath = BUILD_SCRIPT,
} = {}) {
	let derived = null;
	try {
		derived =
			/^GATEWAY="([^"]+)"/m.exec(readFileSync(buildScriptPath, "utf8"))?.[1] ??
			null;
	} catch {
		derived = null;
	}
	if (derived !== null && !IPV4.test(derived)) {
		throw new Error(
			`the image build script's GATEWAY is not an IPv4 address: ${JSON.stringify(derived)}`,
		);
	}
	const configured = env.SWITCHYARD_PARALLELS_C3_GATEWAY || null;
	if (configured !== null && !IPV4.test(configured)) {
		throw new Error(
			`SWITCHYARD_PARALLELS_C3_GATEWAY is not an IPv4 address: ${JSON.stringify(configured)}`,
		);
	}
	if (derived !== null && configured !== null && derived !== configured) {
		throw new Error(
			`C-3 gateway mismatch: the image build script says ${derived} but SWITCHYARD_PARALLELS_C3_GATEWAY says ${configured}. ` +
				"Rebuild the image or correct the override; a verdict against either alone would be about the wrong host.",
		);
	}
	const gateway = configured ?? derived;
	if (!gateway) {
		throw new Error(
			`no C-3 gateway available: ${buildScriptPath} carries no GATEWAY and SWITCHYARD_PARALLELS_C3_GATEWAY is unset`,
		);
	}
	return { gateway, derived, configured };
}

const GATEWAY_PROBE_PORTS = ["443", "80", "53"];

/**
 * Why a C-3 block rule was not proven. A flat list of labels reported three
 * different states as one cause, and they demand different responses: a
 * missing candidate is a coverage bug in this harness, an unreachable one is
 * an environment condition, and an unsound one means the probe could have
 * succeeded for a reason other than pf. A closed enum, not an interpolated
 * message, for the same reason the integration gate's refusal kinds are.
 */
export const C3_UNPROVEN_REASONS = Object.freeze({
	/** No candidate in this range was ever constructed. Harness coverage gap. */
	NO_CANDIDATE: "no_candidate_constructed",
	/** A candidate existed but nothing answered at it. Environment condition. */
	UNREACHABLE: "candidate_unreachable",
	/**
	 * A candidate existed and answered, but could not prove the rule: the C-3
	 * anchor passes it, or the probe never crossed the guest's network path.
	 */
	UNSOUND: "candidate_unsound",
});

const C3_UNPROVEN_REASON_VALUES = Object.freeze(
	Object.values(C3_UNPROVEN_REASONS),
);

/**
 * Assign each unproven rule its cause, most specific first.
 *
 * Ordering matters: a range with both an unsound candidate and an unreachable
 * one is reported unsound, because the operator's next action is to fix the
 * candidate rather than to wait for the host to come back.
 * @param {string[]} coverage rule labels actually proven
 * @param {object[]} dropped candidates that did not become evidence
 * @returns {Array<{label: string, reason: string}>}
 */
function classifyUnproven(coverage, dropped) {
	return C3_BLOCK_RULES.map((rule) => rule.label)
		.filter((label) => !coverage.includes(label))
		.map((label) => {
			const forRule = dropped.filter((entry) => entry.cidr === label);
			if (forRule.some((entry) => entry.unsound)) {
				return { label, reason: C3_UNPROVEN_REASONS.UNSOUND };
			}
			if (forRule.length > 0) {
				return { label, reason: C3_UNPROVEN_REASONS.UNREACHABLE };
			}
			return { label, reason: C3_UNPROVEN_REASONS.NO_CANDIDATE };
		});
}

/**
 * How sound a candidate is as evidence that pf blocked the guest.
 *
 * `probeTcp` runs on the HOST. When the candidate is a host-owned address the
 * connection rides loopback, which proves the listener is alive but says
 * nothing about whether the guest had a route to it. A guest with no route
 * fails its probe, `probe_blocked()` is `! nc -z`, and the failure reads as
 * proof of a block that pf never performed.
 */
export const C3_CANDIDATE_SOUNDNESS = Object.freeze({
	/** The guest has a route to it, so a blocked probe implicates pf. */
	GUEST_ROUTABLE: "guest_routable",
	/** This host owns the address; the guest's route to it is unproven. */
	HOST_OWNED: "host_owned",
	/**
	 * A self-assigned 169.254 address. Attach any NIC with no DHCP server and
	 * macOS invents one, which the host can then "prove" is blocked without the
	 * guest ever having had a route to it.
	 */
	LINK_LOCAL: "link_local",
});

function isLinkLocal(host) {
	return /^169\.254\./.test(String(host ?? ""));
}

/** Same /24 as the C-3 passed gateway, i.e. the subnet the guest sits on. */
function sharesGatewaySubnet(ip, gateway) {
	if (typeof ip !== "string" || typeof gateway !== "string") return false;
	return (
		ip.split(".").slice(0, 3).join(".") ===
		gateway.split(".").slice(0, 3).join(".")
	);
}

/**
 * Classify a candidate by whether the guest could have reached it.
 *
 * The guest's own subnet is derived from the C-3 passed gateway rather than
 * from a device name or a `prlctl list -i` call: the gateway is already the
 * anchor's own notion of the guest network, and reusing it needs no new
 * capability on this host.
 * @param {{host: string, device?: string}} candidate
 * @param {{gateway: string, hostAddresses: Set<string>}} context
 * @returns {string} a C3_CANDIDATE_SOUNDNESS member
 */
export function classifyCandidateSoundness(candidate, context) {
	const host = candidate?.host;
	if (isLinkLocal(host)) return C3_CANDIDATE_SOUNDNESS.LINK_LOCAL;
	if (sharesGatewaySubnet(host, context.gateway)) {
		return C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE;
	}
	if (context.hostAddresses.has(host)) {
		return C3_CANDIDATE_SOUNDNESS.HOST_OWNED;
	}
	return C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE;
}

export function isC3UnprovenReason(value) {
	return C3_UNPROVEN_REASON_VALUES.includes(value);
}

export function classifyBlockedCidr(ip) {
	if (typeof ip !== "string") return null;
	// Reject octet forms Number() would silently coerce ("", 1e1, 0x0a,
	// leading space), which would otherwise classify as a real rule.
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
	const octets = ip.split(".");
	if (octets.length !== 4) return null;
	const parsed = octets.map(Number);
	if (parsed.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
	return C3_BLOCK_RULES.find((rule) => rule.test(parsed))?.label ?? null;
}

export function parseEndpoint(value) {
	if (typeof value !== "string") return null;
	const matched = /^([A-Za-z0-9._:-]+):(\d{1,5})$/.exec(value.trim());
	if (!matched) return null;
	const port = Number(matched[2]);
	if (port < 1 || port > 65535) return null;
	return { value: value.trim(), host: matched[1], port: matched[2] };
}

export function parseEndpoints(value) {
	if (!value) return [];
	return value
		.split(",")
		.map((entry) => parseEndpoint(entry))
		.filter(Boolean);
}

function readCommand(command, args) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

// Deliberately NOT `route -n get default`: a VPN owns the default route, so the
// default gateway is not the LAN's and probing it would prove nothing about the
// 192.168/16 or 172.16/12 rules. Read per-interface, in macOS service order.
export function physicalInterfaces() {
	const order = readCommand("/usr/sbin/networksetup", [
		"-listnetworkserviceorder",
	]);
	const interfaces = [];
	for (const matched of order.matchAll(/Device: ([a-z]+\d+)\)/g)) {
		const device = matched[1];
		if (device.startsWith("utun") || device.startsWith("bridge")) continue;
		const ip = readCommand("/usr/sbin/ipconfig", ["getifaddr", device]);
		if (!ip) continue;
		interfaces.push({
			device,
			ip,
			router: readCommand("/usr/sbin/ipconfig", [
				"getoption",
				device,
				"router",
			]),
		});
	}
	return interfaces;
}

/** Every IPv4 address this host holds on any interface. */
export function hostAddresses() {
	const config = readCommand("/sbin/ifconfig", ["-a"]);
	const addresses = new Set();
	for (const matched of config.matchAll(/^\s+inet (\d+\.\d+\.\d+\.\d+)/gm)) {
		addresses.add(matched[1]);
	}
	return addresses;
}

export function parallelsAdapters() {
	const config = readCommand("/sbin/ifconfig", ["-a"]);
	const adapters = [];
	let current = "";
	for (const line of config.split("\n")) {
		if (/^[a-z]/.test(line)) current = line.split(":")[0];
		const matched = /^\s+inet (\d+\.\d+\.\d+\.\d+)/.exec(line);
		if (matched && current.startsWith("bridge")) {
			adapters.push({ device: current, ip: matched[1] });
		}
	}
	return adapters;
}

export function probeTcp(host, port, timeoutMs = 2500) {
	return new Promise((resolve) => {
		const socket = net.connect({
			host,
			port: Number(port),
			timeout: timeoutMs,
		});
		const settle = (value) => {
			socket.destroy();
			resolve(value);
		};
		socket.on("connect", () => settle(true));
		socket.on("timeout", () => settle(false));
		socket.on("error", () => settle(false));
	});
}

function listenEphemeral() {
	const server = net.createServer((socket) => socket.end());
	server.unref();
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "0.0.0.0", () =>
			resolve({
				port: String(server.address().port),
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			}),
		);
	});
}

function candidateEndpoints(port, gateway) {
	const candidates = [];
	for (const adapter of parallelsAdapters()) {
		if (adapter.ip === gateway) continue;
		candidates.push({
			role:
				adapter.device === "bridge100"
					? `host identity and guest subnet (${adapter.device})`
					: `host identity (${adapter.device})`,
			host: adapter.ip,
			port,
		});
	}
	// Every enabled physical service, not only the first. A Mac with two live
	// NICs previously tested one and reported a verdict covering both, and the
	// second NIC is exactly where a self-assigned link-local address turns up.
	// Redundancy across services is harmless: duplicates are collapsed by
	// `seen`, and Task 5.1's classification decides what is sound.
	for (const physical of physicalInterfaces()) {
		candidates.push({
			role: `host identity on the current LAN (${physical.device})`,
			host: physical.ip,
			port,
		});
		if (physical.router && physical.router !== physical.ip) {
			for (const gatewayPort of GATEWAY_PROBE_PORTS) {
				candidates.push({
					role: `LAN gateway (${physical.device})`,
					host: physical.router,
					port: gatewayPort,
					gateway: true,
				});
			}
		}
	}
	return candidates;
}

async function verifyBlocked(candidates, context) {
	const blocked = [];
	const dropped = [];
	const seen = new Set();
	const satisfiedGateways = new Set();
	for (const candidate of candidates) {
		const value = `${candidate.host}:${candidate.port}`;
		if (seen.has(value)) continue;
		if (candidate.gateway && satisfiedGateways.has(candidate.host)) continue;
		// The C-3 anchor passes the gateway above its block rules, but ONLY on
		// tcp/53 (plus udp/53 and udp/67, which a TCP probe cannot reach). A
		// guest probe there can never be blocked, so it is vacuous evidence.
		// At any other port the gateway is still caught by 10.0.0.0/8 and is
		// legitimate evidence, so this must not be a blanket exclusion.
		// Enforced here, not at candidate construction, so an explicit env
		// override cannot route around it.
		if (candidate.host === context.gateway && candidate.port === "53") {
			dropped.push({
				value,
				role: candidate.role,
				cidr: classifyBlockedCidr(candidate.host),
				unsound: true,
				reason: "passed by C-3 on tcp/53; cannot prove a block rule",
			});
			continue;
		}
		const cidr = classifyBlockedCidr(candidate.host);
		if (!cidr) {
			dropped.push({
				value,
				role: candidate.role,
				cidr: null,
				unsound: false,
				// Not "not an RFC1918 address": C3_BLOCK_RULES also covers
				// 169.254.0.0/16, which is link-local and not RFC1918 at all, so
				// the old wording misdescribed both what was dropped and what
				// the anchor blocks.
				reason: "outside every CIDR range C-3 blocks",
			});
			continue;
		}
		if (!(await probeTcp(candidate.host, candidate.port))) {
			// Only report a gateway as dead once every probe port has failed.
			if (!candidate.gateway || candidate.port === GATEWAY_PROBE_PORTS.at(-1)) {
				dropped.push({
					value,
					role: candidate.role,
					cidr,
					unsound: false,
					reason: "unreachable from the host",
				});
			}
			continue;
		}
		// Classified after the liveness probe, not before: an unsound candidate
		// that is also dead is dead first, and reporting it as unsound would
		// send the operator to fix the wrong thing.
		const soundness = classifyCandidateSoundness(candidate, context);
		if (soundness !== C3_CANDIDATE_SOUNDNESS.GUEST_ROUTABLE) {
			// Not merely excluded from coverage: left in the manifest, the guest
			// would probe an address it has no route to, fail, and have that
			// failure read as proof of a block pf never performed.
			dropped.push({
				value,
				role: candidate.role,
				cidr,
				unsound: true,
				soundness,
				reason:
					soundness === C3_CANDIDATE_SOUNDNESS.LINK_LOCAL
						? "link-local self-assigned address; the guest has no route to it"
						: "host-owned address; the host probe rides loopback and proves no guest path",
			});
			continue;
		}
		seen.add(value);
		if (candidate.gateway) satisfiedGateways.add(candidate.host);
		blocked.push({ ...candidate, value, cidr, soundness });
	}
	return { blocked, dropped };
}

/**
 * Derive and host-verify a C-3 endpoint manifest.
 *
 * Holds an ephemeral listener open for the caller's lifetime, so the Parallels
 * adapter and LAN-IP endpoints are live by construction on any network. The
 * caller MUST await `close()`.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] Environment carrying optional overrides.
 * @returns {Promise<{blocked: object[], dropped: object[], coverage: string[],
 *   unproven: Array<{label: string, reason: string}>, reachable: object,
 *   dnsName: string, gateway: string, derivedGateway: string|null,
 *   derived: boolean,
 *   listenerPort: string|null, close: () => Promise<void>}>}
 */
export async function deriveC3Manifest({ env = process.env } = {}) {
	// Resolved first: a gateway mismatch must fail before any candidate is
	// built, not after a manifest has been half-derived against the wrong host.
	const { gateway, derived: derivedGateway } = resolveC3Gateway({ env });
	const dnsName = env.SWITCHYARD_PARALLELS_C3_DNS_NAME || "apple.com";
	const reachable =
		parseEndpoint(env.SWITCHYARD_PARALLELS_C3_REACHABLE_ENDPOINT) ??
		parseEndpoint("1.1.1.1:443");

	// Explicit overrides opt out of derivation but never out of verification.
	const overrides = [
		...parseEndpoints(env.SWITCHYARD_PARALLELS_C3_HOST_ENDPOINTS),
		parseEndpoint(env.SWITCHYARD_PARALLELS_C3_GATEWAY_ENDPOINT),
		parseEndpoint(env.SWITCHYARD_PARALLELS_C3_GUEST_SUBNET_ENDPOINT),
	].filter(Boolean);

	let listener = null;
	let candidates;
	if (overrides.length > 0) {
		candidates = overrides.map((endpoint) => ({
			role: "explicit override",
			host: endpoint.host,
			port: endpoint.port,
		}));
	} else {
		listener = await listenEphemeral();
		candidates = candidateEndpoints(listener.port, gateway);
	}

	let blocked;
	let dropped;
	try {
		({ blocked, dropped } = await verifyBlocked(candidates, {
			gateway,
			hostAddresses: hostAddresses(),
		}));
	} catch (error) {
		// The caller never receives the object, so it can never call close().
		if (listener) await listener.close();
		throw error;
	}
	const coverage = [...new Set(blocked.map((endpoint) => endpoint.cidr))];
	const unproven = classifyUnproven(coverage, dropped);
	return {
		blocked,
		dropped,
		coverage,
		unproven,
		reachable,
		dnsName,
		gateway,
		derivedGateway,
		derived: listener !== null,
		listenerPort: listener?.port ?? null,
		close: async () => {
			if (listener) await listener.close();
		},
	};
}
