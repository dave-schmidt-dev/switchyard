import { strictEqual } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	after,
	afterEach,
	before,
	beforeEach,
	describe,
	it,
	mock,
} from "node:test";
import { createProviderReliabilityDiagnostic } from "../src/switchyard/diagnostics/provider-reliability.mjs";
import {
	attestRouteRepair,
	ingestRouteHealthEvents,
	inspectRouteHealth,
} from "../src/switchyard/router/health.mjs";
import {
	LIVE_CLAIM_MS,
	STRANDED_CLAIM_MS,
} from "../src/switchyard/router/health-inspect.mjs";
import { updateScope } from "../src/switchyard/router/health-lock.mjs";
import {
	COOLDOWN_MS,
	hash,
	identityFrom,
	locations,
	MAX_ATTEMPTS,
	scopeKey,
	TRANSIENT_CODES,
} from "../src/switchyard/router/health-schema.mjs";
import { createSimpleRouteHealthController } from "../src/switchyard/simple/health.mjs";
import {
	cleanupHealthFixture,
	descriptorFor,
	HEALTH_ROOT,
	healthIdentity,
	initializeHealthRun,
	localLifecycle,
	routeHealthEpoch,
	setupHealthFixture,
	simpleInput,
} from "./provider-reliability-health-fixture.mjs";

const MIN = 60_000;
const SECOND = 1_000;
const HOUR = 60 * MIN;

const OUTCOMES = {
	success: () => ({
		providerResult: { success: true, code: 0, writerLifecycle: "stopped" },
		providerLifecycle: localLifecycle(0),
	}),
	exit: () => ({
		providerResult: { success: false, code: 3, writerLifecycle: "stopped" },
		providerReliability: createProviderReliabilityDiagnostic({
			causeCode: "provider_exit_nonzero",
			phase: "provider",
			exitCode: 3,
		}),
		providerLifecycle: localLifecycle(3),
	}),
	// The writer group could not be proven stopped: the trial cannot resolve.
	unconfirmed: () => ({
		...OUTCOMES.exit(),
		providerResult: { success: false, code: 3, writerLifecycle: "unavailable" },
	}),
};

let base;
let serial = 0;
const clock = (offsetMs) => mock.timers.setTime(base + offsetMs);
const rootFor = (name) => {
	serial += 1;
	return join(HEALTH_ROOT, `recovery-${name}-${serial}`);
};
const codex = () => descriptorFor("codex");
const inspect = (root) =>
	inspectRouteHealth(healthIdentity(root, codex(), routeHealthEpoch()));
const scope = (root) => ({
	healthStateRoot: root,
	targetId: codex().target_id,
	descriptorIdentity: codex().descriptor_identity,
});

function ledger(root) {
	const path = locations(
		root,
		scopeKey(identityFrom(scope(root))),
	).observations;
	if (!existsSync(path)) return { failures: 0, generation: null, seen: 0 };
	const observations = JSON.parse(readFileSync(path, "utf8"));
	const [generation] = Object.values(observations.generations);
	const attempts = generation?.attempts ?? [];
	return {
		failures: attempts.filter(({ code }) => TRANSIENT_CODES.has(code)).length,
		generation,
		seen: observations.seenAttemptIds.length,
	};
}

// Prepare and start an invocation; the caller decides whether it terminates.
async function begin(root, origin = "work") {
	serial += 1;
	const run = await initializeHealthRun(`task-${serial}`);
	const controller = createSimpleRouteHealthController({
		healthStateRoot: root,
		runId: run.runId,
		taskId: run.taskId,
		origin,
	});
	const prepared = await controller.prepare(simpleInput(codex()));
	if (!prepared.allowed) return { run, prepared };
	const started = await controller.start();
	return { run, controller, prepared, started };
}

async function dispatch(root, kind, offsetMs, origin = "work") {
	if (offsetMs !== undefined) clock(offsetMs);
	const begun = await begin(root, origin);
	if (!begun.started?.allowed) return begun;
	const terminal = await begun.controller.terminal(OUTCOMES[kind]());
	return { ...begun, terminal };
}

// Two failures one second apart: cooldown step 1, ending at 1 s + 5 min.
async function coolDown(root) {
	await dispatch(root, "exit", 0);
	await dispatch(root, "exit", SECOND);
	return SECOND + COOLDOWN_MS[0];
}

function rewriteRun(run, fields) {
	const path = join(run.runRoot, "run.json");
	const record = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...record, ...fields }), "utf8");
}

const ENV_KEYS = [
	"SWITCHYARD_ROUTE_HEALTH_MODE",
	"SWITCHYARD_ROUTE_HEALTH_STATE_ROOT",
];
const savedEnv = new Map();
before(() => {
	setupHealthFixture();
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});
after(() => {
	for (const [key, value] of savedEnv)
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	cleanupHealthFixture();
});
beforeEach(() => {
	base = Date.now();
	mock.timers.enable({ apis: ["Date"], now: base });
});
afterEach(() => mock.timers.reset());

describe("simple route-health claim recovery", () => {
	it("reclaims a trial claim once its run is terminal in the run store", async () => {
		const root = rootFor("terminal");
		const expiry = await coolDown(root);
		const stranded = await dispatch(root, "unconfirmed", expiry);
		strictEqual(stranded.started.trial, true);
		strictEqual(stranded.terminal.settled, false);
		strictEqual((await inspect(root)).state, "half-open");
		rewriteRun(stranded.run, { state: "failed", cleanupState: "complete" });
		const state = await inspect(root);
		strictEqual(state.state, "cooldown");
		strictEqual(state.claimStatus, null);
		strictEqual(state.trialAvailable, true);
		const probe = await dispatch(root, "success", expiry + SECOND);
		strictEqual(probe.started.trial, true);
		strictEqual(probe.terminal.settled, true);
		strictEqual((await inspect(root)).state, "healthy");
	});

	it("reclaims a claim stranded by a killed dispatcher after the age bound", async () => {
		const root = rootFor("age");
		const expiry = await coolDown(root);
		clock(expiry);
		// The dispatcher dies after starting the trial: terminal() never runs.
		const killed = await begin(root);
		strictEqual(killed.started.trial, true);
		clock(expiry + STRANDED_CLAIM_MS - SECOND);
		strictEqual((await inspect(root)).state, "half-open");
		strictEqual((await dispatch(root, "success")).prepared.allowed, false);
		clock(expiry + STRANDED_CLAIM_MS);
		strictEqual((await inspect(root)).state, "cooldown");
		const probe = await dispatch(root, "success");
		strictEqual(probe.started.trial, true);
		strictEqual(probe.terminal.settled, true);
		strictEqual((await inspect(root)).state, "healthy");
	});

	it("lets a repair attestation replace a stranded claim", async () => {
		const root = rootFor("attest");
		const expiry = await coolDown(root);
		clock(expiry);
		await begin(root);
		const input = {
			...healthIdentity(root, codex(), routeHealthEpoch()),
			repairKind: "configuration_repaired",
		};
		strictEqual((await attestRouteRepair(input)).reason, "claim-active");
		clock(expiry + STRANDED_CLAIM_MS);
		const attested = await attestRouteRepair(input);
		strictEqual(attested.repairEpoch, 1);
		strictEqual((await inspect(root)).claimStatus, null);
	});

	it("keeps a live worker's claim until the long-task bound", async () => {
		const root = rootFor("live");
		const expiry = await coolDown(root);
		clock(expiry);
		const running = await begin(root);
		rewriteRun(running.run, { workerPid: process.pid });
		clock(expiry + STRANDED_CLAIM_MS);
		strictEqual((await inspect(root)).state, "half-open");
		clock(expiry + LIVE_CLAIM_MS);
		strictEqual((await inspect(root)).state, "cooldown");
	});

	it("lets a trial record its result when a never-successful ledger is full", async () => {
		const root = rootFor("capacity");
		await dispatch(root, "exit", 0);
		// Preload re-probe failures two hours apart, all before the first one,
		// so replaying the ledger puts the target on the top ladder step.
		await updateScope(scope(root), async ({ observations }) => {
			const [generation] = Object.values(observations.generations);
			const template = generation.attempts[0];
			for (let index = 1; index < MAX_ATTEMPTS - 1; index += 1) {
				const id = hash(`preload-${index}`);
				generation.attempts.push({
					...template,
					id,
					attempt: `preload-${index}`,
					incidentId: id,
					at: template.at - index * 2 * HOUR,
					sequence: index,
				});
				observations.seenAttemptIds.push(id);
			}
		});
		await dispatch(root, "exit", SECOND);
		const full = ledger(root);
		strictEqual(full.seen, MAX_ATTEMPTS);
		strictEqual(full.generation.cooldownStep, 3);
		const until = full.generation.cooldownUntil - base;
		const trial = await dispatch(root, "exit", until);
		strictEqual(trial.started.trial, true);
		strictEqual(trial.terminal.settled, true);
		const state = await inspect(root);
		strictEqual(state.state, "cooldown");
		strictEqual(state.claimStatus, null);
		const evicted = ledger(root);
		strictEqual(evicted.seen <= MAX_ATTEMPTS / 2, true);
		strictEqual(evicted.generation.cooldownStep, 3);
		strictEqual(
			evicted.generation.cooldownUntil,
			base + until + COOLDOWN_MS[2],
		);
	});

	it("steps the ladder once for concurrent failures and again only on a failed re-probe", async () => {
		const root = rootFor("concurrent");
		const inFlight = [];
		for (let index = 0; index < 4; index += 1) {
			const begun = await begin(root);
			strictEqual(begun.started.allowed, true);
			strictEqual(begun.started.trial, false);
			inFlight.push(begun);
		}
		for (const [index, begun] of inFlight.entries()) {
			clock(index * SECOND);
			await begun.controller.terminal(OUTCOMES.exit());
		}
		let { generation, failures } = ledger(root);
		strictEqual(failures, 4);
		strictEqual(generation.cooldownStep, 1);
		strictEqual(generation.cooldownUntil, base + SECOND + COOLDOWN_MS[0]);
		const probeAt = SECOND + COOLDOWN_MS[0];
		const probe = await dispatch(root, "exit", probeAt);
		strictEqual(probe.started.trial, true);
		({ generation } = ledger(root));
		strictEqual(generation.cooldownStep, 2);
		strictEqual(generation.cooldownUntil, base + probeAt + COOLDOWN_MS[1]);
	});

	it("ignores a failure replayed after compaction forgot it behind a success", async () => {
		const root = rootFor("barrier");
		const failed = await dispatch(root, "exit", 0);
		await dispatch(root, "success", SECOND);
		await updateScope(scope(root), async ({ observations }) => {
			const [generation] = Object.values(observations.generations);
			const template = generation.attempts.find(
				(attempt) => !TRANSIENT_CODES.has(attempt.code),
			);
			for (
				let index = 1;
				observations.seenAttemptIds.length < MAX_ATTEMPTS / 2;
				index += 1
			) {
				const id = hash(`success-${index}`);
				generation.attempts.push({
					...template,
					id,
					attempt: `success-${index}`,
					incidentId: id,
					at: template.at - SECOND - index,
					sequence: index,
				});
				observations.seenAttemptIds.push(id);
			}
		});
		// This record compacts: the first failure's id is forgotten.
		await dispatch(root, "success", 2 * SECOND);
		strictEqual(ledger(root).failures, 0);
		const seen = ledger(root).seen;
		const [replayed] = await ingestRouteHealthEvents({
			authorisedRuns: [
				{ runId: failed.run.runId, runRoot: failed.run.runRoot },
			],
			healthStateRoot: root,
		});
		strictEqual(replayed.accepted, false);
		strictEqual(replayed.reason, "superseded-by-success");
		strictEqual(ledger(root).failures, 0);
		strictEqual(ledger(root).seen, seen);
		strictEqual((await inspect(root)).state, "healthy");
	});
});

describe("qualification route-health isolation", () => {
	it("failed qualification creates no work health observation", async () => {
		const root = rootFor("qual-fail");
		await dispatch(root, "success", 0, "work");
		strictEqual(ledger(root).failures, 0);
		strictEqual((await inspect(root)).state, "healthy");

		const failed = await dispatch(root, "exit", SECOND, "qualification");
		strictEqual(failed.prepared.allowed, true);
		strictEqual(failed.started.allowed, true);
		strictEqual(failed.terminal.settled, true);
		strictEqual(ledger(root).failures, 0);
		strictEqual((await inspect(root)).state, "healthy");
	});

	it("successful qualification is not mistaken for a successful work sample", async () => {
		const root = rootFor("qual-success");
		await coolDown(root);
		strictEqual((await inspect(root)).state, "cooldown");
		const qual = await dispatch(root, "success", 2 * SECOND, "qualification");
		strictEqual(qual.prepared.allowed, true);
		strictEqual(qual.started.allowed, true);
		strictEqual(qual.terminal.settled, true);
		strictEqual((await inspect(root)).state, "cooldown");
	});

	it("qualification is exempt from suppression during cooldown", async () => {
		const root = rootFor("qual-cooldown");
		await coolDown(root);
		strictEqual((await inspect(root)).state, "cooldown");
		const work = await begin(root, "work");
		strictEqual(work.prepared.allowed, false);
		const qual = await begin(root, "qualification");
		strictEqual(qual.prepared.allowed, true);
		strictEqual(qual.started.allowed, true);
	});

	it("active writer fences reject unconfirmed qualification terminal", async () => {
		const root = rootFor("qual-writer-fence");
		const qual = await begin(root, "qualification");
		strictEqual(qual.prepared.allowed, true);
		strictEqual(qual.started.allowed, true);
		const unconfirmed = await qual.controller.terminal({
			providerResult: {
				success: true,
				code: 0,
				writerLifecycle: "unavailable",
			},
			providerLifecycle: localLifecycle(0),
		});
		strictEqual(unconfirmed.reason, "provider-terminal-unverified");
		strictEqual(unconfirmed.binding, null);
		const refused = await qual.controller.prepare(simpleInput(codex()));
		strictEqual(refused.allowed, false);
		strictEqual(refused.reason, "provider-invocation-unsettled");
	});
});
