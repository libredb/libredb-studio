# granite4.1

`ollama pull granite4.1:<size>` · sizes supported: 8b, 30b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. The fastest family measured, and both supported sizes clear every surface.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **8b** | 5.3 GB | 6s | 10s | 7s | 11s | 16s | 5s | **11s** | 22s |
| **30b** | 17 GB | 16s | 42s | 21s | 31s | 26s | 26s | **26s** | 52s |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `granite4.1:8b`

**worked refusal examples.** A refused call comes back with a correctly-shaped one built from this run's own ledger. It knows what to record and cannot always build the object carrying it.

**empty-turn retry.** Its optimization runs were corrected once and then returned nothing at all — no call, no text. An empty turn reads as a model that stopped; asked again, the cell went 3/5 to 5/5.


### `granite4.1:30b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls — and it clears every surface on them.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
