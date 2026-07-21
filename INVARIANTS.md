# Invariants — switchyard

> System contract. The harvest tool reads `area:` globs to map HISTORY bug entries
> to invariants. Per-project convention (commit prefix, invariant refs) is declared
> in this project's README, not globally.
>
> Confirmed by David Schmidt 2026-07-20 (first closed-loop plan:
> `switchyard-containment-architecture-2026-07-20`). Each invariant maps to a
> seed §4 Go/No-Go gate. `area:` globs point at the planned layout; they become
> live as the code lands.

### INV-1 — No exec/validation container can reach the host, VM gateway, RFC1918 LAN, cloud metadata, Docker socket, or local DNS
area: ["src/switchyard/net/**", "src/switchyard/container/**", "docker/**", "tests/adversarial/**"]
gate_test: tests/adversarial/test_containment.py
threshold: 3
rationale: The sandbox boundary is the product. A reachable host/LAN/metadata endpoint turns a hostile workload into host or network compromise. This is the whole point of the architecture.

### INV-2 — Reusable base images contain no live credentials; provider creds are injected per-task and only for one provider
area: ["docker/**", "src/switchyard/container/**", "src/switchyard/creds/**"]
gate_test: tests/test_base_image_no_creds.py
threshold: 3
rationale: A credential baked into a reusable image is a credential leaked to every task and every image copy. Per-task single-provider injection bounds the blast to one sacrificial environment and one provider.

### INV-3 — The host reads only Importer-emitted canonical patches + control-stripped plaintext logs; never un-normalized container output
area: ["src/switchyard/importer/**"]
gate_test: tests/test_quarantine_importer.py
threshold: 3
rationale: Container output is hostile data (terminal-escape injection, patch path-traversal, symlink attacks). Opening it raw on the trusted host is a direct compromise path; normalization in quarantine is the only safe intake.

### INV-4 — The validation container has no network, no credentials, no Docker socket, no writable dep cache, and immutable hash-pinned deps
area: ["src/switchyard/validator/**", "docker/validator/**"]
gate_test: tests/test_validator_offline.py
threshold: 3
rationale: The validator runs a hostile workload (the patched code + its tests). Network or credential access there re-opens every exfiltration/tamper vector the pipeline exists to close.

### INV-5 — Every task enforces a path/operation allowlist (e.g. max_files_changed) on both export and import, atop global blocks
area: ["src/switchyard/exporter/**", "src/switchyard/importer/**", "src/switchyard/policy/**"]
gate_test: tests/test_allowlists.py
threshold: 3
rationale: Without a per-task allowlist, a compromised agent can exfiltrate more source than intended (export) or write outside its remit (import). Dual-layer allowlists (global blocks + task-specific) bound both directions.

### INV-6 — Every task records repo snapshot, base-image digest, provider-credential identity, patch hash, and validation result — never secret values
area: ["src/switchyard/ledger/**"]
gate_test: tests/test_provenance.py
threshold: 3
rationale: A change that can't be traced to a snapshot/image/credential/patch/result is unauditable and unattributable — fatal for a system that runs untrusted code. Storing credential *identity* (not value) keeps the ledger itself non-sensitive.

### INV-7 — The adversarial corpus uses instrumented canary/test credentials, never production tokens
area: ["tests/adversarial/**", "src/switchyard/creds/**"]
gate_test: tests/adversarial/test_canary_only.py
threshold: 3
rationale: Red-teaming assumes credential exfiltration succeeds. Using a real token to prove that burns a real token; canaries make exfiltration observable without real loss.
