# `prlctl stop` reports success without stopping; `stop --kill` can hang for hours

Both observed 2026-09-08 on Parallels **27.0.1 (58670)**, host idle, against a full clone
of `switchyard-golden-6` with working guest tools (`state=installed version=27.0.1-58670`).
Neither is the `prlctl_job_misfire` signature — no `PrlJob_GetRetCode`/`PrlJob_GetResult`
error, no exit 255.

## 1. Success reported for a stop that did not happen

```
$ prlctl stop switchyard-fullclone-105219
Stopping the VM...
The VM has been successfully stopped.        # exit 0
```

The VM was still running two minutes later, and not merely stale in the status field — it
was genuinely serving:

```
120s: running                                # polled every 5s, 24 times
prlctl exec <vm> /usr/bin/true  ->  exit 0   # guest answering
Uptime: 03:36:20 (since 2026-09-08 10:52:19) # unbroken across the "successful" stop
```

`prlctl stop --kill` against the same VM minutes later stopped it in seconds and reported
`The VM has been forcibly stopped`.

The mundane reading is that graceful stop returns once the ACPI request is *delivered*, and
a macOS guest can decline or stall it. That is still a false success at the CLI boundary:
the caller is told the VM stopped when it did not, with no way to tell the two apart from
the exit code or the message.

**This is the inverse of the misfire this project already handles.** A misfire reports
failure on an operation that may have succeeded, so the safe response is to probe observed
state. Here the operation reports success while nothing changed, and no amount of trusting
the return code catches it. Any caller treating a zero exit from `stop` as "the VM is down"
is wrong; the state must be polled.

### Confound: the two observations are not independent

Written in the order they were understood, which is the wrong order for judging them.
Observation 1 was made **minutes after** the wedged `prlctl stop --kill` of observation 2
was SIGTERM'd by hand — a 3.5-hour job in flight against **this same VM**. So a plausible
alternative to "graceful stop returns on ACPI delivery" is that the Parallels dispatcher
still held a stop job for this VM and answered the new request from that state. On that
reading observation 1 is an artifact of observation 2, not an independent CLI defect.

**A prior, uncontaminated sighting exists in this repo.** Found while fixing the backend:
`tests/parallels-backend.test.mjs`, in "waits out the shutdown settle window instead of racing
its own stop", opens with a sequence measured on the INV-1 gate **2026-08-31** — "the stop
reported success, the delete issued straight after it was refused because Parallels still had
the VM running, and the VM reported stopped a moment later." That is a graceful stop exiting 0
on a still-running VM, observed eight days earlier, with no wedged kill job anywhere near it.
It does not prove the 2h-scale persistence seen below — there the VM settled "a moment later" —
but it does establish the false success itself independently of the confound.

Nothing here distinguishes the two durations: one contaminated observation cannot support the
stronger claim. Treat section 1's mechanism as **unproven** and its consequence as sound regardless —
observing state after a stop is correct whether the false success is general or arises only
after a wedged job, and it is the only thing that catches either. A clean reproduction would
be a fresh full clone, waited until `exec` answers, stopped gracefully with no prior stop job
against it, and polled.

## 2. `stop --kill` hung for three and a half hours

An automated harness issued `prlctl stop <vm> --kill` roughly 40 seconds after
`prlctl start`, while the guest was still early in boot. The process never returned:

```
PID 45285  ELAPSED 03:31:34
/Applications/Parallels Desktop.app/Contents/MacOS/prlctl stop switchyard-fullclone-105219 --kill
```

It was killed by hand after 3h32m; the VM had been running the whole time. The same command
against the same VM once fully booted completed in seconds. Timing against boot is the
suspected trigger, not confirmed.

## Consequences for this project

- Every `prlctl` invocation in a harness or backend path needs a **timeout**. The hang above
  cost 3.5 hours of a running VM because one call had none, and the surrounding script had
  already decided to exit — the hang was in its cleanup trap, so the failure was invisible:
  no output, no exit, a VM left running.
- **Cleanup that reports without verifying is not cleanup.** The harness would have printed
  its "removed N VM(s)" line had it ever returned. Stop/delete must poll for the state it
  claims to have reached.
- `src/switchyard/lifecycle/parallels-execution-backend.mjs` should be audited for any
  `stop` whose success is inferred from the call rather than from an observed `stopped`
  status. **Done 2026-09-08** (TASKS.md Task 29). Three defects found and fixed: no default
  timeout at the `_call` chokepoint; `stopGoldenImage` returning `status: "stopped"` from a
  zero exit alone; and `stopAndDelete` escalating to `--kill` only on a *thrown* stop, so a
  false success fell straight through to `delete` on a running VM.
