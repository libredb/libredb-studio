# bonsai-2

`ollama pull bonsai-2:<size>` · sizes supported: 2b, 4b, 9b

Every size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30
runs. These are the smallest weights on this list — the 2b is 911 MB — and they are the clearest
case the project has that a family's answer cannot be inherited by its sizes: the three profiles
below share no field, and the fourth size does not clear the board at all.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bonsai-2:2b | 911 MB | 3:00 | 43s | 1:13 | 37s | 53s | 14s | **52s** | 5:24 |
| bonsai-2:4b | 1.6 GB | 25s | 1:11 | 37s | 29s | 58s | 59s | **46s** | 3:18 |
| bonsai-2:9b | 3.2 GB | 19s | 1:10 | 1:20 | 28s | 55s | 56s | **55s** | 1:53 |

**Size buys nothing here, and the 9b is the evidence.** Twice the 4b's weights reach the same six
verdicts nine seconds slower over the thirty runs. What the 9b does buy is consistency: its
slowest run is 1:53 where the 4b's is 3:18 and the 2b's is 5:24, so it is the size to take where
a long tail costs more than a median does.

**The 2b's spread is the widest of any model measured here.** Fourteen seconds to plan and three
minutes to investigate, on the same database and the same snapshot. Nothing about the question is
harder; the model simply re-reads before it will commit, and one of its investigate runs took
5:24. At 911 MB that is still the cheapest way onto this list, but it is a trade against the
clock rather than a free one.

## What it needs that the defaults do not give it

### `bonsai-2:2b`

**temperature 0.3, and both hold limits raised to five**, for optimize and analyze. At the
compiled temperature of 0 the two cells lost by restating one answer until the deadline; the
holds are what let a verdict be reconsidered rather than re-sent. Investigate and plan locked at
the compiled defaults, and the profile carries the pair across all six because a profile is one
settings object per model.

**Its operate cell is a fix rather than a setting.** It read 1/5 with forty refusals in one cell,
every one of them `claims.0.evidence.0.locator: too small` — a field that is optional on both
arms of the citation schema and whose own description invites leaving it out. The model was
right and the server was refusing it. With a blank `locator` dropped before the schema is asked
([`tools.ts`](../../../src/lib/agent/tools.ts)), the same cell reads 5/5 at the defaults. No
setting would have reached it, and three were tried first.

### `bonsai-2:4b`

**temperature 0.3, and both hold limits raised to five.** Plan earned the temperature alone and
optimize earned it with the holds; the profile carries the union of the two, and the four cells
that had locked at the compiled defaults were held under it rather than being left at settings
the product does not ship.

**This size caught a fault in the measurement, not in the model.** Its optimize cell spent eight
hours unable to close, and the cause was the driver: at 4/5 it re-ran the same configuration
indefinitely instead of treating a four-of-five as the variance it is. The cell locked the day
that loop was fixed, on a configuration it had already been given. Worth stating because the
eight hours are not a fact about `bonsai-2:4b`.

### `bonsai-2:9b`

**refusal examples**, for optimize. The cell lost to a report it could not get accepted rather
than to the clock, and showing the shape rather than naming the type is what closed it.

**no reasoning on its AGENT turns**, for operate and assess. Both cells spent their turns
thinking and arrived with nothing to file — the same illness `gemma4:12b` earned this switch for,
on the surfaces that deliberately do not get it by default. Quiet, operate runs in 28 seconds.

It does **not** carry temperature 0.3 or either hold limit, which both smaller sizes do, and they
do not carry `suppressAgentReasoning`. Three sizes of one family, three disjoint answers.

## The fourth size, and why it is not here

`bonsai-2:27b` reads **25 of 30**: five surfaces locked and plan at 0/5 across five
configurations, always losing `no-plan-evidence`. It is 8.3 GB, it is measurable, and it is not
supported, because five of six is not the bar these pages state. It is listed here so the gap is
a recorded reading rather than an omission.

## Where these figures are softest

**These three rows were measured between 17 and 22 October 2026, across four application builds
and on Ollama 0.40.6, which is not the single build the rest of this document was taken on.** The
cells were locked one at a time as the refusal fixes that unblocked them landed, which is why
they span builds at all. The settings each cell earned are the settings in the profile, and every
figure in the table above is re-read from the ledger of the run that earned it — but a reader
comparing these medians against a model measured in one unbroken pass is comparing across
engines, and the honest statement is that the scores are reproducible and the seconds are
approximate.

**The 2b's row rests on a code change in the same release.** Before the blank `locator` fix its
operate cell was 1/5; the table above is from after it. A deployment carrying these profiles
without that fix would not reproduce this row.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
