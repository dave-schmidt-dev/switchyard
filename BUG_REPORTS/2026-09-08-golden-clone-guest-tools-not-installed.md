# Linked clones of `switchyard-golden-6` boot without Parallels Tools; `prlctl exec` never opens a session

- **Found:** 2026-09-08, while trying to replicate the 2026-09-01 `prlctl_job_misfire`
  measurement for TASKS.md Task 11.
- **Severity:** blocks dispatch. `prlctl exec` is the only channel Switchyard has into a
  guest — Aqua readiness, `pfctl` anchor load, `chown`, clipboard residue checks, and
  mount inspection all route through it (`parallels-execution-backend.mjs:617, 1847,
  2043, 2152, 2184`).
- **Status:** cause not identified. Remediation requires booting the golden image, which
  is a captain decision.

## Observed

A fresh linked clone of the stopped golden (`prlctl clone switchyard-golden-6 --linked`,
then `prlctl start`) runs normally but never registers guest tools. Polled every 10s for
600s:

```
60s  status=running GuestTools: state=not_installed
...
600s status=running GuestTools: state=not_installed
EXEC NEVER OK after 600s
final: State: running / GuestTools: state=not_installed
```

Every `prlctl exec <clone> /usr/bin/true` in that window returned:

> Unable to open new session in this virtual machine. Make sure your virtual machine has
> finished booting, runs the latest version of Parallels Tools, and is not isolated from
> the host OS.

Reproduced across two independent clones (`...-exec-101830`, `...-diag-102323`), both
deleted afterwards. The golden was left with zero snapshots each time.

## Version skew

| component | version |
| --- | --- |
| host `prlctl` | 27.0.1 (58670) |
| `/Applications/Parallels Desktop.app` mtime | 2026-09-07 19:09 |
| golden `GuestTools` (recorded, VM stopped) | 27.0.0-58628, `state=outdated` |
| clone `GuestTools` (live, VM running) | `state=not_installed` |

The golden's `outdated 27.0.0-58628` is a value recorded the last time it ran; the
clone's `not_installed` is the live report from a running VM. The tools agent inside the
image is not answering under the current host build.

## What is not established

- **That the 09-07 19:09 host update caused this.** There is no post-update baseline. The
  golden itself was last booted 2026-09-06 10:24 (`parallels.log`), before the update, and
  no dispatch has reached a VM since — the only post-update run,
  `35667edc-51cf-413f-97ba-b7dbf523474f` (2026-09-07 23:30Z), failed in 95ms at
  `worker_boot_failed` / `environment_incomplete` ("The selected queue environment did not
  pass preflight"), never touching Parallels. Version skew is a strong correlate, not a
  proven cause.
- **Whether the golden works when booted directly.** Only linked clones were tested.
  Booting the golden mutates a captain-owned asset and was not done.

## Blocked-on

Reinstalling Parallels Tools inside the golden requires booting it, a GUI installer run,
and an admin password — none of which an agent should do unattended to the seed image.

## Consequence for Task 11

Task 11's qualification batch cannot be completed until this clears. Separately, the batch
that did run found no misfires at all — see that row.
