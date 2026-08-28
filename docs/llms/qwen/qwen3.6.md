# qwen3.6

`ollama pull qwen3.6:<size>` · sizes supported: 27b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
Every cell it used to lose, it lost to the clock and to nothing else — and moving the clock did
not only win those cells, it made the ones that already passed measurably faster.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.6:27b | 17 GB | 26s | 238s | 216s | 68s | 82s | 20s | **82s** | 4:12 |

Optimize and assess are the two dear cells: a passing assessment here runs three and a half
minutes. Plan at 20 seconds is the same cell that used to time out at 90, five times over.

## What it needs that the defaults do not give it

### `qwen3.6:27b`

**no reasoning on the plan turn.** The plan cell was 0/5, and all five losses were one run
repeated: `model-timeout` at exactly 90 seconds, no tool invoked, `no-plan`. The turn was spent
thinking rather than answering. This is `muse-glimmer:latest`'s measured case and `gemma4:12b`'s
after it; the same five runs then finish in 16 to 24 seconds.

**a 150-second turn limit.** Optimize was 1/5 and assess 2/5, and every loss in both was a
`model-timeout`. Its passing optimizations take four minutes and its assessments three and a half,
so 90 seconds a turn is the wrong statement about this model rather than the model being wrong.

## Where these figures are softest

**The settings did more than close the three cells — they sped up the other three.** Investigate
went from 51 seconds to 26, operate from 102 to 68, analyze from 110 to 82, with no change to
those cells' verdicts. A model that is not racing a limit it cannot meet finishes sooner, and
nothing in the shipped configuration made that visible before the limit moved.

**Assess was read twice.** The first pass gave 4/5, its one loss a `model-timeout` at 252 seconds;
a second read of the same cell at the same setting gave 5/5. The table reports the five
consecutive passes, and the outlier is recorded here rather than dropped: this cell sits closest
to its limit of any in the model, and a reader running it on a slower machine should expect the
loss the second pass did not repeat.

**It is one of the six models that cannot be loaded without a context bound.** Every figure here
was taken with `OLLAMA_CONTEXT_LENGTH=32768` on the server; unbounded it asks for more memory than
a 64 GB machine has. See [`setup.md`](../setup.md).

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
