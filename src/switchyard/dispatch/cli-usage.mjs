const USAGE = `Usage: switchyard-dispatch <subcommand> [args]
       switchyard-dispatch --version

Subcommands:
  simple <prompt-file> --project <path> ...         Run one local bounded task
  routing-run <inspect|native-start> ...             Inspect or acknowledge native routing
  recover [--run <run-id>] [--state-root <path>]    Release stale project locks and recover simple worktrees
  health <identity|inspect|attest-repair> ...        Inspect or attest route health
  doctor [--quick] [--json]                          Read-only host diagnosis with fixes
  remediate-orphaned-locks [--dry-run|--confirm] [--state-root <path>]
                                                    Interactively remediate orphaned project locks

Run \`switchyard-dispatch <subcommand> --help\` for subcommand options.`;
const USAGE_RECOVER = `Usage: switchyard-dispatch recover [--run <run-id>] [--state-root <path>]

  --run <run-id>       Recover only this run: a terminal simple run's retained worktree and its own project lock
  --state-root <path>  Reconcile this launch's durable state root
  --help               Show this help

  Without --run, recover releases stale and orphaned project locks.
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
	"recover",
	"health",
	"remediate-orphaned-locks",
	"routing-run",
]);
class UsageError extends Error {}

export { KNOWN_SUBCOMMANDS, USAGE, USAGE_HEALTH, USAGE_RECOVER, UsageError };
