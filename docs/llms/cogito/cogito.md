# cogito

`ollama pull cogito:<size>` · sizes supported: 14b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The fastest six-surface sweep on record here — all thirty runs finished in ten minutes — and the
only family measured at three sizes where the middle one is the only one that clears.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **14b** | 9.0 GB | 4s | 13s | 18s | 13s | 8s | 6s | **11s** | 20s |

Every cell is 5/5, so the table says how long rather than whether.

Its 20-second slowest run is the shortest on this list, and that is the figure worth choosing on
rather than the median: several models match 11 seconds in the middle and then have a tail three
or five times longer. Nothing this model did on thirty runs took twice its median.

## What it needs that the defaults do not give it

### `cogito:14b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

## The other two sizes are not supported, in opposite directions

**`cogito:8b` never files a report.** Its investigation cell read 0/5 twice, ten runs, every one
the same: `no-report`, stopped by the turn limit. It works the database and runs out of turns
still working. The refusal wording added alongside these measurements did not move it — the second
0/5 is the read taken after that change — so it is recorded as measured and unfixed rather than
untried.

**`cogito:32b` fails one cell and only one.** Five surfaces read 5/5 on the first attempt;
planning read 0/5, then 1/5, then 0/5 three more times across five configurations. The loss is
always `no-statement` with the model stopping on its own — it discusses the plan and never writes
the runnable statement the surface is scored on. Five sixths is not the claim this product makes,
so 25 of 30 is not listed as supported.

Both are the same finding from either side: on this family the 14b is the size that works, and
neither the smaller nor the larger sibling is a safe substitute for it.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
