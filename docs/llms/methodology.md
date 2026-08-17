# How these numbers were produced

Read this before trusting a row in the tables. It says what was measured, on what,
how many times, and where the results stop being safe to generalise from.

## When, and against what

| | |
| --- | --- |
| Measured | 16–17 August 2026 |
| Application | LibreDB Studio at commit `907e83c` |
| Runtime | Ollama, OpenAI-compatible endpoint (`http://localhost:11434/v1`) |
| Database | the embedded SQLite sample (`seed:sqlite-embedded-sample`) |
| Evidence | every run's ledger, in `.workflow-data` |

Model behaviour changes when a family publishes a new build under the same tag, so
these results describe the tags as they were on those dates.

## The machine

| | |
| --- | --- |
| Hardware | Apple M5 Max, 48 GB unified memory |
| Storage | 2 TB SSD |
| Power | macOS high-power mode, on AC |

**This is a fast machine, and that is a limitation of these pages, not a feature of
them.** Every timing here is a best case. Nothing was measured on a laptop with
16 GB, and a reader with one should treat the pass/fail column as the transferable
part and the seconds column as a lower bound.

Power mode alone was worth 2.8x throughput on this machine, and it decided pass from
fail for one model — see [`qwen3.6`](qwen/qwen3.6.md). Before concluding anything
from a `model-timeout`, check it:

```bash
pmset -g | grep powermode     # 2 is high power
```

## The three questions

One question per workflow, the same wording for every model:

| Workflow | Question |
| --- | --- |
| Investigate | "What tables are in this database and how do they relate to each other?" |
| Operate | "What is currently happening on this database?" |
| Analyze | "Which part of the company costs us the most in salary?" |

A cell is a pass only when the run's goal verdict is `answered`. A run that ends
`succeeded` having answered nothing is a failure here, and the tables say which
shortfall it hit.

## One run per cell

**This is the weakest part of the method, and it matters.**

Each figure comes from a single run. That would be fine if these models were
deterministic, and they are not. The clearest evidence is in this very data set: one
captured request, replayed five times against `mistral-small3.2:24b`, produced three
runs that called tools and two that answered *"I don't have the necessary tools"* —
**60%**, from an identical request.

So:

* a single ❌ on a model that otherwise looks capable may be a sample, not a verdict
* a single ✅ on a model near the size floor may be luck
* the models the tables call unstable — `mistral-small3.2`, `lfm2` — are the ones
  where this matters most, and their pages say so

Where a result was reproduced (before and after a runtime fix, or across power
modes), the page says that explicitly. Treat everything else as one observation.

## What is not covered

* **Only Ollama.** Gemini and OpenAI deployments are not characterised here.
* **Only SQLite.** Agent mode reaches PostgreSQL and SQLite; the sample used is
  SQLite, and a large PostgreSQL schema changes what fits in the captured inventory.
* **Only three questions.** They exercise the three workflows, not the space of
  things a user will ask.
* **Answer correctness is largely unchecked.** The verifier checks that a run read
  something, presented it and cited it. Whether the SQL was the right SQL is a
  separate question, and where it was checked by hand the pages say what was found —
  including one model that passes with a figure that double-counts.

## Reproducing this

The procedure is in [`testing-your-own.md`](testing-your-own.md). If you run it on
different hardware, the numbers will differ; if the pass/fail column differs, that is
worth reporting, because it is the part these pages claim is portable.
