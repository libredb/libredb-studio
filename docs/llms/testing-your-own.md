# Measuring a model these pages do not cover

The library has more models than anyone can test, and new ones land weekly. This is
the procedure that produced every table here, so a result you get is comparable with
a result on these pages.

## Before spending the download

Tool calling is the gate, though not an absolute one. Pull the model, then run the probe in
[`setup.md`](setup.md#checking-a-model-this-list-does-not-cover). A model that answers in prose
rather than with a `tool_calls` array cannot be driven natively, and no amount of prompting
changes that — several reasoning distills were confirmed that way.

What it does NOT mean is that the model is unusable: the application drops such a model to a
prose tool protocol rather than turning it away. It decides per endpoint, from what the endpoint
does, rather than from a list of names.

Two things that look like evidence and are not:

* **the `tools` tag on the Ollama model page.** Models advertise it and cannot do it.
* **the chat template.** A missing `.Tools` block proves nothing: `gemma4:26b` and
  `qwen3.8:latest` both lack it and both clear all six surfaces, because recent Ollama renders
  tools outside the template.

## The runs

Ask each question against the embedded SQLite sample, five times each — see below for why five:

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

## Five consecutive runs, not one

One run per cell was the old method here and it was the weakest thing about it. These models are
not deterministic: cells that passed once came back 3 of 5 when the same question was asked
again, and one captured request replayed five times produced three tool-calling runs and two
refusals.

So a surface counts only when five runs in a row pass. Four in five is not a model you would put
in front of a user, and one pass says nothing about the fifth.

If a result surprises you, run it again before writing it down. A model that passes sometimes and
fails sometimes IS the finding, and it belongs on the page as a rate rather than a tick.
