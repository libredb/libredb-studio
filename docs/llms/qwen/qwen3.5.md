# qwen3.5

`ollama pull qwen3.5:<size>` · sizes supported: 9b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. One supported size, and the only model in the product with a turn limit of its own.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.5:9b | 5.8 GB | 31s | 31s | 52s | 21s | 26s | 1:38 | **33s** | 1:38 |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `qwen3.5:9b`

**a 150-second turn limit.** Five surfaces clear the shipped 90 seconds comfortably; its plan turn lands at 92 to 94. The limit stays 90 for every other model.

**empty-turn retry.** Its optimization runs stopped answering after being corrected, leaving no text behind.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
