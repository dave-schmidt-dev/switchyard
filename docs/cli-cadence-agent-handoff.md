# Handoff: wiring `~/.agent` and `~/.launchd` into the CLI cadence

Status: 2026-10-05. The Switchyard side is done: flag contract, cadence,
launchd template, and the pinned host opencode. This page covers what has to
happen in `~/.agent` and `~/.launchd`, which the session that built it
couldn't reach (it ran in a cloud checkout of this repo only). Each step is
small. Do them in this order.

## 1. Make opencode pinned on the host (decision)

**Decision:** agent-headless runs the **pinned** opencode, the same
`opencode-ai` release as the golden image (`ops/macos-vm/cli-manifest.txt`,
currently 1.18.30), and doesn't track Homebrew.

Reasons:

- Tracking Homebrew is the failure mode. An unattended `brew upgrade` moved
  opencode to 2.0.20, its flags changed, and nothing could gate it. Homebrew
  can't pin a formula version.
- 2.x isn't on the channel we can verify. On 2026-10-05, npm's `opencode-ai`
  `latest` was 1.18.34, and 2.0.20 wasn't published there at all. The golden
  image and the hash checks are built on npm.
- With one pin there's one contract. Switchyard's own call sites (VM adapter,
  both bridges, liveness) use `--variant`, which 2.x removed. Its V2 runtime
  also needs network access outside the simple lane's proxy-only sandbox.
  Tracking 2.x on the host alone would leave two opencode dialects to
  maintain.

The cost: agent-headless's opencode arm goes back to the 1.x flags. Commit
58bd053 moved it to 2.x syntax (`--model provider/model#variant`, no
`--variant`, no `--dir`). After this step it should pass `--variant <v>` again,
and the flag contract confirms 1.18.x accepts `--variant`, `--dir`, `--agent`,
`--auto`, `--pure` and `--format`. A future 2.x bump then goes through the
cadence like any other bump: it is held until every call site, agent-headless
included, passes.

```sh
brew uninstall opencode            # Homebrew's formula can't hold a pin
cd ~/Documents/Projects/switchyard
ops/macos-vm/sync-host-clis.sh --cli-manifest "$PWD/ops/macos-vm/cli-manifest.txt" --only opencode
opencode --version                 # 1.18.30
```

The cadence will move that pin to npm-stable 1.18.34 (or later) once the
contract and canary pass.

## 2. Declare agent-headless's call sites

Create `~/.agent/cli-flag-contract.json`. The cadence reads it by default;
`SWITCHYARD_AGENT_FLAG_CONTRACT` overrides the path. Format and rules are in
`ops/cli-cadence/README.md`. Write one site per arm, using the arm's real argv
with placeholder values:

```json
{
  "sites": [
    { "site": "agent-headless:claude",   "argv": ["claude", "-p", "..."] },
    { "site": "agent-headless:codex",    "argv": ["codex", "exec", "..."] },
    { "site": "agent-headless:agy",      "argv": ["agy", "..."] },
    { "site": "agent-headless:cursor",   "argv": ["cursor-agent", "..."] },
    { "site": "agent-headless:copilot",  "argv": ["copilot", "..."] },
    { "site": "agent-headless:opencode", "argv": ["opencode", "run", "--agent", "plan", "--variant", "max", "--format", "json", "--model", "provider/model", "PROMPT"] },
    { "site": "agent-headless:vibe",     "argv": ["vibe", "..."] },
    { "site": "agent-headless:pi",       "argv": ["pi", "..."] }
  ]
}
```

Better: give agent-headless a `--print-argv TARGET` mode built from the same
code that builds each arm's argv, and generate this file from it. Then the
contract can't drift from the script. Switchyard does the same thing: it
captures argv from its real builders and doesn't keep a list.

## 3. Wire the check into `~/.agent` tests

Add one test to the `~/.agent` runner:

```sh
node ~/Documents/Projects/switchyard/scripts/check-cli-flag-contract.mjs \
  --no-switchyard --contract ~/.agent/cli-flag-contract.json
```

It exits 1 with lines like `FLAG-CONTRACT FAIL opencode 2.0.20: "opencode run
--help" does not list --variant (used by agent-headless:opencode; …)`. Add
`--strict` if every CLI must be installed wherever the tests run. If you add
`--print-argv`, also add a parity test: the generated JSON must equal the
committed file.

The copilot arm's `COPILOT_READONLY_VERIFIED_VERSION` guard will block copilot
the first time the cadence promotes a copilot bump. Either bump it together
with the pin, or replace it with this contract plus a `--canary` run. The
contract is what that guard approximates.

## 4. `~/.agent/CLI.md` note

> **CLI versions.** Provider CLIs are pinned in
> `~/Documents/Projects/switchyard/ops/macos-vm/cli-manifest.txt` (pi is
> host-only and tracked at npm stable). Don't `brew upgrade` them by hand. The
> Switchyard CLI cadence (`com.zerodelta.switchyard.cli-cadence`, daily 06:41)
> reads each CLI's stable channel and stages newer releases in scratch. It
> promotes a release only after `scripts/check-cli-flag-contract.mjs` (every
> flag Switchyard and agent-headless pass, from `~/.agent/cli-flag-contract.json`)
> and a live canary pass against it. Passing pins land on a local
> `cli-cadence/…` branch to review and merge, followed by `npm run cli:sync` for
> the golden VM. Held bumps and drift are reported in
> `.logs/cli-cadence/latest.txt` and to the notifier. When an arm's flags
> change, update `cli-flag-contract.json` in the same commit.

## 5. Schedule it under `~/.launchd`

```sh
cd ~/Documents/Projects/switchyard
ops/cli-cadence/install-cli-cadence.sh --mode promote --notify <owner notifier> --no-load
```

This renders `~/.launchd/com.zerodelta.switchyard.cli-cadence.plist` (set
`SWITCHYARD_LAUNCHD_DIR` to put it elsewhere). Load it the way the other
`~/.launchd` jobs are loaded, or drop `--no-load` to `launchctl bootstrap` it
directly. The job reads this checkout under `~/Documents`, so its interpreter
needs the same Full Disk Access arrangement the other `~/.launchd` jobs use.
Without it, the run fails at `cd` and says so in
`~/Library/Logs/switchyard-cli-cadence.launchd.err.log`. Before relying on the
schedule, run it once by hand:

```sh
npm run cli:cadence -- --mode check      # read-only
npm run cli:cadence                      # stage: installs candidates in scratch only
```

## 6. Decide: claude stable or latest

The manifest pins claude at npm's `stable` dist-tag (2.1.285 on 2026-10-05),
but `sync-host-clis.sh` updates the host with `brew upgrade --cask
claude-code@latest`, which tracks `latest` (2.1.289). The host overshoots the
pin, so `cli:check` reports claude drift, and the cadence won't commit a claude
bump because the host can't land on the pin. Choose one:

- If the `claude-code` cask (without `@latest`) tracks stable, switch the host
  updater to it. That's the stable-only choice and matches the request.
- Or change `CHANNELS.claude` to `latest` and accept non-stable claude
  releases.

## 7. Open question: the empty-stderr review failure (p3-raw)

`~/Documents/Projects/switchyard/.logs/triage-fixes/review/p3-raw.json` and
`.err` (a direct OpenCode review that exited 1 with empty stderr after the
manual fix) weren't readable from the cloud session. Check them before
deciding whether 2.x has a second incompatibility:

- `jq -c 'select(.type) | .type' p3-raw.json | sort | uniq -c`: 2.x
  `--format json` may have renamed or regrouped event types. A parser waiting
  for a 1.x event shape would see "no result" and exit 1 without writing
  stderr.
- Look for a permission or `ask` event near the end. Under 2.x the `plan`
  agent may need a permission that `--auto` no longer grants.

After step 1 (host back on the 1.x pin) this only matters for a future 2.x
bump. Turn whatever you find into a contract site or a canary assertion, so
the cadence holds that bump automatically.
