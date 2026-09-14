# QwQ

`ollama pull qwq:32b` · sizes supported: 32b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is a reasoning model, it is the slowest model on this list, and it asks for nothing: every cell
cleared on the compiled defaults.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwq:32b | 19 GB | 69s | 189s | 208s | 75s | 70s | 61s | **76s** | 6:00 |

Optimize and assess are what a reader is buying time for: three and a half minutes each, against a
69-second investigation on the same model. The plan surface is 61 seconds where most models finish
it in under twenty, and that is the reasoning showing — this model thinks through a turn it is not
required to think through, and the answer is right when it arrives.

## What it needs that the defaults do not give it

Nothing. Every one of the six cells cleared 5/5 at the shipped defaults, including the 90-second
per-turn limit — which is worth saying plainly for a model whose assessment run takes three and a
half minutes. The limit is on a TURN, not on a run, and no single turn of this model's exceeded it.

## Where these figures are softest

**It is the slowest model here and the margin against the turn limit is the thinnest.** Its
assessment cell has passing runs at 208 seconds across roughly a dozen turns. None of those turns
came close to 90 seconds, but a database whose catalog is larger than the sample, or a question
that sends it deeper, would make the individual turns longer rather than merely more numerous. If
this model times out on a real database, the 150-second limit is the first thing to try; six other
models on this list carry one.

**Nothing about the settings is marginal, because there are none.** A model with an empty profile
is the easiest kind to reason about on an unfamiliar database: what is measured here is the model,
not a configuration around it.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
