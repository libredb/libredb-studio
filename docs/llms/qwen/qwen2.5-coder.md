# qwen2.5-coder

`ollama pull qwen2.5-coder:<size>` · sizes supported: 14b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The only code-specialised model on this list, and it arrived by being tried after the reasoning
that excluded its whole class turned out to be wrong.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **14b** | 9.0 GB | 29s | 34s | 21s | 17s | 10s | 1s | **20s** | 37s |

Every cell is 5/5, and every cell closed on its first attempt.

Its one-second plan turn is the fastest on this list, and the shape of the whole model is in that
figure beside the 29 seconds it spends investigating: asked to write a statement it answers at once,
asked to go and read a database it takes longer than its general-purpose sibling of the same size.

## What it needs that the defaults do not give it

### `qwen2.5-coder:14b`

**One plan ask**, which no run of its five spent. It was driven with no entry of its own, so the
server offered the ask on every plan run and its plans fenced a statement without being asked. The
number records the configuration the thirty runs were taken under; nothing here needed it.

## Why a code model was not expected to clear this

The agent surfaces are not code generation. A run reads a database through tools, holds what came
back, and files a report whose claims cite the readings — the SQL it writes along the way is a
means, and a model that writes beautiful SQL and never calls a tool answers nothing here. On that
reasoning the coder families were set aside as a class and none was measured.

The reasoning was sound and the conclusion was wrong. This model matches [`qwen2.5:14b`](qwen2.5.md)
— same generation, same size, same 9 GB — cell for cell, and beats it on assessment by two thirds
of a minute. What the surfaces ask for is instruction-following against a tool schema, and a model
tuned to emit exactly-shaped code turns out to be good at exactly-shaped tool calls.

One size is measured, so this is one data point and not a claim about coder models generally. It is
recorded because it is the one that falsified the exclusion.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
