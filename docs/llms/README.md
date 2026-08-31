# Models in Agent mode

Which models drive an agent run, measured rather than assumed.

Agent mode asks a model to do something a chat model is never asked to do: call a tool, read what
comes back, call another, and finish by recording claims that cite what it read. A model that
writes beautiful prose about a database and never calls a tool answers nothing here. So the
question these pages answer is not what a model knows but what it DOES on a run, and every figure
comes from a run whose ledger is on disk.

**Eighteen models are supported.** Each cleared all six surfaces — Investigate, Optimize, Assess,
Operate, Analyze and Plan — five consecutive times: 540 runs, 540 passes.

Twelve of the eighteen cleared them at the 90-second per-turn limit the product ships. Six carry a
150-second limit of their own — `qwen3.5:9b`, `gemma4:12b`, `nemotron-3.5-lightning:30b`,
`nemotron-3-nano:30b`, `muse-glimmer:latest` and `qwen3.6:27b` — because one turn of theirs does
not fit inside 90 while every other surface does. The limit stays 90 for every other model, and
each page says what its model needed.

| Model | Served through | Disk | Median run | Slowest run |
| --- | --- | --- | --- | --- |
| [`gemini-3.5-flash-lite`](gemini/gemini-3.5.md) | Gemini API | — | 10s | 21s |
| [`gemma4:12b`](gemma/gemma4.md) | Ollama | 7.6 GB | 11s | 63s |
| [`granite4.1:8b`](granite/granite4.1.md) | Ollama | 5.3 GB | 11s | 22s |
| [`qwen3.5:4b`](qwen/qwen3.5.md) | Ollama | 3.4 GB | 11s | 167s |
| [`granite4.1:30b`](granite/granite4.1.md) | Ollama | 17 GB | 26s | 52s |
| [`nemotron3:33b`](nvidia/nemotron3.md) | Ollama | 27 GB | 21s | 119s |
| [`nemotron-3.5-lightning:30b`](nvidia/nemotron-3.5-lightning.md) | Ollama | 25 GB | 29s | 145s |
| [`ornith:9b`](ornith/ornith.md) | Ollama | 5.5 GB | 31s | 118s |
| [`qwen3.5:9b`](qwen/qwen3.5.md) | Ollama | 5.8 GB | 33s | 98s |
| [`gemma4:26b`](gemma/gemma4.md) | Ollama | 16 GB | 36s | 92s |
| [`qwen3:8b`](qwen/qwen3.md) | Ollama | 5.2 GB | 36s | 108s |
| [`qwen3:14b`](qwen/qwen3.md) | Ollama | 9.3 GB | 41s | 303s |
| [`granite4.2:8b`](granite/granite4.2.md) | Ollama | 5.3 GB | 46s | 116s |
| [`nemotron-3-nano:30b`](nvidia/nemotron-3-nano.md) | Ollama | 24 GB | 46s | 190s |
| [`qwen3:4b`](qwen/qwen3.md) | Ollama | 2.5 GB | 72s | 160s |
| [`qwen3.8:latest`](qwen/qwen3.8.md) | Ollama | 19 GB | 72s | 195s |
| [`qwen3.6:27b`](qwen/qwen3.6.md) | Ollama | 17 GB | 82s | 252s |
| [`muse-glimmer:latest`](muse/muse-glimmer.md) | Ollama | 18 GB | 115s | 285s |

The durations are from one machine and are comparable with each other rather than portable: every
figure was taken the same way, on the same database, through the same six surfaces. What they are
for is choosing between these eighteen — the fastest reaches the same verdicts as the slowest in a
twelfth of the time.

One page per model version. Sizes are rows inside it, because `ollama pull qwen3:4b` is how a
size is chosen and because the interesting fact is usually the difference between two sizes of
the same model.

| | |
| --- | --- |
| Configuring one — local or hosted | [`setup.md`](setup.md) |
| How these numbers were produced, and where they stop being safe | [`methodology.md`](methodology.md) |
| Measuring a model these pages do not cover | [`testing-your-own.md`](testing-your-own.md) |
| Giving a model settings Studio has never measured | [`model-tuning.md`](model-tuning.md) |

## What was measured

Six surfaces, one question each, against the embedded SQLite sample:

| Surface | Question | What it takes to pass |
| --- | --- | --- |
| Investigate | "What tables are in this database and how do they relate?" | a report, cited |
| Optimize | "Why is the employee listing query slow?" | a plan comparison or a grounded index recommendation, then a report |
| Assess | "Where is this database's data incomplete or surprising?" | a table profiled, then a report |
| Operate | "What is currently happening on this database?" | readings, then a report |
| Analyze | "Which part of the company costs us the most in salary?" | a read, an answer PRESENTED, then a report |
| Plan | "What tables are in this database and how do they relate?" | a runnable statement, or an explicit refusal |

Five consecutive passes is what makes a surface count, and the bar is consecutive on purpose: a
model that answers four times in five is not one you would put in front of a user, and a single
pass says nothing at all about the fifth.

## Choosing between them

| If you want | Take | Why |
| --- | --- | --- |
| the fastest local model | [`granite4.1:8b`](granite/granite4.1.md) | 11s median, 5.3 GB, and it clears everything |
| the smallest download | [`qwen3:4b`](qwen/qwen3.md) | 2.5 GB — and not the fastest: size buys memory, not speed |
| the steadiest | [`granite4.1:30b`](granite/granite4.1.md) | its slowest run is under twice its median, where most models have a longer tail |
| no local hardware at all | [`gemini-3.5-flash-lite`](gemini/gemini-3.5.md) | the one hosted model, 10s median, and it needs a key |

## What is not here

Models that do not clear all six surfaces are not listed and not supported. Several came close —
one cell short, usually the same one — and being close is not the claim this product makes.
Measuring one yourself is [`testing-your-own.md`](testing-your-own.md).
