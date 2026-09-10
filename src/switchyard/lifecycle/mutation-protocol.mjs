import { createHash } from "node:crypto";

/**
 * A small, provider-neutral protocol for mutations whose response can be
 * lost.  The command is never treated as proof of completion: an adapter must
 * supply an observation that proves the requested postcondition.
 */
const MUTATION_PROTOCOL_VERSION = 1;
const MUTATION_STATES = Object.freeze([
	"intent",
	"commanded",
	"observed",
	"completed",
	"failed",
	"uncertain",
]);
const MUTATION_OUTCOMES = Object.freeze([
	"confirmed",
	"failed",
	"ambiguous",
	"unknown",
	"timed_out",
]);

const DEFAULT_MUTATION_POLICY = Object.freeze({
	maxAttempts: 2,
	commandTimeoutMs: 5_000,
	observationTimeoutMs: 5_000,
	backoffBaseMs: 25,
	backoffMaxMs: 250,
	retryOn: Object.freeze(["timed_out", "failed"]),
	retryAmbiguous: false,
	idempotency: "conditional",
	reconcile: true,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RESOURCE_RE = /^[A-Za-z0-9._:/-]{1,256}$/u;
const SAFE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class MutationProtocolError extends Error {
	constructor(code, message = code, record = null) {
		super(message);
		this.name = "MutationProtocolError";
		this.code = code;
		this.record = record;
	}
}

function safeCode(value, fallback) {
	return typeof value === "string" && SAFE_CODE_RE.test(value)
		? value
		: fallback;
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function generatedOperationId(operation, resource) {
	const digest = createHash("sha256")
		.update(stableJson([operation, resource]), "utf8")
		.digest("hex")
		.slice(0, 32);
	return `operation-${digest}`;
}

function validateDuration(value, name, { allowZero = false } = {}) {
	if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0))
		throw new TypeError(
			`${name} must be a bounded ${allowZero ? "non-negative" : "positive"} integer`,
		);
	return value;
}

/** Normalize an adapter-declared retry and idempotency policy. */
export function createMutationPolicy(options = {}) {
	const merged = { ...DEFAULT_MUTATION_POLICY, ...options };
	validateDuration(merged.maxAttempts, "maxAttempts");
	if (merged.maxAttempts > 3)
		throw new TypeError("maxAttempts exceeds mutation bound");
	validateDuration(merged.commandTimeoutMs, "commandTimeoutMs");
	validateDuration(merged.observationTimeoutMs, "observationTimeoutMs");
	validateDuration(merged.backoffBaseMs, "backoffBaseMs", { allowZero: true });
	validateDuration(merged.backoffMaxMs, "backoffMaxMs", { allowZero: true });
	if (merged.backoffMaxMs < merged.backoffBaseMs)
		throw new TypeError("backoffMaxMs must cover backoffBaseMs");
	if (
		!Array.isArray(merged.retryOn) ||
		merged.retryOn.some((value) => !MUTATION_OUTCOMES.includes(value))
	)
		throw new TypeError("retryOn must contain only closed mutation outcomes");
	if (typeof merged.retryAmbiguous !== "boolean")
		throw new TypeError("retryAmbiguous must be boolean");
	if (!["idempotent", "conditional", "unknown"].includes(merged.idempotency))
		throw new TypeError("idempotency must be a closed policy value");
	if (
		typeof merged.reconcile !== "boolean" &&
		typeof merged.reconcile !== "function"
	)
		throw new TypeError("reconcile must be boolean or a function");
	return Object.freeze({
		maxAttempts: merged.maxAttempts,
		commandTimeoutMs: merged.commandTimeoutMs,
		observationTimeoutMs: merged.observationTimeoutMs,
		backoffBaseMs: merged.backoffBaseMs,
		backoffMaxMs: merged.backoffMaxMs,
		retryOn: Object.freeze([...new Set(merged.retryOn)]),
		retryAmbiguous: merged.retryAmbiguous,
		idempotency: merged.idempotency,
		reconcile: typeof merged.reconcile === "function" ? true : merged.reconcile,
	});
}

/** Return a deterministic exponential delay; no random jitter is persisted. */
export function mutationBackoffDelay(
	attempt,
	policy = DEFAULT_MUTATION_POLICY,
) {
	if (!Number.isSafeInteger(attempt) || attempt < 1)
		throw new TypeError("attempt must be positive");
	const configured = createMutationPolicy(policy);
	return Math.min(
		configured.backoffMaxMs,
		configured.backoffBaseMs * 2 ** (attempt - 1),
	);
}

/** Construct the durable intent record before invoking a command. */
export function createMutationIntent({
	operation,
	resource,
	operationId = null,
	policy = {},
	now = new Date().toISOString(),
} = {}) {
	if (typeof operation !== "string" || !ID_RE.test(operation))
		throw new TypeError("mutation operation is invalid");
	if (typeof resource !== "string" || !RESOURCE_RE.test(resource))
		throw new TypeError("mutation resource is invalid");
	const normalizedPolicy = createMutationPolicy(policy);
	const id = operationId ?? generatedOperationId(operation, resource);
	if (!ID_RE.test(id)) throw new TypeError("mutation operationId is invalid");
	if (typeof now !== "string" || Number.isNaN(Date.parse(now)))
		throw new TypeError("mutation timestamp is invalid");
	return Object.freeze({
		version: MUTATION_PROTOCOL_VERSION,
		operationId: id,
		operation,
		resource,
		state: "intent",
		outcome: "unknown",
		attempt: 0,
		maxAttempts: normalizedPolicy.maxAttempts,
		idempotency: normalizedPolicy.idempotency,
		retryAmbiguous: normalizedPolicy.retryAmbiguous,
		recordedAt: now,
	});
}

/** Validate the closed, content-free shape accepted by a durable store. */
export function validateMutationRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record))
		throw new MutationProtocolError("mutation_record_invalid");
	if (
		record.version !== MUTATION_PROTOCOL_VERSION ||
		!ID_RE.test(record.operationId ?? "") ||
		!ID_RE.test(record.operation ?? "") ||
		!RESOURCE_RE.test(record.resource ?? "") ||
		!MUTATION_STATES.includes(record.state) ||
		!MUTATION_OUTCOMES.includes(record.outcome) ||
		!Number.isSafeInteger(record.attempt) ||
		record.attempt < 0 ||
		!Number.isSafeInteger(record.maxAttempts) ||
		record.maxAttempts < 1 ||
		record.maxAttempts > 3 ||
		!["idempotent", "conditional", "unknown"].includes(record.idempotency) ||
		typeof record.recordedAt !== "string" ||
		Number.isNaN(Date.parse(record.recordedAt))
	)
		throw new MutationProtocolError("mutation_record_invalid");
	return record;
}

function normalizeObservation(value) {
	if (value === true) return { status: "confirmed", ownership: "confirmed" };
	if (value === false || value == null)
		return { status: "ambiguous", ownership: "unknown" };
	if (typeof value !== "object" || Array.isArray(value))
		return { status: "ambiguous", ownership: "unknown" };
	const status = ["confirmed", "failed", "ambiguous", "unknown"].includes(
		value.status,
	)
		? value.status
		: "unknown";
	const ownership = ["confirmed", "mismatch", "unknown"].includes(
		value.ownership,
	)
		? value.ownership
		: status === "confirmed"
			? "confirmed"
			: "unknown";
	return { status, ownership, code: safeCode(value.code, null) };
}

async function boundedCall(fn, timeoutMs, context) {
	let timer;
	let settled = false;
	const controller = new AbortController();
	const work = Promise.resolve().then(() =>
		fn({ ...context, signal: controller.signal }),
	);
	work.catch(() => {});
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => {
			if (settled) return;
			controller.abort();
			resolve({ timedOut: true });
		}, timeoutMs);
	});
	const result = await Promise.race([
		work.then(
			(value) => ({ value }),
			(error) => ({ rejected: error }),
		),
		timeout,
	]);
	settled = true;
	clearTimeout(timer);
	return result;
}

function emit(onStatus, event, operationId, detail = {}) {
	try {
		onStatus?.({ phase: "mutation", event, operationId, ...detail });
	} catch {
		/* observation cannot change mutation */
	}
}

/**
 * Execute one mutation with durable intent, bounded command/observation,
 * explicit postcondition evidence, and a deterministic retry budget.
 */
export async function executeMutation({
	operation,
	resource,
	operationId = null,
	policy = {},
	command,
	observe,
	reconcile,
	persist,
	resume = null,
	onStatus,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => new Date().toISOString(),
	sleepFn,
	nowFn,
} = {}) {
	if (typeof command !== "function" || typeof observe !== "function")
		throw new TypeError("mutation requires command and observe functions");
	const normalizedPolicy = createMutationPolicy(policy);
	const wait = sleepFn ?? sleep;
	const clock = nowFn ?? now;
	const reconcileFn =
		typeof reconcile === "function"
			? reconcile
			: typeof policy?.reconcile === "function"
				? policy.reconcile
				: null;
	let record = resume
		? validateMutationRecord(resume)
		: createMutationIntent({
				operation,
				resource,
				operationId,
				policy: normalizedPolicy,
				now: clock(),
			});
	if (operation && record.operation !== operation)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (resource && record.resource !== resource)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (operationId && record.operationId !== operationId)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (record.state === "completed") return record;
	// An uncertain or known failed operation is a recovery boundary. Re-entry
	// must not silently issue a second destructive command; the caller may
	// explicitly start a fresh operation after reconciling ownership.
	if (resume && (record.state === "uncertain" || record.state === "failed"))
		return record;
	if (
		resume &&
		["commanded", "observed"].includes(record.state) &&
		!normalizedPolicy.reconcile &&
		!reconcileFn
	) {
		const unresolved = Object.freeze({
			...record,
			state: "uncertain",
			outcome: "ambiguous",
			recordedAt: clock(),
		});
		if (typeof persist === "function") await persist(unresolved);
		return unresolved;
	}
	if (
		resume &&
		(normalizedPolicy.reconcile || reconcileFn) &&
		(record.state === "commanded" || record.state === "observed")
	) {
		const reconciled = await boundedCall(
			(context) =>
				reconcileFn
					? reconcileFn({ ...context, resumed: true })
					: observe(undefined, {
							...context,
							resumed: true,
							commandError: null,
						}),
			normalizedPolicy.observationTimeoutMs,
			{ operationId: record.operationId, attempt: record.attempt },
		);
		const observed = reconciled.timedOut
			? {
					status: "ambiguous",
					ownership: "unknown",
					code: "reconciliation_timed_out",
				}
			: normalizeObservation(reconciled.value);
		if (observed.status === "confirmed") {
			record = Object.freeze({
				...record,
				state: "completed",
				outcome: "confirmed",
				reconciled: true,
				recordedAt: clock(),
			});
			if (typeof persist === "function") await persist(record);
			return record;
		}
		const unresolved = Object.freeze({
			...record,
			state: "uncertain",
			outcome: "ambiguous",
			reconciled: true,
			recordedAt: clock(),
			...(observed.code ? { code: observed.code } : {}),
		});
		if (typeof persist === "function") await persist(unresolved);
		return unresolved;
	}
	if (typeof persist === "function") await persist(record);
	emit(onStatus, "mutation_intent_durable", record.operationId);

	for (
		let attempt = Math.max(1, record.attempt + 1);
		attempt <= normalizedPolicy.maxAttempts;
		attempt += 1
	) {
		record = {
			...record,
			state: "commanded",
			attempt,
			outcome: "unknown",
			recordedAt: clock(),
		};
		if (typeof persist === "function") await persist(record);
		emit(onStatus, "mutation_command_started", record.operationId, { attempt });
		let commandResult = null;
		let commandError = null;
		const bounded = await boundedCall(
			command,
			normalizedPolicy.commandTimeoutMs,
			{ operationId: record.operationId, attempt },
		);
		if (bounded.timedOut) {
			commandError = new MutationProtocolError("mutation_command_timed_out");
			emit(onStatus, "mutation_command_timed_out", record.operationId, {
				attempt,
			});
		} else {
			if (bounded.rejected) commandError = bounded.rejected;
			commandResult = bounded.value;
			if (commandResult?.error instanceof Error)
				commandError = commandResult.error;
		}

		const observation = await boundedCall(
			(context) => observe(commandResult, { ...context, commandError }),
			normalizedPolicy.observationTimeoutMs,
			{ operationId: record.operationId, attempt },
		);
		const observed = observation.timedOut
			? {
					status: "ambiguous",
					ownership: "unknown",
					code: "observation_timed_out",
				}
			: normalizeObservation(observation.value);
		record = {
			...record,
			state:
				observed.status === "confirmed"
					? "observed"
					: observed.status === "failed"
						? "failed"
						: "uncertain",
			outcome:
				observed.status === "confirmed"
					? "confirmed"
					: observed.status === "failed"
						? "failed"
						: commandError?.code === "mutation_command_timed_out"
							? "timed_out"
							: "ambiguous",
			recordedAt: clock(),
			...(observed.code ? { code: observed.code } : {}),
		};
		if (typeof persist === "function") await persist(record);
		emit(
			onStatus,
			observed.status === "confirmed"
				? "mutation_postcondition_observed"
				: "mutation_postcondition_uncertain",
			record.operationId,
			{ attempt, status: observed.status },
		);
		if (observed.status === "confirmed") {
			record = { ...record, state: "completed", recordedAt: clock() };
			if (typeof persist === "function") await persist(record);
			emit(onStatus, "mutation_completed", record.operationId, { attempt });
			return Object.freeze(record);
		}
		const ownershipAmbiguous = observed.ownership !== "confirmed";
		const retryAllowed =
			attempt < normalizedPolicy.maxAttempts &&
			normalizedPolicy.idempotency !== "unknown" &&
			!ownershipAmbiguous &&
			(normalizedPolicy.retryOn.includes(record.outcome) ||
				(record.outcome === "ambiguous" && normalizedPolicy.retryAmbiguous));
		if (!retryAllowed) break;
		const delay = mutationBackoffDelay(attempt, normalizedPolicy);
		emit(onStatus, "mutation_retry_scheduled", record.operationId, {
			attempt,
			delayMs: delay,
		});
		await wait(delay);
	}

	record = Object.freeze({
		...record,
		state: record.outcome === "failed" ? "failed" : "uncertain",
		recordedAt: clock(),
	});
	if (typeof persist === "function") await persist(record);
	emit(
		onStatus,
		record.state === "uncertain" ? "mutation_uncertain" : "mutation_failed",
		record.operationId,
		{ attempt: record.attempt },
	);
	return record;
}

/** Synchronous adapter for already-bounded host commands (for timeout paths). */
export function executeMutationSync({
	operation,
	resource,
	operationId = null,
	policy = {},
	command,
	observe,
	reconcile,
	persist,
	resume = null,
	onStatus,
	now = () => new Date().toISOString(),
	sleepFn = () => {},
	nowFn,
} = {}) {
	if (typeof command !== "function" || typeof observe !== "function")
		throw new TypeError("mutation requires command and observe functions");
	const normalizedPolicy = createMutationPolicy(policy);
	const clock = nowFn ?? now;
	const reconcileFn =
		typeof reconcile === "function"
			? reconcile
			: typeof policy?.reconcile === "function"
				? policy.reconcile
				: null;
	let record = resume
		? validateMutationRecord(resume)
		: createMutationIntent({
				operation,
				resource,
				operationId,
				policy: normalizedPolicy,
				now: clock(),
			});
	if (operation && record.operation !== operation)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (resource && record.resource !== resource)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (operationId && record.operationId !== operationId)
		throw new MutationProtocolError("mutation_identity_mismatch");
	if (
		record.state === "completed" ||
		(resume && ["uncertain", "failed"].includes(record.state))
	)
		return record;
	if (
		resume &&
		["commanded", "observed"].includes(record.state) &&
		!normalizedPolicy.reconcile &&
		!reconcileFn
	) {
		const unresolved = Object.freeze({
			...record,
			state: "uncertain",
			outcome: "ambiguous",
			recordedAt: clock(),
		});
		persist?.(unresolved);
		return unresolved;
	}
	if (
		resume &&
		(normalizedPolicy.reconcile || reconcileFn) &&
		["commanded", "observed"].includes(record.state)
	) {
		const observed = normalizeObservation(
			reconcileFn
				? reconcileFn({
						operationId: record.operationId,
						attempt: record.attempt,
						resumed: true,
					})
				: observe(undefined, {
						operationId: record.operationId,
						attempt: record.attempt,
						resumed: true,
					}),
		);
		const reconciled = Object.freeze({
			...record,
			state: observed.status === "confirmed" ? "completed" : "uncertain",
			outcome: observed.status === "confirmed" ? "confirmed" : "ambiguous",
			reconciled: true,
			recordedAt: clock(),
		});
		persist?.(reconciled);
		return reconciled;
	}
	persist?.(record);
	emit(onStatus, "mutation_intent_durable", record.operationId);
	let lastCommandResult;
	for (
		let attempt = Math.max(1, record.attempt + 1);
		attempt <= normalizedPolicy.maxAttempts;
		attempt += 1
	) {
		record = { ...record, state: "commanded", attempt, recordedAt: clock() };
		persist?.(record);
		emit(onStatus, "mutation_command_started", record.operationId, { attempt });
		let commandResult;
		let commandError = null;
		lastCommandResult = undefined;
		const started = Date.now();
		try {
			commandResult = command({ operationId: record.operationId, attempt });
			lastCommandResult = commandResult;
		} catch (error) {
			commandError = error;
		}
		const timedOut = Date.now() - started > normalizedPolicy.commandTimeoutMs;
		const observed = normalizeObservation(
			observe(commandResult, {
				operationId: record.operationId,
				attempt,
				commandError,
				timedOut,
			}),
		);
		record = {
			...record,
			state:
				observed.status === "confirmed"
					? "observed"
					: observed.status === "failed"
						? "failed"
						: "uncertain",
			outcome:
				observed.status === "confirmed"
					? "confirmed"
					: observed.status === "failed"
						? "failed"
						: timedOut
							? "timed_out"
							: "ambiguous",
			recordedAt: clock(),
			...(observed.code ? { code: observed.code } : {}),
		};
		persist?.(record);
		emit(
			onStatus,
			observed.status === "confirmed"
				? "mutation_postcondition_observed"
				: "mutation_postcondition_uncertain",
			record.operationId,
			{ attempt, status: observed.status },
		);
		if (observed.status === "confirmed") {
			const completed = Object.freeze({
				...record,
				state: "completed",
				recordedAt: clock(),
			});
			persist?.(completed);
			emit(onStatus, "mutation_completed", completed.operationId, { attempt });
			return Object.freeze({ ...completed, commandResult });
		}
		if (
			observed.ownership !== "confirmed" ||
			normalizedPolicy.idempotency === "unknown" ||
			attempt >= normalizedPolicy.maxAttempts ||
			!normalizedPolicy.retryOn.includes(record.outcome)
		)
			break;
		sleepFn(mutationBackoffDelay(attempt, normalizedPolicy));
	}
	const final = Object.freeze({
		...record,
		state: record.outcome === "failed" ? "failed" : "uncertain",
		commandResult: lastCommandResult,
		recordedAt: clock(),
	});
	const durableFinal = Object.fromEntries(
		Object.entries(final).filter(([key]) => key !== "commandResult"),
	);
	persist?.(durableFinal);
	emit(
		onStatus,
		final.state === "uncertain" ? "mutation_uncertain" : "mutation_failed",
		final.operationId,
		{ attempt: final.attempt },
	);
	return final;
}
