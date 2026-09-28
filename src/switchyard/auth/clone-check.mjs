import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inspectProvider, PROVIDERS } from "./providers.mjs";
import { withBootedGoldenImage, withDisposableClone } from "./sessions.mjs";
export function reportProviderStatus(
	providers = PROVIDERS,
	{ live = false, workspaceId, executionBackend } = {},
) {
	return providers.map((provider) => {
		try {
			if (provider.authMode === "ephemeral_api_key_dispatch") {
				return {
					name: provider.name,
					authenticated: true,
					...(live ? { live: null, reason: null } : {}),
					authMode: provider.authMode,
				};
			}
			const state = inspectProvider(
				provider,
				live,
				workspaceId,
				executionBackend,
			);
			// `live` stays absent unless a probe actually ran, so a caller can
			// never mistake "we did not look" for "we looked and it answered".
			return live
				? {
						name: provider.name,
						authenticated: state.authenticated,
						live: state.live,
						reason: state.reason,
					}
				: { name: provider.name, authenticated: state.authenticated };
		} catch (error) {
			// Same fail-soft contract as ensureProvidersAuthenticated: one
			// provider's check throwing must not abort the report for the rest,
			// and a check that can't complete is reported as not-authenticated,
			// never as a crash.
			console.error(
				`\n--- ${provider.name}: auth check threw, treating as not authenticated: ${error.message} ---\n`,
			);
			return { name: provider.name, authenticated: false };
		}
	});
}
export function runCheck(
	executionBackend,
	live = false,
	providers = PROVIDERS,
) {
	let statuses;
	try {
		statuses = withBootedGoldenImage(executionBackend, (workspaceId) =>
			reportProviderStatus(providers, { live, workspaceId, executionBackend }),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
		return;
	}
	console.log(
		live
			? "=== Auth status (read-only — no login attempted; live probes run only for probeable providers; BWS lanes remain unprobed) ==="
			: "=== Auth status (read-only — credential presence only; add --live to probe) ===",
	);
	for (const status of statuses) {
		if (status.authMode === "ephemeral_api_key_dispatch") {
			console.log(
				live
					? `${status.name}: BWS runtime dispatch (no OAuth login; live status unprobed)`
					: `${status.name}: BWS runtime dispatch (no OAuth login)`,
			);
			continue;
		}
		if (!status.authenticated) {
			console.log(`${status.name}: NOT AUTHENTICATED`);
			continue;
		}
		if (!live || status.live === null) {
			console.log(`${status.name}: authenticated`);
			continue;
		}
		console.log(
			status.live
				? `${status.name}: authenticated (live)`
				: `${status.name}: AUTHENTICATED BUT NOT LIVE — ${status.reason}`,
		);
	}
	process.exitCode = statuses.some(
		(status) => !status.authenticated || (live && status.live !== true),
	)
		? 1
		: 0;
}
export function qualifyCloneAuth(
	executionBackend,
	providers = PROVIDERS,
	options = {},
) {
	return withDisposableClone(
		executionBackend,
		(workspaceId) =>
			reportProviderStatus(providers, {
				live: true,
				workspaceId,
				executionBackend,
			}),
		options,
	);
}
export const CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION = 1;
export const CLONE_RECEIPT_ERROR_KINDS = Object.freeze([
	"clone_qualification_failed",
	"clone_execution_failed",
]);
export function formatCloneReceipt(statuses = [], errorKind = null) {
	const sanitizedProviders = (statuses || []).map((status) => {
		const entry = {
			name: String(status?.name ?? ""),
			authenticated: status?.authenticated === true,
			live: typeof status?.live === "boolean" ? status.live : null,
		};
		if (typeof status?.authMode === "string") {
			entry.authMode = status.authMode;
		}
		return entry;
	});

	return {
		schemaVersion: CLONE_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
		providers: sanitizedProviders,
		errorKind: errorKind ?? null,
	};
}
export function writeCloneReceipt(receiptPath, receipt) {
	if (!receiptPath || typeof receiptPath !== "string") {
		throw new TypeError("receiptPath must be a non-empty string");
	}
	mkdirSync(dirname(receiptPath), { recursive: true });
	const tmpPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	try {
		renameSync(tmpPath, receiptPath);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
		throw error;
	}
}
export function runCloneCheck(
	executionBackend,
	providers = PROVIDERS,
	options = {},
) {
	const receiptPath = options.receipt ?? options.receiptPath ?? null;
	let statuses;
	try {
		statuses = qualifyCloneAuth(executionBackend, providers, options);
	} catch (error) {
		console.error(error.message);
		if (receiptPath) {
			try {
				writeCloneReceipt(
					receiptPath,
					formatCloneReceipt([], "clone_execution_failed"),
				);
			} catch (receiptError) {
				console.error(
					`warning: failed to write qualification receipt: ${receiptError.message}`,
				);
			}
		}
		process.exitCode = 1;
		return;
	}
	console.log(
		"=== Clone auth qualification (read-only disposable clone — live probes run for probeable providers; BWS lanes remain unprobed) ===",
	);
	for (const status of statuses) {
		if (status.authMode === "ephemeral_api_key_dispatch") {
			console.log(
				`${status.name}: BWS runtime dispatch (no OAuth login; live status unprobed)`,
			);
			continue;
		}
		if (!status.authenticated) {
			console.log(`${status.name}: NOT AUTHENTICATED`);
			continue;
		}
		if (status.live === null) {
			console.log(`${status.name}: authenticated`);
			continue;
		}
		console.log(
			status.live
				? `${status.name}: authenticated (live)`
				: `${status.name}: AUTHENTICATED BUT NOT LIVE — ${status.reason}`,
		);
	}
	const hasFailure = statuses.some(
		(status) => !status.authenticated || status.live !== true,
	);
	if (receiptPath) {
		try {
			writeCloneReceipt(
				receiptPath,
				formatCloneReceipt(
					statuses,
					hasFailure ? "clone_qualification_failed" : null,
				),
			);
		} catch (receiptError) {
			console.error(
				`warning: failed to write qualification receipt: ${receiptError.message}`,
			);
		}
	}
	process.exitCode = hasFailure ? 1 : 0;
}
export function parseCloneArgs(argv) {
	let receipt = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--receipt" && i + 1 < argv.length) {
			receipt = argv[i + 1];
			i++;
		} else if (arg.startsWith("--receipt=")) {
			receipt = arg.slice("--receipt=".length);
		}
	}
	return { receipt };
}
