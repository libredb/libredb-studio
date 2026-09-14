# Magistral

`ollama pull magistral:24b` · sizes supported: 24b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is Mistral's reasoning model, and it is the fastest 24B on this list by a wide margin — a
22-second median against the 78 seconds of the nearest model of its size.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| magistral:24b | 14 GB | 24s | 30s | 18s | 20s | 29s | 5s | **22s** | 0:47 |

Its surfaces are unusually level: the slowest cell is 30 seconds and the fastest agent cell is 18,
where most models on this list spread across a factor of five. Assess, which is the dearest surface
for almost every other model, is this one's second cheapest.

## What it needs that the defaults do not give it

### `magistral:24b`

**a second report reminder.** Analyze read 2/5 on the defaults, and both losses were the same run:
two or three readings taken, then `model-stopped` with prose instead of a report and the verdict
`no-report`. Across the five runs the drive issued three reminders in total, so the one-reminder
bound was being reached rather than ignored. With a second, the cell read 5/5 and has not lost a
run since. A model that narrates where it should file is the shape this setting exists for; a model
that never read anything is not, and this one had read.

## Where these figures are softest

**One setting, and it was found on the cell it fixes.** The other five surfaces cleared on the
compiled defaults at the first attempt, so the cell that needed the reminder is also the only one
whose configuration differs from the one it shipped under. `reportReminderLimit` does not reach the
plan surface at all, so the five cells measured before it were not measured under something they
now carry.

**Reasoning is left on.** Two models on this list needed it suppressed to clear the plan surface,
and this one's plan cell is 5 seconds with it on — the fastest plan on the roster. Nothing was
gained by touching it, so nothing was touched.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
