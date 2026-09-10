# qwen3.6

`ollama pull qwen3.6:<size>` · sizes supported: 27b, 35b

Both sizes run **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
Every cell it used to lose, it lost to the clock and to nothing else — and moving the clock did
not only win those cells, it made the ones that already passed measurably faster.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.6:27b | 17 GB | 26s | 238s | 216s | 68s | 82s | 20s | **82s** | 4:12 |
| qwen3.6:35b | 22 GB | 8s | 19s | 18s | 7s | 13s | 2s | **13s** | 0:29 |

Optimize and assess are the 27b's two dear cells: a passing assessment there runs three and a half
minutes. Plan at 20 seconds is the same cell that used to time out at 90, five times over.

**The larger size is the faster one, by six times, and that is the finding worth carrying out of
this page.** The 35b is five gigabytes bigger and its median run is 13 seconds against the 27b's
82. Nothing about the weights explains that; the settings do. Both carry the same pair of
reasoning suppressions, and the 35b spends none of its turn thinking on either surface class,
while the 27b's figures were taken before the agent-side suppression was added to it. Size is a
poor predictor of speed here compared with whether a model is being asked to think in a place the
run cannot use.

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

### `qwen3.6:35b`

**the 27b's set, taken whole.** This size was measured with exactly what its sibling ships —
`suppressPlanReasoning`, `suppressAgentReasoning` and a 150-second turn limit — and that was not a
guess carried over: optimize had refused to close across three sweeps and four separate levers,
reading 4/5, 3/5, 4/5, 3/5, 4/5 and 2/5, with every loss a `model-timeout` at 200 to 350 seconds
having already called two or three tools. Raising the turn ceiling alone did not do it. The pair
did, on the first reading, and the runs fell from 200-350 seconds to 13-29.

**The other five cells were then read again under it.** They had locked without the agent-side
suppression, which reaches all five agent surfaces — so none of them had been measured under what
ships. All five held at 5/5, and the table above reports those runs rather than the earlier ones.

**It is one of the six models that cannot be loaded without a context bound.** Every figure here
was taken with `OLLAMA_CONTEXT_LENGTH=32768` on the server; unbounded it asks for more memory than
a 64 GB machine has. See [`setup.md`](../setup.md).

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
