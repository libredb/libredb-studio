# Giving a model settings Studio has never measured

Studio ships a document recording what specific models were measured under — how long one of
their turns may take, how many readings they may take before being asked to report, whether an
empty turn is worth asking again. A model it does not name is driven with the compiled defaults,
which is the honest treatment of a model nobody has measured.

This page is how you supply your own, with no new Studio release and no code change. It is the
other half of [`testing-your-own.md`](testing-your-own.md): that page is how you measure a model,
this one is how the measurement takes effect.

Start from [`model-tuning.example.json`](model-tuning.example.json) — a complete, valid document
with one model in it. A test parses that file on every run, so it cannot drift from the contract
below.

## Where it goes

| | |
| --- | --- |
| Anywhere | `AGENT_MODEL_TUNING_PATH=/etc/libredb/model-tuning.json`, then restart |
| Kubernetes | `agent.modelTuning.existingConfigMap` (or `.document`) — the chart mounts it and sets the variable. See [`charts/libredb-studio/README.md`](../../charts/libredb-studio/README.md) |

A relative path is resolved against the working directory, which is a different place in the
container, under `npx` and in a checkout — the path Studio actually opened is reported back, so
you never have to guess which one it was.

## Checking that it took effect

**Do this rather than assume it.** A document that is missing, unreadable or off-schema is
IGNORED and the shipped measurements stand — which is what stops a bad file from breaking a
working agent, and also what makes silence ambiguous. `GET /api/agent/config`, as an **admin**
session, says which happened:

```jsonc
{ "modelTuning": { "state": "applied",  "path": "/etc/libredb/model-tuning.json",
                   "models": 1, "ignoredKeys": [] } }
{ "modelTuning": { "state": "ignored",  "path": "...", "reason": "models.0.settings.turnTimeoutMs: ..." } }
{ "modelTuning": { "state": "unset" } }
```

`ignoredKeys` is the one to read on a successful load: it lists what your document said that this
Studio does not implement — a misspelling, or a setting from a newer Studio. The entry was applied
around those keys rather than because of them.

## The shape

Three top-level keys, one of them optional.

```jsonc
{
  "schemaVersion": 1,          // must match this Studio's version
  "measuredAgainst": { … },    // OPTIONAL: what your numbers were obtained under
  "models": [ … ]              // one entry per model
}
```

**`measuredAgainst`** records the environment the measurement was taken in: `turnTimeoutMs`, a
`protocol` sentence in your own words, and the `defaults` your Studio was running. State the
defaults you know about; ones you omit are simply not compared against.

It is **optional**, and Studio does not read it — the settings in force come from the entries, and
Studio's own recorded basis is the one it compares against. Write it anyway if the document is
going to outlive the conversation you wrote it in: a number with no record of what it was measured
under cannot be compared with anyone else's, which is the whole argument of
[`methodology.md`](methodology.md).

**Each entry in `models`** needs an `id` and a `measured` sentence, and states the settings it
measured — only those. `rationale` is prose arguing for a setting, under that setting's own name;
it is a convention rather than a gate, because a missing paragraph is a fault in the writing and a
run is not the place to discover it.

`id` is matched case-insensitively (`QWEN3:8B` finds `qwen3:8b`) but tags are **not** stripped: a
bare `qwen3.8` does not find `qwen3.8:latest`. Write the tag you run.

## The settings

Every one is optional. What you do not state resolves to the compiled default in the last column.

| setting | type and bounds | what it decides | default |
| --- | --- | --- | --- |
| `sampling` | `{temperature: 0–2, topP: 0–1}` | how every turn of this model is sampled | `{0, 1}` |
| `perWorkflow` | the same object, per workflow id | sampling for named surfaces only — the narrowest an override gets | — |
| `unreportedCallCeiling` | integer 1–100 | how many calls it may make without reporting before the run is narrowed to the tools that would finish it | `12` |
| `reportReminderLimit` | integer 0–5 | how many times a turn with no call and no report may be answered with the report reminder | `1` |
| `planStatementRetries` | integer 0–5 | extra turns a PLAN run gets when its prose named neither a statement nor a refusal | `0` |
| `presentReminderLimit` | integer 0–5 | how many times a report may be held to ask for the answer that belongs beside it | `1` |
| `retryEmptyTurn` | boolean | whether a turn that came back EMPTY is asked once more before the run is ended | `false` |
| `refusalExamples` | boolean | whether a refused call is handed a worked example built from this run's ledger | `false` |
| `turnTimeoutMs` | integer 1000–179999 | how long ONE turn of this model may take, where the product's own limit does not fit it | the product's limit |

Workflow ids for `perWorkflow`: `investigation`, `query-optimization`, `database-assessment`,
`operations`, `data-analysis`.

## The rules

**Merged per model and WHOLE.** An entry replaces the shipped entry for that model rather than
contributing one field to it. If you re-state a model Studio already measured and mention only one
setting, the others fall to the compiled defaults — not to half the shipped entry. Half of one
measurement beside half of another is a configuration nobody has ever run.

**Unknown keys are reported, not fatal.** A key this Studio does not implement does not refuse
your document; it is applied around and listed in `ignoredKeys`. That is what lets a document
written for a newer Studio keep working on an older one, and a document written today keep working
after Studio gains a setting. It is also why you should read `ignoredKeys`: a misspelled
`retryEmtpyTurn` lands there rather than doing anything.

**What does not relax:** every bound in the table above, `measured` on every entry, and one entry
per model id — two spellings of one id is refused rather than last-wins, because no reader of the
file could say which had been used.

**Wording never travels.** The sentences Studio says to a model live in Studio. A document has
nowhere to put one, and that is deliberate: those sentences are pushed verbatim into the model's
messages, so a file that could carry them would let whoever wrote it decide what Studio says
mid-run.

## What is worth measuring before you override anything

Nothing here is a preference. Each of these settings exists because a run was lost and a ledger
said why, and the same discipline is what makes your numbers worth anything to the next person:
five consecutive passing runs per surface, at the settings you are writing down. The method, and
where its numbers stop being safe to generalise from, is in
[`methodology.md`](methodology.md).
