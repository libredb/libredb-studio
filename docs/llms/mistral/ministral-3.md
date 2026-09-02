# ministral-3

`ollama pull ministral-3:<size>` · sizes supported: 8b, 14b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. Mistral's first entry on this list, and both supported sizes cleared every surface on their
first attempt with nothing configured.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **8b** | 6.0 GB | 16s | 22s | 4s | 14s | 13s | 5s | **13s** | 26s |
| **14b** | 9.1 GB | 19s | 27s | 34s | 13s | 15s | 8s | **16s** | 56s |

Every cell is 5/5, so the table says how long rather than whether.

The 8b is the faster of the two everywhere except operate, and the gap is widest on assess — 4
seconds against 34. Between two sizes that both clear everything, the smaller one is the one to
take; the 14b is here because a family that clears six surfaces at one size is worth measuring at
the next, not because it does anything the 8b cannot.

## What it needs that the defaults do not give it

### `ministral-3:8b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

### `ministral-3:14b`

Nothing. Measured at the defaults, and it clears every surface on them.

## The 3b is not supported

`ministral-3:3b` locks three of the six — analyze, assess and plan — and does not lock investigate,
operate or optimize. It is not that it cannot answer them: across nine attempts at those three
cells it passed 20 of 45 runs, reading 4/5 on investigation once. The losses are one shape,
`no-report`: it reads the database, and then finishes the run without filing what it read. Five
consecutive is the bar precisely because a model that answers four times in five is not one to put
in front of a user, so the 3b is measured, recorded here, and not listed as supported.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
