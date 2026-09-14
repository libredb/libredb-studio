# Qwen3-Coder

`ollama pull qwen3-coder:30b` · sizes supported: 30b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is the fastest model on this list — an 11-second median, with no surface slower than 16 seconds
— and it asks for nothing.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-coder:30b | 18 GB | 11s | 12s | 16s | 11s | 11s | 3s | **11s** | 0:21 |

Six surfaces inside a 5-second spread is the flattest profile on this list. The whole model —
thirty runs across six surfaces — was measured in under six minutes, which is less time than a
single assessment takes on the slowest model here.

## What it needs that the defaults do not give it

Nothing. Every cell cleared 5/5 on the compiled defaults at the first attempt, with no setting
spent and no cell re-read.

## Where these figures are softest

**Speed this far from the rest of the list invites the wrong inference.** Eleven seconds is what a
correct run costs on the embedded sample; it is not a claim about a database with a thousand
tables, where the catalog read alone is a different piece of work. What carries across is the
shape: this model calls a tool, reads the result, and files — it does not narrate, and it does not
stop to ask.

**It is a code model driving a database, which is the fit rather than a coincidence.** Every agent
surface here ends in a tool call with a strict argument shape, and the failures that cost other
models their cells are almost all argument-shaped: a string where an array belongs, a key under the
wrong name. This model made none of them across thirty runs.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
