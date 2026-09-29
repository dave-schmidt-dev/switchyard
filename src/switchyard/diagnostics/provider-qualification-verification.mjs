import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { validateInvocationDescriptor } from "../roster/index.mjs";
import {
	isPassingQuickCheckReceipt,
	runQuickChecks,
} from "../runner/checks.mjs";
import {
	ACCEPTANCE_CHECKS,
	fixtureDigest,
	QUALIFICATION_FILES,
	QUALIFICATION_FIXTURE_VERSION,
} from "./provider-qualification-fixture.mjs";

function sha(value) {
	return createHash("sha256").update(value).digest("hex");
}
function git(projectPath, args, encoding = "utf8") {
	return spawnSync("git", ["-C", projectPath, ...args], {
		encoding,
		timeout: 10_000,
		maxBuffer: 2_000_000,
		stdio: ["ignore", "pipe", "ignore"],
	});
}
function statusPaths(projectPath) {
	const result = git(
		projectPath,
		["status", "--porcelain=v1", "-z", "--untracked-files=all"],
		"utf8",
	);
	if (result.status !== 0) return null;
	return result.stdout
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3))
		.sort();
}
function diffAndBase(projectPath) {
	const commit = git(projectPath, ["rev-parse", "HEAD"]);
	const base = git(projectPath, ["rev-parse", "HEAD^{tree}"]);
	const patch = git(projectPath, ["diff", "HEAD", "--binary"]);
	if (
		commit.status !== 0 ||
		base.status !== 0 ||
		patch.status !== 0 ||
		!patch.stdout
	)
		return null;
	return {
		commit: commit.stdout.trim(),
		baseTree: base.stdout.trim(),
		diff: patch.stdout,
	};
}
function providerResultOf(receipt) {
	return receipt?.providerResult ?? receipt?.result ?? null;
}
function exactProviderChecks(plan, receipt, candidate) {
	const result = providerResultOf(receipt);
	if (plan.lane === "simple") {
		const checks = result?.checks ?? receipt?.checks;
		return (
			Array.isArray(checks) &&
			checks.length === 1 &&
			Object.keys(checks[0] ?? {})
				.sort()
				.join(",") === "index,status" &&
			checks[0].index === 1 &&
			checks[0].status === "passed" &&
			receipt?.checkCommands?.length === 1 &&
			receipt.checkCommands[0] === "node --test tests/acceptance.test.mjs"
		);
	}
	const checkReceipt = result?.quickCheckReceipt ?? receipt?.quickCheckReceipt;
	if (!checkReceipt) return false;
	const expectedChecks = [["node", "--test", "tests/acceptance.test.mjs"]];
	return Boolean(
		candidate &&
			checkReceipt.taskId === "1" &&
			checkReceipt.baseTree === candidate.baseTree &&
			isPassingQuickCheckReceipt(checkReceipt, {
				taskId: "1",
				attempt: checkReceipt.attempt,
				baseTree: candidate.baseTree,
				diff: candidate.diff,
				checks: expectedChecks,
				setup: null,
			}),
	);
}
export function hasProvenWorkerCleanup(receipt) {
	const result = providerResultOf(receipt);
	const clean =
		receipt?.cleanup ?? result?.recovery?.cleanup ?? result?.cleanup;
	const writer = clean?.writer?.state ?? clean?.writerState;
	const workspace =
		clean?.workspace?.state ?? clean?.worktree?.state ?? clean?.workspaceState;
	const lock = clean?.projectLock?.state ?? clean?.projectLockState;
	if (
		["stopped", "never_started"].includes(writer) &&
		["removed", "not_created"].includes(workspace) &&
		["released", "not_acquired"].includes(lock)
	)
		return true;
	return false;
}
function successReceipt(receipt) {
	const result = providerResultOf(receipt);
	if (!result || typeof result !== "object" || Array.isArray(result))
		return false;
	if (result.status !== undefined && result.status !== "succeeded")
		return false;
	if (result.success !== undefined && result.success !== true) return false;
	if (result.result !== undefined && result.result !== "success") return false;
	return (
		result.status === "succeeded" ||
		result.success === true ||
		result.result === "success"
	);
}
function targetOf(receipt) {
	const result = providerResultOf(receipt) ?? {};
	return (
		receipt?.targetId ??
		result.targetId ??
		result.resolvedTargetId ??
		result.resolved_target ??
		null
	);
}
function descriptorOf(receipt) {
	const result = providerResultOf(receipt) ?? {};
	return (
		receipt?.invocationDescriptor ??
		result.invocationDescriptor ??
		result.invocation_descriptor ??
		result.descriptorReceipt ??
		null
	);
}
function descriptorIdentityOf(receipt) {
	const result = providerResultOf(receipt) ?? {};
	return (
		receipt?.descriptorIdentity ??
		result.descriptorIdentity ??
		result.descriptor_identity ??
		descriptorOf(receipt)?.descriptor_identity ??
		null
	);
}
function reportedPaths(receipt) {
	const result = providerResultOf(receipt) ?? {};
	return receipt?.changedFiles ?? result.changedFiles ?? result.outputs ?? null;
}
function canonicalPaths(values) {
	return Array.isArray(values)
		? [...values].filter((value) => typeof value === "string").sort()
		: null;
}

/** Verify receipt identity, scoped changed bytes, contained checks, and cleanup. */
export function verifyRepresentativeReceipt(plan, receipt, fixture) {
	const failures = [];
	if (plan?.status !== "ready") failures.push("plan_unavailable");
	if (!successReceipt(receipt)) failures.push("provider_failed");
	if (targetOf(receipt) !== plan?.targetId) failures.push("target_mismatch");
	const routeModel =
		receipt?.routeModel ?? providerResultOf(receipt)?.routeModel ?? null;
	if (routeModel !== null && routeModel !== plan?.selector)
		failures.push("route_model_mismatch");
	try {
		const descriptor = validateInvocationDescriptor(
			descriptorOf(receipt),
			plan.harness,
		);
		if (
			descriptor.descriptor_identity !== plan.descriptorIdentity ||
			descriptorIdentityOf(receipt) !== plan.descriptorIdentity ||
			descriptor.target_id !== plan.targetId ||
			descriptor.selector !== plan.selector ||
			(descriptor.effort ?? null) !== (plan.effort ?? null) ||
			(descriptor.variant ?? null) !== (plan.variant ?? null)
		)
			failures.push("descriptor_mismatch");
	} catch {
		failures.push("descriptor_missing_or_invalid");
	}
	if (!hasProvenWorkerCleanup(receipt)) failures.push("cleanup_unconfirmed");

	const paths = statusPaths(fixture.projectPath);
	const expectedPaths = [...QUALIFICATION_FILES].sort();
	if (!paths || JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
		failures.push("changed_path_scope_mismatch");
	}
	const reported = reportedPaths(receipt);
	if (
		reported !== null &&
		JSON.stringify(canonicalPaths(reported)) !== JSON.stringify(expectedPaths)
	) {
		failures.push("receipt_changed_paths_mismatch");
	}

	const candidate = diffAndBase(fixture.projectPath);
	if (!candidate) failures.push("candidate_diff_unavailable");
	if (
		candidate &&
		(candidate.commit !== fixture.baseCommit ||
			candidate.baseTree !== fixture.baseTree)
	) {
		failures.push("candidate_baseline_mismatch");
	}
	const verificationPaths = statusPaths(fixture.verificationProjectPath);
	const verificationTree = git(fixture.verificationProjectPath, [
		"rev-parse",
		"HEAD^{tree}",
	]);
	if (
		verificationPaths?.length !== 0 ||
		verificationTree.status !== 0 ||
		verificationTree.stdout.trim() !== fixture.baseTree
	) {
		failures.push("verification_base_unavailable");
	}
	if (!exactProviderChecks(plan, receipt, candidate))
		failures.push("provider_checks_missing_or_invalid");

	const outputDigests = {};
	for (const path of QUALIFICATION_FILES) {
		try {
			const fullPath = join(fixture.projectPath, path);
			const directory = lstatSync(
				join(fixture.projectPath, path.split("/")[0]),
			);
			const stats = lstatSync(fullPath);
			if (
				!directory.isDirectory() ||
				directory.isSymbolicLink() ||
				!stats.isFile() ||
				stats.isSymbolicLink()
			) {
				failures.push("unsafe_output_path");
				continue;
			}
			const canonical = realpathSync(fullPath);
			if (!canonical.startsWith(`${fixture.projectPath}/`)) {
				failures.push("unsafe_output_path");
				continue;
			}
			const bytes = readFileSync(fullPath);
			outputDigests[path] = `sha256:${sha(bytes)}`;
		} catch {
			failures.push("output_missing");
		}
	}
	try {
		const acceptanceStats = lstatSync(fixture.acceptancePath);
		if (!acceptanceStats.isFile() || acceptanceStats.isSymbolicLink()) {
			failures.push("acceptance_fixture_digest_mismatch");
		} else {
			const acceptanceBytes = readFileSync(fixture.acceptancePath);
			if (`sha256:${sha(acceptanceBytes)}` !== fixture.acceptanceSha256) {
				failures.push("acceptance_fixture_digest_mismatch");
			}
		}
	} catch {
		failures.push("acceptance_fixture_digest_mismatch");
	}

	const failClosedBeforeChecks = new Set([
		"plan_unavailable",
		"provider_failed",
		"target_mismatch",
		"route_model_mismatch",
		"descriptor_mismatch",
		"descriptor_missing_or_invalid",
		"provider_checks_missing_or_invalid",
		"cleanup_unconfirmed",
		"changed_path_scope_mismatch",
		"receipt_changed_paths_mismatch",
		"unsafe_output_path",
		"output_missing",
		"acceptance_fixture_digest_mismatch",
		"candidate_diff_unavailable",
		"candidate_baseline_mismatch",
		"verification_base_unavailable",
	]);
	let containedChecksPassed = false;
	let containedCleanup = false;
	let containedChecksStarted = false;
	let containedCheckEvidence = null;
	if (!failures.some((failure) => failClosedBeforeChecks.has(failure))) {
		const testPath = join(fixture.projectPath, "tests/summary.test.mjs");
		const testSource = readFileSync(testPath, "utf8");
		if ((testSource.match(/\b(?:test|it)\s*\(/gu) ?? []).length < 3) {
			failures.push("representative_tests_missing");
		}
		if (candidate) {
			const checkEvents = [];
			containedChecksStarted = true;
			const checkReceipt = runQuickChecks({
				projectPath: fixture.verificationProjectPath,
				taskId: "provider-qualification",
				attempt: 1,
				baseTree: candidate.baseTree,
				diff: candidate.diff,
				checks: ACCEPTANCE_CHECKS,
				allowedPaths: QUALIFICATION_FILES,
				snapshotPaths: [],
				onStatus: (event) => checkEvents.push(event.event),
			});
			containedCheckEvidence = checkReceipt
				? {
						status: checkReceipt.status ?? null,
						failureCode: checkReceipt.failureCode ?? null,
						cleanup: checkReceipt.cleanup?.status ?? null,
						checks: (checkReceipt.checks ?? []).map((item) => ({
							index: item.index,
							exitCode: item.exitCode,
							signal: item.signal,
							timedOut: item.timedOut,
							groupCleanup: item.groupCleanup,
						})),
						events: checkEvents,
					}
				: null;
			containedCleanup = checkReceipt?.cleanup?.status === "complete";
			containedChecksPassed = isPassingQuickCheckReceipt(checkReceipt, {
				taskId: "provider-qualification",
				attempt: 1,
				baseTree: candidate.baseTree,
				diff: candidate.diff,
				checks: ACCEPTANCE_CHECKS,
				setup: null,
			});
			if (!containedChecksPassed)
				failures.push("contained_acceptance_or_cleanup_failed");
		}
	}
	return {
		passed: failures.length === 0,
		failures: [...new Set(failures)],
		targetId: plan?.targetId ?? null,
		capability: plan?.capability ?? null,
		descriptorIdentity: plan?.descriptorIdentity ?? null,
		fixtureVersion: QUALIFICATION_FIXTURE_VERSION,
		fixtureSha256: fixtureDigest(),
		outputDigests,
		containedChecks: ACCEPTANCE_CHECKS.map((argv) => argv.join(" ")),
		cleanupVerified: hasProvenWorkerCleanup(receipt) && containedCleanup,
		containedChecksPassed,
		containedChecksStarted,
		containedCheckEvidence,
		promotion: "none",
	};
}
