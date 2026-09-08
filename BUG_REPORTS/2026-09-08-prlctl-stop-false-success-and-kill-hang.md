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
  status. Not yet done.
