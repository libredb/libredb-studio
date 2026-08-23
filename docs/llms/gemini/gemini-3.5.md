# gemini-3.5

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. The one hosted model of the ten, measured exactly as the nine local ones were.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-3.5-flash-lite | — | 6s | 11s | 16s | 10s | 6s | 6s | **10s** | 21s |

Every cell is 5/5, so the table says how long rather than whether.

## What it needs that the defaults do not give it

### `gemini-3.5-flash-lite`

**empty-turn retry.** Its single loss in thirty: the report refused once, held for the plan the surface wants, and then nothing returned.


---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
