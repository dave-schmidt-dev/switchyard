import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DOCKER_PROBE_COMMAND,
	dockerAvailable,
	dockerUnavailableReason,
} from "./helpers/docker.mjs";

// Switchyard executes every dispatched task inside a disposable per-provider
// container, so the Docker daemon is not an optional dependency the way an
// absent Parallels golden image is -- without it the product's central
// execution path does not exist. The eight adapter test files that cover that
// path all skip when the daemon is unreachable, which is the honest thing for
// them to do individually but produced a dishonest whole: a push on 2026-08-27
// reported `skipped 13` and still exited 0 on every phase, so the gate went
// green having never exercised container execution at all.
//
// This is the same reasoning the VM gates already apply to an unset
// SWITCHYARD_PARALLELS_AQUA_UID: a gate that cannot prove its invariant must
// not report green. One loud failure here, rather than a skip inside each
// adapter file, keeps those files' non-container unit tests runnable while
// making the green-with-no-coverage outcome unreachable.
describe("container execution prerequisite", () => {
	it("has a reachable Docker daemon", () => {
		ok(
			dockerAvailable,
			`Docker daemon is unreachable, so every container-execution adapter test ` +
				`would skip and the suite would still report green.\n` +
				`  probe:  ${DOCKER_PROBE_COMMAND}\n` +
				`  reason: ${dockerUnavailableReason}\n` +
				`  remedy: start the daemon (\`open -ga OrbStack\`), wait for ` +
				`\`docker info\` to succeed, then rerun.`,
		);
	});
});
