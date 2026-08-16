const BROKER_SCHEMA_VERSION = 1;

const CAPABILITIES = new Set(["low", "standard", "high"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const REQUEST_FIELDS = new Set([
	"schemaVersion",
	"capability",
	"dataClass",
	"estimatedConsumption",
	"runId",
	"taskId",
	"snapshotSource",
	"availableAdapters",
]);
const RESULT_FIELDS = new Set([
	"schemaVersion",
	"runId",
	"taskId",
	"capability",
	"provider",
	"resolvedTarget",
	"harness",
	"model",
	"effort",
	"snapshotIdentity",
	"reservation",
	"reason",
]);

export const BROKER_CONTRACT_VERSION = BROKER_SCHEMA_VERSION;
const BROKER_DATA_CLASS = Object.freeze({
	repository: "repository",
	restricted: "restricted",
	unknown: "unknown",
});

function requireRecord(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
}

function rejectUnknownFields(value, allowed, label) {
	for (const field of Object.keys(value)) {
		if (!allowed.has(field)) {
			throw new TypeError(`${label} has unknown field '${field}'`);
		}
	}
}

function requireIdentifier(value, label) {
	if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
		throw new TypeError(`${label} must be a non-empty safe identifier`);
	}
	return value;
}

function nullableIdentifier(value, label) {
	return value === null ? null : requireIdentifier(value, label);
}

function requireSafeText(value, label) {
	const hasControlCharacter =
		typeof value === "string" &&
		[...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint <= 31 || codePoint === 127;
		});
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 1024 ||
		hasControlCharacter
	) {
		throw new TypeError(`${label} must be non-empty bounded text`);
	}
	return value;
}

function requireNullableString(value, label) {
	return value === null ? null : requireSafeText(value, label);
}

/** Validate and normalize a broker selection request. */
export function validateBrokerRequest(value) {
	requireRecord(value, "broker request");
	rejectUnknownFields(value, REQUEST_FIELDS, "broker request");
	if (value.schemaVersion !== BROKER_SCHEMA_VERSION) {
		throw new TypeError(
			`broker request.schemaVersion must be ${BROKER_SCHEMA_VERSION}`,
		);
	}
	if (!CAPABILITIES.has(value.capability)) {
		throw new TypeError(
			"broker request.capability must be low, standard, or high",
		);
	}
	if (value.dataClass !== BROKER_DATA_CLASS.repository) {
		if (
			value.dataClass === BROKER_DATA_CLASS.restricted ||
			value.dataClass === BROKER_DATA_CLASS.unknown
		) {
			throw new TypeError(
				`broker request.dataClass '${value.dataClass}' is not eligible for automatic cross-provider routing`,
			);
		}
		throw new TypeError(
			"broker request.dataClass must be the single classification 'repository'",
		);
	}
	if (
		typeof value.estimatedConsumption !== "number" ||
		!Number.isFinite(value.estimatedConsumption) ||
		value.estimatedConsumption <= 0
	) {
		throw new TypeError(
			"broker request.estimatedConsumption must be a positive finite number",
		);
	}
	const runId = requireIdentifier(value.runId, "broker request.runId");
	const taskId = requireIdentifier(value.taskId, "broker request.taskId");
	const snapshotSource = requireSafeText(
		value.snapshotSource,
		"broker request.snapshotSource",
	);
	if (
		!Array.isArray(value.availableAdapters) ||
		value.availableAdapters.length === 0
	) {
		throw new TypeError(
			"broker request.availableAdapters must be a non-empty array",
		);
	}
	const availableAdapters = value.availableAdapters.map((adapter, index) =>
		requireIdentifier(adapter, `broker request.availableAdapters[${index}]`),
	);
	if (new Set(availableAdapters).size !== availableAdapters.length) {
		throw new TypeError(
			"broker request.availableAdapters must not contain duplicates",
		);
	}
	return Object.freeze({
		schemaVersion: BROKER_SCHEMA_VERSION,
		capability: value.capability,
		dataClass: value.dataClass,
		estimatedConsumption: value.estimatedConsumption,
		runId,
		taskId,
		snapshotSource,
		availableAdapters: Object.freeze([...availableAdapters]),
	});
}

function validateSnapshotIdentity(value) {
	requireRecord(value, "broker result.snapshotIdentity");
	const allowed = new Set(["source", "status", "mtime", "ageMs"]);
	rejectUnknownFields(value, allowed, "broker result.snapshotIdentity");
	const source = requireSafeText(
		value.source,
		"broker result.snapshotIdentity.source",
	);
	const status = requireIdentifier(
		value.status,
		"broker result.snapshotIdentity.status",
	);
	for (const field of ["mtime", "ageMs"]) {
		if (
			value[field] !== null &&
			(typeof value[field] !== "number" || !Number.isFinite(value[field]))
		) {
			throw new TypeError(
				`broker result.snapshotIdentity.${field} must be null or finite`,
			);
		}
	}
	return Object.freeze({
		source,
		status,
		mtime: value.mtime,
		ageMs: value.ageMs,
	});
}

function validateReservation(value) {
	if (value === null) return null;
	requireRecord(value, "broker result.reservation");
	const allowed = new Set(["id", "provider", "runId", "taskId", "amount"]);
	rejectUnknownFields(value, allowed, "broker result.reservation");
	const amount = value.amount;
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
		throw new TypeError(
			"broker result.reservation.amount must be a positive finite number",
		);
	}
	return Object.freeze({
		id: requireIdentifier(value.id, "broker result.reservation.id"),
		provider: requireSafeText(
			value.provider,
			"broker result.reservation.provider",
		),
		runId: requireIdentifier(value.runId, "broker result.reservation.runId"),
		taskId: requireIdentifier(value.taskId, "broker result.reservation.taskId"),
		amount,
	});
}

/** Validate and normalize the broker's stable result envelope. */
export function validateBrokerResult(value) {
	requireRecord(value, "broker result");
	rejectUnknownFields(value, RESULT_FIELDS, "broker result");
	if (value.schemaVersion !== BROKER_SCHEMA_VERSION) {
		throw new TypeError(
			`broker result.schemaVersion must be ${BROKER_SCHEMA_VERSION}`,
		);
	}
	if (!CAPABILITIES.has(value.capability)) {
		throw new TypeError("broker result.capability is invalid");
	}
	const provider = requireNullableString(
		value.provider,
		"broker result.provider",
	);
	const resolvedTarget = nullableIdentifier(
		value.resolvedTarget,
		"broker result.resolvedTarget",
	);
	const harness = nullableIdentifier(value.harness, "broker result.harness");
	const model = requireNullableString(value.model, "broker result.model");
	const effort = requireNullableString(value.effort, "broker result.effort");
	const routed = provider !== null;
	if (
		[routed, resolvedTarget !== null, harness !== null, model !== null].some(
			(present) => present !== routed,
		)
	) {
		throw new TypeError(
			"broker result route identity fields must be either all bound or all null",
		);
	}
	const reservation = validateReservation(value.reservation);
	if (reservation && (!routed || reservation.provider !== provider)) {
		throw new TypeError(
			"broker result reservation does not match the routed provider",
		);
	}
	return Object.freeze({
		schemaVersion: BROKER_SCHEMA_VERSION,
		runId: requireIdentifier(value.runId, "broker result.runId"),
		taskId: requireIdentifier(value.taskId, "broker result.taskId"),
		capability: value.capability,
		provider,
		resolvedTarget,
		harness,
		model,
		effort,
		snapshotIdentity: validateSnapshotIdentity(value.snapshotIdentity),
		reservation,
		reason: requireSafeText(value.reason, "broker result.reason"),
	});
}
