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

**Do this rather than assume it.** A document that is missing, unreadable or off-schema in its
ENVELOPE is IGNORED and the shipped measurements stand — which is what stops a bad file from
breaking a working agent, and also what makes silence ambiguous. `GET /api/agent/config`, as an
**admin** session, says which happened:

```jsonc
{ "modelTuning": { "state": "applied",  "path": "/etc/libredb/model-tuning.json",
                   "models": 1, "ignoredKeys": [], "skippedEntries": [], "digest": "9f2c…" } }
{ "modelTuning": { "state": "ignored",  "path": "...", "reason": "schemaVersion: Invalid input: expected 1" } }
{ "modelTuning": { "state": "unset" } }
```

`ignoredKeys` is the one to read on a successful load: it lists what your document said that this
Studio does not implement — a misspelling, or a setting from a newer Studio. The entry was applied
around those keys rather than because of them.

`skippedEntries` is the other one, and it is the difference between `models` and how many entries
you wrote. An entry that does not read is dropped and named here; the entries beside it apply. So a
`"state": "applied"` with `"models": 49` on a fifty-model document is not a success — read this
list, and it will tell you which entry and which value:

```jsonc
{ "skippedEntries": ["qwen3:8b: settings.turnTimeoutMs: Too big: expected number to be <=179999"] }
```

An entry whose `id` is what is wrong is named by its POSITION instead — `#37: id: ...` — because
there is no id to search the file for, and inventing one would name a model you never configured.

`digest` is SHA-256 of the document's bytes as they were read, and it is the same value a run
records. The path says which file drove a run; only the digest says which VERSION of it, and a
finished run that cannot be told apart from one driven by that path after somebody edited it is
most of what recording the path was for. So: read the digest here, compare it against the one on
the run you are explaining, and a mismatch tells you the file changed between them.

## What a run records

Each stretch of a run writes a `driver-resolved` entry naming the model, its provider, and where
its settings came from — `bundled`, `operator` with the digest above, or `operator-ignored`.

PER MODEL, not per document. A document that names `qwen3:8b` did not drive a run on
`gemini-3.5-flash-lite`; that run records `bundled`, because the shipped measurements are what
drove it. Mounting a document does not make it the provenance of everything the server runs.

PER DRIVE, not per run. A run resumed after you changed the configuration ran on two things, and
its ledger holds two entries that may disagree — which is the fact worth finding, not a
contradiction to reconcile.

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
| `verdictHoldLimit` | integer 0–5 | how many times a report whose own verdict would REJECT it may be held and told why — the third of the reminder bounds. A run about to pass never reaches this hold, so raising it costs turns only on a run that has already lost | `2` |
| `retryEmptyTurn` | boolean | whether a turn that came back EMPTY is asked once more before the run is ended | `false` |
| `retryUnreadStop` | boolean | whether a run that stopped having CALLED NOTHING is told once to read the database itself, instead of being ended — it subsumes `retryEmptyTurn`, since the gate asks what was called and not what was said | `false` |
| `suppressPlanReasoning` | boolean | whether this model's PLAN turn asks the endpoint for no reasoning at all — reaches the OpenAI-compatible adapter only (`openai`, `ollama`, `custom`), so it is a no-op on `gemini` | `false` |
| `suppressAgentReasoning` | boolean | the same, for this model's AGENT turns — for a model that either answers at once or thinks until the wall, which `turnTimeoutMs` does not address because a turn spent thinking finds the new wall too. Same adapters, same no-op on `gemini` | `false` |
| `refusalExamples` | boolean | whether a refused call is handed a worked example built from this run's ledger | `false` |
| `turnTimeoutMs` | integer 1000–179999 | how long ONE turn of this model may take, where the product's own limit does not fit it | the product's limit |
| `threadContextMaxChars` | integer 200–32000 | how much of a CONVERSATION this model may be handed — the earlier steps' objectives and the most recent step's report, when a follow-up continues a previous run | the product's budget (4000) |

Workflow ids for `perWorkflow`: `investigation`, `query-optimization`, `database-assessment`,
`operations`, `data-analysis`.

**`threadContextMaxChars` is the one setting Studio ships NO measurement for**, and that is
deliberate rather than an omission: no entry in the shipped document names it, because nobody has
measured one. It is here because the value that is right depends on the model's CONTEXT WINDOW —
what a hosted 200k-window model can carry beside its schema inventory is not what a small local one
can — and this is the only place that fact can be expressed per model. Lower it if a follow-up on
your model starts losing the schema block or ending early; raise it if your model has room and your
conversations are long enough to be truncating. Either way the answer comes from driving it, which
is what [`testing-your-own.md`](testing-your-own.md) is for.

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

**Refused per ENTRY, not per document.** The whole-and-nothing rule above is about MERGING, so it
protects the entry and stops there. An entry that breaks a bound, misses `measured` or repeats an
id already taken is skipped and listed in `skippedEntries`; the rest of the document applies. Until
this changed, a fifty-model document lost all fifty to a typo in the thirty-seventh — tolerable for
a short overlay you wrote, not for a catalog somebody else mounted.

**What does not relax:** every bound in the table above, `measured` on every entry, and one entry
per model id — two spellings of one id skips the second rather than last-wins, because no reader of
the file could say which had been used.

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
