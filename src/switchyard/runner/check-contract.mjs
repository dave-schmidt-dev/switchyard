const MAX_CHECKS = 4;

export { MAX_CHECKS };

/** Accept only bounded, direct-exec command forms in a captain task contract. */
export function parseQuickChecks(
	block,
	taskId,
	type = "implementation",
	executor = "switchyard",
) {
	const lines = block.split("\n");
	const field = (name) =>
		lines.filter((line) => line.startsWith(`- **${name}:**`));
	const declarations = field("Quick checks");
	const setups = field("Quick check setup");
	const suspicious = lines.some((line, index) => {
		const quickLike =
			/^\s*(?:[-*]\s*)?(?:\*\*)?(?:quick|quik|qick|quck)\b[^:\n]{0,60}:/i.test(
				line,
			);
		if (
			quickLike &&
			!line.startsWith("- **Quick checks:**") &&
			!line.startsWith("- **Quick check setup:**")
		)
			return true;
		if (
			(line.startsWith("- **Quick checks:**") ||
				line.startsWith("- **Quick check setup:**")) &&
			/^\s{2,}[-*]\s/u.test(lines[index + 1] ?? "")
		)
			return true;
		return false;
	});
	if (suspicious || declarations.length > 1 || setups.length > 1) {
		throw new Error(
			`Task ${taskId}: malformed or duplicate Quick checks declaration`,
		);
	}
	if (declarations.length === 0) {
		if (type === "implementation" && executor === "switchyard")
			throw new Error(
				`Task ${taskId}: missing Quick checks declaration; use Quick checks: none when check-free`,
			);
		if (setups.length)
			throw new Error(
				`Task ${taskId}: Quick check setup requires Quick checks`,
			);
		return { checks: [], setup: null, declared: false };
	}
	const raw = declarations[0].slice("- **Quick checks:**".length).trim();
	if (raw === "none") {
		if (setups.length)
			throw new Error(
				`Task ${taskId}: Quick checks: none cannot declare setup`,
			);
		return { checks: [], setup: null, declared: true };
	}
	if (type !== "implementation" || executor !== "switchyard")
		throw new Error(
			`Task ${taskId}: Quick checks require a switchyard implementation task`,
		);
	const checks = raw
		.split("; ")
		.map((item) => parseCommand(item, taskId, false));
	if (
		!raw ||
		checks.length > MAX_CHECKS ||
		checks.some((item) => item === null)
	)
		throw new Error(`Task ${taskId}: invalid Quick checks declaration`);
	const setup = setups.length
		? parseCommand(
				setups[0].slice("- **Quick check setup:**".length).trim(),
				taskId,
				true,
			)
		: null;
	return { checks, setup, declared: true };
}

export function parseCommand(raw, taskId, setup) {
	if (raw.length > 300 || /[\r\n\t`$'"\\|&<>]/u.test(raw))
		throw new Error(`Task ${taskId}: unsupported Quick check command`);
	const args = raw.split(" ");
	if (args.some((arg) => !arg || /[^A-Za-z0-9._/@:+-]/u.test(arg)))
		throw new Error(`Task ${taskId}: malformed Quick check command`);
	if (setup) {
		if (args.join(" ") !== "npm ci --ignore-scripts --offline")
			throw new Error(`Task ${taskId}: unsupported Quick check setup`);
	} else if (
		!(
			args[0] === "npm" &&
			args[1] === "run" &&
			args.length === 3 &&
			/^[a-z][a-z0-9:-]{0,63}$/u.test(args[2])
		) &&
		!(args[0] === "npm" && args[1] === "test" && args.length === 2) &&
		!(
			args[0] === "node" &&
			["--test", "--check"].includes(args[1]) &&
			args.length >= 3 &&
			args.length <= 12 &&
			args
				.slice(2)
				.every(
					(path) =>
						!path.startsWith("-") &&
						!path.startsWith("/") &&
						!path.split("/").includes(".."),
				)
		)
	) {
		throw new Error(`Task ${taskId}: unsupported Quick check command`);
	}
	return args;
}
