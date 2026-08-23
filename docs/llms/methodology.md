# How these numbers were produced

Read this before trusting a row in the tables. It says what was measured, on what, how many
times, and where the results stop being safe to generalise from.

## When, and against what

| | |
| --- | --- |
| Measured | 22–23 August 2026 |
| Application | one build, measured whole — no figure here predates it |
| Runtime | Ollama on an OpenAI-compatible endpoint (`http://localhost:11434/v1`), and the Gemini API for the one hosted model |
| Database | the embedded SQLite sample (`seed:sqlite-embedded-sample`) |
| Turn limit | 90 seconds, which is what the product ships |
| Evidence | every run's ledger, in `.workflow-data` |

Model behaviour changes when a family publishes a new build under the same tag, so these results
describe the tags as they were on those dates.

## Six surfaces, five consecutive runs each

Each model was asked one question per surface, the same wording for every model, five times:

| Surface | Question |
| --- | --- |
| Investigate | "What tables are in this database and how do they relate to each other?" |
| Optimize | "Why is the employee listing query slow?" |
| Assess | "Where is this database's data incomplete or surprising?" |
| Operate | "What is currently happening on this database?" |
| Analyze | "Which part of the company costs us the most in salary?" |
| Plan | "What tables are in this database and how do they relate to each other?" |

Ten models, six surfaces, five runs: **300 runs, and all 300 passed.**

A run passes only when its goal verdict is `answered`. A run that ends `succeeded` having
answered nothing is a failure here, and the ledger names which bar it missed.

**Five CONSECUTIVE, and that is the whole point.** An earlier version of this method took one run
per cell, which is fine for deterministic software and these are not: cells that had passed once
came back 3 of 5 when asked again. One pass is a sample; five in a row is a claim about what
happens every time somebody asks.

## The machine

| | |
| --- | --- |
| Hardware | Apple M5 Max, 48 GB unified memory |
| Storage | 2 TB SSD |
| Power | macOS high-power mode, on AC |

**This is a fast machine, and that is a limitation of these pages rather than a feature of
them.** Every timing here is a best case. A reader on a 16 GB laptop should treat the pass/fail
column as the transferable part and the seconds as a lower bound.

Power mode alone was worth 2.8x throughput here, and it has decided pass from fail. Before
concluding anything from a `model-timeout`, check it:

```bash
pmset -g | grep powermode     # 2 is high power
```

### Sustained load is part of the measurement

Running all 300 back to back took three and a half hours and returned 252 of 270 on the local
models — and that number was about the laptop, not the models. `gemma4:26b` scored 1/5 on one
surface during the sweep at 87–93 seconds a run, and 5/5 an hour later at 36 seconds: same code,
same model, same cell, cooler machine. Five of that model's six surfaces slowed by half again
inside the sweep.

Every cell the sweep lost was re-measured on a rested machine, and that is where the figures here
come from. A long unbroken sweep measures thermal state as much as capability, which is worth
knowing before running one.

## The turn limit these numbers are taken at

90 seconds per model turn — the shipped default. Earlier figures for these models were taken at
150 while a measurement harness had it raised, and they are not carried over: two cells that were
called locked at 150 did not hold at 90, and both were withdrawn rather than kept with a
footnote.

One model asks for more time by name: `qwen3.5:9b` clears five surfaces inside 90 seconds and its
plan turn lands at 92 to 94, so its profile carries a 150-second limit and every other model
keeps the shipped one. That is on its page.

## Driven through the interface as well

The 300 runs above were opened over HTTP. A separate sweep drove all ten models through the
product's own rail — log in, pick the sample connection, type the objective, press Start, wait
for the run to finish on screen — one run per surface: **57 of 60 passed.**

The three that did not are the same shapes the ledger records anywhere else (`no-report`,
`no-plan`), and one run is not five, so the API sweep is the authority on rates. What the UI
sweep establishes is different and worth its own line: a person clicking through the product gets
the same result as a request does.

It also found something the API sweep could not. One surface asks for consent before the run
opens — `data-analysis` runs a statement the model wrote and presents the result — and a run
opened over HTTP passes that as a parameter, so no measurement had ever exercised the card the
user actually sees.

## What is not covered

* **One database.** The SQLite sample. A large PostgreSQL schema changes what fits in the
  captured inventory, and that is not measured here.
* **One question per surface.** They exercise the six surfaces, not the space of things a user
  will ask.
* **Answer correctness is largely unchecked.** The verifier checks that a run read something,
  presented it and cited it. Whether the SQL was the RIGHT SQL is a separate question.
* **One machine.** See above.

## Reproducing this

The procedure is in [`testing-your-own.md`](testing-your-own.md). If you run it on different
hardware the numbers will differ; if the pass/fail column differs, that is worth reporting.
