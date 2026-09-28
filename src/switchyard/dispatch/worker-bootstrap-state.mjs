import {
	createWriteChain,
	FATAL_PERSISTENCE_DIAGNOSTIC,
} from "./worker-bootstrap-support.mjs";

let writeFailureCount = 0;
let lastWriteFailure = null;
const shutdown = new AbortController();
let shutdownSignal = null;
let fatalPersistenceDiagnosticEmitted = false;
function emitFatalPersistenceDiagnostic() {
	if (fatalPersistenceDiagnosticEmitted) return;
	fatalPersistenceDiagnosticEmitted = true;
	console.error(FATAL_PERSISTENCE_DIAGNOSTIC);
}
function requestGracefulShutdown(signal) {
	if (shutdownSignal) return;
	shutdownSignal = signal;
	shutdown.abort();
	console.error(
		`worker-bootstrap: received ${signal}; finishing durable cleanup`,
	);
}
function safeWriteFailure(error) {
	writeFailureCount += 1;
	// Keep diagnostics categorical and scalar; Error.message can contain host
	// paths or provider-generated text and must not cross the telemetry boundary.
	const categories = {
		RevisionError: "revision_conflict",
		SchemaError: "schema_invalid",
		LockError: "lock_error",
		TypeError: "type_error",
		Error: "write_failed",
	};
	const name = typeof error?.name === "string" ? error.name : "";
	lastWriteFailure = Object.hasOwn(categories, name)
		? categories[name]
		: "write_failed";
	console.error("worker-bootstrap: run-store write failed");
}
const { queueWrite, drain: drainWriteChain } = createWriteChain({
	onFailure: safeWriteFailure,
});

export {
	drainWriteChain,
	emitFatalPersistenceDiagnostic,
	lastWriteFailure,
	queueWrite,
	requestGracefulShutdown,
	shutdown,
	writeFailureCount,
};

export function createWorkerBootstrapIdentityState() {
	let stateRoot = null;
	let runId = null;
	let nonce = null;
	let queueCleanupErrorType = null;
	let fatalFinalizationPromise = null;

	return {
		setIdentity(next) {
			stateRoot = next.stateRoot;
			runId = next.runId;
			nonce = next.nonce;
		},
		get stateRoot() {
			return stateRoot;
		},
		get runId() {
			return runId;
		},
		get nonce() {
			return nonce;
		},
		setQueueCleanupErrorType(next) {
			queueCleanupErrorType = next;
		},
		get queueCleanupErrorType() {
			return queueCleanupErrorType;
		},
		setFatalFinalizationPromise(next) {
			fatalFinalizationPromise = next;
		},
		get fatalFinalizationPromise() {
			return fatalFinalizationPromise;
		},
	};
}
