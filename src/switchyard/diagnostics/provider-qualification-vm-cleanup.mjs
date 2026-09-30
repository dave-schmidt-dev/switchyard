import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VM_NAME = /^switchyard-work-[A-Za-z0-9._-]{1,120}$/u;

/** Names of every Parallels VM, or null when the listing itself failed. */
function listParallelsVmNames() {
	const result = spawnSync(
		"prlctl",
		["list", "--all", "-o", "name", "--no-header"],
		{
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Prove a finished VM queue run left nothing behind, from durable evidence
 * rather than the in-memory task result: the run and its report both ended
 * `succeeded` with `cleanupState: complete`, the run recorded at least one
 * allocation intent, and no VM named by those intents still exists. The writer
 * lives inside that VM, so its absence also proves the writer stopped.
 */
export function vmRunCleanupProven(
	report,
	projectPath,
	{ listVms = listParallelsVmNames } = {},
) {
	const runId = report?.runId;
	if (typeof runId !== "string" || !RUN_ID.test(runId)) return false;
	if (report.state !== "succeeded" || report.cleanupState !== "complete")
		return false;
	const runRoot = join(projectPath, ".logs", "switchyard", "runs", runId);
	try {
		const run = JSON.parse(readFileSync(join(runRoot, "run.json"), "utf8"));
		if (run.state !== "succeeded" || run.cleanupState !== "complete")
			return false;
		const names = readdirSync(join(runRoot, "resources"))
			.filter((file) => /^parallels-allocation-.*\.intent\.json$/u.test(file))
			.map((file) =>
				JSON.parse(readFileSync(join(runRoot, "resources", file), "utf8")),
			)
			.map((intent) => intent?.vmName);
		if (names.length === 0 || !names.every((name) => VM_NAME.test(name ?? "")))
			return false;
		const existing = listVms();
		return (
			Array.isArray(existing) && names.every((name) => !existing.includes(name))
		);
	} catch {
		return false;
	}
}
