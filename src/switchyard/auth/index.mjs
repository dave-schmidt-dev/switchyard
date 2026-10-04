function main(argv = process.argv.slice(2)) {
	const executionBackend = createExecutionBackend();

	// `--clone`: read-only clone qualification against a disposable clone, never
	// a login. Creates one disposable full clone, checks presence + liveness,
	// emits progress on stderr, prints terminal summary on stdout, optionally writes
	// a sanitized receipt, and destroys the clone.
	if (argv.includes("--clone")) {
		const { receipt } = parseCloneArgs(argv);
		runCloneCheck(executionBackend, PROVIDERS, receipt ? { receipt } : {});
		return;
	}

	// `--check`: read-only status, never a login. The default (no flag) is the
	// full walkthrough, which logs in anything unauthenticated. `--live` adds a
	// real request per authenticated, probeable provider; the walkthrough always
	// probes, because a wrong answer there costs an hour rather than a status
	// line.
	if (argv.includes("--check")) {
		runCheck(executionBackend, argv.includes("--live"));
		return;
	}

	let results;
	try {
		results = withBootedGoldenImage(executionBackend, (workspaceId) =>
			ensureProvidersAuthenticated(PROVIDERS, {
				workspaceId,
				executionBackend,
			}),
		);
	} catch (error) {
		console.error(error.message);
		// An interrupted walkthrough is not an auth failure, and reporting it as
		// exit 1 would make "someone pressed Ctrl+C" indistinguishable from "a
		// provider is unauthenticated" to anything scripting this.
		process.exitCode =
			INTERRUPT_EXIT_CODES[
				error?.code === WALKTHROUGH_INTERRUPTED ? error.signal : ""
			] ?? 1;
		return;
	}
	console.log("\n=== Auth summary ===");
	for (const result of results) {
		const status = result.inconclusive
			? "INCONCLUSIVE"
			: result.authenticated
				? "authenticated"
				: "NOT AUTHENTICATED";
		const action = result.inconclusive
			? `no login available here: ${result.loginUnavailable}`
			: result.wasAuthenticated
				? "already authenticated"
				: result.ranLogin
					? "ran interactive login"
					: result.loginUnavailable
						? `no login available here: ${result.loginUnavailable}`
						: "auth check failed";
		console.log(`${result.name}: ${status} (${action})`);
	}
	process.exitCode = authWalkthroughExitCode(results);
}
if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}

export { PROVIDERS };

import "./sessions.mjs";
import "./providers.mjs";
import "./clone-check.mjs";
import { parseCloneArgs, runCheck, runCloneCheck } from "./clone-check.mjs";
import {
	authWalkthroughExitCode,
	ensureProvidersAuthenticated,
	PROVIDERS,
} from "./providers.mjs";
import {
	createExecutionBackend,
	INTERRUPT_EXIT_CODES,
	WALKTHROUGH_INTERRUPTED,
	withBootedGoldenImage,
} from "./sessions.mjs";

export {
	CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
	CLONE_RECEIPT_ERROR_KINDS,
	formatCloneReceipt,
	parseCloneArgs,
	qualifyCloneAuth,
	reportProviderStatus,
	runCheck,
	runCloneCheck,
	writeCloneReceipt,
} from "./clone-check.mjs";
export {
	AGY_LOGIN_UNAVAILABLE,
	authWalkthroughExitCode,
	CLAUDE_LOGIN_HINT,
	COPILOT_LOGIN_COMMAND,
	ensureProvidersAuthenticated,
} from "./providers.mjs";
export { withBootedGoldenImage, withDisposableClone } from "./sessions.mjs";
