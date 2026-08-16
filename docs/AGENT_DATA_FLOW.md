# What leaves the machine

LibreDB Studio deploys next to the data, and the model is the only thing it talks to that **you did
not name**. This page is about that traffic and only that traffic: **what leaves for a model
provider, when, to which provider, and where the labelling boundary applies.**

**It is not the whole egress boundary, and does not claim to be.** Three other things leave this
host, and an operator writing a firewall rule needs all four:

| What | To where | Call site |
| --- | --- | --- |
| **Model traffic** | The provider you configured through `LLM_*` | The rest of this page |
| **Database traffic** | Every database host in your connections — the product's entire purpose | `src/lib/db/providers/` |
| **OIDC** | Your issuer, when `NEXT_PUBLIC_AUTH_PROVIDER=oidc`: discovery, token and JWKS requests | `src/lib/oidc.ts` |
| **The `npx` launcher** | `github.com` — a **hard-coded** URL, the one outbound host in this repo that you did not choose. `npx @libredb/studio` downloads the release tarball and its `SHA256SUMS` from `https://github.com/libredb/libredb-studio/releases/download/...` before any server starts. It runs once per version and caches under `~/.libredb-studio/`; the Docker, Helm and standalone paths never reach it | `bin/lib/launcher-utils.mjs:87`, called from `bin/studio.js:218-219` |

**It is written from call sites, not from intent.** Every claim below names the file and the lines
that make it true, so you can check any sentence against the code rather than believing this page.
Where something is *not* protected, that is stated here too — an honest egress page is worth nothing
if it only lists the good news.

---

## Contents

- [The short version](#the-short-version)
- [Where a request goes](#where-a-request-goes)
- [When nothing leaves at all](#when-nothing-leaves-at-all)
- [One agent run, message by message](#one-agent-run-message-by-message)
- [What comes back, and what is done with it](#what-comes-back-and-what-is-done-with-it)
- [What #352 added to the boundary](#what-352-added-to-the-boundary)
- [The fence, and what it does not do](#the-fence-and-what-it-does-not-do)
- [B29: the open unfenced path](#b29-the-open-unfenced-path)
- [How much can leave](#how-much-can-leave)
- [What never leaves](#what-never-leaves)
- [The other AI surfaces](#the-other-ai-surfaces)
- [Where prompts do not go](#where-prompts-do-not-go)

---

## The short version

| Surface | What it sends | Fenced? |
| --- | --- | --- |
| An **agent run** | Your objective; the schema inventory (table, column, index identifiers and column types); the relations graph (identifiers only); the rows of each read the model performed, up to 200 per read; engine error text; server-written refusals; server-minted ids | Everything derived from the database is wrapped in an untrusted-content fence before it reaches a prompt |
| An **agent run opened as Operate** | Your objective; **no schema inventory and no relations graph** (a server note replaces them); and the rows of each curated reading — which, for the `sessions` and `slow-queries` kinds, include **other database users' in-flight statement text and their database usernames**. See [the operations workflow](#5a-the-operations-workflow-what-a-curated-reading-sends) | Same fence: every reading's rows are database content and are fenced |
| `POST /api/ai/explain` | Your statement, the EXPLAIN plan, the schema context the browser holds, the engine type | No |
| `POST /api/ai/query-safety` | Your statement, a filtered schema context, the engine type | No |
| `POST /api/ai/describe-schema` | A schema context. From the **Data Profiler** that context includes a per-column `min=` and `max=`, which are **real column values** | No |
| Everything else in the **running server** | Every outbound connection goes to a host **you** configured — your databases, your OIDC issuer when `NEXT_PUBLIC_AUTH_PROVIDER=oidc` (`src/lib/oidc.ts`), and the model provider above. The one host `src/` names itself is OpenAI's default base URL, reached only if you set `LLM_PROVIDER=openai` (`src/lib/llm/utils/config.ts:23`) | — |
| The **`npx` launcher**, before the server exists | The release tarball and `SHA256SUMS` from a hard-coded `github.com` URL (`bin/lib/launcher-utils.mjs:87`, from `bin/studio.js:218-219`). Once per version, cached in `~/.libredb-studio/`; no other install path uses it | — |

---

## Where a request goes

Exactly one place: the model provider **you** configured through `LLM_PROVIDER`, `LLM_MODEL`,
`LLM_API_KEY` and `LLM_API_URL`. The agent resolves that configuration through `src/lib/llm`'s own
resolution — the same one the remaining AI features use — so there is one answer rather than two
that can disagree (`src/lib/agent/model-adapter.ts`).

| Kind | Endpoint | Call site |
| --- | --- | --- |
| `gemini` | Google's own Generative AI endpoint. **No `baseURL` is passed, deliberately**, so an `LLM_API_URL` left over from another setup cannot redirect Gemini traffic — carrying your key — to that host | `src/lib/agent/provider-registry.ts:134-146` |
| `openai`, `ollama`, `custom` | `{LLM_API_URL}/chat/completions` — whatever host you named | `src/lib/agent/provider-registry.ts:121-132` |

Two properties of that seam are enforced rather than assumed:

- **Ambient provider keys cannot authenticate a run.** `@ai-sdk/openai` reads `OPENAI_API_KEY` and
  `OPENAI_BASE_URL` when they are undefined, and `@ai-sdk/google` reads
  `GOOGLE_GENERATIVE_AI_API_KEY`. Every setting is therefore passed explicitly, so none of those
  reads can happen — a keyless Ollama gets a placeholder token and a keyless custom endpoint gets no
  `Authorization` header at all (`provider-registry.ts:81-111`, asserted on the wire in
  `tests/isolated/agent-model-adapter.test.ts`).
- **The SDK's hosted gateway is unreachable by construction.** The AI SDK also accepts a bare model
  id, which it resolves through its own gateway — a third party nothing in this repository
  configures. The type excludes that arm (`AgentLanguageModel`, `provider-registry.ts:53-61`).

`LLM_API_URL` is unread for the `gemini` kind, on the agent path exactly as on the chat surface. A
Gemini deployment behind a proxy is therefore not configurable (`docs/BACKLOG.md` B20).

---

## When nothing leaves at all

- **No model configured, no AI.** With no model configured the agent is not available, the rail does
  not render, and every run-reaching agent route answers `404` (`src/lib/agent/config.ts`,
  `docs/AGENT.md`, "Turning it on"). **The test is a configuration that validates, not a key.**
  `validateConfig` demands `LLM_API_KEY` for the `gemini` and `openai` kinds only
  (`src/lib/llm/utils/config.ts:127-134`): `LLM_PROVIDER=ollama` validates with no key at all, and so
  does `custom` with an `LLM_API_URL`, and on either of those the agent is available and everything
  on this page is sent to that endpoint. What has no AI is a deployment carrying **no `LLM_*`
  configuration at all** — the provider then defaults to `gemini` (`config.ts:12`), which is refused
  without a key, and the availability answer is `NO_MODEL_CONFIGURED`.
- **`GET /api/agent/config` reaches no provider.** The visibility probe the browser makes on mount
  answers from configuration and a local filesystem check; it makes no model call
  (`src/app/api/agent/config/route.ts`).
- **Opening the rail sends nothing.** A shortcut fills the objective box and starts nothing
  (`src/components/agent/use-agent-prefill.ts`); the first model call happens when you press
  **Start**.
- **A `planning` run runs no statement of yours.** Its tool set is empty, so the model sends nothing
  and asks for nothing (`selectAgentTools`). Since 2026-08-15 the SERVER does read this connection's
  catalog for it, before the first turn and through the same read-only, audited path an agent run
  uses (`establishContext` in `src/lib/agent/investigation.ts`): the alternative was a mode that knew
  your database only when an agent run had already read it in the same process. What that reads is a
  schema inventory — names, types, keys and relations — plus what the engine already RECORDS about
  its own tables (`pg_class.reltuples` and `pg_stats` on PostgreSQL, `sqlite_stat1` on SQLite). No
  table is scanned and no value is read out of any column, so nothing about your DATA is in it. Those
  numbers are the engine's estimates, and the prompt says so. On any other engine nothing is read at
  all and the run is told it has no inventory. Nothing is written, and every statement a plan drafts
  is handed to you to run yourself.

There is one model call the agent makes before the run itself: the **capability probe**, one round
trip asking the model to call a trivial tool. Its prompt is a fixed server-written string and
carries nothing of yours (`PROBE_PROMPT`, `src/lib/agent/capability-probe.ts:134`). A positive
verdict is cached for the life of the process, so it is paid once
(`src/lib/agent/capability-gate.ts`).

---

## One agent run, message by message

The transcript is assembled in `runInvestigation` (`src/lib/agent/investigation.ts:662-825`) and is
sent by `takeTurn` through `streamText` (`investigation.ts:575-592`). Nothing else in the runtime
sends anything.

### 1. The system instructions — server text only

`systemPrompt` concatenates the mode's rules, the workflow's tool rules, the workflow's objective
statement and the shared rules (`investigation.ts:240-243`). Every one of those strings is a
constant in that file. **Nothing of yours or of your database is in it.**

### 2. Your objective, verbatim

The first user message is the text you typed, unmodified apart from the trim the rail applies
(`investigation.ts:698`). Bounded to 4000 characters by the route and by the rail
(`AGENT_MAX_OBJECTIVE_LENGTH`).

### 3. The schema inventory — identifiers and types, fenced

**Not on an Operate run.** A run whose workflow is `operations` captures no inventory at all and is
sent a server-written note in its place (`OPERATIONS_CONTEXT_NOTE`, `investigation.ts`), so sections
3 and 4 below do not happen and no catalog is read. That is a decision rather than a gap: the
workflow is offered no tool that reads a catalog, and most of the engines it runs on cannot serve one.

On every other workflow, captured once per run by reading the catalog, then packed for the task
(`packContextForTask`, `src/lib/agent/context-snapshot.ts:466-505`). Per table it renders
(`renderTable`, `context-snapshot.ts:428-441`):

- the table name;
- up to 12 columns, each as `name type`, plus ` NOT NULL`, ` PK` and ` -> referencedTable.column`
  where they apply;
- up to 4 index names with their column lists;
- a count of what was left out, named as left out rather than silently dropped.

Tables are ordered by relevance to the words in your objective, and lines are added only while the
**fenced whole** still fits 6000 characters (`AGENT_CONTEXT_PACK_MAX_CHARS`,
`context-snapshot.ts:348`). Table and column names are database content — anyone who can write to
the database writes them — so the block goes through `fenceUntrustedContent` before it is a message.

**No row value is in this block.**

### 4. The relations block — identifiers only, quoted and escaped

The inventory's foreign keys, rendered as a relation list and fenced beside the inventory
(`packRelations`, `investigation.ts:288-294`; rendering in `src/lib/agent/er-diagram.ts:228-269`).
It carries table names, column names, and at the deepest detail level a table's primary-key and
leading-index column names (`keyColumns`, `er-diagram.ts:145-157`). **Never a row value.**

Every identifier is quoted with its delimiter doubled as SQL does it, and every control character is
escaped, so a table named `orders -> secrets` renders as one quoted name rather than as a relation
nobody has (`quote`/`escapeInIdentifier`, `er-diagram.ts:67-87`). The block is bounded at 2000
rendered characters — a bound in characters, because a count of edges is not a bound on a prompt
(`MAX_ER_CHARS`, `er-diagram.ts:96`).

### 5. Each tool result

| Outcome | What is sent back to the model | Call site |
| --- | --- | --- |
| A completed read | A server sentence naming the artifact id, then the **rows**: one `JSON.stringify` per row, newline separated, inside a fence labelled `<what it was>, N row(s)` | `tools.ts:918-932`, rendering at `tools.ts:620-624` |
| A statement that failed at the database | The **engine's own message**, fenced, referenced by the statement's fingerprint | `tools.ts:872-882` |
| A policy denial | Server text only: the deny code, the policy version, and advice that a boundary decided this. There is no engine text because a denial produced none | `denialText`, `tools.ts:568-574` |
| An approval requirement | Server text naming the operation id | `approvalText`, `tools.ts:576-581` |
| A table profile (Assess) | Counts, the number of findings, the covered column range — plus the **table name** and the **finding lines** (each `column: code — detail`), both fenced. No value from any column | `tools.ts:1325-1345`, `describeFindings` at `tools.ts:1143-1150` |
| A curated operational reading (Operate) | A server sentence naming the artifact id, then the **projected rows**, fenced like any other result. What those rows contain is the point: for `sessions` and `slow-queries` they carry **statement text other users are running or have run**, and for `sessions` the **database username, client address and application name of each connected session**. See below | `tools.ts`, `CURATED_READINGS` |
| A plan comparison (Optimize) | The two statements the run drafted and the server's structural reading of each plan (`full-scan` / `index` / `mixed` / `unknown`, plus whatever estimates the engine reported) | `plan-summary.ts`, restated at `investigation.ts:367-369` |
| A catalog read that could not be performed | Fixed server advice, and one of two things before it. When no catalog plan exists for the engine, or when the rows the read produced are already gone, it is a **server sentence** that may name the connection's **engine type** ("a mongodb connection") or the catalog kind (`context-snapshot.ts:301-305,315-318`). When the catalog read was itself refused, the sentence forwarded is `inspectSchemaTool`'s **own `modelText`** (`context-snapshot.ts:312`) — which for a policy denial is server text, and for a **database-error refusal is the engine's own message, fenced** (`tools.ts:872-882`). Either way it is wrapped by `unavailable` (`context-snapshot.ts:243-245`) and pushed as a user message (`investigation.ts:743`) |

### 5a. The operations workflow: what a curated reading sends

This is the one class of content no other agent path exposes, and it is stated here rather than left
to be inferred from the fence. The `operations` workflow's single database tool calls the provider's
own reporting methods, and two of its six kinds return **text somebody else wrote**:

- `sessions` (`getActiveSessions`) projects, per connected session: `query` — the statement that
  session is running, literals and all — plus `user` (the database username), `clientAddr`,
  `applicationName`, `database`, state and wait information.
- `slow-queries` (`getSlowQueries`) projects `query` for each statement the engine reports as
  costly, with its call counts and timings.

Those rows go into a prompt like any other result: fenced, bounded by the run's row and byte caps,
and never re-delivered on a resume. But a fence is a defence against injection, not a defence
against disclosure — so if a model provider outside your machine is configured, **an Operate run can
send your colleagues' running SQL and their database usernames to it.** Three things follow, all of
them yours to decide:

- It only happens on a run **you** opened as Operate. No other workflow is offered the tool.
- The reading has its own operation id (`db.operations.read`), so an operator can deny exactly this
  one in the audit stream without denying any other agent read.
- The other four kinds (`table-stats`, `index-stats`, `storage`, `health`) carry identifiers,
  counts, sizes and timestamps — no statement text and no usernames.

### 6. On a resumed run, what the ledger already holds

A drive that resumes a run first tells the model what the run established, read off its own ledger
(`describePriorProgress`, `investigation.ts:340-423`). That restatement carries: **the statements
the model drafted and their stated rationales**, the artifact ids and row counts of settled steps
(**not the rows** — "The rows themselves are not delivered again"), a recorded recommendation's
statement, a recorded comparison's two statements and access kinds, and a profile's depth, row count
and artifact id with the table name fenced.

---

## What comes back, and what is done with it

A model boundary has two directions, and the return one is where untrusted content actually lands:
everything below is **the model's own text**, arriving from the provider, and some of it is rendered
to a user and some of it goes to the database.

The loop reads a response part by part rather than awaiting a result (`takeTurn`,
`investigation.ts:600-606`) and keeps three things: the streamed prose, the tool calls, and the SDK's
own assistant messages (`investigation.ts:625-631`).

| What the model returns | What is done to it first | Where it is displayed |
| --- | --- | --- |
| **Its assistant messages** — its prose and the tool calls it made, together | **Nothing.** They are appended to the transcript verbatim (`investigation.ts:792`), because rewriting an assistant turn would desynchronise `tool_call_id`, so they are **not fenced** and are resent on every later turn. This is the mechanism of B29 below | Not displayed as such. Only the parts below reach the rail |
| **A tool call's arguments** | Parsed against that tool's own schema first (`parseToolInput`, `tools.ts:987`). A shape the schema rejects is answered with server text and reaches no database | — |
| **The SQL of a read** (`run_read_query`) | After the schema, it goes to the database through the agent's own audited pipeline, under the read-only execution profile (`runReadQueryTool`, `tools.ts:1051-1058` → `executeAgentOperation`, `tools.ts:809`). It is recorded verbatim as a `statement-drafted` entry with the model's `rationale` (`investigation.ts:859`) | The rail: the SQL as a quoted block, the rationale as the entry's detail (`timeline.ts:378-385`, rendered at `AgentRail.tsx:693,699-703`). **Apply to editor** puts the text in your editor and runs nothing (`AgentRail.tsx:176-186`) |
| **A recommended statement and rationale** (`recommend_change`) | The statement is checked against the change it claims to be, and every citation against this run's own ledger; either failing refuses it (`tools.ts:1402-1407`). **Nothing executes it** — the tool reaches no database | The rail: statement quoted, rationale as detail, with the application's own *"Not applied: nothing here runs this statement."* appended to it (`timeline.ts:421-430`) |
| **Report claims** (`compose_report`) | Every citation is verified against this run's own event log, and one that resolves to nothing refuses the whole report (`composeReportTool`, `tools.ts:1488-1489`). The claim prose is **not echoed back** to the model: the tool's reply is a count (`tools.ts:1503-1505`) | Recorded (`investigation.ts:1040`) and rendered in the **Report** section, each claim a quoted block with its citations under it; a citation the rail cannot resolve reads amber rather than looking checked (`AgentRail.tsx:745-758`, `timeline.ts:556`) |
| **Its closing prose** | Accumulated from the stream's text deltas (`investigation.ts:601`, taken at `:788`) and recorded only when non-empty, so an empty entry cannot record that the model spoke (`:773`) | The rail, under the application's own headline *Closing statement* — as prose, with the headings, bullets, bold and inline code the model wrote (`renderProse`), inside a bordered block that keeps the quoting boundary visible |

Three notes about that last column, because the rail's own rule is narrower than it first reads:

- **One of those fields is the application's `detail`, not the quoted block**: a drafted statement's
  `rationale`. The separation the rail enforces — the application's words and text from elsewhere
  never share a field (`timeline.ts:25-36`) — is what keeps **database** content out of a sentence
  the user reads as the application speaking, and this one is model prose sitting in the field beside
  the application's own headline. The closing prose used to be there too and is now a third field,
  `prose`, rendered as markdown in a block of its own: it arrives as headings and bullets, and one
  paragraph of literal hash marks is what a plan run's whole output read as before.
- **None of it reaches an HTML parser.** Every one of these is passed as a React child, so escaping
  is structural rather than a step someone applies; `dangerouslySetInnerHTML` appears nowhere under
  `src/components/agent/`. That is true of the markdown rendering too — `renderProse` builds React
  nodes and uses no markdown library, so structure is gained without a parser being introduced.
- **Nothing returned becomes an instruction to the next turn.** The system instructions are built
  from constants once per drive (`systemPrompt`, `investigation.ts:240-243`, called at `:697`) and
  `takeTurn` is handed that same string unchanged on every turn (`:787`, used at `:580`).

---

## What #352 added to the boundary

`0a4040b` ("tell the model what a citation is") changed what crosses the boundary, and the change is
worth naming because it is instructions and identifiers rather than data:

- **The evidence contract, as an example object.** `AGENT_EVIDENCE_CONTRACT` renders
  `{"source":"artifact","correlationId":"…"}` and `{"source":"context-snapshot","fingerprint":"…"}`
  into the run's opening rules and into two tool descriptions (`tools.ts:299-316,392,397`,
  `investigation.ts:173-180`). Server text, with placeholders where the ids go.
- **An artifact id at the moment it changes hands.** Every completed read is now preceded by
  *"Stored as artifact `<id>`. To use it in a claim, cite it as {…}"* (`handoverText`,
  `tools.ts:936-937`), and the schema snapshot is preceded by the same sentence for its fingerprint
  (`snapshotHandoverText`, `investigation.ts:258-259`). Both ids are **server-minted** — a UUID and
  a `ctx_…` digest — so nothing untrusted is spliced into a sentence the model reads as the
  server's.
- **Those sentences sit OUTSIDE the fence, deliberately.** A fence is a region the model is told to
  treat as data and never as instruction, so an instruction inside one is an instruction the model
  is right to ignore. That is why `packContextForTask` takes a `preface` parameter instead of the
  caller concatenating one — anything prepended outside the function would overrun its character
  bound by exactly its own length (`context-snapshot.ts:453-470`).
- **The same contract reaches two refusals**: a wrong-shaped tool input and a citation that resolves
  to nothing (`tools.ts:479,609`).

**What else crosses that boundary, checked rather than assumed.** The tool set itself is sent on
every turn: each selected tool's **description and JSON schema** are handed to `streamText`
(`declaredTools`, `investigation.ts:551-560`). Those descriptions are constants in `tools.ts` — the
selector text, the row-budget warning, the "only COUNTS are returned" sentence — and they contain
nothing of yours. Tool **call ids** and step ids also travel: a step id is a SHA-256 digest of the
tool name and the arguments that reach the database (`deriveStepId`, `investigation.ts:482-498`),
which is server-computed but derived from model-supplied SQL, so treat it as a fingerprint of the
statement rather than as an opaque token.

---

## The fence, and what it does not do

Everything derived from the database is wrapped by `fenceUntrustedContent`
(`src/lib/agent/untrusted-content.ts:71-76`): a header naming what the block is, which operation
produced it and which id it joins to; a fixed instruction that the lines are data and must never be
followed as instructions; and a pair of markers bounding the region.

The load-bearing property is **not the wording — it is that the envelope survives the content.** A
row value carrying the closing marker would otherwise end the region, and everything after it would
read as the server's own prose. So both markers are neutralised wherever they occur inside the
content, case-insensitively, including in the header (`neutralise`, `untrusted-content.ts:57-63`).
Neutralising rather than deleting is deliberate: the content is evidence, and a silently edited
result would make what the model reads disagree with the rows the artifact store holds.

`tests/evals/injection.test.ts` is what proves it, and it proves it **by counting rather than by
sampling**: a transcript holds exactly as many closing markers as the server opened, whatever the
database returned.

Two limits stated as plainly as the property:

- **This is a labelling boundary, not a sanitiser.** It makes no claim about what the content MEANS
  — only that a reader can tell where the server stopped talking
  (`untrusted-content.ts:22-23`).
- **A fence is not enough for a notation the server writes.** A fence says where the server stopped
  talking; it does nothing about a table named `orders -> secrets` producing a line that reads as a
  relation. That is why the relations block quotes and escapes every identifier as well as fencing
  the block (`er-diagram.ts:10-19`).

---

## B29: the open unfenced path

**An identifier the model quotes back into its own tool arguments reaches the transcript unfenced.**
This is open, not closed, and it is not a bounded residual.

The mechanism: after each turn the loop appends the SDK's own assistant messages verbatim
(`investigation.ts:625-631`) — the model's words, including the arguments of the tool calls it made.
Those arguments are not passed through the fence, because an assistant message is the model's turn
rather than the server's, and rewriting it would desynchronise `tool_call_id`. An attacker who can
name a table controls the whole identifier, so they control the marker *and* arbitrary text after
it; the surrounding JSON does not make that suffix safe.

What **is** true, and is a different claim: **the server never hands the model the raw marker.**
Every server-authored path neutralises it first, so a model reading a hostile inventory sees the
defanged spelling and has nothing to copy — to get the raw marker into an assistant message the
model has to reconstruct it. Both halves are asserted in `tests/evals/injection.test.ts`: that the
fenced inventory carries no raw marker, and that the transport does not prevent one if the model
produces it anyway.

The other half of the boundary is what stops that mattering more than it does: obeying injected text
changes nothing about what the run may **do**. A write is refused by the statement guard before the
database, a tool the run was never offered does not exist for it, and a claim citing something the
run never read cannot be composed — each asserted against the deciding function in
`tests/unit/agent-policy-gates.test.ts`.

Full entry: `docs/BACKLOG.md` B29.

---

## How much can leave

The frozen execution policies are the ceiling on one run's egress, one row per workflow
(`AGENT_WORKFLOW_BUDGETS` in `src/lib/agent/execution-policy.ts`):

| Bound | Value | What it caps |
| --- | --- | --- |
| `maxResultRows` / `maxResultBytes` | 200 rows / 256 KiB | The most one read can return — and therefore the most one tool result can send |
| `maxStatementsPerRun` | 12-45, by workflow | Reads per drive, catalog reads and repairs included |
| `AGENT_CONTEXT_PACK_MAX_CHARS` | 6000 | The fenced schema inventory |
| `MAX_ER_CHARS` | 2000 | The fenced relations block |
| `AGENT_MAX_OBJECTIVE_LENGTH` | 4000 | Your objective |
| `maxModelTurns` | 20-60, by workflow | Model calls per drive |

An oversized read is **refused, not truncated**, so a result that reached the model is a complete
one. Note the honest edge: the comparison happens after the driver has materialised the rows, so an
oversized read is refused but still paid for at the database.

Every one of these is **per drive**. A run resumed after a restart starts each of them again
(`docs/BACKLOG.md` B6).

---

## What never leaves

- **Database credentials.** A run persists a connection id and no credential, and the state guard
  refuses to persist anything credential-shaped, a client, a pool or a raw result set
  (`src/lib/agent/state-guard.ts`). No message assembled in `investigation.ts` carries a host, a
  port, a user or a password — the message array is built only from the sources listed above
  (`investigation.ts:698-700,736-737,743,753-754,792,801`).

  **One credential does leave, necessarily: your `LLM_API_KEY`.** It is not in a prompt — it is in
  the request's authentication metadata, because that is how the provider authenticates you. The
  OpenAI-compatible kinds send it as the `Authorization` header
  (`src/lib/agent/provider-registry.ts:106,123-126`) and Gemini passes it to the Google provider
  (`:141`). Two consequences worth stating: a keyless Ollama gets a placeholder token and a keyless
  custom endpoint gets no `Authorization` header at all (`:107,110`), so neither invents a
  credential; and Gemini is deliberately given no `baseURL`, so a stale `LLM_API_URL` cannot
  redirect that key to another host (`:134-146`). "No credentials leave" would be the wrong claim
  here — the accurate one is that **no database credential** reaches the model, while the model
  provider's own key reaches the model provider and nothing else.
- **Cell values from a table's own columns.** No agent path reads a row out of a user table and
  puts it in a prompt except a read the model performed and you can see in the timeline. Note the
  boundary this does NOT cover: an Operate run's `sessions` and `slow-queries` readings carry
  statement text and usernames from the engine's own operational views, which is a different thing
  from a table's contents and is documented as its own exposure above.
- **Cell values from a profile.** The Assess workflow's profile is aggregates only: counts of rows,
  present values, distinct values, and shape matches computed with `count(CASE WHEN … LIKE …)`
  *inside* the database. There is deliberately no `min`/`max`, because on a text column those return
  real values (`src/lib/agent/table-profile.ts:1-27`).
- **Rows a resumed run already read.** They are named by artifact id and row count and are not
  delivered again (`investigation.ts:306-313`).
- **Your session.** A run's actor — session id and role — is written into its ledger for
  authorization and is never part of a prompt.
- **Anything at all when the model provider is not configured.**

---

## Where prompts do not go

- **Not into the server log.** `streamText`'s default `onError` writes the raw provider error to the
  console, and an `APICallError` carries `requestBodyValues` — the entire prompt. It is silenced
  deliberately in both places that call the SDK, and the error is read off the stream instead
  (`investigation.ts:588-591`, `capability-probe.ts:36-40,257-259`).
- **Not into the audit trail.** Agent audit events carry the operation id, an `agent:<role>` actor,
  the outcome, a reason code, elapsed time and a correlation id — never the statement, the session
  identifier or the driver's message (`docs/SECURITY.md`, control 3.5).
- **Not into the browser as provider text.** A drive failure crosses to the rail as a *label*; the
  provider's or driver's own message stays in the server log, because none of them promises to keep
  a credential or a host name out of it (`docs/AGENT.md`, "A drive that dies before the loop").

---

## The other AI surfaces

The agent is not the only thing that can reach a model. **Four surfaces remain, over three routes** —
`describe-schema` is reached from two of them — each on an explicit user action, and none of them
fences what it sends:

| Feature | Route | What the browser sends | Call site |
| --- | --- | --- | --- |
| Visual EXPLAIN's AI explanation | `POST /api/ai/explain` | `query`, `explainPlan`, `schemaContext`, `databaseType` | `src/components/VisualExplain.tsx:486-497` |
| Query safety dialog | `POST /api/ai/query-safety` | `query`, a filtered `schemaContext`, `databaseType` | `src/components/QuerySafetyDialog.tsx:167-171` |
| Database documentation | `POST /api/ai/describe-schema` | A schema string built from table names, row counts and column definitions | `src/components/DatabaseDocs.tsx:61-68` |
| Data Profiler's AI summary | `POST /api/ai/describe-schema` | Per column: null percent, distinct count, **`min=` and `max=`** | `src/components/DataProfiler.tsx:117-142` |

**That last row is the one to read carefully.** `/api/db/profile` computes `MIN(col::text)` and
`MAX(col::text)` per column (`src/app/api/db/profile/route.ts:96-97`), and the Data Profiler puts
both into the context it sends for an AI summary. Those are **real values out of your columns** —
the lexicographic first and last of each profiled column. It is the sharpest difference between the
two profiling surfaces in this product: the agent's `profile_table` was built so that no value can
leave, and the legacy profiler's AI summary sends two per column.

None of the four surfaces fires on its own: each is behind a control the user presses.

---

## Verifying this page yourself

```bash
# Every message the run loop assembles
grep -n "messages.push\|toolResultMessage" src/lib/agent/investigation.ts

# Every place database-derived text is wrapped before it can reach a prompt
grep -rn "fenceUntrustedContent(" src/lib/agent/

# Every request that leaves for a model provider
grep -rn "streamText(" src/lib/agent/

# Every absolute URL in the server and the launcher. Read the hits: most are
# hrefs and comments. Exactly two are hosts a request can go to without you
# naming them - the OpenAI default base URL, reached only if you set
# LLM_PROVIDER=openai (src/lib/llm/utils/config.ts:23), and the release
# download in the npx launcher (bin/lib/launcher-utils.mjs:87).
grep -rn "https://" src/ bin/
```

Related: [`docs/AGENT.md`](./AGENT.md) for behaviour, [`docs/AGENT_GUIDE.md`](./AGENT_GUIDE.md) for
the surface, [`docs/SECURITY.md`](./SECURITY.md) for controls 3.4 and 3.5.
