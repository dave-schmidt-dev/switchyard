import { strictEqual } from "node:assert";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	__resetRosterCacheForTests,
	computeQualificationStatus,
	describeDescriptorGap,
	getInvocationDescriptor,
	getInvocationDescriptorIdentity,
	QUALIFICATION_STATUS,
	STALE_MAX_AGE_SECONDS,
} from "../src/switchyard/roster/index.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
let tmpDir;
const previousEnv = {};
function setRosterPath(value) {
	if (!("SWITCHYARD_ROSTER_PATH" in previousEnv)) {
		previousEnv.SWITCHYARD_ROSTER_PATH = process.env.SWITCHYARD_ROSTER_PATH;
	}
	if (value === undefined) {
		delete process.env.SWITCHYARD_ROSTER_PATH;
	} else {
		process.env.SWITCHYARD_ROSTER_PATH = value;
	}
	__resetRosterCacheForTests();
}
afterEach(() => {
	if ("SWITCHYARD_ROSTER_PATH" in previousEnv) {
		if (previousEnv.SWITCHYARD_ROSTER_PATH === undefined) {
			delete process.env.SWITCHYARD_ROSTER_PATH;
		} else {
			process.env.SWITCHYARD_ROSTER_PATH = previousEnv.SWITCHYARD_ROSTER_PATH;
		}
		delete previousEnv.SWITCHYARD_ROSTER_PATH;
	}
	if ("HOME" in previousEnv) {
		if (previousEnv.HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousEnv.HOME;
		}
		delete previousEnv.HOME;
	}
	__resetRosterCacheForTests();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = undefined;
	}
});
describe("roster loader — dispatch qualification evidence and freshness", () => {
	const recentTimestamp = () => new Date().toISOString();
	const descriptor = {
		target_id: "codex",
		model_ref: "openai/fixture",
		selector: "fixture-codex",
		effort: "xhigh",
		invocation_args: ["-c", "model_reasoning_effort=xhigh"],
	};
	const identity = getInvocationDescriptorIdentity(descriptor, "codex");

	function writeRoster(path, qualification, targetOverrides = {}) {
		writeFileSync(
			path,
			JSON.stringify({
				schema_version: 1,
				models: {
					"openai/fixture": { selector: "fixture-codex", status: "active" },
				},
				targets: {
					codex: {
						harness: "codex",
						enabled: true,
						cli_version: "codex-cli 0.146.0",
						wrapper_version: "sha256:wrapper-a",
						credential_profile: "default",
						qualifications: { [identity]: qualification },
						slots: {
							high: [
								{
									model_ref: descriptor.model_ref,
									effort: descriptor.effort,
									invocation_args: descriptor.invocation_args,
									priority: 1,
								},
							],
						},
						...targetOverrides,
					},
				},
			}),
			"utf8",
		);
	}

	it("authorizes a current exact dispatch_qualified receipt", () => {
		tmpDir = tempDir("switchyard-roster-qualification-");
		const path = join(tmpDir, "current.json");
		writeRoster(path, {
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			invocation_args: descriptor.invocation_args,
			tested_at: recentTimestamp(),
			cli_version: "codex-cli 0.146.0",
			wrapper_version: "sha256:wrapper-a",
			credential_profile: "default",
			promotion_receipt: {
				status: "promoted",
				atomic: true,
				descriptor_identity: identity,
				target_id: descriptor.target_id,
				model_ref: descriptor.model_ref,
				selector: descriptor.selector,
				effort: descriptor.effort,
				variant: null,
				invocation_args: descriptor.invocation_args,
				receipt_id: "receipt-1",
				committed_at: recentTimestamp(),
			},
		});
		setRosterPath(path);
		strictEqual(
			getInvocationDescriptor("codex", "high")?.descriptor_identity,
			identity,
		);
	});

	it("fails closed for probe-only, temporary, non-transmittable, stale, drifted, and wrong-argv evidence", () => {
		const records = [
			{
				status: QUALIFICATION_STATUS.PROBE_QUALIFIED,
				tested_at: recentTimestamp(),
			},
			{ status: QUALIFICATION_STATUS.TEMPORARILY_UNAVAILABLE },
			{ status: QUALIFICATION_STATUS.NOT_TRANSMITTABLE },
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: "2026-01-01T00:00:00Z",
			},
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: recentTimestamp(),
				cli_version: "codex-cli old",
			},
			{
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				tested_at: recentTimestamp(),
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
		];
		for (const [index, record] of records.entries()) {
			tmpDir = tempDir(`switchyard-roster-qualification-${index}-`);
			const path = join(tmpDir, "negative.json");
			writeRoster(path, record);
			setRosterPath(path);
			strictEqual(
				getInvocationDescriptor("codex", "high"),
				null,
				`case ${index}`,
			);
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	// Regression, 2026-09-18: every target but one aged past
	// STALE_MAX_AGE_SECONDS five days after a batch qualified together, and the
	// router reported each as the single reason `no_invocation_descriptor`.
	// Read as "provider unsupported", that sent two sessions chasing a
	// nonexistent --exclude-provider/--only-provider bug. These four states
	// have four different remedies and must stay distinguishable.
	describe("describeDescriptorGap", () => {
		const promotionFor = (recordIdentity, recordDescriptor) => ({
			status: "promoted",
			atomic: true,
			descriptor_identity: recordIdentity,
			target_id: recordDescriptor.target_id,
			model_ref: recordDescriptor.model_ref,
			selector: recordDescriptor.selector,
			effort: recordDescriptor.effort,
			variant: null,
			invocation_args: recordDescriptor.invocation_args,
			receipt_id: "receipt-gap",
			committed_at: recentTimestamp(),
		});
		const qualifiedRecord = (testedAt) => ({
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			invocation_args: descriptor.invocation_args,
			tested_at: testedAt,
			cli_version: "codex-cli 0.146.0",
			wrapper_version: "sha256:wrapper-a",
			credential_profile: "default",
			promotion_receipt: promotionFor(identity, descriptor),
		});

		const gapFor = (qualification, targetOverrides = {}) => {
			tmpDir = tempDir("switchyard-roster-gap-");
			const path = join(tmpDir, "gap.json");
			writeRoster(path, qualification, targetOverrides);
			setRosterPath(path);
			return describeDescriptorGap("codex", "high");
		};

		it("reports no gap while the exact receipt is current", () => {
			strictEqual(gapFor(qualifiedRecord(recentTimestamp())), null);
		});

		it("separates an aged-out receipt from one that was never earned", () => {
			// The incident: identity still matches, only the clock moved.
			const expired = new Date(
				Date.now() - (STALE_MAX_AGE_SECONDS + 86400) * 1000,
			).toISOString();
			strictEqual(gapFor(qualifiedRecord(expired)), "qualification_expired");
			// No receipt of any kind — a canary was never run for this target.
			strictEqual(
				gapFor({ status: QUALIFICATION_STATUS.UNTESTED }),
				"qualification_missing",
			);
		});

		it("reports a receipt stranded by a moved slot as superseded, not expired", () => {
			// Antigravity and OpenCode Go were both in this state: a fresh
			// receipt naming the descriptor the slot USED to resolve to
			// (there, a since-superseded model_ref). Age is
			// irrelevant; that evidence can never authorize today's descriptor,
			// so the remedy is a canary against the new one.
			strictEqual(
				gapFor(qualifiedRecord(recentTimestamp()), {
					slots: {
						high: [
							{
								model_ref: descriptor.model_ref,
								effort: "high",
								invocation_args: ["-c", "model_reasoning_effort=high"],
								priority: 1,
							},
						],
					},
				}),
				"qualification_superseded",
			);
		});

		it("reports a receipt that cannot authorize dispatch as invalid", () => {
			// Exact identity, not aged out, not drifted — but the promotion
			// receipt is not atomic, so the evidence cannot authorize dispatch.
			// This is the only state that reaches qualification_invalid; without
			// it the value would be unreachable.
			const record = qualifiedRecord(recentTimestamp());
			record.promotion_receipt.atomic = false;
			strictEqual(gapFor(record), "qualification_invalid");
		});

		it("routes environment drift to the same remedy as an aged-out receipt", () => {
			// A receipt whose cli_version or credential_profile no longer matches
			// the target is refused for the same reason age is: the evidence no
			// longer describes today's environment, and the remedy is a fresh
			// canary. The log string must not claim the receipt is merely old.
			const drifted = qualifiedRecord(recentTimestamp());
			drifted.cli_version = "codex-cli old";
			strictEqual(gapFor(drifted), "qualification_expired");
		});

		it("reports a capability with no resolvable slot as roster data, not qualification", () => {
			strictEqual(
				gapFor(qualifiedRecord(recentTimestamp()), { slots: { high: [] } }),
				"not_configured",
			);
		});

		it("never throws into the preflight eligibility loop", () => {
			// An exception here converts a classified preflight failure into an
			// unclassified environment_incomplete — the failure mode this
			// classifier exists to prevent.
			tmpDir = tempDir("switchyard-roster-gap-throw-");
			const path = join(tmpDir, "gap.json");
			writeRoster(path, qualifiedRecord(recentTimestamp()));
			setRosterPath(path);
			strictEqual(describeDescriptorGap("codex", "nonsense"), "not_configured");
			strictEqual(
				describeDescriptorGap("no-such-target", "high"),
				"not_configured",
			);
			strictEqual(describeDescriptorGap("", "high"), "not_configured");
		});
	});

	it("rejects malformed atomic promotion receipts", () => {
		tmpDir = tempDir("switchyard-roster-qualification-");
		const path = join(tmpDir, "malformed-promotion.json");
		writeRoster(path, {
			status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
			descriptor_identity: identity,
			tested_at: recentTimestamp(),
			promotion_receipt: { status: "rolled_back", atomic: false },
		});
		setRosterPath(path);
		strictEqual(getInvocationDescriptor("codex", "high"), null);
	});

	it("requires nested promotion receipts to match the complete descriptor atomically", () => {
		const baseReceipt = {
			status: "promoted",
			atomic: true,
			descriptor_identity: identity,
			target_id: descriptor.target_id,
			model_ref: descriptor.model_ref,
			selector: descriptor.selector,
			effort: descriptor.effort,
			variant: null,
			invocation_args: descriptor.invocation_args,
			receipt_id: "receipt-2",
			committed_at: new Date().toISOString(),
		};
		const invalidReceipts = [
			{},
			{ ...baseReceipt, atomic: undefined },
			{ ...baseReceipt, atomic: false },
			{ ...baseReceipt, target_id: "other-target" },
			{ ...baseReceipt, model_ref: "openai/other" },
			{ ...baseReceipt, effort: "high" },
			{ ...baseReceipt, variant: "high" },
			{
				...baseReceipt,
				invocation_args: ["-c", "model_reasoning_effort=high"],
			},
			{
				...baseReceipt,
				argv: ["-c", "model_reasoning_effort=high"],
			},
			{
				...baseReceipt,
				validated_invocation_args: ["-c", "model_reasoning_effort=high"],
			},
		];
		for (const [index, promotion_receipt] of invalidReceipts.entries()) {
			tmpDir = tempDir(`switchyard-roster-promotion-${index}-`);
			const path = join(tmpDir, "invalid-promotion.json");
			writeRoster(path, {
				status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
				selector: descriptor.selector,
				tested_at: recentTimestamp(),
				promotion_receipt,
			});
			setRosterPath(path);
			strictEqual(
				getInvocationDescriptor("codex", "high"),
				null,
				`promotion case ${index}`,
			);
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	it("ports staleness evaluation and treats malformed or future timestamps as stale", () => {
		const signature = {
			selector: "fixture-codex",
			cli_version: "codex-cli 0.146.0",
			wrapper_version: "sha256:wrapper-a",
			credential_profile: "default",
		};
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				signature,
				"2026-08-05T18:00:00Z",
			),
			QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				{ ...signature, wrapper_version: "sha256:wrapper-b" },
				"2026-08-05T18:00:01Z",
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "not-a-date",
				},
				signature,
				"2026-08-05T18:00:01Z",
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(
			computeQualificationStatus(
				{
					status: QUALIFICATION_STATUS.DISPATCH_QUALIFIED,
					...signature,
					tested_at: "2026-08-05T18:00:00Z",
				},
				signature,
				"2026-08-05T18:00:01Z",
				0,
			),
			QUALIFICATION_STATUS.STALE,
		);
		strictEqual(STALE_MAX_AGE_SECONDS, 30 * 24 * 60 * 60);
	});
});
