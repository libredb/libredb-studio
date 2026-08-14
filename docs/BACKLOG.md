# Backlog — known defects and deferred work

Work that is known, understood, and not yet scheduled. Every entry here was found while doing
something else — a maintenance sweep, a review, a live probe — and was verified against the code at
the time it was written down, but none of it has been filed as a GitHub issue.

**How this file is used**

- The GitHub issue tracker holds work that is filed, triaged, or in progress. This file holds
  everything else: defects nobody has scheduled, deliberate deferrals, and open questions.
- An entry states what is wrong, where, and what "done" looks like — enough for someone to pick it
  up cold without re-deriving the finding.
- **Delete an entry when the work lands.** A fixed item leaves this file; it does not get a
  strikethrough or a DONE marker. Git history is the record of what was here.
- Re-verify before acting. Line references and behaviour claims age, and some entries name a
  reading of a database's grammar that ought to be checked against a first-party source again.
- Promote an entry to a GitHub issue whenever it needs discussion, an outside reporter, or a
  release note. This file is a holding area, not a competing tracker.
- The reverse happens too. An issue that is understood, breaks nothing today and is not scheduled
  belongs here rather than in a tracker where it only ages: it is closed with a pointer to its entry
  and reopened if a consumer asks for it. A defect a user can hit stays an issue — closing one of
  those hides a limitation instead of deferring it.

---

## SQL statement reading

The readers under `src/lib/sql/` decide where a statement starts, where it ends, and what operates
it. `src/lib/sql/grammar.ts` gave them a dialect (#292); these are what that channel does not yet
cover.

### S1. `statement-splitter.ts` is dialect-blind, and one shape yields a runnable bare `DROP`

`src/lib/sql/statement-splitter.ts` runs its own span walk instead of `spans.ts`, so it disagrees
with every other reader: a `;` inside a MySQL `#` comment, an Oracle `q'{a'b;c}'` body, a `[a;b]`
name, or a backtick-quoted subscript key each split one statement into fragments.

The sharp case: `/* a /* b */ ; DROP TABLE users; -- */ SELECT 1` splits into three fragments whose
second is a bare, valid `DROP TABLE users` that the multi-statement route would run — while
`isDangerousQuery` answers false, because the confirmation gate reads the whole editor text and
never the fragments. Same family as #300, wider blast radius.

Done when the splitter reads spans through the shared reader with the caller's dialect, and the
confirmation gate and the splitter agree about what is going to run.

### S2. Backslash escaping is not a grammar fact

Whether `\` escapes inside a string literal differs by dialect (and, in MySQL, by session mode).
Making it a row in `SqlGrammar` would narrow the false confirmation prompts introduced by #297 and
would remove the MSSQL blunt decline in S4 entirely.

Deliberately left out of maintainer-sweep-5: it retypes every literal in every dialect — a far wider
behaviour change than any bar in that milestone asked for — and it would destroy the premise of two
fixtures that milestone required (the "end cannot be cut because a literal is undeterminable" case
and the "genuinely unresolvable text still has to ask" case). Those fixtures need replacing with
shapes that stay unresolvable once `\` is understood.

The single largest follow-up from that sweep.

### S3. Comment and escape forms no reader models

- **MySQL executable comments.** `/*!40000 DELETE FROM t */` is an ordinary comment to every reader
  here, and MySQL executes it. Nothing asks before it runs.
- **ClickHouse `//`.** Accepted as a line comment (live-verified), modelled nowhere, so
  `// note\nDROP TABLE t` answers not-dangerous.
- **MySQL connection charset.** On a `latin1` connection a leading U+00A0 executes.
  `buildPoolConfig` passes a user's connection string straight to mysql2 as `uri`, so the charset is
  outside the readers' view entirely.

### S4. MSSQL: a parameterised page is still unrecognised

`… OFFSET @skip ROWS` is not recognised as a page, so the statement collects a `TOP` and the server
refuses it. This is a limitation of the shared probes' literal-count reading as much as of the
provider. Verified by probe and documented in `docs/providers/mssql.md`.

Related: the decline that keeps #293 safe keys on an unanchored `OFFSET`/`FETCH` mention wherever the
cut was refused. The precise alternative — walk forward to where the unresolvable region starts — is
only meaningful for a mention *before* the bad span, and costs a new shared-reader API.

### S5. The limiter's whole-body probes still read inside comments

`src/lib/db/utils/query-limiter.ts` runs its `ROWNUM` test, its `UNION` test and its subquery
`SELECT` count over the whole statement text, so a statement that merely *mentions* a bound in an
interior comment reads as already bounded. The statement's *type* stopped being fooled this way in
maintainer-sweep-4/5; these flags did not.

### S6. Grammar facts left undecided

`grammar.ts` records a fact as established only when a first-party source was found for it, and
writes `DEFAULT_SQL_GRAMMAR.<fact>` where it was not. Currently undecided:

| Fact | Undecided for |
|---|---|
| `[…]` bracket reading | mysql, oracle, couchbase, druid, libredb |
| `#` | couchbase, druid, libredb |
| block-comment nesting | couchbase, druid, libredb |

None of these currently costs everyday syntax anything — `[` carries no meaning in ordinary MySQL or
Oracle SQL, and the three HTTP/embedded dialects were never probed for the other two facts. The cost
of leaving one undecided is real when the dialect does use the syntax, which is why PostgreSQL's
bracket row was established rather than left here: at the name reading, `ARRAY[[1,2],[3,4]]` and
`j['a]b']` lost their bound and prompted for confirmation on an ordinary read.

**Rows resting on documentation alone, worth re-checking against an artifact:** ClickHouse's `#` and
bracket rows (HTTP-only provider, no driver package to read), MSSQL's block-comment nesting row
(tedious ships no tokenizer), PostgreSQL's bracket and block-comment rows (`pg` is a wire-protocol
driver and carries no SQL tokenizer, so both rest on the manual), and the `nq'…'` spelling of Oracle's
alternate quoting.

### S7. A confirmation refinement that was considered and rejected

Scanning an unreadable region for destructive vocabulary and asking only when a write could plausibly
be in there. Sound on its face, but it substitutes a cleverer reading for the honesty rule #297
pinned — the gate asks because it *cannot* read the text, not because it guessed what is in it. Only
revisit this with an explicit product decision.

---

### S8. The confirmation gate's destructive vocabulary is SQL-only

`isDangerousQuery` recognises SQL keywords, so it is close to inert for the two non-SQL types it is
nevertheless asked about: a Redis `FLUSHALL` or `DEL key`, and a MongoDB `{"operation":"drop"}`, are
destructive and match nothing. The span-based half of the gate no longer fires on their text at all
(it is not SQL, so a SQL reader's verdict about it means nothing), which makes the keyword half the
only thing left — and it does not speak their languages.

Done when a destructive MongoDB operation and a destructive Redis command each ask before running,
driven from the same single type-to-facts place rather than a type test in the component.

---

## Drivers and connections

### D1. Fatal `error` events on the non-pooled clients were never audited

#298 covered the pooled SQL drivers (`pg` in both the database and storage layers, `mssql`; mysql2
and oracledb have no pool-level `error` event, and each `connect()` now records that). Whether the
MongoDB, Redis, ClickHouse, Druid or Couchbase clients expose a fatal `error` event that can reach
`uncaughtException` is an open question, not a claim.

### D2. Oracle, MongoDB and Redis ignore the SSL/TLS panel the connection dialog shows them

`ConnectionModal.tsx` gates the SSL/TLS and SSH tunnel panels on `!isFileBased(type)`, so every
engine except the two file-based ones (`sqlite` and the embedded `libredb`, both of which declare
`connectionFields: ["database"]`) renders both. The defect is narrow and specific: **the visible
`config.ssl` selection is not enforced by three providers.** `grep -rln ssl src/lib/db/providers/`
hits postgres, mysql, mssql, couchbase, clickhouse and druid; `oracle.ts`, `mongodb.ts` and
`redis.ts` never read it. A user who sets the mode to `require` on those three gets no error and no
guarantee - the connection may still be encrypted, but only if the connection string says so
(`oracle.ts:266` passes a supplied `connectionString` through verbatim, and the MongoDB driver
honours `tls=true` in the URI). Silently accepting a security setting and dropping it is the
problem, not plaintext per se.

Two related scope facts worth keeping straight, both established while correcting an earlier
overstatement of this entry:

- The SSH tunnel is genuinely provider-independent - `factory.ts:229` opens it and rewrites
  host/port before `createDatabaseProvider` - but it is skipped when either is absent. Connection
  string mode (`showConnectionStringToggle`: mongodb, couchbase, clickhouse) clears both in
  `use-connection-form.ts:173-179`, so those connections are not tunnelled even though the panel is
  offered.
- "Every engine except SQLite" is wrong twice over; see the file-based pair above.

Found while reviewing #317, corrected after Copilot's review of #318. The READMEs now state the
real scope, which closes the documentation half; the UI half is still open. Either wire the three
providers (oracledb supports TLS through the connect string, `mongodb` through `tls` options,
`ioredis` through `tls`) or hide the panel where it cannot be honoured.

### D3. Testing a connection to an already-open embedded file fails on its own exclusive lock

`POST /api/db/test-connection` calls `createDatabaseProvider` directly
(`src/app/api/db/test-connection/route.ts:28`) rather than going through the cached provider, which is
right for testing credentials the server has never seen — and wrong for an engine that permits one
writer. If the connection under test points at a file the cached provider already holds, the second
open is refused by the first:

```
[DB] Creating libredb provider for "Sample (LibreDB)"      <- cached, holds the file
[DB] Creating libredb provider for "My Sample"             <- the test, same file
ConnectionError: LibreDB file is already open by another process (exclusive lock).
```

Deterministic, not a race: it reproduces every time on the active LibreDB connection. The visible
consequence is worse than a failed test, because the connection modal tests before it saves — so
**editing the built-in LibreDB sample is impossible**, and the edit is discarded with only a toast
about a connection error, which reads as if the sample itself were broken. Reproduced against a
production build on 2026-08-12 while verifying the seed-eligibility fix (PR #336).

This is the phenomenon an earlier session recorded and then RETRACTED as unreproducible. The
retraction of the *explanation* stands — it was attributed to a read-then-write window in the provider
cache, which was read out of the code and never demonstrated, and is not what happens. The phenomenon
is real; the earlier attempts to reproduce it simply never went through the modal's test path.

Done when testing a connection that resolves to an already-open single-writer file reuses the open
provider instead of opening a second handle, or the test is skipped with an honest message for engines
that cannot be opened twice. Whichever is chosen, the modal must not present a lock conflict as a
failed connection test.

---

## Value interpolation

### V1. Query history records the placeholders, not the values that were bound

Since #290 the inline row editor sends `SET "name" = $1` with the value bound, and
`use-query-execution` writes that text to history — a truthful record of the statement the engine
ran, but no longer a record of what was written. Carrying the bound values as their own history
field would restore the audit trail without putting them back into the SQL. Touches the history
entry shape in `src/lib/storage`, so it is a schema change rather than a one-line fix.

---

## Row editing

### R1. Row editing is offered only where a shared `UPDATE` happens to fit (was #279)

The results grid builds one statement shape for every engine —
`UPDATE <table> SET <col> = <val> WHERE <pk> = <val>` in `src/hooks/use-inline-editing.ts` — so an
engine that spells a row mutation differently cannot have the feature. #269 made that honest rather
than broken: `supportsInlineRowEdit` hides the control wherever the shape does not fit, which is why
this is deferred work and not a defect. Today it is true for PostgreSQL, MySQL, SQLite, Oracle and
SQL Server, and false everywhere else.

Making it work means moving statement generation into the provider, so each dialect owns its own
form: the SQL providers keep the shape above, ClickHouse spells it `ALTER TABLE <t> UPDATE <col> =
<val> WHERE ...`, MongoDB has no statement at all and would need the document-update path, and an
append-only engine keeps declaring the capability false. The provider triad applies, so code,
`docs/providers/<type-id>.md` and the provider's integration test move together, per provider.

Two constraints come from #269 and do not go away:

- **One request per edited row.** Several engines reject a multi-statement request, so the old
  newline-joined payload cannot come back.
- **Primary-key detection is heuristic.** The hook picks the key by looking for a result column named
  `id` or ending in `_id`. That is acceptable for a control gated on an opt-in capability, but
  per-dialect editing on real tables should derive the key from the schema instead.

Whether row editing should be a universal feature at all is a product decision, not a mechanical one,
which is the other half of why it is here. The published `WorkspaceFeatures.inlineEditing` flag is
deprecated against this entry (#288): it becomes real, or goes away in a major, with this work.

---

## Authentication and security headers

### A1. Three copies of the 401 response, with two different shapes

`src/lib/api/require-session.ts:24` builds `{ error: "Authentication required" }` with status 401 —
the shared guard the security/phase-0-hotfix branch added for routes that reach a database or an
LLM provider. `src/lib/api/schema-route.ts:31-34` and `src/app/api/db/health/route.ts:28-31` build
the identical response inline, and both predate that branch: they were not converted to call the
new guard.

Separately, the storage routes (`src/app/api/storage/route.ts:21`,
`src/app/api/storage/[collection]/route.ts:22`, `src/app/api/storage/migrate/route.ts:23`) answer
`{ error: "Unauthorized" }` instead, so a client cannot rely on one error shape for "not logged in"
across the whole API.

Done when there is exactly one 401 response for this condition, built in one place, and every route
that needs it (including the storage routes) calls it. Deferred to Phase 1 rather than folded into
the hotfix: none of the three is wrong today, and consolidating them is a refactor, not a fix.

### A2. Static assets receive no security headers — decided, not implemented

`src/proxy.ts`'s matcher excludes any path matching `.*\..*` so that static assets skip the auth
redirect — `/((?!api/storage/config|_next/static|_next/image|.*\..*).*)`. (`api/db/health` was
also excluded here until it was found to be excluding `POST /api/db/health`, a state-changing
route, from the Origin check too — see SECURITY.md; it is no longer in this list, and GET's
load-balancer path is unaffected because the Origin check exempts GET by method.) The dot exclusion
is by design for auth (nothing under `public/` or `/monaco/vs/*.js` needs a login redirect), but it
means `proxy()` never runs for those paths at all: files under `public/`, `/monaco/vs/*.js` and
`_next/static` are served with none of the Phase 1 security headers (`X-Content-Type-Options` chief
among them), while every extensionless route gets the full set.

This was raised while Phase 1's header work landed and, having weighed it, was left as-is: these
are not documents, and Next serves them with correct content types, so MIME sniffing on them is not
a live threat. `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` belong to the same
decision and are outside the header set Phase 1 agreed. Done when either a second delivery
mechanism covers them (e.g. `next.config`'s `headers()`) or this entry is re-affirmed as permanently
accepted risk rather than revisited again.

---

## Tests

### T1. Two disjuncts are pinned by almost nothing

`isStatementText` (`src/lib/sql/statement-end.ts`) has a `dollar-string` disjunct pinned by exactly
one assertion. That is the same
hole that, for the `subscript` disjunct, let a statement-corrupting emission through the full gate,
CI, 100% line coverage and five reviews — deleting the disjunct failed zero tests. Line coverage
cannot see a missing disjunct in a one-line predicate; only a fixture where the two readings
*disagree* can pin it.

Done when deleting any single disjunct of `isStatementText` fails a test.

### T2. `tests/unit/db/factory.test.ts` shares a `pg` mock with the storage provider

The test mocks `pg` with a shared inert pool while the storage provider caches `Pool` in a
module-level variable, so in a shared process the first initialize decides which mock every later one
gets. Related to the `mock.module()` isolation rules in `docs/TOOLCHAIN.md`.

### T3. `tests/security/image-proxy.test.ts` asserts a configuration invariant, not the threat

The design this test protects is: `/_next/image?url=http://169.254.169.254/` (or any other
attacker-chosen URL) must be rejected, because `next/image`'s optimizer would otherwise perform an
unauthenticated server-side fetch of it. What the test actually asserts is narrower —
`nextConfig.images` is `undefined` — which is sufficient today only because nothing in `src/`
imports `next/image` at all (verified: `next.config`'s `images` key is never set, and no component
imports `next/image`), so the control is closed and correctly verified for the current codebase.

The gap is that the assertion is a proxy for the threat, not the threat itself, and a future,
strictly safer configuration would fail it: setting `images: { unoptimized: true }` (which disables
the optimizer's fetch behaviour entirely, closing the same threat a different way) would still trip
`toBeUndefined()`. The real assertion — that `GET /_next/image?url=<attacker URL>` is rejected —
belongs with the Phase 1 Playwright work, which can make an actual HTTP request against a running
server; a unit test importing `next.config` has no way to exercise the route itself.

---

## Dependencies

### P1. The desktop shell's `glib` advisory has no reachable fix while Tauri v2 targets GTK 3

Dependabot alert 1 (GHSA-wrw7-89jp-8q8g, medium) reports unsoundness in the `Iterator` and
`DoubleEndedIterator` impls of `glib::VariantStrIter`, affecting `>= 0.15.0, < 0.20.0`.
`desktop/src-tauri/Cargo.lock` carries `glib 0.18.5`, and it cannot move:

```
glib 0.18.5  <-  gtk 0.18.2 (requires glib ^0.18)  <-  tauri 2.11.5
```

`cargo update -p glib@0.18.5 --precise 0.20.0` fails on that requirement. Upgrading Tauri does not
help — 2.11.5 is the latest published version — and the `gtk` crate cannot deliver the fix either:
0.18.2 is its latest release and it is published as UNMAINTAINED, directing users to `gtk4`. So the
advisory closes only when Tauri's Linux backend moves off the GTK 3 bindings, which is upstream work
on their side.

Nothing in `desktop/src-tauri/` touches `glib`: the shell's direct dependencies are `tauri`,
`serde_json` and `libc`, and no source file references `glib` or `Variant`. The exposure is whatever
Tauri and GTK do with `VariantStrIter` internally, so the practical risk is low, but "we do not call
it" is not the same as proving the code path is unreachable.

Done when Tauri's dependency tree offers `glib >= 0.20` and the lock is updated, or when the alert is
dismissed with this reasoning recorded on it. Re-check on each Tauri upgrade — a one-line
`cargo tree -i glib` in `desktop/src-tauri/` answers it.

---

## Documentation

### X1. Provider-doc line references are stale across the board

`docs/providers/mssql.md` puts `getCapabilities()` at :57 and `getSchema()` at :369 where they are at
391 and 749. The drift predates any recent milestone and the same line-anchoring style is used in
every provider doc, so the fix is a convention change (anchor on symbol names, not line numbers) as
much as a correction.

### X2. Two chart README `--set` recipes render a YAML boolean where Kubernetes needs a string

`charts/libredb-studio/README.md`'s Content-Security-Policy escape hatch sets `CSP_REPORT_ONLY` with
`--set extraEnv[0].value="true"` (twice: the single-variable example and the two-variable one). The
shell strips the quotes and Helm type-coerces the bare word, so the manifest renders
`value: true` — an unquoted YAML boolean, while `core/v1.EnvVar.value` is a string, and the API server
rejects it (`invalid type for io.k8s.api.core.v1.EnvVar.value: got "bool", expected "string"`).
Reproduced with `helm template` on 2026-08-12. `--set-string` is the fix, one word per line.

Found while documenting the agent runtime in #329 T13, whose own new recipe uses `--set-string` for
exactly this reason. Left for a separate change rather than folded in, because it is a different
feature's documentation and the same PR's chart version bump is already spoken for. Done when both
lines use `--set-string` — and ideally when the README's `--set` bracket arguments are single-quoted,
since unquoted `extraEnv[0]` is a glob pattern in zsh.

### X3. Four channel listings still advertise NL2SQL, which the product no longer has

#331 T2 removed the NL2SQL and Autopilot panels, and #331 T6 rewrote the READMEs, `DOCKERHUB.md` and
`docs/FEATURES.md` around the agent. The **external channel listings were deliberately left out of
that PR**: each is a submission to somebody else's marketplace with its own review cycle, so they
change on their own schedule and not in a documentation PR. They are recorded here so the launch copy
is one list rather than four separate discoveries later.

Four files, with the exact strings that are now false:

| File | Line | The string |
| --- | --- | --- |
| `deploy/railway/TEMPLATE_OVERVIEW.md` | 3 | "with AI-powered query assistance (natural-language-to-SQL, explain, and fix)" |
| `deploy/digitalocean/assets/description-long.md` | 10 | "**AI-assisted SQL** — turn natural language into queries (NL2SQL)" |
| `deploy/rancher/CATALOG_LISTING.md` | 52-53 | "An optional AI assistant (bring your own key: Gemini, OpenAI, or a local model) writes and explains SQL from natural language and" |
| `deploy/azure/listing/listing-fields.md` | 76 | "2. `nl2sql` — \"Turn a plain-English question into SQL with AI assistance.\"" |

"Explain" survives the removal and "writes SQL from natural language" does not, so three of the four
need a rewrite rather than a deletion — the honest replacement is the read-only agent, which is what
the product now has. They are four separate submissions rather than one edit: the Azure entry is a
numbered item in that listing's own field contract, and each of the others is published by its
marketplace from the file above.

Done when each listing has been resubmitted through its own channel with copy that matches the
shipped product, and the entry is deleted then and not before.

---

## Security Phase 1 deferrals

Each of these was decided during Phase 1, not overlooked. Delete an entry when the work lands.

### H1. A CSP nonce needs the app to stop being statically prerendered

`src/lib/security/headers.ts`'s `script-src` carries `'unsafe-inline'`, so the policy does not block
an inline event handler. A nonce is the only alternative and it is blocked by a structural fact:
every document route is statically prerendered (`.next/server/app/index.html` and siblings, verified
— nonce-less `self.__next_f.push` scripts baked in) and a per-request nonce cannot be applied to
prerendered HTML. Next.js does support the plumbing —
`node_modules/next/dist/server/app-render/get-script-nonce-from-header.js` extracts a nonce from the
`script-src`/`default-src` directive of a CSP header the app supplies — and Monaco's loader supports
`loader.config({ cspNonce })` (`public/monaco/vs/loader.js:206,430`).

The experiment, so nobody re-derives it: force dynamic rendering on the root layout, thread the
nonce into the Monaco loader config, then measure what the lost prerendering costs in cold-start
time and in the channels that serve Studio from a small box. Done when either the measurement says
the trade is worth it and the nonce ships, or the measurement is recorded here as the reason it does
not.

### H2. A 429 should produce a Retry-After-aware toast

`src/hooks/use-query-execution.ts:267-269` already reads `.error` from any non-ok body, so a
rate-limited request shows its message today. What it does not do is read the `Retry-After` header
and tell the user how long to wait. Done when the toast names the wait.

### H3. Audit events do not record a user agent

`AuditEvent` (`src/lib/audit.ts`) deliberately has no `userAgent` field: it is attacker-controlled
free text with marginal value for a single-operator product, and adding it means adding the
redaction question the closed `AuditReason` union exists to avoid. Done when a real investigation
needs it, at which point it is added as a truncated, explicitly-allowlisted field.

### H4. The `@libredb/studio/security` usage note is not in the published README

`.claude/rules/platform-integration.md` carries the platform-facing contract for
`securityHeaders()`, which is where a platform constraint belongs, but an npm consumer reading
`README.md` on npmjs.com does not see it. It is left out of `README.md` because `README_zh.md` and
`README_ja.md` (`scripts/readme-check.mjs`'s `LOCALIZED` pair) would then drift, and that script
guards the pair structurally rather than by heading. Done when the note lands in all three READMEs
together.

### H5. No env var can turn HSTS off, and that is deliberate — a lesser hatch would be worse

`src/lib/security/config.ts`'s `readSecurityHeaderOptions()` always sends
`Strict-Transport-Security`; unlike `CSP_REPORT_ONLY`, there is no `HSTS_DISABLE` or similar, and one
should not be added in the shape an operator would expect. An escape hatch that merely *stops
sending* the header is useless against the failure it would be built for: a browser that already
cached the HSTS pin keeps enforcing HTTPS-only for the remainder of the 180-day `max-age`
(`HSTS_MAX_AGE_SECONDS`) regardless of what the server does next, and a server that has already
reverted to plain HTTP may not even be reachable by that browser to serve the corrective response —
HTTPS-only means the plain-HTTP origin is refused before any response body is read. The only hatch
that actually works is one that emits `Strict-Transport-Security: max-age=0` over a still-live HTTPS
listener, which is what tells a visiting browser to drop the pin; a server that can no longer speak
HTTPS at all has no way to reach that browser regardless of what knob exists. Done when a real
report of a stuck HSTS pin needs this, at which point it is a `max-age=0` mode, never a header
omission.

### H6. A coverage-phantom pattern can recur anywhere a rarely-covered function has a multi-line inline parameter type

`scripts/merge-lcov.mjs` picks one "authority" record per source file — whichever test run has the
most executed lines — to decide which lines are "coverable" (`docs/TOOLCHAIN.md`'s "Coverage
measurement" section). A function with a multi-line inline parameter type
(`function f(opts: { a?: string; b?: string; ... })`) that is exercised by only one test file today
reads as fully covered because that file wins the authority vote. Adding a second test file that
exercises a large *new* surface in the same source file — without ever calling that function — can
tip the vote to the new file, whose own run reports the old function as a coarse, never-executed
block whose zero-hit lines include the parameter type's continuation lines. The result looks like a
genuine coverage regression in code nobody touched. `src/lib/audit.ts`'s `AuditRingBuffer.filter`
hit exactly this during Phase 1 (Task 4): extracting the inline type to a module-scope interface
fixed it permanently there, because module-scope type members are erased before any function's
coverage span exists. The general fix is the same wherever the shape recurs: hoist a multi-line
inline parameter (or return) type annotation to a module-scope `interface`/`type`, don't chase it by
adding a test that calls the under-covered function for coverage's sake alone.

### H7. `sanitizeAuditInput` does not recurse, so a nested secret survives inside the coerced string it now produces

`src/lib/audit.ts`'s `sanitizeAuditInput` originally sanitized a value only when
`typeof value === "string"`, silently skipping everything else. That was corrected for I3 of the
Phase 1 review: a top-level value that is neither a string nor `duration`'s legitimate number is
now coerced to a string (`JSON.stringify`, then the same `sanitizeAuditField` a real string goes
through) rather than passed on as-is. The claim this entry originally made — "bounded to the ring
buffer, not stdout, because `toAuditLine`'s allowlist never re-serializes an unknown property" — was
true for the `details` field specifically (`toAuditLine` does not carry `details` at all) but false
as a general rule: `target`, `user`, `action`, `connectionName`, `ip` and `bucket` are all
allowlisted onto the stdout line, all string-typed, and all reachable with a non-string runtime
value the same way `POST /api/db/maintenance`'s `target` was (its own untyped
`await request.json()` body, no runtime validation). The coercion fix closes that gap: a nested
object reaching any of those fields is now bounded (254 chars, same as every other free-text field)
and reaches both destinations as a string, not an object, wherever it lands.

The residual this entry now tracks is narrower: coercion is whole-value, not recursive per-key
redaction. `sanitizeAuditField`'s credential pattern only recognizes a URI-shaped
`scheme://user:pass@host` substring, so a nested secret under an arbitrary key name (for example
`{"apiKey": "sk-live-…"}`, as opposed to a connection string) is bounded and no longer breaks the
shape contract, but is not specifically redacted — it survives, truncated, inside the single
JSON-stringified value. Done when nested plain objects are walked key-by-key (bounded depth, to
avoid a cycle or a pathological document costing unbounded time) so a non-URI-shaped nested secret
gets the same by-key-name scrutiny a top-level one does — no such scrutiny exists for any field
today, top-level or nested; this is a new capability, not a gap being closed.

### H8. The rate limiter's lowest-count eviction lets an attacker buy back a `login_account` guess for a real, but audit-invisible, cost

From `src/lib/api/rate-limit.ts`'s `pruneIfAtCapacity` doc comment, recorded here as instructed: an
attacker can *"buy back one guess against an established `login_account` target sitting at count N
for roughly `(MAX_ENTRIES_PER_BUCKET - 1) x N` decoy requests - not a flat `MAX_ENTRIES_PER_BUCKET -
1` (about a thousand), because each of the ~999 decoys must itself be raised from 0 to N, not merely
inserted once, before the tie-break can fire. At the bucket's current default (20), a target one
guess from tripping (N=20 - `decide()` checks `entry.count >= limit.max` before incrementing, so an
entry with one guess left in its budget sits at count 20, not 19) costs on the order of 999 x 20 -
about twenty thousand decoy requests, by raising that many other entries to TIE (not exceed) the
target's count - the tie-break favors evicting the earliest-inserted member of a tied group, and the
target, having been created before its decoys, always is. This is a real, linear cost multiplier and
not a bypass, but unlike a tripped bucket it produces no `rate_limit_exceeded` audit event, so an
operator watching only the audit trail would not see it happen."* Accepted for
Phase 1: the eviction policy that produces this (lowest-count, not oldest-first) is itself the fix
for a worse bypass (an attacker evicting a target's entry for free before it can accumulate any
cost), and the two alternatives considered and rejected each introduced a worse flaw. Done when a
cheaper, audit-visible eviction policy is found that does not reopen the oldest-first bypass.

### H9. `admin/fleet-health`'s per-request fan-out width is unbounded by the route guard

`src/app/api/admin/fleet-health/route.ts` shares the `query` rate-limit bucket via `guardRoute`, the
same as every other database-reaching route, but the guard limits *request rate*, not *fan-out
width*: the handler runs `Promise.all(connections.map(...))` over whatever `connections` array the
caller's JSON body names, with no upper bound on its length. One admin-authenticated (or stolen
admin) POST can open and health-check an arbitrarily large number of connections concurrently — a
resource-exhaustion vector the per-request rate limit does not touch, because it is a single request
however large its body is. Done when the handler caps the array length (a `400` above some bound) or
chunks the fan-out, whichever the real usage pattern (how many managed connections a fleet-health
dashboard actually names at once) supports.

### H10. The route-guard allowlist in `tests/security/route-auth.test.ts` verifies existence, not truth

`ROUTES_WITHOUT_A_PROVIDER` in `tests/security/route-auth.test.ts` is a hand-maintained map from
route key to a one-line reason the route is exempt from the "requires a session" sweep. The only
automated check on it (`"every allowlist entry names a route that actually exists"`) confirms each
key matches a real route discovered on disk — it does not, and cannot easily, verify that the
*reason* is still true. Nothing greps an allowlisted route's file for a provider import
(`@/lib/db`, `getOrCreateProvider`, `createLLMProvider`, and similar), so a future edit that adds a
provider call to one of these routes (say, `storage/migrate` growing a database-backed feature)
would silently escape the guard sweep the allowlist exists to police, exactly the failure mode the
enumeration itself was built to catch for undiscovered routes. Done when a second, independent check
greps each allowlisted file for provider-reaching imports and fails loudly if one appears.

### H11. `login_account`'s hard cap is an accepted denial-of-login handle on a known account

`src/lib/api/rate-limit.ts`'s `login_account` bucket (keyed on `hmacHex(submittedEmail)`, immune to
`X-Forwarded-For` spoofing) throws before the credential comparison runs, and is cleared only by a
*successful* login, which cannot happen while the bucket is tripped. Anyone who knows or guesses a
real account's address - the published default `admin@libredb.org` when `ADMIN_EMAIL` is unset makes
this free - can lock that account out for the rest of the window with the bucket's own default (20
wrong guesses), and renew the lockout indefinitely afterwards at roughly one wrong guess per window.
`login_client`, the address-keyed bucket, does not help here: it is bypassed in any topology where an
attacker can set or rotate `X-Forwarded-For` (direct exposure, or a proxy that appends rather than
overwrites the header - Caddy and Traefik defaults, and the common nginx `proxy_add_x_forwarded_for`
recipe, all qualify). This is inherent to a hard per-account cap, not a defect to design away:
bounding brute force against an operator-set password and bounding this lockout are in direct
tension, and no design removes one side without giving up the other. `.env.example` documents
`RATE_LIMIT_LOGIN_ACCOUNT_MAX=0` as the break-glass (verified: `decide()` returns `allowed: true`
unconditionally for `max === 0`, for both `peekRateLimit` and `consumeRateLimit`, so the bucket is
fully inert, not merely permissive). Phase 1 narrowed the window from 900 to 300 seconds to shrink
the lockout's blast radius without materially loosening the guess ceiling; it did not and cannot
remove the residual. Done when a design is found that keeps this bucket immune to header spoofing
without also being a stranger's denial-of-login switch on a known account - unknown at the time of
writing.

### H12. A role-based denial is never audited, and `insufficient_role` has no emitter

`AuditReason` includes `insufficient_role` in its closed union, but no call site ever constructs an
event with it. Every denial the audit trail actually records is a SESSION or ORIGIN check failing
(`no_session` from `src/lib/api/require-session.ts`'s `guardRoute`, `origin_mismatch` from
`src/proxy.ts`'s Origin check) - not a ROLE check failing for an already-authenticated caller. Four
in-handler admin-only checks return their 403 with no audit call at all: `GET` and `POST
/api/admin/audit` (`src/app/api/admin/audit/route.ts:9`, `:28`), `POST /api/admin/fleet-health`
(`:29`) and `POST /api/db/maintenance` (`:18`). The proxy's own `/admin` RBAC redirect
(`src/proxy.ts:116`, a non-admin token requesting an `/admin` page) is the same gap at the
middleware layer: it silently redirects to `/`, no audit line, no `insufficient_role` reason ever
used anywhere in the codebase. An admin session (or a stolen one) probing for a role it does not
hold leaves no trace in the one channel this project treats as authoritative. Done when each of
these five call sites emits a `permission_denied` event with `reason: "insufficient_role"`, the same
pattern `guardRoute` already uses for `no_session`.

### H13. No rate-limit bucket is a global, unkeyed ceiling - and Phase 1 leaves it that way on purpose

Every bucket in `src/lib/api/rate-limit.ts` is keyed on something the caller supplies:
`login_client`/`anon` on the derived client address (`X-Forwarded-For`, attacker-controlled in any
topology without a correctly configured `TRUSTED_PROXY_HOPS`), `login_account` on a hash of the
submitted email (fully attacker-chosen, see H11), and `query`/`ai` on the session's username
(attacker-chosen only in the sense that it requires a session at all). A global, unkeyed ceiling -
one counter for an entire bucket regardless of key - is the one shape that cannot be evaded by
picking a favourable key, because there is no key to pick. Phase 1 does not add one, and this is a
deliberate scope boundary for this wave, not an oversight: a global ceiling on `login_client` or
`anon` turns one attacker's flood into a lockout for every other concurrent user of the same bucket,
which is a strictly worse failure mode than the keyed floods it would prevent, and getting the
sizing right (a ceiling loose enough not to bite a legitimate multi-tenant deployment, tight enough
to bound an attacker) is its own design problem this wave did not scope. Recorded here because
`src/proxy.ts`'s rejection warn log (`observedOrigin`, bounded per I4 of the Phase 1 review) and the
`anon` bucket it shares with `guardRoute`'s denial path are the closest thing to a global counter
this codebase has today, and it is still address-keyed. Done when a real, measured flood (not a
hypothetical one) makes the keyed buckets' residual insufficient and a global ceiling's sizing can
be grounded in that data rather than guessed.

---

## Security Phase 2 deferrals

Each of these was decided during Phase 2, not overlooked. Delete an entry when
the work lands. Lettered `C` (supply **C**hain) rather than `S`: the SQL
statement-reading section above already owns `S1`-`S8`.

### C1. No scan check is a required check

Branch protection requires `Lint, Typecheck and Build` and `Unit & Integration
Tests`. Phase 2 adds three scan jobs and promotes none of them, because promoting
a check is a branch-protection change the repository owner makes, and because two
of the three consult a vulnerability database that is rebuilt every six hours -
making them required would import that schedule into the merge gate. **`Secret
Scan` is the one candidate**: its verdict is a pure function of the scanned
commit range and the pinned gitleaks digest, it needs no secrets so it works
identically for fork pull requests, and it currently scans a pull request's
commits in about 75 milliseconds. Done when the owner promotes it, or when this
entry records why not.

### C2. A failing scheduled scan notifies nobody but the owner

`security-scan.yml`'s daily run fails when a critical fixable advisory lands, and
GitHub emails the repository owner for a failed scheduled run. That is the whole
notification path. `helm-index-check.yml` shows the alternative in this
repository - a job with `issues: write` that maintains a single rolling issue -
and it was not copied here because an auto-filed issue per advisory is how a
security label becomes noise. Done when a real missed advisory shows the email is
insufficient, at which point the rolling-issue pattern is the thing to copy.

### C3. The image SBOM is a 30-day workflow artifact, not a durable asset

It cannot be a release asset: `release-artifacts.yml` publishes the release
before dispatching `docker-build-push.yml`, and immutable releases (#154) freeze
the asset set at publish time. It is regenerable by anyone from an immutable
public digest with one Trivy command, documented in `SECURITY.md`, so nothing is
lost that cannot be recovered - what is missing is convenience and an attestation.
The clean fix is a buildx SBOM attestation (`sbom: true` on
`docker/build-push-action`), which attaches it to the image manifest where an
image SBOM belongs. It was not taken in Phase 2 because it adds a step, and a
failure mode, to the release-path Docker build - the most fragile CI surface in
this repository. Done when the release chain has been quiet for a few releases and
the change can be validated with a `workflow_dispatch` backfill first.

### C4. No SBOM covers the operator image

`operator-release.yml` builds a controller image that wraps the chart. Phase 2
deliberately touched no release workflow other than `release-artifacts.yml`, and
the operator image has a different lifecycle and a different consumer (OpenShift
OperatorHub, which does its own scanning). Done when a certification requirement
asks for one.

### C5. Dependabot has alerts but no version-update configuration

The repository has Dependabot alerts and secret scanning enabled, but there is no
`.github/dependabot.yml`, so nothing opens a pull request for a bump. The
dependency gate therefore reports advisories that a human has to act on by hand.
Adding version updates is cheap and the reason it was not done here is scope, not
disagreement - it also interacts with the 100 percent coverage gate and the
required checks in ways worth thinking about once (a bot pull request must pass
the same six gates). Done when `dependabot.yml` lands with a grouping strategy
that does not produce one pull request per transitive package.

### C6. `bun audit` cannot answer "is there a fix"

It reports severity and vulnerable ranges and no fixed version, which is why
Trivy owns the gate and `bun audit` is a job-summary second opinion. If bun adds
fixed-version data, the container dependency in the local contributor workflow
could be dropped entirely. Done when `bun audit --json` carries a fix field.

### C7. The release SBOM does not describe the bundled Node.js runtime

`packaging/linux/fetch-node.sh` and `packaging/windows/fetch-node.sh` download a
pinned Node.js build and bundle it into every packaged artefact except the npm
package itself - the standalone tarballs, the Windows zip, the `.deb` and `.rpm`
packages, the snap, the AppImage and the desktop package. That runtime is the
largest single binary in most of those artefacts, it is fetched by a shell
script rather than resolved from a lockfile, and the CycloneDX SBOM Trivy
generates from `bun.lock` never sees it - the document's only `node`-named
component is `pkg:npm/@types/node`, a type-declarations package. `SECURITY.md`
now says the SBOM covers "the dependency closure of" those artefacts rather than
the artefacts themselves, which is the honest claim; this entry is the gap
behind it. Done when the bundled runtime's version and provenance appear in the
SBOM or a sibling document - a second Trivy pass over the `fetch-node.sh`
scripts' pinned version, or a hand-maintained component entry, whichever ships
without adding a new failure mode to the release chain.

---

## Security Phase 3 deferrals

Each of these was decided during Phase 3, not overlooked. Delete an entry when the work lands.

### K1. Nothing stops a new route from bypassing the authoritative audit channel

`src/lib/audit.ts` exports both `emitAuditEvent` (ring buffer **and** the `libredb.audit.v1` stdout
line) and `getServerAuditBuffer`, and `POST /api/admin/audit` legitimately uses the second on its
own — its body is client-supplied and must never gain authority over the authoritative channel. But
nothing prevents a future route from doing the same by accident: an event pushed straight to the
buffer is visible in the admin UI, invisible to every log pipeline, and no test notices. The
existing tests all pin the CONTENT of the stdout line, not the set of call sites permitted to skip
it. Done when a check enumerates `getServerAuditBuffer(...).push(` call sites across `src/` and
fails on any that is not on a short, commented allowlist - the same inversion
`tests/security/route-auth.test.ts` applied to route discovery, where a hand-curated list had
already lost eleven routes.

### K2. A legacy plaintext password shaped exactly like an envelope is treated as corruption

`src/lib/storage/encryption.ts`'s `readSecret` treats a three-segment value whose first segment
matches `/^v\d+$/` as an envelope. A password stored before this feature existed that happens to be
literally `v1:<base64url>:<base64url>`, with a 12-byte first segment and a second of at least 16
bytes, is therefore classified `undecryptable` and omitted rather than returned. The compounded
probability is negligible, the failure is recoverable (the connection survives and the user retypes
the password once), and the alternative - passing an unrecognised value through - would hand
`v1:abc:def` to a driver as a password. Accepted rather than designed away, because the fix would
be a longer, non-colliding prefix, and the stored envelope shape is a fixed contract. Done when the
envelope format is versioned forward for an unrelated reason, at which point a longer prefix costs
nothing.

### K3. `STORAGE_ENCRYPTION_KEY` is validated at first write, not at boot

`src/lib/config/auth-preflight.ts` validates `JWT_SECRET` at startup, so a short one stops the
server rather than producing a green health check and a 503 on every login.
`STORAGE_ENCRYPTION_KEY` has no equivalent: a value shorter than 32 characters throws only when the
first storage write happens, which is after login, after the migration attempt, and only in server
storage modes. The failure surfaces as a `syncError` in the UI rather than as a boot failure. Done
when the preflight also reads `STORAGE_ENCRYPTION_KEY` - noting that it must stay silent when
`STORAGE_PROVIDER` is `local`, where the variable is inert and an error would be wrong.

### K4. Rotating the key back does not recover credentials once the app has written

`src/lib/storage/connection-secrets.ts`'s `decryptConnections` omits an unreadable secret and keeps
the record, which is correct - dropping the record would be persisted as a deletion. But the
omission is only recoverable until the next write: `useStorageSync` is a write-through cache, so the
first push of the `connections` collection after a failed read overwrites the ciphertext with a
record that has no password field at all. The warning fires on READ, which is before any write, so
an operator who reads their logs promptly has a window. Making the window unnecessary would mean
reading the stored row before every write and preserving an existing envelope when the incoming
value is absent - which would also silently resurrect a password the user deliberately cleared, a
worse bug than the one it fixes. Done when a design is found that distinguishes "the client never
had this value" from "the client cleared this value" without adding a field to the stored shape.

---

## Agent M1 deferrals (#328)

Each of these was decided while building the operation/policy layer, not overlooked. Delete an
entry when the work lands.

### A1. A SQLite agent statement can block the runtime for its whole duration

`src/lib/db/providers/sql/sqlite.ts`'s `queryReadOnly` enforces `statementTimeoutMs` as a
post-execution deadline: the result of an overrunning statement is refused, but the statement is
never preempted. SQLite has no transaction-local statement timeout, and neither `bun:sqlite` nor
`node:sqlite` exposes `sqlite3_interrupt` or a progress handler, so there is nothing to preempt it
with. Because both drivers are synchronous, a hostile recursive CTE therefore blocks the whole
runtime while it runs. This is the same property as the normal SQLite query path, but the input
source is different in kind: there the SQL comes from an authenticated operator, here it comes from
an agent. Done when either driver exposes an interrupt/progress hook, or agent SQLite execution
moves to a worker that can be killed on deadline.

### A2. `VACUUM INTO` can create an empty file at an agent-chosen path

The SQLite agent profile's read-only open governs the target database file only; `VACUUM INTO
'<path>'` writes to a *different* file and is refused by `PRAGMA query_only`, which the profile
re-asserts and verifies before every statement. SQLite creates the destination file before the
write is refused, so a zero-byte file can still appear at any path the server process can write to
(no data reaches it - asserted on both adapters by file size). Closing this needs an authorizer
callback, which `bun:sqlite` does not expose at all. Done when a control exists on both adapters,
or when agent SQLite targets are constrained to an allowlisted directory (related: the base-dir
allowlist proposed in issue #125).

### A3. Out-of-scope READS have no database-native control on either provider

Both agent profiles bound what a statement can WRITE with a database-native control. What it can
READ is bounded only by the policy layer's declared-target allowlist plus the input-stage statement
guard - and both of those read SQL, which this milestone treats as defense in depth rather than a
boundary:

- SQLite: `ATTACH` of an *existing* file succeeds on a read-only handle and its rows become
  readable. No authorizer exists on `bun:sqlite`, so there is nothing engine-side to stop it
  (docs/providers/sqlite.md section 12.3).
- PostgreSQL: the read-only role can read every table its grants allow, whatever catalog or schema
  the request declared. Per-table `SELECT` grants are the only real bound
  (docs/providers/postgres.md section 12.3).

Done when out-of-scope reads are refused by something that does not read SQL - a per-target grant
set generated for the agent role, an allowlisted directory for SQLite targets, or an authorizer both
adapters expose.

### A5. The PostgreSQL profile's regression tests model the server rather than run one

`tests/integration/db/postgres-provider.test.ts` proves the read-only profile against a stateful
hand-written engine mock. Every rule it models was verified against a live PostgreSQL 18 while the
profile was built - read-only transaction rejection by engine state, the extended-protocol refusal of
multi-command strings, `SET TRANSACTION READ WRITE` really relaxing the transaction, advisory locks
surviving rollback - and the mock encodes them faithfully enough that bypass attempts fail on real
modeled behavior (a write actually landing) rather than on protocol metadata.

What it cannot catch is a future regression on the other side of the seam: a driver change, a server
version that behaves differently, or a `pg` option that stops meaning what it meant. The assertions
would stay green because the mock, not the server, defines the semantics. The repository's
integration suites are mock-based by convention and CI runs no database service; the only real
engine in the pipeline today is the throwaway PostgreSQL container behind
`loop/scripts/functional-smoke.sh`.

Done when a container-backed test proves, against a supported PostgreSQL, that a direct write and a
multi-command escape are rejected through the profile under the resolved role. The cheapest path is
extending the functional-smoke container rather than adding a service to every CI test job.

### A6. Druid's hand-written bigint serializer predates the Node 24 floor

`src/lib/db/providers/sql/druid/http-transport.ts` splices the parameters array into the query
envelope by hand so a `bigint` literal reaches Druid unquoted. The reason recorded in `docs/providers/druid.md` was that
`JSON.rawJSON` (ES2025 JSON source text, V8 12.4 / Node 22.2) could not be depended on while
`engines.node` was `">=20.9.0"`.

That constraint is gone: issue #326 raised the floor to `">=24.0.0"`, so `JSON.rawJSON` is available
on every supported runtime. The hand-serializer is not wrong and is fully covered, so it was left
alone rather than rewritten inside a runtime-baseline change - swapping a correctness-critical
escaping path belongs in a change whose tests are about that path.

Done when the splice is replaced by `JSON.rawJSON` with the existing bigint fixtures still green,
or when this entry is deleted with a note that the hand-serializer is the preferred implementation.

### A7. TypeScript 7 compiles this project cleanly but the lint layer cannot follow yet

Probed while raising the Node baseline (#326): `tsc --noEmit` under **typescript@7.0.2** (the native
Go port) reports **zero errors** on this repository and finishes in **1.8s against 7.7s** for the
6.0.3 JavaScript compiler - a 4x wall-clock improvement on the `typecheck` gate.

It cannot be adopted yet, and the blocker is upstream of typescript-eslint rather than in it.
**TypeScript 7 ships no in-process compiler API at all.** Measured against the published packages:

```
typescript@7.0.2               -> require("typescript") exports: version, versionMajorMinor
typescript@7.1.0-dev.20260810.1 -> require("typescript") exports: version, versionMajorMinor
```

`ts.createProgram` and `ts.Extension` are `undefined`. Everything that builds a program in-process -
typescript-eslint, `eslint-config-next`, tsup's declaration build - has nothing to call. The repo's
type-aware ESLint layer guards `src/app/api` and `src/lib/db` against floating promises, so dropping
it to move the compiler is not a trade worth making.

typescript-eslint's own tracking issue is
[#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) ("Use TS 7 (tsgo /
typescript-go) for type information"), open and labelled **blocked by external API**; a maintainer
put it as "there is nothing we can do about this until TS 7 provides an API". Note that
[#12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) reads as *not planned*
in the GitHub UI - that is how a close-as-duplicate renders, not a statement of intent.

An interim option exists if the 4x typecheck gain is wanted before then: Microsoft documents running
[6.0 and 7.0 side by side](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)
- keep `typescript@6` as the peer typescript-eslint resolves, add `typescript-7` as an npm alias, and
point a second script at it. The cost is two compilers in the lockfile and a second source of truth
about what type-checks; today that divergence is zero, since 7.0.2 already reports no errors here.

Done when TypeScript exposes an API 7.x tooling can build on and typescript-eslint's peer range
follows, at which point this is a one-line dependency bump plus a re-run of the gates: the compiler
side is already proven green.

## Agent M2 deferrals (#329)

### B1. A module-private credential map would be invisible to the agent state guard

`src/lib/agent/state-guard.ts` derives its credential key names from `SECRET_FIELD_MAPS` in
`src/lib/storage/connection-secrets.ts`, so a field promoted to `secret` in one of the three
classification maps is covered without an edit. The aggregate itself is a hand-maintained array with
no type-level guarantee - each individual map fails `bun run typecheck` when a field goes
unclassified, but nothing makes a fourth MAP appear in the array.

The direction that loses coverage silently is adding a map, not removing one: the storage layer
would seal the new field while the guard happily persisted it. `tests/unit/lib/agent/state-guard.test.ts`
closes that by reflection - it walks the storage module's exports, recognises a classification map
structurally, and fails when one is not registered. Verified to fire by temporarily exporting a
fourth map.

What remains is narrower: the check sees **exported** maps only. A map kept module-private and wired
straight into `walkConnection` is invisible to it. All three existing maps are exported for
consumers, so this is a convention rather than an enforced rule.

Done when a new classification map cannot be added without the guard learning about it - most
directly by having `walkConnection` iterate a registry instead of three separately derived key
lists. That registry has to carry each map's nesting location (root, `ssl`, `sshTunnel`), so it is a
change to a security-critical encrypt/decrypt path with its own test obligations, which is why it
was not folded into the agent milestone that surfaced it.

### B2. The Anthropic provider kind is ratified and installed, but not offered

`@ai-sdk/anthropic@4.0.37` is an owner-ratified dependency and is installed, and the agent's provider
registry (`src/lib/agent/provider-registry.ts`) could serve it in a few lines. What blocks it is not
the agent at all: the registry is keyed on `LLMProviderType`, the settings surface's own union
(`src/lib/llm/types.ts`), and that union is what `LLM_PROVIDER` resolves against
(`src/lib/llm/utils/config.ts`). Adding `anthropic` there makes `LLM_PROVIDER=anthropic` a
selectable setting for the whole application, and `src/lib/llm/factory.ts` would then have to build a
chat provider for it or throw - so every surface that resolves a provider through the factory would
be broken for exactly the users who configured it.

Serving it properly therefore means a `src/lib/llm/providers/anthropic.ts` that speaks Anthropic's
Messages streaming protocol: `createSSEParser`'s `extractContent` in
`src/lib/llm/utils/streaming.ts` understands the OpenAI delta shape only, and Anthropic requires
`max_tokens` on every request while `LLMStreamOptions.maxTokens` is optional, which needs a default
nobody has chosen. That is a chat-surface feature with its own conventions, tests and release note,
not a line in the agent registry - and the ratified package cannot be used for it either, since
`src/lib/llm` is reachable from the published package while the AI SDK is deliberately not
(`tests/unit/agent-dependency-boundary.test.ts`).

Until then `@ai-sdk/anthropic` stays in `knip.json`'s `ignoreDependencies` as an installed-but-unwired
ratified package, which that test's allowed-ignore set names explicitly.

Done when the chat surface gains an Anthropic provider under its own conventions and the registry
gains the matching adapter in the same change - the `Record<LLMProviderType, AgentProviderAdapter>`
will not compile until it does.

### B3. A scope allowlist on a target dimension denies every tool that cannot declare it

`withinAllowlist` (`src/lib/db/operations/policy.ts`) refuses a call that does not DECLARE a dimension
the scope constrains, which is the right direction - an undeclared target cannot be screened, so it
fails closed. The consequence for the agent tool layer is that a scope carrying an allowlist silently
narrows the tool set to the tools that happen to declare that dimension:

- A `schema` allowlist admits only a NARROWED `inspect_schema` call — one that was given a selector,
  which is what the tool declares. The selector-less full inventory declares nothing and is denied
  (verified: `createTargetScope("c", { schemas: ["public"] })` plus `inspectSchemaTool(ctx, {})`
  answers `TARGET_OUT_OF_SCOPE`), and that is the natural first call — the one T8's run-start snapshot
  DOES make: `captureContextSnapshot` (`src/lib/agent/context-snapshot.ts`) asks for each catalog kind
  with no selector, so under a schema allowlist every run's context capture is refused and the run
  proceeds with no snapshot at all. It fails closed and the model is told to inspect the schema
  itself, but a run scoped to one schema never gets an inventory. Narrowing the capture to the scope's
  own single-entry allowlist is the obvious repair once a caller builds such a scope. Every
  `run_read_query` and `inspect_plan` call is denied outright, because a raw statement cannot declare
  which schema it will touch without parsing it.
- A `catalog` allowlist denies EVERY call in the layer: no tool declares that dimension at all.

Nothing is wired to build such a scope yet (`createTargetScope` has no production caller at this
commit), so this is a property of the layer rather than a live defect, and the tool layer records it
at the `inspect_schema` target declaration. It matters because the failure looks like a policy bug
rather than a scoping choice: the model gets `TARGET_OUT_OF_SCOPE` with advice to ask for an in-scope
target, and for a raw read there is no way to comply.

Two honest resolutions when a caller first needs scoping, and the choice is a product one: give
`run_read_query` an optional declared-schema argument and require it when the scope constrains that
dimension, or let the run service refuse to start a run whose scope constrains a dimension its tool
set cannot declare - which is louder and needs no per-tool argument.

Done when a scope with a schema or catalog allowlist produces a coherent outcome for every tool the
mode offers, with a test per dimension.

### B4. `mapDatabaseError` discards the text that distinguishes a timeout cancel from an operator cancel

`mapDatabaseError` matches `canceling statement` before its timeout branch and returns
`new QueryCancelledError("Query was cancelled", provider, query)` (`src/lib/db/errors.ts`), replacing
the engine's own wording. PostgreSQL says `canceling statement due to statement timeout` for a
`statement_timeout` and `canceling statement due to user request` for `pg_cancel_backend`, so after
this mapping **no** consumer can tell the two apart — the discriminator is gone, not merely
unexamined.

That is why the agent tool layer classifies a cancel as a repairable statement failure
(`src/lib/agent/tools.ts`): the reachable case on the agent path is the timeout this layer itself
installs via `SET LOCAL statement_timeout`, and narrowing the read is the repair that helps. The cost
is stated there — an operator cancel arriving mid-statement is also offered a repair, so a run
cancellation has to be enforced by the run loop's own persisted state between tool calls rather than by
expecting the driver's cancel to propagate.

The fix is in shared code and has editor-visible consequences, which is why it is not in #329:
reordering the timeout check ahead of the cancellation check, or preserving the original message on
`QueryCancelledError`, changes what the query panel shows when a statement is cancelled versus times
out. The reordering is the substantive one and needs the editor's cancel/timeout UX re-checked
(`src/lib/db/providers/sql/postgres.ts` sets `queryTimeout` on the pool as well, so both paths exist
today).

The same mapper has a wider imprecision worth fixing in the same pass, because the agent layer's
repairable-versus-environment split inherits it: the classification is **substring** matching on the
engine's message, so an identifier can decide the class. Verified against the live mapper:

- `no such table: pooled_items` matches `pool` and returns `PoolExhaustedError`, so a plainly
  repairable missing relation is treated as an environment fault and ends an agent run.
- `Connection terminated unexpectedly` matches nothing and falls through to the base `DatabaseError`,
  so a dead socket is offered to a model as a statement it could rewrite (bounded at three attempts).
- `relation "user_passwords" does not exist` matches `password` and returns `AuthenticationError` —
  harmless on the agent path today only because a query-phase `AuthenticationError` is repairable
  there, which is a coincidence rather than a design.

Neither direction is a boundary failure: nothing runs that policy did not allow, and the agent's
statement and repair budgets still bound the waste. What is wrong is the diagnosis, and it is wrong
before any consumer sees the error, so no consumer can correct it.

Done when a statement timeout and a user cancellation are distinguishable by type or by preserved
message, with the editor's own consumers updated and the agent layer's cancel classification
revisited against the new signal; and when classification no longer depends on a substring that a
table or column name can satisfy (driver error codes — PostgreSQL `SQLSTATE`, SQLite `errcode` — are
the signal that does not collide, and each provider already has access to its own).

### B5. The agent run ledger assumes one writer per run, and cannot enforce it

`src/lib/agent/run-store.ts` and `src/lib/agent/run-service.ts` are append-only over the durable
world's stream primitives, which offer no compare-and-append: a writer cannot say "append this only
if the stream is still at index N". Every operation is therefore read-then-append, and two
consequences follow that a single-writer run never meets and a second writer would:

- **Two concurrent opens on one caller-supplied run id write two headers.** The fold refuses a ledger
  with a second header (`MALFORMED_LEDGER`), permanently, for every later read — so the race does not
  resolve in one side's favour, it bricks the run. Nothing minted internally can collide (the id is a
  UUIDv4, so 122 random bits), so reaching this needs a caller that supplies its own id, which is
  exactly what the workflow-run-id path does.
- **Two loops driving one running run would both perform the same step.** `runStep` reads the ledger,
  sees the step neither settled nor invoked, and appends its invocation; two readers of the same state
  both pass that check. The write-ahead ordering makes a step at-most-once *per loop*, not
  *per run* — the milestone's "no tool execution performed twice" criterion is about a restart, where
  the dead process is gone by construction, and that case is genuinely covered.

Not defended in code because every available defence is worse than the constraint: a lock file is
single-instance only (which the Postgres backend exists to escape), and a lease in the ledger is a
distributed-lock design with its own expiry semantics. The honest boundary is that single ownership of
a running workflow belongs to the layer above rather than being re-implemented below it — and how
strong that guarantee is depends on which backend is configured, which is the part worth stating
plainly. On the zero-config local world it holds by construction: the queue awaits each delivery
before attempting the next, so retries are sequential. On the opt-in Postgres backend a
visibility-timeout redelivery can overlap a handler that is still alive, and that is precisely where
the second bullet above would bite.

Done when either the run ledger can append conditionally on the stream's tail index (which is what
would make both races impossible at the storage layer), or the single-ownership guarantee the runtime
provides is asserted by a test rather than assumed by prose — whichever the durable backend can
actually support.

### B6. Every agent cost ceiling is per-drive, so N resumes cost up to N times one drive's budget

The three things that bound what a run may spend — `ExecutionBudgetTracker` (`maxStatementsPerRun`,
`maxTotalRunMs`), `AgentRepairLedger` and `AgentRunDeadline` — are all constructed by the process that
drives a run and live only in its memory. `runInvestigation` (`src/lib/agent/investigation.ts`) takes
them as injected resources, so a run resumed after a process death is handed a fresh set and starts
each ceiling again. A run that dies and resumes ten times may therefore perform ten times
`maxStatementsPerRun` statements and spend ten times `AGENT_RUN_DEADLINE_MS` of wall clock, even though
each individual drive stayed honestly inside its bounds.

Nothing currently claims otherwise — `AGENT_MAX_MODEL_TURNS`'s docblock in
`src/lib/agent/execution-policy.ts` states the per-drive scope explicitly rather than implying a
per-run one, which is why this is a recorded limitation and not a defect. It matters for two later
tasks: T10b's budget meter must not present a per-drive figure as a run total, and any retry policy
that resumes automatically would multiply the ceiling without a user ever asking for it.

The data needed to fix it is already persisted: `AgentRunRecord` carries `createdAtMs`, and the ledger
holds every settled step, so a drive could fold the run's own history into the ceilings it starts with
(a deadline measured from `createdAtMs`, a statement count folded from `tool-completed` entries)
instead of starting from zero. Done when the ceilings a drive enforces are derived from the run's
ledger rather than from the drive's own construction, with a test that resumes a run twice and shows
the second drive inheriting the first's spend.

### B7. A PostgreSQL expression index is absent from the agent's schema inventory

The composed index read (`composePostgresIndexes`, `src/lib/agent/composed-sql.ts`) joins `pg_index`
to `pg_attribute` on `a.attnum = ANY(ix.indkey)` to name each indexed column. An expression index
(`CREATE INDEX … ON t (lower(name))`) stores a zero in `indkey` for its expression and keeps the
expression in `pg_index.indexprs`, so the join matches nothing and the index does not appear in the
run's context snapshot at all. A partly-expression index (`(status, lower(name))`) is worse in one
respect: it appears, carrying only its plain columns, so a reader could take it for an index on
`status` alone.

Consequences are bounded and reporting-only: nothing about enforcement depends on the inventory, and
the model can still ask for a plan (`inspect_plan`), which is what actually says whether an index is
used. The cost is a model reasoning about "there is no index on that column" when there is one. The
SQLite side does not have this gap — `parseSqliteIndexDdl` keeps an expression's written form, because
the DDL text carries it (`src/lib/agent/sqlite-ddl.ts`).

Fixing it means projecting `pg_get_indexdef(ix.indexrelid)` (or `pg_get_expr(ix.indexprs, ix.indrelid)`)
alongside the column join and parsing the emitted definition, which is a second per-dialect parser
against text whose stability this repository has not verified — deliberately not done inside the task
that found it. Done when an expression index appears in the inventory with its expression, asserted
against a live PostgreSQL rather than a fixture, since the projection is the part that cannot be
checked without an engine (see A5).

### B8. The composed foreign-key read cannot pair a composite key's columns, and its referenced side still collides on constraint names

`composePostgresRelations` (`src/lib/agent/composed-sql.ts`) joins
`information_schema.key_column_usage` (one row per REFERENCING column) to
`information_schema.constraint_column_usage` (one row per REFERENCED column) on the constraint alone.
Neither view exposes an ordinal that pairs the two sides, so a foreign key over two or more columns
comes back as the cross-product of its sides: `FOREIGN KEY (x, y) REFERENCES parents (a, b)` yields
four rows, and `buildPostgresTables` turns them into four edges, of which two are wrong
(`x -> parents.b`, `y -> parents.a`). Single-column keys — the overwhelming majority — are exact.

The consequence is confined to what a run is TOLD: the packed context can show a relation that does
not exist, so a model could join on the wrong column and get a statement that is refused or returns
nothing. Nothing about enforcement depends on it. The SQLite side does not have this gap: the DDL
text pairs the two lists positionally and `sqlite-ddl.ts` reads them that way, which is the
declaration's own meaning.

A second, independent defect lives in the same joins and needs the same fix. A PostgreSQL constraint
name is unique per TABLE, so two tables in one schema may both carry `fk_customer`. The referencing
side is narrowed by `tc.table_name = kcu.table_name`, but `constraint_column_usage` exposes no
referencing-table column at all, so the referenced side cannot be narrowed the same way: table `a`
still gains an edge pointing at table `b`'s parent. Same consequence as above — a relation in the
prompt that does not exist — and the same blast radius, since nothing about enforcement reads the
inventory.

A correct projection means leaving `information_schema` for `pg_constraint`, unnesting `conkey` and
`confkey` `WITH ORDINALITY` and joining on the ordinal — which closes both defects at once, because
`pg_constraint` rows carry `conrelid` and are identified by oid rather than by name. It is a statement
that has to be verified against a live server before it can be trusted, which this milestone cannot do
(see A5). Done when a composite foreign key appears in the inventory with each column paired to the one
it actually references, and two same-named constraints in one schema produce only their own edges,
both asserted against a live PostgreSQL.

### B9. Nothing enqueues an agent drive, so an interrupted run is resumable but never resumed

Opened by #329 T9. `POST /api/agent/drive` exists, authenticates a server-minted single-purpose
credential and resumes the run it names, and `src/lib/agent/runtime.ts` re-derives everything that
run needs from its own ledger — so a resume WORKS. What does not exist is anything that asks for
one. A run is driven exactly once, in the process that opened it (`src/app/api/agent/runs/route.ts`),
and if that process dies mid-run the run stays `running` in the ledger with nobody to pick it up:
`mintAgentDriveToken` has no production caller, and the workflow runtime is used only as the
ledger's durable substrate — there is no `"use workflow"` function and no queue producer, so the
backend's own re-enqueue-on-start never sees an agent run.

Distinct from a drive that *fails*, which is now recorded: a throw anywhere in `driveAgentRun` ends
the run as `failed` with a classified reason (`docs/AGENT.md`, "A drive that dies before the loop"),
so an unconfigured model no longer leaves a run at `queued` forever. This entry is the case where the
process is GONE — nothing threw, nothing can record, and the run stays `running` until something asks
for it. Recording a failure cannot close that; only a producer can.

Adopting the SDK's Next.js integration is what would supply the producer, and it was refused
deliberately rather than overlooked. Its documented setup asks for `/.well-known/workflow/*` to be
excluded from the proxy matcher (`node_modules/workflow/docs/getting-started/next.mdx`), and it warns
that a proxy running on that path detaches the request body — so the callback could not merely
authenticate its way through the middleware either. Worse than the requested edit: **this matcher
already excludes it**, because the dot rule (`.*\..*`) skips every path containing a dot and
`.well-known` contains one (A2 above records the same consequence). So that route would sit outside
`src/proxy.ts` entirely, unauthenticated, the moment it existed — with no matcher edit to review. The
pinned decision for exactly this case (P4) says driving in-process without a loopback hop is strictly
better, which is what the start route does; the drive path this task added is one the matcher DOES
route, guarded by a credential rather than by a path rule, and `tests/api/proxy.test.ts` pins both
halves of that.

Two things have to land together whenever a producer arrives, and neither is safe to add alone:

- **A sweep that finds runs left `running`** and drives each one — at boot, or on a timer — with the
  same credential the callback already verifies.
- **Single-flight per run.** Today no two drives of one run can overlap, because there is only ever
  one. A producer removes that accident, and the ledger is explicitly read-then-append with no
  fencing (B5), so two drives would both read "not invoked" for the same step and both perform it —
  the duplicate execution the milestone's durability criterion forbids.

Done when a run whose process died is picked up without a person asking, no step is performed twice
while that happens, and B6's per-drive cost ceilings are accounted for across the resumes it causes.

### B10. No token budget is enforced, so the rail's budget meter reports none

Opened by #329 T10b. The task's bar names tokens among the figures the meter should report, and the
meter deliberately does not show one: nothing in this repository bounds an agent run's token spend.
`AGENT_EXECUTION_POLICY`'s budgets are statement-shaped (`src/lib/agent/execution-policy.ts`),
`AGENT_MAX_MODEL_TURNS` bounds model TURNS rather than their size, and the run loop never reads the
SDK's `usage` at all (`src/lib/agent/investigation.ts` consumes `fullStream` parts and the assistant
messages, nothing else). A token figure would therefore be a number the server does not enforce,
shown next to four that it does — which is the one thing that bar forbids, so the meter states the
turn ceiling instead and says nothing about tokens.

Closing it is two changes that have to land together: reading `usage` off each turn and recording it
in the run's ledger (a new field on `run-finished`, or a new event kind — T2's union is closed, so
this is a deliberate widening rather than an addition anyone can make in passing), and a ceiling in
`execution-policy.ts` that the loop actually refuses on. Done when a run that exceeds a configured
token budget ends with a reason a user can read, and the meter shows the same number the loop
enforced.

### B11. The rail can stop a run but cannot pause or resume one

Opened by #329 T10b. `AgentRunService` has no pause: a run holds a provider and a budget while it is
running, and nothing in this milestone can put those down and pick them up again. Resuming exists
(`POST /api/agent/drive`, `driveAgentRun`) but is authenticated by a server-minted single-purpose
credential a browser never holds — it is the seam a machine producer will use (B9), not a user
control. The rail therefore offers stop and nothing else, and it does not render a disabled pause or
resume, because a disabled control reads as a capability that is merely unavailable right now.

Resume becomes offerable the moment B9's producer exists — a user-visible "pick this run up" is then
just asking for a delivery. Pause is the larger one: it needs a run state between running and
terminal that releases the run's resources without ending it, and a resumed run would have to
re-acquire them, which is exactly the path B6 already complicates. Done when either control exists in
the service with its own ledger record, and the rail renders it because the service can honour it.

### B12. A statement that failed at the database records no duration, so the meter's database time counts completed reads only

Opened by #329 T10b. `ExecutionBudgetTracker` charges `maxTotalRunMs` from every execution's elapsed
time, on the failure path as well as the success one (`execution.ts` calls `endExecution` with
`statements: 1` in both). The durable ledger is narrower: `tool-completed` carries the artifact's
`summary.elapsedMs`, while `tool-refused` carries an `AgentToolRefusal`, whose database-error variant
records a fingerprint and the engine's message and no duration at all (`src/lib/agent/types.ts`). The
rail folds its meter from the ledger, so its database-time figure is the sum over completed reads and
sits BELOW what the tracker enforced whenever a statement failed.

The rail says so beside the meter rather than quietly rounding — under-reporting the time a bound has
already spent is the direction that misleads. Fixing it means recording the elapsed time of a failed
execution somewhere durable; the natural place is the refusal itself, which is a T2 contract change
and therefore deliberate rather than incidental. Done when a run whose statement failed shows the same
database time the tracker charged it, with a test that fails on the current under-count.

### B13. Three spends the agent run ledger never records, so the budget meter reads low

Opened by #329 T10b, found by the task's own fresh-context review rather than by writing the meter.

The largest is the schema capture. `captureContextSnapshot` (`src/lib/agent/context-snapshot.ts`)
calls `inspectSchemaTool` directly, once per catalog kind — three reads on PostgreSQL, two on SQLite
(`CATALOG_PLANS`) — and each one goes through `executeAuditedOperation` and is charged `statements: 1`
plus its elapsed time against exactly the budget the meter displays. What it does NOT go through is
the run loop's `runStep`, which is the only writer of `tool-completed`; the capture records one summary
`context-captured` entry instead. On an agent-mode drive with no reusable snapshot in its ledger — the
case `establishContext` actually reads a catalog in, since a planning run captures nothing and a
resumed run reuses what it recorded — a ledger-folded meter therefore reads "0 / 20 statements" at the
moment two or three are already spent, before the model's first turn, and a capture that FAILS records
no entry at all while still having paid for its reads.

Two smaller mismatches belong with it. An acquisition failure is accounted as one executed statement
although nothing ran — `tools.ts` acquires the provider inside the allowed callback deliberately, so
that a denied call never opens a pool — and it propagates out of the tool, leaving the step with a
`tool-invoked` entry and no settlement, so the fold cannot see it. And a `tool-completed` entry carries
the provider's own `summary.elapsedMs`, while `maxTotalRunMs` is charged the span the execution layer
measured around the whole call (`execution.ts`), which also covers that acquisition. All three gaps run
in the same direction — the meter under-reports — which is why the rail states its figures as a floor
rather than as the spend, and why the caveat it shows is a list of what is known rather than a proof
that the list is complete.

Either half closes the same way: give the capture path a durable per-read record, or read the meter
from the tracker's own accounting instead of from the ledger. The second is not a drop-in — the
tracker is process-local and `releaseExecutionRun` drops a run's accounting when it ends, so a
finished run would report zero — which is why the ledger fold was chosen and its gap recorded rather
than papered over. Done when a run that has captured its schema shows the catalog reads it paid for,
with a test that fails on the current under-count.

### B14. An agent artifact hydrates the grid and the explain view, but not the chart or export surfaces

Deferred by #329 T11, which is the task's own recorded narrowing rather than something discovered
afterwards. A hydrated artifact reaches the two surfaces its operations produce — the results grid for
`sql.query.read`, the explain view for `sql.explain.estimate` — and the charts, pivot and dashboard
views keep rendering the tab's own result while one is shown. Charting a run's rows is a real want and
a bigger change than it looks: `DataCharts` and `PivotTable` are configured against the columns of the
result they were opened on, so hydrating them means deciding what happens to a chart configuration
when the underlying result is replaced and then taken away again.

Export is absent for a different reason, and it is a gap rather than a decision that closes anything:
`exportResults` in `src/components/Studio.tsx` serializes `currentTab.result`, so offering the Export
menu over a hydrated view would export the tab's rows while the user is looking at the run's. The
menu is therefore hidden while an artifact is shown. Done when either surface can take an explicitly
hydrated result — with the provenance badge still naming the run, since an exported file that came
from an agent run and is indistinguishable from one the user ran is the thing to avoid.

### B15. A run's stored results are gone once the run ends, so a report's citations can outlive its rows

Surfaced by #329 T11 rather than introduced by it: `ExecutionArtifactStore` holds results in process
memory and `releaseExecutionRun` drops everything a run produced at `finish` or `cancel`
(`src/lib/agent/run-service.ts`), which is the M1 decision that agent results never rest on disk.
The consequence the artifact route makes visible is that the report — composed as the run's last step
— is usually read AFTER the run has ended, so "Show result" on its citations answers `410` with
`reason: "released"` rather than rows, and the same is true for any run driven by a different replica.

The route says which of the two happened instead of reporting a missing artifact, and the rail offers
"Show result" only while the run is live — the milestone's own rule that a control the service cannot
honour is not rendered — with the report section stating the bound in words, so a user who saw the
control during the run knows why it is gone afterwards. The consequence to know: the show affordance
on report CITATIONS is mostly dormant, because a report is composed as the run's last step; what is
reachable in practice is showing a result from a live run's timeline. Closing it properly means deciding
where agent results may rest — encryption, retention and tenancy are exactly the questions #328
declined to answer — so it is a product decision, not an implementation gap. Done when a finished
run's cited rows are readable for a stated retention window, or when the surface states the window it
has instead of offering a control that usually cannot be honoured.

### B16. The opt-in multi-replica backend cannot load in the container image or the npx payload

Found while landing #329 T1 and carried forward deliberately, because the milestone's own commit that
found it could not validate a fix (nothing built a world yet).

`@workflow/core/dist/runtime/world.js` resolves any world other than its two built-ins with
`require(targetWorld)` off a `createRequire` rooted at `process.cwd()`. The specifier is a variable,
so Next's output-file-tracing cannot see it: `@workflow/world-postgres` is **absent from
`.next/standalone`**, and therefore from the container image and the standalone tarball the npx
launcher downloads. `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` passes this repository's own
allowlist (`src/lib/agent/config.ts`) and then fails inside the runtime at the moment a world is
built — so the documented path to running agents on more than one replica does not work in the
artifacts most operators deploy. A `bun dev` checkout and a plain `node_modules` install are
unaffected, which is exactly why it can go unnoticed.

Scoped by measurement rather than by inference, so the entry is not read as more than it is: a
`DOCKER_BUILD=true bun run build` on 2026-08-12 leaves `.next/standalone/node_modules/@workflow`
holding `world-local` and `utils`, and the rest of the runtime (`workflow`, `@workflow/core`, `ai`,
`@ai-sdk/*`) compiled INTO the server chunks — which is why the default `local` backend does work in
the image. Only the world reached through a variable specifier is missing.

The repository already has the remedy pattern for this shape of dynamic specifier: the explicit
copies in `Dockerfile` and `scripts/build-standalone-payload.sh`, both of which already hand-copy
modules that tracing cannot see. Done when the Postgres world is present in both payloads with a test
asserting it (`tests/unit/packaging-payload-prune.test.ts` pins what the payload must keep and is the
nearest existing home for such an assertion), and when `docs/AGENT.md`'s deployment section loses the
caveat that points here.

### B17. Monitoring tools are deferred; profiling landed with #330 T3

**Half of this entry is done and the other half is unchanged.** #330 T3 instructed that profiling
reach the database "as new descriptors in `descriptors.ts` at R0/R1", which reopened the
three-descriptor product decision this entry rested on: `sql.table.profile` is registered, and
`profile_table` is offered to the `database-assessment` workflow. What follows is the original
reasoning, kept because the monitoring half still stands on it.



Recorded as #329's own narrowing (planning decision P1), not as something discovered later. The
canonical operation set is exactly three descriptors (`src/lib/db/operations/descriptors.ts`), and the
parent epic pinned that number as a product decision, so a tool has to fit one of them or it does not
exist. The M2 tool set is therefore schema inspection, a bounded read, an estimating plan inspection
and report composition.

The two that were left out sit on opposite sides of that line. **Table profiling** (row counts, null
ratios, cardinality, value distributions) fits: it is a bounded read whose SQL the server composes
per dialect, exactly like the catalog read. What it multiplies is scope — each statistic is a
dialect-specific composition with its own cost, and a profile that silently scans a large table is
its own hazard. **Monitoring** does not fit at all: it reaches `getMetrics`, slow-query listings and
session listings, which are provider methods no descriptor covers, so wiring it would be a database
reach outside `src/lib/db/operations/` — a defect by this milestone's constraint rather than a
shortcut.

Done, for profiling, when the composed statements exist per dialect with their own cost bound and the
tool is added to the read-class set. Done, for monitoring, only after a decision about whether the
operation set grows a fourth descriptor for non-SQL metadata reads — which drags the verification
marker, the provider triad and the security matrix with it, and is a human product call.

### B20. A Gemini deployment behind a proxy is not configurable, on either surface

`resolveApiUrl` (`src/lib/llm/utils/config.ts`) returns `LLM_API_URL` for every provider kind, so the
resolved configuration carries it — and both Gemini consumers ignore it. The chat provider constructs
`new GoogleGenerativeAI(apiKey)` (`src/lib/llm/providers/gemini.ts`), which has no base-URL option at
all, and the agent's adapter deliberately passes no `baseURL` (`src/lib/agent/provider-registry.ts`)
because leaving it undefined is what keeps the SDK's own environment fallback unreachable. So an
operator who must reach Gemini through an egress proxy or a regional endpoint can set the variable,
see no error, and be routed to Google directly.

This is pre-existing behaviour that the agent inherited rather than introduced, and it is recorded
here because #329 T4 is where it was noticed. Fixing it means threading `config.apiUrl` into both
consumers and deciding what an explicitly-set `LLM_API_URL` means for a provider whose SDK has no
base-URL seam — a settings-surface change with the chat surface's own conventions and tests, not an
agent change. Done when a proxied Gemini endpoint is reachable from the configuration the user already
entered, or when the settings surface says plainly that the variable does not apply to that kind.

### B21. The published package carries the agent-provenance branch as dormant markup

`BottomPanel` is shared by both shells, and #329 T11 added its agent-provenance branch — an optional
`agentArtifact` prop, the provenance badge and its test ids. `bun run build:lib` therefore emits that
markup inside `dist/workspace.mjs`.

It is inert, and the package boundary that matters is intact: the prop is optional, the embedded shell
never passes it, no entry point exports `BottomPanel` (asserted through a transitive `export … from`
closure in `tests/unit/agent-package-boundary.test.ts`), and the package gains no agent module, no
agent type and none of the runtime packages — which is what the boundary tests pin. What remains is
dead bytes in a consumer's bundle and a small honesty cost: a reader grepping the published output
finds strings suggesting an agent capability that the embedded shell cannot reach.

Done when the provenance branch lives in a standalone-only component and `BottomPanel` takes it as
children, or when Phase 4's surface unification decides the embedded shell gets an agent surface after
all — at which point this stops being dormant rather than being removed.

### B23. Seed eligibility is decided against a browser snapshot, not the live descriptor

`resolveAgentRunConnectionId` (`src/hooks/use-connection-payload.ts`) decides whether an editable
seed copy may start a run by comparing it against the descriptors in `useConnectionManager`'s
`servedSeeds` — the response of the last `GET /api/connections/managed`, fetched at mount and during
the pending-seed poll. The run-start route then resolves `seed:<id>` again, through
`getSeedConnectionById`, whose config loader re-reads the seed file after its own TTL
(`SEED_CACHE_TTL_MS`, 60s by default).

So there is a window. An operator who repoints a seed at a different database while a session is open
leaves that session comparing against the OLD descriptor: the local copy still matches it, the rail
still offers Start, and the run resolves the NEW target. That is the same silent wrong-database
outcome the comparison exists to prevent, reached from the server side instead of the browser side.

Two things bound it. It needs a server-side seed change mid-session, not a user action; and the same
staleness already applies to an admin-managed connection, which has always sent `seed:<id>` for every
query while the sidebar showed whatever the last fetch returned. This is therefore a property of
resolving by id at all, not something the editable-copy path introduced — but the copy path is the
one whose documentation promises a match, so it is the one that overstates.

Done when the run-start route validates the descriptor the browser believed it was starting against —
a fingerprint sent with the request and compared server-side, refusing with a distinct reason when it
has moved — rather than the client's snapshot being the only check. Until then `docs/AGENT.md` says
the comparison is against the last fetch, not against the live descriptor.

### B24. RESOLVED 2026-08-13 — the verdict is a field beside the status, not a fourth status word

`AgentRunTerminalStatus` is unchanged: `succeeded | failed | cancelled`. What was added is
`goalVerdict` on the `run-finished` event — additive and optional, exactly as `reason` and
`stopReason` were before it.

The deciding evidence was two live runs on 2026-08-13. One ended `succeeded` because the model
stopped talking; one ended `failed` because it hit the turn ceiling; **both answered nothing**. A
third shape exists and matters: a drive that dies before the loop ends `failed` with no verdict
meaningful at all, because the run never got to try. Status and verdict are therefore independent
axes, and one word cannot carry both.

`needs_input` was rejected as the term. It names a capability this runtime does not have: a terminal
run accepts no further ledger entries, nothing enqueues a drive (B9), and there is no
resume-with-input path — so the word would promise a continuation nobody can offer. The rail says
"Run answered" or "Run did not answer", and names the shortfall.

Adding a fourth status would also have split `succeeded` by ledger generation, with nothing in an
older record to say which meaning applied. The optional field has the opposite property: its absence
means precisely what is true of it — no verifier ran — which
`tests/unit/lib/agent/ledger-compatibility.test.ts` asserts against a real pre-change ledger.

The original reasoning, kept because it is what the decision was measured against: the concern was
that changing ledger semantics twice is the expensive kind of change, that `failed` would be wrong
for planning mode, and that the rule was not knowable until goal verifiers existed per template. All
three held, and all three are why the answer is a field rather than a word.

### B25. SQLite hides constraint-created indexes, so `fk_unindexed` can fire on a covered key

`composeSqliteIndexes` reads the index inventory from `CREATE INDEX` text (`sql IS NOT NULL`), and
the indexes SQLite creates for a `UNIQUE` or `PRIMARY KEY` constraint carry no DDL at all. They are
therefore absent from the captured inventory, and a foreign-key column covered by a `UNIQUE`
constraint looks uncovered to `findUnindexedForeignKeys` (`src/lib/agent/table-profile.ts`).

The finding is worded to survive this — "no index **in the captured inventory** leads on this
foreign-key column", not "this foreign key is unindexed" — and the primary key is read from the
column inventory rather than the index one, so a PK-covered key is already correct. What remains
wrong is the `UNIQUE` case, which reports a covering index that exists.

Done when the SQLite capture surfaces constraint-created indexes — the information is in the table's
own stored DDL, which `parseSqliteTableDdl` already reads for columns and foreign keys and could read
for `UNIQUE` clauses too — or when the finding is suppressed on SQLite for columns a `UNIQUE`
constraint covers. Related: B7 (PostgreSQL expression indexes are absent) and B8 (a composite foreign
key comes back as the cross product of its sides, which is why composite keys are skipped entirely).

### B26. A profile can test for an email shape and not for a digit run

`table-profile.ts` tests one value shape inside the database, `LIKE '%_@_%._%'`, and derives
`suspected_pii` from the ratio of matches. A run of digits — a phone number, a national id, a card
number — is the other shape worth suspecting, and `LIKE` cannot express it: `_` means "any
character", so a length test would match almost any text. PostgreSQL spells it `~ '[0-9]{9}'` and
SQLite spells it `GLOB '*[0-9][0-9][0-9]…*'`.

An earlier draft of this module shipped `LIKE '%_________%'` as a "nine digits" test, which would
have produced a `suspected_pii` finding for essentially every text column. It was removed before it
landed rather than approximated.

Done when the shape tests are per-dialect predicates rather than one shared `LIKE`, with the digit
run among them and each verified against that engine's own grammar.

### B27. A database assessment reports no monitor snapshot

#330 T3 lists a monitor snapshot among the assessment template's outputs. It is not built, for the
reason B17 gives: engine health reaches `getMetrics`, slow-query listings and session listings, which
are provider methods no operation descriptor covers. A profiling descriptor could be added because a
profile is a composed SQL statement; a metrics read is not, so it needs a descriptor shape for
non-SQL reads — with its own verification marker, its own provider triad and its own security-matrix
row — which is a product decision rather than a subtask.

Done when that shape exists and the assessment template reports engine health beside its table
profiles.

### B28. A profile that times out reports nothing rather than falling back to catalog statistics

#330 T3 asks for "a timeout fallback to catalog stats". A profile that exceeds
`statementTimeoutMs` currently surfaces as a repairable database error, so the model may narrow the
profile or move on — but nothing reads `pg_stats` / `sqlite_stat1` for the approximate answer the
engine already holds.

The gap is honest rather than silent (the run is told the statement failed), and the fallback is a
second composition path per dialect whose numbers are estimates the planner maintains, so a profile
built from it would have to say which of its figures were measured and which were the engine's own
estimate. Done when that distinction is carried in `AgentTableProfile` and the fallback is composed
per dialect.

### B29. An attacker-supplied identifier the model quotes back reaches a transcript unfenced

Found by the injection fixtures in `tests/evals/injection.test.ts` (#330 T4), which is what those
fixtures are for.

Every block the SERVER writes is fenced and its markers neutralised, and the suite asserts that
property directly by counting: a transcript holds exactly as many closing markers as the server
opened. The path this does not cover is the model's own message. An attacker who can name a table can
put the closing marker in that name; the model reads it correctly fenced, and then copies the
identifier into its own tool ARGUMENTS — which are the model's words, not the server's. The
transcript sent back on the next turn therefore carries an unfenced marker.

**This is an open injection path, not a bounded residual**, and the first version of this entry said
otherwise — the correction is worth recording because the mistake was instructive. It claimed "the
text following the marker is the model's own JSON, not attacker content". That is false: an attacker
who can name a table controls the WHOLE identifier, so they control the marker and arbitrary text
after it, and JSON quoting around the string does not make that suffix the model's.

What is true is a narrower and different claim, and it is what makes this hard to reach today rather
than harmless: **the server never hands the model the raw marker.** Every server-authored path
neutralises it first, so a model reading a hostile inventory sees the defanged spelling. For the raw
marker to appear in an assistant message the model has to reconstruct it. The fixtures assert both
halves — that the fenced inventory contains no raw marker, and that the transport does not prevent
one if the model produces it anyway (the scripted model supplies it directly, which is stronger than
what the fenced paths currently give a real one).

The server's own blocks do stay balanced, which bounds what can be re-attributed to the SERVER — and
nothing more than that.

Fixing it means rewriting the messages the provider itself returned (`response.messages`), which is
the transcript that provider will accept back — the same reason `investigation.ts` filters those
messages to the assistant turn rather than rebuilding them. Done when a tool call's arguments are
neutralised on the way into the transcript without desynchronising the `tool_call_id` pairing the
endpoint validates.

### B30. A green ledger probe does not promise the world will build: `version.txt` is checked later

Found while reviewing #331 T5, by reading what the probe actually mirrors.

`GET /api/agent/config` decides the rail's visibility partly on a writable-path probe, and that probe
runs `@workflow/world-local`'s `ensureDataDir` steps: create the directory, check it is readable,
write a probe file, remove it. The world does not call `ensureDataDir`. It calls `initDataDir`, which
calls `ensureDataDir` **and then** reads `version.txt` from an existing ledger and parses it — first
`parseVersionFile`, which throws on content with no `@`, then `parseVersion`, which throws on anything
that is not `major.minor.patch`. Neither is reached by the probe.

So an existing ledger directory whose `version.txt` is truncated, present-but-empty, or written by an
incompatible release answers **green** — the directory is writable, which is all the probe asked. The
rail renders, the operator clicks Start, and the run fails when the world is built. That is precisely
the failure T5 exists to prevent, surviving in a narrower case.

T5 narrowed the promise rather than widening the probe: the docblock on `runLedgerProbe` and the HTTP
surface section of [`AGENT.md`](AGENT.md) now say that green means `ensureDataDir` will pass, not that
`initDataDir` will. Widening was rejected here on two grounds. Parsing another package's on-disk
format in our own probe duplicates a contract that is upstream's to change. And the honest alternative
— calling upstream's `initDataDir` — writes `version.txt` as a side effect, which turns a read-only
visibility probe into something that initialises the ledger on every page load of a logged-in user.

Done when the probe can answer for the version file without writing one: either upstream exposes a
check that does not initialise (worth an issue there), or the probe reads an EXISTING `version.txt`
itself and reports a `LEDGER_INCOMPATIBLE` reason distinct from `LEDGER_UNAVAILABLE`, leaving the
absent-file case to the world.

### B31. The Postgres durable backend is reported available without being contacted

Raised in review of #331 T5.

`resolveAgentAvailability` derives the agent's visibility from two conditions, and the second one —
the durable ledger has a usable home — is only ever *tested* for the `local` backend, where testing it
is a `mkdir` and a file write. With `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` the ledger is a
database, and the check ends at "the variable names a sanctioned backend". `WORKFLOW_POSTGRES_URL` is
neither read nor reached, and unset it does not even refuse: the world falls back to a development
default (`postgres://world:world@localhost:5432/world`).

So a multi-replica deployment pointed at an unreachable, misspelled or unset Postgres URL gets a rail
that renders, a Start that is offered, and a failure at the moment a world is built — the exact
outcome deriving availability exists to prevent, surviving in the one backend an operator opts into
deliberately.

It is a **documented carve-out rather than a silent one**. `AgentAvailability`'s green branch carries
`ledgerVerified`, `GET /api/agent/config` returns it, and this backend answers `false` — so no reader
of the code, the API or [`AGENT.md`](AGENT.md) is told a database was reached when only a variable was
read. What is *not* claimed is that the rail is therefore correct: it still appears.

Not fixed here because the fix is a different piece of work with its own cost: the only real readiness
check is a connection attempt, and this route answers on every page load of a logged-in user, from
outside the `ai` rate-limit bucket. Done when the Postgres backend's readiness is established by a
bounded, cached connection attempt under its own reason code — `LEDGER_UNREACHABLE`, distinct from
`LEDGER_UNAVAILABLE`, which names a directory — with a timeout short enough for a page load and a memo
long enough that a page-load probe cannot become a connection per request. B16 gates any of this being
testable in a shipped artifact: the Postgres world is not in the container image or the npx payload.

### B32. The route-documentation guard covers the agent family and nothing else

`docs/API_DOCS.md` now documents `/api/agent/*` request-by-request, and
`tests/unit/agent-documentation.test.ts` derives the six agent paths from `src/app/api/agent/**` and
fails if one of them is missing from that file — which is what closed the gap the agent family had
(#331 T6). The guard is deliberately scoped to that one family, so **every other route family is
still documented by hand with nothing comparing it against the route tree.** A new `/api/db/*` or
`/api/storage/*` route can ship undocumented exactly as `/api/agent/*` did, and no gate notices.

The narrow scope was a choice rather than an oversight: widening the derivation to `src/app/api/**`
turns up routes the reference documents in prose rather than under a literal path heading (the
schema family reaches two paths through one shared handler, and several `/api/db/*` routes are
described in a single table row), so the assertion would fail on documentation that is not actually
missing. Making it total means first deciding what "documented" means for a route the reference
covers collectively — a documentation-shape decision, not a test.

Done when the guard derives every family from `src/app/api/**` under one stated rule for what counts
as documented, and the reference is reshaped where that rule does not currently hold. It is also
worth noting what the guard does NOT check even for the agent: that a documented request or response
shape still matches the handler. Only presence is asserted.
