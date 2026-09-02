# qwen3.5

`ollama pull qwen3.5:<size>` · sizes supported: 4b, 9b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **4b** | 3.4 GB | 5s | 41s | 21s | 7s | 34s | 1s | **11s** | 2:47 |
| **9b** | 5.8 GB | 31s | 31s | 52s | 21s | 26s | 1:38 | **33s** | 1:38 |

Every cell is 5/5, so the table says how long rather than whether.

The 4b is three times the 9b's speed at two thirds of its disk, which is not the direction size
usually runs. Its tail is the price: 2:47 against the 9b's 1:38.

## What it needs that the defaults do not give it

### `qwen3.5:4b`

**no reasoning on the plan turn.** Its plan turns timed out on every run with an empty ledger —
nothing called, nothing said. Suppressing the reasoning request finished the turns and moved the
cell 0/5 to 1/5. It reaches the OpenAI-compatible adapter only, so it is a no-op on `gemini`.

The other four losses were not the model's, and this is the only cell in the product closed by
fixing Studio's own wording. It had been writing correct refusals — naming the views whose columns
the inventory cannot derive, then asking the one question that would unblock it — and opening every
one with `NO STATEMENT AT ALL:`, which is the phrase the planning rule itself put in front of the
marker it was teaching. The rule now says it once, and the cell read 5/5 on the first pass after.

## Where it is thin

**The 4b's data-analysis re-read 3/5 on a second sitting**, having locked at 5/5 on the first. The
cell has locked repeatedly and is counted as passing; both readings are on record, because a figure
that reads steadier than the model is worse than one that says where it is thin. If you drive this
size on data-analysis, expect it to need a second attempt more often than the table's 11s suggests.

### `qwen3.5:9b`

**a 150-second turn limit.** Five surfaces clear the shipped 90 seconds comfortably; its plan turn lands at 92 to 94. It was the first model to need it and is now one of six that carry it; the limit stays 90 for the other sixteen.

**empty-turn retry.** Its optimization runs stopped answering after being corrected, leaving no text behind.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
