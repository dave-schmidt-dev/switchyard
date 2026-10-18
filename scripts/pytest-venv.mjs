import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** The suite that executes real pytest against an existing venv. */
export const PYTHON_HOST_SUITE =
	"tests/runner-python-quick-checks-host.test.mjs";
export const PYTEST_VENV_REMEDY =
	"set SWITCHYARD_TEST_PYTEST_VENV to an existing venv with installed pytest (no packages are installed by this suite)";

// Test input only: never install packages or search the caller's Python path.
function hasInstalledPytest(path) {
	try {
		return (
			existsSync(join(path, "pyvenv.cfg")) &&
			existsSync(join(path, "bin", "python")) &&
			readdirSync(join(path, "lib")).some(
				(version) =>
					/^python[0-9.]+$/u.test(version) &&
					existsSync(
						join(
							path,
							"lib",
							version,
							"site-packages",
							"pytest",
							"__init__.py",
						),
					) &&
					existsSync(
						join(
							path,
							"lib",
							version,
							"site-packages",
							"_pytest",
							"__init__.py",
						),
					),
			)
		);
	} catch {
		return false;
	}
}

/**
 * Locate the pytest venv the Python host suite runs against: the explicit
 * `SWITCHYARD_TEST_PYTEST_VENV`, else the repository `.venv`, else its
 * parent's `.venv`.
 *
 * @param {object} options
 * @param {string} options.root - Repository root.
 * @param {object} [options.env] - Environment to read the override from.
 * @returns {string|null} The venv path, or null when none has pytest.
 */
export function findPytestVenv({ root, env = process.env }) {
	const candidates = env.SWITCHYARD_TEST_PYTEST_VENV
		? [resolve(env.SWITCHYARD_TEST_PYTEST_VENV)]
		: [resolve(root, ".venv"), resolve(root, "../.venv")];
	return candidates.find(hasInstalledPytest) ?? null;
}

/**
 * Refuse a gate run up front when a suite it requires cannot execute here.
 * The contract gate treats a skipped suite as a failure, so without this the
 * missing fixture surfaced only after every other suite had run.
 *
 * @param {Iterable<string>} requiredSuites - Suites the gate will execute.
 * @param {object} options - `root` and optional `env`, as for findPytestVenv.
 * @returns {string[]} One line per missing prerequisite; empty when ready.
 */
export function gatePrerequisiteProblems(requiredSuites, options) {
	const suites = new Set(requiredSuites);
	if (suites.has(PYTHON_HOST_SUITE) && !findPytestVenv(options))
		return [`Python host fixture unavailable: ${PYTEST_VENV_REMEDY}`];
	return [];
}
