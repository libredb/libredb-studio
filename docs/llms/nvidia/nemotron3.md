# nemotron3

`ollama pull nemotron3:<size>` · sizes supported: 33b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
The largest model in the product by a wide margin, and the only one that ended a run by asking
its user a question.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nemotron3:33b | 27 GB | 12s | 49s | 20s | 18s | 29s | 14s | **21s** | 1:59 |

Optimize is the cell that took twenty-eight runs across eight sittings to close, and it is the
one to read the note below about.

## What it needs that the defaults do not give it

### `nemotron3:33b`

**a retry when it stops having read nothing.** Twice it ended a run by asking for the data
instead of reading it — the clearer of the two ten seconds in, zero tools invoked, closing with
"Could you please share the exact SQL statement you're running for the employee listing?" while
holding `inspect_schema` and `inspect_plan`. A run has no user on the other end, so the question
is a stop. The drive now names the instrument once and gives the turn back.

Free to grant: `compose_report` is one of the tools the drive counts, so a run reaching that
point with nothing called has already earned `no-report`, and the turn is spent on a run that
has lost.

**worked refusal examples.** Three of its optimization losses are one refusal repeated until the
run runs out of time — `claims: expected array`, the same sentence each time, seven times in one
run. The example is built from the run's own ledger, so a model that copies it verbatim gets a
call that is accepted.

## Where these figures are softest

The optimization cell is **locked but marginal**, and every sweep since has said so: 5/5, 5/5,
4/5, 4/5, and 3/5 on a rested machine. Every loss has one signature — the turn after the last
tool call running long, at 90.0 s, 106 s, 172.7 s, 244.6 s and 430.8 s against a 90-second turn,
where the passing runs compose in 21 to 100.

A 150-second turn was measured against it directly (#500): five runs read 3/5
again, but one of them composed at **114 s** — a run the shipped limit would have killed. So the
limit is part of the answer and not all of it; what the runs actually show is a report turn whose
length varies by a factor of twenty on identical input. Assess shows the same shape at 3/5 on the
same sweep.

Recorded rather than smoothed: the pass/fail figures above are the measurement that locked the
cell, and these are what a later reader gets when they run it again.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
