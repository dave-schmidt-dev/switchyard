import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	classifyPreProviderFailure,
	sanitizeFailureMetadata,
} from "../src/switchyard/adapter/exec-error.mjs";
import {
	acquireVmSlot,
	getStateRoot,
	getVmAdmissionRoot,
	releaseVmSlot,
	runStoreTesting,
	sanitizeVmAdmissionError,
	VmAdmissionPermissionDeniedError,
	VmAdmissionStorageError,
	VmAdmissionUnavailableError,
	VmSlotUnavailableError,
} from "../src/switchyard/run-store/index.mjs";
import {
	RUN_STORE_MODULE_URL,
	TEST_ROOT,
	VM_ADMISSION_ROOT,
} from "./helpers/run-store-fixtures.mjs";
import { sourceText } from "./helpers/source-text.mjs";

process.env.SWITCHYARD_RUN_STORE_ROOT = join(TEST_ROOT, "store");
process.env.SWITCHYARD_VM_ADMISSION_ROOT = VM_ADMISSION_ROOT;
process.env.SWITCHYARD_ROSTER_PATH = resolve(
	"tests/fixtures/roster.fixture.json",
);
after(() => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
afterEach(() => {
	try {
		rmSync(join(TEST_ROOT, "store"), { recursive: true, force: true });
		rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
	} catch {
		// no-op
	}
});
function spawnSlotChild(source) {
	return spawn(process.execPath, ["--input-type=module", "-e", source], {
		env: { ...process.env, SWITCHYARD_VM_ADMISSION_ROOT: VM_ADMISSION_ROOT },
		stdio: ["pipe", "pipe", "pipe"],
	});
}
function readChildLine(child) {
	return new Promise((resolveLine, reject) => {
		let output = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out waiting for child output: ${output}`));
		}, 5_000);
		child.stdout.setEncoding("utf8");
		const onData = (chunk) => {
			output += chunk;
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			resolveLine(output.slice(0, newline));
		};
		child.stdout.on("data", onData);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}
function waitForChild(child) {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}
describe("global VM admission slots", () => {
	it("uses a dedicated override root outside the project run store", () => {
		strictEqual(getVmAdmissionRoot(), VM_ADMISSION_ROOT);
		notStrictEqual(getVmAdmissionRoot(), getStateRoot());
	});

	it("publishes a complete parseable owner and releases by matching token only", () => {
		const lease = acquireVmSlot({ runId: "token-owner" });
		const slotPath = join(VM_ADMISSION_ROOT, `vm-slot-${lease.slot}.lock`);
		const body = JSON.parse(readFileSync(slotPath, "utf8"));

		strictEqual(body.ownerPid, process.pid);
		strictEqual(body.runId, "token-owner");
		strictEqual(body.token, lease.token);
		strictEqual(releaseVmSlot({ ...lease, token: "wrong-token" }), false);
		ok(existsSync(slotPath));
		strictEqual(releaseVmSlot(lease), true);
		strictEqual(releaseVmSlot(lease), false);
	});

	it("reclaims a slot whose owner PID is provably dead", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		for (const slotIndex of [0, 1]) {
			writeFileSync(
				join(VM_ADMISSION_ROOT, `vm-slot-${slotIndex}.lock`),
				JSON.stringify({
					ownerPid: 999999999,
					runId: `dead-owner-${slotIndex}`,
					token: `dead-token-${slotIndex}`,
				}),
			);
		}

		const lease = acquireVmSlot({ runId: "new-owner-0" });
		const secondLease = acquireVmSlot({ runId: "new-owner-1" });
		strictEqual(lease.slot, 0);
		strictEqual(secondLease.slot, 1);
		strictEqual(
			JSON.parse(readFileSync(lease.path, "utf8")).runId,
			"new-owner-0",
		);
		lease.release();
		secondLease.release();
	});

	it("ignores interrupted temporary files", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		const tmpPath = join(
			VM_ADMISSION_ROOT,
			`vm-slot-0.lock.${process.pid}.interrupted.tmp`,
		);
		writeFileSync(tmpPath, "complete but unpublished");

		const lease = acquireVmSlot({ runId: "after-interruption" });
		strictEqual(lease.slot, 0);
		lease.release();
		ok(
			existsSync(tmpPath),
			"the primitive need not guess which temp files are safe to remove",
		);
	});

	it("contains admission filesystem failures behind a closed preflight diagnostic", () => {
		writeFileSync(VM_ADMISSION_ROOT, "HOST_ERROR_CANARY /private/admission");

		try {
			acquireVmSlot({ runId: "filesystem-failure" });
			throw new Error("expected VM admission to fail");
		} catch (error) {
			ok(error instanceof VmAdmissionUnavailableError);
			strictEqual(error.code, "VM_ADMISSION_UNAVAILABLE");
			ok(String(error.cause?.message).includes(VM_ADMISSION_ROOT));
			const classified = classifyPreProviderFailure(error);
			deepStrictEqual(classified, {
				diagnosticCode: "vm_admission_unavailable",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
			});
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOST_ERROR_CANARY"));
			ok(!persisted.includes("/private/admission"));
			ok(!persisted.includes(VM_ADMISSION_ROOT));
		}
	});

	it("maps admission filesystem codes to closed sanitized categories", () => {
		for (const [code, ErrorType, diagnosticCode] of [
			[
				"EPERM",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			[
				"EACCES",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			["EIO", VmAdmissionStorageError, "vm_admission_storage_failed"],
			["ENOSPC", VmAdmissionStorageError, "vm_admission_storage_failed"],
			["UNEXPECTED", VmAdmissionUnavailableError, "vm_admission_unavailable"],
		]) {
			const cause = Object.assign(
				new Error(`HOST_ERROR_CANARY ${VM_ADMISSION_ROOT}`),
				{ code },
			);
			const wrapped = sanitizeVmAdmissionError(cause);
			ok(wrapped instanceof ErrorType);
			const classified = classifyPreProviderFailure(wrapped);
			strictEqual(classified.diagnosticCode, diagnosticCode);
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOST_ERROR_CANARY"));
			ok(!persisted.includes(VM_ADMISSION_ROOT));
		}
	});

	it("preserves closed admission errors when an occupied slot cannot be read", () => {
		for (const [code, ErrorType, diagnosticCode] of [
			[
				"EACCES",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			[
				"EPERM",
				VmAdmissionPermissionDeniedError,
				"vm_admission_permission_denied",
			],
			["EIO", VmAdmissionStorageError, "vm_admission_storage_failed"],
		]) {
			const cause = Object.assign(new Error("slot read failed"), { code });
			let observed;
			try {
				runStoreTesting.readVmSlotBody("occupied-slot", () => {
					throw cause;
				});
			} catch (error) {
				observed = error;
			}

			strictEqual(observed, cause);
			const classified = sanitizeVmAdmissionError(observed);
			ok(classified instanceof ErrorType);
			strictEqual(
				classifyPreProviderFailure(classified).diagnosticCode,
				diagnosticCode,
			);
		}
	});

	it("classifies occupied admission slots without confusing storage failure", () => {
		mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
		for (const slotIndex of [0, 1]) {
			writeFileSync(
				join(VM_ADMISSION_ROOT, `vm-slot-${slotIndex}.lock`),
				JSON.stringify({
					ownerPid: process.pid,
					runId: `HOLDER_CANARY_${slotIndex}`,
					token: `holder-token-${slotIndex}`,
				}),
			);
		}

		try {
			acquireVmSlot({ runId: "slot-challenger" });
			throw new Error("expected VM slots to be unavailable");
		} catch (error) {
			ok(error instanceof VmSlotUnavailableError);
			strictEqual(error.code, "VM_SLOT_UNAVAILABLE");
			const classified = classifyPreProviderFailure(error);
			deepStrictEqual(classified, {
				diagnosticCode: "vm_slot_unavailable",
				errorKind: "environment_incomplete",
				failurePhase: "queue_preflight",
			});
			const persisted = JSON.stringify(
				sanitizeFailureMetadata({ result: "launch_failed", ...classified }),
			);
			ok(!persisted.includes("HOLDER_CANARY"));
			ok(!persisted.includes("holder-token"));
		}
	});

	it("classifies malformed or empty occupied slot contents as storage failure", () => {
		for (const contents of [
			"",
			"not-json",
			JSON.stringify({ runId: "missing-owner" }),
		]) {
			rmSync(VM_ADMISSION_ROOT, { recursive: true, force: true });
			mkdirSync(VM_ADMISSION_ROOT, { recursive: true });
			writeFileSync(join(VM_ADMISSION_ROOT, "vm-slot-0.lock"), contents);
			try {
				acquireVmSlot({ runId: "corrupt-slot-challenger" });
				throw new Error("expected corrupted admission slot to fail");
			} catch (error) {
				ok(error instanceof VmAdmissionStorageError);
				strictEqual(error.code, "VM_ADMISSION_STORAGE_FAILED");
				strictEqual(
					classifyPreProviderFailure(error).diagnosticCode,
					"vm_admission_storage_failed",
				);
			}
		}
	});

	it("retries a slot that disappears between failed publication and owner read", () => {
		let publishCalls = 0;
		let readCalls = 0;
		const lease = runStoreTesting.acquireVmSlotWithDependencies(
			{ runId: "slot-release-race" },
			{
				publishVmSlot: () => {
					publishCalls += 1;
					return publishCalls > 1;
				},
				readVmSlotBody: () => {
					readCalls += 1;
					throw Object.assign(new Error("slot vanished"), { code: "ENOENT" });
				},
			},
		);

		strictEqual(lease.slotIndex, 0);
		strictEqual(publishCalls, 2);
		strictEqual(readCalls, 1);
	});

	it("does not invoke project-lock orphan reclamation", async () => {
		const source = sourceText(
			new URL("../src/switchyard/run-store/index.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/errors.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/constants.mjs", import.meta.url),
			new URL(
				"../src/switchyard/run-store/receipt-validation.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/run-store/validate-run.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/run-records.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/vm-slots.mjs", import.meta.url),
			new URL(
				"../src/switchyard/run-store/project-lock-files.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/run-store/run-updates.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/events.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/project-locks.mjs", import.meta.url),
			new URL(
				"../src/switchyard/run-store/project-lock-claims.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/run-store/run-locks.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/evidence.mjs", import.meta.url),
			new URL("../src/switchyard/run-store/outcomes.mjs", import.meta.url),
			new URL(
				"../src/switchyard/run-store/checkpoint-artifacts.mjs",
				import.meta.url,
			),
			new URL(
				"../src/switchyard/run-store/checkpoint-retention.mjs",
				import.meta.url,
			),
			new URL("../src/switchyard/run-store/retention.mjs", import.meta.url),
		);
		const primitive = source.slice(
			source.indexOf("export function acquireVmSlot"),
			source.indexOf("export const acquireMacosVmSlot"),
		);
		ok(primitive.includes("linkSync"));
		ok(!primitive.includes("releaseOrphanedProjectLocks"));
		ok(!primitive.includes('flag: "wx"'));
	});

	it("contends across processes and reports the holding runs safely", async () => {
		const holderSource = `
			import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			const lease = store.acquireVmSlot({ runId: "child-holder" });
			console.log(JSON.stringify({ slot: lease.slot }));
			process.stdin.once("data", () => { lease.release(); process.exit(0); });
		`;
		const holder = spawnSlotChild(holderSource);
		let parentLease;
		try {
			deepStrictEqual(JSON.parse(await readChildLine(holder)), { slot: 0 });
			parentLease = acquireVmSlot({ runId: "parent-holder" });
			strictEqual(parentLease.slot, 1);

			const challengerSource = `
				import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			try {
					store.acquireVmSlot({ runId: "challenger" });
				} catch (error) {
					console.log(JSON.stringify({ code: error.code, message: error.message }));
					process.exit(0);
				}
				process.exit(1);
			`;
			const challenger = spawnSlotChild(challengerSource);
			const result = JSON.parse(await readChildLine(challenger));
			await waitForChild(challenger);
			strictEqual(result.code, "VM_SLOT_UNAVAILABLE");
			ok(result.message.includes("child-holder"));
			ok(result.message.includes("parent-holder"));
		} finally {
			if (parentLease) parentLease.release();
			holder.stdin.write("release\n");
			await waitForChild(holder);
		}
	});

	it("allows a later process to acquire after an unreleased owner is killed", async () => {
		const holderSource = `
			import * as store from ${JSON.stringify(RUN_STORE_MODULE_URL)};
			store.acquireVmSlot({ runId: "killed-holder" });
			console.log("ready");
			setInterval(() => {}, 1000);
		`;
		const holder = spawnSlotChild(holderSource);
		try {
			strictEqual((await readChildLine(holder)).trim(), "ready");
			holder.kill("SIGKILL");
			await waitForChild(holder);
			const lease = acquireVmSlot({ runId: "reclaimed-after-kill" });
			strictEqual(lease.slot, 0);
			lease.release();
		} finally {
			if (!holder.killed) holder.kill("SIGKILL");
		}
	});
});
