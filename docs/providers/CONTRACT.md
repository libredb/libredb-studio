# Provider contract

This is the contract a LibreDB Studio provider package builds on and Studio reads it by.
A provider package is code that serves one or more engines, loaded into Studio's own process, and the contract is everything the two sides may rely on from each other.
The contract is versioned on its own, apart from Studio's releases, and this document states the version in force.

The SDK package `@libredb/provider-sdk`, under [`packages/provider-sdk`](../../packages/provider-sdk), carries the contract's machine-readable parts:

- [`manifest.schema.json`](../../packages/provider-sdk/src/manifest/manifest.schema.json), the manifest schema, JSON Schema 2020-12, published as `@libredb/provider-sdk/manifest.schema.json`.
- [`manifest-types.generated.ts`](../../packages/provider-sdk/src/manifest/manifest-types.generated.ts), the manifest's TypeScript types, generated from the schema.
- `compileManifestValidator`, `refusalSentence` and the refusal types, exported from `@libredb/provider-sdk/manifest`.
- [`codec.ts`](../../packages/provider-sdk/src/values/codec.ts), the value codec, exported from `@libredb/provider-sdk/values`.
- [`errors/index.ts`](../../packages/provider-sdk/src/errors/index.ts), the error record's shape and vocabularies, the kinds a provider may raise and the driver error row contract, exported from `@libredb/provider-sdk/errors`.
- [`calls/index.ts`](../../packages/provider-sdk/src/calls/index.ts), the call and context types, `defineProvider`, `checkProviderModule` and `envReader`, the host's checks of a call, `checkExecuteRequest`, `checkConsoleFacet`, `checkRefinement` and `sessionCalls`, `freezeContext` and `freezeData`, the byte budgets `BATCH_MAX_BYTES` and `PAGE_MAX_BYTES` with `encodedRowBytes`, `rowsSource` and `pumpPage`, and a call's deadline, `deadlineSignal`, `checkCallStart` and `awaitWithin`, and the host's default connect budget, `DEFAULT_CONNECT_BUDGET_MS`, exported from `@libredb/provider-sdk/calls`.
- `SqlGrammar` and its member types, the compatibility default `DEFAULT_SQL_GRAMMAR`, and `hashRunIsAmbiguous`, exported from `@libredb/provider-sdk/sql`.
- [`testing/index.ts`](../../packages/provider-sdk/src/testing/index.ts), `serve`, `readFrame`, `roundTripRefusals` and the frame refusals, exported from `@libredb/provider-sdk/testing` only.

The package root exports every entry's surface but the testing entry's, which only tests import (C-18).
The schema, the generated types and the constants the SDK exports are the source for every vocabulary named here, and this document lists none of them by hand.

## How to read this document

Every clause has a stable id and says whether it is normative or informative.
A normative clause states a rule, and what enforces it is listed under its id in `tests/unit/provider-contract-enforcers.ts`: a test, by its file and exact title, or a location in the manifest schema, by a JSON Pointer into the schema file.
An informative clause states a limit or an intention that nothing checks yet, and says so.
A clause states its rule in at most three sentences, one per line, beside a list or a table only where the rule is an enumeration; the rationale and Studio's own mechanics live in the code and tests that hold it.
A clause is normative only when its enforcer exists, so this document never promises what nothing checks.
`tests/unit/provider-contract-clauses.test.ts` fails on a normative clause with no enforcer, on an enforcer that names a missing file, a missing title or a pointer that resolves to nothing, on an enforcer id that is not a clause of this document, on an enforcer listed in this document rather than in the map, on a clause of more than three sentences, and on a clause id used twice.
An id this document no longer holds was a rule of Studio's own mechanics, which a provider package can neither follow nor rely on, and is never reused: `REMOVED_CLAUSES` in the same module names the file that states that rule now.

## Contract version

The contract version is `MAJOR.MINOR`, and this document states contract `0.1`.
A manifest names the contract it was built against in its `contract` key.
While the major is 0, a host admits a manifest built against exactly its own minor.
From major 1, a host admits a manifest built against its own major and a minor no higher than its own.
So the range a manifest declares is never open-ended: a manifest built against a later contract than the host's is refused, never read as the host's.

## Manifest

A provider package carries one manifest, a JSON document the schema states, describing what the package serves and how the host loads it.
The package's name, version, licence, Node range and entry metadata live in its own `package.json` and are never repeated in the manifest.

### M-1 (normative): One schema file, loaded by its digest

The manifest schema is one file, and `MANIFEST_SCHEMA_SHA256` in the generated types is the SHA-256 of its bytes.
`compileManifestValidator` throws `ManifestSchemaDigestError`, naming both digests, for any other bytes, so every validator uses exactly the schema the SDK was built with.

### M-2 (normative): The types are generated from the schema

The manifest's TypeScript types are generated from the schema and never written by hand.
The generator refuses any schema keyword it does not read, so a type is never wider than the schema it comes from.

### M-3 (normative): The schema is closed

Every object the schema defines refuses a key it does not name.
The two exceptions are `vendor`, which holds the package's own keys, and the envelope, which a host reads before it knows which schema applies.

### M-4 (normative): The envelope is read first

A host reads a manifest's envelope, `{ contract }`, before anything else, and the envelope keeps its shape in every contract.
A manifest whose contract is in the form but not one the host serves is refused as `PROVIDER_CONTRACT_UNSUPPORTED`, naming that contract, and nothing else of it is read.
A manifest with no contract, or one not in the form, is refused with the schema refusal that says so.

### M-5 (normative): Every failure is a named refusal, and no refusal carries a value of the manifest beyond its contract

A manifest the schema does not admit is refused as `PROVIDER_SCHEMA_INVALID`, once per failure, each naming its rule from `SCHEMA_REFUSAL_RULES` and a JSON Pointer into the manifest, and a value that matches no shape of a `oneOf` is one `no-variant` refusal.
The rules JSON Schema cannot state run only on a manifest the schema admits, each under a rule name of its own, and `refusalSentence` words every refusal in one line.
No refusal carries a value of the manifest except `PROVIDER_CONTRACT_UNSUPPORTED`, which names the declared contract, so a refusal can be logged and shown without leaking what a package wrote.

### M-6 (normative): A package's identity is its package.json

The manifest declares no package name, version, licence, publisher or driver list.
Name, version, licence and Node range are the package's `package.json`, its name and version are compared with the lock entry (C-94), the publisher is computed from verified provenance, and the drivers are its dependencies and notices file.

### M-7 (normative): Engine ids

An engine id is the schema's `engineId`, and a manifest declares each of its engines once.

### M-8 (normative): Every engine fact is required

Every fact of an engine declaration is a required key in the schema's engine declaration, written as `null`, `false` or an empty list where the engine has none; only the connection defaults have optional keys.

### M-9 (normative): Connection fields are the contract's vocabulary, and so are their classes

A connection field is named from the contract's closed vocabulary, the schema's `fieldName`, and each name is in exactly one class, secret, identity or public, which the contract fixes and no manifest can change.
A field a package needs and the vocabulary lacks is added, with its class, by a later contract minor.

### M-10 (normative): Every secret field moves the provider cache key

Every field of the secret class is part of the key Studio keeps an open provider under, whatever a manifest declares.
So a connection whose secret changed is never handed a provider opened under the old one.

### M-11 (normative): The rules of an engine's connection

A refused field is never also one of the engine's fields.
A seed-only field is one of the engine's fields or a seed-only field name of the vocabulary.
A host path field is one of the engine's seed-only fields.

### M-12 (normative): A host path field is admitted by core

A host path field names a file on Studio's host, which core resolves, refusing one that names Studio's own storage files before the provider is built.
The provider reads only the absolute path core hands it, and credential material never travels as a path field.

### M-13 (normative): The runtime segment

The runtime segment is the schema's `runtime`: the package-relative entry module whose default export the loader reads, the pinned native packages, and the environment variables the package reads, each with its reason.

### M-14 (normative): Compatibility is a measured claim

A manifest lists the products it was measured against, one entry per product naming one of its engines, and every declared engine has at least one entry.
An entry claims a range of versions, a list of versions or a hosted service measured on a date, and lists the versions its tests ran against, each with its image pinned by its full SHA-256 digest where one exists.
Both ends of a range are tested versions.

### M-17 (normative): A package imports only what it declares

A package's source and tests import their own files, Node built-ins, the names their `package.json` declares and `@libredb/provider-sdk`, and its tests may also import a Bun runtime module.
No package imports a path into Studio's source, out of its own directory or into another provider package (C-42).
Studio reaches a package only by its package name.

### M-18 (normative): Package source reads no environment

A provider package's source, and the SDK's, reads no environment variable, working directory or other process-global state, and writes nothing to the console.
A provider takes every value from the connection and from what the host passes it.

### M-19 (normative): The SDK keeps no process-global state

The SDK is loaded once and shared by every provider, so it keeps no mutable module-level state and never reads `process`.
Each compiled validator is its own, and two validators share nothing.

### M-20 (informative): Studio never reads `vendor`

`vendor` is the package's own, and Studio reads none of its keys, though admission compares and freezes the whole manifest, vendor included (C-98, C-104).

### M-21 (informative): How a host admits a contract

While the major is 0, admission refuses a manifest built against any contract but Studio's own before the schema is applied (C-98).
The rule for major 1 and later is applied by the first host of a contract 1.x.

### M-22 (normative): How a package reads its declared environment

A package declares the environment variables it reads in `runtime.env`, and reads one only through `ctx.env.get`, which `envReader` builds over the declared names.
An undeclared name is refused with an `UndeclaredEnvironmentError` and the process environment is never read for it.
There is no denylist and no grant: a package reads what Studio's own process reads.

### M-23 (informative): The validator compiles code

The validator compiles the schema into a JavaScript function with `new Function`, and runs on the server and in the kit, never in a browser.

### M-24 (normative): A field's label, hint and placeholder

An engine may give any field it takes a label, a hint and a placeholder in `connection.dialog`, a list of entries that each name a field the engine takes, at most once.
A field with no entry keeps Studio's own label, no hint and its own example, and an empty placeholder shows no example.

### M-25 (normative): A field shown under a condition

A field may be drawn only while one other field, itself unconditioned, equals one value, which is one of its choices where that field is a select.
A field hidden by its condition is neither drawn nor saved, and core does not require it.
A connection that leaves a condition's field absent reads it as that field's declared absent value, and only a field a condition reads declares one.

### M-26 (normative): Where a placeable field is drawn

Every placeable field an engine takes, the schema's `placeableFieldName`, is placed `open` or `advanced`, and only a placeable field is placed.

### M-27 (normative): A select's choices

Every select field an engine takes, the schema's `selectFieldName`, declares its choices in the order the dialog lists them, each with the value saved and the label drawn, no two sharing a value.
Only a select field declares choices.

### M-28 (normative): The dialog's order

An engine may state the order the dialog draws its fields in, naming each field once and only fields it takes.
Fields the order leaves out are drawn after it, and `null` keeps the dialog's own order.

### M-29 (normative): The Host box's URI schemes

An engine that takes a `host` field may list in `connection.hostUriSchemes` the schemes, `http` or `https`, of an address pasted into its Host box, which the dialog splits into host and port.
The list's order is the order the box's refusal names them in.

### M-30 (normative): Credential warnings

An engine may warn about a credential in three kinds: `pair`, a published default user and password; `jwt`, a token that declares no expiry or names an access claim; and `no-secret`, a server that accepts no password.
Studio frames each warning in its own words, in the connection dialog and when it loads a seed file, where a read-only seed with a declared pair, or with no password where `no-secret` is declared, is refused.
An engine declares at most one `no-secret` warning, and each warning reads only fields the engine takes.

### M-31 (normative): A function is named, never carried

The manifest holds no code: where an engine has a function, its declaration names it and the package exports it.
A name is the schema's `functionName`, local to its engine, and a package names its functions freely.

### M-32 (informative): How a package's named functions are found and called

A package will export its named functions in one table, checked against its manifest's names, and the host will call each by name through one fixed entry point, on Studio's server and never in a browser.
Nothing resolves a package's names yet, and where a package's connection string readers, seed check or import run is decided with the first package that names one.
Until then a package engine's dialog draws no hint from the package and reads a Host text's identity as the text trimmed and lower-cased.

### M-33 (normative): Field rules

An engine may give a field it takes one rule in `connection.fieldRules`, stating at least one of `required`, `format`, `charRange` or a named `check`.
Fields are checked in the order of `connection.fields`, each with `required` first and then, only for a field that is not blank, `format`, `charRange` and `check`, and the first refusal is answered; a hidden field is not checked, and a field is blank when absent, null or empty, or, for a secret, not text or only whitespace.
The dialog and Studio's server evaluate the same rules before anything is sent, a rule takes every value its engine's provider takes, and the provider still checks its own secrets when it connects, because not every connection passes the dialog.

### M-34 (normative): A bounded pattern

A field rule's format is a regular expression's `source`, 1 to 512 characters, and its `flags`, the empty string or `u`, compiled as JavaScript's `RegExp` reads them.
A value is tested with `RegExp.prototype.test`, which matches anywhere, so a pattern for the whole value writes `^` and `$` itself.

### M-35 (informative): Backtracking is not checked yet

A pattern's author keeps it free of catastrophic backtracking, which this contract's validator does not check.
A regular expression analyzer will check every pattern before a package Studio does not ship is admitted, which is not before contract 1.0.

### M-36 (normative): The Host text readers

An engine that takes a `host` field may name a host hint, `connection.hostHint`, a sentence drawn from the Host box's text in place of the static hint.
It may also name a host identity, `connection.hostIdentity`, the server a Host text names, so the dialog drops the credentials when a pasted connection string names another server.

### M-37 (normative): The connection import

An engine may offer an import, `connection.import`: an action label and a named importer that reads a pasted text into entries, one of which fills the form.
The importer never throws and none of its sentences quotes the text it reads.
The dialog offers the import only for a new connection.

### M-38 (normative): A refused field's sentence

Each entry of `connection.refused` names a field the engine refuses, at most once, with the sentence that names the field and never its value.
Core refuses a connection that sets a refused field, holding a value other than null or the empty string, before it builds any provider, with the sentence of the first such field in list order.

### M-39 (normative): A connection string's scheme

An engine whose connection string names a paste reader may state, in `connection.connectionString.scheme`, the one lower-case URI scheme shown for it.

### M-40 (normative): The paste reader

An engine may read a connection string pasted into the dialog in `connection.connectionString.paste`, naming one reader for three operations: `claims` (whether it reads the paste), `names` (whether the paste is a spelling the engine connects with) and `parse` (the form's fields, or a refusal naming what to paste instead, for a text `claims` accepted).
The paste states whether its reader is a catch-all, claiming generic transport schemes other readers may claim on their own hosts.
It states the formats the Paste URL box names for the engine, at least one, each once, and only forms `parse` connects with.

### M-41 (normative): The order between paste readers is Studio's

Studio offers a paste to the readers in one order it keeps, every catch-all reader last, and the first reader that claims it parses it.
A manifest states no order and no pair of readers, since one package's claim about another's spelling is not its to make.

### M-42 (normative): The URL TLS reader

An engine whose connection string names a paste reader may name, in `connection.connectionString.urlTls`, a reader that turns a URL's TLS parameters into a TLS mode the form holds, or keeps the parameter as written where no mode expresses it.
It never answers a weaker mode than the engine's driver applies to the same URL, and never falls to `disable` on a value it does not recognise.

### M-43 (normative): The seed check

An engine may name, in `connection.connectionString.seedCheck`, a check Studio runs on a seed file's fields for a connection of the engine, before any socket, leaving a field written as a reference unjudged.
Each refusal names a field and a sentence that never quotes its value.

### M-44 (normative): The commit keyword

An engine states, in `editor.commitKeyword`, the one word that keeps an open transaction on it, which Studio's notice names when it rolled back a transaction a statement left open.

### M-45 (normative): The consent deadline

An engine whose long read ends differently from the others states, in `editor.consentDeadline`, the chip and the sentence the agent's consent card shows for it, and every other engine states null.

### M-46 (normative): Fence tags

A markdown fence tag tells Studio what a fenced block holds, read lower-cased, and an engine's id is always a tag naming it, so `editor.fenceAliases` lists only its other tags.
A tag names at most one engine: an alias is never an engine id or another engine's alias, within a manifest and across the admitted set, and never one of the schema's `genericFenceTag`.
An untagged fence and a generic tag hold a query and name no engine.

### M-47 (informative): Fence tags across packages

The validator refuses a duplicate alias within one manifest, and admission refuses one across packages (C-106), so a contested alias never reaches a reader.

### M-48 (normative): The explain format

An engine states, in `editor.explainFormat`, the format of its query plans, one of Studio's explain strategies, or null where it offers no explain.
The format stated is the one the provider declares for a connection it has not connected, the one Studio reads before it connects.

### M-49 (informative): A format measured at connect

A provider may answer another format, or none, for a connection it measures at connect or configures otherwise, which no manifest fact states yet and Studio reads from the connected provider.

### M-50 (normative): The query dialect

An engine states, in `editor.dialect`, null or one of Studio's query dialects with the answers of its row: whether Profile, the code generator, Generate Count Query and the SQL export formats are offered, and the command-line flags query history never keeps.
The editor names the engine's tabs by the dialect, and every declaration of one dialect states the same row.

### M-51 (normative): The connect budget

An engine states, in `connection.connectBudgetMs`, how long the host waits for an open of the engine and for its Test Connection, in milliseconds from the open's start: a whole number from 30,000 to 300,000, or null for the host's default, `DEFAULT_CONNECT_BUDGET_MS`, 70,000.
An engine states a budget of its own when its own connect bound at Studio's default statement timeout, plus 10 s for its answer to arrive, is longer than the default, so a provider that bounds its connect answers in its own words before the host does.

### M-52 (normative): Claims are requests

An engine states in `policy` and `mcp`, and in the members of its other segments M-53 names, what it asks of the gates Studio decides: each such member is a claim, a request and never a fact Studio believes as declared.
A declared fact is a claim when a gate reads it, one value lets that gate pass what another stops on the strength of what the provider does, and it has a restrictive value; a fact whose values only add to what a gate stops, such as a credential warning, is not a claim.
Every gate reads a claim only as Studio's grant of it (M-54), and read-only enforcement is no member: Studio keeps a connection's read-only mode wherever the granted write reach is not `open`.

### M-53 (normative): The restrictive value of each claim

Each claim has a restrictive value, the answer under which the gates that read it refuse, withhold or keep apart the most, and every restrictive value is a request the schema admits:

- `writeReach`: `open`, under which read-only mode is refused, the reach ordered `open`, `guarded`, `none` from the most restrictive;
- `readsFileAccessPosture`: true, so a denied handle and a full-reach one never share a provider;
- `deniedFileAccessRefusal`: a refusal, so every caller whose file access is denied is refused;
- `singleWriterFile`: false, so each user of a connection keeps a provider of their own;
- `readRootsRequired`, `metadataReadChangesState` and `agentCredentialRequired`: true;
- `exposable` and `statementRead`: false;
- `connection.opensLocalFile`: true, so core admits the file the connection names, no governance source grants the engine, and an untrusted VS Code workspace opens none;
- `connection.hostPathFields`: every host path field among the engine's seed-only fields, so core admits each before the provider reads it;
- `connection.serverLevelWithoutDatabase`: true at governance admission, so a definition that names no database is never granted, and false at the choice of database, so a caller's choice of database is never honoured;
- `connection.sshTunnel`: refused, so a connection whose tunnel is on is refused before anything is dialled;
- `connection.agentCredential`: null, so a seed's agent credential is refused at load;
- `agent.statementLanguage`: null, so no statement workflow opens in agent mode and MCP serves no statement on the engine;
- `facets.agentReadings`: empty, so every agent reading is refused before a provider is acquired;
- `sqlText.redaction`: `none`, so the query event log's redacted capture keeps nothing of the statement's text;
- `sqlText.readsSqlText`: true, so the confirmation gate reads the statement text as SQL;
- `sqlText.grammar.confirmExemptForms`: empty, so every shared dangerous keyword asks;
- `policy.agentCredentialForm`: `none`, so every agent acquisition is refused;
- `policy.maskingExemptColumns`: null, so every column the masking rules match stays masked;
- `agent.overlay.dialect.catalogRead.commandShaped`: false, so the statement fence admits no composed catalog command.

### M-54 (normative): How a host grants a claim

A host reads each claim as the more restrictive of the manifest's request and Studio's grant, which for an admitted package's engine is its register row (M-84), or the claim's restrictive value (M-53) where no row exists.
So a restrictive request is read as made, a looser one only as far as a grant allows, a declared claim alone never loosens a gate, a request outside its claim's vocabulary is refused by name, and a package carries no grant of its own in this contract.
The claim's form decides what "more restrictive" means:

- a write reach request is capped at the grant, and read as `open` where no grant exists;
- a claim restrictive when true is true where the request or the grant is, and one restrictive when false is true only where both are;
- a set a gate admits, refuses or keeps apart, `connection.hostPathFields`, is the union of request and grant, and a set a gate offers, `facets.agentReadings`, their intersection;
- `connection.serverLevelWithoutDatabase` is granted per gate, as restrictive when true where a gate refuses on true and as restrictive when false where a gate honours only on true;
- a claim whose values are not ordered, such as a statement language, an agent credential form, a redaction other than `none` or a single-writer file, is its grant where the request equals it and its restrictive value otherwise, a statement language only under M-87, and an unequal single-writer request leaves the engine refused by name at every open;
- a SQL text claim, `sqlText.readsSqlText`, `sqlText.redaction` or an exempt form of `sqlText.grammar.confirmExemptForms`, is granted only for the grammar its register row reviewed, `grammarSha256`, `readsSqlText: false` also only under M-87, and is read at its restrictive value under any other grammar;
- a requested refusal, of denied file access or of an SSH tunnel, keeps its own sentence, one offered against a refusing grant takes the grant's sentence, and one offered where no grant exists takes the host's own.

### M-55 (normative): The rules of an engine's claims

The rules check an engine's requests, never a host's reading of them, and a request of every claim at its restrictive value meets them where the engine's connection allows it:

- a statement read is claimed only for an engine its MCP claims expose;
- an agent credential is required only of an engine whose seeds take one, `connection.agentCredential`, and read roots only of an engine whose seed-only fields name `agentReadRoots`;
- a seed's agent credential takes the form the request names (M-58): `pair`, an `agentUser` and an `agentPassword` together; `dedicated-pair`, the same with an `agentUser` other than the connection's own `user`; `secret`, an `agentPassword` alone; and a request of `none` is held to no seed form;
- a denied file access refusal is stated only for an engine that reads the file-access posture.

An engine a host reads as requiring an agent credential it can never present is closed to MCP: its granted `exposable` is false.

### M-56 (normative): The trust material a provider is handed

An engine whose provider's TLS library does not read Node.js's trust store states `connection.readsTrustMaterial: true`, and its provider is handed, as data, the CA certificates of the file `NODE_EXTRA_CA_CERTS` names.
Every other engine states false and is handed nothing.
It is not a claim: no gate reads it, and a provider that needs the material and does not ask fails to verify, never verifies less.

### M-58 (normative): The agent credential form an engine requests

`policy.agentCredentialForm` is one of the forms Studio's agent credential takes, `pair` naming the user and password together.
Every agent acquisition reads Studio's grant of the request (M-54).

### M-59 (normative): A masking exemption matches whole column names only

The column pattern of `policy.maskingExemptColumns` opens with `^`, closes with a `$` that no backslash escapes and no character class holds, keeps every alternative inside a group, and compiles with no flag.
The pattern is read as text and never run, so `^a$|^b$` is refused for the group form `^(?:a|b)$`.
An unanchored exemption would reach columns other masking rules cover.

### M-60 (normative): An engine's safeguards are its provider's own statements

The `safeguards` segment states what the provider's code does: the reach of each write path, the metadata-only answer of its read path, and the result columns its inline editor refuses.
No gate reads a safeguard, so none is a claim (M-52): a review reads them as the evidence of the policy claims, and a provider that declares no write reach is read as open on every path.
A fact a provider answers only per connection, or one that waits for a chapter not yet in this contract, is not a member.

### M-61 (normative): The write paths and the write reach they sum to

Each of the four write paths is absent, gated with the gate that refuses every write there while read-only mode holds, or open, and an absent editor path names the structural proof that keeps it so.
A gate or a proof names a module by its path from the package root, under `src/`, with no dot segment and ending in `.ts`, and an export by its name.
`policy.writeReach` is the summary of the paths: `open` where any path is open, else `guarded` where any is gated, else `none`.

### M-62 (normative): The metadata-only answer and the inline edit refusal

`metadataOnly` lists each operation the metadata-only read permits, once, in the provider's order, with its columns, each once within its operation, and the kind of fact each holds; it is null where the provider answers as it reads.
`inlineEditRefusedColumns` is a type pattern that compiles with no flag and the reason a refused cell shows, or null.

### M-63 (informative): Facts a provider answers per connection

Whether a request resumes compute the engine bills for, `resumesBilledCompute`, is the provider's answer for each connection, read from the provider built for it.
It depends on the connection and protects none of a claim's boundaries, so no member states it.

### M-64 (normative): An engine's maintenance specs

`facets.maintenanceSpecs` holds one spec for each operation `facets.maintenance` lists, and no other.
A spec states its operation, its label, whether it runs on one object a row names and whether over the whole database, a card's title and description or null, its typed confirmation or null, whether a row previews it, and the object kinds a row offers it on, or null for every relation kind.
Neither a spec nor the maintenance list is a claim (M-52): Studio reads them only to refuse a request the provider says it does not take, and a typed confirmation only adds a step to the confirmations Studio asks itself.

### M-65 (normative): Where a spec places its operation, its confirmation and its preview

A spec places its operation on a row, over the whole database or both; only `kill` places it nowhere, since its target is a session the session list names.
Each confirmation goes with one placement:

- a typed confirmation, the connection's name, only where the operation is placed over the whole database alone, with a title and a description, and asked on its card;
- a typed target, the object's own name, only where the operation is placed on a row alone;
- a preview only on a row.

A confirmation is admitted only where at least one control sends the operation and every control that sends it asks the confirmation.

### M-66 (informative): The maintenance a connected server accepts

A provider may measure at connect which placements its server accepts and narrow its declaration for that connection: a refused placement is withdrawn, an operation left with none leaves the list, and nothing is added or widened.
The declaration states the maintenance before any connection, and a session answers a connection's narrowing in its refinement (C-68).

### M-67 (normative): An engine's agent overlay

`agent.overlay` states how agent mode composes on the engine, and is null exactly where the engine speaks no statement language.
Otherwise it states the engine's SQL dialect (M-68), null on every family but SQL, and a named derivation of its family's grounding, or null where it keeps its family's, every function named by its slot and exported by the package (M-31).
No member states the dialect's client view, the engine's family or whether agent mode runs on the engine, which Studio decides (C-39).

### M-68 (normative): The SQL dialect

A dialect states the following, each member null where the engine composes none:

- its catalog read: a composer per catalog kind, an optional schema fold, retry and row mapper, and whether its statement is a command;
- its estimating plan: a prefix that opens with EXPLAIN and holds no word that executes the plan, or a session mode;
- its profile: two shape tests and the type patterns of the columns it leaves out;
- its statistics: a builder and an optional probe and note;
- its capture: the catalog kinds it reads in order, a builder, and the engine's word for each object kind the provider declares, once.

A statistics reading or a capture is stated only beside a catalog read.

### M-69 (normative): A composed statement meets the statement fence

Every statement a dialect composes is checked as a statement the model wrote: the catalog read and its statistics as a bounded read, the estimating plan and the profile as a bounded read that refuses plan execution, and the statistics probe as a plain read.
So a dialect widens what agent mode composes on an engine it already runs on, never where it runs or what the fence admits.
The one exception is a catalog read whose statement is a command, claimed as `commandShaped` (M-53) and granted by the engine's register row (M-54, M-84): the fence admits that one statement by identity, still refusing a comment or a word with a side effect.

### M-73 (normative): An engine's TLS modes are data of its declaration

A declaration states in `connection.tls.modes` the TLS modes its provider takes, each once and in the order of the schema's `tlsMode`, or none where the engine offers no TLS, so no TLS panel is drawn and the provider receives no TLS settings.
Each mode means the same on every engine that lists it, and the SDK's `TlsSettings.mode` reads the same vocabulary, `TlsMode`.
A mode outside the vocabulary, a repeated mode and a mode out of order are each refused by name at the mode's own pointer.

### M-76 (normative): An agent reading's panel is offered

An engine lists in `facets.agentReadings` a reading served by a monitoring panel only where its `facets.monitoring` offers that panel, since the host refuses a panel the engine does not offer (C-71); `health`, served by the mandatory health call, is admitted whatever the panels.
Any other such reading is refused as `agent-reading-panel-not-offered` at the reading's own pointer, in a sentence naming the pointer and no value.

### M-84 (normative): The register

A grant to an admitted package's engine is a row of Studio's register, keyed by the package's name, version and digest (C-93) and by the engine, so a new version or digest of a package has no row until LibreDB reviews it.
A row grants claims as M-54 reads them, and may also grant the engine its own words through core's scrub (C-112), never by default.
A row is LibreDB's review, kept in Studio's repository until the providers move to repositories of their own, and no manifest member, lock entry or admission step writes one.

### M-85 (normative): An engine's statement language is data of its declaration

An engine that speaks a statement language of its own, not SQL, states that language as data in its declaration, and states null there where it speaks SQL or no statement language.
The data names the language and states its confirmation part (M-86) and its agent part, or null where agent mode sends the language no statement: the request form agent mode admits, the text agent mode shows and the MCP statement tool the language is served as, null where it has none; every member required as M-8 says, with the manifest schema as its vocabulary.
A text is a string or a list of parts, a part naming a value Studio fills only where the schema lists that value for the text, and it reaches the model and the user only as the register row grants the language (M-87).

### M-86 (normative): The confirmation part of a statement language

The confirmation part states the operations whose statements ask a confirmation, which of core's reader kinds names the operations a statement runs, and whether that reading is the confirmation's whole answer or the shared dangerous keywords are also read in the statement.
It also states whether Studio may send the language's statements to the AI safety analysis, and the most UTF-8 bytes a statement may hold, past which Studio refuses the statement before it is sent, or null for no bound.
It names no function of the package.

### M-87 (normative): A register row reviews an engine's statement language data

A register row states the digest of the statement language data it reviewed, `languageSha256`, or null for an engine that states none, and grants the engine's statement language, the claim that its confirmation reading is the whole answer and `readsSqlText: false` only where that is the digest of the data the engine states, so a changed byte of that data grants none of them until LibreDB reviews it again.
A package row that grants `readsSqlText: false` or `decidesAlone: true` with a null digest is refused, so a package engine that states no statement language data is never granted either of the two.

## Values

A value crosses a JSON boundary, between a provider and the host or between two of the host's own hops, in one form: the value codec of `@libredb/provider-sdk/values`.

### V-1 (normative): One codec, and its tags are the schema's

A value is plain JSON, or a tagged value: an object whose own keys are exactly `$`, the tag, and `v`, its payload.
The tags are the schema's `valueTag`, typed `ValueTag`, and the codec's module comment states the value and the payload of each.
`encodeValue` writes only those tags and `decodeValue` reads only those.

### V-2 (normative): Every tag round-trips

A value the codec encodes decodes to the same value, an object member left out under V-9 aside, and a JSON value with no tagged kind crosses unchanged.

### V-3 (normative): Nothing a database hands back is read as a tag

A data object whose own keys are exactly `$` and `v` is written as the escape tag, so an object with those two keys on the wire is always a tag.

### V-4 (normative): The domain is closed, and a refusal never carries the value

The codec refuses every value outside its domain with a `ValueCodecError` that names the kind and the JSON Pointer of the place, never the value.

### V-5 (normative): Decoding is strict and canonical

A payload in any spelling but the one the encoder writes, an unknown tag, a payload of the wrong type and a value `JSON.parse` cannot produce are each refused on decode.

### V-6 (informative): No tag for a decimal, a date, a time of day or a duration

The codec has no tag for a decimal, a date without a time, a time of day or a duration, because no provider hands it one.
A later minor of the contract adds such a tag together with the provider that needs it.

### V-7 (informative): The codec loads in a browser

The codec uses no Node-only global, so it loads in a browser as well as on the server.
Nothing checks this yet.

### V-8 (normative): Nesting depth is bounded

An array or a data object nested inside `MAX_VALUE_DEPTH` others is refused on encode and on decode with a `ValueCodecError` naming its JSON Pointer, so a deep or cyclic value never overflows the stack.
A tagged value counts as the one value it carries: the tag wrapper adds no level, and an `obj` payload is the data object the bound counts.

### V-9 (normative): An object member whose value is undefined is left out

An object member whose value is `undefined` is left out on encode, as JSON leaves it out, and the `obj` escape is decided on the members written.
`undefined` at the root or as an array element is refused.

## Errors

A failed call answers, beside its words, an error record of closed fields a reader can branch on, whose shape and vocabularies `@libredb/provider-sdk/errors` exports.
A provider raises an error class and never writes a record: Studio's core reads each error into one.

### E-1 (normative): A provider raises only the kinds a provider may raise

A provider constructs and extends only error classes whose kind is in `PROVIDER_ERROR_KINDS`; the other kinds, `CORE_ERROR_KINDS`, are core's own, each with its reason beside the constant, and the two lists partition `ERROR_KINDS`.
One core kind reaches a caller through a provider: the read allowance in a statement budget raises `read-allowance-exceeded` when the provider charges past what is left.
The provider lets that refusal pass unchanged and never constructs one of its own.

### E-2 (normative): A provider's own class takes its nearest contract class's kind

An error class a provider declares takes the kind of the nearest contract class it extends, whatever its own fields say.
Any thrown value that is no contract error is `internal`.

### E-3 (normative): The record is closed

A record holds `kind` and `code`, and may hold `sqlState`, `engineCode`, `outcome` and `sessionState`, each in its vocabulary or pattern: `ERROR_KINDS`, `SQLSTATE_PATTERN`, `ENGINE_CODE_PATTERN`, `EXECUTE_OUTCOMES` and `SESSION_STATES`.
A reader refuses any other record, naming the field and never its value.

### E-4 (normative): The record holds no text of the error

A record holds no message, detail, statement or identifier of the error.

### E-5 (normative): Only a statement that cannot have reached the database is not-sent

`outcome` is `not-sent` only when the statement cannot have reached the database, no provider writes an error's `outcome` itself, and every other failure is `unknown`.
The host marks not-sent every failure of a provider's connect and every console call it refuses before making it.
A provider claims not-sent only by raising `refused-before-send`, by taking its connection or session through `checkoutPhase` before it sends anything (a deadline the checkout meets becomes a `ConnectionError` naming the wait), or by raising `transaction-lost` with `beforeSend` for a call on a held transaction whose session it found already ended.

### E-6 (informative): No error carries a session state or an engine code yet

`sessionState` and `engineCode` are defined and read, and no error carries either yet.

### E-7 (normative): A driver error row maps into the record

A driver's error row, `DriverErrorClassifier`, answers what the driver's own fields and words say of an error, and each answer maps to one kind.
A configuration refusal is `config`; a database the login cannot open is `connection`; an access refusal is `permission` for a missing privilege and `authentication` for a refused credential, the credential words counting only on an error with no code; a statement fault is `query`; the engine's own time budget is `timeout`; a cancelled statement is `cancelled`; a late classification is `connection` or `query`, as it says.
The record keeps the SQLSTATE the driver reported.

### E-8 (normative): Nothing resends on `retryable`

An answer's `retryable` is advice to a person that trying again may help.
No host, client, agent or MCP component resends a request because of it, for a write and a billed read alike.

## SQL grammar

An engine whose query text is SQL states its grammar facts: what a handful of characters and forms mean in its SQL, which Studio's readers read a statement's structure with.

### S-1 (normative): One grammar type and one compatibility default, both the SDK's

The grammar facts are one type, `SqlGrammar`, and the compatibility reading is one value, `DEFAULT_SQL_GRAMMAR`, both exported from `@libredb/provider-sdk/sql`.
A fact a dialect has not established takes the default's value, and the default is frozen to its leaves, so no module that imports it changes it for another.

### S-3 (normative): The SQL text segment

An engine states, in `sqlText`, whether its statement text is SQL, its grammar facts, its redaction, its update target words and its completion quoting, or null where it has no SQL text.
`grammar` has one required member per member of the SDK's `SqlGrammar`, under the same name.
Studio reads an engine whose `sqlText` is null as one whose grammar no register row reviews (S-7, S-8), whatever its register row grants.

### S-4 (normative): A fact the grammar may leave out is written

A fact the `SqlGrammar` type may leave out is written at the reading its absence has, so a grammar read from a declaration reads every statement as the default reading does:

- a form the engine does not have is false or an empty list, tagged runs are true, the formatter language is `postgresql` and the completion words are two empty lists where the engine adds none;
- the two backslash overrides are null where the quote takes the reading `backslashAlwaysEscapes` gives both quotes;
- the session keys are null where no SET or RESET asks, and a list, even an empty one, makes a RESET with no key ask.

A formatter language is one of the sql-formatter languages Studio's own engines state.

### S-5 (normative): Trailing limit clauses

A trailing limit clause is a pattern of a `source`, of 1 to 512 characters, which opens with `\s+` and closes with `\s*$`, and its `flags`, `i` or `iu`, compiled as JavaScript's `RegExp` reads them.
Studio places the row bound before the run of such clauses at a statement's end, stripping them in the order declared, and reads a bound followed by such a run as the statement's own.

### S-6 (informative): How a host runs a clause pattern

A host compiles each clause pattern once, when it reads the declaration, and anchors the whole pattern behind a character that is not whitespace and at the statement's end, so a match starts only where a whitespace run starts and ends only at the end.
Backtracking is not checked yet, as M-35 says of a field rule's pattern.

### S-7 (normative): Redaction

An engine's redaction says what the query event log's redacted capture keeps of a statement, while its full capture keeps the statement and its error text with their credentials masked under every redaction:

- `sql`: the statement's literals are replaced, and only a closed name in its `nameQuote` is kept, or none where it is null;
- `none`: nothing of the text is kept;
- `command`: a named pure reader answers, from the statement's text, the text the log keeps.

Studio keeps a statement under the redaction an engine's register row grants for the grammar that row reviewed (M-54, M-84), and a register row grants a provider package's engine `sql` or `none`, never `command`.
Where no register row reviews the grammar an engine declares, its query events keep no statement and no error text in any capture mode, and read the statement's kind as `OTHER`.

### S-8 (normative): A claim that loosens the confirmation gate

`readsSqlText: false` and an exempt form each loosen the confirmation gate.
The gate counts such a claim only where the engine's register row grants it for the grammar that row reviewed (M-54, M-84), the query event log reads `readsSqlText` the same way, and every other reader reads it as declared.
Where no register row reviews the grammar an engine declares, the gate asks about every statement of the engine; under a reviewed grammar it reads a provider package's statements under that grammar and asks where a statement asks under either value of `explainExecutesWithAnalyze`.

### S-9 (normative): Update target words and completion quoting

`updateTarget` names the words beside the shared sets that open a query and that join two queries, each one upper-case word, and whether `--` opens a comment only before a space or a control character.
`completion` names a pure segment formatter, used instead of the connection's quoting, and a pure reader of a quoted qualifier before a dot, each null where the engine has none.

### S-10 (informative): Where a grammar function runs

Studio runs a command redaction reader on its server and its completion readers in the browser.
Where a package's completion reader runs is decided with the first package that names one (M-32).

### S-11 (normative): The SQL writing segment

An engine states, in `sqlWriting`, how a generated statement spells a literal, a name, a bind and a temporal literal for it, what its inline edit and its result export read, and how a document insert is written where its console text is a request, or null where it has no SQL writing.
Every member is required: a function the engine lacks is null, and every other function is named by the slot it fills.

### S-12 (normative): The type names an inline edit and an export read

An inline edit type name is one lower-case word, and a standing-alone name, a bare spelling's name and a bare type family's name are lower-case words separated by one space, as Studio reads a declared type lower-cased, unwrapped and with its whitespace collapsed.
Every key column is float64 where `float64TypeNames` is `all`.
A map keyed by type name is a list, the bare spellings as entries and the bare type families as one list per kind, and each name is named once per table.

### S-13 (normative): Text an export writes from a declaration stays on its line

Nothing a declaration states becomes a statement of the file an export writes:

- a DDL type and a bare spelling are each one SQL type of up to 64 characters with no line break, words separated by one space with at most one parenthesized argument list, so it fills one column's type;
- a non-finite literal is printable ASCII with no line break and no space at either end;
- a create table key's note is whole comment lines, each `-- ` and text with no line break, ending in a line feed.

### S-14 (normative): The type vocabulary

Each engine states the vocabulary its declared types are read with: its bare type families grouped by kind, and three patterns.
Each pattern is a `source` of 2 to 512 characters written with `^` and `$`, and its `flags`, none, `i`, `u` or `iu`, compiled as JavaScript's `RegExp` reads them.
`floatType` and `exactNumericType` are tested against a whole type, and `numericWrapper` captures exactly one group, the type it wraps.

### S-15 (informative): How a host runs a type pattern

A host compiles each type pattern once, when it reads the declaration, and takes a wrapper off only while the pattern matches and its capture is a strictly shorter type, so a capture as long as the type, or none, ends the unwrapping.
Backtracking is not checked yet, as M-35 says of a field rule's pattern.

### S-16 (informative): Where an SQL writing function runs

Studio runs the SQL writing functions in the browser and on its server.
A package that fills a slot is admitted with its names read for their form only (C-99), and its engine gets no SQL writing in this contract.
How a package's SQL writing functions are called and granted is decided in provider isolation milestone M7, where the browser reads the engine catalog at run time.

### S-17 (normative): The migration DDL segment

An engine states, in `migrationDdl`, what the schema diff's migration writes for it, in one of two forms, every member required, or null where it has no migration DDL, and a value neither form admits is one `no-variant` refusal at the segment:

- refused: the one line the migration writes in place of any statement, no transaction wrapper, and the reason the line gives;
- written: its transaction wrapper or none, its CREATE TABLE form, written by a key writer and a foreign key writer or refused by a named function that writes the line for the quoted table, its nine statement writers, and every refusal sentence its writers print.

### S-18 (normative): Text a migration writes from a declaration stays on its line

Nothing a declaration states becomes a second statement of the migration:

- the refusal is one comment line, `-- ` and text with no line break, up to 1024 characters;
- each transaction wrapper statement is words separated by one space, ending in its one semicolon, up to 64 characters;
- each reason is one line of 1 to 1024 characters, named once.

### S-19 (informative): Where a migration DDL function runs

Studio runs every migration DDL function in the browser, in the schema diff panel, which shows and copies the migration text and never runs it.
How a package's migration DDL functions are called is decided with the first package that fills a slot.

### S-20 (normative): The SQL generator segment

An SQL engine states, in `sqlGenerators`, what it writes apart from Studio's shared SQL forms, or null where it quotes a name as its declared identifier quoting says and counts with `COUNT(*)`.
Otherwise it names the engine's name quoting, the tree click's statement, and Generate Query's statement on the column list and on the projected column list, each null where the shared form stands, and states the count Generate Count Query writes.
Every member is required.

### S-21 (normative): A count expression is one call

A count expression is an aggregate name of letters, digits and underscores, starting with a letter, followed by `(*)`, up to 64 characters.
So the count a declaration states fills one expression of the statement Studio writes, and never adds a clause or a statement.

### S-22 (informative): Where an SQL generator function runs

Studio runs a generator row's name quoting in the browser and on its server, and its statement forms and count in the browser.
How a package's generator functions are called is decided with the first package that fills a slot, and the query dialects' and query languages' own generators stay Studio's while the dialect is one of Studio's (M-50).

### S-23 (normative): The editor language

An engine states, in `editor.language`, the query language it speaks, one of Studio's query languages, the Monaco language its query tabs are written in (one of Studio's editor languages), that language's accent, and whether it is a console dialect, whose id is its Monaco id.
An accent is a border class of one hue of Studio's palette at 40 percent, optionally its `-alt` step, and is none of the three status hues, amber, rose and emerald.
Two engines that name one editor language state the same accent and console, and an engine's tabs open under its dialect's name (M-50) or, with no dialect, its query language's tab type, so a manifest states no tab type.

### S-24 (informative): What stays Studio's browser code

A language's Monaco registration, completion source and formatter, and a console dialect's grammar and routes, stay Studio's browser code keyed by the language's Monaco id, so an engine's editor language is one Studio's editor already has.

## Calls

The host calls a provider's implementation in its own process, as async functions, and every request and answer is data in the value codec's domain except the session handle `open` answers, which is the package's own and which the host never reads (C-22).
The mandatory calls are `open`, `close`, `health` and `console.execute` (C-3), and the manifest's `calls` segment, a fact of the package beside `runtime` since one implementation serves every engine the package declares, declares the optional request fields its execute honours and the optional facets it answers:

- the console facets: `cancel`, which cancels a run, `endScope`, which ends a session scope, and `transaction`, which opens, commits and rolls back a transaction and reads its state (C-57);
- the object facet: `tree`, which lists, counts and describes a connection's containers and objects (C-61);
- the maintenance facets: `run`, which runs one operation an engine lists, and `preview`, which reads what a per-row operation would do (C-67);
- the monitoring facets: `panel`, which reads one monitoring panel an engine offers, and `poolStats`, which reads the counts of the session's own pool (C-71).

The shapes of each call, its request, its answer and the contexts the host passes are the types `@libredb/provider-sdk/calls` exports.

### C-1 (normative): A package's entry exports the record defineProvider returns

A package's entry default-exports the record `defineProvider` returns, `{ contract, manifest, impl }`, a plain object with no brand, since several copies of the SDK may share Studio's process.
`checkProviderModule` refuses any other value by a rule of `DEFINITION_REFUSAL_RULES`, naming a JSON Pointer into the record and never a value, reads every key as a data property without calling a getter, and refuses a list longer than its bound, the request fields or the schema's `maxItems` (at most 64 engines), by its length before reading any item.
The record is frozen, its implementation frozen in place and its manifest a deep-frozen copy, so the package's own manifest object is never changed.

### C-2 (informative): Admission checks the record with the host's SDK

Admission runs the host's own copy of `checkProviderModule` and of the manifest validator on the entry's `default` export (C-87, C-98, C-104), so a record another copy of the SDK built is checked by the host's.

### C-3 (normative): The mandatory calls

The mandatory calls are `open`, `close`, `health` and `console.execute`, each a function of the implementation at the path its name spells.
An implementation's only keys are `open`, `close`, `health`, `console`, `objects`, `maintenance` and `monitoring`, and one that offers no object, maintenance or monitoring facet may leave that segment out or hold it empty.
Each calls segment present is a record of its calls: any other value is refused by name and nothing under it is read.

### C-4 (normative): An optional facet is declared and implemented, both ways

An optional facet of `CONSOLE_FACETS`, `OBJECTS_FACETS`, `MAINTENANCE_FACETS` or `MONITORING_FACETS` is offered in the manifest's `calls` exactly when the implementation has its function, and is never discovered by calling it or by its shape.
An engine fact that needs a call is admitted only where the package offers that call, and is otherwise refused by name as `engine-facet-call-not-offered`, naming the call:

- a maintenance operation needs `maintenance.run`, and a maintenance spec that previews needs `maintenance.preview`;
- an offered monitoring panel needs `monitoring.panel`;
- an agent reading served by a monitoring panel needs `monitoring.panel`, and `health` is served on every package.

A package may offer a maintenance or monitoring facet no engine uses, since the host never calls it without one.

### C-5 (normative): A package declares the request fields its execute honours

A package lists in `calls.console.execute.honours` the optional request fields of `EXECUTE_REQUEST_FIELDS` its execute honours (C-8, C-9).
A package that serves read-only statements lists `readOnly` (C-78).

### C-6 (normative): A package never reads a proxy variable

`runtime.env` cannot declare a proxy variable, in either case, and package source reads no environment variable itself (M-18), so every route out of Studio's process is core's.
A kit check that runs each package in an environment poisoned with proxy variables does not exist yet.

### C-8 (informative): A provider never ignores a request field it does not honour

A provider that receives a request field it does not honour answers a named error and never ignores it.
The kit does not check it yet, and the host's half is C-9.

### C-9 (normative): The host sends only the request fields a session honours

The host holds every execute request to the session's calls with `checkExecuteRequest` before the call, refusing by a rule of `CALL_REFUSAL_RULES`, naming the field and a JSON Pointer and never a value, an optional request field the session does not honour, `readOnly` included, or a `scope` to a session that does not offer `console.endScope`.
A statement sent inside a transaction, with `transaction`, goes only to a session that offers `console.transaction`, never with a `scope`, and is held to the same `honours`.
A present `params` key is sent whatever its length, and an offset is sent when it is not zero.

### C-10 (normative): A refinement only narrows a session's calls

`open` may answer a refinement beside its handle: a closed object at the paths of the manifest's `calls`, every key optional and every value a subset of the declared one, and `maintenance`, the placements the session's server accepts (C-68).
`checkRefinement` refuses a widening, an unknown key and an unreadable value by name, never calling a getter or carrying a value, so a refinement may withdraw any facet the manifest offers and never offers another; `health` is no member of `calls` and is never withdrawn (C-72).
`sessionCalls` answers the narrowed calls, frozen, which the host keeps with the session and nowhere else.

### C-11 (normative): The contexts and requests the host passes are frozen

`freezeContext` freezes a context in place at every depth except its `signal` and `env`, which stay as the host passed them, and `freezeData` freezes a request in place at every depth except its typed arrays and dates.
Both walk every own key, symbols included, and refuse by JSON Pointer, freezing nothing, an object outside the value codec's domain, a function, an invalid Date, an accessor property, whose getter is never called, and a symbol-keyed property.

### C-12 (normative): The host freezes on every call, in every environment

The host passes every context and request through `freezeContext` and `freezeData` on every call, in every environment, so a provider that writes to what the host passed fails the same way in a test and in production, at the line that writes.
Both freeze in place, so the host builds a fresh context and request for each call.

### C-13 (normative): The byte budgets and the row measure

The byte budgets of a result are `BATCH_MAX_BYTES` for one batch and `PAGE_MAX_BYTES` for one page.
A row's size is the UTF-8 length of its encoded JSON text, `encodedRowBytes`, a batch's and a page's the sum of their rows', and each pull hands its own `measure`, on its limit, which answers that size.
Measuring a row encodes every cell, so a cell outside the value codec's domain is refused by the codec's own error.

### C-14 (normative): A result source answers within the limit it is asked for

A result source answers each `next` with at most the rows and the bytes it is asked for, and never splits a row, so a batch of exactly one row may be larger than its byte limit and one row always makes progress.
It sizes each row it answers with the measure of the limit it is asked with.
`rowsSource` does so over rows a driver already holds in memory.

### C-15 (normative): The host pulls a page with pumpPage

The host pulls a page from a result source with `pumpPage`, one batch at a time, each pull asking for no more than the page has left with a frozen limit that holds that pull's own measure, which throws when called after its pull answered.
The pump refuses by a rule of `CALL_REFUSAL_RULES` a batch that breaks C-14 or is not a plain record of rows and done, a row that is not positional, a batch that brings nothing and is not done, and a row no page can hold.
It cuts the page by size, ends it at its row limit or when the source is done, starts no pull once the execute call's signal aborted or its deadline passed (C-27), never keeps a source open across pages, and closes the source exactly once on every path, throwing both failures together when the close fails after another.

### C-16 (normative): What the byte budgets bound

The budgets bound what crosses from a provider, not what a driver buffers: a driver without a cursor materialises a page before the SDK sees it, and a page of very small rows is bounded by the host's finite row limit.
The pump runs in the host's copy of the SDK, so every package's batches are measured by one rule, and a row a source answers as the very array the pull's measure sized is measured once, any other row, such as a copy or a row answered twice, again.
The pump hands on the provider's own row arrays, so a source whose cells change after a row was measured answers more than was measured.

### C-17 (normative): The host calls a facet only when the session offers it

The host holds every facet call to the session's calls, as `sessionCalls` answers them, with `checkConsoleFacet`, `checkObjectsFacet`, `checkMaintenanceFacet` or `checkMonitoringFacet` before the call, and refuses a facet the session does not offer as `facet-not-offered`.
It holds maintenance and monitoring requests to the session's maintenance and the engine's panels, each refusal naming a JSON Pointer into the request, in request order, and never a value:

- `checkMaintenanceRunRequest` and `checkMaintenancePreviewRequest` refuse an operation the session does not list as `request-operation-not-offered`, a placement its spec does not offer as `request-placement-not-offered`, which `kill` and an operation listed with no spec pass, and a preview its spec does not declare as `request-preview-not-offered`;
- empty text where a request names something, a target, a container, a path or a name in it, is `request-field-empty`;
- `checkMonitoringPanelRequest` refuses a panel the engine does not offer, a request that names none and an inherited panel name as `request-panel-not-offered`, without throwing.

### C-18 (normative): The testing entry is for tests

`@libredb/provider-sdk/testing` holds the memory test transport's pieces, and only tests import it.
The package root never re-exports it, and Studio's runtime source never imports it, a type import included.

### C-19 (normative): serve crosses every call as JSON frames through the value codec

`serve` puts a provider module record, checked first with `checkProviderModule`, behind the memory test transport: every call crosses as one request frame and one answer frame, the JSON text of what `encodeValue` wrote, decoded with `decodeValue` on the other side, with the host's `signal`, `env` and a pull's `measure` attached by reference.
The provider receives decoded copies frozen by `freezeContext` and `freezeData`, the host receives decoded copies of each answer, and a row that crosses a frame is a new array, which the host's pump measures itself.
A value outside the codec's domain fails where it is encoded, an `undefined` optional member is refused as `round-trip-changed`, a frame `readFrame` or `roundTripRefusals` refuses fails as one `FrameRefusalError`, and an error either side throws crosses by reference.

### C-20 (normative): Each part of each frame is read as a closed shape

`readFrame` reads each part of each call's frame, its context, request and answer, as the closed shape of its call type, refusing by a rule of `FRAME_REFUSAL_RULES`, at a JSON Pointer and never with a value, a key the shape does not define, a missing required key, and a value of the wrong type, outside its vocabulary, behind an accessor or in a list with a hole.
A part with several forms is read as exactly one of them, told apart by its action, its panel or its keys, as the call types state them, and a timestamp admits only a valid `Date`; an open answer may carry `engineUser`, the engine principal the session acts as, as text.
The reader reads shapes only: which answer form answers which action or panel is the host's (C-62).

### C-21 (normative): What crosses is compared deep-equal, and whatever the round trip changes is refused

The value a side decodes is compared deep-equal with the value the other side handed, as `roundTripRefusals` does, never copied with `structuredClone`, so a test sees what a JSON boundary does to a value.
Whatever the codec's round trip changes or drops is refused as `round-trip-changed` at its pointer: a symbol-keyed or non-enumerable property, an accessor, whose getter is never called, an array's property that is not an index, and a key, length or leaf that differs.
What the codec defines as equal compares equal, such as `-0` and `0`, NaN and NaN, a Buffer and a `Uint8Array` of the same bytes, a `Date` subclass and a `Date` of the same time, and an object with no prototype and a plain one, a `Uint8Array` or `Date` compared by its bytes or time alone.

### C-22 (normative): A session handle and a result source never cross

Over the memory test transport a session handle and a result source stay in tables the served instance owns and only their ids cross: the host holds a frozen token per session, looked up by identity, and the provider's calls receive its own handle.
A closed or foreign token is refused as `session-not-open`, and a closed result source as `result-not-open`, before any frame.
A close takes its entry out of both tables whatever the provider's close answers, and a close that resolves anything but nothing is refused.

### C-23 (normative): The served host side checks each call before any frame, and closes what a refused answer handed over

The served host side refuses before any frame what C-9 and C-17 refuse, holding each call to the session's calls as the refinement `open` answered narrows them (C-10, C-68) and each panel call to the open engine's panels, and refuses an open context that names an engine the manifest does not declare.
An answer the host refuses holds nothing open afterwards: a refused open answer closes its session through the provider's `close` under a cleanup context of its own (C-47), and a refused execute answer closes each result source it handed over, an item that is not an object refused at its index and a source whose `columns` or `rowCount` read throws closed with those before it.
Every close runs, and when one fails the host receives an `AggregateError` with the refusal first and each close's error after it.

### C-24 (normative): A frame never grows past what the provider holds

The transport encodes a value before it stringifies it, and every loop it runs over a provider's array stops at the first hole, so a sparse list of any length is refused at its first hole.
A served result source asks the provider for exactly the limit it is pulled with, one batch a pull, and buffers nothing ahead, so `pumpPage` cuts a page of a source that never ends at its byte budget.

### C-25 (informative): The memory transport is a test transport

The memory transport keeps frames for tests only, so a test and the kit see what crossing a JSON boundary does to a call.
Whether any of its checks run in production is decided with the first host surface.

### C-26 (normative): One deadline, owned by the host

Every call's context carries one absolute `deadline`, in epoch milliseconds on the clock `Date.now()` reads, which every step of the call consumes, and a `signal` that aborts at the deadline with a DOMException named `TimeoutError`, or earlier with the caller's own reason.
`deadlineSignal` builds that signal from `AbortSignal.timeout` and `AbortSignal.any`, already aborted for a deadline already past, and refuses with a `RangeError` a deadline that is not finite or lies further ahead than 2147483647 milliseconds.
The signal's timer does not keep a process alive, so nothing relies on it to.

### C-27 (normative): No call starts after its signal aborted or its deadline passed

The host checks each call with `checkCallStart` before it makes it, and refuses it by `call-deadline-passed`, read by time, or by `call-signal-aborted`, thrown with the signal's reason as the error's cause and never as a value of the refusal.
The served host side runs the check on every call before any frame and before C-9 and C-17, so a refused call reaches no provider and leaves the session as it was.
`pumpPage` checks before every pull, and a refusal there is thrown after the source's one close (C-15).

### C-28 (normative): The host stops waiting at the signal, and an abandoned answer keeps its handler

The host waits on a provider's answer with `awaitWithin`: an answer that comes first settles the wait and leaves no listener, and a signal that aborts first rejects the wait at once with its reason.
An abandoned answer keeps a handler that hands its late value or error to the host's late handler once, by reference, which closes what the late answer handed over, every result source included, and logs a late failure by its kind and code, never its text.
A result source runs under the context of the execute call that answered it, so `next` takes no context, and a cancellation a provider answers after the host sent the run's cancel is the run's expected end and is not logged.

### C-29 (informative): What a provider does with the deadline and the signal

A provider derives every driver timeout from `ctx.deadline`, its connect's from the open's deadline, which its engine's connect budget sets (C-55), starts no work on a signal already aborted, and ends its waits when the signal aborts.
It answers `cancelled: false` for a run it does not know, and a result source's pulls honour the context of the execute call that answered it.
A close, and the cancel a stopped wait sends, are called with the host's own `cleanupContext`, never one already aborted (C-47); the kit does not check these yet.

### C-30 (normative): A session without console.cancel is reported as still running, without a call

The host refuses a cancel to a session that does not offer `console.cancel` before the call (C-17), and reports the run as not cancelled, `cancelled: false`, calling nothing.

### C-31 (normative): A throw inside a call fails only that call

An error a provider's call throws reaches the host by reference, and that session and every other session keep serving.
Studio reads it into an error record where the caller answers it.

### C-32 (normative): The SDK keeps sessions apart

The SDK keeps no state across sessions and installs no process handler, since several copies of it share Studio's process (M-19).
The memory transport keeps each served instance's sessions in tables of its own, and each call reaches only its own session's handle.

### C-33 (informative): A provider keeps per-session state in its handle

A provider keeps its per-session state, its connection, statement, cursor, transaction and schema, in the handle `open` answers, never in module scope.
So two sessions opened by two owners exchange no result, handle, error or cached metadata.
The kit's isolation case checks it, and no such case exists yet.

### C-34 (informative): The failure matrix

How a provider's failure ends, by kind and by runtime: Studio's Next.js server, the VS Code extension's backend child under Node.js and under Electron, and the server under Node.js with `--unhandled-rejections=strict`.
Each "Held by" cell names the clause that holds the row, or what will hold it; the kit's fault cases and a measurement under Electron do not exist yet.

| Failure | Next.js server | VS Code child, Node.js | VS Code child, Electron | Node.js, strict | Blast radius | Held by |
|---|---|---|---|---|---|---|
| The loader refuses a package | Starts without its engines | The same | The same | The same | That package's engines | C-105 |
| A package's import throws | Starts without its engines | The same | The same | The same | That package's engines | C-88, C-105 |
| A package's import passes its deadline | Stops waiting and starts without its engines, unless the import is synchronous | The same | The same | The same | That package's engines, or the process | C-88, C-89, C-37, C-105 |
| A synchronous hang, at import or in a call | Every request waits | The same | The same | The same | The process | Only a watchdog outside the process, C-37 |
| A throw inside a call | That call fails | The same | The same | The same | That call | C-31 |
| A detached rejection | Logged, serving goes on | Exit 1, restarted, measured by a probe | Not measured | Exit 70 | None on the server, the process otherwise | C-35, the server's own choice open |
| An uncaught exception in a callback | Exit 70 | Exit 1, restarted, measured by a probe | Not measured | Exit 70 | The process | C-35 |
| A native fault in an addon | Ends on the signal | The same | The same | The same | The process | The kit's fault cases |
| A close that never settles at shutdown | Cut after 15 s, exit 143, where Studio owns the exit | Cut by C-45's deadlines | Cut by C-45's deadlines | As the server | The shutdown | C-36, C-45 |

### C-35 (normative): An uncaught exception stops the server with code 70, and a detached rejection does not

An exception that no code catches stops Studio's server with exit code 70, after one logged line.
A promise rejection that nothing handles does not stop it, unless Node.js runs with `--unhandled-rejections=strict`, which raises the rejection as an uncaught exception, so the server exits with 70 for it too ([DISTRIBUTION.md](../DISTRIBUTION.md#uncaught-errors-and-restarts)).

### C-36 (normative): A close that never settles at shutdown is cut

Where Studio owns the exit, a provider cache close still pending 15 s into the shutdown is cut, and the exit code is 143.
Where Next.js owns the exit, Studio closes no provider.
Inside those 15 s each provider is also cut by C-45's own deadlines.

### C-37 (informative): The import deadline cannot stop synchronous code

The loader's import deadline is a timer in Studio's own thread, so a synchronous loop at import or in a call blocks Studio as it blocks every request.
Only a watchdog outside the process detects a hung process, and the kit's import-time measurement is the check at a package's build.

### C-38 (normative): Classification is core's, and its verdict is a closed set

Core decides whether a statement needs a confirmation, never by a call into a provider, and decides it for a provider package's engine by one check over what its declaration states of its statements, its statement language data (M-85) or its SQL text (S-3), read as its register row grants them (M-87, S-8).
The verdict is one of the members of `ConfirmationVerdict`, and a reader that throws asks for a confirmation.

### C-39 (normative): A protected read path is a precondition of agent and MCP statements

Agent, hand-over and MCP statements reach a provider only as read-only executes on a read-only statement session (C-78), and the plain execute is never the fallback.
A provider without a read-only path serves none of them: for a legacy provider, the read-only statement session's open refuses it by name before anything is called.

### C-40 (normative): One provider kind, and no named provider method

Every package implements the mandatory calls, `console.execute` among them, so no lifecycle-only kind of provider exists.
An implementation key the contract does not define is refused, so a dialog action or a dynamic option is never a provider method of its own.
A host path field is M-12's.

### C-41 (informative): Dialog actions, dynamic options and a provider's classification

If a provider ever needs dialog actions or dynamic select options, both come through one fixed facet call with an action id, whose answer may set only declared fields of their declared types.
If a provider ever answers a classification, it is read from a closed set, and any other answer, an error or a timeout asks for a confirmation.
No such call exists yet, so nothing checks this.

### C-42 (normative): A package depends on no other provider package

No workspace package but the kit imports, in its source or its tests, or declares, in any dependency field of its `package.json`, a name starting `@libredb/provider-` other than `@libredb/provider-sdk` and its own.
The kit, `@libredb/provider-kit`, is admitted only in a package's tests and its `devDependencies`.

### C-43 (normative): A provider depends on no load order

The order of the lock's entries carries no meaning, and no provider is required for Studio to start.
The lock's read and the catalog boot composes answer the same for every order of the same packages (C-106).
With no providers directory set, no package is read.

### C-44 (normative): The host owns each open

The host keeps one open in flight per session key, shared by every concurrent caller, and a caller's wait is ended only by its own signal while the open goes on for the others.
An open that settles after every caller left is admitted exactly once, and an open that a removal or a close of the caches overtook closes what it opened exactly once, admits nothing, and answers its callers that the connection closed while it was opening, outcome not-sent.

### C-45 (normative): Teardown under fixed deadlines

When the host closes its sessions, at a shutdown or when its caches are cleared, it tears each one down under fixed deadlines: an open transaction is rolled back first, waited for at most 5 s, then the session is closed, waited for at most 10 s.
A step that fails or is cut is logged, the next step still runs, and the teardown itself never fails.
Each provider still open at a cut is named, by its connection, its author and Studio's version, and a provider package's session by its connection and its package's name and version.

### C-47 (normative): A cleanup call runs under a context of its own

A cleanup call ends work another call started: a close, the cancel the host sends when it stops waiting for a run, and the end of a run's scope (C-60).
It runs under `cleanupContext`, never under the context of the call it follows, which may have aborted: a deadline `CLEANUP_DEADLINE_MS`, 10 s, after it starts, a signal that aborts only at that deadline, and the reader of the call it follows.

### C-55 (normative): An open ends at its engine's connect budget

Each open has a deadline, its engine's connect budget from the open's start (M-51), at which every caller still waiting is answered that the connection did not open within the budget, a timeout refusal with outcome not-sent, and the next caller of its key starts a new open.
The expired open goes on until its connect settles, then closes what it opened exactly once and admits nothing, a failure it settles with logged as C-44 states.
So a provider that bounds nothing of its own on a server that accepts and never answers keeps its socket until its connect settles.

### C-56 (normative): Test connection answers within its engine's connect budget

A Test Connection has one deadline, its engine's connect budget from the test's start (M-51), over the tunnel's open, the provider's build, its connect, the checks a provider runs only for a test and the health read.
At that deadline the test answers a connection error naming the budget, never a caution or a degraded success.
A provider already connected is closed at once, and one still connecting once its connect settles, since no provider promises a disconnect during its connect.

### C-57 (normative): The transaction facet

`console.transaction` is one console facet, implemented as one function whose request names its action, one of `TRANSACTION_ACTIONS`, and every answer carries `sessionState`, one of `SESSION_STATES`, the session's state after the call:

- `begin` opens a transaction on the session, and may set `requireReportedState`, so a provider that cannot read the transaction state from the server refuses the begin rather than answer a state it guessed, and only a begin's answer may carry `stateReported`;
- `commit` and `rollback` end the transaction, and `state` reads the session state and changes nothing.

A statement inside the transaction is console execute sent with `transaction`, run on the transaction's own connection and answering `sessionState` too, and a statement sent without it runs outside the transaction, on another of the session's connections.
The host reads both answers with `checkTransactionAnswer` and `checkTransactionStatement`, which refuse as `transaction-answer-unreadable` a state that is missing, outside its vocabulary or behind an accessor, a misplaced or mistyped `stateReported`, any other key and an answer that is no plain record, never calling a getter or naming a value.

### C-58 (normative): An unknown session state is never read as closed

A provider answers `unknown` when it cannot tell whether the session holds a transaction, such as after its connection was lost mid-statement, and an aborted transaction block, which accepts only a rollback, is `in-transaction`.
The host keeps no copy of a session state between calls and asks the session on every call, and reads a call it stopped waiting for, or a failed COMMIT, ROLLBACK or statement whose state read fails, as `unknown`.
An unknown state is never read as closed: Studio resolves it only by a later answer or state read once every call it stopped waiting for has settled, and records an end it sees after it as `unknown`, never as rolled back.

### C-60 (normative): A run's scope ends through console.endScope, after the run

The caller that runs statements in a scope mints it, one per request, sends it with every execute of the request, only to a session that offers `console.endScope` (C-9), and ends it once after the run through `console.endScope`, under a cleanup context (C-47).
A provider that offers `console.endScope` keeps the connection that holds a transaction a scope's statements opened to that scope while the transaction is open, and lends it to no other scope or caller, until `endScope` for that scope has answered.
An end that fails is answered in the run's place, and the run's answer says the transaction was rolled back only when the end answered so.

### C-61 (normative): The objects tree facet

`objects.tree` is one object facet, implemented as one function under `objects` whose request names its action, one of `TREE_ACTIONS`, its answer shapes the SDK's object tree types:

- `containers` lists the containers under `parent`, or at the top level when the request sends none, and a top-level listing that answers no container may carry `needsConfiguration`, the provider's sentence, completing "could be listed:", for why its inventory needs configuration the session lacks;
- `count` answers each kind's count of objects in one container: a count, a count from a bounded sample with the provider's sentence for what bounded it, or the engine's sentence for a read that was refused;
- `list` answers one kind's objects in one container, by name and path, with no columns;
- `describe` answers one object's columns, indexes and foreign keys, its indexes the engine's sentence where that read was refused;
- `describeMany` answers the same for every object of one kind in one container in one read, at most `limit` of them when sent, saying so in `truncated` when the read stopped short, and with `defaultSql` each default as SQL text.

A container's path and an object's path are opaque: the host sends each back exactly as it was answered and reads nothing in it.
The facet has no honours list: a provider honours every member of the request its action names (C-63).

### C-62 (informative): A tree answer is read by reference

In process the host reads a tree answer by reference and decides nothing on its values, and Studio answers one that lacks the member its action answers, or carries `needsConfiguration` where C-61 does not allow it, as the provider's defect.
The host's reader that checks a native provider's answer form against its action arrives with the first native provider.

### C-63 (informative): A provider honours every member of a tree request

A provider's `objects.tree` honours every member of the request its action names: it lists the containers under the `parent` it is sent, and stops a `describeMany` read at the `limit` it is sent, saying so in `truncated`, never at a cap of its own it does not state.
No package implements `objects.tree` yet, and neither the host's reader nor a kit case checks this of a package.

### C-66 (normative): The metadata session and the host's session capacity class

The host classes each connection's session capacity, one or several, from Studio's own records and the connection, never from a manifest or a provider, and the class decides only which session a tree read, a monitoring panel read, a health read or a kill runs on.
On a connection of class several, those reads run on a metadata session of the connection's own: an open like the editor's, of the same connection through the same checks, with a smaller `pool` and no role, opened once per key (C-44), torn down with the caches (C-45), and opening nothing until a read asks.
On a server-level connection a read inside one of its databases runs on the catalog session the metadata session opens for that database, and on a connection of class one every such read runs on the editor's session.

### C-67 (normative): The maintenance facets

`maintenance.run` and `maintenance.preview` are the two maintenance facets, each one function under `maintenance`, honouring every member of its request, so neither has an honours list, and no member of either is a claim (M-64):

- `maintenance.run` runs one operation of those the session's engine lists on its target object or session, absent for the whole database, in its container, absent where it names none, each never empty text, and answers whether the engine took it, how long it ran in milliseconds, the engine's sentence and, for an operation whose answer is a table, its rows with their `fields`;
- `maintenance.preview` reads what one per-row operation would do to the object its path addresses, container levels first and the object last, never empty, and answers a summary, the facts it rests on, a refusal where a preflight refuses the operation, and a note on how fresh or exact the facts are.

The host holds each request to the session's maintenance (C-17), and sends `kill`, which its spec places nowhere, with its session target and no placement check.
The engine principal a session acts as, a user name and never any part of a secret, is `open`'s optional `engineUser`, read once at open, which the maintenance audit names.

### C-68 (normative): A session's maintenance is narrowed by what its server accepts

`open` may answer, in its refinement's `maintenance`, the placements its server accepts for the operations its provider measured at open: one item per operation, named once, with whether the server takes it on a row and over the whole database.
`sessionMaintenance` refuses an operation the engine does not list as `refinement-widens`, and answers the engine's maintenance, frozen, with every refused placement withdrawn and every operation left with none removed, adding nothing and changing no label, confirmation, preview or kinds.
The host keeps the narrowed maintenance with the session and holds every run and preview request to it (C-17).

### C-71 (normative): The monitoring facets

`monitoring.panel` and `monitoring.poolStats` are the two monitoring facets, each one function under `monitoring`, honouring every member of its request, so neither has an honours list; no member of either is a claim, and the answer shapes are the SDK's panel and pool statistics types.
`monitoring.panel` reads one panel the session's engine offers, its request naming the panel, a key of `$defs/monitoringPanels`, with the panel's own members, such as a row limit the host resolves or an optional schema, and answers one form whose one key is the panel's own; the host never asks a panel the engine does not offer (C-17).
`monitoring.poolStats` takes no request, makes no round trip to the engine it does not need, and answers the counts of the session's own pool, in all, idle, active and waiting, and the configured ceiling where the provider reports one.

### C-72 (normative): The health call

Every session answers `health`, a mandatory call that takes no request, is no member of `calls`, so no refinement withdraws it, reaches the engine and answers its health in the SDK's health shape.
It answers the count of open connections where the engine can measure it, left out where it cannot and never a zero in its place, the database's size, its cache hit ratio, its slowest queries and its sessions.

### C-78 (normative): The read-only execute

A read-only execute is console execute sent with `readOnly`, a request field a package lists in `honours` (C-5): the statement runs on the session's read-only boundary within the call's deadline (C-26), and `readOnly` carries its budget, the most rows and the most UTF-8 JSON bytes of them it may answer, and its mode, of `READ_ONLY_MODES`, where no mode executes the statement and `estimate-plan` asks for the engine's estimated plan, never running the statement instead.
A provider answers within the budget or refuses and never truncates, an estimating plan held to the bytes alone, applies its page as C-85 states, and, on an engine that bills every read, refuses every statement, since the billed-read allowance stays with the host and no request carries it.
A read-only statement session, opened under a policy with both `readOnly` and `sendsStatements`, takes only read-only executes and is the only session that takes one, which the host holds with `checkReadOnlyRequest` before the call, refusing `request-read-only-not-opened` or `request-read-only-missing` at `/readOnly`.

### C-85 (normative): A read-only execute's page, and MCP's offset paging on the host

A session sent a bounded page, a limit and an offset, applies it before it sends anything and answers `pageApplied` true, or sends a statement that does not apply it and answers `pageApplied` false.
A non-zero offset it does not apply it refuses as `offset-unsupported` before it sends anything, and never answers the first rows as the page the offset names.
No kit checks a native provider's half yet (C-8).

### C-87 (normative): The loader reads only a package entry's default record

The loader imports a package's entry by the `file:` URL of its absolute path and reads only the namespace's `default`, calling none of the package's code in its check and answering a record that passes as the package exported it.
It refuses as `PROVIDER_LOAD_FAILED` a namespace with no `default` (`default-missing`), a default that is not a plain record, an object whose prototype is `Object.prototype` or `null` and so never a Proxy, an array, a function, a class instance or a primitive (`not-a-record`), and a plain record with an own `__esModule` key, whose inner `default` is never read (`interop-wrapper`).
Bun unwraps a CommonJS entry's interop wrapper before the loader reads it, so only an ES module entry reads alike on Node.js, Electron and Bun.

### C-88 (normative): Every import runs under its caller's deadline

The loader runs every import under its caller's deadline, and past it answers `PROVIDER_LOAD_FAILED` with the reason `deadline-passed`, a deadline that cannot stop synchronous code (C-37).
An import that throws, a missing entry file among them, is refused with `import-threw`, the thrown value its `cause` by reference, for the host's log and never for a client, and the refusal's other members carry no text of the error.

### C-89 (normative): A late settle is never answered as loaded

An import that settles after its deadline is never answered as loaded: its success, without its value, or its rejection, with its cause, reaches the caller's late port once, and no rejection is left unhandled.

### C-91 (normative): A package is read from the providers directory only where its lock entry names it

An operator names the providers directory with `LIBREDB_PROVIDERS_DIR`, holding the lock, `providers.lock.json`, written by Studio's command `bun run providers:lock -- --dir <absolute directory>` and never by a package, and each package as `<name>/<version>/`, or `@scope/<name>/<version>/`, the name an npm package name of at most 214 characters and the version an exact version of at most 64.
A package's directory is resolved by real path, a link that stays inside the providers directory followed, and a directory or manifest entry that resolves outside it, or an entry that is not a regular file of the directory, is refused as `PROVIDER_PATH_OUTSIDE`.
No connection's database file or host path may name the providers directory, a path in it or its lock.

### C-92 (normative): An artifact is a tree of regular files with portable names

A package's directory holds only regular files and directories, each named by 1 to 255 letters, digits and `. _ - @ + ~`, at most 10,000 files and 32 levels of directories.
A symbolic link, a junction, a named pipe, a socket or a device anywhere in it, such as the links a package manager writes under `node_modules/.bin`, is refused as `PROVIDER_PATH_OUTSIDE`, and is never followed or opened.
A name outside that set, or more files or levels, is refused as `PROVIDER_DIGEST_MISMATCH`.

### C-93 (normative): Every file of a package is checked against the lock's digest at every read

The lock pins each package by its digest, `sha256:` and the hex SHA-256 of a listing of:

- one line per regular file, sorted by path, `<mode> <hex SHA-256 of the file> <path>` and a newline, the path relative to the package's directory with `/` between names, the mode `755` where the file's owner execute bit is set and `644` otherwise, empty directories not listed;
- then one line per recorded import (C-102), sorted by the module file's path, then specifier, then kind, `import <path of the module file> <specifier> <kind>` and a newline.

Windows reports no execute bit, so a package holding an executable file has another digest there: write the lock on the platform that reads it.
The digest is computed at every read and nothing is kept between reads, so a changed, added, removed or renamed file, an edited import record, and a missing or unreadable directory are each refused as `PROVIDER_DIGEST_MISMATCH` at the next read.

### C-94 (normative): A package's identity is its package.json and its manifest, as its lock entry names them

A package holds `package.json`, at most 1 MiB, and its manifest, `libredb-provider.json`, at most 2 MiB, at the root of its directory, each a UTF-8 JSON object without a byte order mark.
The name and version of its `package.json`, its manifest's engine ids in any order, and its manifest's `runtime.entry` must equal its lock entry's, each difference refused as `PROVIDER_IDENTITY_MISMATCH` naming the field.
A `package.json` or manifest that cannot be read, or whose `engines` or `runtime.entry` is not in its form, is refused naming that file.

### C-95 (normative): A package serves no engine Studio already serves

A package that serves an engine id Studio's bundled catalog serves is refused as `PROVIDER_ID_COLLISION`, so a package never takes over a shipped engine.
Two packages that serve one engine id are both refused as `PROVIDER_ID_COLLISION`, each naming the others by name and version, so the lock's order decides nothing.
Both are read from the lock alone, before any file of the package is read.

### C-96 (normative): A refusal names the package and nothing it holds

Every refusal carries one code of one closed list, `PROVIDER_LOCK_INVALID`, `PROVIDER_PATH_OUTSIDE`, `PROVIDER_DIGEST_MISMATCH`, `PROVIDER_IDENTITY_MISMATCH`, `PROVIDER_ID_COLLISION`, `PROVIDER_CONTRACT_UNSUPPORTED`, `PROVIDER_SCHEMA_INVALID`, `PROVIDER_MODULE_FORMAT`, `PROVIDER_LOAD_FAILED`, `PROVIDER_NATIVE_UNSUPPORTED`, `PROVIDER_RECORD_INVALID` and `PROVIDER_CATALOG_CONFLICT`, and one rule of that code's closed list, in a sentence on one line that names the first of the SDK's schema or record rules, with its manifest pointer, and how many more there are, never a key the package chose.
A package's refusal names the package by its lock entry's name and version, and never a file inside its directory, a value of its `package.json` or manifest, or an engine id, except that a package the lock refuses also carries the engine ids its lock entry names, which the operator wrote (C-107).
No step of the lock's read imports or runs a package's code, and admission imports it only after the checks C-97 orders.

### C-97 (normative): A locked package is admitted in a fixed order, and none of its code runs before its manifest, format, closure and native checks pass

A package that passed its lock is admitted in this order, its first refusal ending it: its manifest's bytes, contract, schema and the SDK's rules (C-98); the engine ids it serves (C-100); its entry's module format (C-101); its TypeScript files and import closure (C-102); native addons (C-103); then its import and its record (C-104).
A package refused before its import runs none of its code, and one refused after it has run its top level but is never registered and serves no engine; the entry module is read by the runtime's loader, not by admission, so the providers directory must be writable only by the operator.
Admission grants no claim, so every claim of a package's engines is read at its restrictive value where no register row grants it, whatever the manifest requests (M-54, M-84).

### C-98 (normative): The manifest is read as bytes, for Studio's contract, by the SDK's validator

Admission reads `libredb-provider.json` as bytes within 2 MiB, never by importing it, and its SHA-256 must be the one the lock's listing holds, or the package is refused as `PROVIDER_DIGEST_MISMATCH`.
A contract of the envelope's form other than Studio's, `0.1`, is refused as `PROVIDER_CONTRACT_UNSUPPORTED` before the schema is applied, naming Studio's contract, not the manifest's.
The SDK's validator then applies the schema and its code rules, a refusal being `PROVIDER_SCHEMA_INVALID`, and the manifest admitted is deep-frozen.

### C-99 (normative): A package's named functions are read for their form only

Admission reads a package's function names for their form only and binds none of them to code, so an engine Studio does not ship is never refused because a table of Studio's lacks its id.
A package's engine gets no SQL writing (S-16).

### C-100 (normative): A package serves no engine another serves, in Studio's catalog or in this process

A package is refused as `PROVIDER_ID_COLLISION`, each case under a rule of its own, when it serves an engine id Studio's bundled catalog serves, an engine id a package registered earlier in the process serves, or an engine id that names a member every JavaScript object inherits, such as `constructor`, and when a package of its name was registered earlier in the process or its name is `@libredb/studio`, the name Studio's bundled engines are served under.
The engine ids and the name are checked before the import and again right before registration, so of two admitted packages the one that would register second is refused, after its import.

### C-101 (normative): The entry is an ES module

The entry is an ES module when its name ends in `.mjs`, or in `.js` and the nearest `package.json` from its directory up to the package's root declares `"type": "module"`, the lookup stopping at a directory named `node_modules` as Node.js's package scope lookup does.
Any other entry is refused as `PROVIDER_MODULE_FORMAT` before the import, and so is one whose nearest `package.json` is over 1 MiB or not a JSON object.
A module's syntax is never read to decide.

### C-102 (normative): Every module of a package imports only what its own directory holds or a built-in

The lock command records, with Bun's transpiler and each with its kind, every static import of every file of the package whose name ends in `.js`, `.mjs` or `.cjs` in any letter case: import declarations, re-exports, and `import()` and `require()` of a string; it refuses a module file it cannot parse or that is not UTF-8, a specifier outside printable ASCII without spaces or over 1,024 characters, more than 4,096 imports, and a lock over 1 MiB.
Before the import, admission refuses:

- as `PROVIDER_MODULE_FORMAT` with the rule `typescript-module`, a package whose listing holds a TypeScript file, `.ts`, `.mts`, `.cts` or `.tsx` in any letter case, declaration files included, since Bun and Node.js can each run one unseen;
- as `PROVIDER_LOAD_FAILED` with the rule `closure-outside`, an import that is neither a built-in of the runtime nor a relative path that stays inside the package's directory and holds no `%`, `?`, `#` or backslash, so every bare specifier, absolute path, URL and subpath import is refused, whatever `node_modules` folder the package holds.

So a package of this contract is a JavaScript bundle whose static imports are relative paths inside it or built-ins; a computed `import()` or `require()`, a directory's `main` and a file loaded by another extension are not checked, and the check is no sandbox, since an admitted package runs in Studio's process.

### C-103 (normative): A native addon is not admitted in this contract yet

A package holding a file whose name ends in `.node`, in any letter case, or whose manifest declares `runtime.native`, is refused as `PROVIDER_NATIVE_UNSUPPORTED` before the import.

### C-104 (normative): The record a package exports is the manifest it declared

A loader refusal is the package's `PROVIDER_LOAD_FAILED` with the loader's reason as its rule, and a value the entry threw is kept for the host's log only.
The record's manifest must equal the manifest file, compared by the own data properties of plain objects and arrays, key order aside, and neither the implementation nor one of its segments may be a Proxy, or the package is refused as `PROVIDER_RECORD_INVALID`, as it is for a refusal of Studio's copy of `checkProviderModule`.
Studio then freezes the implementation and its segments and keeps its own record of them with the manifest it validated.

### C-105 (normative): Boot admits each locked package once, after the host core and before anything is served

On the standalone server the providers directory's packages are admitted once per process, when the server starts and before anything is served, one at a time in package-name order, each import under a deadline of 10 s, and no outcome depends on that order (C-43).
A lock refused as a whole, a set directory that does not exist among them, stops the boot with exit 1 and a line naming the lock and the rule.
Only the packages the catalog's set rules keep (C-106) are registered, each refused package, one whose import settles after its deadline included, is logged once and serves nothing, and a synchronous hang at import blocks the boot (C-37).

### C-106 (normative): The server's engine catalog is Studio's bundled catalog and the admitted packages' engines, composed once

A package never shadows a bundled engine: the server's engine catalog, composed once at boot, answers a bundled engine first, then an admitted package's engine, then an engine only refused packages name, and a process with no boot admission, the published library and the VS Code backend among them, serves the bundled catalog.
A package's engine gets its catalog entry, its connection tables, its field rules and its grants, each claim at its restrictive value where no register row grants it (M-53, M-54), and no SQL writing, connection form, connection string, grammar, migration DDL or generator row, so a request that needs one is refused by name, and a field rule naming a check refuses a field holding a value with core's sentence naming the field.
The set rules over every admitted package, engine id, fence alias, query dialect, tab type and editor language, refuse every claimant as `PROVIDER_CATALOG_CONFLICT` whatever the order, Studio's bundled values the reference and an engine id equal to a bundled fence alias included, naming the package and the rule and no value of its declaration.

### C-107 (normative): A connection of an engine no admitted package serves names why

A connection of an engine only refused packages name in the lock, a package whose directory is missing among them, is refused as `PROVIDER_UNAVAILABLE`, 503, naming every refusal code and never the package, before any cache, tunnel or build.
An admitted package's engine is served by Test Connection and by the query route, its session opening through its package (C-109), and is refused on every other request as `PACKAGE_ENGINE_UNSUPPORTED`, 501, until that request serves package engines.
Both are core's error kinds, `provider-unavailable` and `package-engine-unsupported` (E-1).

### C-109 (normative): A package's open receives only the context core builds

An admitted package's engine opens through the package's own `open`, never through a legacy provider, and `open` receives only the context core builds from the connection, the server catalog's record of the engine and the caller's execution context:

- the engine's id and the connection's id;
- for each field the declaration names, the connection's own value where it sets one, and no other field, no SSH tunnel and no agent credential;
- the connection's TLS settings, for a mode the declaration lists;
- core's egress decision, and core's trust material where the declaration reads it, an empty list otherwise;
- the open policy, core's pool defaults or the owner's share, and a deadline of the open's start plus the engine's connect budget (M-51);
- the package's declared environment (M-22), which every later call of the session is given too.

Before `open` is called, core refuses by name, never by value and with outcome not-sent, a connection it cannot hand a package whole, among them a field value outside the contract's value forms, a TLS mode the declaration does not list, a field the declaration refuses, a required secret left blank, an SSH tunnel that is on, a host path field, a read-only connection, a claim its grants leave refused, and a connection or an execution context that is not plain data.
An answer with no handle is the package's defect, a widening refinement (C-10) is refused with the handle closed under a cleanup context (C-47), and a handle answered after the open's deadline or stop is closed and never used.

### C-111 (normative): Core calls a package's session only for what it offers

A session of a package's engine has a member exactly for each call it offers after its refinement, and each member calls the package's function with the session's handle first.
Core never calls a package for a call its session does not offer, nor with a request field it does not honour, bound params or a non-zero offset among them: each is refused before the call, outcome not-sent.
The host core's execute, cancel on a stop, end of a scope, tree, maintenance, monitoring and health calls run on such a session as on any other.

### C-112 (normative): The client receives no words a package wrote unless a register row grants them

Where no register row grants an engine its own words (M-84), a package's error, from its open, its health read or its execute, reaches the client only as Studio's sentence naming its code, and its warnings only as Studio's sentence naming their count.
The package's own words then go only to the server's log, each error and each warning logged once through core's scrub of the connection, and a refusal of what the package answered is logged as the package's defect: a malformed batch or row, warnings that are not a list or a warning that is not the SDK's `Warning`, or an execution time or row count outside its type.

## Not yet in this contract

These chapters are added by the changes that bring their enforcers:

- The machine redaction a provider declares once built and the object kinds a maintenance spec names, with the object model; and presentation (an icon and a colour).
- The API report of each SDK entry.

## Change notes

These notes are closed until the first published contract.
Until then a change to this document states itself in its commit and its pull request, and the first published contract writes its notes once.
A list every change appends to makes every two open changes conflict, which is why it stays closed.

Against the manifest sketch the design started from:

- The `package` segment is gone: its facts are the package's own `package.json`, M-6.
- `publisher` is never declared, and `drivers` is gone, M-6.
- One `contract` string replaces a contract range and a separate manifest version, under "Contract version" and M-4.
- The runtime segment states the in-process placement only: `entry`, `native` and `env`, M-13.
  Left out: a child entry, isolation and heap settings (the child placement is not in this contract), an egress declaration (core decides egress), a spawn declaration (nothing reads one), a Node range (`package.json` `engines.node` states it), and an optional native package with a fallback (it would choose a weaker path without a word).
- A required `compatibility` list replaces the `upstream` segment, M-14.
- Field names and their classes are the contract's, not a manifest's, M-9.
- The value tags keep the names of Studio's value codec, V-1.
- The error kinds keep the names of Studio's error record, E-1.
- Facet names keep Studio's own vocabulary, the seven monitoring panels, the maintenance operations and the curated agent readings, rather than new dotted names.
- The host's own rules for opening and closing sessions and for the legacy provider interface are clauses of the calls chapter, C-44 to C-46, since the host serves today's providers through them.
- The host core is one instance per process, installed by the process's composition root, C-52, where the sketch named no instance.
- The host core holds the process's page budget, C-53, where the sketch named none.
- The connection dialog's per-field facts, its labels, hints, placeholders, placement, choices, conditions and absent values, are lists of entries that each name their field, rather than maps keyed by field, M-24.
- A condition is one field equal to one value, with no list of values and no combination of conditions in this contract, M-25.
- A `calls` segment declares the package's optional console facets and the request fields its execute honours.
  The sketch's dotted facet list is not adopted for calls, which are keyed by the path to their function.
- A function the manifest names is a name, never code, M-31.
- A refused field carries the sentence core refuses it with, M-38.
- A paste reader is one name for its three operations, claims, names and parse, M-40.
- The order between paste readers stays Studio's, and a manifest states none, M-41.
- An engine's own id is always one of its fence tags, so a manifest lists only its other tags, and the tags of a language several engines speak are the contract's, M-46.
- The explain format a manifest states is the one before a connection is measured, M-48.
- A dialect's tabs are named by the dialect, so a manifest states the name once, M-50.
- An engine's connect budget is a number of milliseconds or null for the host's default, declared in the engine's declaration rather than beside each provider, M-51.
- An engine's SQL grammar row is one segment, `sqlText`, S-3.
- A fact the SDK's grammar type may leave out is written at the reading its absence has, and three facts are null where a reading of their own applies, S-4.
- A trailing limit clause is a pattern's source and flags, S-5.
- An engine's SQL writing row is one segment, `sqlWriting`, S-11.
- A map keyed by type name is a list, the bare spellings as entries and the bare type families grouped by kind, S-12.
- The type vocabulary is a fact of each engine, S-14.
- An engine's migration DDL row is one segment, `migrationDdl`, in one of its two forms, S-17.
- An engine's SQL generator row is one segment, `sqlGenerators`, null where the engine writes Studio's shared forms, S-20.
- An engine's editor language is stated per engine, a console dialect's id being its Monaco id and a dialect-less engine's tab type its query language's, S-23.
- Policy and MCP claims are requests Studio reads as far as its review record or an operator's audited grant allows, never facts a declaration sets alone, M-52 to M-54.
- Read-only enforcement is not declared: Studio derives it from the write reach, M-52.
- The trust material a provider is handed is a connection fact, not a claim, M-56.
- The write reach, file-access posture, single-writer file, agent credential form and masking exemption a built provider restates in its capabilities are read from Studio's records of them, never from the provider, and its catalog sessions are bounded by `OPENS_SERVER_LEVEL_WITHOUT_DATABASE` rather than read from a record, M-57.
- A connection, facets, agent or SQL text fact a gate reads is a claim only where a value loosens the gate on the strength of the provider's behaviour and a restrictive value exists, M-52 to M-54; a query dialect's answers are Studio's, M-50.
- The sketch's frame cap is replaced by the byte budgets, since calls are unframed in process; the memory test transport keeps frames for tests only.
- The agent credential form a manifest requests names the pair `pair` where Studio's record writes null, M-58.
- A masking exemption matches whole column names only, M-59.
- The write paths, the metadata-only answer and the inline edit refusal a provider declares are facts of a `safeguards` segment read back to the provider, and the write reach request is the paths' summary, M-60 to M-62.
- Billed compute is answered per connection and stated by no member, M-63.
- Each maintenance operation's spec is an entry naming its operation, and every operation the maintenance list names has one, M-64.
- A maintenance spec's placements, confirmation and preview are the provider's statements, never claims, and only kill is placed nowhere, M-64 and M-65.
- An engine's agent overlay is a member of its agent segment, its dialect's functions named and its client view derived, never declared, M-67 and M-68.
- Whether a catalog read's statement is a command is the agent overlay's one claim, read from Studio's overlay registry, M-53 and M-69.
- Transactions are one console facet, `transaction`, whose request names its action, and a statement inside a transaction is console execute sent with `transaction`; the sketch named four wire methods and a separate `session/state` read, C-57.
- The object tree is one facet, `objects.tree`, whose request names its action; the sketch named five wire methods, `objects/containers`, `objects/count`, `objects/list`, `objects/describe` and `objects/describeMany`, C-61.
- Maintenance is two facets, `maintenance.run` and `maintenance.preview`, as the sketch named them, and an engine's maintenance is admitted only where its package offers the call that serves it, C-4 and C-67.
- Monitoring is two facets, `monitoring.panel`, one call whose request names the panel, and `monitoring.poolStats`, where the sketch named a facet per panel such as `monitoring.sessions`, C-71.
- Health is the mandatory call `health`, the sketch's `session/health`, C-72.

Against this contract's earlier text:

- A provider may claim not-sent for a failure of its checkout of a connection or session before it sends, E-5, where only `refused-before-send` could.
- A provider may claim not-sent for a call on a held transaction whose session it found ended before it sent anything, by raising `transaction-lost` with `beforeSend`, E-5, and a transaction's begin takes its connection through `checkoutPhase` like a statement.
- The legacy bridge offers `console.transaction` where its provider is a transaction provider, C-50, where it first offered it nowhere.
- C-58 is normative: the host's half of the unknown state arrived with the host's transaction calls, C-58 and C-59.
- A row is measured once on the host's path: the pump hands each pull its own measure and takes the size it recorded for the row a source answers, C-13 to C-16 and C-50, where a source and the pump each measured every row.
- The legacy bridge offers `console.endScope` where its provider ends what its query path left open, and a run's scope ends through it after the run, C-50 and C-60, where the bridge ended the run's open transaction inside its execute.
- A tree read runs on a metadata session of the connection's own where the host's session capacity class is several, C-66, where it shared the editor's session.
- The engine catalog and the connect budget are projections of the declarations, M-15, M-51 and M-70, where Studio kept each in a table of its own.
- An engine's maintenance operation is refused only where its package does not offer `maintenance.run`, C-4, where every one was refused as having no call.
- A connection's maintenance narrowing is the session's refinement, C-68, where no member stated it.
- The connection fields, seed-only fields, refused fields, credential warnings, trust material and connection string answers are projections of the declarations, M-15 and M-71, where Studio kept each in a table of its own.
- A seed's agent credential form follows the agent credential form request, M-55.
- A maintenance run or preview is held to the session's maintenance before the call, C-17 and C-69, where only its facet was.
- The connection form and each engine's display name are projections of the declarations, M-15 and M-72, each named function bound by Studio's function table, where Studio kept each form in a hand-written entry.
- An engine's monitoring panel is refused only where its package does not offer `monitoring.panel`, C-4, where every offered panel was refused as having no call.
- The monitoring and pool-stats routes read through the host core's monitoring calls, C-73 and C-74, where they called the provider's members, and the bridge offers both monitoring facets, C-50.
- The health and fleet health routes and Test Connection read health through the host core's health call, C-73 and C-75, where they called the provider's `getHealth`, and the bridge serves `health`, C-50.
- Health is a mandatory call, C-3 and C-72, where the calls chapter left it out.
- A kill runs on the connection's metadata session where the host's session capacity class is several, C-66 and C-70, where it ran on the editor's.
- One core module evaluates the field rules for the connection dialog and for the test-connection path Test Connection and Save post to, and a field holding null holds no value, M-33, where only the dialog evaluated them and null was a value.
- An engine's TLS offer lists the TLS modes the engine takes, M-73, where it was a word offering every mode of Studio's or none.
- Each engine's connection string is a projection of the declarations, M-15 and M-74, each named function bound by Studio's connection string function table, where each engine kept a row beside its provider.
- Each engine's commit keyword, consent deadline and fence aliases are a projection of the declarations, M-15 and M-75, where each engine kept an execution UI row beside its provider and Studio kept one table of fence tags.
- The hand-over route and the agent runs route wait for their opens within the engine's connect budget and the request's signal, C-77, where they waited for the open alone.
- The agent's curated readings read through the host core's panel and health calls, C-76, each within the time its call was granted, where they called the provider's members with no bound.
- A run whose header predates the engine field, on an engine that does not offer a kind's panel, such as Apache Kafka or SQLite, has that reading refused as a kind its provider does not serve, C-76, where it called the provider's member.
- An engine's agent reading is refused only where its package does not offer the call that serves it, C-4, where every reading was refused as having no call, so `engine-facet-without-call` left the definition rules; a reading whose monitoring panel its engine does not offer is refused, M-76.
- Each engine's query dialect row, its tabs' editor language and that language's accent are a projection of the declarations, M-15 and M-77, where Studio kept a table of dialect rows, a table of tab type languages and an accent beside each language's code.
- Console execute carries a read-only execute, `readOnly`, its rows, bytes and mode, sent only to a session opened under the read-only policy to be sent statements, which takes no other execute, C-78, where the contract's execute carried no read budget, no mode and no read-only session.
- The host core holds every execute to its session's read-only policy, and the legacy bridge serves a provider's read-only statement path as a read-only statement session refused at its open where the provider has none, C-39, C-48 and C-50, where the host had no read-only session.
- A caller whose time refusal is its own reads the host's records through a budget view, C-51, where every call ended at its deadline answered `StudioTimeoutRefusal`.
- The agent's statements run through the host core's read-only execute, C-79, where they called the provider's read-only path through Studio's own timer; a failure after Studio stopped waiting is logged by kind and code, and a later answer is not logged.
- A provider without `queryReadOnly` handed to the agent's statement path is refused at the read-only statement session's open with the acquisition's refusal, C-39 and C-79, where the run threw a plain error.
- The hand-over replay runs through the host core's read-only execute under its request's signal, C-79: a client that leaves while the statement runs is answered at once, and a row larger than one page is refused by the host's page budget, where the replay waited for the statement and answered such a row.
- Each engine's SQL grammar row is composed from its declaration's SQL text, M-15 and M-78, where each row was a module beside its provider, and its redaction is read from `SQL_TEXT_REDACTION`, Studio's hand-written record, M-54; a declared trailing limit clause is anchored as a whole, at its start and at the statement's end, S-6.
- A top-level containers answer that lists no container may say the inventory needs configuration the session lacks, C-61, where a containers answer carried its containers alone.
- The legacy bridge's top-level containers read asks a provider that answers the inventory's configuration question first, and its tree reads take the billed-read allowance from the session's input, C-50, where it asked nothing and passed no allowance.
- The legacy bridge serves a composed statement session that sends the statement exactly as composed, C-50.
- The agent's grounding walk reads through the host core's tree call under one deadline, the time its call was granted, C-80: a walk whose time ends sends no further read and the run counts only the read in flight, where the run stopped waiting and the walk went on reading to its end; a read that fails after the stop is logged by kind and code, where it was released silently.
- Plan mode's statistics read runs through the host core's console execute on a composed statement session, C-80, the statement exactly as composed: its rows are held to the byte budget by each row's UTF-8 JSON bytes summed, where it measured their JSON text's length, a row larger than one page is refused by the host's page budget, and an answer over 1 MiB waits for the host's large-page slot.
- Each engine's SQL writing is a projection of its declaration, M-15 and M-79, its functions bound by Studio's own table, where each engine kept an SQL writing row beside its provider; the export takes a numeric wrapper off only while its capture is a strictly shorter type, S-15.
- MCP's acquisitions hand the factory's open the call's wait, ended by the request's signal or the call's deadline, C-81, where they waited for the open alone within MCP's own race; an open whose only caller was an MCP call that stopped waiting, and that fails afterwards, is logged by the factory's unclaimed-open line, where it was dropped silently.
- Every MCP statement tool's statement runs through the host core's read-only execute under the call's deadline and its request's signal, C-81, where it called the provider's read-only path under MCP's own race; a statement that fails after MCP stopped waiting is logged by kind and code, where it was dropped silently, and an answer over 1 MiB in the host's measure waits for the host's large-page slot.
- A provider without `queryReadOnly` handed to an MCP statement tool is refused at the read-only statement session's open as Studio's profile refusal with its record, C-39 and C-81, where MCP answered its own sentence with no record.
- A value nested deeper than the value codec's bound in an MCP statement's rows is refused as the host measures the rows, at its place in the row read positionally, C-81, where MCP's own encoding refused it at its place under the column's name.
- The legacy bridge measures a bigint beside a cell outside the value codec as its decimal text, C-50, where the measure threw.
- Each engine's migration DDL is a projection of its declaration, M-15 and M-80, its functions bound by Studio's own table, where each engine kept a migration DDL row beside its provider.
- Each SQL engine's generator forms are a projection of its declaration, M-15 and M-81, its functions bound by Studio's own table, where each engine kept a generator row beside its provider.
- The MCP database choice's listing runs through the host core's tree call under the call's deadline and its request's signal, C-82, where it called the provider's `listContainers`; a listing that fails after MCP stopped waiting is logged by kind and code, where it was dropped silently.
- inspect_schema's container listings, relation listings and descriptions run through the host core's tree call under the call's deadline and its request's signal, C-82, where they called the provider's members under MCP's own race; a read that fails after MCP stopped waiting is logged by kind and code, where it was dropped silently.
- A statement tool's database listing on a connection that reaches every database ends at `timeout_ms` and when the client leaves, answered as the timeout or the cancel, C-82, where it waited for the listing with no bound.
- inspect_schema reads the host core before anything else, C-82, so a call made before its install throws by name with no audit record.
- Every policy and MCP gate reads Studio's grant of the claim, the more restrictive of the declaration's request and Studio's review record, M-54 and M-82, where each read the record itself; for every engine Studio ships the grant is the record's row.
- The legacy bridge serves a script unit session that sends a script's unit as the script route always sent it, C-50.
- Every unit of a script of `POST /api/db/multi-query` runs through the host core's console execute under its own deadline and the request's signal, C-83, where the route called the provider itself and waited for each unit without end: a unit that does not answer within its connection's statement timeout plus ten seconds is answered as that unit's error in the editor's sentence, and no further unit starts.
- A request that leaves while a unit of its script runs is answered at once and the script's scope is ended once that unit settles, in the background, C-60 and C-83, where the route waited for the unit and ended the scope before answering.
- A unit's row larger than one page is answered as that unit's byte budget refusal, a unit whose first result passes one batch waits for the host's large-page slot within its deadline, and a value nested past the value codec's depth bound in a unit's first result is that unit's error in the codec's sentence, C-83, where each was answered.
- A connection whose statement timeout is malformed is refused before a script is split or opened, and a script's connection opens within its engine's connect budget and while its request stays, C-83, where the script ran and the open was waited for alone.
- A script's units are sent the script's scope only where the session offers `console.endScope`, and such a provider's script is asked to end none, C-83, where every unit was sent a scope and the end was refused as not offered.
- A unit's failure after Studio stopped waiting for it, and a failed end of a stopped script's scope, are logged by kind and code, C-83.
- The legacy bridge serves a transaction script unit session that sends a unit of the transaction route's script as that route always sent it, C-50.
- Every unit of the transaction route's script runs through the host core's console execute sent with `transaction`, under its own deadline and the request's signal, C-84, where the route called `queryInTransaction` itself and waited for each unit without end: a unit that does not answer within its connection's statement timeout plus ten seconds is answered as that unit's error in the editor's sentence inside the script's answer, no further unit starts, and the transaction and its owner are kept with the state unknown until that unit settles, C-58.
- A request that leaves while a unit of a script inside a transaction runs is answered at once with that unit's cancellation and no further unit is sent, C-84, where every remaining unit ran inside the transaction after the client had gone; the unit in flight goes on in the database.
- A row larger than one page in a unit of a script inside a transaction is that unit's byte budget refusal with the state unknown, a unit whose first result passes one batch waits for the host's large-page slot within its deadline, and a value nested past the value codec's depth bound is that unit's error, C-84, where each was answered.
- A query action of the transaction route whose connection statement timeout is malformed is refused with the query route's sentence before it is gated or opens anything, C-84, where a script ran and one statement failed with the host's deadline error.
- A script inside a transaction whose unit Studio stopped waiting for records its `open` event with the stop's code, and the end found after it is recorded `unknown`, C-58 and C-84.
- A provider whose state read throws right after a unit of a script inside a transaction fails that unit with its error, C-50, where only the read after the script was taken.
- A read-only execute's page is every row or a limit and an offset, and a session sent a bounded page applies it or refuses a non-zero offset it does not apply before it sends anything, C-78 and C-85, where a read-only execute answered every row and the read-only statement session took no offset.
- The legacy bridge's read-only statement session applies a bounded page through the provider's prepare and refuses an offset the prepare did not apply as Studio's own refusal, not-sent, C-50, C-85 and E-5, where the read-only session read no page.
- run_read_query's page is applied by the read-only statement session through the host core, C-81 and C-85, where MCP called the provider's `prepareQuery` itself; an offset the provider does not apply is refused when the statement starts, so a call whose deadline passed or whose request left before then is answered with the timeout or the cancel, and a provider's `offset-unsupported` refusal from its read path is answered as an offset refusal, where it was the engine's error.
