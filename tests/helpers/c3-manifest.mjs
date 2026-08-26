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
import net from "node:net";

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
const C3_PASSED_GATEWAY = "10.211.55.1";

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

function candidateEndpoints(port) {
	const candidates = [];
	for (const adapter of parallelsAdapters()) {
		if (adapter.ip === C3_PASSED_GATEWAY) continue;
		candidates.push({
			role:
				adapter.device === "bridge100"
					? `host identity and guest subnet (${adapter.device})`
					: `host identity (${adapter.device})`,
			host: adapter.ip,
			port,
		});
	}
	// Only the FIRST physical service contributes. A Mac with two live NICs on
	// one LAN would otherwise emit several endpoints that all prove one rule.
	const [primary] = physicalInterfaces();
	if (primary) {
		candidates.push({
			role: `host identity on the current LAN (${primary.device})`,
			host: primary.ip,
			port,
		});
		if (primary.router && primary.router !== primary.ip) {
			for (const gatewayPort of GATEWAY_PROBE_PORTS) {
				candidates.push({
					role: `LAN gateway (${primary.device})`,
					host: primary.router,
					port: gatewayPort,
					gateway: true,
				});
			}
		}
	}
	return candidates;
}

async function verifyBlocked(candidates) {
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
		if (candidate.host === C3_PASSED_GATEWAY && candidate.port === "53") {
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
		seen.add(value);
		if (candidate.gateway) satisfiedGateways.add(candidate.host);
		blocked.push({ ...candidate, value, cidr });
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
 *   dnsName: string, derived: boolean,
 *   listenerPort: string|null, close: () => Promise<void>}>}
 */
export async function deriveC3Manifest({ env = process.env } = {}) {
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
		candidates = candidateEndpoints(listener.port);
	}

	let blocked;
	let dropped;
	try {
		({ blocked, dropped } = await verifyBlocked(candidates));
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
		derived: listener !== null,
		listenerPort: listener?.port ?? null,
		close: async () => {
			if (listener) await listener.close();
		},
	};
}
