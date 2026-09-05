# cogito

`ollama pull cogito:<size>` · sizes supported: 14b, 32b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The 14b is the fastest six-surface sweep on record here — all thirty runs finished in ten minutes.
The 32b spent weeks recorded as unsupported for one cell it could not close, and the cell turned
out to be the server's.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **14b** | 9.0 GB | 4s | 13s | 18s | 13s | 8s | 6s | **11s** | 20s |
| **32b** | 19 GB | 21s | 23s | 32s | 31s | 23s | 4s | **23s** | 39s |

Every cell is 5/5, so the table says how long rather than whether.

The 14b's 20-second slowest run is the shortest on this list, and that is the figure worth choosing
on rather than the median: several models match 11 seconds in the middle and then have a tail three
or five times longer. Nothing this model did on thirty runs took twice its median.

The 32b holds the same shape at twice the weight — a 39-second slowest run against a 23-second
median — and buys nothing for it. Both sizes are supported; the 14b is the one to reach for.

## What it needs that the defaults do not give it

### `cogito:14b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

### `cogito:32b`

**One plan ask, and this one is load-bearing.** One of its five passing plan runs wrote its
statement only after being asked for it; the other four fenced one unprompted. Remove the ask and
the cell is 4/5 and this size is not supported.

## What the 32b's plan cell was, and what it turned out to be

This page recorded the 32b as unsupported, in these words: *five surfaces read 5/5 on the first
attempt; planning read 0/5, then 1/5, then 0/5 three more times across five configurations.* The
loss was always `no-statement` — the model discusses the plan and never writes the runnable
statement the surface is scored on — and five configurations of sampling, reasoning suppression and
turn budget moved none of it.

The server had a notice written for exactly that loss and did not send it. The notice was offered
only to a model whose profile asked for it, and a model nobody has measured has no profile, so the
one model that most needed the ask was the one guaranteed not to get it. Asking whoever produced
neither statement nor refusal closed the cell on the next attempt: 5/5 at the defaults, one of the
five a run that was asked.

Nothing about the model changed. What is recorded here is a measurement that was reading the
server, and this size now clears all six.

## The smallest size is not supported

**`cogito:8b` never files a report.** Its investigation cell read 0/5 twice, ten runs, every one
the same: `no-report`, stopped by the turn limit. It works the database and runs out of turns
still working. The refusal wording added alongside these measurements did not move it — the second
0/5 is the read taken after that change — so it is recorded as measured and unfixed rather than
untried.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
