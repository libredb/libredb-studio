# qwen2.5

`ollama pull qwen2.5:<size>` · sizes supported: 7b, 14b, 32b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The oldest model generation on this list, and the only family measured at three sizes where all
three clear — including the smallest model on the whole list, which is also the fastest.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **7b** | 4.7 GB | 6s | 10s | 5s | 9s | 5s | 2s | **6s** | 21s |
| **14b** | 9.0 GB | 17s | 35s | 1:03 | 18s | 13s | 1s | **18s** | 1:05 |
| **32b** | 19 GB | 19s | 28s | 29s | 28s | 16s | 3s | **20s** | 36s |

Every cell is 5/5, so the table says how long rather than whether.

**The 7b is the fastest model measured here and the second smallest.** Its median run is six
seconds, its slowest of thirty is 21, and no surface of its six takes ten. Nothing else on this
list combines those two figures; the models that match its median have tails five and ten times
longer. If the question is which local model to put in front of a user who is waiting, this is
the answer, and it takes 4.7 GB of disk to hold.

Assessment is where the 14b's minute goes: a passing assess run profiles a table and takes a full
minute, where its other five surfaces are done inside 35 seconds and its plan turn inside two. The
1:05 slowest run is an assess run, so the tail is that one cell rather than a general unsteadiness.
The 32b does not repeat it — its assess cell is 29 seconds and its slowest run of thirty is 36 —
which is the one place in this family where the larger model is the steadier one.

## What it needs that the defaults do not give it

### `qwen2.5:7b`

**One plan ask**, which no run of its five spent. It was driven with no entry of its own, so the
server offered the ask every plan run and its plans fenced a statement without being asked. The
number is recorded because it is the configuration the thirty runs were taken under, not because
a run needed it.

### `qwen2.5:14b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

### `qwen2.5:32b`

**One plan ask, and this one is load-bearing.** One of its five passing plan runs wrote its
statement only after being asked for it; the other four fenced one unprompted. Remove the ask and
the cell is 4/5 and this size is not supported.

## Why an older generation is on this list

[`qwen3`](qwen3.md) is represented here at three sizes and [`qwen3.5`](qwen3.5.md) at two, and both
of those needed settings written for them: `qwen3:8b` is the only sampled cell in the product,
`qwen3:14b` and `qwen3.5:4b` each needed a plan-turn setting. This one, a generation older and the
same 9 GB as `qwen3:14b`, arrived on the defaults. It is a useful correction to the assumption that
drove most of the measuring — that the newer or the larger model is the one to reach for. Neither
held here.

The two sizes added since say the same thing twice more. The 7b is a generation old, a third the
weight of the 14b, and it is the fastest model on this list at every one of the six surfaces. The
32b is twice the 14b's weight and matches it rather than beating it. Within this family, size buys
steadiness on one cell and nothing else.

[`qwen2.5-coder:14b`](qwen2.5-coder.md) is measured separately, and clears all six as well.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
