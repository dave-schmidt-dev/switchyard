// INV-1 clipboard probe: sentinel minting, the guest-side probe scripts for
// both directions, and a classifier that separates the outcomes an exit code
// cannot.
//
// The classifier exists because "the sentinel was not found" has four causes
// that a boolean collapses into one:
//
//   - the probe ran in the guest and found isolation                (ISOLATED)
//   - the probe ran and the sentinel crossed the boundary           (LEAKED)
//   - the probe never ran: no transport, no pbpaste, no output   (DID_NOT_RUN)
//   - the probe ran somewhere else, e.g. against the host's own
//     pasteboard, where it would report the sentinel byte-for-byte
//     and be indistinguishable from a real guest leak            (WRONG_ORIGIN)
//
// Only the first is a pass. Reporting the other three as isolation is how a
// broken gate reads green, which is the failure this whole file guards.
//
// prlcopypaste syncs both ways, so both directions are probed. Guest-to-host
// is the more serious breach: it is the direction in which a provider running
// in the guest could push data onto the operator's own pasteboard.

import { randomUUID } from "node:crypto";

/** Closed set of probe outcomes. Only ISOLATED passes the gate. */
export const CLIPBOARD_VERDICTS = Object.freeze({
	ISOLATED: "isolated",
	LEAKED: "leaked",
	DID_NOT_RUN: "probe_did_not_run",
	WRONG_ORIGIN: "wrong_origin",
});

export const CLIPBOARD_DIRECTIONS = Object.freeze({
	HOST_TO_GUEST: "host-to-guest",
	GUEST_TO_HOST: "guest-to-host",
});

/**
 * A sentinel no earlier run, earlier assertion, or concurrent run can have
 * left on either pasteboard. A fixed literal makes a stale value and a live
 * leak report the same verdict.
 * @param {string} [direction] included so the two directions of one run cannot
 *   be confused for each other in probe output
 * @returns {string}
 */
export function mintSentinel(direction = "probe") {
	return `switchyard-clipboard-${direction}-${randomUUID()}`;
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Guest-side script for the host-to-guest direction: read the guest pasteboard
 * and report whether the host's sentinel is visible there.
 *
 * Always exits 0 and reports on stdout. Signalling through the exit code made
 * a transport failure and a real leak surface identically, as an opaque
 * `Command failed` with empty output.
 * @param {{sentinel: string, hostHome: string}} options
 * @returns {string}
 */
export function hostToGuestProbeScript({ sentinel, hostHome }) {
	return `set +e
paste="$(/usr/bin/pbpaste 2>/dev/null)"
origin=guest
test -e ${shellQuote(hostHome)} && origin=HOST
user="$(/usr/bin/whoami)"
if printf %s "$paste" | /usr/bin/grep -Fq ${shellQuote(sentinel)}; then
	verdict=sentinel-visible
else
	verdict=sentinel-absent
fi
printf 'clipboard-probe: direction=host-to-guest %s origin=%s user=%s bytes=%s\\n' "$verdict" "$origin" "$user" "$(printf %s "$paste" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
exit 0`;
}

/**
 * Guest-side script for the guest-to-host direction: put a guest-minted
 * sentinel on the guest pasteboard and confirm the guest can read it back.
 *
 * The read-back matters. Without it, the sentinel's later absence on the host
 * would prove only that nothing was ever put on the guest pasteboard, which is
 * a probe that did not run rather than a boundary that held.
 * @param {{sentinel: string, hostHome: string}} options
 * @returns {string}
 */
export function guestToHostProbeScript({ sentinel, hostHome }) {
	return `set +e
origin=guest
test -e ${shellQuote(hostHome)} && origin=HOST
user="$(/usr/bin/whoami)"
printf %s ${shellQuote(sentinel)} | /usr/bin/pbcopy 2>/dev/null
copy_status=$?
back="$(/usr/bin/pbpaste 2>/dev/null)"
if ((copy_status != 0)); then
	verdict=probe-failed
elif printf %s "$back" | /usr/bin/grep -Fq ${shellQuote(sentinel)}; then
	verdict=copied
else
	verdict=probe-failed
fi
printf 'clipboard-probe: direction=guest-to-host %s origin=%s user=%s bytes=%s\\n' "$verdict" "$origin" "$user" "$(printf %s "$back" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
exit 0`;
}

/**
 * Classify one direction's probe output. Returns a closed verdict plus the raw
 * text, so a failure message can quote what the probe actually said.
 * @param {string} text probe stdout
 * @param {{direction: string, providerUser: string}} context
 * @returns {{verdict: string, detail: string}}
 */
export function classifyProbeOutput(text, { direction, providerUser }) {
	const detail = JSON.stringify(String(text ?? "").trim());
	const line = String(text ?? "");
	const marker = `direction=${direction}`;

	// Ordered deliberately: identity before verdict. A probe that reported a
	// sentinel from the wrong pasteboard must not be read as a leak, and a
	// probe with no output at all must not be read as isolation.
	if (!line.includes("clipboard-probe:") || !line.includes(marker)) {
		return { verdict: CLIPBOARD_VERDICTS.DID_NOT_RUN, detail };
	}
	if (line.includes("verdict=probe-failed") || /\bprobe-failed\b/.test(line)) {
		return { verdict: CLIPBOARD_VERDICTS.DID_NOT_RUN, detail };
	}
	if (!new RegExp(`user=${providerUser}\\b`).test(line)) {
		return { verdict: CLIPBOARD_VERDICTS.WRONG_ORIGIN, detail };
	}
	if (!/\borigin=guest\b/.test(line)) {
		return { verdict: CLIPBOARD_VERDICTS.WRONG_ORIGIN, detail };
	}
	if (direction === CLIPBOARD_DIRECTIONS.HOST_TO_GUEST) {
		if (/\bsentinel-visible\b/.test(line)) {
			return { verdict: CLIPBOARD_VERDICTS.LEAKED, detail };
		}
		if (/\bsentinel-absent\b/.test(line)) {
			return { verdict: CLIPBOARD_VERDICTS.ISOLATED, detail };
		}
		return { verdict: CLIPBOARD_VERDICTS.DID_NOT_RUN, detail };
	}
	// guest-to-host: the guest half only proves it staged a sentinel. Whether
	// that sentinel reached the host is decided on the host, by
	// classifyHostPasteboard below.
	if (/\bverdict=copied\b/.test(line) || /\bcopied\b/.test(line)) {
		return { verdict: CLIPBOARD_VERDICTS.ISOLATED, detail };
	}
	return { verdict: CLIPBOARD_VERDICTS.DID_NOT_RUN, detail };
}

/**
 * The host half of the guest-to-host direction: did the guest's sentinel reach
 * this pasteboard? Only meaningful once the guest confirmed it staged one.
 * @param {string|null|undefined} hostPasteboard host pbpaste output, or null
 *   when pbpaste itself could not run
 * @param {{sentinel: string}} context
 * @returns {{verdict: string, detail: string}}
 */
export function classifyHostPasteboard(hostPasteboard, { sentinel }) {
	if (hostPasteboard === null || hostPasteboard === undefined) {
		return {
			verdict: CLIPBOARD_VERDICTS.DID_NOT_RUN,
			detail: '"host pbpaste did not run"',
		};
	}
	const text = String(hostPasteboard);
	return {
		verdict: text.includes(sentinel)
			? CLIPBOARD_VERDICTS.LEAKED
			: CLIPBOARD_VERDICTS.ISOLATED,
		detail: `"host pasteboard carried ${text.length} bytes"`,
	};
}
