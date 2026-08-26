// Unit coverage for the INV-1 clipboard probe's classifier and scripts.
//
// The live gate in tests/no-host-rights-vm.test.mjs needs a booted VM, so the
// cases that matter most cannot be reached there: a probe whose command is
// unavailable, a probe that produced no output at all, and a probe that read
// the wrong pasteboard. Those are exactly the inputs that must NOT be read as
// isolation, and they are proven here, without Parallels.

import {
	deepStrictEqual,
	match,
	notStrictEqual,
	ok,
	strictEqual,
} from "node:assert";
import { describe, it } from "node:test";
import {
	CLIPBOARD_DIRECTIONS,
	CLIPBOARD_VERDICTS,
	classifyHostPasteboard,
	classifyProbeOutput,
	guestToHostProbeScript,
	hostToGuestProbeScript,
	mintSentinel,
} from "./helpers/clipboard-probe.mjs";

const PROVIDER = "switchyard";
const H2G = CLIPBOARD_DIRECTIONS.HOST_TO_GUEST;
const G2H = CLIPBOARD_DIRECTIONS.GUEST_TO_HOST;

const classify = (text, direction) =>
	classifyProbeOutput(text, { direction, providerUser: PROVIDER }).verdict;

describe("clipboard sentinel", () => {
	it("mints a different value every call", () => {
		const seen = new Set();
		for (let i = 0; i < 64; i += 1) seen.add(mintSentinel(H2G));
		strictEqual(seen.size, 64, "sentinels collided within a single run");
	});

	it("separates the two directions of one run", () => {
		notStrictEqual(mintSentinel(H2G), mintSentinel(G2H));
		match(mintSentinel(H2G), /^switchyard-clipboard-host-to-guest-/);
		match(mintSentinel(G2H), /^switchyard-clipboard-guest-to-host-/);
	});
});

describe("host-to-guest classification", () => {
	const ok_ = `clipboard-probe: direction=host-to-guest sentinel-absent origin=guest user=${PROVIDER} bytes=0`;

	it("passes only a probe that ran in the guest and found nothing", () => {
		strictEqual(classify(ok_, H2G), CLIPBOARD_VERDICTS.ISOLATED);
	});

	it("reports a visible sentinel as a leak", () => {
		strictEqual(
			classify(
				`clipboard-probe: direction=host-to-guest sentinel-visible origin=guest user=${PROVIDER} bytes=52`,
				H2G,
			),
			CLIPBOARD_VERDICTS.LEAKED,
		);
	});

	// The defect this classifier replaces: every one of these once produced the
	// same "not found" as real isolation.
	it("never reads a probe that did not run as isolation", () => {
		for (const [label, text] of [
			["no output at all", ""],
			["whitespace only", "   \n"],
			["undefined", undefined],
			["null", null],
			["a transport error", "Command failed: prlctl exec"],
			[
				"output for the other direction",
				`clipboard-probe: direction=guest-to-host copied origin=guest user=${PROVIDER} bytes=52`,
			],
			[
				"an explicit probe failure",
				`clipboard-probe: direction=host-to-guest verdict=probe-failed origin=guest user=${PROVIDER} bytes=0`,
			],
			[
				"a line with neither verdict token",
				`clipboard-probe: direction=host-to-guest origin=guest user=${PROVIDER} bytes=0`,
			],
		]) {
			strictEqual(
				classify(text, H2G),
				CLIPBOARD_VERDICTS.DID_NOT_RUN,
				`${label} must not read as isolation`,
			);
		}
	});

	it("distinguishes a probe that read the wrong pasteboard from a real leak", () => {
		// origin=HOST reporting the sentinel is a probe pointed at the host's own
		// pasteboard. It would report the sentinel byte-for-byte and look exactly
		// like a guest leak.
		strictEqual(
			classify(
				`clipboard-probe: direction=host-to-guest sentinel-visible origin=HOST user=${PROVIDER} bytes=52`,
				H2G,
			),
			CLIPBOARD_VERDICTS.WRONG_ORIGIN,
		);
		strictEqual(
			classify(
				"clipboard-probe: direction=host-to-guest sentinel-absent origin=guest user=dave bytes=0",
				H2G,
			),
			CLIPBOARD_VERDICTS.WRONG_ORIGIN,
		);
	});
});

describe("guest-to-host classification", () => {
	it("accepts only a guest that confirmed it staged a sentinel", () => {
		strictEqual(
			classify(
				`clipboard-probe: direction=guest-to-host verdict=copied origin=guest user=${PROVIDER} bytes=52`,
				G2H,
			),
			CLIPBOARD_VERDICTS.ISOLATED,
		);
	});

	it("fails when the guest could not copy, so host absence would prove nothing", () => {
		for (const text of [
			`clipboard-probe: direction=guest-to-host verdict=probe-failed origin=guest user=${PROVIDER} bytes=0`,
			"",
			`clipboard-probe: direction=host-to-guest sentinel-absent origin=guest user=${PROVIDER} bytes=0`,
		]) {
			strictEqual(classify(text, G2H), CLIPBOARD_VERDICTS.DID_NOT_RUN);
		}
	});

	it("decides the host half on the host pasteboard, not in the guest", () => {
		const sentinel = mintSentinel(G2H);
		strictEqual(
			classifyHostPasteboard(`prior content ${sentinel} trailing`, { sentinel })
				.verdict,
			CLIPBOARD_VERDICTS.LEAKED,
		);
		strictEqual(
			classifyHostPasteboard("unrelated host content", { sentinel }).verdict,
			CLIPBOARD_VERDICTS.ISOLATED,
		);
		strictEqual(
			classifyHostPasteboard("", { sentinel }).verdict,
			CLIPBOARD_VERDICTS.ISOLATED,
		);
	});

	it("fails, rather than passes, when the host's own pbpaste could not run", () => {
		const sentinel = mintSentinel(G2H);
		strictEqual(
			classifyHostPasteboard(null, { sentinel }).verdict,
			CLIPBOARD_VERDICTS.DID_NOT_RUN,
		);
		strictEqual(
			classifyHostPasteboard(undefined, { sentinel }).verdict,
			CLIPBOARD_VERDICTS.DID_NOT_RUN,
		);
	});
});

describe("probe scripts", () => {
	const HOME = "/Users/someone";

	it("quote the sentinel and the host home so neither can break out", () => {
		const nasty = "a'b;rm -rf /";
		for (const build of [hostToGuestProbeScript, guestToHostProbeScript]) {
			const script = build({ sentinel: nasty, hostHome: HOME });
			ok(!script.includes("; rm -rf /"), "sentinel escaped its quoting");
			ok(script.includes(`'a'\\''b;rm -rf /'`), "sentinel is not shell-quoted");
		}
	});

	it("always exit 0, so a verdict is the only signal", () => {
		for (const build of [hostToGuestProbeScript, guestToHostProbeScript]) {
			const script = build({ sentinel: "s", hostHome: HOME });
			ok(script.trimEnd().endsWith("exit 0"), "probe signals by exit code");
		}
	});

	it("both report their direction, origin, and user", () => {
		deepStrictEqual(
			[hostToGuestProbeScript, guestToHostProbeScript].map((build) => {
				const script = build({ sentinel: "s", hostHome: HOME });
				return [
					script.includes("direction=host-to-guest") ||
						script.includes("direction=guest-to-host"),
					script.includes("origin=%s"),
					script.includes("user=%s"),
				];
			}),
			[
				[true, true, true],
				[true, true, true],
			],
		);
	});

	it("the guest-to-host probe reads its own copy back before claiming success", () => {
		const script = guestToHostProbeScript({ sentinel: "s", hostHome: HOME });
		ok(script.includes("pbcopy"), "the guest never copies anything");
		ok(
			script.indexOf("pbcopy") < script.indexOf("pbpaste"),
			"the read-back must follow the copy",
		);
		ok(
			script.includes("verdict=copied") || script.includes("copied"),
			"the guest never confirms its copy",
		);
	});
});
