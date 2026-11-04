# lfm3

`ollama pull lfm3:1.7b` · sizes supported: 1.7b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs,
on the settings the product already ships. At 1.7 GB it clears the board with no profile of its
own — nothing in it was tuned.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lfm3:1.7b | 1.7 GB | 43s | 4:13 | 1:58 | 1:23 | 1:09 | 36s | **84s** | 5:33 |

**It is slow for its size, and that is the trade rather than a defect.** An 84-second median
against the twenty and thirty seconds most of this list reaches, and an optimize cell that runs
past four minutes on weights a fraction of theirs. What it is not doing is skipping the work: the
passing runs in that cell call tools, read what comes back and cite it, which is the whole bar
these pages measure. Take it where the constraint is memory rather than latency.

**Its investigate cell shows the shape of the model.** Four of the five passing runs call no tool
at all, answering from the snapshot the run is given, and three of those finish inside 45
seconds; the fifth takes 4:32 and calls two. Same question, same snapshot. The median is honest
and the mean would not be.

## What it needs that the defaults do not give it

Nothing. Every cell locked on the compiled defaults — temperature 0, the shipped call ceiling and
the shipped reminder limits — and the profile records that rather than leaving the model
unlisted.

**Two cells needed a re-roll, which is not the same as needing a setting.** Assess and optimize
each read 4/5 first, and each locked at 5/5 on a second run of the same document. A four-of-five
at fixed settings is variance; tuning it would have bought a setting the model never needed and
a profile nobody could reproduce.

## Where these figures are softest

**It refuses to be pulled below Ollama v0.40.12**, and these runs were taken on 0.40.13 while
most of this document was measured on an earlier engine. The scores are what this model does; the
seconds are comparable within this page before they are comparable across it.

**Its long tail is long.** The slowest passing run on the table is 5:33 and the slowest
investigate run 4:32, against medians of 4:13 and 43s. Nothing in the thirty runs failed, but a
deployment sizing timeouts off the median column will cut runs this model would have finished.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
