# muse-glimmer

`ollama pull muse-glimmer:latest` · sizes supported: the single `latest` tag

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is the slowest model on this list by a wide margin, and it needs more settings than any other
model in the product — three, for three different failures.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| muse-glimmer:latest | 18 GB | 103s | 191s | 167s | 80s | 115s | 17s | **115s** | 4:45 |

A passing assessment here calls eleven tools and takes two and a half minutes. Plan at 17 seconds
is the outlier, and it is the outlier only because of the setting below — the same cell was five
timeouts before it.

## What it needs that the defaults do not give it

### `muse-glimmer:latest`

**no reasoning on the plan turn.** The plan cell was 0/5, and all five losses were one run
repeated: `model-timeout` at exactly 90 seconds, an empty ledger, no tool invoked, `no-plan`. The
turn was spent thinking rather than answering. With reasoning suppressed the same five runs finish
in 16 to 21 seconds. The same shape closed the plan cell of two other models on this list.

**a 150-second turn limit.** Two more cells lost to the clock and to nothing else: investigate
4/5 with the single loss a `model-timeout` at 159s against passes at 102 to 116, and assess 4/5
with the single loss at 160s against passes at 141 to 163. For a model whose passing runs take two
minutes, 90 seconds a turn is the wrong statement about it rather than the model being wrong.

**a second report reminder.** With the clock no longer the constraint, assess still lost one run —
and to a different failure: `model-stopped` with `no-report` at 105 seconds having called fourteen
tools, where the timeout losses used to run past 160. A run holding fourteen readings that files
none of them took its one reminder and stopped again, which is the distinction between a model
that forgot and one that stops as its habit.

## Where these figures are softest

**Three settings on one model is the widest set here, and the cells were re-read together to earn
it.** Each setting was found on the cell it fixes, which means each was found under a different
configuration from the one that ships. So all six surfaces were measured again in a single pass
under the final three, and that pass is what the table above reports: 30 of 30, no losses.

One run of that pass ended `model-unavailable` — the server did not answer. That is a serving
outage rather than a verdict, so the cell was re-read clean instead of being scored with a gap in
it. Worth stating because the distinction is invisible in a pass/fail count and was, for an hour,
misread here as a lost cell.

**It is slow enough that the choice is a real one.** At a 115-second median it reaches the same
verdicts as models a tenth its speed. Nothing about the six cells is marginal once the settings
are in place; what a reader is trading is minutes.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
