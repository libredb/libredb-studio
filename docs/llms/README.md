# Local models in Agent mode

Which models can actually drive an agent run, measured rather than assumed.

Agent mode asks a model to do something a chat model is never asked to do: call a
tool, read what comes back, call another, and finish by calling `compose_report`
with claims that cite what it read. A model that writes beautiful prose about a
database and never calls a tool answers nothing here. So the only useful question
is what a model DOES on a run, and every figure on these pages comes from a run
whose ledger is in `.workflow-data`.

One page per model version. Sizes are rows inside it, because `ollama pull qwen3:4b`
is how the size is chosen and because the interesting fact is usually the difference
between two sizes of the same model.

## What was measured

Three workflows, one question each, against the embedded SQLite sample:

| Workflow | Question | What it takes to pass |
| --- | --- | --- |
| Investigate | "What tables are in this database and how do they relate?" | a report, cited |
| Operate | "What is currently happening on this database?" | readings, then a report |
| Analyze | "Which part of the company costs us the most in salary?" | a read, an answer PRESENTED, then a report |

Analyze is the hard one and the one that separates models: it is not enough to read
the data and describe it, the result has to be handed over with `present_answer`.

**Hardware:** Apple M5 Max, 48 GB, macOS in high-power mode. Timings scale with the
machine; the pass/fail column does not, except where a run is close to the 90-second
per-turn ceiling. If your machine is slower, prefer a smaller model rather than a
larger one you will wait on. Power mode alone was measured at 2.8x throughput on this
machine, and it decided pass from fail for one model.

## The short answer

| If you have | Use | Disk |
| --- | --- | --- |
| a modest laptop | [`qwen3:4b`](qwen/qwen3.md) | 2.5 GB |
| a little more room | [`ornith:9b`](ornith/ornith.md) | 5.6 GB |
| a workstation | [`gemma4:26b`](gemma/gemma4.md) or [`granite4.1:30b`](granite/granite4.1.md) | 17 GB |
| a DeepSeek preference | none of them work — [why](deepseek/deepseek-r1.md) | — |

## Every model measured

| Model | Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- | --- |
| [`gemma4`](gemma/gemma4.md) | 26b | 17 GB | ✅ 6.5s | ✅ 12.0s | ✅ 25.6s | **3/3** |
| [`granite4.1`](granite/granite4.1.md) | 30b | 17 GB | ✅ 6.7s | ✅ 23.7s | ✅ 19.9s | **3/3** |
| [`nemotron-3.5-lightning`](nemotron/nemotron-3.5-lightning.md) | 30b | 25 GB | ✅ 14s | ✅ 15s | ✅ 21s | **3/3** |
| [`qwen3.8`](qwen/qwen3.8.md) | 27b | 17 GB | ✅ 49.3s | ✅ 90.0s | ✅ 62.0s | **3/3** |
| [`qwen3.6`](qwen/qwen3.6.md) | 27b | 17 GB | ✅ 56s | ✅ 108s | ✅ 87s | **3/3** |
| [`muse-glimmer`](muse/muse-glimmer.md) | — | 18 GB | ✅ 90.4s | ✅ 69.4s | ✅ | **3/3** |
| [`gemma4`](gemma/gemma4.md) | 12b | 7.6 GB | ✅ 21s | ✅ 72s | ✅ 119s | **3/3** |
| [`qwen3.5`](qwen/qwen3.5.md) | 9b | 6.6 GB | ✅ 25s | ✅ 16s | ✅ | **3/3** |
| [`ornith`](ornith/ornith.md) | 9b | 5.6 GB | ✅ 14s | ✅ 26s | ✅ 21s | **3/3** |
| [`qwen3`](qwen/qwen3.md) | 8b | 5.2 GB | ✅ | ✅ 17s | ✅ 31s | **3/3** |
| [`qwen3.5`](qwen/qwen3.5.md) | 4b | 3.4 GB | ✅ 24s | ✅ 10s | ✅ | **3/3** |
| [`qwen3`](qwen/qwen3.md) | 4b | 2.5 GB | ✅ 27s | ✅ 36s | ✅ 56s | **3/3** |
| [`granite4.1`](granite/granite4.1.md) | 8b | 5.3 GB | ✅ 4.0s | ✅ 2.9s | ❌ | 2/3 |
| [`granite4.1`](granite/granite4.1.md) | 3b | 2.1 GB | ✅ 2.8s | ✅ 1.3s | ❌ | 2/3 |
| [`mistral-small3.2`](mistral/mistral-small3.2.md) | 24b | 15 GB | ✅ 7.2s | ✅ | ❌ | 2/3 |
| [`lfm2`](lfm/lfm2.md) | 24b | 14 GB | ✅ | ❌ | ❌ | 1/3 |
| [`qwen3.5`](qwen/qwen3.5.md) | 2b | 2.7 GB | ❌ | ❌ | ❌ | 0/3 |
| [`qwen3`](qwen/qwen3.md) | 1.7b | 1.4 GB | ❌ | ❌ | ❌ | 0/3 |
| [`qwen3`](qwen/qwen3.md) | 0.6b | 522 MB | — | ❌ | ❌ | 0/3 |
| [`deepseek-r1`](deepseek/deepseek-r1.md) | 7b–32b | 4.7–19 GB | ❌ | ❌ | ❌ | **0/3** |

## Size is the strongest predictor, and 4B is the floor

| Size | What happens |
| --- | --- |
| under 2B | calls tools, then narrates its findings instead of reporting. Nothing is recorded. |
| 2B | same, and more stubbornly: one run made 42 tool calls and still wrote prose. |
| **4B and up** | **works.** `qwen3:4b` passes all three at 2.5 GB. |
| 9B and up | works, with more headroom on the analysis question. |

Newer is not automatically better within a family: `qwen3:4b` (older generation)
scores 3/3 where `qwen3.5:2b` scores 0/3, and the difference is size, not generation.

## What a failure looks like

The verdict on a run names which of these happened, and each has a different cause:

| Verdict | What the model did | Fixable? |
| --- | --- | --- |
| `no-report` | called tools, then wrote its findings as prose | yes, the run is reminded once |
| `no-answer` | read the data, then reported without presenting the result | yes, the run is told to present first |
| `empty-evidence` | reported claims nothing in the run establishes | no, that is the citation contract working |
| `model-timeout` | one turn took longer than 90 seconds | usually the machine, not the model |
| no tool call at all | answered the question as a chat model would | no |

Two of those are handled in the runtime now, which is why several models on this page
score 3/3 today and scored 2/3 when first measured. The pages say which.
