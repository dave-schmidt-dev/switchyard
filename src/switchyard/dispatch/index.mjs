// Thin dispatch CLI over runQueue: farm a task queue across the funded
// providers instead of running every task on one. Host-side routing picks a
// provider by usage headroom (INV-4/5); each task then runs headless inside a
// disposable per-provider working container seeded from the project (INV-1),
// and its result returns to the host only through the reviewed integration
// gate (INV-2). The working container is wiped at the end (INV-3).
//
// This is also the executable SWITCHYARD_ORCHESTRATOR_CMD-style entry the
// :implement loop can point at; standalone it dispatches a queue against a
// project.
//
// Usage:
//   node src/switchyard/dispatch/index.mjs <tasks.md> --project <path> [options]
//   npm run dispatch -- <tasks.md> --project <path> [options]
//
// Options:
//   --project <path>       Host git repo to dispatch against (required). Its
//                          committed HEAD seeds each working container, and
//                          reviewed diffs land back on it.
//   --max-tasks <n>        Cap how many tasks are processed this run.
//   --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json).
//   --no-stop-on-failure   Keep going after a task fails (default: stop).
//   --help                 Show this help.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runQueue } from "../runner/index.mjs";

const USAGE = `Usage: dispatch <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --help                 Show this help`;

// Distinguishes a bad-invocation error (print usage, exit 2) from a real
// run-time failure (exit 1), mirroring conventional CLI exit-code semantics.
class UsageError extends Error {}

/**
 * Validate CLI arguments into a runQueue options object.
 * @param {string[]} argv process.argv.slice(2)
 * @throws {UsageError} on any invalid/missing argument
 */
function parseDispatchArgs(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				"max-tasks": { type: "string" },
				checkpoint: { type: "string" },
				"no-stop-on-failure": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error.message);
	}

	const { values, positionals } = parsed;
	if (values.help) {
		return { help: true };
	}

	const tasksFilePath = positionals[0];
	if (!tasksFilePath) {
		throw new UsageError("missing <tasks.md> positional argument");
	}
	if (positionals.length > 1) {
		throw new UsageError(
			`unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
		);
	}
	if (!values.project) {
		throw new UsageError("--project <path> is required");
	}

	const resolvedTasks = resolve(tasksFilePath);
	if (!existsSync(resolvedTasks) || !statSync(resolvedTasks).isFile()) {
		throw new UsageError(`tasks file not found: ${resolvedTasks}`);
	}

	const projectPath = resolve(values.project);
	if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
		throw new UsageError(`--project is not a directory: ${projectPath}`);
	}
	// seedProject archives the project's committed HEAD into each working
	// container, so a non-repo project can't be dispatched against.
	if (!existsSync(join(projectPath, ".git"))) {
		throw new UsageError(`--project is not a git repository: ${projectPath}`);
	}

	let maxTasks = Number.POSITIVE_INFINITY;
	if (values["max-tasks"] !== undefined) {
		maxTasks = Number.parseInt(values["max-tasks"], 10);
		if (!Number.isInteger(maxTasks) || maxTasks < 1) {
			throw new UsageError(
				`--max-tasks must be a positive integer, got "${values["max-tasks"]}"`,
			);
		}
	}

	return {
		help: false,
		tasksFilePath: resolvedTasks,
		projectPath,
		maxTasks,
		checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined,
		stopOnFailure: !values["no-stop-on-failure"],
	};
}

/**
 * Run the dispatch, printing live per-task progress (INV-1: no silent waits).
 * Sets process.exitCode: 1 if any processed task failed, else 0.
 * @param {object} opts Result of parseDispatchArgs (help:false variant)
 */
function dispatch(opts) {
	console.log(`dispatch: queue    ${opts.tasksFilePath}`);
	console.log(`dispatch: project  ${opts.projectPath}`);
	console.log(
		"dispatch: routing host-side by usage headroom; each task runs headless in a disposable per-provider container.",
	);
	console.log(
		"dispatch: expect several minutes per task while the provider CLI runs.",
	);

	const result = runQueue({
		tasksFilePath: opts.tasksFilePath,
		projectPath: opts.projectPath,
		maxTasks: opts.maxTasks,
		...(opts.checkpointPath ? { checkpointPath: opts.checkpointPath } : {}),
		stopOnFailure: opts.stopOnFailure,
		dependencies: {
			onTaskStart: (task) =>
				console.log(
					`dispatch: -> task ${task.id} ${task.title ?? ""}`.trimEnd(),
				),
			onResult: (r) => {
				const where = `${r.provider ?? "no-provider"}${r.model ? `/${r.model}` : ""}`;
				console.log(
					`dispatch: ${r.success ? "ok  " : "FAIL"} task ${r.taskId} [${where}] ${r.result}`,
				);
			},
		},
	});

	const failed = result.results.filter((r) => !r.success);
	console.log(
		`dispatch: done — ${result.processedTasks}/${result.runnableTasks} runnable processed, ` +
			`${result.completedTaskIds.length} completed, ${failed.length} failed`,
	);
	console.log(`dispatch: checkpoint ${result.checkpointPath}`);
	process.exitCode = failed.length > 0 ? 1 : 0;
}

function main(argv) {
	const opts = parseDispatchArgs(argv);
	if (opts.help) {
		console.log(USAGE);
		return;
	}
	dispatch(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`dispatch: ${error.message}\n`);
			console.error(USAGE);
			process.exitCode = 2;
		} else {
			console.error(`dispatch: run aborted: ${error.message}`);
			process.exitCode = 1;
		}
	}
}

export { parseDispatchArgs };
