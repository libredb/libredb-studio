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

`src/hooks/use-query-execution.ts:277` and `src/components/NL2SQLPanel.tsx:126` already read
`.error` from any non-ok body, so a rate-limited request shows its message today. What they do not
do is read the `Retry-After` header and tell the user how long to wait. Done when the toast names
the wait.

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

### A4. No wall-clock deadline bounds an agent run

`maxTotalRunMs` bounds the DATABASE time a run consumes: the execution layer reports each completed
call's elapsed time and the tracker sums them. Nothing bounds the run's wall clock. Time between
calls is not counted, so a run that spends minutes in model latency or waiting on a caller stays
inside its budget indefinitely; parallel calls each contribute their own duration, so the sum can
exceed real elapsed time; and a call admitted just under the limit can still overrun it by up to one
statement timeout.

This is deliberate at this layer. `ExecutionBudgetTracker` has no clock so that budget accounting
stays deterministic under test, and database time is the bound that actually protects the database.
The missing control is a run-level one: a runaway agent is bounded by how long it may run, not by
how much database time it used.

Done when the run loop owns a monotonic deadline per run, refuses to admit a call that cannot finish
inside the remaining time, and clamps each effective statement timeout to what is left. That belongs
with the WorkflowAgent run loop in M2 (#329), which is the first component that owns a run's
lifetime.

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
