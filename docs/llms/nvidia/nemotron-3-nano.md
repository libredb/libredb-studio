# nemotron-3-nano

`ollama pull nemotron-3-nano:<size>` · sizes supported: 30b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
Five of the six locked on the first reading at the shipped defaults; the sixth needed the clock
moved, and the note below says what that cost.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nemotron-3-nano:30b | 24 GB | 11s | 2:08 | 51s | 32s | 1:22 | 33s | **46s** | 3:10 |

Every cell is 5/5, so the table says how long rather than whether.

Investigate at eleven seconds against optimize at over two minutes is the widest spread any
supported model shows. What it costs is wall-clock on one surface, not a verdict on any of them.

## What it needs that the defaults do not give it

### `nemotron-3-nano:30b`

**a 150-second turn limit.** Five surfaces clear the shipped 90 seconds — 11s, 51s, 32s, 1:22 and
33s against the limit — and query-optimization does not: at 90 the cell read 3/5, and both losses
were `model-timeout` with tools already invoked. A turn that never finished, rather than an answer
that was wrong.

The value is the one `qwen3.5:9b` and `nemotron-3.5-lightning:30b` already carry for the same
shape rather than a new number, and it is the product's ceiling: nothing here exceeds what Studio
already ships for a model that needs longer turns. One setting, because one is what it was
measured needing — everything else is the compiled default, and a setting a model did not earn is
a guess.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
