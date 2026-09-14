# GLM-4.7-Flash

`ollama pull glm-4.7-flash` · sizes supported: the single `latest` tag

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is Zhipu's model and the first Zhipu model on this list.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| glm-4.7-flash:latest | 19 GB | 14s | 38s | 58s | 39s | 37s | 5s | **34s** | 1:25 |

Four of the six surfaces sit between 37 and 58 seconds, and the two that do not are the extremes:
a 14-second investigation and a 5-second plan.

## What it needs that the defaults do not give it

### `glm-4.7-flash:latest`

**no reasoning on the plan turn.** The plan cell read 4/5, then 3/5, then 0/5, and in the 0/5 every
one of the five runs ended `model-timeout` at exactly 90 seconds with zero tools invoked and no
text at all: the turn was spent thinking rather than answering. With plan reasoning suppressed the
same five runs finish in 5 to 7 seconds. Ninety seconds to five is the largest single change any
setting makes on this list.

**a 150-second turn limit.** Carried alongside the suppression rather than instead of it — the plan
cell's timeouts are what earned it, and the agent surfaces keep the headroom.

**a second report reminder.** Optimize was the last cell and it sat at 4/5 across ten rolls, always
losing exactly one run, always the same way: the model called `inspect_schema`, was reminded once
to report, and answered the reminder by asking the user to paste the statement it had been sent to
diagnose — and then stopped. There is nobody on the other end of an agent run, so the question is
the end of it. One reminder was all the run had. With a second, the cell closed on the third roll.

**Not the agent-side reasoning suppression, and that is a measurement rather than an omission.**
Its sibling setting closes the plan cell; the agent-side one was tried on optimize and made it
WORSE — 0/3 against 4/5 without it, the model running eleven calls deep and past `compare_plans`
every time. The two are separate fields precisely because they reach separate modes, and here only
one of them is wanted.

## Where these figures are softest

**Three settings, and the cells were not all measured under the final three.** `suppressPlanReasoning`
reaches the plan turn only, and `reportReminderLimit` does not reach the plan surface at all, so no
cell in the table above was measured under something that changes it. `turnTimeoutMs` raises a
ceiling rather than altering behaviour: a run that finished inside 90 seconds finishes inside 150
unchanged.

**Its optimize cell is the one that took the work.** Ten rolls at 4/5 before the reminder closed it,
and the losing run was never a capability failure — the model had read the schema and knew what it
wanted. What it did with the turn was ask a question, and the drive has no answer to give it.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
