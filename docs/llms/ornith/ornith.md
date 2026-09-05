# ornith

`ollama pull ornith:<size>` · sizes supported: 9b, 35b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. The 9b clears every surface with no setting of its own beyond a single extra plan turn. The
35b is the slowest supported model on this list and needs both reasoning suppressions to get there.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ornith:9b | 5.5 GB | 20s | 36s | 51s | 21s | 16s | 31s | **31s** | 1:58 |
| ornith:35b | 21 GB | 1:37 | 55s | 50s | 16s | 28s | 37s | **36s** | 2:30 |

Every cell is 5/5, so the table says how long rather than whether.

The 35b is the slowest model this list supports, and its investigation cell is where the time
goes: a minute and a half against the 9b's twenty seconds for the same question and the same
answer. Four times the weight buys nothing measurable here, and the 9b is the size to reach for.

## What it needs that the defaults do not give it

### `ornith:9b`

**one extra plan turn.** Its plans describe the schema correctly and completely and stop one sentence short of the runnable statement the surface is scored on.

### `ornith:35b`

**Both reasoning suppressions, and one extra plan turn.** Its plan cell read 0/5 twice at the
defaults, and the loss was the clock rather than the plan — it spends the turn thinking and the
deliverable never arrives. Quiet, it answers in 37 seconds. The plan-turn switch alone did not
close the cell; the pair did.

The extra plan turn is load-bearing here too: one of its five passing plan runs wrote a statement
only after being asked for one.

## Why the 35b was measured twice

The sweep locks a cell against whatever settings were in force when it closed, and it moves
settings between cells. This model closed plan and investigate with both suppressions on and its
other four surfaces at the defaults — but a bundled profile carries ONE set for all six, so
shipping the pair would have put four surfaces out under settings no run of theirs had used.

They were read again with the pair on rather than described as something they had not been
measured as: assess, operate and analyze read 5/5, and optimize read 4/5 and then 5/5 on a
re-roll. The figures in the table above are from those runs.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
