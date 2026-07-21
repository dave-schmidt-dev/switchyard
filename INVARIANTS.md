# Invariants — switchyard

> System contract. The harvest tool reads `area:` globs to map HISTORY bug entries
> to invariants. Per-project convention is declared in this project's README.
>
> Confirmed by David Schmidt 2026-07-20. switchyard is a **usage-aware dispatcher**
> that spreads coding tasks across subscription-backed agent CLIs (routing on live
> usage from the `gradus` project) and runs each in a disposable sandbox with no
> rights to the Mac host. Threat model: **accident-containment, not adversary defense.**

### INV-1 — Agents have no rights to the Mac host
area: ["src/switchyard/container/**", "src/switchyard/sandbox/**", "docker/**"]
gate_test: tests/no-host-rights.test.mjs
threshold: 3
rationale: The whole safety story. Neither the agent container nor the working container mounts the host filesystem, Docker socket, or host credentials. Agents operate only on the working container's copy of the code. A host mount = the agent can nuke the Mac. Provider CLIs authenticate via **independent in-container logins**, not copied host credentials, so no host secret enters the container. Routing is decided **host-side** (the runner reads gradus's snapshot on the host), so the snapshot never enters the container either — the only inbound signal is the per-task assignment (chosen provider/model + task text), a control input that carries no host credentials or paths and confers no power over the host.

### INV-2 — Code returns to the Mac only through the explicit, reviewed integration step
area: ["src/switchyard/integrate/**"]
gate_test: tests/integration-gate.test.mjs
threshold: 3
rationale: The single door between the sandbox and the host. Agent output reaches real files only via a reviewed apply/merge — never a direct agent write to the host. Bypassing this is how unattended agents would silently corrupt the Mac's copy.

### INV-3 — The working container is wiped at project end
area: ["src/switchyard/container/**", "src/switchyard/lifecycle/**"]
gate_test: tests/workspace-wipe.test.mjs
threshold: 3
rationale: The working container (project code + build artifacts) is the disposable unit; wiping it per project prevents cross-project state bleed and bounds any accident to one project. The standing agent container is never the disposable unit.

### INV-4 — A task is dispatched only to a provider with remaining usage, spreading load across funded providers; every dispatch records provider + model + result
area: ["src/switchyard/router/**", "src/switchyard/roster/**", "src/switchyard/ledger/**"]
gate_test: tests/router.test.mjs
threshold: 3
rationale: The product's reason to exist. Routing to an exhausted provider (percent_left at/near 0, or before reset_iso) defeats load-spreading and hits the "out of usage" wall switchyard removes. Among funded providers the router SPREADS — it favors the most remaining headroom rather than draining one provider before touching the next — so a plan consumes the aggregate capacity of every subscription. (The provider *priority list* Claude>Codex>Agy>Cursor>Vibe>Copilot governs the order adapters are BUILT, not runtime preference.) Recording provider+model+result per task keeps dispatch auditable and feeds the (tier → provider/model) fitness record INV-5 relies on.

### INV-5 — A task runs only on a (provider, model) whose capability class meets its difficulty tier
area: ["src/switchyard/router/**", "src/switchyard/roster/**"]
gate_test: tests/capability-match.test.mjs
threshold: 3
rationale: Providers and models are not interchangeable. A high-tier task (complex integration, schema/migration) routed to a low-capability harness or small model (Vibe, Copilot, or a Haiku-class model) produces wrong work that costs more to fix than it saved; conversely, running trivial tasks on a top model (Opus, top-tier GPT) needlessly burns the premium caps switchyard exists to conserve. So capability is a hard eligibility FILTER applied *before* INV-4's spread selection — a (provider, model) below the task's tier is not a candidate — and within the chosen harness the model is right-sized to the tier. Combined with INV-4's spread this is self-optimizing: easy tasks fall to weak/cheap providers first, reserving strong providers' headroom for the tasks that need them. The per-task difficulty tier is assigned upstream (the plan/board, per `delegation-principle.md`); switchyard's contract is to RESPECT it, not to invent it.
