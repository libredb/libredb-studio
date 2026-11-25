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
A clause is normative only when its enforcer exists, so this document never promises what nothing checks.
`tests/unit/provider-contract-clauses.test.ts` fails on a normative clause with no enforcer, on an enforcer that names a missing file, a missing title or a pointer that resolves to nothing, on an enforcer id that is not a clause of this document, on an enforcer listed in this document rather than in the map, and on a clause id used twice.
An id this document no longer holds was a rule of Studio's own mechanics, which a provider package can neither follow nor rely on, and is never reused: `REMOVED_CLAUSES` in the same module names the file that states that rule now.

## Contract version

The contract version is `MAJOR.MINOR`, and this document states contract `0.1`.
A manifest names the contract it was built against in its `contract` key.
While the major is 0, a host admits a manifest built against exactly its own minor.
From major 1, a host admits a manifest built against its own major and a minor no higher than its own.
So the range a manifest declares is never open-ended: a manifest built against a later contract than the host's is refused, never read as the host's.

## Manifest

A provider package carries one manifest, a JSON document the schema states.
The manifest describes what the package serves and how the host loads it.
The package's name, version, licence, Node range and entry metadata live in the package's own `package.json`, the file npm documents for them, and are never repeated in the manifest.

### M-1 (normative): One schema file, loaded by its digest

The manifest schema is one file, and `MANIFEST_SCHEMA_SHA256` in the generated types is the SHA-256 of its bytes.
`compileManifestValidator` hashes the bytes its caller gives it before it reads them, and throws `ManifestSchemaDigestError`, naming both digests, for any other bytes.
So a host, the kit and a test validate against exactly the schema the SDK was built with.
The repository checks the file out with LF line endings on every platform, so the digest is the same on every checkout.

### M-2 (normative): The types are generated from the schema

The manifest's TypeScript types are rendered from the schema by `scripts/generate-manifest-types.ts` and never written by hand.
The generator reads a closed subset of JSON Schema and refuses any other keyword by name, so a type is never wider than the schema it comes from.
After a schema change, `bun run manifest:types` writes the types again.

### M-3 (normative): The schema is closed

Every object the schema defines refuses a key it does not name.
The two exceptions are `vendor`, which holds the package's own keys, and the envelope, which a host reads before it knows which schema applies.

### M-4 (normative): The envelope is read first

A host reads a manifest's envelope, `{ contract }`, before anything else, and the envelope keeps its shape in every contract.
A manifest whose contract is in the form but is not one the host serves is refused as `PROVIDER_CONTRACT_UNSUPPORTED`, naming the contract it declares, and nothing else of it is read.
A manifest with no contract, or one not in the form, is refused with the schema refusal that says so.

### M-5 (normative): Every failure is a named refusal, and no refusal carries a value of the manifest beyond its contract

A manifest the schema does not admit is refused as `PROVIDER_SCHEMA_INVALID`, once per failure, each refusal naming its rule and a JSON Pointer into the manifest, and the key for an unknown or missing one.
The rules are the closed list `SCHEMA_REFUSAL_RULES`, and `refusalSentence` words each in one sentence.
A value that matches none of the shapes a `oneOf` allows is one `no-variant` refusal at its pointer, and the failures of each shape are not reported.
The rules JSON Schema cannot state run only on a manifest the schema admits, each with a rule name of its own.
No refusal and no sentence carries a value of the manifest, except `PROVIDER_CONTRACT_UNSUPPORTED`, which names the contract the manifest declares, a string the envelope holds to the form MAJOR.MINOR.
A sentence quotes a key's name as a JSON string, so a name with a line break or a quote stays one line.
So a refusal can be logged and shown without leaking what a package wrote.

### M-6 (normative): A package's identity is its package.json

The manifest declares no package name, version, licence or publisher, and no driver list.
Name, version, licence and the Node range are the package's `package.json`, and its name and version are compared with the lock entry, C-94.
The publisher is computed from verified provenance and is never declared.
The drivers are the package's `package.json` dependencies and its notices file.

### M-7 (normative): Engine ids

An engine id is a lower-case letter followed by up to 31 lower-case letters or digits, and a manifest declares each of its engines once.

### M-8 (normative): Every engine fact is required

Every fact of an engine declaration is a required key, written as `null`, `false` or an empty list where the engine has none.
So a declaration cannot leave a fact out by omission, and no fact has a default a host fills in.
The connection defaults are the one object whose keys are optional, because each is a value the connection dialog fills in, absent where it fills in nothing.

### M-9 (normative): Connection fields are the contract's vocabulary, and so are their classes

A connection field is named from the contract's closed vocabulary, `fieldName` in the schema.
Each name is in exactly one class, secret, identity or public, and the class is the contract's, the one Studio's storage layer gives the field, never a manifest's.
So no manifest can call a secret field public.
A field name a package needs and the vocabulary lacks is added by a later contract minor, which also states its class.

### M-10 (normative): Every secret field moves the provider cache key

Studio keys the providers it keeps open by the connection, and every field of the secret class is part of that key, whatever a manifest declares.
So a connection whose secret changed is never handed a provider opened under the old one.

### M-11 (normative): The rules of an engine's connection

A refused field is never also one of the engine's fields.
A seed-only field is one of the engine's fields or a seed-only field name of the vocabulary.
A host path field is one of the engine's seed-only fields.

### M-12 (normative): A host path field is admitted by core

A host path field names a file on the host Studio runs on.
Core resolves it and refuses one that names Studio's own storage files before the provider is built, and the provider reads only the absolute path core hands it.
Credential material itself never travels as a path field: a path names where the operator keeps it.

### M-13 (normative): The runtime segment

`runtime.entry` is the package-relative path of the ES module whose default export the loader reads, with no dot segment, so it never names a file outside the package.
A native package is pinned to one exact version, with the platforms it serves, in npm's os, cpu and libc vocabulary, and the Node-API version it is built for.
An environment variable the package reads is declared by name, with the reason it reads it.

### M-14 (normative): Compatibility is a measured claim

A manifest lists the products it was measured against, one entry per product, each naming an engine the manifest declares.
Every declared engine has at least one entry.
An entry claims a range of versions, a list of versions, or a hosted service measured on a date, and lists the versions its tests ran against, each with the image they ran where one exists, pinned by its full SHA-256 digest.
Both ends of a range are tested versions.

### M-17 (normative): A package imports only what it declares

A workspace package's source and tests import their own files, Node built-ins, the names their `package.json` declares and `@libredb/provider-sdk`, and its tests may import a Bun runtime module.
No package imports a path into Studio's own source or out of its own directory, so no package depends on another package's internals.
Studio reaches a package only by its package name, never by a path into `packages/`.
A package depends on no other provider package, C-42.

### M-18 (normative): Package source reads no environment

The source of a provider package, and of the SDK, reads no environment variable, no working directory and no process-global state, and writes nothing to the console.
A provider takes every value from the connection and from what the host passes it.

### M-19 (normative): The SDK keeps no process-global state

The SDK is loaded once into Studio's process and shared by every provider, so its source declares no module-level `let` or `var`, creates no module-level collection, and never reads `process`.
Each call that compiles a validator builds its own, and two validators share nothing.
A module-level typed array is listed by file and name: the codec's two lookup tables, which nothing writes after load, and its encode buffer, which each call writes before it reads, so no call reads what another left.

### M-20 (informative): Studio never reads `vendor`

`vendor` is the package's own, and no step of Studio reads a vendor key.
Admission compares the whole manifest with the record's and freezes it, vendor included, C-98 and C-104, and nothing reads what it holds.

### M-21 (informative): How a host admits a contract

Admission applies the version rule under "Contract version" while the major is 0, C-98: a manifest built against any contract but Studio's own is refused before the schema is applied.
The rule for major 1 and later is applied by the first host of a contract 1.x; until then the validator serves exactly one contract, the one its schema names, and refuses every other.

### M-22 (normative): How a package reads its declared environment

A package declares the environment variables it reads in `runtime.env`, so every setting it reads is listable before its code runs.
It reads one only through `ctx.env.get`, which `envReader` builds over the declared names and a function the host passes to read the process environment.
A declared name answers what the host's function reads; any other name is refused by name with an `UndeclaredEnvironmentError`, and the host's function is never called for it.
There is no denylist and no grant: a package reads what Studio's own process reads.

### M-23 (informative): The validator compiles code

ajv compiles a schema into a JavaScript function, built with `new Function`.
The validator runs on the server and in the kit, never in a browser, so a content security policy there does not apply to it.

### M-24 (normative): A field's label, hint and placeholder

An engine may give any field it takes a label, a hint and a placeholder, each in `connection.dialog`, in a list of entries that each name their field.
A field with no entry keeps Studio's own word: its own label, no hint, and its own example.
An empty placeholder means the field shows no example, which is not the same as having no entry.
Each entry names a field the engine takes, and a list names a field at most once.

### M-25 (normative): A field shown under a condition

A field may be drawn only while one other field equals one value, never a list of values or a combination of conditions.
The field a condition reads has no condition of its own, so whether a field is shown never depends on another hidden field.
Where the field read is a select, the value is one of its choices.
A field hidden by its condition is neither drawn nor saved, and core does not require it.
A connection that leaves the field a condition reads absent is read as that field's absent value, which every select a condition reads declares, and an absent value is declared only for a field a condition reads.

### M-26 (normative): Where a placeable field is drawn

Every placeable field an engine takes is placed, `open` with the other fields or `advanced` behind Advanced, and only a placeable field is placed.
The placeable fields are the contract's vocabulary, `placeableFieldName` in the schema.

### M-27 (normative): A select's choices

Every select field an engine takes declares its choices, in the order the dialog lists them, each with the value saved and the label drawn, and no two choices of a field share a value.
Only a select field declares choices, and the select fields are the contract's vocabulary, `selectFieldName` in the schema.

### M-28 (normative): The dialog's order

An engine may state the order the dialog draws its fields in, naming each field once and only fields it takes.
The fields the order leaves out are drawn after it, and `null` keeps the dialog's own order.

### M-29 (normative): The Host box's URI schemes

An engine may let its Host box take a pasted `http` or `https` address, which the dialog splits into its host and port.
`connection.hostUriSchemes` lists the schemes in the order the box's refusal names them, and only an engine that takes a `host` field lists any.

### M-30 (normative): Credential warnings

An engine may warn about a credential in three kinds: `pair`, a published default user and password; `jwt`, a token in the password field that declares no expiry or an access claim named; and `no-secret`, a server that accepts a connection with no password.
Studio frames each warning's sentence with its own words, and reads one record of them both in the connection dialog and when it loads a seed file, where a read-only seed with a declared pair, or without a password where a `no-secret` warning is declared, is refused.
An engine declares at most one `no-secret` warning, and each warning reads only fields the engine takes.

### M-31 (normative): A function is named, never carried

The manifest holds no code: where an engine has a function, its declaration names it, and the package exports it.
A name is a lower-case letter followed by up to 63 letters or digits, `functionName` in the schema, and it is local to its engine, so two engines of one package may each have a function of one name.
A package names its functions freely.
Studio's own declarations name each function by the slot it fills: `<field>Check` for a field rule's check, `hostHint`, `hostIdentity`, `importer` for the connection import, `urlTls`, `pasteReader` and `seedCheck` for the connection string's URL TLS reader, paste reader and seed check, `redactionReader` for a command redaction's reader, `formatSegment` and `readQuotedQualifier` for the completion readers, and, for the SQL writing functions, `escapeLiteral`, `unescapeLiteral`, `quoteIdentifier`, `placeholder`, `temporalLiteral`, `insertDocuments`, `boundEdit`, `binaryLiteral`, `rewriteDeclared`, `declareFromSample`, `typedLiteral`, `columnWriters` and `createTableKeyClause` for the create table key's clause, and, for the migration DDL functions, `createTablePrimaryKey` and `createTableForeignKey` for a written CREATE TABLE's key writers, `createTableRefusal` for a refused one's line, `columnDef`, `createIndex`, `dropIndex`, `addForeignKey`, `dropForeignKey`, `addColumn`, `dropColumn`, `modifyColumn` and `dropTable`, and, for the SQL generator forms, `generatorQuote`, `generatorTable`, `generatorSelect` and `generatorSelectList`, and, for the agent overlay, `catalogColumns`, `catalogRelations`, `catalogIndexes` and `catalogStatistics` for the catalog read's composers, `declaredSchema`, `retryMatches`, `retryRewrite` and `mapRows`, `emailShapeTest` and `digitRunShapeTest` for a profile's shape tests, `statisticsBuild`, `captureBuild` and `groundingOverride`.
Studio's census holds every name its declarations give to the very function Studio runs, by identity and never by the function's own name, and finds no function Studio runs that a declaration does not name.
A name in an engine's connection form is bound by Studio's function table, `CONNECTION_FORM_FUNCTIONS` in `src/lib/db/connection-form.ts`, to the function Studio's own source holds for that engine at that slot, M-72, and the table holds exactly the names the committed declarations give.
A name in an engine's connection string is bound the same way by Studio's connection string function table, `CONNECTION_STRING_FUNCTIONS` in `src/lib/db/connection-string/index.ts`, M-74, which holds exactly the names the committed declarations give.
A name in an engine's SQL writing is bound the same way by Studio's SQL writing function table, `SQL_WRITING_FUNCTIONS` in `src/lib/db/sql-writing/index.ts`, M-79, one table per slot, which holds exactly the names the committed declarations give.
A name in an engine's migration DDL is bound the same way by Studio's migration DDL function table, `MIGRATION_DDL_FUNCTIONS` in `src/lib/db/migration-ddl/index.ts`, M-80, and a name in its SQL generator forms by `SQL_GENERATOR_FUNCTIONS` in `src/lib/db/query-generators/index.ts`, M-81, one table per slot, each holding exactly the names the committed declarations give.
Every such table looks a name up through one helper, `src/lib/db/function-table.ts`, so each refuses a name it holds no function for in one sentence.

### M-32 (informative): How a package's named functions are found and called

A package will export its named functions in one table, which the SDK's definition step checks against the names its manifest gives.
The host will call a named function through that table by its name, through one fixed entry point, never as a provider method of its own per function.
No package function runs in a browser, so Studio calls a named check, hint or identity reader on its server.
Nothing resolves a package's names yet: until the definition step does, Studio runs its own functions, which its census holds to their names.
Where an engine names no identity reader, Studio reads a Host text's identity as the text trimmed and lower-cased.
Studio's own source holds every named check, hint and identity reader the engines it ships name, and the connection dialog calls each in the browser: the hint on each render of the Host box, the identity on a paste, and the check before Test Connection and Save.
The test-connection path that Test Connection and Save post to runs the same check again on the server, through the same module, M-33.
Composing a connection form refuses by name any function name Studio holds no function for at its slot, M-72, so no form binds a function only a package holds.
Studio's own source holds every paste reader, URL TLS reader and import the engines it ships name, and the connection dialog calls each in the browser, so neither a pasted connection string nor a pasted kubeconfig reaches the server before Test Connection or Save.
Composing a connection string refuses by name any function name Studio holds no function for at its slot, M-74, so no package reader runs in a browser.
Where a package's paste reader, URL TLS reader, seed check or import runs is decided with the first package that names one.
A package's named check will be answered by the route that Test Connection and Save post to, never on a keystroke, and the dialog will draw no hint from a package and read a Host text's identity as the default above, the text trimmed and lower-cased.

### M-33 (normative): Field rules

An engine may give a field it takes one rule, in `connection.fieldRules`, and a rule states at least one check: `required`, `format`, `charRange` or a named `check`.
The dialog checks the fields in the order of `connection.fields`, so the order of the rules carries no meaning, and it answers the first refusal it meets.
On each field it reads `required` first, which refuses a blank field, then, only for a field that is not blank, `format`, `charRange` and `check`, in that order.
A field hidden by its condition is not checked.
A field is blank when it holds no value, being absent or null, or an empty one; a secret field is also blank when its value is not text or holds only whitespace.
One core module evaluates the rules: the connection dialog before Test Connection and Save send anything, and the test-connection path both post to, before it opens a tunnel or builds a provider, so the two refuse exactly the same connections with the same sentence, and the path answers a refusal as a configuration error whose statement was not sent.
A rule takes every value its engine's provider takes, so Test Connection never refuses a connection the editor opens.
Core refuses a connection that leaves a shown required secret blank before it builds a provider, with that rule's sentence, and the provider checks again when it connects, because a seed opened in the editor, an agent's or MCP's connection and an API call never pass the dialog or the test-connection path.

### M-34 (normative): A bounded pattern

A field rule's format is a bounded pattern: a regular expression's `source`, of 1 to 512 characters, and its `flags`, the empty string or `u`.
The pattern compiles as JavaScript's `RegExp` reads it, with its flags.
A value is tested with `RegExp.prototype.test`, which matches anywhere in it, so a pattern that must match the whole value writes `^` and `$` itself.
The flags `g` and `y` are left out because they make `test` remember where it stopped.

### M-35 (informative): Backtracking is not checked yet

A pattern's author keeps it free of catastrophic backtracking, but the validator of this contract does not check it.
Every pattern Studio declares is, by its census, the source and flags of a pattern its dialog runs today, and each was measured to run in time linear in the length of its input.
No package Studio does not ship is admitted before contract 1.0, and a regular expression analyzer will check every pattern before one is.

### M-36 (normative): The Host text readers

An engine may name a host hint, `connection.hostHint`, which answers from the text in the Host box a sentence the dialog draws in place of the static Host hint while it answers one.
An engine may name a host identity, `connection.hostIdentity`, which answers the server a Host text names, so the dialog tells whether a pasted connection string names the server already in the box or another one, whose credentials it then drops.
Only an engine that takes a `host` field names either.

### M-37 (normative): The connection import

An engine may offer an import, `connection.import`: the label of the dialog's import action and an importer, a named function that reads a pasted text into entries, one of which fills the form.
The importer never throws, and none of its sentences quotes the text it reads.
The dialog offers the import only for a new connection, never while it edits a saved one.

### M-38 (normative): A refused field's sentence

Each entry of `connection.refused` names a field the engine refuses and the sentence core refuses a connection that sets it with, which names the field and never its value.
Core refuses a connection that sets a refused field before it builds any provider, with the sentence of the first such field in the order of the list, so no provider receives one.
A field is set when the connection holds it with a value other than nothing, null and the empty string, and a list names a field at most once.

### M-39 (normative): A connection string's scheme

An engine may state, in `connection.connectionString.scheme`, the one URI scheme shown for it, written in lower case as a URI scheme.
Only an engine whose connection string names a paste reader states a scheme, so every scheme shown is one a paste of it reads.
Studio's map of engine schemes is the schemes the declarations state.

### M-40 (normative): The paste reader

An engine may read a connection string pasted into the dialog's Paste URL box, and states how in `connection.connectionString.paste`.
The paste names one reader, a function name for three operations.
`claims` answers whether the reader reads a paste, given the paste trimmed with its scheme lower-cased and every character after `://` as typed.
`names` answers whether the paste, trimmed and lower-cased whole, is a spelling the engine connects with, which can be fewer than it claims.
`parse` answers the form's fields, or a refusal naming what to paste instead, and it reads only a text `claims` accepted.
The paste states whether its reader is a catch-all, one that claims generic transport schemes other readers may claim on their own hosts.
The paste states the formats the Paste URL box names for the engine, at least one and each once, and only forms `parse` connects with.
The box lists the formats of every engine in the order the engine picker lists the engines.

### M-41 (normative): The order between paste readers is Studio's

Studio offers a paste to the paste readers in one order it keeps, and the first reader that claims the paste parses it.
Every catch-all reader comes after every other reader.
Studio declares each pair of readers that may both claim a text, with a text both claim, and the order decides which of the two reads it.
A manifest states no order and no pair: one package's claim about another package's spelling is not its to make.

### M-42 (normative): The URL TLS reader

An engine may name, in `connection.connectionString.urlTls`, a reader of the TLS a URL's query carries.
It reads the query into a TLS mode the connection form can hold, or keeps the parameter as written where no mode expresses it.
It never answers a weaker mode than the engine's own driver applies to the same URL, and never falls to `disable` on a value it does not recognise.
Only an engine whose connection string names a paste reader names one, and that paste reader is what calls it.

### M-43 (normative): The seed check

An engine may name, in `connection.connectionString.seedCheck`, a check Studio runs when it loads a seed file.
Studio runs it on the fields the file writes for a connection of the engine, before any socket.
The check leaves a field written as a reference unjudged.
Each refusal it answers names a field and a sentence that never quotes the field's value, and Studio refuses the file naming the connection and the field.

### M-44 (normative): The commit keyword

An engine states, in `editor.commitKeyword`, the one word that keeps an open transaction on it.
When a statement left a transaction open and Studio rolled it back, the notice Studio shows names this keyword, so it tells the user a command their engine has.

### M-45 (normative): The consent deadline

An engine whose long read ends differently from the others states, in `editor.consentDeadline`, the chip and the sentence the agent's consent card shows for it, and every other engine states null.
The chip is a label in the card's bounds row, and the sentence is the paragraph under the card's box.

### M-46 (normative): Fence tags

A markdown fence tag tells Studio what a fenced block a model wrote holds, and Studio reads a tag lower-cased.
An engine's id is always a fence tag naming that engine, so a manifest never lists it.
An engine lists its other tags in `editor.fenceAliases`.
A tag names at most one engine: an alias is never an engine id of its manifest and is never declared by two of its engines, and across the admitted set Studio's projection refuses the same, M-75.
A generic fence tag is the tag of a language several engines speak; the schema's `genericFenceTag` lists them, and an alias is never one.
An untagged fence and a generic tag hold a query and name no engine, so neither contradicts a connection.

### M-47 (informative): Fence tags across packages

Within one manifest the validator refuses an alias two of its engines declare or one equal to one of its engine ids, M-46.
Across the admitted set the fence alias projection refuses both, M-75, so an alias another admitted declaration states, or one equal to another admitted engine id, never reaches a reader.

### M-48 (normative): The explain format

An engine states, in `editor.explainFormat`, the format of its query plans, one of Studio's explain strategies, or null where it offers no explain.
The format stated is the one the provider declares for a connection it has not connected, the one Studio reads before it connects.
Studio's generator reads it in an empty environment with no `.env` file loaded, so a variable that changes what a provider declares, such as `FIRESTORE_EMULATOR_HOST`, never changes a committed declaration.
Studio reads a plan with that format's strategy.

### M-49 (informative): A format measured at connect

A provider may answer another format of the vocabulary, or none, for a connection it measures at connect or configures otherwise, such as a server whose grammar lacks the declared form or an emulator.
No manifest fact states that answer yet, and Studio reads it from the connected provider.

### M-50 (normative): The query dialect

An engine states, in `editor.dialect`, null or one of Studio's query dialects with the answers of its row: whether Profile, the code generator, Generate Count Query and the SQL export formats are offered, and the command-line flags whose values query history never keeps.
The editor opens the engine's tabs under the dialect's name, so a manifest states the name once.
Studio's dialect rows are the projection of the declarations' rows, M-77, every declaration of one dialect stating one row.

### M-51 (normative): The connect budget

An engine states, in `connection.connectBudgetMs`, how long the host waits for an open of the engine and for its Test connection, in milliseconds from the open's start.
The budget is a whole number from 30,000 to 300,000, or null where the engine takes the host's default, `DEFAULT_CONNECT_BUDGET_MS`, 70,000, which `@libredb/provider-sdk/calls` exports.
The minimum is an SSH tunnel's 20 s handshake bound plus 10 s for the connect, so no budget ends an open before a legitimate tunnel could open; the maximum bounds the longest any caller waits for an open to five minutes.
An engine states a budget of its own when its own connect bound at Studio's default statement timeout, plus 10 s for its answer to arrive, is longer than the default, so a provider that bounds its connect answers in its own words before the host does.
Studio's budget for each engine it ships is authored in the engine's declaration, M-15, and read through the engine catalog, M-70.

### M-52 (normative): Claims are requests

An engine states in `policy` and `mcp`, and in the members of its other segments M-53 names, what it asks of the gates Studio decides before or around a provider.
Each such member is a claim: a request, never a fact Studio believes as declared.
A declared fact is a claim when a gate Studio decides reads it, a value lets that gate pass what another value stops on the strength of what the provider or the engine does, and it has a restrictive value; any other declared fact is not a claim.
A fact whose values only add to what a gate stops, from an open-ended vocabulary, such as a credential warning, has no restrictive value and is not a claim, and where it is absent the gate answers at core's own default.
Studio's review record of each claim is a table of Studio's source, except the confirmation gate's claims, whose record is `CONFIRMATION_CLAIM_REVIEW` (S-8).
A declaration authors its policy and MCP claims, M-15, and every gate reads each of them only as Studio's grant of it, M-54, which the grant reader `src/lib/db/claim-grants.ts`, the one module that reads their records, computes, M-82.
A declaration authors its connection claims too, and every gate reads each of them only as Studio's grant of it, which the same grant reader computes, M-83.
A declaration authors its agent mode claims, `facets.agentReadings` and `agent.statementLanguage`, too, and every gate reads each of them only as Studio's grant of it, which the same grant reader computes, M-83.
Each SQL text claim and each claim of the agent overlay is generated into the declaration from its record, and every gate reads that record.
Each per-engine record of a claim Studio keeps in core is written by hand, a literal never computed, so no projection of the declarations can feed one; `CONFIRMATION_CLAIM_REVIEW` is written by hand too.
Only the modules `tests/unit/db/engine-declaration-readers.test.ts` lists read a declaration or a projection of the declarations, and none of them reads a claim but the modules its `CLAIM_READERS` lists, the claim projection and its generated module, which carry the policy, MCP, connection and agent mode requests as declared, and the grant reader, which grants them, M-82 and M-83; no member a declaration authors is a claim, M-15, but the policy, MCP, connection and agent mode claims and the confirmation gate's two, `sqlText.readsSqlText` and an exempt form, which the gate counts only where `CONFIRMATION_CLAIM_REVIEW` lists them, S-8, so a declared claim alone never reaches a gate.
For every engine Studio ships, each request is its record's row.
Read-only enforcement is no member: Studio keeps a connection's read-only mode wherever the write reach is not `open`.
The engines agent and MCP statements run on are Studio's record alone, C-39, and S-8 applies the same rule to the confirmation gate's claims.

### M-53 (normative): The restrictive value of each claim

Each claim has a restrictive value, the answer under which the gates that read it refuse, withhold or keep apart the most.
`writeReach`: `open`, under which read-only mode is refused, the reach ordered `open`, `guarded`, `none` from the most restrictive.
`readsFileAccessPosture`: true, so a denied handle and a full-reach one never share a cached provider or a borrowed handle.
`deniedFileAccessRefusal`: a refusal, so every caller whose file access is denied is refused.
`singleWriterFile`: false, so each user of a connection keeps a provider of their own.
`readRootsRequired`: true.
`exposable` and `statementRead`: false.
`metadataReadChangesState`: true, so the metadata tool is not marked read-only.
`agentCredentialRequired`: true.
`connection.opensLocalFile`: true, so core admits the file the connection names, a governance source never grants the engine, and an untrusted VS Code workspace opens none; its record is `OPENS_LOCAL_FILE`.
`connection.hostPathFields`: every host path field among the engine's seed-only fields, so core admits each before the provider reads it; its record is `HOST_PATH_FIELDS`.
`connection.serverLevelWithoutDatabase`: read per gate, M-54: at governance admission true, so a definition that names no database is never granted, and at the choice of database false, so a caller's choice of database is never honoured, M-57; its record is `OPENS_SERVER_LEVEL_WITHOUT_DATABASE`.
`connection.sshTunnel`: refused, so a connection whose tunnel is on is refused before any cache lookup or dial; its record is `SSH_TUNNEL_REFUSAL`.
`connection.agentCredential`: null, so a seed's agent credential is refused at load; its record is `SEED_AGENT_CREDENTIAL`.
`agent.statementLanguage`: null, so no statement workflow opens in agent mode and MCP serves no statement on the engine; its record is `AGENT_STATEMENT_LANGUAGE`.
`facets.agentReadings`: empty, so the operations workflow does not open in agent mode and every reading is refused before a provider is acquired; its record is the `agentReadings` of the engine's `ENGINE_FACETS` row.
`sqlText.redaction`: `none`, so the query event log keeps nothing of the statement's text; its record is `SQL_TEXT_REDACTION`.
`policy.agentCredentialForm`: `none`, so every agent credential is refused at every agent acquisition; its record is `AGENT_CREDENTIAL_FORM`, whose null row a declaration writes `pair`.
`policy.maskingExemptColumns`: null, so every column the masking rules match stays masked; its record is `MASKING_EXEMPT_COLUMNS`.
`agent.overlay.dialect.catalogRead.commandShaped`: false, so the statement fence admits no composed catalog command and refuses it as it refuses the model's; its record is the engine's server overlay in Studio's agent overlay registry.
Every restrictive value is a request the schema admits.

### M-54 (normative): How a host grants a claim

A host reads each claim as the more restrictive of the manifest's request and the grant.
The grant is the row of Studio's review record for the engine, or an operator's audited grant for the package, and the claim's restrictive value, M-53, where neither exists.
An operator's audited grant of a masking exemption names the protected column names the exemption reaches.
So a restrictive request is read as made, a looser one only as far as a grant allows, and a declared claim alone never loosens a gate.
A record's row is the engine's own property of the record, so a key the record inherits is no row.
A write reach request is capped at the grant: a request of `none` on an engine whose record grants `guarded` is read as `guarded`, and any request on an engine with no grant is read as `open`.
Studio keeps a connection's read-only mode exactly where the granted write reach is not `open`.
A claim whose restrictive value is true, `readsFileAccessPosture`, `readRootsRequired`, `metadataReadChangesState` and `agentCredentialRequired`, is read as true where the request or the grant is true; one whose restrictive value is false, `exposable` and `statementRead`, is read as true only where both are.
A denied file access refusal that is requested keeps its own sentence, one offered against a refusing grant takes the record's sentence, and one offered where no grant exists takes the host's own sentence.
A single-writer file request is read as its grant where it equals the grant, false where no grant exists; any other request leaves the engine refused by name at every open, before any cache lookup, tunnel or build, since a second read-write handle on one file and one handle shared between users both overreach.
The agent credential form's record writes the pair form as null, and a request of `pair` equals that row.
A request value outside its claim's vocabulary is refused by name, naming the claim and the engine.
A set of things a gate admits, refuses or keeps apart, `connection.hostPathFields`, is read as the union of the request and the grant, and a set of things a gate offers, `facets.agentReadings`, as their intersection.
A claim two gates read with opposite restrictive values, `connection.serverLevelWithoutDatabase`, is granted per gate: as a claim restrictive when true where one gate refuses on true, and as one restrictive when false where the other honours only on true.
A claim whose values M-53 does not order, such as two statement languages, two agent credential forms or two redactions other than `none`, is read as its grant where the request equals it, and at its restrictive value otherwise.
An SSH tunnel request that is refused keeps its own sentence, a request offered against a refused grant takes the record's sentence, and one offered where no grant exists takes the host's own sentence.
A record whose rows are declared beside each provider or engine in Studio's source, `ENGINE_FACETS` and the agent overlay registry, is Studio's review record while those rows are outside any provider package.
The `sqlText.redaction` row is kept in `SQL_TEXT_REDACTION`, a core record keyed by the engine and written by hand, its command reader held by name and bound through Studio's grammar function table, since Studio's SQL grammar is projected from the declarations, M-78.
The change that moves a provider whose row records a claim into a package, or the first change that makes Studio read that claim from a declaration, whichever comes first, keeps the claim's row in a core record keyed by the engine, so a package never carries its own grant.
Studio reads the policy and MCP claims, M-82, and the connection and agent mode claims, M-83, from the admitted declarations through its grant reader by these rules; the agent overlay's claims and the SQL text claims are not read from a declaration yet, M-52, and the change that first reads one applies this clause to it and extends its enforcer.

### M-55 (normative): The rules of an engine's claims

A statement read is claimed only for an engine its MCP claims expose.
An agent credential is required only of an engine whose seeds take one, `connection.agentCredential`.
An agent credential a seed takes is in the form the agent credential form request names, M-58: for the pair request, the seed form `pair`, an `agentUser` and an `agentPassword` together; for the dedicated user's request, the seed form `dedicated-pair`, an `agentUser` and an `agentPassword` together whose `agentUser` is not the connection's own `user`, compared without case or surrounding space where neither is written as a reference; and for the token and service-account key requests, the seed form `secret`, an `agentPassword` alone with no `agentUser`.
A request of `none` refuses every agent acquisition, so it is held to no seed form.
Read roots are required only of an engine whose seed-only fields name `agentReadRoots`.
A denied file access refusal is stated only for an engine that reads the file-access posture.
The rules check requests, never a host's reading of them: a request of every policy and MCP claim at its restrictive value meets them where the engine's connection allows it.
An engine a host reads as requiring an agent credential it takes none of is closed to MCP: Studio's grant of `exposable` is false where its grant of `agentCredentialRequired` is true and either its grant of `connection.agentCredential` is null or its grant of `policy.agentCredentialForm` is `none`, which refuses every agent acquisition, M-54.

### M-56 (normative): The trust material a provider is handed

An engine whose provider's TLS library does not read Node.js's trust store states `connection.readsTrustMaterial: true`, and its provider is handed the CA certificates of the file `NODE_EXTRA_CA_CERTS` names, as data.
Every other engine states false and is handed nothing.
No gate reads it, the material is the operator's public certificates, and a provider that needs it and does not ask fails to verify, never verifies less, so it is not a claim.

### M-58 (normative): The agent credential form an engine requests

`policy.agentCredentialForm` is one of the forms Studio's agent credential takes, with `pair` for the user and password together, the form Studio's record writes null.
The secret-only forms and the dedicated user's are the record's own forms, named as the record names them.
Every agent acquisition reads Studio's grant of the request, M-57, which is the more restrictive of the request and Studio's record, M-54.

### M-59 (normative): A masking exemption matches whole column names only

The column pattern of `policy.maskingExemptColumns` opens with `^`, closes with a `$` no backslash escapes and no character class holds, keeps every alternative inside a group, and compiles with no flag, the way Studio's masking compiles it.
An unanchored pattern reaches columns other masking rules cover, so an exemption written for one column crosses into a rule it was never about.
The pattern is read as text and never run, so a pattern anchored in each alternative, such as `^a$|^b$`, is refused for the group form `^(?:a|b)$`, which says the same once.

### M-60 (normative): An engine's safeguards are its provider's own statements

The `safeguards` segment states what the provider's code does: the reach of each write path, the metadata-only answer of its read path, and the result columns its inline editor refuses.
No gate of Studio reads a safeguard, so none is a claim, M-52, and a review reads them as the evidence of the policy claims.
The segment is authored, M-15, beside the policy claims whose write reach summarizes it, M-61, and never projected, since nothing in Studio reads it.
For every engine Studio ships, the census reads each safeguard back to the provider's own capabilities.
A provider that declares no write reach is stated open on every path, the reading Studio gives that absence.
A fact a provider answers only for a connection, or one that waits for a chapter not yet in this contract, is not a member.

### M-61 (normative): The write paths and the write reach they sum to

Each of the four write paths is absent, gated with the gate that refuses every write there while read-only mode holds, or open.
An absent editor path names the structural proof that keeps it so.
A gate or a proof names a module by its path relative to the root of the package declaring the engine, under `src/`, with no dot segment and ending in `.ts`, and an export by its name.
`policy.writeReach` is the summary of the paths: `open` where any path is open, else `guarded` where any is gated, else `none`.
A request at M-55's restrictive values meets this rule only where the write paths still sum to its write reach.

### M-62 (normative): The metadata-only answer and the inline edit refusal

`metadataOnly` lists each operation the metadata-only read permits, once, in the provider's order, with its columns, each once within its operation, and the kind of fact each holds; it is null where the provider answers as it reads.
`inlineEditRefusedColumns` is a type pattern that compiles with no flag, the way the inline editor compiles it, and the reason a refused cell shows, or null.

### M-63 (informative): Facts a provider answers per connection

Whether a request resumes compute the engine bills for, `resumesBilledCompute`, is the provider's answer for each connection, read from the built provider for that connection.
Its loose value spends the operator's compute, which none of the boundaries a claim protects is, and the answer depends on the connection, so it is no claim and no member states it, as M-49 leaves a measured explain format to the connected provider.

### M-64 (normative): An engine's maintenance specs

`facets.maintenanceSpecs` holds one spec for each operation `facets.maintenance` lists, and no other.
A spec states the operation it names, the label its controls show, whether it runs on one object a row names, whether it runs over the whole database, a card's title and description or null, the typed confirmation it asks or null, whether a per-row control previews it, and the object kinds a per-row control offers it on, or null for every relation kind.
A list of entries that each name their operation states what Studio's capabilities state as a map keyed by operation.
For every engine Studio ships, the census reads each spec back to the provider's own declaration before it connects, and Studio's maintenance gate answers from the declaration what it answers from the provider.
No member of a spec is a claim, M-52: the maintenance routes read the placements only to refuse a request in a form the provider says it does not take, every maintenance request is an administrator's, and a typed confirmation only adds a step to the confirmations Studio asks itself, whole-database runs and session kills included, so no value skips one.
The maintenance list is no claim either: the routes read it to refuse, before any provider is built, an operation the engine does not offer.

### M-65 (normative): Where a spec places its operation, its confirmation and its preview

A spec places its operation on a row, over the whole database or both.
Only `kill`'s places it nowhere, since its target is a session the session list names, and the maintenance route passes such a request to the provider as it arrives.
A typed confirmation, the connection's name, is asked only on a whole-database card.
A spec may declare one only where it places its operation over the whole database alone, with a title and a description.
A typed target, the object's own name, is asked only on a row.
A spec may declare one only where it places its operation on a row alone.
A preview is shown only on a row.
A confirmation is admitted only where at least one control sends the operation and every control that sends it asks the confirmation: a typed confirmation where the operation's one control is its declared card, whose typed dialog takes the title as its heading and the description as its body, and a typed target where its only controls are on its objects' rows.
A preview is admitted only where a row shows it.

### M-66 (informative): The maintenance a connected server accepts

A provider whose engine family's servers accept different maintenance may measure at connect which placements its server accepts and narrow its declaration for that connection.
A refused placement is withdrawn, an operation left with none leaves the list, and nothing is added or widened, so every label, confirmation and preview stays as declared.
The maintenance routes after connect, and the Operations and Tables tabs through the monitoring answer, read the connected provider's narrowed declaration.
The declaration states the maintenance before any connection, and no member of it states a connection's narrowing, which a session answers in its refinement, C-68.

### M-67 (normative): An engine's agent overlay

`agent.overlay` states how agent mode composes on the engine.
It is null exactly where the engine speaks no statement language.
Otherwise it states the engine's SQL dialect, null on every family but SQL, and a named derivation of its family's grounding, or null where the engine keeps its family's.
Every function is named by the slot it fills and the package exports it, M-31.
The client view of a dialect and an engine's family are derived, the client view supplied exactly where the server member is, and no member states them.
No member states whether agent mode runs on the engine: the engines agent and MCP statements run on are `AGENT_EXECUTION_ENGINES` alone, C-39.
The other members Studio's overlay type lets an engine override are not in this contract.
For every engine Studio ships, the census reads each member back through Studio's overlay registries and holds each name to the very function the engine's overlay holds.

### M-68 (normative): The SQL dialect

Its catalog read names a composer per catalog kind, an optional schema fold, an optional retry and an optional row mapper, and says whether its statement is a command.
Its estimating plan is a prefix that opens with EXPLAIN and holds no word that executes the plan, or a session mode, since one strip built from every engine's prefix serves every engine.
Its profile names two shape tests and the type patterns of the columns it leaves out.
Its statistics name a builder and an optional probe and note.
Its capture lists the catalog kinds it reads in order, a builder, and the engine's words for the object kinds the provider declares, each word once.
A member is null where the engine composes none.
A statistics reading or a capture is stated only beside a catalog read.

### M-69 (normative): A composed statement meets the statement fence

Every statement a dialect composes is checked as a statement the model wrote is.
The catalog read and its statistics kind are checked as a bounded read, the estimating plan and the profile as a bounded read that refuses plan execution, and the statistics probe as a plain read.
So a dialect widens what agent mode composes on an engine it already runs on, never where it runs or what the fence admits.
The one exception is a catalog read whose statement is a command: the fence admits that one statement by identity, still refusing a comment or a word with a side effect, and the claim is `commandShaped`, M-53.

### M-73 (normative): An engine's TLS modes are data of its declaration

A declaration states in `connection.tls.modes` the TLS modes its engine's provider takes, each once and in the order of the schema's `tlsMode`, and none where the engine offers no TLS, so no surface draws the SSL / TLS panel for it and its provider receives no TLS settings.
Each mode means what Studio's published `SSLMode` in `src/lib/types.ts` says, the same on every engine that lists it, so core never maps one engine's modes onto another's.
A mode outside the vocabulary, a repeated mode and a mode listed after one the vocabulary orders after it are each refused by name, at the mode's own pointer, and a TLS offer stated as a word rather than a list of modes is refused as the wrong type.
The SDK's TLS settings read the same vocabulary: `TlsSettings.mode` is the generated `TlsMode`, which a census holds equal to `SSLMode` in both directions and in its order.
Each of Studio's surfaces that offers a mode offers every mode of the vocabulary today, and every shipped engine that lists any lists them all, which a census holds.

### M-76 (normative): An agent reading's panel is offered

An engine lists in `facets.agentReadings` a reading read through a monitoring panel, as `AGENT_READING_PANELS` names it, only where its `facets.monitoring` offers that panel, since the host refuses every panel call for a panel the session's engine does not offer, C-71.
A reading whose panel the engine does not offer is refused as `agent-reading-panel-not-offered`, at the reading's own pointer, in a sentence naming that pointer and no value.
`health`, which the mandatory health call serves, is admitted whatever the panels.
Every engine Studio ships satisfies the rule, which its census holds.

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

An array or a data object nested inside `MAX_VALUE_DEPTH` others is refused on encode and on decode with a `ValueCodecError` naming its JSON Pointer, so a deep or cyclic value is refused by name and never overflows the stack.
A tagged value counts as the one value it carries: the wire's tag wrapper adds no level, and an `obj` payload is the data object the bound counts.

### V-9 (normative): An object member whose value is undefined is left out

An object member whose value is `undefined` is left out on encode, as JSON leaves it out, and the `obj` escape is decided on the members written.
`undefined` at the root or as an array element is refused.

## Errors

A failed call answers, beside its words, an error record: closed fields a reader can branch on.
Studio's core reads each error a provider raises into a record, so a provider raises an error class and never writes a record itself.
The record's shape and vocabularies are the constants `@libredb/provider-sdk/errors` exports.

### E-1 (normative): A provider raises only the kinds a provider may raise

A provider constructs and extends only error classes whose kind is in `PROVIDER_ERROR_KINDS`.
The other kinds, `CORE_ERROR_KINDS`, are core's own: refusals before any provider is built, refusals of a facet member an engine does not declare, the refusal of the run's read allowance, Studio's own refusals marked by a class only core constructs, the scrub's replacement of an error whose text held a credential, and `internal`.
The reason each is core's stands beside the constant.
The two lists partition `ERROR_KINDS`.
One core kind reaches a caller through a provider: the read allowance core hands a provider in its statement budget raises `read-allowance-exceeded` when the provider charges past what is left.
The provider lets that refusal pass unchanged, and never constructs one of its own.
The provider code that charges the allowance is recorded, so a new charge is noticed.

### E-2 (normative): A provider's own class takes its nearest contract class's kind

An error class a provider declares takes the kind of the nearest contract class it extends, whatever its own fields say.
Any thrown value that is no contract error is `internal`.

### E-3 (normative): The record is closed

A record holds `kind` and `code`, and may hold `sqlState`, `engineCode`, `outcome` and `sessionState`, each in its vocabulary or pattern: `ERROR_KINDS`, `SQLSTATE_PATTERN`, `ENGINE_CODE_PATTERN`, `EXECUTE_OUTCOMES` and `SESSION_STATES`.
A reader refuses any other record, naming the field and never its value.

### E-4 (normative): The record holds no text of the error

A record holds no message, detail, statement or identifier of the error.

### E-5 (normative): Only a statement that cannot have reached the database is not-sent

`outcome` is `not-sent` only when the statement cannot have reached the database.
The host marks every failure of a provider's connect, and a provider claims not-sent only by raising `refused-before-send`, whose class marks it, by taking its connection or session through `checkoutPhase` before it sends anything, which marks what the checkout raised and turns a deadline the checkout met into a `ConnectionError` naming the wait, or by raising `transaction-lost` with `beforeSend` for a call on a held transaction whose session it found already ended, which the class then marks.
The host also marks not-sent a console call it refuses before making it, a deadline already passed or a caller already gone, C-51.
Studio's own refusal of an offset a legacy provider's prepare did not apply, C-85, is not-sent, since the bridge raises it before the provider's read path is called.
No provider writes an error's `outcome` itself, and every other failure is `unknown`.

### E-6 (informative): No error carries a session state or an engine code yet

`sessionState` and `engineCode` are defined and read, and no error carries either yet.

### E-7 (normative): A driver error row maps into the record

A driver's error row, `DriverErrorClassifier`, answers what the driver's own fields and words say of an error, and each answer maps to one kind.
A configuration refusal is `config`; a database the login cannot open is `connection`; an access refusal is `permission` for a missing privilege and `authentication` for a refused credential, and the credential words count only on an error that carries no code; a statement fault is `query`; the engine's own time budget is `timeout`; a cancelled statement is `cancelled`; a late classification is `connection` or `query`, as it says.
The record keeps the SQLSTATE the driver reported.

### E-8 (normative): Nothing resends on `retryable`

An answer's `retryable` is advice to a person that trying again may help.
No host, client, agent or MCP component resends a request because of it, for a write and a billed read alike.
Every read of the flag in Studio's source is a recorded copy that carries it to the next hop.

## SQL grammar

An engine whose query text is SQL states its grammar facts: what a handful of characters and forms mean in its SQL, which Studio's readers read a statement's structure with.

### S-1 (normative): One grammar type and one compatibility default, both the SDK's

The grammar facts are one type and the compatibility reading is one value, both exported from `@libredb/provider-sdk/sql`.
Studio's readers and the composition of its grammar rows import `SqlGrammar` and `DEFAULT_SQL_GRAMMAR` from `@libredb/provider-sdk/sql` by name, a fact a dialect has not established takes the default's value, and the module that resolves a grammar by engine id declares neither.
The default is frozen to its leaves, so no module that imports it changes it for another.

### S-3 (normative): The SQL text segment

An engine states, in `sqlText`, whether its statement text is SQL, its grammar facts, its redaction, its update target words and its completion quoting.
`grammar` has one member per member of the SDK's `SqlGrammar`, under the same name, and every member is required.
Studio composes each engine's grammar row from its declaration, M-78, and its census reads every member of every declaration back to that row, and finds no member of a row that its declaration leaves out.

### S-4 (normative): A fact the grammar may leave out is written

A fact the `SqlGrammar` type may leave out is written at the reading its absence has.
A form the engine does not have is false or an empty list, tagged runs are true, the formatter language is `postgresql` and the completion words are two empty lists where the engine adds none.
The two backslash overrides are null where the quote takes the reading `backslashAlwaysEscapes` gives both quotes, which is a third reading where that fact is false.
The session keys are null where no SET or RESET asks, and a list, even an empty one, makes a RESET with no key ask.
A grammar read from a declaration, each null fact left out, reads every statement as the engine's grammar row does.

### S-5 (normative): Trailing limit clauses

A trailing limit clause is a pattern of a `source`, of 1 to 512 characters, which opens with `\s+` and closes with `\s*$`, and its `flags`, `i` or `iu`, and it compiles as JavaScript's `RegExp` reads it with its flags.
The flags that would make the limiter remember where it stopped, match at a line end or anchor at a stored index are left out.
Studio places the row bound before the run of such clauses at a statement's end, stripping them in the order declared, and reads a bound followed by such a run as the statement's own.

### S-6 (informative): How a host runs a clause pattern

A host compiles each clause pattern once, when it reads the declaration, never per statement, and anchors the whole pattern behind a character that is not whitespace and at the statement's end, so a match starts only where a whitespace run starts and ends only at the end, whatever alternatives the pattern has.
Anchoring only a pattern's first alternative would try each later one from every position of a whitespace run, in time quadratic in the run's length, and would let an earlier alternative that does not end the statement strip the text after it; `tests/unit/db/limiter-clause-anchoring-bounds.test.ts` holds both in a bounded child.
Backtracking is not checked yet, as M-35 says of a field rule's pattern.
Every clause pattern Studio declares is the source and flags of a pattern its limiter runs, compiled once when its grammar row is composed, M-78, and each was measured to run in time linear in the statement's length.

### S-7 (normative): Redaction

An engine's redaction says what the query event log keeps of a statement.
`sql`: the statement's literals are replaced, and only a closed name in its `nameQuote` is kept, or none where it is null.
`none`: nothing of the text is kept.
`command`: a named pure reader answers, from the statement's text, the text the log keeps.

### S-8 (normative): A claim that loosens the confirmation gate

`readsSqlText: false` and an exempt form each loosen the confirmation gate.
The gate counts such a claim only where Studio's review record lists it, and every other reader reads it as declared.
Studio's census holds each declaration's claims to the record.

### S-9 (normative): Update target words and completion quoting

`updateTarget` names the words beside the shared sets that open a query and that join two queries, each one upper-case word, and whether `--` opens a comment only before a space or a control character.
`completion` names a pure segment formatter, used instead of the connection's quoting, and a pure reader of a quoted qualifier before a dot, each null where the engine has none.

### S-10 (informative): Where a grammar function runs

Studio runs a command redaction reader on its server, and its completion readers in the editor, in the browser.
Composing the SQL grammar refuses any function name Studio holds no function for at its slot, M-78, so no package function runs in a browser or on the server through a grammar; where a package's completion reader runs is decided with the first package that names one, M-32.

### S-11 (normative): The SQL writing segment

An engine states, in `sqlWriting`, how a generated statement spells a literal, a name, a bind and a temporal literal for it, what its inline edit and its result export read, and how a document insert is written where its console text is a request.
The segment has one member per member of Studio's SQL writing row, under the same name and with the same nesting, and every member is required.
A function the engine lacks is null, and every other function is named by the slot it fills.
Studio composes each engine's row from the segment, M-79, so no member of the row is stated anywhere else.

### S-12 (normative): The type names an inline edit and an export read

An inline edit type name is one lower-case word, since the inline edit reads the first word of a declared type, lower-cased and with its wrappers off.
A standing-alone name, a bare spelling's name and a bare type family's name are lower-case words separated by one space, since the export reads a declared type trimmed, lower-cased and with each run of whitespace one space.
Every key column is float64 where `float64TypeNames` is `all`.
A map keyed by type name is a list, the bare spellings as entries and the bare type families as one list per kind, and each name is named once per table.

### S-13 (normative): Text an export writes from a declaration stays on its line

A DDL type and a bare spelling are each one SQL type of up to 64 characters with no line break: words separated by one space, then at most one parenthesized argument list with its commas inside it, then words, so it fills one column's type and never adds a column.
A non-finite literal is printable ASCII with no line break and no space at either end.
A create table key's note is whole comment lines, each `-- ` and text with no line break, ending in a line feed.
So nothing a declaration states becomes a statement of the file an export writes.

### S-14 (normative): The type vocabulary

Each engine states the vocabulary its declared types are read with: its bare type families grouped by kind, and three patterns.
Each pattern is a `source` of 2 to 512 characters, written with `^` and `$`, and its `flags`, none, `i`, `u` or `iu`, and it compiles as JavaScript's `RegExp` reads it with its flags.
`floatType` and `exactNumericType` are tested against a whole type, and `numericWrapper` captures exactly one group, the type it wraps.
The validator counts that group without running the declared pattern, so a wrapper that backtracks without end on some text is admitted or refused as quickly as any other.

### S-15 (informative): How a host runs a type pattern

A host compiles each type pattern once, when it reads the declaration.
It strips wrappers while the wrapper pattern matches and its capture is shorter than the type, and stops otherwise, since a capture as long as the type would never end the loop.
Studio takes a wrapper off only while the pattern matches and its capture is a strictly shorter type, so a capture as long as the type, or none, ends the unwrapping; `tests/unit/lib/export/numeric-wrapper-bounds.test.ts` holds both in a bounded child.
Backtracking is not checked yet, as M-35 says of a field rule's pattern.
Every type pattern Studio declares is the source and flags of one its export runs today, each measured to run in time linear in the type's length.
Studio compiles each type pattern once, when it composes the engine's row, M-79.

### S-16 (informative): Where an SQL writing function runs

Studio composes each engine's SQL writing row from its declaration, M-79, binding each function it names through Studio's own table.
Studio runs these functions in the browser, in the inline editor, the result export, the test data generator, the data import and the pivot table, and on its server.
M-32 says no package function runs in a browser.
The first package that fills a slot is admitted with its names read for their form only, C-99, and Studio composes no SQL writing row for its engine; how a package's SQL writing functions are called, and whether a declaration may choose a shared building block by name, is decided in a later milestone.

### S-17 (normative): The migration DDL segment

An engine states, in `migrationDdl`, what the schema diff's migration writes for it, in one of two forms.
Refused: the one line the migration writes in place of any statement, no transaction wrapper, and the reason the line gives.
Written: its transaction wrapper or none, its CREATE TABLE form, written by a key writer and a foreign key writer or refused by a named function that writes the line for the quoted table, its nine statement writers, and every refusal sentence its writers print.
The segment has one member per member of Studio's migration DDL row in that form, under the same name and with the same nesting, and every member is required.
A value neither form admits is one `no-variant` refusal at the segment, as M-5 says of every union.
Studio composes each engine's migration DDL row from the segment, M-80, so no member of the row is stated anywhere else.

### S-18 (normative): Text a migration writes from a declaration stays on its line

The refusal is one comment line, `-- ` and text with no line break, up to 1024 characters.
Each transaction wrapper statement is words separated by one space, ending in its one semicolon, up to 64 characters.
Each reason is one line of 1 to 1024 characters, named once.
So nothing a declaration states becomes a second statement of the migration.

### S-19 (informative): Where a migration DDL function runs

Studio composes each engine's migration DDL row from its declaration, M-80, binding each function it names through Studio's own table.
Studio runs every migration DDL function in the browser, in the schema diff panel, and none on its server; the panel shows and copies the migration text and never runs it, so a statement a declaration states reaches a database only when the user runs the text.
M-32 says no package function runs in a browser, so how a package's migration DDL functions are called, and whether a declaration may choose a shared building block by name, is decided with the first package that fills a slot.

### S-20 (normative): The SQL generator segment

An SQL engine states, in `sqlGenerators`, what it writes apart from Studio's shared SQL forms.
The segment is null where the engine writes the shared forms: it quotes a name as its declared identifier quoting or Studio's default says, and counts with `COUNT(*)`.
Otherwise it names the engine's name quoting, the tree click's statement, Generate Query's statement on the column list and the same statement on the projected column list, each form null where the shared form stands, and states the count Generate Count Query writes, `COUNT(*)` where the engine's is the shared one.
The segment has one member per member of Studio's SQL generator row, and every member is required.
Studio composes each SQL engine's generator row from the segment, M-81, so no member of the row is stated anywhere else.

### S-21 (normative): A count expression is one call

A count expression is an aggregate name of letters, digits and underscores, starting with a letter, followed by `(*)`, up to 64 characters.
So the count a declaration states fills one expression of the statement Studio writes, and never adds a clause or a statement.

### S-22 (informative): Where an SQL generator function runs

Studio composes each SQL engine's generator row from its declaration, M-81, binding each form it names through Studio's own table.
Studio runs a row's name quoting in the browser and on its server, in the profile route and in the agent's context, and its statement forms and count in the browser.
M-32 says no package function runs in a browser, so how a package's generator functions are called is decided with the first package that fills a slot.
The query dialects' and the query languages' own generators stay Studio's, keyed by the dialect and the language, while the dialect is one of Studio's (M-50).

### S-23 (normative): The editor language

An engine states, in `editor.language`, the query language it speaks, the Monaco language its query tabs are written and rendered in, one of Studio's editor languages, that language's accent, and whether the language is a console dialect.
An accent is a border class of one hue of Studio's palette at 40 percent, optionally its `-alt` step, and is none of the three status hues, amber, rose and emerald.
A console dialect's id is its Monaco id, so a manifest states no second id.
An engine with no dialect opens its tabs under its query language's tab type: `sql` for sql, `mongodb` for json, and `promql`, `cypher` and `influxql` for their own.
An engine with a dialect opens them under the dialect's name (M-50), so a manifest states no tab type.
Two engines that name one editor language state the same accent and console.
The projection refuses by name two declarations that state one editor language with a different accent or console, or one tab type in different languages, M-77, and Studio composes each language's code with the accent the declarations state.

### S-24 (informative): What stays Studio's browser code

A language's Monaco registration, its completion source, its formatter, and a console dialect's grammar and routes stay code beside the provider, read by Studio's editor in the browser, until Studio's browser catalog reads them.
An engine's editor language is one Studio's editor already has.
Two declarations that state one language differently are refused, M-77, and a language's code is Studio's, keyed by its Monaco id.

## Calls

The host calls a provider's implementation in its own process, as async functions.
Every request and answer is data in the value codec's domain, except the session handle `open` answers, so the calls need no framing.
The handle holds the session's state and is the package's own: the host never reads it, which the memory test transport checks, C-22.
The mandatory calls are `open`, `close`, `health`, which reaches the engine and answers its health, C-72, and `console.execute`, C-3.
The manifest's `calls` segment declares what the package's code answers beyond the mandatory calls: the optional console facets, the optional request fields its execute honours, the optional object facets, the optional maintenance facets and the optional monitoring facets.
The optional console facets are `cancel`, which cancels a run, `endScope`, which ends a session scope, and `transaction`, which opens, commits and rolls back a transaction on the session and reads its state, C-57.
The one object facet is `tree`, which lists a connection's containers and objects, counts them and describes them, C-61.
The maintenance facets are `run`, which runs one operation an engine lists, and `preview`, which reads what a per-row operation would do, C-67.
The monitoring facets are `panel`, which reads one monitoring panel an engine offers, and `poolStats`, which reads the counts of the session's own pool, C-71.
One implementation serves every engine the package declares, so `calls` is a fact of the package, a sibling of `runtime`, and never a fact of an engine.
The shapes of each call, its request, its answer and the contexts the host passes are the types `@libredb/provider-sdk/calls` exports.
Every other surface of today's provider interface joins this chapter with the change that carries it.

### C-1 (normative): A package's entry exports the record defineProvider returns

A package's entry default-exports the record `defineProvider` returns, `{ contract, manifest, impl }`.
`checkProviderModule` refuses any other value by a rule of `DEFINITION_REFUSAL_RULES`, each refusal naming a JSON Pointer into the record and never a value of the manifest or the implementation.
The record is frozen, its implementation is frozen in place, and its manifest is a deep-frozen copy, so the package's own manifest object is never changed.
The record is a plain object with no brand, because several copies of the SDK may share Studio's process.
Every key the check reads is read as a data property, and an accessor there is refused without its getter being called, so the functions checked are the functions the host calls.
An `honours` list longer than the request fields is refused by its length, before any item is read, so a sparse array's length bounds no loop of the check.
So is an engine list, and an engine's maintenance, maintenance specs and agent readings lists, longer than the schema's `maxItems` for it: the engine list holds at most 64 engines, a contract limit for a package that serves one provider's engines, and each facet list at most the size of its vocabulary, since each item is listed once and a spec is stated once for each operation listed.

### C-2 (informative): Admission checks the record with the host's SDK

The loader reads only the entry's `default` export, C-87.
Admission runs `checkProviderModule` on that record with the host's copy of the SDK, so a record another copy of the SDK built is checked by the host's copy.
Admission also validates the manifest against the schema the host holds.
Admission checks both at boot: C-98 validates the manifest with the host's validator, C-104 runs the host's `checkProviderModule` on the record, and C-105 runs admission for each locked package.

### C-3 (normative): The mandatory calls

The mandatory calls are `open`, `close`, `health` and `console.execute`, each a function of the implementation's own, found at the path its name spells.
An implementation defines no other key than the calls this contract defines: its keys are `open`, `close`, `health`, `console`, `objects`, which holds the object facets, `maintenance`, which holds the maintenance facets, and `monitoring`, which holds the monitoring facets; an implementation that offers no object, maintenance or monitoring facet may leave that segment out or hold it empty.
Each calls segment it has, `console`, `objects`, `maintenance` and `monitoring` alike, is a record of its calls: one that is `null`, a string, an array or any other value that is not an object is refused by name, and nothing under it is read.

### C-4 (normative): An optional facet is declared and implemented, both ways

An optional facet, one of `CONSOLE_FACETS`, `OBJECTS_FACETS`, `MAINTENANCE_FACETS` or `MONITORING_FACETS`, is offered in the manifest's `calls.console`, `calls.objects`, `calls.maintenance` or `calls.monitoring` exactly when the implementation has its function under `console`, `objects`, `maintenance` or `monitoring`.
A facet is never discovered by calling it or by its shape.
An engine's maintenance operation is admitted only where the package offers `maintenance.run`, and a maintenance spec that previews only where it offers `maintenance.preview`; each is otherwise refused by name as `engine-facet-call-not-offered`, naming the call that would serve it.
Of a maintenance spec the check reads only whether it previews; every other rule of a spec is the validator's, M-64 and M-65.
A package may offer either maintenance facet with no engine listing an operation: the host never calls it without one.
An engine's offered monitoring panel is admitted only where the package offers `monitoring.panel`, and is otherwise refused by name as `engine-facet-call-not-offered`, naming `monitoring.panel`.
A package may offer either monitoring facet with no engine offering a panel: the host never asks a panel its session's engine does not offer, C-71, and pool statistics describe the session's own pool.
An engine's agent reading is admitted only where the package offers the call that serves it, which `AGENT_READING_PANELS` names: a reading read through a monitoring panel only where it offers `monitoring.panel`, and is otherwise refused by name as `engine-facet-call-not-offered`, naming `monitoring.panel`; `health`, which the mandatory health call serves, on every package.
Of an agent reading the check reads only which call serves it; a reading outside the vocabulary, and a reading whose panel its engine does not offer, are the validator's, M-76.

### C-5 (normative): A package declares the request fields its execute honours

A package lists in `calls.console.execute.honours` the optional request fields, of `EXECUTE_REQUEST_FIELDS`, its execute honours.
How the host uses that list is C-9, and how a provider does is C-8.
A package that serves read-only statements lists `readOnly`, the read-only execute of C-78.

### C-6 (normative): A package never reads a proxy variable

`runtime.env` cannot declare a proxy variable, in either case, so every route out of Studio's process is core's.
Package source reads no environment variable itself, M-18.
A later check of the kit runs each package in an environment poisoned with proxy variables; it does not exist yet.

### C-8 (informative): A provider never ignores a request field it does not honour

A provider that receives a request field it does not honour answers a named error and never ignores it.
The kit checks it, and no such check exists yet.
The host's half, which sends no such field, is C-9.

### C-9 (normative): The host sends only the request fields a session honours

The host holds every execute request to the session's calls with `checkExecuteRequest` before the call, and refuses it by a rule of `CALL_REFUSAL_RULES` when it carries an optional request field the session does not honour, or a `scope` to a session that does not offer `console.endScope`.
A statement sent inside a transaction, with `transaction`, goes only to a session that offers `console.transaction`, and never with a `scope`: it runs on the transaction's own session, which no scope names.
Such a statement is held to the same `honours` as any other, since it is the same execute.
A present `params` key is sent whatever its length, and an offset is sent when it is not zero.
A present `readOnly` key is held to `honours` like every other field, and the session's read-only policy holds it beside, C-78.
A refusal names the field and a JSON Pointer into the request, never a value of it.

### C-10 (normative): A refinement only narrows a session's calls

`open` may answer a refinement beside its handle: a closed object at the paths of the manifest's `calls`, every key optional, every value of which is a subset of the declared one.
`checkRefinement` refuses a widening, an unknown key and an unreadable value by name, reading every value as a data property and never calling a getter, and no refusal carries a value of the refinement.
An `honours` list longer than the declared one is refused as a widening by its length, before any item is read, so a sparse array's length bounds no loop of the check.
`sessionCalls` answers the narrowed calls, frozen, and the host keeps them with the session and nowhere else, with no cache and no invalidation event.
A refinement may withdraw any console facet the manifest offers, `console.transaction` among them, `objects.tree`, `maintenance.run`, `maintenance.preview`, `monitoring.panel` and `monitoring.poolStats`, and never offers one the manifest does not.
`health` is no member of `calls`, so no refinement withdraws it, C-72.
Its `calls` may hold `console`, `objects`, `maintenance` and `monitoring`, each optional and closed, and each is read by its own segment's reader, so a key that names no segment is refused by name and never read as another segment.
A refinement may also hold `maintenance`, the placements the session's server accepts, C-68, read for its shape here; any other top-level key is refused by name.
A refinement is a call's answer, not a manifest fact, so the schema has no place for it.

### C-11 (normative): The contexts and requests the host passes are frozen

`freezeContext` freezes a context in place at every depth, except its `signal` and `env`, which stay exactly as the host passed them, because a frozen AbortSignal can no longer be aborted or listened to on Node.
`freezeData` freezes a request in place at every depth, except its typed arrays and dates, since JavaScript cannot freeze a typed array's elements and a date's time is no property.
Both walk every own key of every object they freeze, symbols included.
Either refuses, by its JSON Pointer and then freezing nothing, an object outside the value codec's domain, a function, an invalid Date, which `encodeValue` refuses too, and an accessor property, whose getter it never calls, so no object behind a getter is left unfrozen.
Either refuses a symbol-keyed property by the JSON Pointer of the object that holds it, since a pointer cannot name a symbol, and then freezes nothing.

### C-12 (normative): The host freezes on every call, in every environment

The host passes every context and request through `freezeContext` and `freezeData` on every call, in every environment, production included, so a provider that writes to what the host passed fails the same way in a test and in production, at the line that writes.
Both freeze in place, so the host builds a fresh context and request for each call, and a value it shares across calls ends frozen.
The host core's console calls do so, C-48.

### C-13 (normative): The byte budgets and the row measure

The byte budgets of a result are `BATCH_MAX_BYTES`, for one batch, and `PAGE_MAX_BYTES`, for one page.
A row's size is the UTF-8 length of its encoded JSON text, `encodedRowBytes`, and a batch's and a page's size is the sum of their rows' sizes.
The pump hands each pull its own measure, `measure` on the pull's limit, which answers that size.
Measuring a row encodes every cell, so a cell outside the value codec's domain is refused by the codec's own error.

### C-14 (normative): A result source answers within the limit it is asked for

A result source answers each `next` with at most the rows and the bytes it is asked for, and never splits a row, so a batch of exactly one row may be larger than its byte limit and one row always makes progress.
It sizes each row it answers with the measure of the limit it is asked with.
`rowsSource` does so over rows a driver already holds in memory.

### C-15 (normative): The host pulls a page with pumpPage

The host pulls a page from a result source with `pumpPage`, one batch at a time, the pull being the credit.
Each pull asks for no more than the page has left, with a frozen limit that holds the pump's own measure for that pull, a new one each pull.
The pump takes the size its measure recorded for the same row array a source answers, in the order the source measured its rows, and measures any other row itself, a copy of a measured row, a row measured in another pull and a row answered twice included, so a page's bytes are the same whichever rows a source measured.
A pull's measure answers only during its pull: called after its pull answered, it throws an error that names the source's defect.
As it reads each batch, the pump refuses by a rule of `CALL_REFUSAL_RULES` a batch that breaks C-14 or is not a plain record of rows and done, a row that is not positional, a batch that brings nothing and is not done, and a row no page can hold.
It cuts the page by size, ends it at its row limit or when the source is done, and closes the source exactly once on every path, losing no failure: when the close fails after another failure, both are thrown together.
A limit that is not a positive safe integer is a host defect, refused before any pull.
The pump never keeps a source open across pages, so a later page is a new execution with an offset, C-9.
The pump takes the context of the execute call that answered the source and starts no pull once that call's signal has aborted or its deadline has passed, C-27.

### C-16 (normative): What the byte budgets bound

The pump runs in the host's copy of the SDK, so every package's batches are measured by one rule.
The budgets bound what crosses from a provider, not what a driver buffers: a driver without a cursor materialises a page before the SDK sees it.
A page of very small rows is bounded in the heap by the host's row limit, not by its bytes, so the host always passes a finite row limit.
A row a source answers as the same array the pull's measure sized, in the order the source measured its rows, is measured once, by that call, and its cells are read once, when it is measured.
Every other row is measured by the pump as C-15 states, so a copy of a measured row, a row measured in another pull and a row answered twice are measured a second time, as is a row that crossed a frame of the kit, C-19.
The pump hands on the provider's own row arrays, so a source whose cells change after the row was measured, through a getter or a later write, whether after its own call of the pull's measure or after the pump read the batch, answers more than was measured.
In process nothing is framed, so the host measures what a source answers, through the pump's own measure, and a source of the legacy bridge sizes each row with the pull's measure in the form C-50 states.
How many pages larger than one batch the host holds at once is bounded by its page budget, C-53.

### C-17 (normative): The host calls a facet only when the session offers it

The host holds every call to a console facet to the session's calls with `checkConsoleFacet` before the call, every call to an object facet with `checkObjectsFacet`, every call to a maintenance facet with `checkMaintenanceFacet` and every call to a monitoring facet with `checkMonitoringFacet`, and refuses it by `facet-not-offered`, a rule of `CALL_REFUSAL_RULES`, when the session's calls do not offer that facet.
The session's calls are the ones `sessionCalls` answers, so a facet the manifest offers and a refinement narrowed to not-offered is refused too.
The refusal names the facet by its call name and a JSON Pointer into the session's calls.
The host also holds every maintenance run request to the session's maintenance with `checkMaintenanceRunRequest`, and every maintenance preview request with `checkMaintenancePreviewRequest`, before the call.
It refuses an operation the session's maintenance does not list as `request-operation-not-offered`, a run on a placement the operation's spec does not offer as `request-placement-not-offered`, and a preview of an operation whose spec declares no preview on a row as `request-preview-not-offered`.
An operation its spec places nowhere, `kill`, passes the placement check, as does an operation listed with no spec.
Empty text where a request names something, a target, a container, the path or a name in it, is refused as `request-field-empty`, named by the field.
A preview request whose path is not a list is not read by the check: reading the request's frame refuses it by name.
The host holds every monitoring panel request to the panels the session's engine offers with `checkMonitoringPanelRequest` before the call, and refuses a panel that engine does not offer, a request that names no panel and a panel name an object inherits as `request-panel-not-offered`, without throwing.
Each refusal names a JSON Pointer into the request, in request order, and never a value of it.

### C-18 (normative): The testing entry is for tests

`@libredb/provider-sdk/testing` holds the memory test transport's pieces, and only tests import it.
The package root never re-exports it, and Studio's runtime source under `src/`, `bin/` and `vscode-extension/src/` never imports it, in any form, a type import included.

### C-19 (normative): serve crosses every call as JSON frames through the value codec

`serve` puts a provider module record behind the memory test transport: every call crosses as one request frame and one answer frame, each the JSON text of what `encodeValue` wrote, parsed and decoded with `decodeValue` on the other side.
The provider receives decoded copies, its context frozen by `freezeContext` with the host's `signal` and `env` attached by reference, and its request by `freezeData`, and the host's own context and request are left as the host built them.
A `result.next` frame carries the limit's numbers only, and the provider receives them decoded and frozen with the host's `measure` attached by reference, as the context's `signal` and `env` are.
A row that crosses a frame is a new array, so the host's pump measures it itself.
A call with no request part, `health` and `monitoring.poolStats`, crosses its context in the request frame and its answer in the answer frame.
The host receives decoded copies of each answer, a timestamp member a new `Date` of the same time.
A value outside the codec's domain fails where it is encoded, with the codec's own `ValueCodecError`, before the other side is called.
An `undefined` optional member, which the codec leaves out (V-9), is refused by the round trip as `round-trip-changed` at its pointer, and a frame that `readFrame` or `roundTripRefusals` refuses fails as one `FrameRefusalError`.
An error either side throws crosses by reference.
`serve` checks the module with `checkProviderModule` first and serves nothing it refuses, and what it serves is itself an implementation of the module's manifest, with the module's facets.

### C-20 (normative): Each part of each frame is read as a closed shape

`readFrame` reads each part of each call's frame, its context, its request and its answer, as the closed shape of the call type it carries.
A key the shape does not define, a required key the part lacks, and a value of the wrong type, outside its vocabulary, behind an accessor or in a list with a hole are each refused by a rule of `FRAME_REFUSAL_RULES`, at a JSON Pointer into the part, and never with a value of it.
A page bound is exactly one of its two forms, a transaction request is read as the closed shape of the action it names, so only a begin carries `requireReportedState`, and a connection's keys are the contract's field names.
A tree request is read as the closed shape of the action it names, so a member of another action is refused, and a tree answer is exactly one of its five forms, told apart by its keys, each read as its closed shape; a kind count, an object's read range and an object's indexes are each one of their forms, and the counts are a map whose every key is read.
An open answer may carry the engine principal the session acts as, `engineUser`, as text.
A maintenance run request is its operation, one of the maintenance vocabulary, with its target and container as text where it names them, and its answer is whether the engine took it, how long it ran, the engine's sentence, and its rows, each a record of codec values, with their fields, so an answer with rows and no fields is refused as `frame-key-missing` at `fields`; a maintenance preview request is its operation and the object's path, never empty, so an empty path is refused as `frame-value-unreadable` at `path`, and its answer is the summary, the facts, each a closed label and value, and the refusal and the note where it has them.
A monitoring panel request is read as the closed shape of the panel it names, so a member of another panel is refused and a panel outside the vocabulary is refused as `frame-value-unreadable` at `panel`, and a panel answer is exactly one of its forms, each with one key, the panel's own, told apart by it and read as its closed shape at every depth, a session's activity one of its vocabulary.
A pool statistics answer is its four counts and the ceiling where it has one, and a health answer is its connection count where it has one, the size, the cache hit ratio and its two lists, each item a closed record.
A timestamp member admits a valid `Date`, which the value codec carries as its timestamp, and nothing else.
The frame reader reads shapes only: which answer form answers which action, or which panel, is the host's, C-62.
Each reader is declared as the shape of its call type, so a member added to a call type, or to a union it reads, fails typecheck until its reader names it.

### C-21 (normative): What crosses is compared deep-equal, and whatever the round trip changes is refused

The value a side decodes is compared deep-equal with the value the other side handed, as `roundTripRefusals` does, and never copied with `structuredClone`, so a test sees what a JSON boundary does to a value.
Whatever the value codec's JSON round trip changes or drops is refused as `round-trip-changed` at its pointer: a symbol-keyed property, at the object that holds it, a non-enumerable property, an accessor, whose getter the comparison never calls, an array's property that is not an index, at the array, and a key, a length or a leaf that differs.
What the codec defines as equal compares equal: `-0` and `0`, NaN and NaN, a `Uint8Array` subclass such as a Buffer and a plain `Uint8Array` of the same bytes, a `Date` subclass and a `Date` of the same time, and an object with no prototype and one with `Object.prototype`.
A `Uint8Array` and a `Date` are compared by their bytes and their time alone, so an own property either one carries besides them is not compared: a typed array's own keys are its indices, and walking them would cost a pass over every byte.

### C-22 (normative): A session handle and a result source never cross

Over the memory test transport a session handle and a result source stay in tables the served instance owns, and only their ids cross.
The host holds a frozen token for each session, looked up by identity, so a copy of a token is foreign, and the provider's calls receive the provider's own handle.
A closed or foreign token is refused as `session-not-open`, and a closed result source as `result-not-open`, before any frame.
A close takes its entry out of both tables whatever the provider's close answers, and a close that resolves anything but nothing is refused.

### C-23 (normative): The served host side checks each call before any frame, and closes what a refused answer handed over

The served host side refuses before any frame what C-9 and C-17 refuse, holding each call to the session's calls.
It reads the refinement `open` answers by C-10, so the session's calls are the narrowed ones, and its maintenance narrowing by C-68 against the maintenance of the engine the open context names; an open context that names an engine the module's manifest does not declare is refused before any frame.
It keeps the monitoring panels of that engine with the session, and refuses a panel call for a panel they do not offer before any frame, C-17.
An answer the host refuses holds nothing open afterwards: a refused open answer closes its session through the provider's `close`, under a cleanup context of its own, C-47, never the open's, and a refused execute answer closes each result source it handed over through its own `close`.
An item of an execute answer's `results` that is not an object is refused at its index, as a hole is, and a source whose `columns` or `rowCount` read throws is closed with the sources before it, the read's own error thrown.
Every close runs, and when one fails the host receives an `AggregateError` with the refusal first and each close's error after it.

### C-24 (normative): A frame never grows past what the provider holds

The transport encodes a value before it stringifies it, and every loop it runs over a provider's array stops at the first hole, so a sparse list of any length is refused at its first hole.
A served result source asks the provider for exactly the limit it is pulled with, one batch a pull, and buffers nothing ahead, so `pumpPage` cuts a page of a source that never ends at its byte budget.

### C-25 (informative): The memory transport is a test transport

The memory transport keeps frames for tests only, so a test, the kit and the host core's tests see what crossing a JSON boundary does to a call.
The kit's run in memory calls `serve`, and whether any of the transport's checks run in production is decided with the first host surface.
Its deadline and cancellation rules are C-26 to C-30, and the failure matrix is C-34.

### C-26 (normative): One deadline, owned by the host

Every call's context carries one absolute `deadline`, in epoch milliseconds on the clock `Date.now()` reads, which every step of the call consumes.
Its `signal` aborts at the deadline with a DOMException named `TimeoutError`, or when the caller goes first, with the caller's own reason.
`deadlineSignal` builds that signal from the standard `AbortSignal.timeout` and `AbortSignal.any`, and answers a signal already aborted for a deadline already past.
A deadline that is not a finite number, or one further ahead than a timer waits, 2147483647 milliseconds, is a host defect, refused with a `RangeError` before any signal is built, since Node.js runs a longer timer after one millisecond.
Node.js does not let the signal's timer keep a process alive, so nothing relies on the signal to do so.

### C-27 (normative): No call starts after its signal aborted or its deadline passed

The host checks each call with `checkCallStart` before it makes it, and refuses it by `call-deadline-passed` or `call-signal-aborted`, rules of `CALL_REFUSAL_RULES`, each at a JSON Pointer into the call's context.
A refusal by `call-signal-aborted` is thrown with the signal's reason as the error's cause, never as a value of the refusal or of its sentence.
The deadline is read by time, since a signal does not abort at once when its deadline has already passed.
The served host side runs the check on every call, before any frame and before C-9 and C-17, so a refused call reaches no provider and leaves the session as it was.
`pumpPage` checks before every pull, so no batch is pulled after either, and a refusal there is thrown after the source's one close, as any failure of a step is, C-15.

### C-28 (normative): The host stops waiting at the signal, and an abandoned answer keeps its handler

The host waits on a provider's answer with `awaitWithin`.
When the answer comes first, the wait settles as the answer does and leaves no listener on the signal.
When the signal aborts first, or had aborted already, the wait rejects with the signal's reason at once, and the answer keeps a handler for its value and for its error, which hands its late outcome to the host's late handler once, by reference.
So no abandoned rejection goes unhandled, and the host's late handler closes what a late answer handed over and logs a late failure.
A late handler that throws is a host defect, and its error is a detached rejection.
A result source runs under the context of the execute call that answered it, so `next` takes no context, and the host's wait on a page is its wait on that call.
The memory transport races nothing: an answer the host stopped waiting for is delivered whole, its session token and served sources included, so the late handler closes it once, and what the served host side refuses of a late answer it closes itself, C-23, and hands on as a failure.
The host core's execute call closes every source of an execute answer that arrives after its stop and pumps none of them, and hands a failure that arrives after its stop to the caller's late handler once, C-48, which logs it by its kind and code, never its text.
Once the host sent the run's cancel, the caller's late handler reads a cancellation the provider answers after it, Studio's `QueryCancelledError`, as the run's expected end and logs nothing for it.

### C-29 (informative): What a provider does with the deadline and the signal

A provider derives every driver timeout from `ctx.deadline`, for checkout, connect and execute alike, starts no work on a signal already aborted, and ends its waits when the signal aborts.
A provider derives its connect's timeouts from the open's deadline, its engine's connect budget, C-55; the bridged providers do not yet, and bound their connect by their own constants and the connection's statement timeout.
It answers `cancelled: false` for a run it does not know.
A result source's pulls honour the context of the execute call that answered it.
A close, and the cancel a stopped wait sends, are called with a context of the host's own, `cleanupContext`, never one that already aborted, C-47.
The kit checks these, and no such check exists yet.

### C-30 (normative): A session without console.cancel is reported as still running, without a call

The host refuses a cancel to a session that does not offer `console.cancel` before the call, C-17, and reports the run as not cancelled.
Studio's cancel route answers such a connection with `cancelled: false` and calls nothing.

### C-31 (normative): A throw inside a call fails only that call

An error a provider's call throws reaches the host by reference, and that session and every other session keep serving.
An error a bridged provider throws reaches the caller by reference, through the host core and the legacy bridge, and is read into an error record where the caller answers it, `databaseErrorBody`.

### C-32 (normative): The SDK keeps sessions apart

The SDK keeps no state across sessions and installs no process handler, since several copies of it share Studio's process, M-19.
The memory transport keeps each served instance's sessions in tables of its own, and each call reaches only its own session's handle.

### C-33 (informative): A provider keeps per-session state in its handle

A provider keeps its per-session state, its connection, statement, cursor, transaction and schema, in the handle `open` answers, never in module scope.
So two sessions opened by two owners exchange no result, handle, error or cached metadata.
The kit's isolation case checks it, and no such case exists yet.

### C-34 (informative): The failure matrix

How a provider's failure ends, by kind and by runtime.
The runtimes are Studio's Next.js server, the VS Code extension's backend child under Node.js, the same child under Electron, which is how the extension forks it, and the server under Node.js started with `--unhandled-rejections=strict`.
Each "held by" cell names the clause that holds the row, or says what will hold it.
The kit's fault cases and a measurement under Electron do not exist yet, and the detached rejection row stays open until such rejections have been counted in real sessions.

| Failure | Next.js server | VS Code child, Node.js | VS Code child, Electron | Node.js, strict | Blast radius | Held by |
|---|---|---|---|---|---|---|
| The loader refuses a package | Studio starts without its engines | The same | The same | The same | That package's engines | C-105 |
| A package's import throws | Studio starts without its engines | The same | The same | The same | That package's engines | C-88 and C-105 |
| A package's import passes its deadline | Studio stops waiting and starts without its engines, unless the import is synchronous | The same | The same | The same | That package's engines, or the process | C-88, C-89, C-37 and C-105 |
| A synchronous hang, at import or in a call | Every request waits | The same | The same | The same | The process | Only a watchdog outside the process, C-37 |
| A throw inside a call | That call fails | The same | The same | The same | That call | C-31 |
| A detached rejection | Logged, and the server keeps serving | The child exits with 1 and the extension restarts it, measured by a probe, not a test | Not measured | The server exits with 70 | None on the server, the process otherwise | C-35, with the server's own choice open |
| An uncaught exception in a callback | The server exits with 70 | The child exits with 1 and the extension restarts it, measured by a probe, not a test | Not measured | The server exits with 70 | The process | C-35 |
| A native fault in an addon | The process ends on the signal | The same | The same | The same | The process | The kit's fault cases |
| A close that never settles at shutdown | Cut after 15 s, exit 143, where Studio owns the exit | Each provider cut by C-45's deadlines when the backend's shutdown clears the caches | Each provider cut by C-45's deadlines when the backend's shutdown clears the caches | As the server | The shutdown | C-36 and C-45 |

### C-35 (normative): An uncaught exception stops the server with code 70, and a detached rejection does not

An exception that no code catches stops Studio's server with exit code 70, after one logged line.
A promise rejection that nothing handles does not stop it, unless Node.js runs with `--unhandled-rejections=strict`, which raises the rejection as an uncaught exception, so the server exits with 70 for it too ([DISTRIBUTION.md](../DISTRIBUTION.md#uncaught-errors-and-restarts)).

### C-36 (normative): A close that never settles at shutdown is cut

Where Studio owns the exit, a provider cache close still pending 15 s into the shutdown is cut, and the exit code is 143.
Where Next.js owns the exit, Studio closes no provider.
Inside those 15 s each provider is also cut by C-45's own deadlines.

### C-37 (informative): The import deadline cannot stop synchronous code

The loader's deadline on each import is a timer in Studio's own thread, so a synchronous loop at import or in a call blocks it as it blocks every request.
Only a watchdog outside the process detects a hung process.
The Helm chart's and the OpenShift operator's liveness probe restarts the pod.
The Compose healthcheck marks the container unhealthy and restarts nothing.
npx, the Linux packages' units, Snap, Homebrew, Windows, the desktop shell after its boot and the VS Code extension detect nothing.
The kit's import-time measurement is the check at a package's build, and the loader's deadline, C-88, is the bound at its load.

### C-38 (normative): Classification is core's, and its verdict is a closed set

Whether a statement needs a confirmation is decided by core's readers over facts core holds, never by a call into a provider.
The verdict is one of the members of `ConfirmationVerdict`, and a reader that throws asks for a confirmation.

### C-39 (normative): A protected read path is a precondition of agent and MCP statements

A provider without `queryReadOnly` is refused for agent and MCP statements before it is connected, and the plain query path is never the fallback.
The host holds the same rule on its own side: the legacy bridge's read-only statement session over a provider without `queryReadOnly` is refused at its open by name, before anything is called, and the host core refuses a plain execute on a read-only statement session before the call, C-78, so `query()` is never called on that path.
Every agent, hand-over and MCP statement reaches that open, C-79 and C-81, so a provider without `queryReadOnly` that an acquirer handed over anyway is refused there, answered as Studio's profile refusal with its record.

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

The order of the entries in the lock carries no meaning, and no provider is required for Studio to start.
The lock's read answers the same for every order of the same entries, and lists its packages by name.
With no providers directory set, no package is read, and a lock with no entries names none.
Boot admits the packages in the lock's order, which carries no meaning, and the catalog it composes answers the same for every order of the same packages, C-106; the loader's registry lists records in the order they were registered, an order nothing reads.

### C-44 (normative): The host owns each open

The host keeps one open in flight per session key, and every concurrent caller of that key shares it.
A caller's wait for an open is ended only by its own signal, with that signal's reason, and the open goes on for the others.
An open that settles after every caller left is admitted exactly once, by the open itself.
An open a removal or a close of the caches overtook closes what it opened exactly once, admits nothing, and answers its callers that the connection was closed while it was opening, outcome not-sent.
A close of the caches overtakes every open that settles while it runs, one that started after it began included, so it leaves no provider admitted and drops none without a close.
An open that fails with no caller left is handled by the host, never left as a detached rejection: it is logged by its connection, the error's kind and its code, never its text.
A caller passes its own wait as the fourth argument of `getOrCreateProvider`.
The metadata session of C-66 shares its opens the same way, in a table of its own.
The editor's query and its cancel, in the routes and in the VS Code backend, wait for their provider's open at most their engine's connect budget, M-51, or until their caller leaves, whichever comes first.

### C-45 (normative): Teardown under fixed deadlines

When the host closes its sessions, at a shutdown or when its caches are cleared, it tears each one down under fixed deadlines, shared, owned and metadata sessions alike.
An open transaction is rolled back first, and the host waits at most 5 s for the rollback.
Then the session is closed, and the host waits at most 10 s for the close.
A step that fails or is cut is logged, the next step still runs, and the teardown itself never fails.
Each provider still open at a cut is named, by its connection, its author and Studio's version.

### C-47 (normative): A cleanup call runs under a context of its own

A cleanup call ends work another call started: a close, the cancel the host sends when it stops waiting for a run, and the end of a run's scope, C-60.
It never runs under the context of the call it follows, which may have aborted, but under `cleanupContext`: a deadline `CLEANUP_DEADLINE_MS`, 10 s, after it starts, a signal that aborts only at that deadline, and the reader of the call it follows.
The memory transport closes the session of an open answer it refuses under such a context, and the host core's teardown waits for a close at most the same 10 s, C-45.

### C-55 (normative): An open ends at its engine's connect budget

Each open has a deadline, its engine's connect budget from the open's start, M-51, which the host core reads once when the open starts.
At that deadline the open is over: every caller still waiting for it, one without a wait of its own included, is answered that the connection did not open within the budget, as Studio's timeout refusal with outcome not-sent.
The open leaves the open table at its deadline, so the next caller of its key starts a new open instead of joining one that may never settle.
The open itself goes on until its connect settles, then closes what it opened exactly once and admits nothing, and a failure it settles with is logged as C-44 states.
A late settle of an expired open never removes the open that replaced it.
Until it settles, an expired open stays where a cache close still finds it but no caller can join it, so a cache close waits for it as for any open in flight, C-44, and names it when it is still connecting at the close deadline.
A deadline is the host's, not a removal's: a removal keeps an overtaken open in the table so a caller arriving meanwhile joins it, C-44.
A provider that bounds nothing of its own on a server that accepts and never answers keeps its socket until its connect settles, since the host closes what an open opened only once it settles.

### C-56 (normative): Test connection answers within its engine's connect budget

A Test connection has one deadline, its engine's connect budget from the test's start, M-51, over the whole test: the tunnel's open, the provider's build, its connect, the checks a provider runs only for a test and the health read.
At that deadline the test answers a connection error naming the budget, never a caution or a degraded success.
A one-shot tunnel closes at once, a provider already connected is closed at once, and a provider still connecting is closed once its connect settles, since no provider promises a disconnect during its connect.
The same deadline holds on the Test connection route and in the VS Code backend's `connection/test`, which keeps no deadline of its own.

### C-57 (normative): The transaction facet

`console.transaction` is one console facet, offered or not in `calls.console.transaction` like every other, and implemented as one function whose request names its action, one of `TRANSACTION_ACTIONS`.
`begin` opens a transaction on the session, and may set `requireReportedState`, so a provider that cannot read the transaction state from the server refuses the begin rather than answer a state it guessed.
`commit` and `rollback` end the transaction, and `state` reads the session state and changes nothing.
Every answer carries `sessionState`, one of `SESSION_STATES`, the state of the session after the call, and only a begin may carry `stateReported`, whether the server reported the transaction state.
A statement inside the transaction is console execute sent with `transaction`: the provider runs it on the transaction's own connection, and its answer carries `sessionState` too.
A statement sent without `transaction` runs outside any transaction the facet opened, on another of the session's connections.
The host reads a transaction answer with `checkTransactionAnswer` and a statement's answer with `checkTransactionStatement`, which refuse by name, as `transaction-answer-unreadable`, a session state that is missing, outside its vocabulary or an accessor, a `stateReported` on another action than begin or of another type, any other key, and an answer that is no plain record.
Each reads the answer by its own property descriptors, never calls a getter, and names no value of the answer, so a state the host cannot read is refused, never read as any state.

### C-58 (normative): An unknown session state is never read as closed

A provider answers `unknown` when it cannot tell whether the session holds a transaction, such as after its connection was lost mid-statement.
An aborted transaction block, one a failed statement left that accepts only a rollback, is `in-transaction`.
The host keeps no copy of a session state between calls and asks the session on every call: every record carries the state its own call answered.
A stopped transaction call or statement answers no state, and its caller reads it as `unknown`.
Its record carries the settle of the call the host stopped waiting for, which resolves once that call has settled, answered or failed, since until then it may still change the session.
After a provider's failure of a COMMIT, a ROLLBACK or a statement, the caller reads the state at once; a read that is stopped or fails answers `unknown`.
The transaction route keeps its record of a transaction and its owner while the state is unknown, records no terminal event for it, and resolves it by the next answer or by the state read every request makes, but only once every call Studio stopped waiting for has settled.
Until then no read resolves or releases the record, whatever state it finds: a provider may report the transaction open only because that call still runs, or closed only because a BEGIN it still runs has not opened it yet.
The route's status answer says the state is unknown until then, whatever the read found.
The route's five-minute watch for the provider's own timeout records no end while such a call still runs: it looks again a second later.
Every state read of the route is awaited, so a read that began before another request of the same owner claimed, changed or ended the record is not about it, and neither releases nor settles it: the record carries a generation every change bumps, and a read acts only when the record and its generation are the ones it began with.
The route counts each call of the owner's that may change the session, a BEGIN on an existing record, a statement, a script for its whole run, a COMMIT or a ROLLBACK, on the record from before it is sent until it answers, and a call Studio stops waiting for moves to the calls that have not settled; each change bumps the generation, and a call's own answer is read against the mark taken after its own count.
While any such call is in flight, or stopped and still running, no read acts on the record: the reconcile keeps it and records nothing, the watch records nothing and looks again, and the status answer says the state is unknown.
The status answer also says the state is unknown when the record changed while its read ran.
The watch takes a mark before its own read, and when the record changed while that read ran it records nothing and looks again.
The watch's repeated looks stop once the record's lease has lapsed, which leaves the record to the next request's lease check.
While such a call still runs, the route refuses a BEGIN, a statement, a COMMIT or a ROLLBACK of the owner's with 409 `TRANSACTION_CALL_RUNNING` before it is sent, never queued: on a connection that runs one call at a time it would queue behind that call, which may end the transaction first; the state read is still answered.
An end the route sees after an unknown state is recorded `unknown`, never `timed-out` or `rolled-back`, unless Studio's own rollback answered while no call of the owner's was in flight or stopped and still running.
When the owner's credential changes while such a call is in flight or still running, or a record whose state is unknown finds no transaction left to roll back, Studio's rollback is still sent where a transaction is open, the end is recorded `unknown` and the answer says `rolledBack: false`, since that call may have ended the transaction first.
An answered statement or script after which the session holds no transaction records the terminal `unknown`, since Studio cannot tell whether the statement or the provider's own timer ended it.
A teardown of the owner's providers by a governance reload records `unknown`, never `rolled-back`, while a call of the owner's is in flight or stopped and still running on the record, since that call may end the transaction before the teardown's rollback.
A BEGIN that replaces a record whose end no path recorded records that end `unknown`, since the provider opened a new transaction and how the old one ended is not known.
A COMMIT that fails after it may have reached the database, its outcome not `not-sent`, E-5, and leaves no transaction is recorded `unknown`, never rolled back.
A unit of the transaction route's script that Studio stopped waiting for leaves the state unknown: nothing is read after it, the record is marked unresolved, the script's call counts as stopped until that unit settles, and the script's answer carries `inTransaction: null`, C-84.

### C-60 (normative): A run's scope ends through console.endScope, after the run

The caller that runs statements in a scope mints it, one per request, sends it with every execute of the request and only to a session that offers `console.endScope`, C-9, and ends it once through `endScopeCall`, C-48, under a cleanup context the caller's leaving does not end, C-47.
A provider that offers `console.endScope` keeps the connection that holds a transaction a scope's statements opened to that scope while the transaction is open, and lends it to no other scope or caller, until `endScope` for that scope has answered.
The legacy bridge's postgres provider does not hold this rule today: its `query()` returns such a client to its pool, and the end comes after the run's pump, so another request can borrow the client in between and run inside that transaction; the backlog tracks it as D620.
The editor query ends its run's scope once its execute answered or failed, before its answer is built, and after a stop once the stopped call's `settled` resolved; a run refused before its call ran nothing and ends none.
An end that fails is answered in the run's place, its error by reference, and an end its deadline stopped answers `StudioTimeoutRefusal` naming the end, outcome unknown; after a stop, either is logged by kind and code, since the stop was already answered.
The answer carries `openTransaction: "rolled-back"` only when the end answered it.
`POST /api/db/query` and the VS Code backend's `query/run` end their run's scope so.
`POST /api/db/multi-query` ends its script's scope once after the last unit it ran, at once when that unit answered or failed and once its call settled when Studio stopped waiting for it, C-83, and answers 504 naming the end when its cleanup deadline stopped an end it waited for.
Only the legacy bridge calls a provider's `endOpenQueryTransaction`.

### C-61 (normative): The objects tree facet

`objects.tree` is one object facet, offered or not in `calls.objects.tree`, and implemented as one function under the implementation's `objects` whose request names its action, one of `TREE_ACTIONS`.
`containers` lists the containers under `parent`, or at the top level when the request sends none.
A top-level listing that answers no container may carry `needsConfiguration`, the provider's sentence for why its inventory cannot be listed without configuration the session lacks, completing "could be listed:"; a listing with a container, or below the top level, never carries it.
An engine with no container level reads no top-level listing, so it is never asked the question.
`count` answers each kind's count of objects in one container, keyed by the kind: a count, a count read from a bounded sample with the provider's sentence for what bounded it, or the engine's sentence for a read that was refused.
`list` answers one kind's objects in one container, by name and path, with no columns.
`describe` answers one object's columns, indexes and foreign keys, its indexes the engine's sentence where that read was refused.
`describeMany` answers the same detail for every object of one kind in one container in one read, at most `limit` of them when the request sends one, and says so in `truncated` when the read stopped short; with `defaultSql` it answers each default as SQL text, which a provider whose catalog already spells a default as SQL answers anyway.
A container's path and an object's path are opaque: the host sends each back exactly as it was answered and reads nothing in it.
The facet has no honours list: its request's members are each the action's own, absent `parent` meaning the top level and absent `limit` meaning unbounded, and a provider honours every one of them, C-63.
The answer shapes are Studio's own object tree shapes, declared by the SDK and held mutually assignable with Studio's, C-7.

### C-62 (informative): A tree answer is read by reference

In process the host reads a tree answer by reference and decides nothing on its values; what a caller reads of one stays the caller's.
The caller facade of the object tree reads the member its action answers, and answers an answer without it as a defect of Studio's bridge, naming the action and the member, C-65, except a `describeMany` batch, which the bridge passes through by reference, so a batch without `details` is answered as the provider's answer without it.
It answers a containers answer that carries `needsConfiguration` beside a container, or on a listing below the top level, as the provider's defect, naming where it was said, C-61.
The host's reader of a native provider's tree answer, which checks that the form answers the action, arrives with the first native provider.

### C-63 (informative): A provider honours every member of a tree request

A provider's `objects.tree` honours every member of the request its action names: it lists the containers under the `parent` it is sent, and it stops a `describeMany` read at the `limit` it is sent and says so in `truncated`, never at a cap of its own it does not state.
No package implements `objects.tree` yet, and the legacy bridge offers it on every session and runs today's members, which the conformance helper holds, so nothing checks this of a package's implementation.
Today's providers, whose tree methods the legacy bridge runs, are held to the same members by `assertObjectSurface` in `tests/helpers/object-surface-conformance.ts`, which their integration tests run: its own tests "rejects a deep container whose LAST segment the provider never answered", "rejects a bounded read that stops short and says nothing" and "rejects an unbounded read that reports the caller's bound", in `tests/unit/db/object-surface-conformance.test.ts`, show it fails a provider that ignores `parent` or `limit`.
The host's reader of a native provider's tree answer, which arrives with the first native provider, or a case of the kit checks it, and neither exists yet.

### C-66 (normative): The metadata session and the host's session capacity class

The host classes each connection's session capacity, one or several, from Studio's own records and the connection, never from a manifest or a provider.
It is one where Studio's record of the engines that serve their tree from one session, `SERVES_ONE_SESSION`, names a reason, which it does for every engine that keeps one handle per file, and where the connection's database is in memory, one database per handle, as the file admission reads it; it is several otherwise.
A manifest has no member for it, and a built provider's declaration never reaches it, M-57.
The class decides only which session a tree read, a monitoring panel read, a health read or a kill runs on; it never authorizes anything.
On a connection of class several, the tree routes and the VS Code backend's tree calls, `selectStatement`'s describe among them, read on a metadata session of the connection's own, opened beside the editor's session from the same connection, with the same credentials, file-access posture and owner, through the same checks in the same order, and keyed by the editor session's key with a metadata frame, so it is each owner's own under governance.
Its pool holds at most two sessions and opens none until a read or a kill asks.
The maintenance route runs a kill on the same metadata session, under the editor's posture and through the same checks, and every other operation on the editor's provider, C-70.
The monitoring route reads every panel, and the health route and fleet health read health and the overview, on the same metadata session, under the editor's posture and through the same checks, C-74 and C-75; the pool-stats route reads the editor's provider, whose pool its answer describes.
On a connection of class one every one of these reads, and a kill, runs on the editor's session.
A metadata session opens once per key, C-44, is torn down with the caches under the teardown's deadlines, C-45, leaves with the idle sweep and with every removal that names its connection, its owner or its record's key, and keeps the connection's SSH tunnel open while it serves the connection.
A tree read takes no catalog, so no catalog choice is honoured on it, M-57.
The catalog of a kill, a monitoring panel read or a health read is honoured on the metadata session through the same catalog choice as on the editor's provider, and a catalog the connection cannot honour is refused in the same words, M-57.
On a server-level connection, a tree read inside one of its databases, and a kill, a monitoring panel read or a health read in a catalog, run on the catalog session the metadata session opens for that database, which takes the pool its provider gives every catalog session in place of the metadata session's two.
The legacy bridge's postgres provider, the one provider that declares catalog sessions, gives each catalog session a pool of at most three sessions that opens none until a read asks, and keeps at most five databases open at once, so its metadata session on a server-level connection holds at most seventeen sessions.
A native provider's metadata session is an open like the editor's with a smaller `pool`, and the open names no role.

### C-67 (normative): The maintenance facets

`maintenance.run` and `maintenance.preview` are the two maintenance facets, each offered or not in `calls.maintenance`, and each implemented as one function under the implementation's `maintenance`.
`maintenance.run` runs one operation of those the session's engine lists: its request names the operation, the object or session it targets, absent for the whole database, and the container the target lives in, absent where it names none.
A target or a container, when present, is never empty text, and the host holds each run and preview request to the session's maintenance, C-17.
It answers whether the engine took the operation, how long it ran in milliseconds, the engine's sentence and, for an operation whose answer is a table, its rows and their fields, `fields` present whenever `rows` is.
`maintenance.preview` reads what one per-row operation would do to the object its path addresses, container levels first and the object last, so the path is never empty, and answers a summary, the facts it rests on, a refusal where a preflight refuses the operation, and a note on how fresh or exact the facts are.
Every implementation honours every member of its request, so neither facet has an honours list.
The host sends a run for an operation whose spec places it nowhere, `kill` with its session target, without a placement check, as the maintenance route always has.
The engine principal a session acts as, a user name and never any part of a secret, is `open`'s optional `engineUser`, which the maintenance audit row names; it is read once, at open, since a session acts as one principal.
No member of either call is a claim, M-64.
The answer shapes are Studio's own maintenance result and preview, declared by the SDK and held mutually assignable with Studio's, C-7.

### C-68 (normative): A session's maintenance is narrowed by what its server accepts

`open` may answer, in its refinement's `maintenance`, the placements its server accepts for the operations its provider measured at open: one item for each such operation, naming it and whether the server takes it on a row and over the whole database.
`checkRefinement` reads each item as a closed record of exactly its operation, one of the maintenance vocabulary and named once, and its two placements, each a boolean, in a list no longer than the vocabulary, refused by its length before any item is read, so a sparse array's length bounds no loop of the check.
`sessionMaintenance` reads the same shape, refuses an operation the session's engine does not list as `refinement-widens`, and answers the engine's maintenance with every refused placement withdrawn and every operation left with none removed from both lists, `kill` among them.
It adds nothing and changes no label, confirmation, preview or kinds, and an operation the narrowing does not name stays as declared, which is how Studio's `narrowMaintenance` reads a connected provider's measurement.
Its answer is frozen at every depth, and the declaration is left as it is.
The host keeps the narrowed maintenance with the session, beside its calls, and holds every run and preview request to it, C-17.

### C-71 (normative): The monitoring facets

`monitoring.panel` and `monitoring.poolStats` are the two monitoring facets, each offered or not in `calls.monitoring`, and each implemented as one function under the implementation's `monitoring`.
`monitoring.panel` reads one monitoring panel of those the session's engine offers, its request naming the panel, one of the keys of `$defs/monitoringPanels`, with the panel's own members.
The slow queries and the active sessions panels carry a limit, the most rows to answer, which the host resolves, and the table and the index statistics panels an optional schema, absent for every user schema.
It answers one form with one key, the panel's own, holding what the panel reads, which is the monitoring payload's member for that panel.
`monitoring.poolStats` reads the counts of the session's own pool, its connections in all, the idle and the active ones, the requests waiting for one and the configured ceiling where the provider reports one, takes no request and makes no round trip to the engine it does not need.
The host never asks a panel the session's engine does not offer, C-17, and such a panel is answered as not offered, never read.
Every implementation honours every member of its request, so neither facet has an honours list.
A timestamp member of an answer, such as when the server started or when a query began, crosses as the value codec's timestamp, a `Date`.
No member of either call is a claim.
The answer shapes are Studio's own panel shapes and pool statistics, declared by the SDK and held mutually assignable with Studio's, C-7.

### C-72 (normative): The health call

Every session answers `health`, a mandatory call beside `open` and `close` that reaches the engine and answers its health.
It answers the count of open connections where the engine can measure it, left out where it cannot and never a zero in its place, the database's size, its cache hit ratio, its slowest queries and its sessions, as Studio's health shape.
It takes no request, and no refinement withdraws it, since it is no member of `calls`.
The answer shape is Studio's own health answer, declared by the SDK and held mutually assignable with Studio's, C-7.

### C-78 (normative): The read-only execute

A read-only execute is console execute sent with `readOnly`: the statement runs on the session's read-only boundary, and `readOnly` carries its budget, the most rows and the most UTF-8 JSON bytes of those rows it may answer, and its mode, of `READ_ONLY_MODES`.
A request without a mode executes the statement, and `estimate-plan` asks for the engine's estimated plan, which the provider answers or refuses and never runs the statement instead.
Its time is the call's deadline, C-26, so `readOnly` carries no timeout of its own.
Its page is every row or a limit and an offset, and a session sent a bounded page applies it, or refuses a non-zero offset it does not apply, before it sends anything, C-85.
A provider answers within the budget's rows and bytes or refuses, and never truncates; an estimating plan's rows are the optimizer's operators, so its answer is held to the bytes alone.
`readOnly` is a request field, so a package lists it in `honours`, C-5, and the host sends it only to a session that honours it, C-9.
A read-only statement session is a session whose open policy has both `readOnly` and `sendsStatements`.
The host holds every execute to its session's read-only policy with `checkReadOnlyRequest` before the call: a read-only execute to a session that is not one is refused `request-read-only-not-opened`, and an execute without `readOnly` to one that is is refused `request-read-only-missing`, so the plain path is never the fallback on such a session.
Both refusals name the pointer `/readOnly` and never a value of the request.
The host core keeps whether each session is a read-only statement session with the session and refuses both as records before the call, C-48.
The memory transport keeps the policy its session was opened under and refuses both before any frame, and its frame reads `readOnly` as a closed shape of a budget of two numbers and an optional mode of the vocabulary.
`readOnly` is also the name of the open policy's flag: the request reuses the word because the request is the read-only execute.
The billed-read allowance a run spends stays with the host: it is a ledger charged as each request is sent, which no frame carries, so a provider of an engine that bills every read is handed none through the contract and refuses every statement, as its own rule refuses a budget that carries none.

### C-85 (normative): A read-only execute's page, and MCP's offset paging on the host

A read-only execute's page is every row or a limit and an offset, as any execute's, C-78.
A session sent a bounded page applies it before it sends anything and answers `pageApplied` true, or sends a statement that does not apply it and answers `pageApplied` false.
A non-zero offset it does not apply it refuses before it sends anything, and never answers the first rows as the page the offset names; a provider's refusal is `offset-unsupported`.
The host's half and the legacy bridge's are normative and tested here; that a native provider keeps the rule is the provider's own, which no kit checks yet, as C-8 states for a request field a provider ignores.

The legacy bridge's read-only statement session, C-50, honours `offset` beside `readOnly`.
On every row its execute calls no prepare and sends the statement as written, its page not applied.
On a bounded page it runs the provider's own prepare with a fresh options object of the page's limit and offset, so a legacy member may write what it receives, and sends the statement it prepared to `queryReadOnly`, its page applied exactly when the prepare says it limited the statement.
A non-zero offset the prepare did not apply is refused as Studio's own refusal, `StudioOffsetRefusal`, kind `studio-offset-refusal`, outcome not-sent, E-5, before `queryReadOnly` is called, in a sentence that names no statement text.
The prepare's own error, a provider's `OffsetUnsupportedError` included, passes by reference, and `queryReadOnly` is not called.

The paged read-only execute, `runReadOnlyPage`, sends the caller's page through the one host core execute of C-79 and answers the provider's result with whether the session applied the page; `runReadOnlyExecute` is it with every row as its page, so the agent's statements and the hand-over replay send every row as before.
Studio's refusal of an offset passes out of it by reference.

run_read_query sends a page one row past `max_rows` from its offset, and offers a next offset only where the page was applied and the engine's SQL has an offset.
No module of MCP calls a provider's prepare: the read-only statement session applies the page.
An offset on an engine whose SQL has none is still refused before the statement's execute, in the words that say how to page there.
Studio's refusal of an offset the prepare did not apply is answered in Studio's words, which say which case kept the provider from paging, with no record, and a provider's `offset-unsupported` refusal of a non-zero offset, from its prepare or its read path, is answered in its own words behind the notice naming the provider; both are recorded as `mcp_offset_unsupported`, and both are answered by class before the rule that answers a failure at or after the deadline as the timeout.
Since the prepare now runs inside the host call, a call whose deadline passed or whose request left before the statement starts is answered with the timeout or the cancel, where an offset the prepare did not apply was refused first.
A statement tool that does not page sends every row as its page.

### C-87 (normative): The loader reads only a package entry's default record

The loader imports a package's entry by the `file:` URL of its absolute path and reads only the namespace's `default`.
A namespace with no `default` is refused as `PROVIDER_LOAD_FAILED` with the reason `default-missing`.
A default that is not a plain record is refused with `not-a-record`: a plain record is an object whose prototype is `Object.prototype` or `null`, and a Proxy, an array, a function, a class instance and a primitive are not.
A plain record with an own `__esModule` key is an interop wrapper, refused with `interop-wrapper`, and its inner `default` is never read.
No step of the check calls the package's code.
A record that passes is answered as the package exported it.
The measured limit: on Bun the runtime unwraps a CommonJS entry's interop wrapper before the loader reads it, so only an ES module entry reads alike on Node.js, Electron and Bun.

### C-88 (normative): Every import runs under its caller's deadline

The loader runs every import under the deadline its caller passes, and past it answers `PROVIDER_LOAD_FAILED` with the reason `deadline-passed`.
An import that throws, a missing entry file among them, is refused with `import-threw`, and the thrown value is the refusal's `cause`, by reference.
The refusal's other members carry no text of the package's error; `cause` is for the host's log, and a host never sends it to a client.
An entry that is not an absolute path, a deadline that is not a whole number of milliseconds from 1 to 2,147,483,647 and a late port that is not a function are host defects, refused with a `TypeError` before anything is imported.
The deadline cannot stop synchronous code, C-37.

### C-89 (normative): A late settle is never answered as loaded

An import that settles after its deadline is never answered as loaded.
Its success or its rejection reaches the caller's late port once, the success without its value and the rejection with its cause, and no rejection is left unhandled.
A late port that throws is a host defect, which the loader does not catch.

### C-91 (normative): A package is read from the providers directory only where its lock entry names it

An operator names the providers directory with `LIBREDB_PROVIDERS_DIR`; it holds the lock, `providers.lock.json`, and each package as `<name>/<version>/`, a scoped name as `@scope/<name>/<version>/`.
The name is an npm package name of at most 214 characters, and the version an exact version of at most 64, never a range.
The lock is written by Studio's command, `bun run providers:lock -- --dir <absolute directory>`, never by the package it vouches for.
A package's directory is resolved by real path, and one that resolves outside the providers directory, through a symbolic link or junction included, is refused as `PROVIDER_PATH_OUTSIDE`.
A link that stays inside the providers directory is followed, and the package is read at its real path.
The entry its manifest names must be a regular file of that directory, compared by exact path, or the package is refused as `PROVIDER_PATH_OUTSIDE`.
No connection's database file or host path may name the providers directory, a path in it or its lock.

### C-92 (normative): An artifact is a tree of regular files with portable names

A package's directory holds only regular files and directories, each named by 1 to 255 letters, digits and `. _ - @ + ~`.
It holds at most 10,000 files and 32 levels of directories.
A symbolic link, a junction, a named pipe, a socket or a device anywhere in it, such as the links a package manager writes under `node_modules/.bin`, is refused as `PROVIDER_PATH_OUTSIDE`, and is never followed or opened.
A name outside that set, or more files or levels, is refused as `PROVIDER_DIGEST_MISMATCH`.

### C-93 (normative): Every file of a package is checked against the lock's digest at every read

The lock pins each package by its digest: `sha256:` and the hex SHA-256 of a listing with one line per regular file, sorted by path, `<mode> <hex SHA-256 of the file> <path>` and a newline, the path relative to the package's directory with `/` between names.
The mode is `755` when the file's owner execute bit is set and `644` otherwise, so the group and other bits and the umask of whoever copied the files change nothing, and empty directories are not listed.
Windows reports no execute bit, so every file reads `644` there, and a package holding an executable file has another digest on Windows than on Linux and macOS: write the lock on the platform that reads it.
The lock's digest of a package also covers its import record, C-102: after the file lines comes one line per recorded import, sorted by the module file's path, then by specifier, then by kind, `import <path of the module file> <specifier> <kind>` and a newline, so a record edited without its files is refused as `PROVIDER_DIGEST_MISMATCH` like any changed file.
A package whose modules import nothing has the digest of its files alone.
The digest is computed at every read and nothing is kept between reads, so any changed, added, removed or renamed file is refused as `PROVIDER_DIGEST_MISMATCH` at the next read, and so is a package whose directory is missing or cannot be read.

### C-94 (normative): A package's identity is its package.json and its manifest, as its lock entry names them

A package holds `package.json` and its manifest, `libredb-provider.json`, at the root of its directory.
Its `package.json` is at most 1 MiB and its manifest at most 2 MiB, each UTF-8 JSON without a byte order mark and a JSON object.
The name and version of its `package.json`, the engine ids of its manifest in any order, and its manifest's `runtime.entry` must equal its lock entry's.
Each difference is refused as `PROVIDER_IDENTITY_MISMATCH` naming the field, and a `package.json` or manifest that cannot be read, or whose `engines` or `runtime.entry` is not in its form, is refused naming that file.

### C-95 (normative): A package serves no engine Studio already serves

A package that serves an engine id Studio's bundled catalog serves is refused as `PROVIDER_ID_COLLISION`, so a package never takes over a shipped engine.
Two packages that serve one engine id are both refused as `PROVIDER_ID_COLLISION`, each naming the others by name and version, so the lock's order decides nothing.
Both are read from the lock alone, before any file of the package is read.

### C-96 (normative): A refusal names the package and nothing it holds

Every refusal carries one code of one closed list, `PROVIDER_LOCK_INVALID`, `PROVIDER_PATH_OUTSIDE`, `PROVIDER_DIGEST_MISMATCH`, `PROVIDER_IDENTITY_MISMATCH`, `PROVIDER_ID_COLLISION`, `PROVIDER_CONTRACT_UNSUPPORTED`, `PROVIDER_SCHEMA_INVALID`, `PROVIDER_MODULE_FORMAT`, `PROVIDER_LOAD_FAILED`, `PROVIDER_NATIVE_UNSUPPORTED`, `PROVIDER_RECORD_INVALID` and `PROVIDER_CATALOG_CONFLICT`, and one rule of that code's closed list, in a sentence on one line.
The rules of `PROVIDER_SCHEMA_INVALID` and `PROVIDER_RECORD_INVALID` are the SDK's own lists, and admission's refusal names the first one, with the manifest pointer for a schema rule, and how many more there are, never a key the package chose.
A package's refusal names the package by the name and version its lock entry gives, and never carries a file name inside its directory, a value of its `package.json` or its manifest, or an engine id.
A package the lock refuses also carries the engine ids its lock entry names, which the operator wrote, not the package, so the server answers those engines as unavailable, C-107.
No step of the lock's read imports or runs a package's code, and admission imports it only after the checks C-97 orders.

### C-97 (normative): A locked package is admitted in a fixed order, and none of its code runs before its manifest, format, closure and native checks pass

A package that passed its lock is admitted in this order, and its first refusal ends it: its manifest's bytes and their binding to the lock's listing, its contract, the schema and the SDK's rules, C-98; the engine ids it serves, C-100; its entry's module format, C-101; its TypeScript files and its import closure, C-102; native addons, C-103; then its import and its record, C-104.
A package refused before its import is never imported, so none of its code runs.
A package refused after its import has run its top level, is never registered and serves no engine.
The entry module is read by the runtime's loader, not by admission, so a change to it after the lock's read is not seen; the providers directory must be writable only by the operator, C-93.
Admission grants no claim: a package carries no grant in this contract, so every claim of its engines is read as M-54 reads a claim with neither a record nor a grant, at its restrictive value, whatever the manifest requests.
A package passing every step is answered with Studio's record of it, and admission registers nothing: boot registers it once, under its name, when the catalog's set rules keep it, C-105.

### C-98 (normative): The manifest is read as bytes, for Studio's contract, by the SDK's validator

Admission reads `libredb-provider.json` as bytes within 2 MiB, never by importing it, and its SHA-256 must be the one the lock's listing holds, or the package is refused as `PROVIDER_DIGEST_MISMATCH`.
A contract of the envelope's form other than Studio's, `0.1`, is refused as `PROVIDER_CONTRACT_UNSUPPORTED` before the schema is applied, and the refusal names Studio's contract, not the manifest's.
The SDK's validator then applies the schema and its code rules, the same rules Studio's generator admits its own engine declarations by, and a refusal is `PROVIDER_SCHEMA_INVALID`.
The manifest admitted is deep-frozen.

### C-99 (normative): A package's named functions are read for their form only

Admission binds no function name through any of Studio's function tables and reads no table keyed by an engine id, so an engine Studio does not ship is never refused because such a table lacks its id.
Its SQL writing names are read for their form, and Studio composes no SQL writing row for its engine, S-16.

### C-100 (normative): A package serves no engine another serves, in Studio's catalog or in this process

A package is refused as `PROVIDER_ID_COLLISION` when it serves an engine id Studio's bundled catalog serves, an engine id a package registered earlier in the same process serves, or an engine id that names a member every JavaScript object inherits, such as `constructor`, and when a package of its name was registered earlier in the process.
Each names its own rule.
The engine ids and the name a package registered earlier serves are checked before the import and again by `registerAdmission` right before registration, with nothing awaited between that check and the registration, so of two admitted packages registered in one process the one that would register second is refused, after its import.

### C-101 (normative): The entry is an ES module

The entry is an ES module when its name ends in `.mjs`, or in `.js` and the nearest `package.json` from its directory up to the package's root declares `"type": "module"`.
The lookup stops at a directory named `node_modules` without reading a `package.json` there, as Node.js's package scope lookup does, so a `.js` entry below such a directory is an ES module only when a `package.json` below it declares the type, whatever the root declares.
Any other entry is refused as `PROVIDER_MODULE_FORMAT` before the import, and so is one whose nearest `package.json` is over 1 MiB or not a JSON object.
A module's syntax is never read to decide.

### C-102 (normative): Every module of a package imports only what its own directory holds or a built-in

The lock command records, with Bun's transpiler, every static import of every file of the package whose name ends in `.js`, `.mjs` or `.cjs` in any letter case: import declarations, re-exports, and `import()` and `require()` of a string.
A file of any other extension is listed and covered by the digest, but not scanned.
Each import is recorded with its kind: `require` for a `require()` call, `import` for the rest.
The record is in the lock, covered by its digest, C-93, and the command refuses a module file it cannot parse or that is not UTF-8, a specifier outside printable ASCII without spaces or over 1,024 characters, more than 4,096 imports in a package, and a lock over 1 MiB.
Before the import, admission refuses as `PROVIDER_MODULE_FORMAT` with the rule `typescript-module` a package whose listing holds a TypeScript file, one whose name ends in `.ts`, `.mts`, `.cts` or `.tsx` in any letter case, a declaration file ending in `.d.ts`, `.d.mts` or `.d.cts` among them, whatever its imports.
Bun maps an extensionless, a `.d` and a `.js` specifier onto a TypeScript file and runs it, so `import "./types.d"` runs `types.d.ts` and its runtime imports, and Bun's transpiler drops a type-only import, `import { type B } from "y"`, which Node.js's type stripping keeps as `import {} from "y"` and loads.
A TypeScript file inside a package could therefore run unseen on either runtime, and a package of this contract is a JavaScript bundle, which holds none.
Admission then requires each recorded import to be a built-in of the runtime that imports the package, or a relative path that stays inside the package's directory and holds no `%`, `?`, `#` or backslash.
Every bare specifier is refused, whether an `import` or a `require` names it and whatever `node_modules` folder the package holds, because Node.js's CommonJS resolver, Bun's, and Bun's ES module resolver move on to the next `node_modules` directory up, outside the package, when the folder found first lacks the file.
A package of this contract is a bundle whose static imports are relative paths inside it or built-ins, and bare specifiers are refused until a later milestone designs dependency resolution for packages.
Anything else, an absolute path, a URL, another scheme or a subpath import among them, is refused as `PROVIDER_LOAD_FAILED` with the rule `closure-outside`.
The kind of each import stays in the record, as what the scanner saw, and no rule of admission reads it.
The limits: a computed `import()` or `require()` is not recorded; the `main` of a package.json, which a `require` of a directory reads, is not read; a file a module loads by another extension is not scanned, such as a `.txt` or extensionless file a `require` names, which Node.js's CommonJS loader runs as JavaScript, or a `.wasm` module.
The check keeps a package from depending on modules outside its directory, Studio's own `node_modules` among them; it is no sandbox, since an admitted package runs in Studio's process.

### C-103 (normative): A native addon is not admitted in this contract yet

A package holding a file whose name ends in `.node`, in any letter case, or whose manifest declares `runtime.native`, is refused as `PROVIDER_NATIVE_UNSUPPORTED` before the import.

### C-104 (normative): The record a package exports is the manifest it declared

A loader refusal is the package's `PROVIDER_LOAD_FAILED` with the loader's reason as its rule, and the value an entry threw is kept for the host's log only, never in the refusal.
The record's manifest must equal the manifest file, compared by the own data properties of plain objects and arrays, key order aside, without calling a getter or reading a Proxy, or the package is refused as `PROVIDER_RECORD_INVALID`.
An implementation or one of its segments that is a Proxy is refused as `PROVIDER_RECORD_INVALID` before the SDK's check, which would run its traps.
The SDK's `checkProviderModule`, Studio's copy, then checks the record, and a refusal is `PROVIDER_RECORD_INVALID` naming its rule.
Studio then freezes the implementation and its segments and answers its own record of them with the manifest it validated, which boot registers, C-105.

### C-105 (normative): Boot admits each locked package once, after the host core and before anything is served

On the standalone server, `register()` admits the providers directory's packages once per process, after it installs the host core and before governance, the banner and the samples.
With no providers directory set, no lock is read and no validator is compiled.
A lock refused as a whole, a set directory that does not exist among them, stops the boot with exit 1 and a line naming the lock and the rule.
Otherwise each package the lock verified is admitted in the lock's order, one at a time, its import under a deadline of 10 s, with one manifest validator compiled from the SDK's schema text, whose digest the validator checks.
The catalog's set rules, C-106, then run over every admitted package, and only the packages they keep are registered, so the loader's registry and the server's catalog name the same packages.
Each refused package is logged once with its sentence, and a value its entry threw only as the logged error, never in the sentence.
An import that settles after its deadline is logged by its package and never registered.
A synchronous hang at import blocks the boot, C-37.

### C-106 (normative): The server's engine catalog is Studio's bundled catalog and the admitted packages' engines, composed once

The server's engine catalog is composed once at boot and read through one accessor, `serverEngine`, which answers a bundled type id first, so a package never shadows a bundled engine, then an engine an admitted package serves, then an engine only refused packages name, and refuses anything else as before.
Every lookup is a `Map` lookup, so a type that names an `Object.prototype` member is unknown.
For a package's engine the catalog holds its catalog entry, its connection tables, its field rules and Studio's grant of each claim, and no SQL writing, connection form, connection string, grammar, migration DDL or generator row, so a request that needs one is refused by name.
Its field rules are composed from its declaration, and a rule naming a check refuses a field holding a value with core's sentence naming the field, since Studio binds no function of a package, C-99.
Every claim is granted by Studio's grant reader against Studio's record, which holds no row for a package's engine, so each claim is at its restrictive value, M-53 and M-54.
The set rules over the whole set, the engine id, the fence alias, the query dialect, the tab type and the editor language, refuse every admitted claimant as `PROVIDER_CATALOG_CONFLICT`, whatever the order, with Studio's bundled value the reference, and the refusal names the package and the rule and no value of its declaration.
An engine id that is one of Studio's bundled fence aliases is refused under the engine id rule, so no fence tag names a bundled engine and a package's engine.
A package so refused is never registered and serves nothing.
The catalog is held in one place per process, so the module instance boot installs it from and each route's module instance read the same catalog.
A process with no boot admission, the published library and the VS Code backend among them, serves the bundled catalog.
The published `DatabaseType` and `isDatabaseType` are unchanged.

### C-107 (normative): A connection of an engine no admitted package serves names why

A connection of an engine only refused packages name in the lock, a package whose directory is missing among them, is refused as `PROVIDER_UNAVAILABLE`, 503, naming every refusal code and never the package, on every route and at every factory entry point, before any cache, tunnel or build.
An admitted package's engine is served by Test Connection, which validates its connection against the engine's field rules, and is refused on every other request, and at the open of a session, as `PACKAGE_ENGINE_UNSUPPORTED`, 501, until that request serves package engines.
MCP answers both with the same sentences: `list_connections` lists such a connection with no read tool and the sentence as its `unavailable`, every MCP tool refuses it with that sentence before any open, and the open's own checks refuse it as the factory does.
Both are core's error kinds, `provider-unavailable` and `package-engine-unsupported`, E-1.

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
