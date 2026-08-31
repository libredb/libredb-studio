# granite4.2

`ollama pull granite4.2:<size>` · sizes supported: 8b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. It carries no settings at all — the second model measured to need none.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **8b** | 5.3 GB | 28s | 1:12 | 1:29 | 19s | 45s | 33s | **46s** | 1:56 |

Every cell is 5/5, so the table says how long rather than whether.

Slower than `granite4.1:8b` on the same disk footprint — four times the median — and it is the
same six verdicts at the end. Take 4.1 unless you have a reason to prefer this one.

## What it needs that the defaults do not give it

### `granite4.2:8b`

Nothing. Measured at the defaults — temperature 0, top_p 1, a ceiling of twelve unreported calls,
the shipped 90-second turn limit — and it clears every surface on them.

It still has an entry in the measurement document, and that is deliberate: an absent entry records
no measurement rather than a measurement that found nothing to change, and a model nobody can see
was measured is a model nobody can trust.

## Where it is thin

**Assess re-read 4/5 on a second sitting**, having locked at 5/5 on the first. The loss was a
report the run never composed, not a wrong answer. Both readings are on record and the cell is
counted as passing; a figure that reads steadier than the model is worse than one that says where
it is thin.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
