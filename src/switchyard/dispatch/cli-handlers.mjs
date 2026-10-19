import {
	attestRouteRepair,
	createDefaultRouteHealthDecision,
	inspectRouteHealth,
} from "../router/health.mjs";
import { GOLDEN_IMAGE_VERIFIED_PROVIDERS } from "../router/index.mjs";
import {
	parseHealthArgs,
	parseOrphanLockRemediationArgs,
	withStateRoot,
} from "./cli-args.mjs";
import { USAGE_HEALTH } from "./cli-usage.mjs";
import { run as runOrphanLockRemediation } from "./remediate-orphaned-locks.mjs";

async function handleHealth(argv) {
	const input = parseHealthArgs(argv);
	if (input.help) {
		console.log(USAGE_HEALTH);
		return;
	}
	const onStatus = ({ event }) =>
		console.error(`dispatch: route health ${event}`);
	if (input.action === "identity") {
		const decision = createDefaultRouteHealthDecision({
			qualifiedProviders: GOLDEN_IMAGE_VERIFIED_PROVIDERS,
		});
		const identity = decision.identityFor(input);
		if (!identity) process.exitCode = 1;
		console.log(JSON.stringify(identity ?? { available: false }));
		return;
	}
	const result =
		input.action === "inspect"
			? await inspectRouteHealth({ ...input, onStatus })
			: await attestRouteRepair({ ...input, onStatus });
	if (result?.available === false) process.exitCode = 1;
	console.log(JSON.stringify(result));
}

async function handleOrphanLockRemediation(argv) {
	const { argv: remediationArgv, stateRoot } =
		parseOrphanLockRemediationArgs(argv);
	return withStateRoot(stateRoot, async () => {
		const result = await runOrphanLockRemediation(remediationArgv);
		process.exitCode = result.exitCode;
		return result;
	});
}

export { handleHealth, handleOrphanLockRemediation };
