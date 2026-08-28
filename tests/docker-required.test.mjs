import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DOCKER_PROBE_COMMAND,
	dockerAvailable,
	dockerUnavailableReason,
} from "./helpers/docker.mjs";

// Docker is a test harness here, not a production dependency: Parallels is the
// sole execution backend and the Docker lane was removed 2026-08-19. The eight
// adapter files use a real container to exercise each adapter out-of-process,
// standing in for the Parallels guest, and that is the only coverage those
// execution paths get. Each file skips when the daemon is unreachable, which is
// honest individually but produced a dishonest whole: a push on 2026-08-27
// reported `skipped 13` and still exited 0 on every phase, so the gate went
// green having exercised none of them.
//
// This is the same reasoning the VM gates already apply to an unset
// SWITCHYARD_PARALLELS_AQUA_UID: a gate that cannot prove what it exists to
// prove must not report green. One loud failure here, rather than a skip inside
// each adapter file, keeps those files' non-container unit tests runnable while
// making the green-with-no-coverage outcome unreachable.
//
// The helper starts a stopped daemon before giving up, so reaching this
// assertion red means the runtime is missing, refused to launch, or never came
// up -- none of which a rerun fixes on its own.
describe("container execution prerequisite", () => {
	it("has a reachable Docker daemon", () => {
		ok(
			dockerAvailable,
			`Docker daemon is unreachable and could not be started, so every ` +
				`container-execution adapter test would skip and the suite would ` +
				`still report green.\n` +
				`  probe:  ${DOCKER_PROBE_COMMAND}\n` +
				`  reason: ${dockerUnavailableReason}\n` +
				`  remedy: install or repair a Docker runtime (OrbStack or Docker ` +
				`Desktop) and confirm \`docker info\` succeeds. Auto-start is ` +
				`suppressed by SWITCHYARD_DOCKER_AUTOSTART=0.`,
		);
	});
});
