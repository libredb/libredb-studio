# gemma4

`ollama pull gemma4:<size>` · sizes supported: 12b, 26b, 31b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. The 26b is the size that carries this family, and the one whose ledger taught this project
what an empty completion looks like. The 12b is the smaller, faster one, and it is the model that
made the product learn to tell an agent turn to stop thinking. The 31b is the largest, the slowest
model on the whole roster, and the one that shows what this family's growth actually buys.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma4:12b | 7.6 GB | 4s | 24s | 21s | 14s | 11s | 2s | **11s** | 1:03 |
| gemma4:26b | 16 GB | 15s | 1:02 | 31s | 26s | 46s | 36s | **36s** | 1:32 |
| gemma4:31b | 19 GB | 26s | 6:18 | 3:34 | 1:33 | 2:12 | 3s | **1:47** | 6:38 |

Every cell is 5/5, so the table says how long rather than whether. The 12b is three times the
26b's speed at half its size, and it did not start out that way — see its note below.

**Size buys nothing here, and the 31b is the evidence.** Three more gigabytes than the 26b cost it
three times the median and six minutes on one cell, and every verdict it reaches the 12b reaches
too, in a tenth of the time. Its optimize cell alone runs longer than a whole 12b sweep. Take it
only if this exact model is what you have to run; otherwise the 12b is the same family answering
the same six questions.

## What it needs that the defaults do not give it

### `gemma4:12b`

**no reasoning on its AGENT turns, and this is the model that setting was written for.** Its
investigate cell read 5/5 at 9 seconds on one serving engine and 1/5 on the next, and the four
losses share a signature: the whole turn spent without invoking a single tool, then the clock.
The passing runs still finished in 9. Bimodal — it either answers at once or thinks until the
wall.

Nothing that already existed reached it. A longer turn does not: measured at 150 seconds the cell
read 1/5 again, the losses simply longer, because a turn spent thinking finds the new wall too.
The switch that does is the one this model earned — the same remedy the plan turn already had,
on the surfaces it deliberately did not reach.

**no reasoning on its plan turn** either, and **a 150-second turn** for the two cells that lose to
the clock while working rather than while thinking.

**What the settings bought is not only the four cells.** Every cell got faster, several by most of
their length: analyze 102s to 11s, assess 118s to 21s, operate 75s to 14s, investigate 9s to 4s.
It arrived at 2/6 and 15/30 and leaves at 6/6 and 30/30, three times faster than the 26b.

### `gemma4:31b`

**no reasoning on its plan turn.** That cell read 0/5 at the defaults, losing to the clock rather
than to the plan — the model spends the turn thinking and the deliverable never arrives. Quiet, it
answers in three seconds, the fastest plan turn in this family, and the cell locked on the second
attempt. The switch reaches plan turns only (`suppressesPlanReasoning` is read where the mode is
not `agent`, in [`investigation.ts`](../../../src/lib/agent/investigation.ts)), so it is not what
carried the five agent surfaces.

**a 150-second turn**, for optimize and only because of optimize: a passing optimize run takes six
minutes against a 26-second investigation, and at the compiled 90-second ceiling the cell would not
close.

Those two were earned separately, which left five cells locked at the 90-second ceiling while the
profile that ships carries 150. Raising a per-call ceiling is not obviously free — a turn cut at 90
is re-asked, while a turn allowed 150 spends that from the run's own deadline instead — so the five
were read again under the pair that ships: twenty-five runs, every surface 5/5. The figures in the
table above are from those runs.

It does **not** carry `suppressAgentReasoning`, which its 12b sibling does. That setting was
measured for an illness this size does not have, and a setting a model did not earn is a guess.

### `gemma4:26b`

**call ceiling of 10.** It reads more thoroughly than a run has room for: eleven calls in, with nothing left to spend a twelfth on.

**empty-turn retry.** Fifteen measured losses on one cell to a turn that came back empty. Two other fixes were tried on the wrong reading of it first and made the cell worse; this took it to 5/5.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
