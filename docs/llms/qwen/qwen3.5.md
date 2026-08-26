# qwen3.5

`ollama pull qwen3.5:<size>` · sizes supported: 4b, 9b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. Two supported sizes, and the 9b is the only model in the product with a turn limit of its
own.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:4b | 3.4 GB | 6s | 44s | 33s | 11s | 13s | 2s | **11s** | 2:36 |
| qwen3.5:9b | 5.8 GB | 31s | 31s | 52s | 21s | 26s | 1:38 | **33s** | 1:38 |

Every cell is 5/5, so the table says how long rather than whether. The 4b's slowest run is its
optimization cell, which is also the one that did not reproduce at 5/5 on a later sweep - see
below.

## What it needs that the defaults do not give it

### `qwen3.5:4b`

**no reasoning on the plan turn.** Its plan cell was 0/5 at the defaults, and every loss was a
`model-timeout` with an empty ledger: asked for one statement against a Studio-sized prompt it
returns 13 188 characters of reasoning against 1 165 of content, in 48 seconds. With
`reasoning_effort: "none"` the same five runs finish in 2 to 6. Applied to the plan turn only -
its five agent surfaces were all measured WITH reasoning and pass as they are.

### `qwen3.5:9b`

**a 150-second turn limit.** Five surfaces clear the shipped 90 seconds comfortably; its plan turn lands at 92 to 94. The limit stays 90 for every other model.

**empty-turn retry.** Its optimization runs stopped answering after being corrected, leaving no text behind.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
