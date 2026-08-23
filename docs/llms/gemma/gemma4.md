# gemma4

`ollama pull gemma4:<size>` · sizes supported: 26b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. The size that carries this family, and the one whose ledger taught this project what an empty completion looks like.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemma4:26b | 16 GB | 15s | 1:02 | 31s | 26s | 46s | 36s | **36s** | 1:32 |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `gemma4:26b`

**call ceiling of 10.** It reads more thoroughly than a run has room for: eleven calls in, with nothing left to spend a twelfth on.

**empty-turn retry.** Fifteen measured losses on one cell to a turn that came back empty. Two other fixes were tried on the wrong reading of it first and made the cell worse; this took it to 5/5.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
