const USAGE = `Usage: switchyard-dispatch <subcommand> [args]
       switchyard-dispatch --version

Subcommands:
  routing-run <inspect|native-start> ...             Inspect or acknowledge native routing
  simple <prompt-file> --project <path> ...         Run one local bounded task
  run    <tasks.md> --project <path> [options]    Run queue synchronously
  launch <tasks.md> --project <path> [options]    Launch detached run
  validate-inputs <tasks.md> --project <path> [options]  Validate caller inputs
  backend-health [--json]                             Probe execution backend readiness
  status <run-id> [--json]                        Show run status
  result <run-id> [--json]                        Show run result
  recover [--run <run-id>] [--state-root <path>]  Recover managed objects
  remediate-orphaned-locks [--dry-run|--confirm] [--state-root <path>]
                                                Interactively remediate orphaned project locks

Run/Launch options:
  --routing-run-id <id>  Honor the native latch (or SWITCHYARD_ROUTING_RUN_ID)
  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --health-enforce        Apply route-health exclusions (default: shadow only)
  --health-state-root <path>  Explicit host-owned route-health root
  --json                  Emit one terminal JSON object
  --help                 Show this help`;
const USAGE_RUN = `Usage: switchyard-dispatch run <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --json                  Emit one terminal JSON object
  --help                 Show this help`;
const USAGE_VALIDATE_INPUTS = `Usage: switchyard-dispatch validate-inputs <tasks.md> --project <path> [options]

  --project <path>       Host git repo to validate against (required)
  --max-tasks <n>        Validate the same bounded execution selection
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Include the execution option in queue identity
  --exclude-provider <name>  Include this provider filter in queue identity (repeatable)
  --only-provider <name>  Include this provider filter in queue identity (repeatable, mutually exclusive with --exclude-provider)
  --platform <macos>     Queue workspace platform (default: macos)
  --task-id <id>         Select an exact task (repeatable; identity-bound)
  --dirty-overlay        Validate declared tracked dirty bytes without publishing a receipt
  --json                 Idempotent; output is always one JSON object
  --help                 Show this help`;
const USAGE_BACKEND_HEALTH = `Usage: switchyard-dispatch backend-health [--json]

Runs one bounded read-only execution-backend readiness probe. It never starts,
repairs, or mutates a service, VM, workspace, or provider.`;
const USAGE_LAUNCH = `Usage: switchyard-dispatch launch <tasks.md> --project <path> [options]

  --project <path>       Host git repo to dispatch against (required)
  --max-tasks <n>        Cap how many tasks are processed this run
  --checkpoint <path>    Checkpoint file (default: <tasks>.checkpoint.json)
  --no-stop-on-failure   Keep going after a task fails (default: stop)
  --exclude-provider <name>  Never route to this provider (repeatable)
  --only-provider <name>  Restrict routing to only this provider (repeatable, mutually exclusive with --exclude-provider)
  --task-id <id>          Select an exact task (repeatable; identity-bound)
  --json                  Emit one JSON object on success or failure
  --help                 Show this help`;
const USAGE_STATUS = `Usage: switchyard-dispatch status <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
  --help     Show this help`;
const USAGE_RESULT = `Usage: switchyard-dispatch result <run-id> [--json]

  --json                    Output as JSON (default behavior)
  --state-root <path>       Read the run from this launch's durable state root
  --help     Show this help`;
const USAGE_RECOVER = `Usage: switchyard-dispatch recover [--run <run-id>] [--state-root <path>]

  --run <run-id>       Recover only this run's managed objects; simple worktrees are report-only
  --state-root <path>  Reconcile this launch's durable state root
  --help               Show this help

  Simple candidates include runLiveness (worker PID state, not writer proof).
  Running simple targets skip global project-lock cleanup to protect possible child writers.`;
const USAGE_HEALTH = `Usage: switchyard-dispatch health <identity|inspect|attest-repair> --target <target-id> [options]

  identity:      --capability <low|standard|high>
  inspect:       --descriptor <descriptor-identity> --public-configuration-epoch <epoch> --repair-epoch <n> [--health-state-root <path>]
  attest-repair: --descriptor <descriptor-identity> --public-configuration-epoch <epoch> --repair-kind <image_repaired|auth_repaired|configuration_repaired> [--health-state-root <path>]
  Run \`health identity\` first: it prints the descriptor identity and public configuration epoch the other two require.
  attest-repair records attended host control metadata only; it never reads credentials or repairs a service.`;
const KNOWN_SUBCOMMANDS = new Set([
	"simple",
	"run",
	"launch",
	"validate-inputs",
	"backend-health",
	"status",
	"result",
	"recover",
	"health",
	"remediate-orphaned-locks",
	"routing-run",
]);
class UsageError extends Error {}

export {
	KNOWN_SUBCOMMANDS,
	USAGE,
	USAGE_BACKEND_HEALTH,
	USAGE_HEALTH,
	USAGE_LAUNCH,
	USAGE_RECOVER,
	USAGE_RESULT,
	USAGE_RUN,
	USAGE_STATUS,
	USAGE_VALIDATE_INPUTS,
	UsageError,
};
