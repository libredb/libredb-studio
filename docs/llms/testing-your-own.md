# Measuring a model these pages do not cover

The library has more models than anyone can test, and new ones land weekly. This is
the procedure that produced every table here, so a result you get is comparable with
a result on these pages.

## Before spending the download

Tool calling is the gate. Pull the model, then run the probe in
[`setup.md`](setup.md#3-check-the-model-can-drive-a-run-at-all). A model that answers
in prose rather than with a `tool_calls` array cannot drive a run, and no amount of
prompting changes that — four `deepseek-r1` sizes were confirmed that way.

Two things that look like evidence and are not:

* **the `tools` tag on the Ollama model page.** `deepseek-r1` advertises it and cannot
  do it.
* **the chat template.** A missing `.Tools` block proves nothing: `gemma4:26b`,
  `qwen3.8` and `muse-glimmer` all lack it and all score 3/3, because recent Ollama
  renders tools outside the template.

## The three runs

Ask each question against the embedded SQLite sample, one run each:

| Workflow | Question |
| --- | --- |
| Investigate | What tables are in this database and how do they relate to each other? |
| Operate | What is currently happening on this database? |
| Analyze | Which part of the company costs us the most in salary? |

Analyze is the one that separates models. It is not enough to read the data and
describe it: the result has to be handed over with `present_answer`, and most models
that score 2/3 fail exactly there.

## Reading the result

A run is a pass only when its goal verdict is `answered`. `succeeded` is not the same
thing — a run can end successfully having answered nothing.

The ledger in `.workflow-data` is the authority. What to look for:

| On the ledger | What happened |
| --- | --- |
| `tool-invoked` / `tool-completed` | the model called a tool and it settled |
| `answer-composed` | a result was presented. Absent on every `no-answer` run |
| `report-composed` | the run reported. Absent on every `no-report` run |
| `run-finished` with `stopReason` | how the loop ended |

One thing the ledger cannot tell you: a refused ledger-only tool writes no event, so
"never called `present_answer`" and "called it and was refused" look identical. If a
model insists it is presenting and the verdict says otherwise, that is the case to
suspect — it is what [`qwen3.8`](qwen/qwen3.8.md) turned out to be.

## Recording it

Note these, because a number without them cannot be compared:

* the exact tag (`qwen3:4b`, not "qwen")
* disk size and parameter count, from `ollama list` and `/api/show`
* the machine, and the power mode
* seconds per workflow, and the verdict for each

Then add a row to the model's page, or a new page under the family folder if the
family is not covered. Sizes are rows inside a version page, not separate files.

## Run it more than once

Every table on these pages is one run per cell, and that is the method's weakest
point — see [`methodology.md`](methodology.md). Some models are genuinely unstable:
one captured request replayed five times against `mistral-small3.2:24b` produced three
tool-calling runs and two refusals.

If a result surprises you, run it again before writing it down. If a model passes
sometimes and fails sometimes, that IS the finding, and it belongs on the page.
