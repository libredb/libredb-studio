# nemotron-3.5-lightning

`ollama pull nemotron-3.5-lightning:<size>` · sizes supported: 30b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
Five of the six clear the shipped turn limit untouched; the sixth needed the clock moved, and the
note below says what that cost.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nemotron-3.5-lightning:30b | 25 GB | 4s | 20s | 57s | 38s | 9s | 144s | **29s** | 2:25 |

Investigate at four seconds is the fastest first surface measured on a local model here. Plan at
144 is the slowest cell in the product, and it is the cell the setting below exists for.

## What it needs that the defaults do not give it

### `nemotron-3.5-lightning:30b`

**a 150-second turn limit.** Its five agent surfaces clear the shipped 90 seconds and nothing
about them is marginal — 4s, 20s, 57s, 38s and 9s against the limit. Its plan turn does not: at 90
the cell scored 4/5, and the one loss was a `model-timeout` on the first run after a cold load,
with zero tools invoked and the four passing runs landing within three seconds of each other at
67 to 69. A turn that never finished, rather than an answer that was wrong.

The value is the one `qwen3.5:9b` already carries for the same shape rather than a new number, and
it is per model: the limit stays 90 for everything else.

## Where these figures are softest

**Raising the limit did not just save the loss — it doubled the cell.** The plan turn's median
went from 67 seconds at a 90-second limit to 144 at a 150-second one, on the same objective
against the same database. Both ended `model-stopped`, so the model is not being cut off at either
setting: it spends the budget it is given.

So the honest statement about this cell is that it costs twice what it did and is now won rather
than lost. A reader choosing this model for plan work should budget from the 144, not from the 67
that appears in the sweep that preceded the setting.

The other five cells were re-measured at 150 seconds rather than carried over, because a turn
limit is read on every turn of every surface — all five stayed 5/5, and none of them moved by
enough to report.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
