# RETRACTED: "linked clones of `switchyard-golden-6` boot without Parallels Tools"

- **Filed:** 2026-09-08 (commit `531cfe7`)
- **Retracted:** 2026-09-08, same day, before any remediation was attempted.
- **Verdict:** not a defect. The reported behaviour is a known, documented property of
  linked clones of this golden, recorded in `README.md` almost a month earlier.

## What the original report claimed

That a fresh linked clone of `switchyard-golden-6` boots with
`GuestTools: state=not_installed`, that `prlctl exec` never opens a session against it,
that this blocks all Switchyard dispatch, and that last night's host update from Parallels
27.0.0 to 27.0.1 (2026-09-07 19:09) was the strong correlate.

## Why that was wrong

`README.md:288` already said so, and said it first:

> A **full** clone is required, not a linked one. An earlier attempt at this gate used a
> linked clone, which reported `GuestTools: state=not_installed` and so had no
> `prlctl exec` channel at all. Full clones carry working Guest Tools, and they are not the
> expensive option they sound like: APFS clonefile produced a 185 GB clone in 0.28-0.34 s
> consuming zero additional disk.

Dating puts this beyond doubt. The `state=not_installed` observation was committed in
`1101cc8` on **2026-08-13** and the full-clone requirement in `b666992` on **2026-08-14** —
about three and a half weeks before the 27.0.1 host update the original report proposed as
the cause. The behaviour predates the update entirely.

Dispatch also does not take the path that was tested.
`src/switchyard/runner/index.mjs:10447` requests `linked: !!dependencies.linkedCloneMeasurement`,
so a clone is linked only when a measurement receipt exists and is a full clone otherwise,
and `src/switchyard/auth/index.mjs:221` hardcodes `linked: false`. Both probes in the
original report were linked clones. The production path was never exercised.

## Method error worth keeping

Two clones reproduced the same result and that consistency was read as corroboration. It
was not: both probes shared the same wrong assumption, so the second could only confirm the
first. The check that would have caught it was cheap and was skipped — grepping the
project's own README for the observed string before proposing a cause for it. A version
skew was available as an explanation (`27.0.0-58628` guest vs `27.0.1-58670` host, real and
still true), and it was fitted to the symptom without first ruling out documented, expected
behaviour.

## What survives

- **The golden's Parallels Tools are genuinely outdated**: `27.0.0-58628` against a
  `27.0.1-58670` host. That is routine maintenance, not an outage, and it is not known to
  affect anything.
- **The Task 11 null result is unaffected** and stands on its own evidence: 200 real
  `start` and 200 real `snapshot-delete` mutations produced zero misfires against a
  documented 3.3% serial rate. That measurement never involved a clone.

No VM was modified. The golden was never booted, no tools were installed, and every probe
clone was deleted with the golden left at zero snapshots.

## Retraction confirmed empirically (2026-09-08 14:25)

A **full** clone of the same golden, booted on the same host, settles it:

```
State: running
GuestTools: state=installed version=27.0.1-58670
prlctl exec switchyard-fullclone-105219 /usr/bin/true  ->  exit 0
```

Guest tools are present and are the **current** build, matching the host exactly. So the
secondary claim in the original report — that the golden's tools are outdated at
`27.0.0-58628` — was also wrong. That string is a stale value recorded against the
*stopped* VM; the live report from a running full clone is `27.0.1-58670`. There is no
version skew and nothing to install. The Todoist follow-up row raised for it
(`6hRjV8MjcC7vMvrf`) is void for the same reason.

Dispatch was never broken. Both of the original probes used the one clone type documented
since 2026-08-13 as having no exec channel.
