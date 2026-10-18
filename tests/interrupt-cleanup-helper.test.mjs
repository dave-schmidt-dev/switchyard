import { ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { HANG_GUARD_MS } from "./helpers/hang-guard.mjs";
import { tempDir } from "./helpers/tempdir.mjs";

const HELPER_URL = pathToFileURL(
	join(import.meta.dirname, "helpers", "interrupt-cleanup.mjs"),
).href;

function childSource(
	markerPath,
	{ dispose, throwing = false, repeated = false },
) {
	const pause = repeated
		? 'writeSync(1, "cleaning\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);'
		: "";
	const registration = `runOnInterrupt(() => { ${pause} writeFileSync(${JSON.stringify(markerPath)}, "cleaned"); ${throwing ? 'throw new Error("cleanup failed");' : ""} });`;
	const lines = [
		`import { writeFileSync, writeSync } from "node:fs";`,
		`import { runOnInterrupt } from ${JSON.stringify(HELPER_URL)};`,
	];
	if (dispose) {
		lines.push(`const dispose = ${registration}`, "dispose();");
	} else {
		lines.push(registration);
	}
	lines.push(`process.stdout.write("ready\\n");`);
	lines.push("setInterval(() => {}, 1000);");
	return lines.join("\n");
}

function waitForExit(child) {
	return new Promise((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}

function waitForReady(child, marker = "ready\n") {
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		child.stdout.setEncoding("utf8");
		const onData = (chunk) => {
			output += chunk;
			if (!output.includes(marker)) return;
			child.stdout.off("data", onData);
			resolveReady();
		};
		child.stdout.on("data", onData);
		child.once("error", rejectReady);
		child.once("exit", (code, signal) => {
			rejectReady(
				new Error(
					`child exited before printing ready: code=${code} signal=${signal}`,
				),
			);
		});
	});
}

async function runSignalScenario({
	dispose,
	throwing = false,
	repeated = false,
	interrupt = "SIGTERM",
}) {
	const directory = tempDir("switchyard-interrupt-cleanup-");
	const markerPath = join(directory, "cleanup-marker");
	const code = childSource(markerPath, { dispose, throwing, repeated });
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	// A node:test timeout does not unwind a suspended readiness await.
	const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
	try {
		await waitForReady(child);
		child.kill(interrupt);
		if (repeated) {
			await waitForReady(child, "cleaning\n");
			child.kill("SIGHUP");
		}
		const { signal } = await waitForExit(child);
		return { signal, markerExists: existsSync(markerPath) };
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null && child.signalCode === null) {
			const exited = waitForExit(child);
			child.kill("SIGKILL");
			await exited;
		}
	}
}

for (const interrupt of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	it(`runs cleanup then dies by ${interrupt}`, {
		timeout: HANG_GUARD_MS,
	}, async () => {
		const result = await runSignalScenario({ dispose: false, interrupt });
		strictEqual(result.signal, interrupt);
		ok(result.markerExists, "cleanup marker must exist");
	});
}

it("cleanup throwing still dies by the signal", {
	timeout: HANG_GUARD_MS,
}, async () => {
	const result = await runSignalScenario({ dispose: false, throwing: true });
	strictEqual(result.signal, "SIGTERM");
	ok(result.markerExists, "cleanup must run before throwing");
});

it("a second signal cannot interrupt synchronous cleanup", {
	timeout: HANG_GUARD_MS,
}, async () => {
	const result = await runSignalScenario({ dispose: false, repeated: true });
	strictEqual(result.signal, "SIGTERM");
	ok(result.markerExists, "cleanup must finish despite the second signal");
});

it("dispose skips cleanup", { timeout: HANG_GUARD_MS }, async () => {
	const result = await runSignalScenario({ dispose: true });
	strictEqual(result.signal, "SIGTERM");
	ok(!result.markerExists, "cleanup marker must not exist");
});
