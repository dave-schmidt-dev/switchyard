# Provider CLI cadence and flag contract

Provider CLIs (claude, codex, agy, cursor-agent, copilot, opencode, vibe, pi)
move under us. On 2026-10-02 Homebrew upgraded opencode to 2.0.20, `opencode run`
stopped accepting `--variant` and `--dir`, and every agent-headless OpenCode
review failed with "Unrecognized flag" until someone noticed by hand. Two pieces
keep that from happening again:

1. **The flag contract** (`npm run cli:contract`): every flag our tooling passes
   to a provider CLI must be accepted by the installed release.
2. **The cadence** (`npm run cli:cadence`, scheduled daily by launchd): move
   each CLI to its latest **stable** release, but only once the contract and a
   live canary pass against it.

## Flag contract

`scripts/check-cli-flag-contract.mjs` (`src/switchyard/cli-contract/`) builds
the contract from the production argv builders, not from a hand-kept list:

| Lane | Call sites captured |
| --- | --- |
| VM adapters | `adapter/{claude,codex,agy,cursor,copilot,opencode}.mjs`, `vibe-execution.mjs`, once per roster invocation template (`--effort`, `-c model_reasoning_effort=…`, every `--variant`) |
| Auth and liveness | each `is*Authenticated` probe and every `LIVENESS_PROBES` entry |
| Simple lane | `simple/provider-invocation.mjs` (codex, agy, copilot), `simple-vibe-code-launcher.mjs`, `simple-provider-keyless-bridge.mjs` (vibe, and opencode against the **vendored** `.tools/opencode-v1.18.30` runtime) |
| BWS API-key bridge | `opencode-api-key-bridge.mjs` guest `opencode run` |
| Other tools | any `--contract FILE`, e.g. `~/.agent/cli-flag-contract.json` for agent-headless |

Each site's flags are compared, per subcommand (`codex exec`, `opencode run`),
with the flags the installed CLI lists on option-definition lines of its
`--help`. Flags merely mentioned in prose don't count. A flag missing from
`--help` gets a second witness: Switchyard runs it through the parser, and
counts silence as acceptance only if that same parser rejects a made-up flag in
the same position. copilot's hidden `--sandbox` passes this way, with a note. A
lenient parser (opencode 1.x, claude, vibe) provides no such evidence, so the
missing flag stays a violation.

```sh
npm run cli:contract                                     # installed CLIs; absent ones skipped
npm run cli:contract -- --strict                         # an absent CLI fails
npm run cli:contract -- --contract ~/.agent/cli-flag-contract.json
npm run cli:contract -- --bin opencode=/opt/homebrew/bin/opencode --only opencode
npm run cli:contract -- --canary                         # plus one live "reply OK" per CLI
```

Each failure prints one line naming the CLI, its version, the help scope, the
flag, every call site that uses it, and the binary that was checked:

```
FLAG-CONTRACT FAIL opencode 2.0.20: "opencode run --help" does not list --variant (used by adapter:opencode:max, agent-headless:opencode; /opt/homebrew/bin/opencode)
```

The canary (`--canary`) reuses `auth/liveness.mjs`'s probes on the host and
distinguishes `live`, `flag_rejected` and `not_live` (all three count) from
`auth_unavailable` and `quota_unavailable` (reported, but not a failure: the
contract is about flags, and a host without a login can't prove a reply).

### Contract file for other tools

```json
{
  "sites": [
    { "site": "agent-headless:opencode", "argv": ["opencode", "run", "--agent", "plan", "--format", "json", "--model", "opencode-go/x"] },
    { "site": "agent-headless:pi", "argv": ["pi", "-p", "--no-session", "--model", "x"] }
  ]
}
```

`argv[0]` names the CLI. A site may add `"binary"` (an absolute path to check
instead of `PATH`) or `"subcommands"` (the same shape as `CLI_SUBCOMMANDS`).
The best contract file is one the tool writes itself from its own argv builder
(for example an `agent-headless --print-argv TARGET` mode), so the contract
can't drift from the script.

## Cadence

`ops/cli-cadence/cli-cadence.mjs [--mode check|stage|promote] [--no-notify] [--json]`

| Step | check | stage (default) | promote (launchd) |
| --- | --- | --- | --- |
| Read each CLI's stable channel (below) | ✓ | ✓ | ✓ |
| `sync-host-clis.sh --check` (host vs pins) | ✓ | ✓ | ✓ |
| Flag contract against the host's installed CLIs (plus `~/.agent/cli-flag-contract.json`) | ✓ | ✓ | ✓ |
| Regenerate a candidate manifest in scratch (`generate-cli-manifest.sh --out`) | | ✓ | ✓ |
| Install each newer stable release **in scratch** and run `--strict` contract + canary against it | | ✓ | ✓ |
| Update the host (`sync-host-clis.sh --only …`) for passing candidates, then re-check what got installed | | | ✓ |
| Commit the passing pins on a local branch `cli-cadence/<date>-…` (never pushed, never main) | | | ✓ |

Invariants:

- A candidate whose contract or canary fails is **held**: its row isn't
  merged, the host isn't updated for it, and nothing is committed for it. The
  other candidates still proceed.
- Only `ops/macos-vm/cli-manifest.txt` is written. `~/.agent/roster.json`
  (slots, qualifications, `invocation_args`) is never read or written.
- Pins are committed only when `sync-host-clis.sh` confirms the host reached
  them and the post-update contract passes against what actually got
  installed. A package manager that overshoots or undershoots the pin blocks
  the commit (claude's Homebrew cask, for example, tracks `latest`, not
  `stable`).
- The golden VM isn't touched. After merging the branch, run `npm run cli:sync`.
- Scratch is a `mktemp -d` under `$TMPDIR`, removed at exit. A lock in
  `.logs/cli-cadence/run.lock` keeps runs from overlapping. Long steps log a
  heartbeat every 30 s.
- No secret is read or passed: canaries use each CLI's existing login.

| CLI | Stable channel | Staged from |
| --- | --- | --- |
| claude | npm `@anthropic-ai/claude-code` dist-tag **`stable`** (`latest` runs ahead) | npm, in scratch |
| codex | npm `@openai/codex` `latest` | npm, in scratch |
| copilot | npm `@github/copilot` `latest` | npm, in scratch |
| opencode | npm `opencode-ai` `latest` (Homebrew's version is reported, never followed) | npm, in scratch |
| vibe | Homebrew formula `mistral-vibe` (the guest installs it and hashes its source) | `uv venv` from PyPI, in scratch |
| cursor-agent | `cursor.com/install` (embedded lab version) | hash-checked installer, `HOME` in scratch |
| agy | `antigravity.google/cli/install.sh` manifest | hash-checked installer, `HOME` in scratch |
| pi | npm `@earendil-works/pi-coding-agent` `latest` (agent-headless only; not in the manifest) | npm, in scratch; promoted with `npm install -g` |

A version with a semver prerelease suffix (`1.0.92-5`, `0.159.0-alpha.12`) is
never stable. cursor's dated `YYYY.MM.DD-<hash>` builds are the one exception.

Each candidate's manifest row is generated on its own, with every other row at
its pin. A provider whose release can't be pinned holds only itself. For
example, mistral-vibe 2.25.8 ships PyPI wheels only, so until Homebrew's
formula reaches it there is no source archive to hash.

Every run writes `.logs/cli-cadence/<timestamp>.json` and `latest.txt`, prints
the summary, and notifies the owner through `$SWITCHYARD_CLI_CADENCE_NOTIFY`, an
executable that receives the title as `$1` and the report on stdin (a macOS
notification otherwise). The exit code is 0 only when nothing needs the owner.

### OpenCode: pinned, not Homebrew

The host's opencode is pinned like every other lane. `sync-host-clis.sh`
installs exactly the manifest's `opencode-ai@<pin>` from npm, the same package
the golden image installs, and refuses while Homebrew's `opencode` formula is
installed (`brew uninstall opencode`). Homebrew can't pin, tracks its own 2.x
line, and was the unattended path behind the 2026-10-02 breakage. agent-headless
therefore runs the pinned release, and its flags are held to the same contract.

The simple lane's vendored `.tools/opencode-v1.18.30` stays where it is:
`opencode run` 2.x drops `--variant`, which the keyless bridge passes. Its V2
runtime also needs network permissions outside the proxy-only sandbox (see the
README). A staged opencode candidate is checked against the keyless bridge's
call sites as well, so any release that would break the simple lane is held.
When a candidate passes, the report notes that the vendored runtime still pins
1.18.30. Re-vendoring is a separate manual change (binary, SHA-256 and
`KEYLESS_OPENCODE_VERSION` in `ops/simple-provider-keyless-bridge.mjs`).

### Install

```sh
ops/cli-cadence/install-cli-cadence.sh [--mode promote] [--notify ~/.agent/bin/notify-owner] [--no-load]
```

This renders `com.zerodelta.switchyard.cli-cadence.plist` into
`$SWITCHYARD_LAUNCHD_DIR` (default `~/.launchd`), copies the entry script to
`~/Library/Application Support/switchyard/` and bootstraps the job, which runs
daily at 06:41. The job reads this checkout under `~/Documents`, so whatever
launchd runs it as needs Full Disk Access (macOS TCC). If `~/.launchd` already
has a convention for that, use `--no-load` and wire the rendered plist the same
way as the other jobs there.
