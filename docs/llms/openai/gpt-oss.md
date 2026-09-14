# gpt-oss

`ollama pull gpt-oss:20b` · sizes supported: 20b

The size listed here runs **all six agent surfaces**, five consecutive times each: 30 of 30 runs.
It is OpenAI's open-weight model and the first OpenAI model on this list.

## What it does, and how long it takes

Seconds are the median of the runs that passed, per surface.

| Size | Disk | Investigate | Optimize | Assess | Operate | Analyze | Plan | Median | Slowest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-oss:20b | 13 GB | 19s | 78s | 142s | 30s | 31s | 16s | **37s** | 2:49 |

Assess is this model's dear cell at a factor of seven over its investigation, and optimize is the
second. The other four finish in half a minute or less.

## What it needs that the defaults do not give it

### `gpt-oss:20b`

**no reasoning on the agent turns.** With reasoning on, four of the six surfaces lost runs to turns
spent thinking rather than answering. Suppressed, the same cells cleared — and this is the
agent-side suppression, which reaches all five agent surfaces, so every cell in the table above was
read under it rather than inherited from a measurement taken without it.

**sampling of its own on optimize.** The query-optimization cell alone carries `temperature: 0.8`
and `topP: 0.9`, against the zero temperature every other surface uses. At zero it produced the
same rewrite as the statement it was given, over and over, and a comparison of a plan with itself
is refused — correctly — so the cell could not close. Enough spread to make it write a different
statement was what closed it. The setting is scoped to that one workflow: the other five surfaces
want determinism and get it.

## Where these figures are softest

**The assessment cell is the one to watch.** At a 142-second median it is nearly five times this
model's overall median, and it is the cell that was slowest to stabilise. It reads 5/5 now, and it
read 1/5 once on a build whose refusal text was less precise — which is a fact about the drive
rather than about this model, but it is the reason the cell was measured more times than any other
here.

**Per-workflow sampling is rare and it is worth knowing it is in force.** One model on this list
carries a sampling override, and this is it. On a database where optimize behaves unexpectedly,
that override is the first thing to look at, because it is the only place any model on this roster
runs at a non-zero temperature.

---

Method, and where these numbers stop being safe to generalise from:
[`methodology.md`](../methodology.md).
