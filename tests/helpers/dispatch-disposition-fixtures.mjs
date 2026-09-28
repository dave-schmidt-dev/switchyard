function run(overrides = {}) {
	return {
		runId: "run-1",
		state: "running",
		cleanupState: "not_started",
		lastFailure: null,
		...overrides,
	};
}

export { run };
