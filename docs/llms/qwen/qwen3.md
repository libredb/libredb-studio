# qwen3

`ollama pull qwen3:<size>` · sizes supported: 8b, 14b, 4b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. Three sizes supported, and the smallest is not the fastest — size buys memory rather than speed on this workload.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **8b** | 5.2 GB | 10s | 1:18 | 46s | 36s | 46s | 26s | **36s** | 1:48 |
| **14b** | 9.3 GB | 15s | 3:10 | 1:22 | 46s | 31s | 21s | **41s** | 5:03 |
| **4b** | 2.5 GB | 41s | 2:04 | 1:13 | 1:12 | 1:43 | 46s | **1:12** | 2:40 |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `qwen3:8b`

**sampling on optimization only.** The only sampled cell in the product. At temperature 0 it opened with the wrong tool ten times out of ten; at 0.8 it opened with the right one and won. Its other five surfaces are deterministic.


### `qwen3:14b`

**one extra plan turn.** The model this setting was written for: five surfaces locked and plan lost four times in five, always for the same missing sentence.


### `qwen3:4b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
