// The cadence's decisions, separated from its side effects (host-io.mjs) so
// every branch is testable: which CLIs have a newer stable release, whether a
// staged candidate may be promoted, and what the owner is told.
//
// Invariants:
//   * a candidate whose flag contract or canary fails is HELD: its pin is not
//     written, the host is not updated and nothing is committed for it;
//   * the roster is never read or written (pins only);
//   * promotion is per CLI, so one held candidate never blocks another.

import { CHANNELS, compareVersions } from "./channels.mjs";

/** Rows of cli-manifest.txt keyed by provider; comments are not rows. */
export function parseManifest(text) {
	const rows = new Map();
	for (const line of String(text).split("\n")) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		const [provider, kind, ref, detail, hash, version] = line.split("|");
		rows.set(provider, { line, kind, ref, detail, hash, version });
	}
	return rows;
}

/**
 * The current manifest with only the promoted providers' rows replaced by
 * their candidate rows. Header, order and every held row stay byte-identical.
 */
export function mergeManifest(currentText, candidateRows, promoted) {
	return String(currentText)
		.split("\n")
		.map((line) => {
			if (line.trim() === "" || line.startsWith("#")) return line;
			const provider = line.split("|")[0];
			if (!promoted.has(provider)) return line;
			const replacement = candidateRows.get(provider);
			if (!replacement)
				throw new Error(`no candidate manifest row for ${provider}`);
			return replacement.line;
		})
		.join("\n");
}

/** CLIs whose channel has a stable release newer than what we run. */
export function selectCandidates(status) {
	const candidates = [];
	for (const [name, entry] of Object.entries(status)) {
		const current = CHANNELS[name].manifest ? entry.pin : entry.host;
		if (!entry.latest || !current) continue;
		if (compareVersions(entry.latest, current) > 0)
			candidates.push({ name, from: current, to: entry.latest });
	}
	return candidates;
}

/** A staged candidate is promotable only when nothing it was checked by failed. */
export function verdictFor({
	staged,
	contract,
	canaries,
	failingCanaryStatuses,
}) {
	if (!staged.ok)
		return { pass: false, reason: `not staged: ${staged.reason}` };
	if (!contract.ok) return { pass: false, reason: "flag contract failed" };
	const failed = canaries.filter((outcome) =>
		failingCanaryStatuses.includes(outcome.status),
	);
	if (failed.length > 0)
		return {
			pass: false,
			reason: `canary ${failed.map((outcome) => outcome.status).join(", ")}`,
		};
	return { pass: true, reason: null };
}

/** Title and body for the owner's notification surface and the run log. */
export function formatCadenceReport(report) {
	const lines = [];
	const verdict = report.ok ? "PASS" : "FAIL";
	const title = `Switchyard CLI cadence ${verdict}`;
	lines.push(`${title} (${report.mode}, ${report.startedAt})`);
	for (const [name, entry] of Object.entries(report.status)) {
		const parts = [
			`pin ${entry.pin ?? "-"}`,
			`host ${entry.host ?? "absent"}`,
			`stable ${entry.latest ?? `unknown (${entry.error})`}`,
		];
		if (entry.otherChannel) parts.push(entry.otherChannel);
		lines.push(`  ${name}: ${parts.join(", ")}`);
	}
	if (!report.drift.ok) {
		lines.push("host drift (sync-host-clis.sh --check):");
		for (const line of report.drift.lines) lines.push(`  ${line}`);
	}
	if (!report.hostContract.ok) {
		lines.push("host flag contract:");
		for (const line of report.hostContract.lines) lines.push(`  ${line}`);
	}
	for (const candidate of report.candidates) {
		const outcome = candidate.verdict.pass
			? candidate.promoted
				? "PROMOTED"
				: "PASSED (not promoted)"
			: `HELD (${candidate.verdict.reason})`;
		lines.push(
			`update ${candidate.name} ${candidate.from} -> ${candidate.to}: ${outcome}`,
		);
		for (const line of candidate.contract?.lines ?? [])
			if (/FAIL|note:/u.test(line)) lines.push(`  ${line}`);
		for (const canary of candidate.canaries ?? [])
			lines.push(`  canary ${canary.cli}: ${canary.status}`);
	}
	if (report.mode !== "check" && report.candidates.length === 0)
		lines.push("no newer stable releases");
	if (report.promotion) {
		const { promotion } = report;
		lines.push(
			`promotion: host ${promotion.host.ok ? "updated" : "FAILED"}; post-update contract ${promotion.postContract.ok ? "ok" : "FAILED"}`,
		);
		for (const line of [
			...promotion.host.lines,
			...promotion.postContract.lines,
		])
			if (/FAIL|DRIFT|ERROR/u.test(line)) lines.push(`  ${line}`);
		if (promotion.commit)
			lines.push(
				`pins committed on local branch ${promotion.commit.branch} (${promotion.commit.sha.slice(0, 12)}); review and merge, then npm run cli:sync for the golden VM`,
			);
	}
	for (const note of report.notes) lines.push(`note: ${note}`);
	return { title, body: lines.join("\n") };
}

/**
 * One cadence run.
 * mode "check":   channels, host drift and the host's own flag contract only.
 * mode "stage":   also stage each newer stable in scratch and check it.
 * mode "promote": also update the host and commit pins for passing candidates.
 */
export async function runCadence({ mode, startedAt }, io) {
	const report = {
		mode,
		startedAt,
		ok: true,
		status: {},
		drift: { ok: true, lines: [] },
		hostContract: { ok: true, lines: [] },
		candidates: [],
		promotion: null,
		notes: [],
	};
	const manifestText = await io.readManifest();
	const pins = parseManifest(manifestText);
	for (const name of Object.keys(CHANNELS)) {
		const entry = { pin: pins.get(name)?.version ?? null };
		entry.host = await io.hostVersion(CHANNELS[name].bin);
		try {
			entry.latest = await io.resolveLatest(name);
		} catch (error) {
			entry.latest = null;
			entry.error = error.message;
			report.notes.push(
				`could not read ${name}'s stable channel: ${error.message}`,
			);
		}
		const other = CHANNELS[name].informational;
		if (other) {
			const version = await io.otherChannelVersion(other);
			if (version && version !== entry.pin)
				entry.otherChannel = `${other.kind} ${other.formula} ${version} (not followed)`;
		}
		report.status[name] = entry;
	}
	io.log("checking host drift against the pinned manifest");
	report.drift = await io.syncHostCheck();
	io.log("checking the host's installed CLIs against the flag contract");
	report.hostContract = await io.contract({ strict: false });

	const candidates = selectCandidates(report.status);
	if (mode === "check")
		for (const candidate of candidates)
			report.notes.push(
				`newer stable ${candidate.name} ${candidate.from} -> ${candidate.to} (run --mode stage to test it)`,
			);
	if (mode !== "check") {
		// One generation per candidate, every other row at its pin, so a
		// provider whose source cannot be pinned (vibe 2.25.8 ships no sdist)
		// holds only itself.
		const candidateRows = new Map();
		for (const candidate of candidates) {
			if (!CHANNELS[candidate.name].manifest) continue;
			const versions = {};
			for (const [name, channel] of Object.entries(CHANNELS))
				if (channel.manifest) versions[name] = report.status[name].pin;
			versions[candidate.name] = candidate.to;
			try {
				const text = await io.generateCandidateManifest(versions);
				const row = parseManifest(text).get(candidate.name);
				if (row?.version === candidate.to)
					candidateRows.set(candidate.name, row);
				else
					report.notes.push(
						`${candidate.name}: regenerated row is ${row?.version ?? "missing"}, not ${candidate.to}`,
					);
			} catch (error) {
				report.notes.push(
					`${candidate.name}: candidate manifest row not generated: ${error.message}`,
				);
			}
		}
		for (const candidate of candidates) {
			io.log(`staging ${candidate.name} ${candidate.to}`);
			const row = candidateRows.get(candidate.name) ?? null;
			const staged = await io.stage(candidate.name, candidate.to, row);
			const only = [CHANNELS[candidate.name].bin];
			const binOverrides = staged.ok ? { [only[0]]: staged.binary } : {};
			const contract = staged.ok
				? await io.contract({ strict: true, only, binOverrides })
				: { ok: false, lines: [] };
			const canaries =
				staged.ok && contract.ok && CHANNELS[candidate.name].harness
					? await io.canary({
							names: [CHANNELS[candidate.name].harness],
							binOverrides,
						})
					: [];
			let verdict = verdictFor({
				staged,
				contract,
				canaries,
				failingCanaryStatuses: io.failingCanaryStatuses,
			});
			if (verdict.pass && CHANNELS[candidate.name].manifest && !row)
				verdict = {
					pass: false,
					reason: "no candidate manifest row, so no pin to write",
				};
			report.candidates.push({
				...candidate,
				staged,
				contract,
				canaries,
				verdict,
				promoted: false,
			});
		}
		const passing = report.candidates.filter((c) => c.verdict.pass);
		if (mode === "promote" && passing.length > 0) {
			const promotedManifest = new Set(
				passing.filter((c) => CHANNELS[c.name].manifest).map((c) => c.name),
			);
			const finalManifest =
				promotedManifest.size > 0
					? mergeManifest(manifestText, candidateRows, promotedManifest)
					: manifestText;
			const host = await io.promoteHost({
				manifestText: finalManifest,
				providers: [...promotedManifest],
				hostOnly: passing
					.filter((c) => !CHANNELS[c.name].manifest)
					.map((c) => ({ name: c.name, version: c.to })),
			});
			// Whatever the host package managers actually installed is checked
			// again: an updater that overshoots the pin must not go unchecked.
			const postContract = await io.contract({
				strict: true,
				only: passing.map((c) => CHANNELS[c.name].bin),
			});
			// Pins are committed only when the host now runs them and passes.
			const commit =
				promotedManifest.size > 0 && host.ok && postContract.ok
					? await io.commitPins({
							manifestText: finalManifest,
							bumps: passing.filter((c) => promotedManifest.has(c.name)),
						})
					: null;
			for (const candidate of passing)
				candidate.promoted = host.ok && postContract.ok;
			report.promotion = { host, postContract, commit };
		}
	}
	report.ok =
		report.drift.ok &&
		report.hostContract.ok &&
		report.candidates.every((c) => c.verdict.pass) &&
		Object.values(report.status).every((entry) => !entry.error) &&
		(report.promotion === null ||
			(report.promotion.host.ok && report.promotion.postContract.ok));
	return report;
}
