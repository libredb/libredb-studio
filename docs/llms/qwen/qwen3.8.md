# qwen3.8

`ollama pull qwen3.8:<size>` · sizes supported: latest

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. Among the slowest on this list, and it reaches the same verdicts as models six times faster.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3.8:latest | 19 GB | 31s | 2:19 | 2:50 | 1:12 | 1:38 | 57s | **1:12** | 3:15 |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `qwen3.8:latest`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
