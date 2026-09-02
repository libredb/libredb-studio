# qwen2.5

`ollama pull qwen2.5:<size>` · sizes supported: 14b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The oldest model generation on this list, and it needs nothing that the newest ones do not.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **14b** | 9.0 GB | 17s | 35s | 1:03 | 18s | 13s | 1s | **18s** | 1:05 |

Every cell is 5/5, so the table says how long rather than whether.

Assessment is where its minute goes: a passing assess run profiles a table and takes a full minute,
where its other five surfaces are done inside 35 seconds and its plan turn inside two. The 1:05
slowest run is an assess run, so the tail is that one cell rather than a general unsteadiness.

## What it needs that the defaults do not give it

### `qwen2.5:14b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

## Why an older generation is on this list

[`qwen3`](qwen3.md) is represented here at three sizes and [`qwen3.5`](qwen3.5.md) at two, and both
of those needed settings written for them: `qwen3:8b` is the only sampled cell in the product,
`qwen3:14b` and `qwen3.5:4b` each needed a plan-turn setting. This one, a generation older and the
same 9 GB as `qwen3:14b`, arrived on the defaults. It is a useful correction to the assumption that
drove most of the measuring — that the newer or the larger model is the one to reach for. Neither
held here.

`qwen2.5:7b` and `qwen2.5:32b` have not been measured. They are absent rather than rejected.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
