import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	openRoutingRun,
	readRoutingRunState,
	recordAttemptOutcome,
	releasePartialAttempt,
} from "../src/switchyard/simple/routing-state.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const fixture = () => ({
	project: realpathSync(tempDir("release-transition-project-")),
	stateRoot: realpathSync(tempDir("release-transition-state-")),
});
const allocation = (attemptId, taskId) => ({
	attemptId,
	taskId,
	runId: `simple-${taskId}`,
	targetId: "codex",
	capability: "standard",
	startedAt: new Date().toISOString(),
});
const closed = (pending, partialWorktree) => ({
	...pending,
	terminal: "failed",
	reason: "execution_failed",
	closedAt: new Date().toISOString(),
	partialWorktree,
});
// One run holding two recorded partials: the guard must accept clearing
// either one alone and nothing else.
function recordedPartials(project, stateRoot) {
	const handle = openRoutingRun(project, "run-1", { stateRoot });
	const first = allocation("attempt-1", "task-1");
	const second = allocation("attempt-2", "task-2");
	handle.commit({ pendingAttempt: first });
	recordAttemptOutcome(
		handle.state,
		handle.commit,
		closed(first, join(project, "partial-1")),
	);
	handle.commit({ pendingAttempt: second });
	recordAttemptOutcome(
		handle.state,
		handle.commit,
		closed(second, join(project, "partial-2")),
	);
	return handle;
}
const releaseCommit = (handle, attemptId, mutate) =>
	handle.commit(
		{
			attempts: handle.state.attempts.map((item) =>
				item.attemptId === attemptId
					? { ...item, partialWorktree: null, ...mutate }
					: item,
			),
		},
		{ transition: "release_partial", attemptId },
	);

test("release_partial clears exactly the named attempt's recorded partialWorktree", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	const before = handle.state.attempts.map((attempt) => ({ ...attempt }));
	releasePartialAttempt(handle.state, handle.commit, "attempt-1");
	deepStrictEqual(handle.state.attempts[0], {
		...before[0],
		partialWorktree: null,
	});
	deepStrictEqual(handle.state.attempts[1], before[1]);
	handle.release();
	const reloaded = readRoutingRunState(project, "run-1", { stateRoot });
	strictEqual(reloaded.attempts[0].partialWorktree, null);
	strictEqual(reloaded.attempts[1].partialWorktree, join(project, "partial-2"));
	deepStrictEqual(reloaded.failedTargetIds, ["codex"]);
});

test("a release commit that also changes any other attempt field is rejected", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	const before = handle.state.attempts.map((attempt) => ({ ...attempt }));
	for (const mutate of [
		{ reason: "check_failed" },
		{ terminal: "skipped" },
		{ closedAt: new Date().toISOString() },
		{ targetId: "vibe" },
		{ partialWorktree: join(project, "moved") },
	]) {
		// Validation runs before the monotonic check, so a mutation that also
		// breaks state consistency is rejected as malformed instead.
		throws(
			() => releaseCommit(handle, "attempt-1", mutate),
			(error) =>
				["routing_state_nonmonotonic", "routing_state_malformed"].includes(
					error.code,
				),
		);
	}
	deepStrictEqual(handle.state.attempts, before);
	handle.release();
	deepStrictEqual(
		readRoutingRunState(project, "run-1", { stateRoot }).attempts,
		before,
	);
});

test("a release commit that also touches a sibling attempt is rejected", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	const before = handle.state.attempts.map((attempt) => ({ ...attempt }));
	throws(
		() =>
			handle.commit(
				{
					attempts: handle.state.attempts.map((attempt) => ({
						...attempt,
						partialWorktree: null,
					})),
				},
				{ transition: "release_partial", attemptId: "attempt-1" },
			),
		{ code: "routing_state_nonmonotonic" },
	);
	throws(
		() =>
			handle.commit(
				{
					attempts: handle.state.attempts.map((attempt) =>
						attempt.attemptId === "attempt-2"
							? { ...attempt, reason: "check_failed" }
							: attempt.attemptId === "attempt-1"
								? { ...attempt, partialWorktree: null }
								: attempt,
					),
				},
				{ transition: "release_partial", attemptId: "attempt-1" },
			),
		{ code: "routing_state_nonmonotonic" },
	);
	deepStrictEqual(handle.state.attempts, before);
	handle.release();
});

test("a release commit naming another attempt, changing nothing or adding attempts is rejected", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	const before = handle.state.attempts.map((attempt) => ({ ...attempt }));
	throws(
		() =>
			handle.commit(
				{
					attempts: handle.state.attempts.map((attempt) =>
						attempt.attemptId === "attempt-1"
							? { ...attempt, partialWorktree: null }
							: attempt,
					),
				},
				{ transition: "release_partial", attemptId: "attempt-2" },
			),
		{ code: "routing_state_nonmonotonic" },
	);
	throws(
		() =>
			handle.commit(
				{ attempts: handle.state.attempts.map((attempt) => ({ ...attempt })) },
				{ transition: "release_partial", attemptId: "attempt-1" },
			),
		{ code: "routing_state_nonmonotonic" },
	);
	throws(
		() =>
			handle.commit(
				{
					attempts: [
						...handle.state.attempts.map((attempt) =>
							attempt.attemptId === "attempt-1"
								? { ...attempt, partialWorktree: null }
								: attempt,
						),
						closed(allocation("attempt-3", "task-3"), null),
					],
				},
				{ transition: "release_partial", attemptId: "attempt-1" },
			),
		{ code: "routing_state_nonmonotonic" },
	);
	deepStrictEqual(handle.state.attempts, before);
	handle.release();
});

test("a partial cannot be cleared without the explicit release_partial transition", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	const before = handle.state.attempts.map((attempt) => ({ ...attempt }));
	throws(
		() =>
			handle.commit({
				attempts: handle.state.attempts.map((attempt) =>
					attempt.attemptId === "attempt-1"
						? { ...attempt, partialWorktree: null }
						: attempt,
				),
			}),
		{ code: "routing_state_nonmonotonic" },
	);
	deepStrictEqual(handle.state.attempts, before);
	handle.release();
});

test("releasePartialAttempt requires a recorded partial for the named attempt", () => {
	const { project, stateRoot } = fixture();
	const handle = recordedPartials(project, stateRoot);
	releasePartialAttempt(handle.state, handle.commit, "attempt-1");
	throws(
		() => releasePartialAttempt(handle.state, handle.commit, "attempt-1"),
		{
			code: "partial_worktree_not_recorded",
		},
	);
	throws(() => releasePartialAttempt(handle.state, handle.commit, "missing"), {
		code: "partial_worktree_not_recorded",
	});
	handle.release();
});
