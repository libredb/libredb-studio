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
A normative clause states a rule, and names what enforces it: a test, by its file and exact title, or a location in the manifest schema, by a JSON Pointer into the schema file.
An informative clause states a limit or an intention that nothing checks yet, and says so.
A clause is normative only when its enforcer exists, so this document never promises what nothing checks.
`tests/unit/provider-contract-clauses.test.ts` fails on a normative clause with no enforcer, on an enforcer that names a missing file, a missing title or a pointer that resolves to nothing, and on a clause id used twice.

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

- test `packages/provider-sdk/tests/manifest/digest.test.ts` "MANIFEST_SCHEMA_SHA256 is the SHA-256 of the schema file's bytes"
- test `packages/provider-sdk/tests/manifest/digest.test.ts` "a schema whose bytes differ is refused before it is parsed, naming both digests"

### M-2 (normative): The types are generated from the schema

The manifest's TypeScript types are rendered from the schema by `scripts/generate-manifest-types.ts` and never written by hand.
The generator reads a closed subset of JSON Schema and refuses any other keyword by name, so a type is never wider than the schema it comes from.
After a schema change, `bun run manifest:types` writes the types again.

- test `tests/unit/provider-sdk/manifest-types.test.ts` "the generated manifest types are what the schema renders"
- test `tests/unit/provider-sdk/manifest-types.test.ts` "rendering refuses a keyword it does not read, naming it"

### M-3 (normative): The schema is closed

Every object the schema defines refuses a key it does not name.
The two exceptions are `vendor`, which holds the package's own keys, and the envelope, which a host reads before it knows which schema applies.

- schema `/additionalProperties`
- schema `/properties/vendor`
- test `packages/provider-sdk/tests/manifest/schema.test.ts` "every object schema is closed except vendor and the envelope"

### M-4 (normative): The envelope is read first

A host reads a manifest's envelope, `{ contract }`, before anything else, and the envelope keeps its shape in every contract.
A manifest whose contract is in the form but is not one the host serves is refused as `PROVIDER_CONTRACT_UNSUPPORTED`, naming the contract it declares, and nothing else of it is read.
A manifest with no contract, or one not in the form, is refused with the schema refusal that says so.

- schema `/$defs/envelope/properties/contract/pattern`
- schema `/properties/contract/const`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a manifest built against another contract is refused as PROVIDER_CONTRACT_UNSUPPORTED without schema refusals"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "the envelope is read first: a missing contract is the only refusal"

### M-5 (normative): Every failure is a named refusal, and no refusal carries a value of the manifest beyond its contract

A manifest the schema does not admit is refused as `PROVIDER_SCHEMA_INVALID`, once per failure, each refusal naming its rule and a JSON Pointer into the manifest, and the key for an unknown or missing one.
The rules are the closed list `SCHEMA_REFUSAL_RULES`, and `refusalSentence` words each in one sentence.
A value that matches none of the shapes a `oneOf` allows is one `no-variant` refusal at its pointer, and the failures of each shape are not reported.
The rules JSON Schema cannot state run only on a manifest the schema admits, each with a rule name of its own.
No refusal and no sentence carries a value of the manifest, except `PROVIDER_CONTRACT_UNSUPPORTED`, which names the contract the manifest declares, a string the envelope holds to the form MAJOR.MINOR.
A sentence quotes a key's name as a JSON string, so a name with a line break or a quote stays one line.
So a refusal can be logged and shown without leaking what a package wrote.

- test `packages/provider-sdk/tests/manifest/validate.test.ts` "no refusal carries a value of the manifest"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a failed variant is one no-variant refusal and nothing under it"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "several failures are each refused, ordered by pointer"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "words each rule in one sentence naming the pointer, and the key where there is one"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "quotes an unknown key as a JSON string, so a key with a line break stays on one line"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "names the contract a manifest declares that the host does not serve"

### M-6 (normative): A package's identity is its package.json

The manifest declares no package name, version, licence or publisher, and no driver list.
Name, version, licence and the Node range are the package's `package.json`, which admission compares with the lock entry.
The publisher is computed from verified provenance and is never declared.
The drivers are the package's `package.json` dependencies and its notices file.

- schema `/additionalProperties`
- test `packages/provider-sdk/tests/manifest/schema.test.ts` "package, name, version and publisher are unknown keys"

### M-7 (normative): Engine ids

An engine id is a lower-case letter followed by up to 31 lower-case letters or digits, and a manifest declares each of its engines once.

- schema `/$defs/engineId/pattern`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "two engines with one id are refused as engine-id-duplicate at the second"

### M-8 (normative): Every engine fact is required

Every fact of an engine declaration is a required key, written as `null`, `false` or an empty list where the engine has none.
So a declaration cannot leave a fact out by omission, and no fact has a default a host fills in.
The connection defaults are the one object whose keys are optional, because each is a value the connection dialog fills in, absent where it fills in nothing.

- schema `/$defs/engineDeclaration/required`
- schema `/$defs/connection/required`
- schema `/$defs/monitoringPanels/required`
- schema `/$defs/facets/required`

### M-9 (normative): Connection fields are the contract's vocabulary, and so are their classes

A connection field is named from the contract's closed vocabulary, `fieldName` in the schema.
Each name is in exactly one class, secret, identity or public, and the class is the contract's, the one Studio's storage layer gives the field, never a manifest's.
So no manifest can call a secret field public.
A field name a package needs and the vocabulary lacks is added by a later contract minor, which also states its class.

- schema `/$defs/fieldName`
- schema `/$defs/secretFieldName`
- schema `/$defs/identityFieldName`
- schema `/$defs/publicFieldName`
- test `tests/unit/db/engine-declarations.test.ts` "the schema's field names are the connection fields and the seed-only fields"
- test `tests/unit/db/engine-declarations.test.ts` "the schema's secret, identity and public lists are the storage layer's classes of those fields"

### M-10 (normative): Every secret field moves the provider cache key

Studio keys the providers it keeps open by the connection, and every field of the secret class is part of that key, whatever a manifest declares.
So a connection whose secret changed is never handed a provider opened under the old one.

- test `tests/unit/lib/db/provider-cache-key.test.ts` "changing any one of them alone changes the key"

### M-11 (normative): The rules of an engine's connection

A refused field is never also one of the engine's fields.
A seed-only field is one of the engine's fields or a seed-only field name of the vocabulary.
A host path field is one of the engine's seed-only fields.

- schema `/$defs/seedOnlyFieldName`
- schema `/$defs/hostPathField`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a refused field that is also declared is refused as refused-field-declared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a seed-only field neither declared nor a seed-only name is refused as seed-only-field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a host path field that is not a seed-only field of its engine is refused as host-path-field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration is held to the rules of its own connection"

### M-12 (normative): A host path field is admitted by core

A host path field names a file on the host Studio runs on.
Core resolves it and refuses one that names Studio's own storage files before the provider is built, and the provider reads only the absolute path core hands it.
Credential material itself never travels as a path field: a path names where the operator keeps it.

- test `tests/unit/lib/db/provider-files.test.ts` "either path naming one of Studio's own storage files is refused by name, with the field and the connection's type, before any provider is built"
- test `tests/unit/lib/db/provider-files.test.ts` "every field HOST_PATH_FIELDS names is a seed-only field, so only an operator's seed file or an embedder's own code names one"

### M-13 (normative): The runtime segment

`runtime.entry` is the package-relative path of the ES module whose default export the loader reads, with no dot segment, so it never names a file outside the package.
A native package is pinned to one exact version, with the platforms it serves, in npm's os, cpu and libc vocabulary, and the Node-API version it is built for.
An environment variable the package reads is declared by name, with the reason it reads it.

- schema `/$defs/runtime/properties/entry/pattern`
- schema `/$defs/nativePackage/properties/version/pattern`
- schema `/$defs/envDeclaration/properties/name/pattern`

### M-14 (normative): Compatibility is a measured claim

A manifest lists the products it was measured against, one entry per product, each naming an engine the manifest declares.
Every declared engine has at least one entry.
An entry claims a range of versions, a list of versions, or a hosted service measured on a date, and lists the versions its tests ran against, each with the image they ran where one exists, pinned by its full SHA-256 digest.
Both ends of a range are tested versions.

- schema `/properties/compatibility`
- schema `/$defs/imageReference/properties/digest/pattern`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine with no compatibility entry is refused as compatibility-engine-missing"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a compatibility entry for an undeclared engine is refused as compatibility-engine-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a range endpoint missing from the tested versions is refused as compatibility-endpoint-untested"

### M-15 (normative): Every shipped engine has a declaration, its authored members written in it and the rest generated from Studio's tables

Every engine Studio ships has an engine declaration, `src/lib/db/engine-declarations/<type-id>.json`, committed.
Its authored members are written in the declaration itself: `id`, `displayName`, `location`, and of `connection` its `fields`, `defaults`, `seedOnly`, `refused`, `connectionString.accepted`, `connectionString.dialogOffersUri`, `connectionString.scheme`, `connectionString.urlTls`, `connectionString.paste`, `connectionString.seedCheck`, `tls`, `readsTrustMaterial`, `dialog`, `hostUriSchemes`, `credentialWarnings`, `fieldRules`, `hostHint`, `hostIdentity`, `import` and `connectBudgetMs`, of `editor` its `commitKeyword`, `consentDeadline`, `fenceAliases`, `dialect` and `language`, of `sqlText` its `readsSqlText`, `grammar`, `updateTarget` and `completion`, and `sqlWriting`.
`scripts/generate-engine-declarations.ts` reads them from the committed file, refuses by name a file that lacks one or whose `id` is not its file name, and writes them back unchanged.
Every other member is generated by that script from the per-engine tables it comes from and from what each engine's provider declares before it connects.
Each declaration is admitted by the schema's `engineDeclaration` and the rules of its own connection.
A census reads each declaration back to every table it came from, with read-back functions of its own, so the schema is shown to hold every fact of those tables without loss.
After a table change, or a change to an authored member, `bun run engines:generate` generates the engine catalog, M-70, the connection tables, M-71, the connection forms, M-72, the connection strings, M-74, the execution UI and fence aliases, M-75, the query dialects, tab type editors and editor languages, M-77, the SQL text, M-78, and the SQL writing, M-79, from the authored members, then the declarations, and then admits every declaration it wrote.
The projections come first because the declaration generator builds each provider through the factory, which builds only an engine the catalog holds.
They read each file's authored members without admitting the whole file, because the validator holds an authored member to generated ones, each host path field to `connection.seedOnly`, and a file whose authored members just changed still holds the generated members the previous ones gave.
The connection's dialog and its field rules are authored beside its fields, so the validator holds each dialog entry and field rule to `connection.fields` within the authored members, and the last step refuses an authored change that leaves them apart, such as a placeable field with no placement.
The run is exact in one pass because the projections read only authored members, which the declaration generator never changes, and its last step admits the whole written set, so it exits 1 with the validator's refusal when the authored members disagree among themselves or when Studio's tables do not follow the authored change.
A function name Studio holds no function for stops the run earlier, at the declaration generator, which loads the modules that compose the connection forms, the connection strings, the SQL grammar and the SQL writing and so refuses the name by name, M-72, M-74, M-78 and M-79.
A new engine's declaration starts as a copy of another engine's file with its authored members written for the new engine, and `bun run engines:generate` then projects it into the catalog, writes every other member and admits it.
A declaration is not a full manifest: the runtime and compatibility segments describe a package and its measurements, which a provider gains when it moves into a package of its own.

- test `tests/unit/db/engine-declarations.test.ts` "the directory holds exactly one declaration per shipped type-id"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration is what the generator builds from its authored members and Studio's tables"
- test `tests/unit/db/engine-declarations.test.ts` "the authored members are the catalog's, the data-only connection members, the connection form's, the connection string's, the editor's commit keyword, consent deadline, fence aliases, dialect and language, the SQL text's members but its redaction, and the SQL writing segment"
- test `tests/unit/db/engine-declarations.test.ts` "a declaration's authored members are its committed file's, and every other member is the tables'"
- test `tests/unit/db/engine-declarations.test.ts` "a committed declaration lacking an authored member, or naming another id than its file, is refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored connection.fields and connection.dialog change in one run: a placeable field added and a placed one removed"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 with the validator's refusal when Studio's tables do not follow an authored change"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 with the validator's refusal when an authored change leaves a placeable field unplaced"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored connection string change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the function when a declaration names a connection string function Studio holds none for"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored execution UI and fence alias change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored dialect row and editor language change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored SQL text change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the function when a declaration names a SQL grammar function Studio holds none for"
- test `tests/unit/db/engine-catalog.test.ts` "the catalog reads only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the connection tables read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the connection forms read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the connection strings read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the execution UI and the fence aliases read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the query editor facts read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the SQL text reads only the members a declaration authors"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration is admitted by the schema's engine declaration and its rules"
- test `tests/unit/db/engine-declarations.test.ts` "the census"
- test `tests/unit/db/engine-declarations.test.ts` "the generated unions are Studio's own types"

### M-16 (normative): Every per-engine table is accounted for

Every per-engine table in Studio's source, outside the provider directory, is either read into the engine declarations or listed with the contract segment it is planned for or the reason Studio keeps it.
A per-engine table here is a module-level variable whose type, written on its declaration or in its initializer (a `satisfies` or `as` type, or the type arguments of `new Map<...>()`), is a `Record`, a mapped type or a `Map` keyed by `DatabaseType`.
A table written as an array of rows, or as an object whose type is only inferred, is outside this clause.
The list is `tests/unit/db/engine-declarations/inventory.ts`.

- test `tests/unit/db/engine-table-inventory.test.ts` "every per-engine table in src is in the inventory"
- test `tests/unit/db/engine-table-inventory.test.ts` "every inventory entry exists"

### M-17 (normative): A package imports only what it declares

A workspace package's source and tests import their own files, Node built-ins, the names their `package.json` declares and `@libredb/provider-sdk`, and its tests may import a Bun runtime module.
No package imports a path into Studio's own source or out of its own directory, so no package depends on another package's internals.
Studio reaches a package only by its package name, never by a path into `packages/`.
A package depends on no other provider package, C-42.

- test `tests/unit/package-imports.test.ts` "the repository's packages import only what they declare"
- test `tests/unit/package-imports.test.ts` "core reaches no workspace package by path"

### M-18 (normative): Package source reads no environment

The source of a provider package, and of the SDK, reads no environment variable, no working directory and no process-global state, and writes nothing to the console.
A provider takes every value from the connection and from what the host passes it.

- test `tests/unit/provider-source-coupling-lint.test.ts` "process.env is refused in provider source, in each form a provider reads it today"
- test `tests/unit/provider-source-coupling-lint.test.ts` "the SDK's source is covered"

### M-19 (normative): The SDK keeps no process-global state

The SDK is loaded once into Studio's process and shared by every provider, so its source declares no module-level `let` or `var`, creates no module-level collection, and never reads `process`.
Each call that compiles a validator builds its own, and two validators share nothing.
A module-level typed array is listed by file and name: the codec's two lookup tables, which nothing writes after load, and its encode buffer, which each call writes before it reads, so no call reads what another left.

- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source declares no top-level let or var"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source creates no top-level Map, Set, WeakMap or WeakSet"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source never reads process"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source's module-level typed arrays are the codec's lookup tables and its encode buffer"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "two validators compiled from the same bytes are independent objects"

### M-20 (informative): Studio never reads `vendor`

`vendor` is the package's own, and Studio reads none of it.
No manifest reader exists in Studio yet, so nothing checks this.

### M-21 (informative): How a host admits a contract

The version rule under "Contract version" is applied by the loader's admission, which does not exist yet.
Until it does, the validator serves exactly one contract, the one its schema names, and refuses every other.

### M-22 (normative): How a package reads its declared environment

A package declares the environment variables it reads in `runtime.env`, so every setting it reads is listable before its code runs.
It reads one only through `ctx.env.get`, which `envReader` builds over the declared names and a function the host passes to read the process environment.
A declared name answers what the host's function reads; any other name is refused by name with an `UndeclaredEnvironmentError`, and the host's function is never called for it.
There is no denylist and no grant: a package reads what Studio's own process reads.

- test `packages/provider-sdk/tests/calls/env.test.ts` "a declared name is read through the host's reader"
- test `packages/provider-sdk/tests/calls/env.test.ts` "an undeclared name is refused by name and never read"
- test `packages/provider-sdk/tests/calls/env.test.ts` "a package that declares no environment reads none"

### M-23 (informative): The validator compiles code

ajv compiles a schema into a JavaScript function, built with `new Function`.
The validator runs on the server and in the kit, never in a browser, so a content security policy there does not apply to it.

### M-24 (normative): A field's label, hint and placeholder

An engine may give any field it takes a label, a hint and a placeholder, each in `connection.dialog`, in a list of entries that each name their field.
A field with no entry keeps Studio's own word: its own label, no hint, and its own example.
An empty placeholder means the field shows no example, which is not the same as having no entry.
Each entry names a field the engine takes, and a list names a field at most once.

- schema `/$defs/connectionDialog`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an empty placeholder is admitted: it means the field shows no example"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "%s for a field the engine does not take is refused as field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "two entries of one list naming one field are refused as dialog-entry-duplicate at the second"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's dialog is held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/db/engine-declarations.test.ts` "connection.dialog.labels, hints and placeholders are the form's"

### M-25 (normative): A field shown under a condition

A field may be drawn only while one other field equals one value, never a list of values or a combination of conditions.
The field a condition reads has no condition of its own, so whether a field is shown never depends on another hidden field.
Where the field read is a select, the value is one of its choices.
A field hidden by its condition is neither drawn nor saved, and core does not require it.
A connection that leaves the field a condition reads absent is read as that field's absent value, which every select a condition reads declares, and an absent value is declared only for a field a condition reads.

- schema `/$defs/fieldCondition`
- schema `/$defs/fieldAbsentValue`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a condition with a second key is refused as unknown-key"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a condition on, or reading, a field the engine does not take is refused as field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a condition reading a field that has a condition of its own is refused as shown-when-chained"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a condition on a select naming a value none of its choices is refused as shown-when-value-not-an-option"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an absent value that is none of its field's choices is refused as absent-value-not-an-option"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an absent value for a field no condition reads is refused as absent-value-unread"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a select field a condition reads with no absent value is refused as absent-value-missing"
- test `tests/unit/db/engine-declarations.test.ts` "a form read from the declaration shows the same fields as the connection form for every value of each controlling field"
- test `tests/unit/lib/db-ui-config.test.ts` "the dialog refuses exactly what core refuses of a required secret"

### M-26 (normative): Where a placeable field is drawn

Every placeable field an engine takes is placed, `open` with the other fields or `advanced` behind Advanced, and only a placeable field is placed.
The placeable fields are the contract's vocabulary, `placeableFieldName` in the schema.

- schema `/$defs/placeableFieldName`
- schema `/$defs/fieldPlacement`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a placement for a field that is not placeable is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a placeable field the engine takes with no placement is refused as placement-missing"
- test `tests/unit/db/engine-declarations.test.ts` "the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select"
- test `tests/unit/lib/db-ui-config-placement.test.ts` "each engine declares a placement for exactly the placeable fields it takes, and no other"

### M-27 (normative): A select's choices

Every select field an engine takes declares its choices, in the order the dialog lists them, each with the value saved and the label drawn, and no two choices of a field share a value.
Only a select field declares choices, and the select fields are the contract's vocabulary, `selectFieldName` in the schema.

- schema `/$defs/selectFieldName`
- schema `/$defs/fieldOptions`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "choices for a field that is not a select are refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a select field the engine takes with no options is refused as options-missing"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "two choices of one field with one value are refused as option-value-duplicate at the second"
- test `tests/unit/db/engine-declarations.test.ts` "the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select"

### M-28 (normative): The dialog's order

An engine may state the order the dialog draws its fields in, naming each field once and only fields it takes.
The fields the order leaves out are drawn after it, and `null` keeps the dialog's own order.

- schema `/$defs/connectionDialog/properties/order`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an order item naming a field the engine does not take is refused as field-undeclared"
- test `tests/unit/db/engine-declarations.test.ts` "connection.dialog.order is the form's dialogOrder"

### M-29 (normative): The Host box's URI schemes

An engine may let its Host box take a pasted `http` or `https` address, which the dialog splits into its host and port.
`connection.hostUriSchemes` lists the schemes in the order the box's refusal names them, and only an engine that takes a `host` field lists any.

- schema `/$defs/hostUriScheme`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "URI schemes on an engine without a host field are refused as host-uri-schemes-without-host"
- test `tests/unit/db/engine-declarations.test.ts` "connection.hostUriSchemes is the form's hostAcceptsUri, in order"

### M-30 (normative): Credential warnings

An engine may warn about a credential in three kinds: `pair`, a published default user and password; `jwt`, a token in the password field that declares no expiry or an access claim named; and `no-secret`, a server that accepts a connection with no password.
Studio frames each warning's sentence with its own words, and reads one record of them both in the connection dialog and when it loads a seed file, where a read-only seed with a declared pair, or without a password where a `no-secret` warning is declared, is refused.
An engine declares at most one `no-secret` warning, and each warning reads only fields the engine takes.

- schema `/$defs/credentialWarning`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "the three credential warning kinds are admitted, a pair with an empty password among them"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a credential warning on a field the engine does not take is refused as credential-warning-field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a second no-secret warning is refused as no-secret-warning-duplicate"
- test `tests/unit/db/engine-declarations.test.ts` "connection.credentialWarnings is the engine's CREDENTIAL_WARNINGS row, and the form reads that same row"
- test `tests/unit/lib/db/credential-warnings.test.ts` "refuses the declared pair with the dialog's own sentence"

### M-31 (normative): A function is named, never carried

The manifest holds no code: where an engine has a function, its declaration names it, and the package exports it.
A name is a lower-case letter followed by up to 63 letters or digits, `functionName` in the schema, and it is local to its engine, so two engines of one package may each have a function of one name.
A package names its functions freely.
Studio's own declarations name each function by the slot it fills: `<field>Check` for a field rule's check, `hostHint`, `hostIdentity`, `importer` for the connection import, `urlTls`, `pasteReader` and `seedCheck` for the connection string's URL TLS reader, paste reader and seed check, `redactionReader` for a command redaction's reader, `formatSegment` and `readQuotedQualifier` for the completion readers, and, for the SQL writing functions, `escapeLiteral`, `unescapeLiteral`, `quoteIdentifier`, `placeholder`, `temporalLiteral`, `insertDocuments`, `boundEdit`, `binaryLiteral`, `rewriteDeclared`, `declareFromSample`, `typedLiteral`, `columnWriters` and `createTableKeyClause` for the create table key's clause, and, for the migration DDL functions, `createTablePrimaryKey` and `createTableForeignKey` for a written CREATE TABLE's key writers, `createTableRefusal` for a refused one's line, `columnDef`, `createIndex`, `dropIndex`, `addForeignKey`, `dropForeignKey`, `addColumn`, `dropColumn`, `modifyColumn` and `dropTable`, and, for the SQL generator forms, `generatorQuote`, `generatorTable`, `generatorSelect` and `generatorSelectList`, and, for the agent overlay, `catalogColumns`, `catalogRelations`, `catalogIndexes` and `catalogStatistics` for the catalog read's composers, `declaredSchema`, `retryMatches`, `retryRewrite` and `mapRows`, `emailShapeTest` and `digitRunShapeTest` for a profile's shape tests, `statisticsBuild`, `captureBuild` and `groundingOverride`.
Studio's census holds every name its declarations give to the very function Studio runs, by identity and never by the function's own name, and finds no function Studio runs that a declaration does not name.
A name in an engine's connection form is bound by Studio's function table, `CONNECTION_FORM_FUNCTIONS` in `src/lib/db/connection-form.ts`, to the function Studio's own source holds for that engine at that slot, M-72, and the table holds exactly the names the committed declarations give.
A name in an engine's connection string is bound the same way by Studio's connection string function table, `CONNECTION_STRING_FUNCTIONS` in `src/lib/db/connection-string/index.ts`, M-74, which holds exactly the names the committed declarations give.
A name in an engine's SQL writing is bound the same way by Studio's SQL writing function table, `SQL_WRITING_FUNCTIONS` in `src/lib/db/sql-writing/index.ts`, M-79, one table per slot, which holds exactly the names the committed declarations give.
Every such table looks a name up through one helper, `src/lib/db/function-table.ts`, so each refuses a name it holds no function for in one sentence.

- schema `/$defs/functionName`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an importer named in another form is refused as pattern-mismatch"
- test `tests/unit/db/engine-declarations.test.ts` "every function a declaration names is, through the census's own resolver, the very function the connection form runs"
- test `tests/unit/db/engine-declarations.test.ts` "every function the connection form holds is named by its engine's declaration, and the resolver names nothing else"
- test `tests/unit/lib/db/connection-form.test.ts` "Studio's function table holds exactly the functions the committed declarations name, each at its own slot"
- test `tests/unit/db/connection-string/compose.test.ts` "Studio's connection string function table holds exactly the functions the committed declarations name, each at its own slot"
- test `tests/unit/lib/db/function-table.test.ts` "a name the table holds for the engine is bound, and any other name is refused by name, an inherited one included"
- test `tests/unit/db/engine-declarations.test.ts` "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/db/engine-declarations.test.ts` "every function a connection string row holds is named by its engine's declaration"
- test `tests/unit/db/engine-declarations.test.ts` "every function a grammar row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/db/engine-declarations.test.ts` "every function a grammar row holds is named by its engine's declaration"
- test `tests/unit/db/engine-declarations.test.ts` "every name an SQL writing declaration states is its member's slot, and Studio's SQL writing function table binds it there to the function the engine's row runs"
- test `tests/unit/db/engine-declarations.test.ts` "every function an SQL writing row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named"
- test `tests/unit/db/sql-writing/compose.test.ts` "Studio's SQL writing function table holds exactly the functions the committed declarations name, each at its own slot"
- test `tests/unit/lib/db/function-table.test.ts` "a slot's table holds each engine's function under the slot's name, and nothing else"
- test `tests/unit/db/engine-declarations.test.ts` "every name a migration DDL declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own module exports there"
- test `tests/unit/db/engine-declarations.test.ts` "every function a migration DDL row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named"
- test `tests/unit/db/engine-declarations.test.ts` "every name an SQL generator declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own module exports there"
- test `tests/unit/db/engine-declarations.test.ts` "every function an SQL generator row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named"
- test `tests/unit/db/engine-declarations.test.ts` "every name an agent overlay declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own overlay module exports there"
- test `tests/unit/db/engine-declarations.test.ts` "every function an engine's server overlay holds is named at its slot by its engine's declaration, and no slot the overlay leaves empty is named"

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

- schema `/$defs/fieldRule`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a field rule for a field the engine does not take is refused as field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "two field rules naming one field are refused as field-rule-duplicate at the second"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a field rule that states nothing is refused as field-rule-empty"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a character range whose minimum exceeds its maximum is refused as char-range-inverted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's field rules and host readers are held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/db/engine-declarations.test.ts` "connection.fieldRules are the form's fieldRules, each pattern by its source and flags"
- test `tests/unit/db/engine-declarations.test.ts` "a form whose rules are read from the declaration refuses exactly what the connection form refuses"
- test `tests/unit/lib/db-ui-config.test.ts` "connectionFieldRefusal checks charRange after format"
- test `tests/unit/lib/db-ui-config.test.ts` "the dialog refuses exactly what core refuses of a required secret"
- test `tests/unit/lib/db/connection-field-rules.test.ts` "its run-time graph reaches no React, component, provider or Node built-in module"
- test `tests/unit/lib/db/connection-field-rules.test.ts` "fieldRuleRefusal answers what connectionFieldRefusal answers on the engine's form entry, and refuses a type outside the union by name"
- test `tests/unit/lib/db/connection-field-rules.test.ts` "a field holding null holds no value: its required rule refuses it and no other check reads it"
- test `tests/unit/db/connection-field-rules/provider-acceptance.test.ts` "every connection the shared field rules refuse, its engine's provider refuses before it opens a socket"
- test `tests/unit/db/connection-field-rules/provider-acceptance.test.ts` "each engine's base connection passes its provider's checks and reaches the loopback socket"
- test `tests/api/db/test-connection-field-rules.test.ts` "Test Connection's route refuses exactly the connections the dialog refuses, with the dialog's sentence, over every engine's field rules"
- test `tests/api/db/test-connection-field-rules.test.ts` "every connection the dialog lets through reaches the tunnel and the build on Test Connection's route"
- test `tests/unit/lib/api/test-connection.test.ts` "a connection its engine's field rules refuse is refused with the rule's sentence before the tunnel opens or anything is built, and its statement was not sent"

### M-34 (normative): A bounded pattern

A field rule's format is a bounded pattern: a regular expression's `source`, of 1 to 512 characters, and its `flags`, the empty string or `u`.
The pattern compiles as JavaScript's `RegExp` reads it, with its flags.
A value is tested with `RegExp.prototype.test`, which matches anywhere in it, so a pattern that must match the whole value writes `^` and `$` itself.
The flags `g` and `y` are left out because they make `test` remember where it stopped.

- schema `/$defs/boundedPattern`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a field rule's pattern longer than 512 characters is refused as out-of-range"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a field rule's pattern with a flag other than u is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a pattern that does not compile is refused as pattern-invalid"
- test `tests/unit/db/engine-declarations.test.ts` "connection.fieldRules are the form's fieldRules, each pattern by its source and flags"

### M-35 (informative): Backtracking is not checked yet

A pattern's author keeps it free of catastrophic backtracking, but the validator of this contract does not check it.
Every pattern Studio declares is, by its census, the source and flags of a pattern its dialog runs today, and each was measured to run in time linear in the length of its input.
No package Studio does not ship is admitted before contract 1.0, and a regular expression analyzer will check every pattern before one is.

### M-36 (normative): The Host text readers

An engine may name a host hint, `connection.hostHint`, which answers from the text in the Host box a sentence the dialog draws in place of the static Host hint while it answers one.
An engine may name a host identity, `connection.hostIdentity`, which answers the server a Host text names, so the dialog tells whether a pasted connection string names the server already in the box or another one, whose credentials it then drops.
Only an engine that takes a `host` field names either.

- schema `/$defs/connection/properties/hostHint`
- schema `/$defs/connection/properties/hostIdentity`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a host hint named in another form is one no-variant refusal"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a host reader on an engine without a host field is refused as host-reader-without-host"
- test `tests/unit/db/engine-declarations.test.ts` "every function a declaration names is, through the census's own resolver, the very function the connection form runs"
- test `tests/unit/db/engine-declarations.test.ts` "connection.hostHint, hostIdentity and import are the form's, the import with its label"
- test `tests/components/ConnectionModal.test.tsx` "draws no Port box, lets the Account span the row, and shows the host Studio connects to"
- test `tests/components/ConnectionModal-snowflake.test.tsx` "a second paste naming another account drops the first account's token, database and schema"

### M-37 (normative): The connection import

An engine may offer an import, `connection.import`: the label of the dialog's import action and an importer, a named function that reads a pasted text into entries, one of which fills the form.
The importer never throws, and none of its sentences quotes the text it reads.
The dialog offers the import only for a new connection, never while it edits a saved one.

- schema `/$defs/connectionImport`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an import without its importer is refused as missing-key, and a label longer than 128 characters as out-of-range"
- test `tests/unit/db/engine-declarations.test.ts` "every function a declaration names is, through the census's own resolver, the very function the connection form runs"
- test `tests/components/ConnectionModal-kubeconfig.test.tsx` "the entry declares it, and its loader resolves to the browser importer itself"
- test `tests/unit/lib/connection-import-declaration.test.ts` "is declared by exactly the listed entries"
- test `tests/unit/lib/kubernetes/kubeconfig-import.test.ts` "never throws, whatever the text"
- test `tests/unit/lib/kubernetes/kubeconfig-import.test.ts` "a context that cannot be imported is refused by its place, never by a value"

### M-38 (normative): A refused field's sentence

Each entry of `connection.refused` names a field the engine refuses and the sentence core refuses a connection that sets it with, which names the field and never its value.
Core refuses a connection that sets a refused field before it builds any provider, with the sentence of the first such field in the order of the list, so no provider receives one.
A field is set when the connection holds it with a value other than nothing, null and the empty string, and a list names a field at most once.

- schema `/$defs/refusedField`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a refused entry without its sentence is refused as missing-key"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "two refused entries naming one field are refused as refused-field-duplicate at the second"
- test `tests/unit/db/engine-declarations.test.ts` "connection.refused is the engine's REFUSED_CONNECTION_FIELDS row, each field with its sentence, in the order core checks them"
- test `tests/unit/db/engine-declarations.test.ts` "core refuses a connection that sets a refused field with the sentence its declaration states"
- test `tests/unit/lib/db/provider-connection.test.ts` "the first set field in the row's order answers its sentence"

### M-39 (normative): A connection string's scheme

An engine may state, in `connection.connectionString.scheme`, the one URI scheme shown for it, written in lower case as a URI scheme.
Only an engine whose connection string names a paste reader states a scheme, so every scheme shown is one a paste of it reads.
Studio's map of engine schemes is the schemes the declarations state.

- schema `/$defs/connectionStringOffer/properties/scheme`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a connection string scheme that is not a lower-case URI scheme is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a scheme on an engine whose connection string names no paste reader is refused as scheme-without-paste"
- test `tests/unit/db/engine-declarations.test.ts` "connection.connectionString.scheme is the row's scheme"
- test `tests/unit/db/engine-declarations.test.ts` "ENGINE_URI_SCHEMES is the scheme of each declaration that states one"
- test `tests/components/ConnectionSignature.test.tsx` "shows only schemes parseConnectionString accepts, one per engine that has one"

### M-40 (normative): The paste reader

An engine may read a connection string pasted into the dialog's Paste URL box, and states how in `connection.connectionString.paste`.
The paste names one reader, a function name for three operations.
`claims` answers whether the reader reads a paste, given the paste trimmed with its scheme lower-cased and every character after `://` as typed.
`names` answers whether the paste, trimmed and lower-cased whole, is a spelling the engine connects with, which can be fewer than it claims.
`parse` answers the form's fields, or a refusal naming what to paste instead, and it reads only a text `claims` accepted.
The paste states whether its reader is a catch-all, one that claims generic transport schemes other readers may claim on their own hosts.
The paste states the formats the Paste URL box names for the engine, at least one and each once, and only forms `parse` connects with.
The box lists the formats of every engine in the order the engine picker lists the engines.

- schema `/$defs/connectionStringPaste`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a paste reader named in another form is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a paste with no format is refused as too-few, and one naming a format twice as duplicate"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a paste format longer than 128 characters is refused as out-of-range"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a paste without its catch-all flag is refused as missing-key"
- test `tests/unit/db/engine-declarations.test.ts` "connection.connectionString names a URL TLS reader, a paste reader and a seed check exactly where the row has one, the paste with its catch-all and formats in order"
- test `tests/unit/db/engine-declarations.test.ts` "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/db/connection-string/census.test.ts` "each row is its declaration's connection string composed with Studio's function table"
- test `tests/unit/db/engine-declarations.test.ts` "a parser walking core's paste order over the readers the declarations name parses and detects as the parser does"
- test `tests/unit/db/engine-declarations.test.ts` "the Paste URL box's formats are the declarations' formats in the engine picker's order"
- test `tests/unit/db/connection-string/paste.test.ts` "every row that reads a paste names at least one format"
- test `tests/unit/db/connection-string/paste.test.ts` "the box's list is the rows' formats in the order the engine picker lists them, and nothing else"

### M-41 (normative): The order between paste readers is Studio's

Studio offers a paste to the paste readers in one order it keeps, and the first reader that claims the paste parses it.
Every catch-all reader comes after every other reader.
Studio declares each pair of readers that may both claim a text, with a text both claim, and the order decides which of the two reads it.
A manifest states no order and no pair: one package's claim about another package's spelling is not its to make.

- test `tests/unit/db/connection-string/paste.test.ts` "a catch-all row comes after every row that claims its own spellings"
- test `tests/unit/db/connection-string/paste.test.ts` "each declared overlap names two rows in the order, the first walked first, and its text is claimed by both"
- test `tests/unit/db/connection-string/paste.test.ts` "every pasted fixture has one claimant or a declared pair, and the first is the engine it parsed as"
- test `tests/unit/db/engine-declarations.test.ts` "core's paste order walks exactly the engines whose declaration names a paste reader, every catch-all after the rest"

### M-42 (normative): The URL TLS reader

An engine may name, in `connection.connectionString.urlTls`, a reader of the TLS a URL's query carries.
It reads the query into a TLS mode the connection form can hold, or keeps the parameter as written where no mode expresses it.
It never answers a weaker mode than the engine's own driver applies to the same URL, and never falls to `disable` on a value it does not recognise.
Only an engine whose connection string names a paste reader names one, and that paste reader is what calls it.

- schema `/$defs/connectionStringOffer/properties/urlTls`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a URL TLS reader or a seed check named in another form is one no-variant refusal"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a URL TLS reader on an engine whose connection string names no paste reader is refused as url-tls-without-paste"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's connection string is held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/db/engine-declarations.test.ts` "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/db/connection-string/census.test.ts` "each row is its declaration's connection string composed with Studio's function table"
- test `tests/unit/lib/connection-string-parser.test.ts` "an unrecognised sslmode does not become disable"
- test `tests/unit/lib/connection-string-parser.test.ts` "maps the JDBC/Heroku ssl=true form to verify-system, not to require"
- test `tests/unit/lib/connection-string-parser.test.ts` "refuses to map ssl-mode=PREFERRED"
- test `tests/unit/lib/connection-string-parser.test.ts` "an unrecognised Encrypt does not become disable"

### M-43 (normative): The seed check

An engine may name, in `connection.connectionString.seedCheck`, a check Studio runs when it loads a seed file.
Studio runs it on the fields the file writes for a connection of the engine, before any socket.
The check leaves a field written as a reference unjudged.
Each refusal it answers names a field and a sentence that never quotes the field's value, and Studio refuses the file naming the connection and the field.

- schema `/$defs/connectionStringOffer/properties/seedCheck`
- test `tests/unit/db/engine-declarations.test.ts` "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/db/connection-string/census.test.ts` "each row is its declaration's connection string composed with Studio's function table"
- test `tests/unit/seed/types.test.ts` "refuses an account connect() refuses, naming the entry and the field and never the value"
- test `tests/unit/seed/types.test.ts` "leaves root, and a user written as a reference, to the editor and to the check at open"
- test `tests/unit/seed/types.test.ts` "refuses anything but a list of strings in the table's words, not zod's"

### M-44 (normative): The commit keyword

An engine states, in `editor.commitKeyword`, the one word that keeps an open transaction on it.
When a statement left a transaction open and Studio rolled it back, the notice Studio shows names this keyword, so it tells the user a command their engine has.

- schema `/$defs/editor/properties/commitKeyword`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a commit keyword that is not one word is refused as pattern-mismatch"
- test `tests/unit/db/engine-declarations.test.ts` "editor.commitKeyword and editor.consentDeadline are the engine's EXECUTION_UI row"
- test `tests/unit/db/engine-declarations.test.ts` "executionUiFor answers, for every engine, the spec its declaration states"
- test `tests/unit/db/engine-declarations.test.ts` "every member of an execution UI row has its member in the declaration"
- test `tests/unit/db/execution-ui/census.test.ts` "each row is its declaration's commit keyword and consent deadline, read from the generated execution UI record"
- test `tests/unit/db/execution-ui/shared.test.ts` "the postgres golden names it in the rolled-back notice"

### M-45 (normative): The consent deadline

An engine whose long read ends differently from the others states, in `editor.consentDeadline`, the chip and the sentence the agent's consent card shows for it, and every other engine states null.
The chip is a label in the card's bounds row, and the sentence is the paragraph under the card's box.

- schema `/$defs/consentDeadline`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a consent deadline chip longer than 128 characters or a sentence longer than 2000 is refused as out-of-range"
- test `tests/unit/db/engine-declarations.test.ts` "editor.commitKeyword and editor.consentDeadline are the engine's EXECUTION_UI row"
- test `tests/unit/db/engine-declarations.test.ts` "executionUiFor answers, for every engine, the spec its declaration states"
- test `tests/unit/db/execution-ui/census.test.ts` "the commit keyword and consent deadline rows are the ones today's code has"
- test `tests/unit/db/execution-ui/census.test.ts` "each row is its declaration's commit keyword and consent deadline, read from the generated execution UI record"

### M-46 (normative): Fence tags

A markdown fence tag tells Studio what a fenced block a model wrote holds, and Studio reads a tag lower-cased.
An engine's id is always a fence tag naming that engine, so a manifest never lists it.
An engine lists its other tags in `editor.fenceAliases`.
A tag names at most one engine: an alias is never an engine id of its manifest and is never declared by two of its engines, and across the admitted set Studio's projection refuses the same, M-75.
A generic fence tag is the tag of a language several engines speak; the schema's `genericFenceTag` lists them, and an alias is never one.
An untagged fence and a generic tag hold a query and name no engine, so neither contradicts a connection.

- schema `/$defs/fenceTag`
- schema `/$defs/genericFenceTag`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a fence alias that is not a lower-case tag is refused as pattern-mismatch, one listed twice as duplicate, and a seventeenth as too-many"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a fence alias equal to an engine id of the manifest is refused as fence-alias-engine-id"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a fence alias an earlier engine declares is refused as fence-alias-duplicate at the later"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a generic fence tag declared as an alias is refused as fence-alias-generic"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's fence aliases are held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/db/engine-declarations.test.ts` "editor.fenceAliases are the aliases ALIAS_ENGINES maps to the engine"
- test `tests/unit/db/engine-declarations.test.ts` "ALIAS_ENGINES and QUERY_FENCE_ALIASES are the declarations' aliases and the schema's generic fence tags"
- test `tests/unit/db/engine-declarations.test.ts` "a reader built from the declarations names and admits every fence tag as fenceTagEngine and isQueryFenceTag do"
- test `tests/unit/lib/sql/fence-tags.test.ts` "an alias names the engine it is an alias for"
- test `tests/unit/lib/sql/fence-tags.test.ts` "a generic tag and an absent one name no engine, so they contradict none"
- test `tests/unit/db/engine-catalog.test.ts` "an alias two declarations state, or one equal to another admitted engine id, is refused by name"

### M-47 (informative): Fence tags across packages

Within one manifest the validator refuses an alias two of its engines declare or one equal to one of its engine ids, M-46.
Across the admitted set the fence alias projection refuses both, M-75, so an alias another admitted declaration states, or one equal to another admitted engine id, never reaches a reader.

### M-48 (normative): The explain format

An engine states, in `editor.explainFormat`, the format of its query plans, one of Studio's explain strategies, or null where it offers no explain.
The format stated is the one the provider declares for a connection it has not connected, the one Studio reads before it connects.
Studio's generator reads it in an empty environment with no `.env` file loaded, so a variable that changes what a provider declares, such as `FIRESTORE_EMULATOR_HOST`, never changes a committed declaration.
Studio reads a plan with that format's strategy.

- schema `/$defs/explainFormat`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an explain format outside Studio's strategies is one refusal at the editor's explain format"
- test `tests/unit/db/engine-declarations.test.ts` "editor.explainFormat is the format the engine's unconnected provider declares, null exactly where it supports no explain"
- test `tests/unit/db/engine-declarations.test.ts` "a variable a provider reads before it connects, set where the generator runs, changes no declaration"
- test `tests/unit/db/engine-declarations.test.ts` "the census reads each provider's capabilities in its stated environment, so a variable set where it runs changes none"
- test `tests/unit/db/engine-declarations.test.ts` "every declared explain format has Studio's strategy for it"
- test `tests/unit/db/engine-declarations.test.ts` "the explain formats, the query dialects and the generic fence tags are Studio's"
- test `tests/unit/lib/explain/registry.test.ts` "returns null for undefined (provider without explain support)"

### M-49 (informative): A format measured at connect

A provider may answer another format of the vocabulary, or none, for a connection it measures at connect or configures otherwise, such as a server whose grammar lacks the declared form or an emulator.
No manifest fact states that answer yet, and Studio reads it from the connected provider.

### M-50 (normative): The query dialect

An engine states, in `editor.dialect`, null or one of Studio's query dialects with the answers of its row: whether Profile, the code generator, Generate Count Query and the SQL export formats are offered, and the command-line flags whose values query history never keeps.
The editor opens the engine's tabs under the dialect's name, so a manifest states the name once.
Studio's dialect rows are the projection of the declarations' rows, M-77, every declaration of one dialect stating one row.

- schema `/$defs/queryDialectRow`
- schema `/$defs/historyMask`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a dialect outside Studio's dialects is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a history mask with no flag is refused as too-few, and a flag that is not a long option as pattern-mismatch"
- test `tests/unit/db/engine-declarations.test.ts` "editor.dialect is the provider's query dialect with its QUERY_DIALECTS row"
- test `tests/unit/db/engine-declarations.test.ts` "QUERY_DIALECTS is the dialect rows the declarations state, one per dialect, each opening tabs of its own name"
- test `tests/unit/db/engine-declarations.test.ts` "history keeps no value of a flag the declarations name, as it keeps none of the registry's"
- test `tests/unit/db/engine-declarations.test.ts` "every member of a dialect row has its member in the declaration"
- test `tests/unit/lib/history-mask.test.ts` "a registered dialect answers its record's mask"
- test `tests/unit/db/kubernetes/history-mask.test.ts` "the dialect declares exactly the console's credential flags"
- test `tests/unit/editor/tab-language-registry.test.ts` "resolveTabType answers the registry record's tabType before reading the language"
- test `tests/unit/db/dialect-gates-registry.test.ts` "a record that offers profiling, code generation and a count is offered all three"

### M-51 (normative): The connect budget

An engine states, in `connection.connectBudgetMs`, how long the host waits for an open of the engine and for its Test connection, in milliseconds from the open's start.
The budget is a whole number from 30,000 to 300,000, or null where the engine takes the host's default, `DEFAULT_CONNECT_BUDGET_MS`, 70,000, which `@libredb/provider-sdk/calls` exports.
The minimum is an SSH tunnel's 20 s handshake bound plus 10 s for the connect, so no budget ends an open before a legitimate tunnel could open; the maximum bounds the longest any caller waits for an open to five minutes.
An engine states a budget of its own when its own connect bound at Studio's default statement timeout, plus 10 s for its answer to arrive, is longer than the default, so a provider that bounds its connect answers in its own words before the host does.
Studio's budget for each engine it ships is authored in the engine's declaration, M-15, and read through the engine catalog, M-70.

- schema `/$defs/connectBudget`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a connect budget of null or within 30,000 to 300,000 ms is admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a connect budget below 30,000 ms or above 300,000 ms is refused as out-of-range at the connection's connectBudgetMs"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a connect budget that is not a whole number is refused as wrong-type"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a connection without connectBudgetMs is refused as missing-key"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "the host's default connect budget is 70 s, inside the bounds the schema gives a declared one"
- test `tests/unit/db/engine-declarations.test.ts` "connectBudgetFor answers, for every engine, the budget its declaration states, or the host's default where it states null"
- test `tests/unit/db/connect-budget.test.ts` "the host's default is the pools' 60 s acquire bound plus 10 s"
- test `tests/unit/db/connect-budget.test.ts` "only BigQuery and Snowflake declare a connect budget of their own"
- test `tests/unit/db/connect-budget.test.ts` "the document of each engine that declares a connect budget states it in seconds, and no other provider document states one"
- test `tests/unit/db/bigquery/connect-budget.test.ts` "BigQuery's connect budget covers its connect's dataset list and probe job at the default statement timeout, plus 10 s"
- test `tests/unit/db/snowflake/connect-budget.test.ts` "Snowflake's connect budget covers its connect's two Studio statements at their deadline, plus 10 s"

### M-52 (normative): Claims are requests

An engine states in `policy` and `mcp`, and in the members of its other segments M-53 names, what it asks of the gates Studio decides before or around a provider.
Each such member is a claim: a request, never a fact Studio believes as declared.
A declared fact is a claim when a gate Studio decides reads it, a value lets that gate pass what another value stops on the strength of what the provider or the engine does, and it has a restrictive value; any other declared fact is not a claim.
A fact whose values only add to what a gate stops, from an open-ended vocabulary, such as a credential warning, has no restrictive value and is not a claim, and where it is absent the gate answers at core's own default.
Studio's review record of each claim is the table of Studio's source the declaration is generated from, except the confirmation gate's claims, whose record is `CONFIRMATION_CLAIM_REVIEW` (S-8), and every gate reads that record.
Each per-engine record of a claim Studio keeps in core is written by hand, a literal never computed, so no projection of the declarations can feed one; `CONFIRMATION_CLAIM_REVIEW` is written by hand too.
Only the modules `tests/unit/db/engine-declaration-readers.test.ts` lists read a declaration or a projection of the declarations, and none of them reads a claim, nor is any member a declaration authors a claim, M-15, except the confirmation gate's two, `sqlText.readsSqlText` and an exempt form, which the gate counts only where `CONFIRMATION_CLAIM_REVIEW` lists them, S-8, so a declared claim alone never reaches a gate.
For every engine Studio ships, each request is its record's row.
Read-only enforcement is no member: Studio keeps a connection's read-only mode wherever the write reach is not `open`.
The engines agent and MCP statements run on are Studio's record alone, C-39, and S-8 applies the same rule to the confirmation gate's claims.

- schema `/$defs/policyClaims`
- schema `/$defs/mcpClaims`
- test `tests/unit/db/engine-declarations.test.ts` "every claim of the policy and MCP segments is the row of Studio's review record of it"
- test `tests/unit/db/engine-declarations.test.ts` "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it"
- test `tests/unit/db/engine-declarations.test.ts` "each claim the census reads back is a member of the schema's engine declaration"
- test `tests/unit/db/engine-declarations.test.ts` "agent mode opens a workflow on exactly the engines the declarations' statement languages and readings and Studio's agent execution record give it"
- test `tests/unit/db/engine-declarations.test.ts` "READ_ONLY_ENFORCED is true exactly where the declaration's write reach is not open"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration's policy and MCP segments hold exactly the claims Studio keeps a review record of"
- test `tests/unit/db/engine-declarations.test.ts` "MCP serves statements on exactly the engines the declarations' claims and Studio's agent execution record give it"
- test `tests/unit/db/engine-declaration-readers.test.ts` "only the modules DECLARATION_READERS lists read an engine declaration or a projection of the declarations"
- test `tests/unit/db/engine-declaration-readers.test.ts` "no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record"
- test `tests/unit/db/engine-declaration-readers.test.ts` "the scan finds each way a module could read a declaration or a projection, and passes over a backticked path in a comment"
- test `tests/unit/db/engine-declaration-readers.test.ts` "every claim record Studio keeps in core is written by hand, so no projection of the declarations can feed one"
- test `tests/unit/db/engine-declaration-readers.test.ts` "the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module and the SQL grammar, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW"
- test `tests/unit/mcp/served-engines.test.ts` "an engine agent mode does not execute on is not served, whatever its rows say"
- test `tests/unit/db/write-reach-capability.test.ts` "READ_ONLY_ENFORCED, now derived from the record, answers what it answered before, bar the flipped entries"

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
`connection.serverLevelWithoutDatabase`: true, so a governance definition that names no database is never granted; its record is `OPENS_SERVER_LEVEL_WITHOUT_DATABASE`.
`connection.sshTunnel`: refused, so a connection whose tunnel is on is refused before any cache lookup or dial; its record is `SSH_TUNNEL_REFUSAL`.
`connection.agentCredential`: null, so a seed's agent credential is refused at load; its record is `SEED_AGENT_CREDENTIAL`.
`agent.statementLanguage`: null, so no statement workflow opens in agent mode and MCP serves no statement on the engine; its record is `AGENT_STATEMENT_LANGUAGE`.
`facets.agentReadings`: empty, so the operations workflow does not open in agent mode and every reading is refused before a provider is acquired; its record is the `agentReadings` of the engine's `ENGINE_FACETS` row.
`sqlText.redaction`: `none`, so the query event log keeps nothing of the statement's text; its record is `SQL_TEXT_REDACTION`.
`policy.agentCredentialForm`: `none`, so every agent credential is refused at every agent acquisition; its record is `AGENT_CREDENTIAL_FORM`, whose null row a declaration writes `pair`.
`policy.maskingExemptColumns`: null, so every column the masking rules match stays masked; its record is `MASKING_EXEMPT_COLUMNS`.
`agent.overlay.dialect.catalogRead.commandShaped`: false, so the statement fence admits no composed catalog command and refuses it as it refuses the model's; its record is the engine's server overlay in Studio's agent overlay registry.
Every restrictive value is a request the schema admits.

- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a policy and an MCP segment at every claim's restrictive value are admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine whose connection, facets, agent and SQL text claims are at their restrictive values is admitted"
- test `tests/unit/seed/types.test.ts` "refuses readOnly: true on every engine whose write reach is open, naming the type and the field"
- test `tests/isolated/factory.test.ts` "a databend connection with readOnly: true is refused before anything is built (Databend design 5.7)"
- test `tests/unit/lib/db/provider-cache-key.test.ts` "a non-admin (deny) DuckDB handle keys apart from an admin (allow) one, so they never share a handle"
- test `tests/unit/db/refuses-denied-file-access.test.ts` "SQLite refuses a handle opened with file access denied, and DuckDB confines one"
- test `tests/unit/lib/db/provider-cache-key.test.ts` "an owner appends a framed segment, no owner is byte-identical, and duckdb and libredb ignore the owner"
- test `tests/unit/seed/types.test.ts` "refuses mcp: true without read roots, at the mcp field, and loads it with them"
- test `tests/api/agent/runs.test.ts` "an OPC UA run that sends statements is refused on a connection without read roots, before a run exists"
- test `tests/unit/seed/types.test.ts` "refuses only the engine the record answers false for"
- test `tests/unit/mcp/served-engines.test.ts` "an engine MCP is not offered for is not served, whatever its MCP read row says"
- test `tests/unit/mcp/served-engines.test.ts` "an agent engine whose MCP read row is false is not served, though every other record lets it through"
- test `tests/unit/mcp/annotations.test.ts` "answers not read-only and not destructive, closed-world, for a reach holding an engine whose row is true"
- test `tests/unit/seed/types.test.ts` "fails a seed with mcp: true and no agent key, naming mcp and the type"
- test `tests/integration/mcp/context.test.ts` "refuses a connection with no agent credential in Studio's words, naming the connection"
- test `tests/unit/lib/governance/admission.test.ts` "every engine that opens a local file stays ENGINE_UNSUPPORTED, named in GOVERNANCE_ALLOWED_ENGINES or not"
- test `tests/unit/lib/db/provider-files.test.ts` "one of Studio's own files is refused by name with the reserved sentence and the connection's own type"
- test `tests/unit/lib/db/provider-files.test.ts` "either path naming one of Studio's own storage files is refused by name, with the field and the connection's type, before any provider is built"
- test `tests/unit/lib/governance/admission.test.ts` "a postgres definition without database is skipped as SERVER_LEVEL_NOT_ALLOWED"
- test `tests/unit/lib/db/tunnel-decision.test.ts` "%s: a tunnel that is on is refused exactly when its row names a reason"
- test `tests/unit/seed/types.test.ts` "refuses either field on a %s seed, which takes no agent credential"
- test `tests/unit/lib/agent/agent-manifest.test.ts` "%s opens operations and planning, and refuses a statement workflow in agent mode"
- test `tests/unit/lib/agent/agent-manifest.test.ts` "the operations arm refuses an engine the tables leave out of the agent-readings requirement"
- test `tests/unit/lib/query-events/redact.test.ts` "every redaction vector produces its redacted text and fingerprint"
- test `tests/isolated/factory.test.ts` "libredb takes no agent credential and refuses %s before it connects"
- test `tests/unit/components/results-grid-masking-exemption.test.ts` "the rules themselves are untouched: with no declaration the same column is still masked"
- test `tests/unit/lib/agent/composed-catalog-admission-drive.test.ts` "an overlay that does not declare its catalog read a command gets the ordinary refusal"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a catalog read that claims no command, the claim's restrictive value, is admitted"

### M-54 (informative): How a host grants a claim

A host reads each claim as the more restrictive of the manifest's request and the grant.
The grant is the row of Studio's review record for the engine, or an operator's audited grant for the package, and the claim's restrictive value, M-53, where neither exists.
So a restrictive request is read as made, a looser one only as far as a grant allows, and a declared claim alone never loosens a gate.
A write reach request is capped at the grant: a request of `none` on an engine whose record grants `guarded` is read as `guarded`.
A set of things a gate admits, refuses or keeps apart, `connection.hostPathFields`, is read as the union of the request and the grant, and a set of things a gate offers, `facets.agentReadings`, as their intersection.
A claim whose values M-53 does not order, such as two statement languages, two agent credential forms or two redactions other than `none`, is read as its grant where the request equals it, and at its restrictive value otherwise.
An SSH tunnel request that is refused keeps its own sentence, a request offered against a refused grant takes the record's sentence, and one offered where no grant exists takes the host's own sentence.
A record whose rows are declared beside each provider or engine in Studio's source, `ENGINE_FACETS` and the agent overlay registry, is Studio's review record while those rows are outside any provider package.
The `sqlText.redaction` row is kept in `SQL_TEXT_REDACTION`, a core record keyed by the engine and written by hand, its command reader held by name and bound through Studio's grammar function table, since Studio's SQL grammar is projected from the declarations, M-78.
The change that moves a provider whose row records a claim into a package, or the first change that makes Studio read that claim from a declaration, whichever comes first, keeps the claim's row in a core record keyed by the engine, so a package never carries its own grant.
Studio reads no declaration's claims yet, M-52, so nothing checks this rule, and the change that first makes Studio read them applies it and adds its enforcer.

- test `tests/unit/db/engine-declaration-readers.test.ts` "every claim record Studio keeps in core is written by hand, so no projection of the declarations can feed one"
- test `tests/unit/db/sql-grammar/compose.test.ts` "the redaction is the record's row, a command reader bound through the function table, never the entry's"
- test `tests/unit/db/engine-declarations.test.ts` "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it"

### M-55 (normative): The rules of an engine's claims

A statement read is claimed only for an engine its MCP claims expose.
An agent credential is required only of an engine whose seeds take one, `connection.agentCredential`.
An agent credential a seed takes is in the form the agent credential form request names, M-58: for the pair request, the seed form `pair`, an `agentUser` and an `agentPassword` together; for the dedicated user's request, the seed form `dedicated-pair`, an `agentUser` and an `agentPassword` together whose `agentUser` is not the connection's own `user`, compared without case or surrounding space where neither is written as a reference; and for the token and service-account key requests, the seed form `secret`, an `agentPassword` alone with no `agentUser`.
A request of `none` refuses every agent acquisition, so it is held to no seed form.
Read roots are required only of an engine whose seed-only fields name `agentReadRoots`.
A denied file access refusal is stated only for an engine that reads the file-access posture.
The rules check requests, never a host's reading of them: a request of every policy and MCP claim at its restrictive value meets them where the engine's connection allows it.
An engine a host reads as requiring an agent credential it takes none of is closed to MCP.

- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a statement read on an engine not exposed to MCP is refused as statement-read-unexposed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an agent credential required of an engine whose seeds take none is refused as agent-credential-form-missing"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a seed agent credential whose form is not the one the agent credential form request names is refused as agent-credential-seed-form-differs, a request of none excepted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "read roots required of an engine whose seeds cannot declare them are refused as read-roots-field-undeclared"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a denied file access refusal on an engine that reads no file-access posture is refused as denied-file-access-unread"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's claims are held to the rules the schema cannot state, at pointers into it"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a policy and an MCP segment at every claim's restrictive value are admitted"

### M-56 (normative): The trust material a provider is handed

An engine whose provider's TLS library does not read Node.js's trust store states `connection.readsTrustMaterial: true`, and its provider is handed the CA certificates of the file `NODE_EXTRA_CA_CERTS` names, as data.
Every other engine states false and is handed nothing.
No gate reads it, the material is the operator's public certificates, and a provider that needs it and does not ask fails to verify, never verifies less, so it is not a claim.

- schema `/$defs/connection/properties/readsTrustMaterial`
- test `tests/unit/db/engine-declarations.test.ts` "connection.readsTrustMaterial is the engine's READS_TRUST_MATERIAL row"
- test `tests/security/provider-trust-material.test.ts` "READS_TRUST_MATERIAL names db2 alone, the engine whose TLS the probe found outside Node's trust store"
- test `tests/security/provider-trust-material.test.ts` "a caller's trust in the execution context never reaches a provider"

### M-57 (normative): A built provider's own declaration of a claim this clause names reaches no gate

A provider's capabilities restate, once it is built, some claims an engine declaration requests: its write reach on each write path, whether it reads the file-access posture, whether it keeps one handle per file, the form the agent's own credential takes, the result columns it exempts from the masking rules, and whether it opens a session per database a caller names.
Studio's gates read each from Studio's review record of the claim, never from the provider.
Read-only mode reads `WRITE_REACH`, the file-access posture's cache key and borrow read `READS_FILE_ACCESS_POSTURE`, the provider cache key's owner and the single-writer borrow read `SINGLE_WRITER_FILE`, and every agent acquisition reads the agent credential's shape from `AGENT_CREDENTIAL_FORM`, null where the provider declares no form.
Studio's producers of client capabilities, `readProviderDeclarations` and the VS Code backend's connection description, answer the masking exemption from `MASKING_EXEMPT_COLUMNS`, absent where its row is null, in place of the provider's own, so the browser and the webview read Studio's record at `capabilities.maskingExemptColumns`, and a client with no answer yet exempts nothing.
Catalog sessions, `catalogSessions`, are answered per connection, so no record replaces the provider's answer, and Studio bounds it instead.
The places that honour a caller's choice of database, `scopeToCatalog` (every editor route, the VS Code backend and MCP through it), `providerInDatabase` and the agent runs route, read it through `catalogChoice`, only where `OPENS_SERVER_LEVEL_WITHOUT_DATABASE` holds the engine and the connection names no database and no connection string, and otherwise refuse the choice, saying why.
`assertNotWholeServer` reads the provider's own answer, since there a declaration only refuses more.
So none of these claims moves a gate on the provider's word, as a claim a declaration requests never does, M-52.
For every engine Studio ships, each provider's own declaration is its record's row, and its catalog sessions are honoured exactly where it declares them.

- test `tests/isolated/factory.test.ts` "a form a provider declares that Studio's record does not hold is never read: the record's pair refuses an agent secret alone"
- test `tests/isolated/factory.test.ts` "the form Studio's record holds is read when the provider declares none: Kubernetes takes an agent token alone"
- test `tests/isolated/factory.test.ts` "a provider that declares singleWriterFile on an engine Studio's record does not name registers no file, and no other connection is lent its handle"
- test `tests/isolated/factory.test.ts` "Studio's record registers the file of a single-writer engine whose provider declares nothing, and another connection on the file is lent the open handle"
- test `tests/isolated/factory.test.ts` "a masking exemption a provider declares that Studio's record does not hold is never read: readProviderDeclarations answers none"
- test `tests/isolated/factory.test.ts` "the masking exemption Studio's record holds is read when the provider declares none: Modbus answers its address column"
- test `tests/api/db/provider-meta.test.ts` "a masking exemption a provider declares that Studio's record does not hold never reaches the browser"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a masking exemption the provider declares that Studio's record does not hold is not in the description"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "the description answers Studio's record of the masking exemption where the provider declares none"
- test `tests/unit/db/agent-credential-capability.test.ts` "%s: AGENT_CREDENTIAL_FORM is the form its provider declares, null where it declares none"
- test `tests/unit/db/compatibility.test.ts` "SINGLE_WRITER_FILE matches the engines whose capabilities declare singleWriterFile"
- test `tests/unit/db/write-reach-capability.test.ts` "%s: the record answers the summary of its provider's declaration"
- test `tests/unit/db/reads-file-access-posture-capability.test.ts` "%s: the map answers what its provider declares"
- test `tests/unit/db/masking-exemption-guard.test.ts` "%s: MASKING_EXEMPT_COLUMNS is the exemption its provider declares, null where it declares none"
- test `tests/unit/db/catalog-scope.test.ts` "catalogChoice honours catalog sessions only where the provider declares them, Studio's record holds the engine, and the connection names no database"
- test `tests/unit/db/catalog-scope.test.ts` "a provider that declares catalog sessions on a connection naming a database is refused a catalog by name, and no session opens"
- test `tests/unit/db/catalog-scope.test.ts` "a provider that declares catalog sessions on an engine Studio's record does not hold is refused a catalog by name, and no session opens"
- test `tests/unit/db/catalog-scope.test.ts` "assertNotWholeServer refuses a provider that declares catalog sessions, whatever Studio's record and the connection say"
- test `tests/unit/mcp/database-choice.test.ts` "a provider that declares catalog sessions on a connection naming a database is read as it is, and another database is refused by name"
- test `tests/unit/mcp/database-choice.test.ts` "a provider that declares catalog sessions on an engine Studio's record does not hold is read as it is, and a database is refused by name"
- test `tests/api/agent/runs.test.ts` "a provider that declares catalog sessions on a connection naming a database is not read: a catalog is refused by name, and a run without one starts"
- test `tests/api/agent/runs.test.ts` "a provider that declares catalog sessions on an engine Studio's record does not hold is not read: a catalog is refused by name"
- test `tests/api/db/query.test.ts` "a provider that declares catalog sessions on a connection naming its database runs nothing in another: the catalog is refused by name"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a provider that declares catalog sessions on a connection naming its database runs nothing in another catalog, and the refusal says why"
- test `tests/unit/db/compatibility.test.ts` "%s: Studio honours catalog sessions exactly where its provider declares them, with and without a database"

### M-58 (normative): The agent credential form an engine requests

`policy.agentCredentialForm` is one of the forms Studio's agent credential takes, with `pair` for the user and password together, the form Studio's record writes null.
The secret-only forms and the dedicated user's are the record's own forms, named as the record names them.
Every agent acquisition reads the record, M-57, and a host reads the request against it, M-54.

- schema `/$defs/agentCredentialFormClaim`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an agent credential form outside the claim's values is refused as value-not-allowed, and null as wrong-type beside it"
- test `tests/unit/db/engine-declarations.test.ts` "every claim of the policy and MCP segments is the row of Studio's review record of it"
- test `tests/unit/db/engine-declarations.test.ts` "the generated unions are Studio's own types"
- test `tests/unit/db/agent-credential-capability.test.ts` "%s: AGENT_CREDENTIAL_FORM is the form its provider declares, null where it declares none"

### M-59 (normative): A masking exemption matches whole column names only

The column pattern of `policy.maskingExemptColumns` opens with `^`, closes with a `$` no backslash escapes and no character class holds, keeps every alternative inside a group, and compiles with no flag, the way Studio's masking compiles it.
An unanchored pattern reaches columns other masking rules cover, so an exemption written for one column crosses into a rule it was never about.
The pattern is read as text and never run, so a pattern anchored in each alternative, such as `^a$|^b$`, is refused for the group form `^(?:a|b)$`, which says the same once.

- schema `/$defs/maskingExemption`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a masking exemption or inline edit refusal whose pattern or reason is empty or past its bound is refused as out-of-range"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a masking exemption whose column pattern does not match whole names only is refused as masking-exemption-unanchored"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a masking exemption or inline edit refusal pattern that does not compile is refused as pattern-invalid"
- test `tests/unit/db/masking-exemption-guard.test.ts` "an unanchored pattern reaches into a rule it was never about"

### M-60 (normative): An engine's safeguards are its provider's own statements

The `safeguards` segment states what the provider's code does: the reach of each write path, the metadata-only answer of its read path, and the result columns its inline editor refuses.
No gate of Studio reads a safeguard, so none is a claim, M-52, and a review reads them as the evidence of the policy claims.
For every engine Studio ships, the census reads each safeguard back to the provider's own capabilities.
A provider that declares no write reach is stated open on every path, the reading Studio gives that absence.
A fact a provider answers only for a connection, or one that waits for a chapter not yet in this contract, is not a member.

- schema `/$defs/safeguards`
- test `tests/unit/db/engine-declarations.test.ts` "every fact of the safeguards segment is its provider's own declaration"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration's safeguards segment holds exactly the facts the census reads back to the providers"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "the machine redaction, billed compute and the write paths are no claims, each refused as unknown-key where it is not a member"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's safeguards and its new claims are held to their rules, at pointers into it"

### M-61 (normative): The write paths and the write reach they sum to

Each of the four write paths is absent, gated with the gate that refuses every write there while read-only mode holds, or open.
An absent editor path names the structural proof that keeps it so.
A gate or a proof names a module by its path relative to the root of the package declaring the engine, under `src/`, with no dot segment and ending in `.ts`, and an export by its name.
`policy.writeReach` is the summary of the paths: `open` where any path is open, else `guarded` where any is gated, else `none`.
A request at M-55's restrictive values meets this rule only where the write paths still sum to its write reach.

- schema `/$defs/writePaths`
- schema `/$defs/writePathProof`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a write path that is not one of the three reaches, or whose gate or proof is not a .ts module under src with an export name, is refused as no-variant at the path"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a write reach claim that is not the summary of the engine's write paths is refused as write-reach-summary-differs"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an absent editor write path that names no proof is refused as editor-write-path-unproven"
- test `tests/unit/db/engine-declarations.test.ts` "the validator admits a write reach claim exactly where it is Studio's summary of the write paths"
- test `tests/unit/db/write-reach-proofs.test.ts` "every write-reach gate and proof names a real export"

### M-62 (normative): The metadata-only answer and the inline edit refusal

`metadataOnly` lists each operation the metadata-only read permits, once, in the provider's order, with its columns, each once within its operation, and the kind of fact each holds; it is null where the provider answers as it reads.
`inlineEditRefusedColumns` is a type pattern that compiles with no flag, the way the inline editor compiles it, and the reason a refused cell shows, or null.

- schema `/$defs/metadataOnlyOperation`
- schema `/$defs/inlineEditRefusal`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a metadata-only answer with no operation or an operation with no column is refused as too-few, and a kind outside name, count and flag as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a metadata operation or column name outside its pattern is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a metadata operation named twice is refused as metadata-operation-duplicate, at the later one"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a column named twice in one metadata operation is refused as metadata-column-duplicate, and the same column in two operations is admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a masking exemption or inline edit refusal pattern that does not compile is refused as pattern-invalid"

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

- schema `/$defs/maintenanceSpec`
- schema `/$defs/facets/properties/maintenanceSpecs`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a maintenance spec whose label, title or description is empty or past its bound is refused as out-of-range"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a maintenance spec for an operation the maintenance facet does not list is refused as maintenance-spec-unlisted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a maintenance operation given two specs is refused as maintenance-spec-duplicate, at the later one"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a listed maintenance operation with no spec is refused as maintenance-spec-missing, at the operation"
- test `tests/unit/db/engine-declarations.test.ts` "facets.maintenanceSpecs is its provider's own maintenance specs, one for each operation its facet lists, in the facet's order"
- test `tests/unit/db/engine-declarations.test.ts` "maintenanceControl and declaredEntityOperations answer from each declaration what they answer from its provider, for every operation, placement and kind"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration's maintenance specs hold exactly Studio's spec members and the operation they name"
- test `tests/unit/db/engine-declarations.test.ts` "a provider's maintenance spec missing for a listed operation, or given for an unlisted one, is refused by name, by the generator and by the census"
- test `tests/api/db/maintenance.test.ts` "non-admin user returns 403"
- test `tests/components/admin/OperationsTab.test.tsx` "confirming sends exactly one request for the whole database"
- test `tests/components/admin/OperationsTab.test.tsx` "kill button opens confirmation dialog"

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

- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a maintenance spec that places its operation nowhere is refused as maintenance-spec-unplaced, and kill's is admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a typed confirmation is admitted only on a spec placed over the whole database alone, with a title and a description, and refused elsewhere as maintenance-typed-confirmation-unasked"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a typed target is admitted only on a spec placed on a row alone, and refused elsewhere as maintenance-typed-target-unasked"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a maintenance preview no per-row control shows is refused as maintenance-preview-unplaced"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's maintenance specs are held to their rules, at pointers into it"
- test `tests/api/db/maintenance.test.ts` "an operation that takes no target refuses a request that names one"
- test `tests/api/db/maintenance.test.ts` "an operation that requires a target refuses a request without one"
- test `tests/api/db/maintenance.test.ts` "kill keeps its session-id target, which neither placement describes"
- test `tests/components/admin/OperationsTab.test.tsx` "a typed-target control sends nothing until the row's own name is typed exactly, then sends once"
- test `tests/components/admin/OperationsTab.test.tsx` "a whole-database card with a typed confirmation still asks for the connection's name, not a row's"

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

- schema `/$defs/agentOverlay`
- schema `/$defs/agent/properties/overlay`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an agent overlay member Studio's declaration has no place for is refused as unknown-key"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine that speaks a statement language with no agent overlay is refused as agent-overlay-missing"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an agent overlay on an engine that speaks no statement language is refused as agent-overlay-unspoken"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an SQL engine with no dialect is refused as agent-dialect-missing"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a dialect on an engine of another family is refused as agent-dialect-unspoken"
- test `tests/unit/db/engine-declarations.test.ts` "the server registry holds each engine module's overlay, member by member"
- test `tests/unit/db/engine-declarations.test.ts` "every data member of each declared dialect is what the server registry's dialect holds, null where it is unsupported"
- test `tests/unit/db/engine-declarations.test.ts` "every engine's server facet, through runServerPack, is its family's with exactly the derivations its declaration names"
- test `tests/unit/db/engine-declarations.test.ts` "each engine's family and client dialect, through the client registry, are its declared language and the client view of its declared dialect"
- test `tests/unit/db/engine-declarations.test.ts` "the SQL catalog and composer requirements and the composed capture hold on exactly the engines whose declared dialect supplies them"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration's agent overlay holds exactly the members of the schema's overlay and SQL dialect"
- test `tests/unit/db/engine-declarations.test.ts` "an agent overlay member the declaration has no place for, a grounding given as a value, and a pattern flag it does not take are refused by name by the generator"
- test `tests/unit/db/engine-declarations.test.ts` "agent mode opens a workflow on exactly the engines the declarations' statement languages and readings and Studio's agent execution record give it"

### M-68 (normative): The SQL dialect

Its catalog read names a composer per catalog kind, an optional schema fold, an optional retry and an optional row mapper, and says whether its statement is a command.
Its estimating plan is a prefix that opens with EXPLAIN and holds no word that executes the plan, or a session mode, since one strip built from every engine's prefix serves every engine.
Its profile names two shape tests and the type patterns of the columns it leaves out.
Its statistics name a builder and an optional probe and note.
Its capture lists the catalog kinds it reads in order, a builder, and the engine's words for the object kinds the provider declares, each word once.
A member is null where the engine composes none.
A statistics reading or a capture is stated only beside a catalog read.

- schema `/$defs/sqlDialect`
- schema `/$defs/catalogRead`
- schema `/$defs/planEstimatePrefix`
- schema `/$defs/captureKindWord`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an estimating plan that is neither an EXPLAIN prefix nor the session mode is refused as no-variant"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a statistics reading without a catalog read is refused as statistics-without-catalog-read"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a catalog capture without a catalog read is refused as catalog-capture-without-catalog-read"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a kind word given twice is refused as capture-kind-word-duplicate, at the later one"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an estimating prefix that executes the plan is refused as plan-estimate-prefix-executes"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a profile type pattern that does not compile is refused as pattern-invalid"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's agent overlay is held to its rules, at pointers into it"
- test `tests/unit/lib/agent/engine-overlays.test.ts` "an engine that reads statistics also reads its catalog, since the statistics read is a catalog kind"
- test `tests/unit/lib/agent/engine-overlays.test.ts` "an engine that captures its catalog also composes every kind it captures"

### M-69 (normative): A composed statement meets the statement fence

Every statement a dialect composes is checked as a statement the model wrote is.
The catalog read and its statistics kind are checked as a bounded read, the estimating plan and the profile as a bounded read that refuses plan execution, and the statistics probe as a plain read.
So a dialect widens what agent mode composes on an engine it already runs on, never where it runs or what the fence admits.
The one exception is a catalog read whose statement is a command: the fence admits that one statement by identity, still refusing a comment or a word with a side effect, and the claim is `commandShaped`, M-53.

- test `tests/unit/db/operations/statement-guard.test.ts` "only the plan-execution schema admits EXPLAIN ANALYZE"
- test `tests/unit/db/operations/statement-guard.test.ts` "the query read admits the statement the server composed, though its verb is no read"
- test `tests/unit/db/operations/statement-guard.test.ts` "the same text with no admission is refused as it always was"
- test `tests/unit/db/operations/statement-guard.test.ts` "an admission a caller wrote itself is refused, as any text a model sends would be"
- test `tests/unit/db/operations/statement-guard.test.ts` "only the query read takes an admission: plan inspection and the profile keep the strict read input"
- test `tests/unit/db/operations/statement-guard.test.ts` "only the catalog read mints an admission, for the catalog statement itself or for its statistics kind"
- test `tests/unit/lib/agent/composed-catalog-admission-drive.test.ts` "the identical command written by the model is refused before it is sent, as it always was"
- test `tests/unit/lib/agent/elasticsearch-catalog-read.test.ts` "each composed command is admitted by identity, and refused as model text"
- test `tests/unit/db/engine-declarations.test.ts` "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it"

### M-70 (normative): Studio's engine catalog is projected from the admitted declarations

Which engines Studio ships, whether each is an engine the user already runs or the store Studio carries with it, and each engine's connect budget are the engine catalog: the projection of the declarations `scripts/generate-engine-catalog.ts` admits.
The command's `--check` admits every committed declaration through the SDK's `compileManifestValidator` and holds the generated module to the projection of the admitted set, and refuses by name an entry that is not a `.json` file, a file that is not JSON, a declaration the schema refuses and a declaration whose `id` is not its file name.
Its `--write` projects each file's authored members without admitting the whole file, M-15, and refuses by name the same entries, a file that lacks an authored member and a file whose `id` is not its file name; `bun run engines:generate` runs `--check` once the declarations are written.
The projection, `projectCatalog` in `src/lib/db/engine-catalog/projection.ts`, reads only each declaration's authored members, M-15, holds one entry per id, keyed in ascending id order, and is a pure function of the set: the same set gives the same catalog whatever order it is admitted in, and two declarations of one id are refused by name.
The projection is rendered into one generated module, `src/lib/db/engine-catalog/catalog.generated.ts`, held byte for byte to what the command renders and typed as a record over `DatabaseType`, so a member of the union with no declaration fails the typecheck there.
Every reader of the catalog, in the browser, the server, the VS Code extension and the published library, reads that module through `SHIPPED_DATABASE_TYPES`, `EXTERNAL_DATABASE_TYPES`, `isExternalDatabaseType` and `connectBudgetFor`; no module of Studio's runtime reads a declaration file.
Removing an engine's declaration gives exactly the catalog a fresh build from the remaining set gives, and a stored connection of an engine the catalog no longer holds stays in the user's list, shown as Unavailable.

- test `tests/unit/db/engine-catalog.test.ts` "the catalog holds one entry per declaration, keyed in ascending id order whatever order they come in"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the catalog reads only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "every committed declaration is admitted through the SDK's digest-checked validator before it is projected"
- test `tests/unit/db/engine-catalog.test.ts` "a declaration the schema refuses, one whose id is not its file name, and a stray entry are each refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "--write's authored members of a declaration the validator refuses until its generated members are rewritten"
- test `tests/unit/db/engine-catalog.test.ts` "the committed catalog module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale catalog module, --write writes it, and anything else is refused with the usage line"
- test `tests/unit/db/engine-catalog.test.ts` "SHIPPED_DATABASE_TYPES is the catalog's engines in its order"
- test `tests/unit/db/engine-catalog.test.ts` "EXTERNAL_DATABASE_TYPES and isExternalDatabaseType answer the location each declaration authors"
- test `tests/unit/db/engine-declarations.test.ts` "connectBudgetFor answers, for every engine, the budget its declaration states, or the host's default where it states null"
- test `tests/unit/db/engine-projections-removal.test.ts` "the fixture engine's declaration is admitted by the schema's engine declaration and its rules"
- test `tests/unit/db/engine-projections-removal.test.ts` "the catalog built with the fixture engine holds it, and with it removed is exactly a fresh build from the remaining set and the committed catalog"
- test `tests/unit/db/engine-projections-removal.test.ts` "the catalog is the same whatever order the declarations are admitted in"
- test `tests/unit/db/engine-projections-removal.test.ts` "a stored connection of an engine the catalog no longer holds is kept and shown as Unavailable"

### M-71 (normative): Studio's data-only connection tables are projected from the admitted declarations

Each engine's connection fields, seed-only fields, refused fields, credential warnings, trust material answer and connection string answers are the connection tables: `CONNECTION_FIELDS`, `SEED_ONLY_FIELDS`, `REFUSED_CONNECTION_FIELDS`, `CREDENTIAL_WARNINGS`, `READS_TRUST_MATERIAL`, `CONNECTION_STRING_ACCEPTED` and `CONNECTION_FORM_URI_MODE`.
They are the projection of each admitted declaration's `connection.fields`, `seedOnly`, `refused`, `credentialWarnings`, `readsTrustMaterial`, `connectionString.accepted` and `connectionString.dialogOffersUri`, members it authors, M-15.
The projection, `projectConnectionTables` in `src/lib/db/engine-catalog/projection.ts`, reads only those members, holds one row per id in ascending id order, an engine with no credential warning holding none, and is a pure function of the set; two declarations of one id are refused by name.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into two modules, each held byte for byte to what the command renders and each table a record over `DatabaseType`: `src/lib/db/engine-catalog/connection-flags.generated.ts` holds the three tables `src/lib/db/compatibility.ts` reads, `READS_TRUST_MATERIAL`, `CONNECTION_STRING_ACCEPTED` and `CONNECTION_FORM_URI_MODE`, and `src/lib/db/engine-catalog/connection.generated.ts` holds the other four, so a reader of `compatibility.ts` loads only the three.
A seed-only refusal is its template with each `{field}`, or each `{id}` and `{type}`, replaced once by its value, so a value holding a placeholder or a replacement pattern is written as it is.
None of these members is a claim, M-52: each gate that reads one reads data a wrong value cannot loosen, or no gate reads it.
Removing an engine's declaration gives exactly the tables a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "the connection tables hold one row per declaration, keyed in ascending id order whatever order they come in"
- test `tests/unit/db/engine-catalog.test.ts` "the connection tables read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the committed connection modules are what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale connection module, and --write writes every projected module"
- test `tests/unit/db/connection-fields/census.test.ts` "a seed-only refusal writes each value in its place once, a value holding a placeholder or a replacement pattern included"
- test `tests/unit/db/engine-declarations.test.ts` "connection.seedOnly is the engine's SEED_ONLY_FIELDS row, and every refusal Studio renders from it is the sentence the table gave"
- test `tests/unit/db/engine-projections-removal.test.ts` "the fixture engine's declaration is admitted by the schema's engine declaration and its rules"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection tables built with the fixture engine hold its rows, and with it removed are exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection tables are the same whatever order the declarations are admitted in"

### M-72 (normative): Studio's connection form is projected from the admitted declarations

Each engine's connection form, what its connection dialog draws apart from its icon and colour, is `CONNECTION_FORM` in `src/lib/db/connection-form.ts`, which `DB_UI_CONFIG` brands with each icon and colour.
It is the projection of each admitted declaration's `displayName` and, of its `connection`, the `defaults`, `tls`, `dialog`, `hostUriSchemes`, `fieldRules`, `hostHint`, `hostIdentity` and `import`, members it authors, M-15.
The projection, `projectConnectionForms` in `src/lib/db/engine-catalog/projection.ts`, reads only those members, holds one entry per id in ascending id order, each member as the declaration states it, a pattern as its source and flags and a function as its name, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/connection-form.generated.ts`, held byte for byte to what the command renders and typed as a record over `DatabaseType`, which only `src/lib/db/connection-form.ts` reads.
`composeConnectionForm` reads each entry into the form the dialog, the factory's required secret check, `providerFields` and the VS Code extension read: each per-field list as a record keyed in field order, each pattern compiled once, each named function bound through Studio's function table, M-31, and the SSL / TLS panel offered where the engine lists a TLS mode, M-73.
A named function is bound to the function Studio's own source holds for that engine at that slot, and a name Studio holds no function for, at that slot, is refused by name when the form is composed, with no default; the forms are composed when the module loads.
None of these members is a claim, M-52: each is presentation, or a field rule or condition that only adds a refusal to the ones core makes, or the TLS modes the engine takes, M-73, which hand its provider the connection's own settings, or an identity reader Studio's own source holds.
Removing an engine's declaration gives exactly the forms a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "the connection forms hold one entry per declaration, keyed in ascending id order whatever order they come in"
- test `tests/unit/db/engine-catalog.test.ts` "the connection forms read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the committed connection form module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale connection form module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer writes a backslash, a character outside ASCII and a number as the formatter leaves them, and refuses a control character by name"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer refuses a line or paragraph separator by name, as it refuses a control character"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer refuses a soft hyphen by name, as it refuses a control character"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer refuses a zero-width character by name, as it refuses a control character"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer refuses a lone surrogate by name, and writes a surrogate pair as itself"
- test `tests/unit/lib/db/connection-form.test.ts` "each entry is its declaration's form members composed with Studio's function table"
- test `tests/unit/lib/db/connection-form.test.ts` "a declaration naming a function Studio holds none for is refused by name when its form is composed"
- test `tests/unit/lib/db/connection-form.test.ts` "a name Studio holds only for another slot is refused by name"
- test `tests/unit/lib/db/connection-form.test.ts` "a form entry for a field the connection dialog does not draw is refused by name when its form is composed"
- test `tests/unit/lib/db-ui-config.test.ts` "Snowflake's declared rule sentences and Sign-in absent value are the account module's own"
- test `tests/unit/lib/db/provider-field-census.test.ts` "providerFields composes each engine's declared connection fields, seed-only fields, accepted connection string and TLS offer, and Studio's tunnel record"
- test `tests/unit/db/engine-declaration-readers.test.ts` "no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection forms built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection forms are the same whatever order the declarations are admitted in"

### M-73 (normative): An engine's TLS modes are data of its declaration

A declaration states in `connection.tls.modes` the TLS modes its engine's provider takes, each once and in the order of the schema's `tlsMode`, and none where the engine offers no TLS, so no surface draws the SSL / TLS panel for it and its provider receives no TLS settings.
Each mode means what Studio's published `SSLMode` in `src/lib/types.ts` says, the same on every engine that lists it, so core never maps one engine's modes onto another's.
A mode outside the vocabulary, a repeated mode and a mode listed after one the vocabulary orders after it are each refused by name, at the mode's own pointer, and a TLS offer stated as a word rather than a list of modes is refused as the wrong type.
The SDK's TLS settings read the same vocabulary: `TlsSettings.mode` is the generated `TlsMode`, which a census holds equal to `SSLMode` in both directions and in its order.
Each of Studio's surfaces that offers a mode offers every mode of the vocabulary today, and every shipped engine that lists any lists them all, which a census holds.

- schema `/$defs/tlsMode`
- schema `/$defs/tlsOffer`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "TLS modes in the provider contract's order, %s, are admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS mode outside the provider contract's modes is refused as value-not-allowed at its own pointer"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS mode listed twice is refused as duplicate at the second"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS mode listed after one the provider contract orders after it is refused as tls-mode-order, at each such mode"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS mode out of order is refused in one sentence naming its pointer and no mode"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS offer stated as the word %s is refused as wrong-type"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a TLS offer with no modes member is refused as missing-key, and one with another member as unknown-key"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the manifest's TLS modes are Studio's published SSL modes, in its order"
- test `tests/unit/db/engine-declarations.test.ts` "connection.tls lists TLS modes exactly where the dialog offers the SSL panel"
- test `tests/unit/lib/db/connection-form.test.ts` "a composed form offers the SSL / TLS panel exactly where its engine lists any TLS mode, one or several"
- test `tests/unit/lib/db/provider-field-census.test.ts` "every engine that lists TLS modes lists each of the provider contract's modes, in its order, and an engine lists none exactly where the dialog offers no SSL / TLS panel"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection forms built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module"

### M-74 (normative): Studio's connection strings are projected from the admitted declarations

Each engine's connection string, `CONNECTION_STRING` in `src/lib/db/connection-string/index.ts`, which the paste parser, the login signature's scheme map, the seed loader and the VS Code extension read, is the projection of each admitted declaration's `connection.connectionString` scheme, URL TLS reader, paste and seed check, members it authors, M-15.
The projection, `projectConnectionStrings` in `src/lib/db/engine-catalog/projection.ts`, reads only those members, holds one entry per id in ascending id order, each member as the declaration states it and a function as its name, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/connection-string.generated.ts`, held byte for byte to what the command renders and typed as a record over `DatabaseType`, which only `src/lib/db/connection-string/index.ts` reads.
`composeConnectionString` reads each entry into the row its readers read: the scheme as declared, and each named function bound through Studio's connection string function table, `CONNECTION_STRING_FUNCTIONS`, M-31, to the function Studio's own source holds for that engine at that slot, the paste reader's three operations beside the declared catch-all flag and formats.
A name Studio holds no function for, at that slot, is refused by name when the module loads, with no default.
None of these members is a claim, M-52: the scheme is presentation, a paste reader and a URL TLS reader fill the dialog's fields in the browser and decide nothing on the server, and a seed check only refuses earlier what the provider or the agent profile's proof refuses again when the connection opens, and binds only to Studio's own function, so a declaration chooses between Studio's reviewed check and none.
Removing an engine's declaration gives exactly the connection strings a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "the connection strings hold one entry per declaration, keyed in ascending id order whatever order they come in"
- test `tests/unit/db/engine-catalog.test.ts` "the connection strings read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the committed connection string module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale connection string module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored connection string change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the function when a declaration names a connection string function Studio holds none for"
- test `tests/unit/db/connection-string/census.test.ts` "each row is its declaration's connection string composed with Studio's function table"
- test `tests/unit/db/connection-string/census.test.ts` "each function the table binds for an engine is the export of that engine's own module"
- test `tests/unit/db/connection-string/compose.test.ts` "a declaration naming a function Studio holds none for is refused by name when its connection string is composed"
- test `tests/unit/db/connection-string/compose.test.ts` "a name Studio holds only for another slot is refused by name"
- test `tests/unit/db/connection-string/compose.test.ts` "Studio's connection string function table holds exactly the functions the committed declarations name, each at its own slot"
- test `tests/unit/db/engine-declaration-readers.test.ts` "no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection strings built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the connection strings are the same whatever order the declarations are admitted in"

### M-75 (normative): Studio's execution UI and fence aliases are projected from the admitted declarations

Each engine's execution UI, `EXECUTION_UI` in `src/lib/db/execution-ui/index.ts`, the commit keyword the rolled-back notice names, M-44, and the consent card's deadline, M-45, is the projection of each admitted declaration's `editor.commitKeyword` and `editor.consentDeadline`, members it authors, M-15.
The fence aliases `fenceTagEngine` and `isQueryFenceTag` read, `ALIAS_ENGINES` and `QUERY_FENCE_ALIASES` in `src/lib/sql/fence-tags.ts`, are the projection of each admitted declaration's `editor.fenceAliases`, a member it authors, M-15, each alias mapped to its engine.
The projection, `projectEditorFacts` in `src/lib/db/engine-catalog/projection.ts`, reads only those members, holds one execution UI entry per id in ascending id order and one alias entry per alias, in ascending id order and then each declaration's own order, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
Before it builds any entry it refuses by name an alias two declarations state, naming both engines, and an alias equal to another admitted declaration's engine id, the rules across the set that admitting each declaration on its own cannot see, M-47.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/editor.generated.ts`, held byte for byte to what the command renders and typed as records over `DatabaseType`.
An engine's id names that engine as a fence tag through the catalog, M-70, so no list of engine ids is kept, and the generic fence tags, M-46, are Studio's own record of the schema's, keyed by its vocabulary, so a tag the schema adds fails Studio's typecheck until Studio lists it.
None of these members is a claim, M-52: the commit keyword and the consent deadline are text Studio shows, and a fence tag decides only whether a fenced block is offered to the editor and which block a plan run records, and nothing runs on that answer without the confirmation gate.
Removing an engine's declaration gives exactly the execution UI and fence aliases a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "the execution UI holds one entry per declaration and the fence aliases one per alias, keyed in ascending id order whatever order they come in"
- test `tests/unit/db/engine-catalog.test.ts` "the execution UI and the fence aliases read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "an alias two declarations state, or one equal to another admitted engine id, is refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the committed editor module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale editor module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored execution UI and fence alias change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the alias when two declarations state one fence alias"
- test `tests/unit/db/engine-declarations.test.ts` "a committed declaration lacking an authored member, or naming another id than its file, is refused by name"
- test `tests/unit/db/engine-declarations.test.ts` "ALIAS_ENGINES and QUERY_FENCE_ALIASES are the declarations' aliases and the schema's generic fence tags"
- test `tests/unit/db/engine-declaration-readers.test.ts` "no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record"
- test `tests/unit/db/engine-projections-removal.test.ts` "the execution UI and the fence aliases built with the fixture engine hold its entries, and with it removed are exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the execution UI and the fence aliases are the same whatever order the declarations are admitted in"

### M-76 (normative): An agent reading's panel is offered

An engine lists in `facets.agentReadings` a reading read through a monitoring panel, as `AGENT_READING_PANELS` names it, only where its `facets.monitoring` offers that panel, since the host refuses every panel call for a panel the session's engine does not offer, C-71.
A reading whose panel the engine does not offer is refused as `agent-reading-panel-not-offered`, at the reading's own pointer, in a sentence naming that pointer and no value.
`health`, which the mandatory health call serves, is admitted whatever the panels.
Every engine Studio ships satisfies the rule, which its census holds.

- schema `/$defs/agentReading`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an agent reading whose monitoring panel the engine does not offer is refused as agent-reading-panel-not-offered"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "the health reading and a reading whose panel the engine offers are admitted"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration is admitted by the schema's engine declaration and its rules"
- test `tests/unit/db/engine-facets/census.test.ts` "every agent reading is the kind of a panel the row offers, or health"

### M-77 (normative): Studio's query dialects, tab type editors and editor languages are projected from the admitted declarations

`QUERY_DIALECTS` in `src/lib/db/query-dialects.ts`, `DIALECT_EDITORS` in `src/lib/editor/dialect-editors.ts`, and the accent and console of each language of `EDITOR_LANGUAGES` in `src/lib/db/editor-language/index.ts` are the projection of each admitted declaration's `editor.dialect` and `editor.language`, members it authors, M-15.
The declaration generator holds both to the query dialect and the query language the engine's provider declares, and refuses a difference by name.
The projection, `projectQueryEditorFacts` in `src/lib/db/engine-catalog/projection.ts`, reads only those members and holds one dialect row per stated dialect, its tab type the dialect's name and every member present, one editor per tab type, the tab type its tabs open under by S-23's rule, and one language entry per Monaco id, each keyed in ascending order, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
Before it builds any entry it refuses by name a dialect stated with different rows, a tab type stated in different languages and a language stated with a different accent or console, naming both engines, the rules across the set that admitting each declaration on its own cannot see.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/query-editor.generated.ts`, held byte for byte to what the command renders and typed over Studio's query dialects, tab types and Monaco languages, which stay closed vocabularies.
Each of Studio's languages is its own code, keyed by its Monaco id, composed when its module loads with the accent and console the declarations state: a stated language Studio holds no code for, a language no declaration states and a console the two disagree on are refused by name, with no default.
None of these members is a claim, M-52: the row menus, the export menu and the tab's language are offers and presentation, the profile route's language check protects no interest M-52 names, and the history mask only adds to what history drops.
Removing a declaration gives exactly the query dialects, tab type editors and editor languages a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "the query dialects, the tab type editors and the editor languages hold one entry per stated key, keyed in ascending order whatever order the declarations come in"
- test `tests/unit/db/engine-catalog.test.ts` "the query editor facts read only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations of one engine id are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "two declarations stating one dialect with different rows, one tab type in different editor languages, or one editor language with a different accent or console are refused by name"
- test `tests/unit/db/engine-catalog.test.ts` "the committed query editor module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale editor module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored dialect row and editor language change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the editor language when two declarations state it with different accents"
- test `tests/unit/db/engine-declarations.test.ts` "a committed declaration lacking an authored member, or naming another id than its file, is refused by name"
- test `tests/unit/db/engine-declarations.test.ts` "the generator refuses, by name, a declaration whose query dialect or query language is not the one its provider declares"
- test `tests/unit/editor/editor-language-registry.test.ts` "composeEditorLanguages gives each of Studio's languages the accent and console the declarations state, in the code's order"
- test `tests/unit/editor/editor-language-registry.test.ts` "composeEditorLanguages refuses by name a stated language Studio holds no code for, a language no declaration states, and a console the code and the declarations disagree on"
- test `tests/unit/editor/editor-language-registry.test.ts` "composeEditorLanguages refuses by name a code row or a console that names another Monaco id"
- test `tests/unit/db/engine-declaration-readers.test.ts` "no listed reader reads a claim, so a declared claim reaches a gate only through Studio's review record"
- test `tests/unit/db/engine-projections-removal.test.ts` "the query dialects, the tab type editors and the editor languages built with the fixture engine are the committed module's, and with it or the only declaration of a dialect, tab type and language removed are exactly a fresh build from the remaining set"
- test `tests/unit/db/engine-projections-removal.test.ts` "the query dialects, the tab type editors and the editor languages are the same whatever order the declarations are admitted in"

### M-78 (normative): Studio's SQL grammar is projected from the admitted declarations

`SQL_GRAMMAR` in `src/lib/db/sql-grammar/index.ts` is composed from each admitted declaration's `sqlText.readsSqlText`, `grammar`, `updateTarget` and `completion`, members it authors, M-15.
The projection, `projectSqlText` in `src/lib/db/engine-catalog/projection.ts`, reads only those members and holds one entry per declaration, each as the declaration states it, a clause as its source and flags and a function as its name, keyed in ascending id order, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/sql-text.generated.ts`, held byte for byte to what the command renders and typed over `DatabaseType`, a record only the SQL grammar's module reads.
Each row is composed when that module loads: the grammar is the declaration's facts in its member order, each fact stated at the reading its absence has left out, S-4, and each trailing limit clause compiled once; each function the declaration names is bound through Studio's grammar function table, `SQL_GRAMMAR_FUNCTIONS`, and a name it holds no function for at that slot is refused by name, with no default.
The redaction is never read from a declaration: it is the engine's row of `SQL_TEXT_REDACTION`, Studio's hand-written review record of the claim, its command reader bound through the same table, M-53 and M-54.
`readsSqlText: false` and an exempt form are claims the confirmation gate counts only where `CONFIRMATION_CLAIM_REVIEW` lists them, S-8, and every other member is read as declared.
Removing a declaration gives exactly the SQL text a fresh build from the remaining set gives.

- test `tests/unit/db/engine-catalog.test.ts` "projectSqlText answers each declaration's SQL text but its redaction, frozen, in ascending id order"
- test `tests/unit/db/engine-catalog.test.ts` "the SQL text reads only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the committed SQL text module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale editor module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored SQL text change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the function when a declaration names a SQL grammar function Studio holds none for"
- test `tests/unit/db/sql-grammar/compose.test.ts` "each row is its declaration's SQL text composed with Studio's record of its redaction"
- test `tests/unit/db/sql-grammar/compose.test.ts` "a grammar fact at the reading its absence has is left out, and every other fact is the declaration's"
- test `tests/unit/db/sql-grammar/compose.test.ts` "each trailing limit clause is compiled once, when its row is composed"
- test `tests/unit/db/sql-grammar/compose.test.ts` "the rows, their grammars and their lists are frozen"
- test `tests/unit/db/sql-grammar/compose.test.ts` "a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included"
- test `tests/unit/db/sql-grammar/compose.test.ts` "Studio's grammar function table holds exactly the functions the committed declarations and the redaction record name, each at its own slot"
- test `tests/unit/db/sql-grammar/compose.test.ts` "the redaction is the record's row, a command reader bound through the function table, never the entry's"
- test `tests/unit/sql/confirmation-claim-review-gate.test.ts` "mongodb and redis text is not read as SQL"
- test `tests/unit/db/engine-declaration-readers.test.ts` "the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module and the SQL grammar, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW"
- test `tests/unit/db/engine-projections-removal.test.ts` "the SQL text built with the fixture engine holds its entry, and with it removed is exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the SQL text is the same whatever order the declarations are admitted in"

### M-79 (normative): Studio's SQL writing is projected from the admitted declarations

`SQL_WRITING` in `src/lib/db/sql-writing/index.ts` is composed from each admitted declaration's `sqlWriting`, a segment it authors, M-15.
The projection, `projectSqlWriting` in `src/lib/db/engine-catalog/projection.ts`, reads only that segment and holds one entry per declaration, each as the declaration states it, a type pattern as its source and flags and a function as its name, keyed in ascending id order, frozen at every level, and is a pure function of the set; two declarations of one id are refused by name.
It is rendered by the command M-70 names, from the same authored members and held by the same admission, into `src/lib/db/engine-catalog/sql-writing.generated.ts`, held byte for byte to what the command renders and typed over `DatabaseType`, a record only the SQL writing module reads.
Each row is composed when that module loads: each type name list is a set in its declared order, each type pattern is compiled once, S-15, and each function the declaration names is bound through Studio's SQL writing function table, `SQL_WRITING_FUNCTIONS`, one table per slot, a name it holds no function for at that slot refused by name, with no default.
A function stated null is left out of the row, or is the row's null where the row's member takes one, `placeholder` and `temporalLiteral`.
The segment holds no claim, M-52, so every member is read as declared.
Removing a declaration gives exactly the SQL writing a fresh build from the remaining set gives.

- test `tests/unit/db/engine-declarations.test.ts` "the authored members are the catalog's, the data-only connection members, the connection form's, the connection string's, the editor's commit keyword, consent deadline, fence aliases, dialect and language, the SQL text's members but its redaction, and the SQL writing segment"
- test `tests/unit/db/engine-catalog.test.ts` "projectSqlWriting answers each declaration's SQL writing, frozen, in ascending id order"
- test `tests/unit/db/engine-catalog.test.ts` "the SQL writing reads only the members a declaration authors"
- test `tests/unit/db/engine-catalog.test.ts` "the committed SQL writing module is what the generator renders from the admitted declarations"
- test `tests/unit/db/engine-catalog.test.ts` "the renderer writes a line feed as its escape and refuses every other character it does not quote"
- test `tests/unit/db/engine-catalog.test.ts` "--check names a stale editor module, and --write writes every projected module"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate regenerates an authored SQL writing change in one run"
- test `tests/unit/db/engine-catalog.test.ts` "bun run engines:generate exits 1 naming the function when a declaration names a SQL writing function Studio holds none for"
- test `tests/unit/db/sql-writing/compose.test.ts` "each row is its declaration's SQL writing composed with Studio's SQL writing function table"
- test `tests/unit/db/sql-writing/compose.test.ts` "a hook the declaration states as null is left out, and a placeholder or temporal literal stated as null is null"
- test `tests/unit/db/sql-writing/compose.test.ts` "each type pattern is compiled once, when its row is composed"
- test `tests/unit/db/sql-writing/compose.test.ts` "the rows and their records are frozen"
- test `tests/unit/db/sql-writing/compose.test.ts` "a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included"
- test `tests/unit/db/sql-writing/compose.test.ts` "Studio's SQL writing function table holds exactly the functions the committed declarations name, each at its own slot"
- test `tests/unit/db/engine-projections-removal.test.ts` "the SQL writing built with the fixture engine holds its entry, and with it removed is exactly a fresh build from the remaining set and the committed module"
- test `tests/unit/db/engine-projections-removal.test.ts` "the SQL writing is the same whatever order the declarations are admitted in"

## Values

A value crosses a JSON boundary, between a provider and the host or between two of the host's own hops, in one form: the value codec of `@libredb/provider-sdk/values`.

### V-1 (normative): One codec, and its tags are the schema's

A value is plain JSON, or a tagged value: an object whose own keys are exactly `$`, the tag, and `v`, its payload.
The tags are the schema's `valueTag`, typed `ValueTag`, and the codec's module comment states the value and the payload of each.
`encodeValue` writes only those tags and `decodeValue` reads only those.

- schema `/$defs/valueTag`
- test `packages/provider-sdk/tests/values/tags.test.ts` "the codec writes and reads exactly the schema's value tags"
- test `packages/provider-sdk/tests/values/tags.test.ts` "a tag the schema does not name is refused on decode"

### V-2 (normative): Every tag round-trips

A value the codec encodes decodes to the same value, an object member left out under V-9 aside, and a JSON value with no tagged kind crosses unchanged.

- test `packages/provider-sdk/tests/values/codec.test.ts` "every bigint from -2^63 to 2^64 - 1 round-trips as its decimal digits"
- test `packages/provider-sdk/tests/values/codec.test.ts` "every Uint8Array and Buffer round-trips as canonical base64, byte for byte"
- test `packages/provider-sdk/tests/values/codec.test.ts` "every valid Date round-trips as its toISOString text, the range ends included"
- test `packages/provider-sdk/tests/values/codec.test.ts` "NaN, Infinity and -Infinity round-trip as their words"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a JSON value with no tagged kind passes through both ways unchanged"

### V-3 (normative): Nothing a database hands back is read as a tag

A data object whose own keys are exactly `$` and `v` is written as the escape tag, so an object with those two keys on the wire is always a tag.

- test `packages/provider-sdk/tests/values/codec.test.ts` "an object whose keys are exactly $ and v round-trips at any depth and is never read as a tag"
- test `packages/provider-sdk/tests/values/codec.test.ts` "an object with $ alone or with a third key is not wrapped"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a __proto__ key stays an own key"

### V-4 (normative): The domain is closed, and a refusal never carries the value

The codec refuses every value outside its domain with a `ValueCodecError` that names the kind and the JSON Pointer of the place, never the value.

- test `packages/provider-sdk/tests/values/codec.test.ts` "every value outside the codec's domain is refused by kind, naming its JSON Pointer and never its value"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a bigint outside the 64-bit range is refused, naming its path"
- test `packages/provider-sdk/tests/values/codec.test.ts` "an invalid Date is refused on encode"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a ValueCodecError is an Error with its own name"

### V-5 (normative): Decoding is strict and canonical

A payload in any spelling but the one the encoder writes, an unknown tag, a payload of the wrong type and a value `JSON.parse` cannot produce are each refused on decode.

- test `packages/provider-sdk/tests/values/codec.test.ts` "digits with a plus sign, a leading zero, an exponent, spaces or -0 are refused on decode"
- test `packages/provider-sdk/tests/values/codec.test.ts` "base64 that is malformed, unpadded, URL-safe or non-canonical is refused on decode"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a timestamp that is not exactly toISOString's text is refused on decode"
- test `packages/provider-sdk/tests/values/codec.test.ts` "an obj payload whose keys are not exactly $ and v is refused on decode"
- test `packages/provider-sdk/tests/values/codec.test.ts` "an unknown tag or a payload of the wrong type is refused on decode, naming its path"
- test `packages/provider-sdk/tests/values/codec.test.ts` "decode refuses a value JSON cannot produce"

### V-6 (informative): No tag for a decimal, a date, a time of day or a duration

The codec has no tag for a decimal, a date without a time, a time of day or a duration, because no provider hands it one.
A later minor of the contract adds such a tag together with the provider that needs it.

### V-7 (informative): The codec loads in a browser

The codec uses no Node-only global, so it loads in a browser as well as on the server.
Nothing checks this yet.

### V-8 (normative): Nesting depth is bounded

An array or a data object nested inside `MAX_VALUE_DEPTH` others is refused on encode and on decode with a `ValueCodecError` naming its JSON Pointer, so a deep or cyclic value is refused by name and never overflows the stack.
A tagged value counts as the one value it carries: the wire's tag wrapper adds no level, and an `obj` payload is the data object the bound counts.

- test `packages/provider-sdk/tests/values/codec.test.ts` "a value inside MAX_VALUE_DEPTH arrays and objects round-trips, and one level more is refused on encode and decode, naming its path"
- test `packages/provider-sdk/tests/values/codec.test.ts` "a tagged value adds no level, so the bound counts the value's own arrays and objects"
- test `packages/provider-sdk/tests/values/codec-depth.test.ts` "a value nested far past any stack is refused by the depth rule in a bounded Node child, never a RangeError"

### V-9 (normative): An object member whose value is undefined is left out

An object member whose value is `undefined` is left out on encode, as JSON leaves it out, and the `obj` escape is decided on the members written.
`undefined` at the root or as an array element is refused.

- test `packages/provider-sdk/tests/values/codec.test.ts` "an object member whose value is undefined is left out, and undefined anywhere else is refused"
- test `packages/provider-sdk/tests/values/codec.test.ts` "the obj escape is decided on the members written"

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

- test `packages/provider-sdk/tests/errors/kinds.test.ts` "the kinds a provider raises and the kinds only core raises partition the record's kinds"
- test `tests/unit/db/provider-error-kinds.test.ts` "every error class Studio declares has a kind the contract places"
- test `tests/unit/db/provider-error-kinds.test.ts` "provider code constructs and extends only classes of the kinds a provider may raise"
- test `tests/unit/db/provider-error-kinds.test.ts` "provider code charges the read allowance only where the record names, so its refusal is the one core kind a provider passes on"
- test `tests/unit/lib/db/error-record.test.ts` "every class errors.ts exports has exactly one kind, and no two share one"

### E-2 (normative): A provider's own class takes its nearest contract class's kind

An error class a provider declares takes the kind of the nearest contract class it extends, whatever its own fields say.
Any thrown value that is no contract error is `internal`.

- test `tests/unit/lib/db/error-record.test.ts` "a TransportError answers connection, whatever its own kind field says"
- test `tests/unit/lib/db/error-record.test.ts` "a value that is no error class answers internal"

### E-3 (normative): The record is closed

A record holds `kind` and `code`, and may hold `sqlState`, `engineCode`, `outcome` and `sessionState`, each in its vocabulary or pattern: `ERROR_KINDS`, `SQLSTATE_PATTERN`, `ENGINE_CODE_PATTERN`, `EXECUTE_OUTCOMES` and `SESSION_STATES`.
A reader refuses any other record, naming the field and never its value.

- test `tests/unit/lib/db/error-record.test.ts` "a missing or unknown kind or code is refused, naming the field"
- test `tests/unit/lib/db/error-record.test.ts` "a malformed sqlState or engineCode is refused, naming the field and not the value"
- test `tests/unit/lib/db/error-record.test.ts` "an unknown outcome or session state is refused"
- test `tests/unit/lib/db/error-record.test.ts` "an extra key is refused"
- test `tests/unit/lib/db/error-record.test.ts` "every generated record over the whole shape crosses JSON and the reader unchanged"

### E-4 (normative): The record holds no text of the error

A record holds no message, detail, statement or identifier of the error.

- test `tests/unit/lib/db/error-record.test.ts` "no record holds any text the error carries"

### E-5 (normative): Only a statement that cannot have reached the database is not-sent

`outcome` is `not-sent` only when the statement cannot have reached the database.
The host marks every failure of a provider's connect, and a provider claims not-sent only by raising `refused-before-send`, whose class marks it, by taking its connection or session through `checkoutPhase` before it sends anything, which marks what the checkout raised and turns a deadline the checkout met into a `ConnectionError` naming the wait, or by raising `transaction-lost` with `beforeSend` for a call on a held transaction whose session it found already ended, which the class then marks.
The host also marks not-sent a console call it refuses before making it, a deadline already passed or a caller already gone, C-51.
No provider writes an error's `outcome` itself, and every other failure is `unknown`.

- test `tests/unit/db/provider-error-kinds.test.ts` "provider code never writes an error's outcome"
- test `tests/unit/lib/db/error-record.test.ts` "a refusal before send answers not-sent wherever it is raised"
- test `tests/unit/lib/db/error-record.test.ts` "every other class answers unknown"
- test `tests/unit/db/errors.test.ts` "a failure the connect raises keeps its identity and answers not-sent"
- test `tests/unit/db/errors.test.ts` "a connect deadline becomes a ConnectionError that answers not-sent"
- test `tests/unit/db/errors.test.ts` "a failure the checkout raises is thrown as its mapped class and answers not-sent"
- test `tests/unit/db/errors.test.ts` "a checkout deadline becomes a ConnectionError naming the wait that answers not-sent, the deadline kept as its cause"
- test `tests/unit/db/statement-outcome-docs.test.ts` "each provider document has one Failed statement outcome row, checkout-not-sent exactly when its provider runs a checkout through checkoutPhase"
- test `tests/integration/db/postgres-provider.test.ts` "a pool checkout that fails answers its mapped class with outcome not-sent and sends nothing"
- test `tests/integration/db/mysql-provider.test.ts` "a pool checkout that fails answers its mapped class with outcome not-sent, not an internal error"
- test `tests/integration/db/oracle-provider.test.ts` "a pool checkout that fails answers its mapped class with outcome not-sent and sends nothing"
- test `tests/integration/db/postgres-provider.test.ts` "a begin whose pool checkout fails answers its mapped class with outcome not-sent, sends nothing and holds no transaction"
- test `tests/integration/db/mysql-provider.test.ts` "a begin whose pool checkout fails answers its mapped class with outcome not-sent, not an internal error"
- test `tests/integration/db/oracle-provider.test.ts` "a begin whose pool checkout fails answers its mapped class with outcome not-sent and holds no transaction"
- test `tests/unit/db/errors.test.ts` "a TransactionLostError raised before anything was sent answers not-sent, and one raised without beforeSend answers unknown"
- test `tests/integration/db/postgres-provider.test.ts` "%s on a held transaction whose session already ended answers TRANSACTION_LOST with outcome not-sent and sends nothing"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "a checkout failure inside execute answers not-sent"
- test `tests/unit/lib/provider-host/access.test.ts` "a call the caller left is answered as QueryCancelledError, not-sent before the call and unknown after it"
- test `tests/unit/lib/provider-host/access.test.ts` "a call past its deadline is answered as StudioTimeoutRefusal, not-sent before the call and unknown after it"

### E-6 (informative): No error carries a session state or an engine code yet

`sessionState` and `engineCode` are defined and read, and no error carries either yet.

### E-7 (normative): A driver error row maps into the record

A driver's error row, `DriverErrorClassifier`, answers what the driver's own fields and words say of an error, and each answer maps to one kind.
A configuration refusal is `config`; a database the login cannot open is `connection`; an access refusal is `permission` for a missing privilege and `authentication` for a refused credential, and the credential words count only on an error that carries no code; a statement fault is `query`; the engine's own time budget is `timeout`; a cancelled statement is `cancelled`; a late classification is `connection` or `query`, as it says.
The record keeps the SQLSTATE the driver reported.

- test `tests/unit/db/driver-row-kinds.test.ts` "each answer a driver row gives maps to one error kind, keeping the driver's SQLSTATE"
- test `tests/unit/db/driver-errors.test.ts` "answers every corpus input exactly as the shared mapping answered it before the move"

### E-8 (normative): Nothing resends on `retryable`

An answer's `retryable` is advice to a person that trying again may help.
No host, client, agent or MCP component resends a request because of it, for a write and a billed read alike.
Every read of the flag in Studio's source is a recorded copy that carries it to the next hop.

- test `tests/unit/lib/api/retryable-readers.test.ts` "every read of an answer's retryable is a recorded copy, so nothing resends on it"
## SQL grammar

An engine whose query text is SQL states its grammar facts: what a handful of characters and forms mean in its SQL, which Studio's readers read a statement's structure with.

### S-1 (normative): One grammar type and one compatibility default, both the SDK's

The grammar facts are one type and the compatibility reading is one value, both exported from `@libredb/provider-sdk/sql`.
Studio's readers and the composition of its grammar rows import `SqlGrammar` and `DEFAULT_SQL_GRAMMAR` from `@libredb/provider-sdk/sql` by name, a fact a dialect has not established takes the default's value, and the module that resolves a grammar by engine id declares neither.
The default is frozen to its leaves, so no module that imports it changes it for another.

- test `packages/provider-sdk/tests/sql/grammar.test.ts` "DEFAULT_SQL_GRAMMAR is the compatibility reading"
- test `packages/provider-sdk/tests/sql/grammar.test.ts` "DEFAULT_SQL_GRAMMAR is frozen to its leaves, so no importer changes it for another"
- test `tests/unit/sql/grammar.test.ts` "the module that resolves a grammar by engine id exports only its two readers"
- test `tests/unit/db/sql-grammar/shared.test.ts` "the shared blocks are NO_EXTRA_WORDS and REDACTED_VALUE"

### S-2 (informative): Studio composes its grammar rows from the declarations

Studio's registry composes each engine's grammar row from the SQL text its declaration authors, M-78, so the declaration is where a grammar fact is stated.
Its redaction stays Studio's review record, and the functions a row runs stay Studio's code, bound by name.

### S-3 (normative): The SQL text segment

An engine states, in `sqlText`, whether its statement text is SQL, its grammar facts, its redaction, its update target words and its completion quoting.
`grammar` has one member per member of the SDK's `SqlGrammar`, under the same name, and every member is required.
Studio composes each engine's grammar row from its declaration, M-78, and its census reads every member of every declaration back to that row, and finds no member of a row that its declaration leaves out.

- schema `/$defs/sqlText`
- schema `/$defs/grammarFacts`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a SQL text segment with every grammar fact stated, a command redaction and both completion readers is admitted"
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.readsSqlText is the engine's SQL_GRAMMAR row's"
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.grammar is the row's grammar, each fact the row leaves out at its reading when left out and each trailing limit clause by its source and flags"
- test `tests/unit/db/engine-declarations.test.ts` "every member of a grammar row has its member in the declaration"

### S-4 (normative): A fact the grammar may leave out is written

A fact the `SqlGrammar` type may leave out is written at the reading its absence has.
A form the engine does not have is false or an empty list, tagged runs are true, the formatter language is `postgresql` and the completion words are two empty lists where the engine adds none.
The two backslash overrides are null where the quote takes the reading `backslashAlwaysEscapes` gives both quotes, which is a third reading where that fact is false.
The session keys are null where no SET or RESET asks, and a list, even an empty one, makes a RESET with no key ask.
A grammar read from a declaration, each null fact left out, reads every statement as the engine's grammar row does.

- schema `/$defs/grammarFacts/properties/confirmConfigKeys`
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.grammar is the row's grammar, each fact the row leaves out at its reading when left out and each trailing limit clause by its source and flags"
- test `tests/unit/db/engine-declarations.test.ts` "a grammar read from the declaration reads every statement of the census corpus as the row's grammar does"
- test `tests/components/QuerySafetyDialog.test.tsx` "absent: a RESET and a listed key ask nothing"
- test `tests/unit/sql/spans.test.ts` "absent, with backslashAlwaysEscapes true: the backslash escapes the quote and the run does not close"

### S-5 (normative): Trailing limit clauses

A trailing limit clause is a pattern of a `source`, of 1 to 512 characters, which opens with `\s+` and closes with `\s*$`, and its `flags`, `i` or `iu`, and it compiles as JavaScript's `RegExp` reads it with its flags.
The flags that would make the limiter remember where it stopped, match at a line end or anchor at a stored index are left out.
Studio places the row bound before the run of such clauses at a statement's end, stripping them in the order declared, and reads a bound followed by such a run as the statement's own.

- schema `/$defs/clausePattern`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a trailing limit clause longer than 512 characters is refused as out-of-range"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a trailing limit clause whose flags are not i or iu is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a trailing limit clause that does not compile is refused as pattern-invalid"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's trailing limit clauses are held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/sql/spark-grammar.test.ts` "a trailing OFFSET follows the row bound, and LIMIT before OFFSET reads as bounded"

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

- schema `/$defs/statementRedaction`
- schema `/$defs/nameQuote`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a redaction of no listed kind, a name quote outside the vocabulary and a reader that is not a function name are each one refusal at the redaction"
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.redaction is the row's redaction, a command reader named by its slot"
- test `tests/unit/db/engine-declarations.test.ts` "every function a grammar row holds is, through the census's own resolver, the very slot its declaration names"
- test `tests/unit/lib/query-events/redact.test.ts` "the vectors hold every literal form for postgres, mysql, mssql and oracle, and MongoDB and Redis commands"

### S-8 (normative): A claim that loosens the confirmation gate

`readsSqlText: false` and an exempt form each loosen the confirmation gate.
The gate counts such a claim only where Studio's review record lists it, and every other reader reads it as declared.
Studio's census holds each declaration's claims to the record.

- test `tests/unit/sql/confirmation-claim-review-gate.test.ts` "mongodb and redis text is not read as SQL"
- test `tests/unit/sql/confirmation-claim-review-gate.test.ts` "snowflake's session forms stay exempt"
- test `tests/unit/lib/db/confirmation-claim-review.test.ts` "lists every exempt form a shipped grammar row declares, and no other"
- test `tests/unit/lib/db/confirmation-claim-review.test.ts` "lists every text-not-sql claim a shipped grammar row makes, and no other"
- test `tests/unit/db/engine-declarations.test.ts` "the confirmation gate's claims each declaration makes are the entries Studio's review record lists for its engine"
- test `tests/unit/db/engine-declaration-readers.test.ts` "the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module and the SQL grammar, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW"

### S-9 (normative): Update target words and completion quoting

`updateTarget` names the words beside the shared sets that open a query and that join two queries, each one upper-case word, and whether `--` opens a comment only before a space or a control character.
`completion` names a pure segment formatter, used instead of the connection's quoting, and a pure reader of a quoted qualifier before a dot, each null where the engine has none.

- schema `/$defs/updateTargetWords`
- schema `/$defs/completionReaders`
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.updateTarget is the row's, each word set in its order"
- test `tests/unit/db/engine-declarations.test.ts` "sqlText.completion names a segment formatter and a quoted qualifier reader exactly where the row has one"
- test `tests/unit/db/engine-declarations.test.ts` "every function a grammar row holds is named by its engine's declaration"

### S-10 (informative): Where a grammar function runs

Studio runs a command redaction reader on its server, and its completion readers in the editor, in the browser.
Composing the SQL grammar refuses any function name Studio holds no function for at its slot, M-78, so no package function runs in a browser or on the server through a grammar; where a package's completion reader runs is decided with the first package that names one, M-32.

### S-11 (normative): The SQL writing segment

An engine states, in `sqlWriting`, how a generated statement spells a literal, a name, a bind and a temporal literal for it, what its inline edit and its result export read, and how a document insert is written where its console text is a request.
The segment has one member per member of Studio's SQL writing row, under the same name and with the same nesting, and every member is required.
A function the engine lacks is null, and every other function is named by the slot it fills.
Studio composes each engine's row from the segment, M-79, so no member of the row is stated anywhere else.

- schema `/$defs/sqlWriting`
- schema `/$defs/inlineEditFacts`
- schema `/$defs/exportFacts`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an SQL writing segment with every hook named, a create table key, a bare spelling and every key float64 is admitted"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.inlineEdit is the row's, each type name set in its order and float64 as all where every key is"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.export states the row's DDL types, standing-alone names, bare spellings, non-finite literals and insert form"
- test `tests/unit/db/engine-declarations.test.ts` "every member of an SQL writing row has its member in the declaration"

### S-12 (normative): The type names an inline edit and an export read

An inline edit type name is one lower-case word, since the inline edit reads the first word of a declared type, lower-cased and with its wrappers off.
A standing-alone name, a bare spelling's name and a bare type family's name are lower-case words separated by one space, since the export reads a declared type trimmed, lower-cased and with each run of whitespace one space.
Every key column is float64 where `float64TypeNames` is `all`.
A map keyed by type name is a list, the bare spellings as entries and the bare type families as one list per kind, and each name is named once per table.

- schema `/$defs/keyTypeName`
- schema `/$defs/declaredTypeName`
- schema `/$defs/float64TypeNames`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an inline edit type name that is not one lower-case word is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a declared type name that is not lower-case words separated by single spaces is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "float64 type names that are neither a list nor all are one refusal at the member"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a type name under two families, or a bare spelling named twice, is refused as type-name-duplicate at the later"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.inlineEdit is the row's, each type name set in its order and float64 as all where every key is"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.export states the row's DDL types, standing-alone names, bare spellings, non-finite literals and insert form"
- test `tests/unit/db/sql-writing/golden.test.ts` "SQL writing golden output"
- test `tests/unit/db/sql-writing/compose.test.ts` "each row is its declaration's SQL writing composed with Studio's SQL writing function table"

### S-13 (normative): Text an export writes from a declaration stays on its line

A DDL type and a bare spelling are each one SQL type of up to 64 characters with no line break: words separated by one space, then at most one parenthesized argument list with its commas inside it, then words, so it fills one column's type and never adds a column.
A non-finite literal is printable ASCII with no line break and no space at either end.
A create table key's note is whole comment lines, each `-- ` and text with no line break, ending in a line feed.
So nothing a declaration states becomes a statement of the file an export writes.

- schema `/$defs/sqlTypeSpelling`
- schema `/$defs/nonFiniteLiteral`
- schema `/$defs/commentLines`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a DDL type, a bare spelling or a non-finite literal that would not stay on its line is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a DDL type or a bare spelling that is more than one type at the top level is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a create table key note that is not whole comment lines is refused as pattern-mismatch"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.export.createTableKey carries the row's note where the row has a key"

### S-14 (normative): The type vocabulary

Each engine states the vocabulary its declared types are read with: its bare type families grouped by kind, and three patterns.
Each pattern is a `source` of 2 to 512 characters, written with `^` and `$`, and its `flags`, none, `i`, `u` or `iu`, and it compiles as JavaScript's `RegExp` reads it with its flags.
`floatType` and `exactNumericType` are tested against a whole type, and `numericWrapper` captures exactly one group, the type it wraps.
The validator counts that group without running the declared pattern, so a wrapper that backtracks without end on some text is admitted or refused as quickly as any other.

- schema `/$defs/typeVocabulary`
- schema `/$defs/typePattern`
- schema `/$defs/typeFamilies`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a type pattern longer than 512 characters is refused as out-of-range, and one not written with ^ and $ as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a type pattern whose flags are not none, i, u or iu is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a type pattern that does not compile is refused as pattern-invalid"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a wrapper pattern that does not capture exactly one group is refused as wrapper-group-count"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a wrapper pattern that backtracks without end on the empty string is still counted at once"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's SQL writing facts are held to the rules the schema cannot state, at pointers into it"
- test `tests/unit/db/engine-declarations.test.ts` "sqlWriting.export.typeVocabulary is the row's, its bare type families grouped by kind and each pattern by its source and flags"
- test `tests/unit/db/sql-writing/golden.test.ts` "SQL writing golden output"
- test `tests/unit/db/sql-writing/compose.test.ts` "each row is its declaration's SQL writing composed with Studio's SQL writing function table"

### S-15 (informative): How a host runs a type pattern

A host compiles each type pattern once, when it reads the declaration.
It strips wrappers while the wrapper pattern matches and its capture is shorter than the type, and stops otherwise, since a capture as long as the type would never end the loop.
Studio takes a wrapper off only while the pattern matches and its capture is a strictly shorter type, so a capture as long as the type, or none, ends the unwrapping; `tests/unit/lib/export/numeric-wrapper-bounds.test.ts` holds both in a bounded child.
Backtracking is not checked yet, as M-35 says of a field rule's pattern.
Every type pattern Studio declares is the source and flags of one its export runs today, each measured to run in time linear in the type's length.
Studio compiles each type pattern once, when it composes the engine's row, M-79.

- test `tests/unit/lib/export/numeric-wrapper-bounds.test.ts` "a wrapper whose capture is not shorter than the type ends the unwrapping, so the export reads the type as it is"
- test `tests/unit/lib/export/numeric-wrapper-bounds.test.ts` "a wrapper whose group is absent ends the unwrapping"

### S-16 (informative): Where an SQL writing function runs

Studio composes each engine's SQL writing row from its declaration, M-79, binding each function it names through Studio's own table.
Studio runs these functions in the browser, in the inline editor, the result export, the test data generator, the data import and the pivot table, and on its server.
M-32 says no package function runs in a browser, so how a package's SQL writing functions are called, and whether a declaration may choose a shared building block by name, is decided with the first package that fills a slot.

### S-17 (normative): The migration DDL segment

An engine states, in `migrationDdl`, what the schema diff's migration writes for it, in one of two forms.
Refused: the one line the migration writes in place of any statement, no transaction wrapper, and the reason the line gives.
Written: its transaction wrapper or none, its CREATE TABLE form, written by a key writer and a foreign key writer or refused by a named function that writes the line for the quoted table, its nine statement writers, and every refusal sentence its writers print.
The segment has one member per member of Studio's migration DDL row in that form, under the same name and with the same nesting, and every member is required.
A value neither form admits is one `no-variant` refusal at the segment, as M-5 says of every union.
Studio's census holds every member of every declaration to the engine's row, and finds no member of a row that its declaration leaves out.

- schema `/$defs/migrationDdl`
- schema `/$defs/migrationDdlRefused`
- schema `/$defs/migrationDdlWritten`
- schema `/$defs/createTable`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a migration DDL segment that refuses table DDL, one that writes it with a transaction wrapper, and one whose CREATE TABLE is refused are admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a migration DDL member of the other form, a missing one or an unknown one is one no-variant refusal at the segment"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a create table of no listed kind, or with a member of the other kind, is one no-variant refusal at the segment"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's migration DDL is refused at its own pointer under validateEngine"
- test `tests/unit/db/engine-declarations.test.ts` "migrationDdl states the row's table DDL, its refusal line, its transaction wrapper and its reasons in order"
- test `tests/unit/db/engine-declarations.test.ts` "migrationDdl.createTable states the row's create table form"
- test `tests/unit/db/engine-declarations.test.ts` "every member of a migration DDL row has its member in the declaration"
- test `tests/unit/db/engine-declarations.test.ts` "the generator refuses, by name, a migration DDL member it has no place for"
- test `tests/unit/db/engine-declarations.test.ts` "the generator refuses, by name, a table DDL or create table form that is neither refused nor written"
- test `tests/unit/db/engine-declarations/migration-ddl-replay.test.ts` "every engine's migration DDL row, rebuilt from its declaration with each function resolved by its slot, renders the engine's golden migration text"

### S-18 (normative): Text a migration writes from a declaration stays on its line

The refusal is one comment line, `-- ` and text with no line break, up to 1024 characters.
Each transaction wrapper statement is words separated by one space, ending in its one semicolon, up to 64 characters.
Each reason is one line of 1 to 1024 characters, named once.
So nothing a declaration states becomes a second statement of the migration.

- schema `/$defs/migrationRefusal`
- schema `/$defs/wrapperStatement`
- schema `/$defs/transactionWrapper`
- schema `/$defs/ddlReason`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a migration DDL refusal that is not one comment line is one no-variant refusal at the segment"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a migration DDL reason that is not one line, or is listed twice, is one no-variant refusal at the segment"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a transaction wrapper statement that is not words ending in one semicolon is one no-variant refusal at the segment"
- test `tests/unit/db/engine-declarations/migration-ddl-replay.test.ts` "every engine's migration DDL row, rebuilt from its declaration with each function resolved by its slot, renders the engine's golden migration text"

### S-19 (informative): Studio still reads its migration DDL rows, and where their functions run

A migration DDL row is code beside its provider, read by Studio's registry.
Each engine declaration states the same facts as data, which nothing but Studio's census reads until the schema diff reads admitted manifests.
Studio runs every migration DDL function in the browser, in the schema diff panel, and none on its server.
M-32 says no package function runs in a browser, so how a package's migration DDL functions are called is decided when Studio reads admitted manifests.

### S-20 (normative): The SQL generator segment

An SQL engine states, in `sqlGenerators`, what it writes apart from Studio's shared SQL forms.
The segment is null where the engine writes the shared forms: it quotes a name as its declared identifier quoting or Studio's default says, and counts with `COUNT(*)`.
Otherwise it names the engine's name quoting, the tree click's statement, Generate Query's statement on the column list and the same statement on the projected column list, each form null where the shared form stands, and states the count Generate Count Query writes, `COUNT(*)` where the engine's is the shared one.
The segment has one member per member of Studio's SQL generator row, and every member is required.
Studio's census holds every member of every declaration to the engine's row, and finds no member of a row that its declaration leaves out.

- schema `/$defs/sqlGenerators`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an SQL generator segment naming every form, one naming only its quoting, and a null one are admitted"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an SQL generator form named in another form is refused at the form"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's SQL generators are refused at their own pointer under validateEngine"
- test `tests/unit/db/engine-declarations.test.ts` "sqlGenerators is null exactly where the engine has no SQL_ENGINE_GENERATORS row, and states the row's count expression, COUNT(*) where it has none"
- test `tests/unit/db/engine-declarations.test.ts` "every name an SQL generator declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own module exports there"
- test `tests/unit/db/engine-declarations.test.ts` "every function an SQL generator row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named"
- test `tests/unit/db/engine-declarations.test.ts` "every member of an SQL generator row has its member in the declaration"
- test `tests/unit/db/engine-declarations.test.ts` "the generator refuses, by name, an SQL generator member it has no place for"
- test `tests/unit/db/engine-declarations/sql-generators-replay.test.ts` "every SQL engine's generator row, rebuilt from its declaration with each form resolved by its slot, answers the committed generator corpus"

### S-21 (normative): A count expression is one call

A count expression is an aggregate name of letters, digits and underscores, starting with a letter, followed by `(*)`, up to 64 characters.
So the count a declaration states fills one expression of the statement Studio writes, and never adds a clause or a statement.

- schema `/$defs/countExpression`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a count expression that is not one aggregate call over every row is refused as pattern-mismatch, and one longer than 64 characters as out-of-range"
- test `tests/unit/db/engine-declarations/sql-generators-replay.test.ts` "every SQL engine's generator row, rebuilt from its declaration with each form resolved by its slot, answers the committed generator corpus"

### S-22 (informative): Studio still reads its SQL generator rows, and where their functions run

An SQL generator row is code beside its provider, read by Studio's registry.
Each engine declaration states the same facts as data, which nothing but Studio's census reads until Studio reads admitted manifests.
Studio runs a row's name quoting in the browser and on its server, in the profile route and in the agent's context, and its statement forms and count in the browser.
M-32 says no package function runs in a browser, so how a package's generator functions are called is decided when Studio reads admitted manifests.
The query dialects' and the query languages' own generators stay Studio's, keyed by the dialect and the language, while the dialect is one of Studio's (M-50).

### S-23 (normative): The editor language

An engine states, in `editor.language`, the query language it speaks, the Monaco language its query tabs are written and rendered in, one of Studio's editor languages, that language's accent, and whether the language is a console dialect.
An accent is a border class of one hue of Studio's palette at 40 percent, optionally its `-alt` step, and is none of the three status hues, amber, rose and emerald.
A console dialect's id is its Monaco id, so a manifest states no second id.
An engine with no dialect opens its tabs under its query language's tab type: `sql` for sql, `mongodb` for json, and `promql`, `cypher` and `influxql` for their own.
An engine with a dialect opens them under the dialect's name (M-50), so a manifest states no tab type.
Two engines that name one editor language state the same accent and console.
The projection refuses by name two declarations that state one editor language with a different accent or console, or one tab type in different languages, M-77, and Studio composes each language's code with the accent the declarations state.

- schema `/$defs/editorLanguageFacts`
- schema `/$defs/queryLanguage`
- schema `/$defs/monacoLanguageId`
- schema `/$defs/editorAccent`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an editor language with Studio's query language, Monaco language and accent is admitted, and a console language too"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a query language or a Monaco language outside Studio's is refused as value-not-allowed"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an accent that is not one border hue class of Studio's palette, or is a status hue, is refused as pattern-mismatch"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an editor language that states a tab type or a console dialect id is refused as unknown-key"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an engine declaration's editor language is refused at its own pointer under validateEngine"
- test `tests/unit/db/engine-declarations.test.ts` "editor.language.queryLanguage is the query language the engine's unconnected provider declares"
- test `tests/unit/db/engine-declarations.test.ts` "a dialect-less engine's tabs take its query language's tab type, and a dialect engine's its dialect's name"
- test `tests/unit/db/engine-declarations.test.ts` "editor.language.monacoId is the Monaco language Studio's editor renders the engine's tabs in"
- test `tests/unit/db/engine-declarations.test.ts` "editor.language.accent and console are the EDITOR_LANGUAGES row's, a console registered under its own Monaco id"
- test `tests/unit/db/engine-declarations.test.ts` "EDITOR_LANGUAGES and DIALECT_EDITORS are the editor language facts the declarations state, one per language and one per tab type"
- test `tests/unit/db/engine-declarations.test.ts` "every member of an editor language row and of a tab type's editor row has its member in the declaration, or stays browser code"
- test `tests/unit/db/engine-declarations.test.ts` "the query languages and the editor languages are Studio's"
- test `tests/unit/editor/editor-language-registry.test.ts` "each language takes an accent of its own, and none is a status hue"

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

- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a provider whose implementation matches its declared calls is defined, and its record is frozen"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the manifest in the record is a deep-frozen copy, and the package's own object is left as it was"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a value that is not a provider module record is refused as module-not-a-record"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a manifest or record built against another contract is refused as contract-not-served"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "no refusal and no message carries a value of the manifest or the implementation"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an accessor the check would read is refused as property-not-data, and its getter is never called"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an honours list longer than the request fields is refused as manifest-unreadable at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/honours-bounds.test.ts` "a manifest honours list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no engine is read"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a maintenance or agent readings list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a maintenance specs list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "an engine list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "a maintenance list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "a maintenance specs list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "an agent readings list of the longest length is refused at the list, in a bounded child"
- schema `/properties/engines/maxItems`
- schema `/$defs/facets/properties/maintenance/maxItems`
- schema `/$defs/facets/properties/maintenanceSpecs/maxItems`
- schema `/$defs/facets/properties/agentReadings/maxItems`
- test `packages/provider-sdk/tests/manifest/schema.test.ts` "the engine list is bounded at 64, and each facet list by the size of its vocabulary"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a list longer than its maxItems is refused as too-many"

### C-2 (informative): The loader checks the record with the host's SDK

The loader reads only the entry's `default` export and runs `checkProviderModule` on it, so a record another copy of the SDK built is checked by the host's copy.
Validating the manifest against the schema is the loader's too, since it holds the schema bytes.
No loader exists yet, so nothing checks this.

### C-3 (normative): The mandatory calls

The mandatory calls are `open`, `close`, `health` and `console.execute`, each a function of the implementation's own, found at the path its name spells.
An implementation defines no other key than the calls this contract defines: its keys are `open`, `close`, `health`, `console`, `objects`, which holds the object facets, `maintenance`, which holds the maintenance facets, and `monitoring`, which holds the monitoring facets; an implementation that offers no object, maintenance or monitoring facet may leave that segment out or hold it empty.
Each calls segment it has, `console`, `objects`, `maintenance` and `monitoring` alike, is a record of its calls: one that is `null`, a string, an array or any other value that is not an object is refused by name, and nothing under it is read.

- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a mandatory call that is missing or no function is refused as call-missing"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a calls segment of the implementation that is not a record is refused as impl-segment-not-a-record, and nothing under it is read"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an implementation key the contract does not define is refused as impl-key-unknown"

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

- schema `/$defs/consoleCalls`
- schema `/$defs/objectsCalls`
- schema `/$defs/maintenanceCalls`
- schema `/$defs/monitoringCalls`
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an offered facet the implementation lacks is refused as facet-unimplemented"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an implemented facet the manifest does not offer is refused as facet-undeclared"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the transaction facet is declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the objects tree facet is declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the maintenance facets are declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine's maintenance is admitted where the package offers maintenance.run, and refused by name as engine-facet-call-not-offered where it does not"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a maintenance spec that previews is admitted where the package offers maintenance.preview, and refused by name where it does not"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the monitoring facets are declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine's offered monitoring panel is admitted where the package offers monitoring.panel, and refused by name as engine-facet-call-not-offered where it does not"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an agent reading is admitted where the call that serves it is offered: a panel reading where the package offers monitoring.panel, and health on every package"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a panel reading is refused by name as engine-facet-call-not-offered, naming monitoring.panel, where the package does not offer it"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "no definition check answers engine-facet-without-call, which left the vocabulary with the agent readings' calls"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the console facets and execute's request fields are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the objects facets are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the maintenance facets are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the monitoring facets are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "each agent reading names the monitoring panel that serves it, or none for health"

### C-5 (normative): A package declares the request fields its execute honours

A package lists in `calls.console.execute.honours` the optional request fields, of `EXECUTE_REQUEST_FIELDS`, its execute honours.
How the host uses that list is C-9, and how a provider does is C-8.
A package that serves read-only statements lists `readOnly`, the read-only execute of C-78.

- schema `/$defs/executeCall/properties/honours`
- schema `/$defs/executeRequestField`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a request field execute does not know, or one listed twice, is refused"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a manifest without its calls is refused as missing-key"

### C-6 (normative): A package never reads a proxy variable

`runtime.env` cannot declare a proxy variable, in either case, so every route out of Studio's process is core's.
Package source reads no environment variable itself, M-18.
A later check of the kit runs each package in an environment poisoned with proxy variables; it does not exist yet.

- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a proxy variable declared in runtime.env is refused as env-proxy-variable"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a lower-case proxy variable is refused by the name pattern"
- test `tests/unit/provider-source-coupling-lint.test.ts` "process.env is refused in provider source, in each form a provider reads it today"

### C-7 (normative): Today's provider inputs and console answer each have a place

Every input a provider is built with today, and every member of today's console request and answer, has a place in the calls, or a stated reason it stays with the host.
So a provider moves onto the contract without a behaviour change.
A provider is built from the connection's fields and from the marks core sets beside them under symbol keys: the tunnel's far end and route, the literal seed-file mark, the file core admitted and the host paths core admitted.
A census over Studio's own types holds this, one record over the connection's fields and one over its marks, and the shapes the open context shares with Studio, the TLS settings, the egress decision, the trust material, the pool settings, the tunnel's far end and the admitted host paths, are each mutually assignable with Studio's own.
The census covers today's transaction surface too, the transaction methods the transaction route calls, begin's options and result and the arguments of a statement inside the transaction, each placed on the transaction facet's actions, its request and answer, or console execute, C-57.
It covers today's object tree surface, the five provider members that list containers and objects, count them and describe them, each placed on an action of `objects.tree` and each argument on a member of that action's request, except the billed-read allowance, which stays with the host and reaches a legacy provider's tree reads through the bridge's session input, C-50 and C-61.
The inventory's configuration question a provider may answer is placed on the top-level containers answer's `needsConfiguration`, C-61.
The tree's answer shapes, the container, the object and its read range, the kind count, the column, index, foreign key and exclusion constraint and the object's detail and its batch, are each mutually assignable with Studio's own and have its keys, and each answer form's member is Studio's answer, a list compared by its items, since Studio's lists are mutable and the SDK's are not.
It covers today's maintenance surface, the run and the preview the maintenance routes call, each placed on its maintenance facet and each argument on a member of that facet's request, and the engine principal the maintenance audit row names, placed on the open answer, C-67.
The run's answer and the preview are mutually assignable with Studio's maintenance result and preview and have their keys, the run's rows and fields compared by their items, and the maintenance vocabulary is Studio's.
A session's maintenance, narrowed by what its server accepts, is what Studio's `narrowMaintenance` answers for every committed engine declaration, every spec and every placement a server may accept, one operation at a time and all of an engine's at once, C-68.
It covers today's monitoring, pool statistics and health surface: each panel read placed on `monitoring.panel` with its panel and each of its options on a member of that panel's request, the pool statistics the pool-stats route reads on `monitoring.poolStats`, the health read on `health`, and the dashboard's orchestration, its panel states and the options that choose which panels are read with the host, C-71 and C-72.
The panel shapes, the pool statistics and the health answer are mutually assignable with Studio's own and have their keys, each answer form's member is the answer of the member that reads its panel, lists compared by their items, and the panel vocabulary is Studio's.
It covers today's read-only statement surface: the provider's read-only statement path placed on console execute sent with `readOnly`, its statement on the request's statement, its budget's rows and bytes on the read-only execute's budget, its mode on the read-only execute's mode, its timeout on the call's deadline, and its billed-read allowance with the host, C-78.
Studio's read-only statement mode is the SDK's `READ_ONLY_MODES`, both ways.

- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every input a provider is built with has a place in the open context or a reason it stays with the host"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's console answer and request has a place in the console calls"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's transaction surface has a place in the console calls"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's object tree surface has a place in the objects calls"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the object tree's answers are Studio's own shapes"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's maintenance surface has a place in the maintenance calls or the open answer"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the maintenance answers are Studio's own shapes"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "a session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a server accepts"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's monitoring and health surface has a place in the monitoring calls, the health call or with the host"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the monitoring and health answers are Studio's own shapes"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's read-only statement surface has a place in the console calls or with the host"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the context's shared shapes are Studio's own"

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

- test `packages/provider-sdk/tests/calls/request.test.ts` "a request field the session does not honour is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that honours every field and offers endScope takes each"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a request on a refined session is held to the narrowed calls"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a statement sent inside a transaction to a session without console.transaction is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a statement sent inside a transaction never carries a scope"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that offers console.transaction takes a statement inside its transaction with its params and offset"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a CallRefusalError carries every refusal and words each"

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

- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement that widens a declared value is refused as refinement-widens"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw console.transaction, and never offer it where the manifest does not"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw objects.tree, and never offer it where the manifest does not"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw maintenance.run and maintenance.preview, and never offer one the manifest does not"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw monitoring.panel and monitoring.poolStats, and never offer one the manifest does not"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "an honours list longer than the declared one is refused as refinement-widens at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/honours-bounds.test.ts` "a refinement honours list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a key a refinement cannot have is refused as refinement-key-unknown"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a calls segment the contract does not define is refused by name, and never read as the objects segment"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement value of the wrong type, an accessor or a repeated field is refused as refinement-unreadable"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "no refinement refusal carries a value of the refinement"

### C-11 (normative): The contexts and requests the host passes are frozen

`freezeContext` freezes a context in place at every depth, except its `signal` and `env`, which stay exactly as the host passed them, because a frozen AbortSignal can no longer be aborted or listened to on Node.
`freezeData` freezes a request in place at every depth, except its typed arrays and dates, since JavaScript cannot freeze a typed array's elements and a date's time is no property.
Both walk every own key of every object they freeze, symbols included.
Either refuses, by its JSON Pointer and then freezing nothing, an object outside the value codec's domain, a function, an invalid Date, which `encodeValue` refuses too, and an accessor property, whose getter it never calls, so no object behind a getter is left unfrozen.
Either refuses a symbol-keyed property by the JSON Pointer of the object that holds it, since a pointer cannot name a symbol, and then freezes nothing.

- test `packages/provider-sdk/tests/calls/freeze.test.ts` "a context is frozen at every depth, and a write to any of it throws"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "the signal and the environment reader are left as the host passed them, and the signal still aborts"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "a request is frozen at every depth, except its typed arrays and dates"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "a value that holds itself is frozen once"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "an object outside the value codec's domain is refused by its pointer"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "an accessor property is refused by its pointer, its getter never runs, and nothing is frozen"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "a symbol-keyed property is refused by the pointer of the object that holds it, and nothing is frozen"
- test `packages/provider-sdk/tests/calls/freeze.test.ts` "an invalid Date is refused by its pointer, as the value codec refuses it, and nothing is frozen"

### C-12 (normative): The host freezes on every call, in every environment

The host passes every context and request through `freezeContext` and `freezeData` on every call, in every environment, production included, so a provider that writes to what the host passed fails the same way in a test and in production, at the line that writes.
Both freeze in place, so the host builds a fresh context and request for each call, and a value it shares across calls ends frozen.
The host core's console calls do so, C-48.

- test `tests/unit/lib/provider-host/core/console.test.ts` "every call gets a fresh context and request, frozen at every depth"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a cancel of a run the provider does not know answers not cancelled"

### C-13 (normative): The byte budgets and the row measure

The byte budgets of a result are `BATCH_MAX_BYTES`, for one batch, and `PAGE_MAX_BYTES`, for one page.
A row's size is the UTF-8 length of its encoded JSON text, `encodedRowBytes`, and a batch's and a page's size is the sum of their rows' sizes.
The pump hands each pull its own measure, `measure` on the pull's limit, which answers that size.
Measuring a row encodes every cell, so a cell outside the value codec's domain is refused by the codec's own error.

- test `packages/provider-sdk/tests/calls/results.test.ts` "the batch and page budgets are one MiB and 32 MiB"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a row's size is the UTF-8 length of its encoded JSON text"

### C-14 (normative): A result source answers within the limit it is asked for

A result source answers each `next` with at most the rows and the bytes it is asked for, and never splits a row, so a batch of exactly one row may be larger than its byte limit and one row always makes progress.
It sizes each row it answers with the measure of the limit it is asked with.
`rowsSource` does so over rows a driver already holds in memory.

- test `packages/provider-sdk/tests/calls/results.test.ts` "a batch held to batch.maxBytes"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a row larger than the batch budget comes alone, and is refused only when no page can hold it"

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

- test `packages/provider-sdk/tests/calls/results.test.ts` "a page cut by size at page.maxBytes"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a page ends at its row limit or when the source is done"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a batch a source should not have answered is refused by name, and the source is closed once"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a failure to pull or to close is thrown, and neither is lost"
- test `packages/provider-sdk/tests/calls/results.test.ts` "the limits a source is asked for are frozen and within the page"
- test `packages/provider-sdk/tests/calls/results.test.ts` "each pull hands the source the pump's own measure, and a row the source sized with it is not measured again"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a row the source did not size with its pull's measure is measured by the pump"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a pull's measure called after its pull answered is refused by name"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a pump limit that is not a positive safe integer is refused before any pull"
- test `packages/provider-sdk/tests/calls/pump-bounds.test.ts` "a source that never progresses is refused after one pull, in a bounded child"
- test `packages/provider-sdk/tests/calls/pump-bounds.test.ts` "a source that never ends is cut at the page's byte budget, in a bounded child"
- test `tests/unit/lib/provider-host/core/console.test.ts` "the first result is pumped within the limits set from the answer, and every other result is closed once"

### C-16 (normative): What the byte budgets bound

The pump runs in the host's copy of the SDK, so every package's batches are measured by one rule.
The budgets bound what crosses from a provider, not what a driver buffers: a driver without a cursor materialises a page before the SDK sees it.
A page of very small rows is bounded in the heap by the host's row limit, not by its bytes, so the host always passes a finite row limit.
A row a source answers as the same array the pull's measure sized, in the order the source measured its rows, is measured once, by that call, and its cells are read once, when it is measured.
Every other row is measured by the pump as C-15 states, so a copy of a measured row, a row measured in another pull and a row answered twice are measured a second time, as is a row that crossed a frame of the kit, C-19.
The pump hands on the provider's own row arrays, so a source whose cells change after the row was measured, through a getter or a later write, whether after its own call of the pull's measure or after the pump read the batch, answers more than was measured.
In process nothing is framed, so the host measures what a source answers, through the pump's own measure, and a source of the legacy bridge sizes each row with the pull's measure in the form C-50 states.
How many pages larger than one batch the host holds at once is bounded by its page budget, C-53.

- test `tests/unit/lib/provider-host/core/console.test.ts` "the first result is pumped within the limits set from the answer, and every other result is closed once"
- test `packages/provider-sdk/tests/calls/results.test.ts` "each pull hands the source the pump's own measure, and a row the source sized with it is not measured again"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the bridge sizes every row it answers with the pull's measure, and answers that same array"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a cell outside the value codec is measured in its JSON form and answered unchanged"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the page's row limit is the probe limit for a bound Studio wrote, and every returned row otherwise"

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

- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session does not offer is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session offers is called"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the transaction facet is refused by name to a session that does not offer it"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the objects tree facet is refused by name to a session that does not offer it"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that offers objects.tree is called"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the maintenance facets are refused by name to a session that does not offer them"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that offers maintenance.run and maintenance.preview is called"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a maintenance run is held to the operations and placements the session's maintenance offers, kill placed nowhere"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a maintenance preview is held to an operation whose spec previews on a row"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a maintenance request with empty text where it names something is refused by the field"
- test `packages/provider-sdk/tests/calls/request.test.ts` "no maintenance request refusal carries a value of the request"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the monitoring facets are refused by name to a session that does not offer them"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that offers monitoring.panel and monitoring.poolStats is called"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a monitoring panel request is held to the panels the session's engine offers"
- test `packages/provider-sdk/tests/calls/request.test.ts` "no monitoring request refusal carries a value of the request"
- test `packages/provider-sdk/tests/calls/request.test.ts` "every call refusal rule is worded in one sentence"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served maintenance call whose request the session's maintenance does not take is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame"

### C-18 (normative): The testing entry is for tests

`@libredb/provider-sdk/testing` holds the memory test transport's pieces, and only tests import it.
The package root never re-exports it, and Studio's runtime source under `src/`, `bin/` and `vscode-extension/src/` never imports it, in any form, a type import included.

- test `packages/provider-sdk/tests/manifest/digest.test.ts` "the package root does not export the testing surface"
- test `tests/unit/package-imports.test.ts` "Studio's runtime source never imports the SDK's testing entry"
- test `tests/unit/package-imports.test.ts` "a planted runtime file that imports the testing entry fails by file and specifier"

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

- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served module answers every call through one request frame and one answer frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the provider receives decoded copies, frozen at every depth, with the host's signal and environment reader by reference"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the host's own context and request are left as the host built them, and the host receives decoded copies of each answer"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a value the codec cannot carry, or a frame key the call does not define, fails the call before the provider is called"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "an error a call or a source throws reaches the host as the same object"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served source's provider receives the limit's numbers decoded and frozen with the host's measure by reference, and the frame carries the numbers only"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served transaction call crosses its request and answer as frames, and a statement inside the transaction carries its session state back"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served maintenance call crosses its request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served health call crosses its context and answer as frames, and the host receives a decoded copy"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a value that is not a provider module record is refused with every refusal before anything is served"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the served implementation is an implementation of the module's manifest, with the module's facets"

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

- test `packages/provider-sdk/tests/testing/frames.test.ts` "a well-formed frame of every call and part is admitted"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a key a frame's shape does not define is refused as frame-key-unknown at its pointer"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a required key a frame lacks is refused as frame-key-missing"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a page bound is exactly one of its two forms"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a transaction request is one of its actions, and only begin carries requireReportedState"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a tree request is one of its actions, each with its own members"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a tree answer is exactly one of its five forms, each read as its closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a maintenance run request and answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a maintenance preview request and answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a monitoring panel request is the closed shape of the panel it names"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a monitoring panel answer is exactly one of its seven forms, each read as its closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a pool statistics answer and a health answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a timestamp member admits a Date and nothing else"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a connection's keys are the contract's field names and each value a connection field value"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "no frame refusal and no sentence carries a value of the frame"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "every frame refusal rule is worded in one sentence"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a FrameRefusalError carries every refusal and words each"

### C-21 (normative): What crosses is compared deep-equal, and whatever the round trip changes is refused

The value a side decodes is compared deep-equal with the value the other side handed, as `roundTripRefusals` does, and never copied with `structuredClone`, so a test sees what a JSON boundary does to a value.
Whatever the value codec's JSON round trip changes or drops is refused as `round-trip-changed` at its pointer: a symbol-keyed property, at the object that holds it, a non-enumerable property, an accessor, whose getter the comparison never calls, an array's property that is not an index, at the array, and a key, a length or a leaf that differs.
What the codec defines as equal compares equal: `-0` and `0`, NaN and NaN, a `Uint8Array` subclass such as a Buffer and a plain `Uint8Array` of the same bytes, a `Date` subclass and a `Date` of the same time, and an object with no prototype and one with `Object.prototype`.
A `Uint8Array` and a `Date` are compared by their bytes and their time alone, so an own property either one carries besides them is not compared: a typed array's own keys are its indices, and walking them would cost a pass over every byte.

- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "a value the codec carries is admitted, with -0, a Buffer, a null-prototype object and Date and Uint8Array subclasses compared as the codec defines them"
- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "a symbol-keyed property is refused as round-trip-changed at the pointer of the object that holds it"
- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "a non-enumerable property is refused as round-trip-changed at its pointer"
- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "an accessor is refused as round-trip-changed at its pointer, and the comparison never calls its getter"
- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "an array's own property that is not an index is refused as round-trip-changed at the array"
- test `packages/provider-sdk/tests/testing/round-trip.test.ts` "a received value that differs from the sent one is refused at the pointer where it differs"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served health call crosses its context and answer as frames, and the host receives a decoded copy"

### C-22 (normative): A session handle and a result source never cross

Over the memory test transport a session handle and a result source stay in tables the served instance owns, and only their ids cross.
The host holds a frozen token for each session, looked up by identity, so a copy of a token is foreign, and the provider's calls receive the provider's own handle.
A closed or foreign token is refused as `session-not-open`, and a closed result source as `result-not-open`, before any frame.
A close takes its entry out of both tables whatever the provider's close answers, and a close that resolves anything but nothing is refused.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "the session handle and each result source stay in the served instance's tables, and only their ids cross"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a closed or foreign session token is refused as session-not-open before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a closed result source is refused as result-not-open before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a close takes the session out of both tables even when the provider's close throws"

### C-23 (normative): The served host side checks each call before any frame, and closes what a refused answer handed over

The served host side refuses before any frame what C-9 and C-17 refuse, holding each call to the session's calls.
It reads the refinement `open` answers by C-10, so the session's calls are the narrowed ones, and its maintenance narrowing by C-68 against the maintenance of the engine the open context names; an open context that names an engine the module's manifest does not declare is refused before any frame.
It keeps the monitoring panels of that engine with the session, and refuses a panel call for a panel they do not offer before any frame, C-17.
An answer the host refuses holds nothing open afterwards: a refused open answer closes its session through the provider's `close`, under a cleanup context of its own, C-47, never the open's, and a refused execute answer closes each result source it handed over through its own `close`.
An item of an execute answer's `results` that is not an object is refused at its index, as a hole is, and a source whose `columns` or `rowCount` read throws is closed with the sources before it, the read's own error thrown.
Every close runs, and when one fails the host receives an `AggregateError` with the refusal first and each close's error after it.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "a request field or a console facet the session does not offer is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a transaction call or a statement inside a transaction on a session without console.transaction is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a tree call on a session without objects.tree is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a maintenance call on a session without the facet is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a refinement open answers narrows the served session's calls"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served open whose maintenance narrowing names an operation its engine does not list is refused, and the session it opened is closed"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served open is held to the maintenance of the engine its context names, which the module declares"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "an open answer the host refuses closes its session, and an execute answer the host refuses closes its sources"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a close that fails beside a refused answer is thrown with the refusal first"

### C-24 (normative): A frame never grows past what the provider holds

The transport encodes a value before it stringifies it, and every loop it runs over a provider's array stops at the first hole, so a sparse list of any length is refused at its first hole.
A served result source asks the provider for exactly the limit it is pulled with, one batch a pull, and buffers nothing ahead, so `pumpPage` cuts a page of a source that never ends at its byte budget.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served result source pulled by pumpPage answers the provider's rows, one frame a batch"
- test `packages/provider-sdk/tests/testing/serve-bounds.test.ts` "a batch whose rows are a sparse list of the longest length is refused at its first hole, in a bounded child"
- test `packages/provider-sdk/tests/testing/serve-bounds.test.ts` "an execute answer whose results are a sparse list of the longest length is refused at its first hole, in a bounded child"
- test `packages/provider-sdk/tests/testing/serve-bounds.test.ts` "a served source that never ends is cut at the page's byte budget, in a bounded child"

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

- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a call signal aborts at its deadline with a TimeoutError"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a call signal aborts with the caller's reason when the caller goes first"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a deadline already past answers a signal already aborted"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a deadline that is not a finite number is a host defect, refused before any signal is built"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a deadline further ahead than a timer can wait is refused before any signal is built"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the provider's context carries the host's deadline and signal, and its signal aborts at the deadline"

### C-27 (normative): No call starts after its signal aborted or its deadline passed

The host checks each call with `checkCallStart` before it makes it, and refuses it by `call-deadline-passed` or `call-signal-aborted`, rules of `CALL_REFUSAL_RULES`, each at a JSON Pointer into the call's context.
A refusal by `call-signal-aborted` is thrown with the signal's reason as the error's cause, never as a value of the refusal or of its sentence.
The deadline is read by time, since a signal does not abort at once when its deadline has already passed.
The served host side runs the check on every call, before any frame and before C-9 and C-17, so a refused call reaches no provider and leaves the session as it was.
`pumpPage` checks before every pull, so no batch is pulled after either, and a refusal there is thrown after the source's one close, as any failure of a step is, C-15.

- test `packages/provider-sdk/tests/calls/deadline.test.ts` "checkCallStart refuses a call whose deadline passed or whose signal aborted, naming each"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a CallRefusalError carries the signal's reason as its cause"
- test `packages/provider-sdk/tests/calls/results.test.ts` "the pump pulls no batch once the call's signal aborted or its deadline passed, and closes the source once"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a call signal that aborts during a page stops the pump before its next pull"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a call whose signal aborted or whose deadline passed is refused before any frame, and the provider is never called"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "no statement starts once the call's signal aborted"
- test `tests/api/db/cancel.test.ts` "a cancel whose caller already left calls nothing and answers 499"

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

- test `packages/provider-sdk/tests/calls/deadline.test.ts` "the host's wait settles as the answer does when the answer comes first, and leaves no listener on the signal"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "the host's wait ends at the signal, and the abandoned answer's outcome reaches the late handler once"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a signal aborted before the wait ends it at once, and the answer still reaches the late handler"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "an answer the host stopped waiting for reaches its late handler whole, and the host closes what it handed over once"
- test `tests/unit/lib/provider-host/core/console.test.ts` "an answer that arrives after the stop has its sources closed and is never pumped"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a failure after the stop reaches the late handler once and is never a detached rejection"
- test `tests/unit/lib/api/editor-query.test.ts` "a failure after the caller left is logged by kind and code, never its text"
- test `tests/unit/lib/api/editor-query.test.ts` "the cancellation answer of a run whose cancel the host sent is its expected end, and is not logged"
- test `tests/unit/lib/api/editor-query.test.ts` "any other late failure is still logged: another error after the cancel, or a cancellation with no cancel sent"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "an answer the host abandoned keeps its handler"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "every provider promise the host abandons keeps a rejection handler"

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

- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session does not offer is refused before the call"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a request field or a console facet the session does not offer is refused before any frame"
- test `tests/api/db/cancel.test.ts` "provider without cancelQuery returns 400"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "an engine that cannot cancel is reported still running, and nothing is called"

### C-31 (normative): A throw inside a call fails only that call

An error a provider's call throws reaches the host by reference, and that session and every other session keep serving.
An error a bridged provider throws reaches the caller by reference, through the host core and the legacy bridge, and is read into an error record where the caller answers it, `databaseErrorBody`.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "an error a call or a source throws reaches the host as the same object"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a call that throws fails only that call, and its session and the served instance keep serving"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "a socket lost mid-statement answers CONNECTION_ERROR with outcome unknown"

### C-32 (normative): The SDK keeps sessions apart

The SDK keeps no state across sessions and installs no process handler, since several copies of it share Studio's process, M-19.
The memory transport keeps each served instance's sessions in tables of its own, and each call reaches only its own session's handle.

- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source declares no top-level let or var"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source creates no top-level Map, Set, WeakMap or WeakSet"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source never reads process"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "two sessions of one served module reach only their own handles, and one session's error or close leaves the other serving"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "two served instances of one module share no session"

### C-33 (informative): A provider keeps per-session state in its handle

A provider keeps its per-session state, its connection, statement, cursor, transaction and schema, in the handle `open` answers, never in module scope.
So two sessions opened by two owners exchange no result, handle, error or cached metadata.
The kit's isolation case checks it, and no such case exists yet.

### C-34 (informative): The failure matrix

How a provider's failure ends, by kind and by runtime.
The runtimes are Studio's Next.js server, the VS Code extension's backend child under Node.js, the same child under Electron, which is how the extension forks it, and the server under Node.js started with `--unhandled-rejections=strict`.
Each "held by" cell names the clause that holds the row, or says what will hold it.
The loader, the kit's fault cases and a measurement under Electron do not exist yet, and the detached rejection row stays open until such rejections have been counted in real sessions.

| Failure | Next.js server | VS Code child, Node.js | VS Code child, Electron | Node.js, strict | Blast radius | Held by |
|---|---|---|---|---|---|---|
| The loader refuses a package | Studio starts without its engines | The same | The same | The same | That package's engines | The loader |
| A package's import throws | Studio starts without its engines | The same | The same | The same | That package's engines | The loader |
| A package's import passes its deadline | Studio stops waiting and starts without its engines, unless the import is synchronous | The same | The same | The same | That package's engines, or the process | The loader, and C-37 |
| A synchronous hang, at import or in a call | Every request waits | The same | The same | The same | The process | Only a watchdog outside the process, C-37 |
| A throw inside a call | That call fails | The same | The same | The same | That call | C-31 |
| A detached rejection | Logged, and the server keeps serving | The child exits with 1 and the extension restarts it, measured by a probe, not a test | Not measured | The server exits with 70 | None on the server, the process otherwise | C-35, with the server's own choice open |
| An uncaught exception in a callback | The server exits with 70 | The child exits with 1 and the extension restarts it, measured by a probe, not a test | Not measured | The server exits with 70 | The process | C-35 |
| A native fault in an addon | The process ends on the signal | The same | The same | The same | The process | The kit's fault cases |
| A close that never settles at shutdown | Cut after 15 s, exit 143, where Studio owns the exit | Each provider cut by C-45's deadlines when the backend's shutdown clears the caches | Each provider cut by C-45's deadlines when the backend's shutdown clears the caches | As the server | The shutdown | C-36 and C-45 |

### C-35 (normative): An uncaught exception stops the server with code 70, and a detached rejection does not

An exception that no code catches stops Studio's server with exit code 70, after one logged line.
A promise rejection that nothing handles does not stop it, unless Node.js runs with `--unhandled-rejections=strict`, which raises the rejection as an uncaught exception, so the server exits with 70 for it too ([DISTRIBUTION.md](../DISTRIBUTION.md#uncaught-errors-and-restarts)).

- test `tests/unit/lib/uncaught-exception.test.ts` "the listener logs the line once, with no stack even under NODE_ENV=development, then exits with 70"
- test `tests/unit/lib/uncaught-exception.test.ts` "attaches one uncaughtException listener and nothing else"
- test `tests/unit/lib/uncaught-exception.test.ts` "logs an unhandled rejection that Node.js raised as an uncaught exception by that origin, then exits with 70"
- test `tests/unit/uncaught-exception-documentation.test.ts` "it says an unhandled promise rejection does not stop the server, unless Node.js raises it as an exception"

### C-36 (normative): A close that never settles at shutdown is cut

Where Studio owns the exit, a provider cache close still pending 15 s into the shutdown is cut, and the exit code is 143.
Where Next.js owns the exit, Studio closes no provider.
Inside those 15 s each provider is also cut by C-45's own deadlines.

- test `tests/unit/lib/shutdown-handler.test.ts` "a cache close that never settles is cut after 15 s and the exit code is 143"
- test `tests/unit/lib/shutdown-handler.test.ts` "where Next.js owns the exit it runs the hooks, closes no provider cache and never exits"

### C-37 (informative): The import deadline cannot stop synchronous code

The loader's deadline on each import is a timer in Studio's own thread, so a synchronous loop at import or in a call blocks it as it blocks every request.
Only a watchdog outside the process detects a hung process.
The Helm chart's and the OpenShift operator's liveness probe restarts the pod.
The Compose healthcheck marks the container unhealthy and restarts nothing.
npx, the Linux packages' units, Snap, Homebrew, Windows, the desktop shell after its boot and the VS Code extension detect nothing.
The kit's import-time measurement is the check at a package's build, and no loader exists yet.

### C-38 (normative): Classification is core's, and its verdict is a closed set

Whether a statement needs a confirmation is decided by core's readers over facts core holds, never by a call into a provider.
The verdict is one of the members of `ConfirmationVerdict`, and a reader that throws asks for a confirmation.

- test `tests/unit/editor/statement-analysis.test.ts` "answers run for a read"
- test `tests/unit/editor/statement-analysis.test.ts` "answers confirm for a write"
- test `tests/unit/editor/statement-analysis.test.ts` "refuses a connection-name ask on a nameless connection"
- test `tests/unit/lib/api/run-confirmation.test.ts` "a reader that throws asks, marked classificationFailed, and logs no text"

### C-39 (normative): A protected read path is a precondition of agent and MCP statements

A provider without `queryReadOnly` is refused for agent and MCP statements before it is connected, and the plain query path is never the fallback.
The host holds the same rule on its own side: the legacy bridge's read-only statement session over a provider without `queryReadOnly` is refused at its open by name, before anything is called, and the host core refuses a plain execute on a read-only statement session before the call, C-78, so `query()` is never called on that path.

- test `tests/integration/mcp/run-read-query.test.ts` "without queryReadOnly is refused, and query() is never the fallback"
- test `tests/isolated/factory.test.ts` "refuses %s on an engine on the review record whose provider implements no read-only statement path, before connecting it, and query() is never the fallback"
- test `tests/api/agent/handover.test.ts` "refuses to replay on an engine the review record does not list, naming it, and never calls queryReadOnly"
- test `tests/unit/lib/provider-host/host-rules.test.ts` "the host never falls back from the protected read path to the plain one: a read-only statement session without queryReadOnly is refused at its open, a plain statement on one is refused before the call, and query() is never called"

### C-40 (normative): One provider kind, and no named provider method

Every package implements the mandatory calls, `console.execute` among them, so no lifecycle-only kind of provider exists.
An implementation key the contract does not define is refused, so a dialog action or a dynamic option is never a provider method of its own.
A host path field is M-12's.

- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a mandatory call that is missing or no function is refused as call-missing"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an implementation key the contract does not define is refused as impl-key-unknown"
- schema `/$defs/consoleCalls/required`

### C-41 (informative): Dialog actions, dynamic options and a provider's classification

If a provider ever needs dialog actions or dynamic select options, both come through one fixed facet call with an action id, whose answer may set only declared fields of their declared types.
If a provider ever answers a classification, it is read from a closed set, and any other answer, an error or a timeout asks for a confirmation.
No such call exists yet, so nothing checks this.

### C-42 (normative): A package depends on no other provider package

No workspace package but the kit imports, in its source or its tests, or declares, in any dependency field of its `package.json`, a name starting `@libredb/provider-` other than `@libredb/provider-sdk` and its own.
The kit, `@libredb/provider-kit`, is admitted only in a package's tests and its `devDependencies`.

- test `tests/unit/package-imports.test.ts` "no workspace package imports or declares another provider package"
- test `tests/unit/package-imports.test.ts` "a planted package that imports or declares another provider package fails by file and name, the kit admitted in its tests only"

### C-43 (informative): A provider depends on no load order

The order of the entries in the lock carries no meaning, and no provider is required for Studio to start.
The loader holds this, and it does not exist yet.

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

- test `tests/unit/lib/provider-host/core/open-once.test.ts` "concurrent callers of one key share one open"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a failed open reaches every caller and frees its key"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a caller whose signal aborts stops waiting, and the others still get the open"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a caller whose signal already aborted starts nothing and joins nothing"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "an open no caller waits for any more is admitted exactly once by its own start"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "an open that fails with no caller left reaches the unclaimed hook once, never as a detached rejection"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a discard aborts the matching flights' signals and answers them"
- test `tests/unit/lib/provider-host/core/open-once-bounds.test.ts` "a caller's signal frees it from an open that never settles"
- test `tests/isolated/factory.test.ts` "two concurrent first calls for one connection build, connect and cache one provider"
- test `tests/isolated/factory.test.ts` "a connect two concurrent callers share fails once for both, releases the tunnel once and caches nothing"
- test `tests/isolated/factory.test.ts` "twelve concurrent first acquisitions of one connection and profile construct one provider"
- test `tests/isolated/factory.test.ts` "two concurrent first tree reads of one connection open one metadata session, and a removal overtakes one in flight"
- test `tests/isolated/factory.test.ts` "a removal of the connection closes an open it overtook and caches nothing"
- test `tests/isolated/factory.test.ts` "a cache clear closes an open in flight and names one still opening at the cut"
- test `tests/isolated/factory.test.ts` "an open that settles while the caches close is closed once, admits nothing and answers not-sent, in either cache"
- test `tests/integration/db/factory-open-once.test.ts` "two concurrent first writes for one DuckDB connection both reach the file"
- test `tests/isolated/factory.test.ts` "a caller whose wait ends stops waiting with its reason, and the others still get the open"
- test `tests/isolated/factory.test.ts` "an open every caller stopped waiting for is admitted once and served from the cache"
- test `tests/isolated/factory.test.ts` "an open that fails after every caller stopped waiting is logged by its connection, kind and code, never its text"
- test `tests/isolated/factory.test.ts` "a caller whose wait already ended builds and connects nothing"
- test `tests/unit/lib/api/editor-open-bounds.test.ts` "an open that never settles is cut at the call's open allowance, not-sent"
- test `tests/api/db/query.test.ts` "the provider opens under the request's own open wait"
- test `tests/api/db/cancel.test.ts` "a cancel that leaves while its connection opens answers 499 not-sent and cancels nothing"
- test `tests/api/db/query-open-wait.test.ts` "a request that leaves while its connection opens is answered at once, and the open's later failure is logged by connection, kind and code"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "query/run opens its provider under the run's own open wait, and a token cancelled while it opens answers QUERY_CANCELLED not-sent"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "query/cancel takes its request's cancellation as its caller signal, while the provider opens and while the engine answers"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "query/cancel with a token already cancelled calls nothing"

### C-45 (normative): Teardown under fixed deadlines

When the host closes its sessions, at a shutdown or when its caches are cleared, it tears each one down under fixed deadlines, shared, owned and metadata sessions alike.
An open transaction is rolled back first, and the host waits at most 5 s for the rollback.
Then the session is closed, and the host waits at most 10 s for the close.
A step that fails or is cut is logged, the next step still runs, and the teardown itself never fails.
Each provider still open at a cut is named, by its connection, its author and Studio's version.

- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a rollback settles before the close starts"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a rollback that never settles is cut at its deadline and the close still runs"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a close that never settles is cut at its deadline"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a step that fails is reported with its error and the next step still runs"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a step that fails after its cut changes nothing and is never a detached rejection"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "a teardown leaves no timer pending once it answers"
- test `tests/unit/lib/provider-host/core/teardown-bounds.test.ts` "a close that never settles is cut by the teardown's own deadline"
- test `tests/isolated/factory.test.ts` "a shared provider in a transaction is rolled back before it is closed when the caches close"
- test `tests/isolated/factory.test.ts` "a shared provider whose disconnect never settles is cut at 10 s and named"
- test `tests/isolated/factory.test.ts` "a shared provider whose rollback never settles is cut at 5 s and still closed"
- test `tests/isolated/factory.test.ts` "the providers not closed at shutdown are named with their author and Studio's version"
- test `tests/isolated/factory.test.ts` "the close the factory registers for the shutdown names an owned provider whose rollback or disconnect timed out or failed, and a profiled one whose close failed"
- test `tests/isolated/factory.test.ts` "the caches' close tears the metadata sessions down under the teardown's deadlines and names one not closed"

### C-46 (normative): Contract first

The legacy provider interface, `DatabaseProvider` in `src/lib/db/types.ts`, gains no member.
A new capability lands in the manifest schema or a facet first, then in the bridge that serves today's providers as contract providers, then in the facade today's callers use.
The lint holds the members `DatabaseProvider` declares, so a capability read by duck typing outside the interface, as the factory's `openTransaction` reads `isInTransaction` and `rollbackTransaction`, is not a member it can see, and such a read is held by review.

- test `tests/unit/lib/db/database-provider-members.test.ts` "DatabaseProvider gains no member, so every SPI change lands contract-first"
- test `tests/unit/lib/db/database-provider-members.test.ts` "a planted member is refused by name"
- test `tests/unit/lib/db/database-provider-members.test.ts` "a removed member is refused by name, so the list stays exact"

### C-47 (normative): A cleanup call runs under a context of its own

A cleanup call ends work another call started: a close, the cancel the host sends when it stops waiting for a run, and the end of a run's scope, C-60.
It never runs under the context of the call it follows, which may have aborted, but under `cleanupContext`: a deadline `CLEANUP_DEADLINE_MS`, 10 s, after it starts, a signal that aborts only at that deadline, and the reader of the call it follows.
The memory transport closes the session of an open answer it refuses under such a context, and the host core's teardown waits for a close at most the same 10 s, C-45.

- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a cleanup call gets a context of its own, ten seconds ahead and never aborted"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a refused open answer's session is closed with a context of its own, not the open's aborted one"
- test `tests/unit/lib/provider-host/core/teardown.test.ts` "the close deadline is the SDK's cleanup deadline"
- test `tests/unit/lib/api/editor-query.test.ts` "the scope's end runs under a cleanup context of its own, ten seconds from its start, which the caller's leaving does not end"

### C-48 (normative): The host's console calls

The host core makes each console call through `executeCall`, `cancelCall`, `endScopeCall` or `transactionCall`, which answer a record of how the call ended and pass a provider's error by reference.
Before the call it checks the context with `checkCallStart`, C-27, and the request with `checkExecuteRequest`, C-9, and with `checkReadOnlyRequest` against whether the session is a read-only statement session, C-78, or the facet with `checkConsoleFacet`, C-17, and answers each refusal as a record, the signal's reason as its cause when the signal aborted, without calling the provider.
It then freezes the context and the request in place, C-12, and waits for the call with `awaitWithin` until the context's signal, C-28.
An execute's run pumps the first result with `pumpPage` within the limits the caller sets from the execute answer, C-15, under the core's page budget, C-53, closes every other result once, and answers a refusal the pump throws as a record.
A call is stopped exactly when its signal aborted and the wait rejected with that signal's reason, so a provider that throws its own signal's reason is stopped too, and the stop is answered as a record with that reason.
A stop that ends an execute after its execute answered is marked by the part of the run it ended, since the statement ran: the slot while the page waits for one, C-54, the page from its first pull until the pump answered it, and the other results while the run closes them after that.
The caller answers a stop marked as waiting for the page or for the other results as C-54 answers one waiting for the slot, `QueryCancelledError` when its own signal ended the wait and otherwise `StudioTimeoutRefusal` with Studio's sentence saying the statement answered and, for the other results, that its page was read, both outcome unknown.
A stopped execute sends the run's cancel when the session offers `console.cancel` and the request names a run, under a cleanup context of its own, C-47, and a cancel that fails or is cut is handed to the caller, never left as a detached rejection.
A transaction call is checked with `checkCallStart` and with `checkConsoleFacet` for `console.transaction`, frozen, and waited for until its signal; its answer is read with `checkTransactionAnswer`, C-57, and refused after the call, as a record, when the host cannot read it.
A statement sent with `transaction` has its execute answer read with `checkTransactionStatement` before its page is pumped; an answer the host cannot read is refused after the call, as a record, with every source closed once, and otherwise its page record carries the session state the execute answered.
A stopped transaction call or statement carries no session state.
An endScope call is checked with `checkCallStart` and with `checkConsoleFacet` for `console.endScope`, frozen, and waited for until its signal, and answers a record of the outcome its session answered, `openTransaction`, read by reference as a cancel's answer is; a stop carries its `settled`, and a failure after the stop is handed to the caller once.
Core's execute never ends a scope: the caller that minted the scope ends it through `endScopeCall`.
Core constructs no error class a caller tests with `instanceof`: the caller builds its own classes from the records, C-51.

- test `tests/unit/lib/provider-host/core/console.test.ts` "a call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a request field the session does not honour is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a read-only execute is refused before the call on a session not opened for read-only statements, and a plain execute on one that is"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a row no page can hold is refused as a record, and the source is closed once"
- test `tests/unit/lib/provider-host/core/console.test.ts` "an error the provider throws reaches the caller as the same object, and every source is closed once"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a wait the caller's signal ends answers a stop at once and sends the run's cancel with a context of its own"
- test `tests/unit/lib/provider-host/core/console.test.ts` "no cancel is sent to a session without console.cancel or for a request without a run id"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a cancel that fails after a stop reaches its handler once"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a provider that throws its own signal's reason is answered as a stop"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a call whose page its caller stops while it is read answers a stop marked as waiting for the page"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a call whose page its deadline stops while it is read answers a stop marked as waiting for the page"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a call stopped after its page was read, while its other results close, answers a stop marked as closing them"
- test `tests/unit/lib/api/editor-query.test.ts` "a page whose reading its deadline ends answers StudioTimeoutRefusal saying the statement answered, outcome unknown"
- test `tests/unit/lib/api/editor-query.test.ts` "a run whose closing of its other results its deadline ends answers StudioTimeoutRefusal saying the page was read, outcome unknown"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a cancel to a session without console.cancel is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a cancel whose signal already aborted is refused as a record"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a cancel the caller stops waiting for answers a stop, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/console-bounds.test.ts` "an execute that never settles is stopped at the call's deadline"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a transaction call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a transaction call to a session without console.transaction is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a transaction call answers the session state it was answered, and stateReported only for a begin"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "an answer the host cannot read is refused as a record after the call, never read as any state"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "an error the provider throws reaches the caller as the same object"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a transaction call the caller stops waiting for answers a stop at once with no state, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a statement sent inside a transaction answers its page with the session state after it"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a statement inside a transaction whose answer carries no readable session state is refused as a record, and every source is closed once"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a statement inside a transaction that its caller stops answers a stop with no state"
- test `tests/unit/lib/provider-host/core/console-bounds.test.ts` "a transaction call that never settles is stopped at the call's deadline"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "an endScope call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "an endScope call to a session without console.endScope is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "an endScope call answers the outcome its session answered, with the request and context frozen"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "an error the provider throws reaches the caller as the same object"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "an endScope call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/console-scope.test.ts` "a session that offers console.endScope with no endScope function is a host defect, named"
- test `tests/unit/lib/provider-host/core/console-bounds.test.ts` "an endScope call that never settles is stopped at the call's deadline"

### C-49 (normative): A turn of the event loop before every pull

A source over rows already in memory answers each pull without leaving the microtask queue, so a page pumped from it would hold the event loop until the whole page is measured.
The host core awaits one `setImmediate` turn before every pull, then refuses the pull, as `checkCallStart` answers, when the call's signal aborted or its deadline passed during that turn, the signal's reason as the refusal's cause.
So the longest the host holds the event loop over a page is one batch's pull and measure, which the host page benchmark holds under its T4 threshold.
The turn is the host's and not the SDK pump's, since the pump is also the kit's and runs where fake timers may hold `setImmediate`.

- test `tests/unit/lib/provider-host/core/turns.test.ts` "the host yields one turn of the event loop before every pull"
- test `tests/unit/lib/provider-host/core/turns.test.ts` "a signal that aborts during the turn stops the pull it precedes"

### C-50 (normative): The legacy bridge serves today's providers as contract sessions

The legacy bridge serves a provider of the legacy interface, `DatabaseProvider`, as one session of console execute, cancel, endScope and transaction, of the object tree, of maintenance and of monitoring, built per call by the caller's facade, so today's providers run through the host core's console calls, C-48.
Its execute honours `params` and `offset` for every engine, so each provider answers both as it always has, its own refusal of an offset included.
It offers `console.cancel` exactly when the provider can cancel a run.
It offers `console.endScope` exactly where the provider ends the transactions its query path left open, and its `endScope` runs the provider's `endOpenQueryTransaction` with the request's scope and answers its outcome; its execute hands the provider the request's scope and ends nothing itself.
It offers `console.transaction` exactly when the provider holds a transaction session, the duck typing of begin, commit and rollback the transaction route has always read.
It offers `objects.tree` on every session, since every legacy provider holds the five tree members.
It offers `maintenance.run` on every session, since every legacy provider holds `runMaintenance`, and `maintenance.preview` exactly where the provider holds `previewMaintenance`.
It offers `monitoring.panel` on every session, and `monitoring.poolStats` exactly where the provider holds a pool statistics read.
The session's panels are its engine's row of monitoring panels, by identity, where the provider holds the member of every panel the row offers, as every shipped provider does.
Otherwise they are a frozen copy of the row with each panel whose member the provider does not hold not offered, a member held as the pool statistics read is, a function on the provider or its prototype, so the host refuses a call for such a panel before the call and never calls a member that is not there.
Its panel call runs the panel's own member with today's argument and answers its answer under the panel's key by reference, and its pool statistics call answers the provider's own statistics by reference, a synchronous throw as the call's rejection.
Neither calls `forCatalog`, and each passes a provider's error by reference.
It serves `health` on every session, since every legacy provider holds `getHealth`: its health call runs `getHealth` with no argument and answers its answer by reference, a synchronous throw as the call's rejection, never calls `forCatalog`, and passes a provider's error by reference.
Its run calls `runMaintenance` with exactly three arguments, the operation, the target and the container, `undefined` for an absent one, and its preview calls `previewMaintenance` with the operation and a fresh copy of the path.
Each answers the provider's answer by reference, never calls `forCatalog`, and passes a provider's error by reference.
The session's maintenance is the provider's declaration before it connects, narrowed through `sessionMaintenance` by the refinement the bridge answers from the connected provider's capabilities, C-68.
That refinement names, for each declared operation with a spec, the placements both the declaration and the connected provider say true, both false where the connected provider no longer lists the operation, and only where that differs from the declaration, so the session's maintenance never offers more than the declaration.
Its tree call runs the provider's own member for the action with a fresh copy of each path and today's arguments: `listContainers` with one argument, the parent or `undefined` at the top level, `countObjects`, `listObjects`, `describeObject`, and `describeObjects` with the limit, `defaultSql` passed only when the request sends it.
It answers the member's answer by reference in its action's form, never calls `forCatalog`, and a provider's error passes by reference.
A top-level `containers` read of a provider that answers the inventory's configuration question, `inventoryNeedsConfiguration`, a function on the provider or its prototype, asks it first: a reason answers no container and the reason as `needsConfiguration` without listing, C-61, and no reason lists as before; below the top level, and for a provider without the member, the read lists as before.
The bridge's session takes a host-side input a tree request does not carry, the billed-read allowance: a session built with one hands a fresh options object holding it by reference as the trailing argument of `countObjects`, `listObjects` and `describeObjects`, beside `defaultSql` where the request sends it, and a session built without one passes today's arguments.
MCP's tree reads, and the source, edit and key scan routes, still call the provider themselves until they move onto the host core; the agent's grounding walk reads through it, C-80.
Its transaction call runs the provider's own method for the action, a begin with `requireReportedState` as the transaction route has always passed it, answering `stateReported` exactly when the provider answered a result, and `state` runs nothing.
Every transaction answer's session state is the provider's `isInTransaction()` read after the call, so through the bridge a state is `in-transaction` or `not-in-transaction`, and the bridge keeps none between calls.
A statement sent with `transaction` runs the provider's prepare, the probe row past the page and `queryInTransaction` with a new array of the request's params, with no run id, no scope and no transaction ender, since it runs on the transaction's own connection, and answers the session state read after it.
A provider's error passes by reference.
The transaction route's script of several statements still calls `queryInTransaction` itself, statement by statement, until it moves with `POST /api/db/multi-query`, and reads only the state after them through the host, C-59.
Its execute hands the provider a fresh copy of the caller's own page options and a new array of the request's params, so a provider that writes what it receives changes nothing the host froze, and runs the provider's prepare, the probe row past the page and the statement as the editor query always ran them.
It answers one source per result set, the main rows first.
A source reads each row positionally under the result's columns in its value codec form, or, when the codec refuses a cell, in the JSON form the answer writes for that row, sizes it with the pull's measure, C-15, and answers that same array, so each row is measured once, in the form closest to its answer.
Which cells the codec refuses is read before encoding, the codec's domain read as the codec reads it, so no codec error is thrown per row, and every error measuring a row throws passes by reference.
A key a row holds outside its columns is answered and not measured.
The page's row limit is set once execute answered: one past the page when the provider applied the page, otherwise every row the provider returned, at least one.
That session is no read-only statement session: it serves the editor's and the operations profile's sessions, none of which is sent read-only statements.
A provider's read-only statement path is served as a read-only statement session of its own, C-78, built per call by its facade over a provider acquired under a profile whose open policy has both `readOnly` and `sendsStatements`, C-79.
Its open refuses a provider without `queryReadOnly` by name, in the words the execution-profile acquisition uses, and calls nothing, C-39.
Its calls offer execute alone, honouring `readOnly`.
Its execute runs `queryReadOnly` with the statement, a fresh budget of the open's statement timeout and billed-read allowance, by reference, and the request's rows and bytes, and the request's mode, and never the prepare, the probe or the plain query.
It answers one source per result set, the main rows first, its page not applied, and its page's row limit is every row the provider returned, at least one, within one page.
A statement Studio composed and its statement guard admitted, which must reach the provider exactly as composed, is served as a composed statement session of its own, built per call by its facade, C-80.
Its calls offer execute alone, honouring no request field, and it is no read-only statement session.
Its execute runs the provider's plain `query` with exactly one argument, the request's statement, and never the prepare, the probe, params, a run id or a scope, so no page bound is appended to the statement.
It answers and limits its page as the read-only statement session does, and reads no engine row.

- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a read-only statement session runs the provider's queryReadOnly with the request's rows, bytes and mode and the open's timeout and read allowance, and never its plain query"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a read-only statement session over a provider without queryReadOnly is refused at its open by name, and nothing is called"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the bridge's console session is no read-only statement session, and the read-only one offers nothing but execute"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a composed statement session runs the provider's plain query with the statement as composed and nothing else, never prepareQuery or the probe"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a composed statement session offers execute alone, honouring no request field, and is no read-only statement session"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session honours params and offset, offers cancel only where the provider cancels, and endScope only where the provider ends its query path's transactions"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged endScope runs the provider's ender on the scope it is sent and answers its outcome, its failure by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session offers the transaction facet exactly where the provider is a TransactionProvider"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session offers objects.tree for every provider"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session offers maintenance.run for every provider and maintenance.preview exactly where the provider previews"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session offers monitoring.panel for every provider and monitoring.poolStats exactly where the provider reads its pool statistics"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session's panels are its engine's row"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a panel whose member the legacy provider does not hold is not offered on its session, and a provider holding every member keeps its engine's row"
- test `tests/isolated/monitoring-panels-census.test.ts` "every shipped provider holds the member of each panel its engine offers, so its bridged session offers its engine's row"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged panel call runs the panel's own member with today's argument and answers its answer by reference under the panel's key"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged pool statistics call answers the provider's own statistics by reference, and a throw as its rejection"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged health call runs getHealth with no argument and answers its health by reference, and a throw as its rejection"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged maintenance run calls runMaintenance with the operation, the target and the container, undefined where absent, and answers its result by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged maintenance preview calls previewMaintenance with a copy of the path and answers its preview by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged maintenance call whose member throws passes the error by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session's maintenance is the provider's declaration, narrowed through sessionMaintenance by what the connected provider still accepts"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session's maintenance never offers more than the declaration"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged tree call runs the provider's own member for each action with today's arguments, and answers its answer by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged tree call never calls forCatalog"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged tree call hands the session's read allowance by reference to count, list and describeMany, and today's arguments where the session has none"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged top-level containers read asks the provider whether its inventory needs configuration first, and given a reason answers no container and the reason without listing"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged containers read below the top level, or of a provider that cannot say, lists as before and carries no reason"
- test `tests/unit/db/modbus/index.test.ts` "a connection with no register map answers its top-level tree listing with no unit and the reason, and a malformed map with the error its listing raises"
- test `tests/isolated/inventory-configuration-census.test.ts` "every shipped provider that answers the inventory's configuration question declares a container level, so the grounding walk asks it on its top-level listing"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged tree call whose member throws passes the error by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a legacy tree member that writes the paths it receives changes nothing the host froze"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged begin, COMMIT, ROLLBACK and state read call the provider's methods and answer its state after each"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged begin hands the provider requireReportedState as the route always did, true only when asked"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged statement inside the transaction prepares, probes and runs queryInTransaction, with no run id, no scope and no ender, and answers the state after it"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged transaction call whose provider throws passes the error by reference"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session reads the provider's state on every call, and keeps none"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a legacy provider that writes what it receives changes nothing the host froze"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the run prepares, probes and queries with the request's own scope, and ends nothing itself"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "every result set is a source, the main rows first"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the bridge sizes every row it answers with the pull's measure, and answers that same array"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a cell outside the value codec is measured in its JSON form and answered unchanged"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a measuring error other than the codec's passes as the same object"
- test `tests/unit/lib/provider-host/legacy-bridge-measure.test.ts` "a row with an undefined cell is measured in its JSON form, and the codec throws nothing"
- test `tests/unit/lib/provider-host/legacy-bridge-measure.test.ts` "a row with a Map is measured in its JSON form, and the codec throws nothing"
- test `tests/unit/lib/provider-host/legacy-bridge-measure.test.ts` "a row with a class instance, nested in a cell, is measured in its JSON form, and the codec throws nothing"
- test `tests/unit/lib/provider-host/legacy-bridge-measure.test.ts` "the bridge reads the codec's domain as the codec does, for every kind it takes and refuses"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "the page's row limit is the probe limit for a bound Studio wrote, and every returned row otherwise"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged cancel names the run and answers the provider's boolean"

### C-51 (normative): The host's records become the calling bundle's classes

The accessor, in the calling bundle, builds Studio's error class from each record the host core answers, so a class a caller tests with `instanceof` is always its own bundle's.
A refusal or a stop whose reason is the caller's own signal's reason is `QueryCancelledError`, with the sentence a cancelled query has always answered.
A refusal of a passed deadline or of any other aborted signal, and any other stop, is `StudioTimeoutRefusal`, with Studio's sentence naming the wait.
A row no page can hold is `StudioByteBudgetRefusal`, naming the page's bytes and the row's size, outcome unknown, since the statement ran.
A refusal before the call was made answers outcome not-sent, E-5; once the provider was called the outcome stays unknown.
A call's wait for its provider's open that ended answers `QueryCancelledError` when its reason is the caller's own and `StudioTimeoutRefusal` naming the open otherwise, both outcome not-sent, since no statement was sent; any other failure of the open passes as the same object.
Every other refusal is a defect of Studio's own bridge, which honours every request field and is sent a scope only where it offers `console.endScope`: a plain error naming each refusal's sentence.
A refused offset and refused params of a session that refuses a field arrive with the first such session.
A caller whose time refusal is its own reads the records through a budget view: a refusal or a stop whose reason is the caller's own is `QueryCancelledError` as above, a refusal of a passed deadline or of any other aborted signal, and any other stop, whatever wait it ended, is the caller's own time refusal, built fresh for the call, and every other refusal answers as above.

- test `tests/unit/lib/provider-host/access.test.ts` "a call the caller left is answered as QueryCancelledError, not-sent before the call and unknown after it"
- test `tests/unit/lib/provider-host/access.test.ts` "a call past its deadline is answered as StudioTimeoutRefusal, not-sent before the call and unknown after it"
- test `tests/unit/lib/provider-host/access.test.ts` "a row no page can hold is answered as StudioByteBudgetRefusal, outcome unknown"
- test `tests/unit/lib/provider-host/access.test.ts` "any other refusal is a host defect named by its rule"
- test `tests/unit/lib/provider-host/access.test.ts` "every class the accessor builds is the calling bundle's own"
- test `tests/unit/lib/provider-host/access.test.ts` "a budget view's stop or refused start is QueryCancelledError when the caller left, and otherwise the caller's own time refusal"
- test `tests/unit/lib/api/editor-query.test.ts` "the open allowance is the engine's connect budget"
- test `tests/unit/lib/api/editor-query.test.ts` "an open is handed the call's own wait, which the caller's leaving or the allowance ends"
- test `tests/unit/lib/api/editor-query.test.ts` "an open the caller left answers QueryCancelledError, not-sent"
- test `tests/unit/lib/api/editor-query.test.ts` "an open past its allowance answers StudioTimeoutRefusal naming the engine's budget, not-sent"
- test `tests/unit/lib/api/editor-query.test.ts` "an open's own failure passes as the same object"
- test `tests/api/db/query.test.ts` "a request that leaves while its connection opens answers 499 not-sent and runs nothing"

### C-52 (normative): One host core per process

A process holds one host core, created by `createHostCore` and installed under a registered symbol by the process's composition root, which the install names: the server's instrumentation and the VS Code backend's entry.
The core holds plain functions, the console calls, the tree call, the maintenance calls, the monitoring calls and the health call, and constructs no class, so a caller in any bundle of the process runs the core another bundle installed.
Its execute runs under a page budget the core creates for itself, C-53, so the process holds one page budget as it holds one core.
The classes a caller tests with `instanceof` and the ports that read them stay the caller's, built per call, C-51.
A call made before the core is installed fails by name, as a defect of how the process was composed, and nothing reaches the provider.
A second install from the same composition root keeps the first core and its page budget and changes nothing, so the server's `register()` may run again in one process.
A second install from another composition root is refused by name, naming both roots, and the first core stays, so no second core is ever used.
The library surface never reads the installed core, so an embedder composes nothing.
The live check `tests/live/host-core-live.ts` holds the same rule against the built standalone server, in CI's "Host Core Live Check".

- test `tests/unit/lib/provider-host/core/host-core.test.ts` "the host core holds the console calls on a page budget of its own, the tree call, the maintenance calls, the monitoring calls and the health call, frozen, and nothing else"
- test `tests/unit/lib/provider-host/instance.test.ts` "the host core is installed once per process, under a registered symbol"
- test `tests/unit/lib/provider-host/instance.test.ts` "a second install from the same composition root keeps the first core, and throws nothing"
- test `tests/unit/lib/provider-host/instance.test.ts` "a second install from another composition root is refused by name, naming both roots, and the first core stays"
- test `tests/unit/instrumentation.test.ts` "register() installs the shutdown handler once, and before the auth bootstrap"
- test `tests/unit/lib/provider-host/instance.test.ts` "a call made with no host core installed fails by name, and nothing reaches the provider"
- test `tests/unit/lib/provider-host/instance.test.ts` "only a composition root creates the host core, and only the core reaches its console calls"
- test `tests/unit/lib/provider-host/instance.test.ts` "no module the library entries reach reads the host core, so an embedder needs none"
- test `tests/unit/instrumentation.test.ts` "register() installs the provider host core once, after the boot checks"
- test `tests/unit/instrumentation.test.ts` "a boot a check refuses installs no host core"
- test `vscode-extension/test/unit/backend-start.test.ts` "installs the provider host core, then starts the backend on its own process, which under Mocha has no IPC channel"
- test `tests/unit/lib/provider-host/cross-bundle.test.ts` "the two bundles hold two copies of Studio's errors, as instrumentation and a route do"
- test `tests/unit/lib/provider-host/cross-bundle.test.ts` "a route runs the host core instrumentation installed, and builds none of its own"
- test `tests/unit/lib/provider-host/cross-bundle.test.ts` "a refusal the host core answers as a record becomes the route bundle's own class"
- test `tests/unit/lib/provider-host/cross-bundle.test.ts` "a provider error the route bundle built passes through the host core by reference"

### C-53 (normative): The host's page budget

A host core holds one page budget of large-page slots, and the budget holds one slot.
Every page takes its first batch without waiting, at most one batch's bytes or one row.
A page that needs a second batch first takes a slot, waiting for one in arrival order until its call's signal aborts, and runs every later pull under it.
A wait its call's signal ends is refused as `checkCallStart` refuses that call, and any other failure of the take passes by reference.
A waiting page holds its first batch and no slot, so no two pages wait on each other.
The caller releases a page record once its answer body is built, exactly once, and the host releases a page that ends any other way: a run that answers no page gives its slot back before it answers, and a page answered after its call stopped is released by the host.
A slot or a page record released twice is refused by name.
The slot count does not follow the heap limit V8 reports, which adds a young generation whose size differs by Node version and machine.
The budget does not bound a legacy provider's own rows, held before the first pull, nor the caller's answer text, written from the body after the release, nor one row of up to the whole page taken as a first batch.

- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a free slot is taken at once, and a host core's budget holds one slot"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a page that finds every slot held waits, and slots go in arrival order as they are released"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a wait its signal ends rejects with the signal's reason and leaves the queue"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a signal already aborted is refused at once and takes no free slot"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a slot released twice is refused by name"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a slot count that is not a positive safe integer is refused"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a page's first pull takes no slot, and every later pull runs under the one slot it took"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a pull whose wait for a slot the call's signal ends is refused as checkCallStart answers, the signal's reason as its cause, and the source is not pulled"
- test `tests/unit/lib/provider-host/core/page-budget.test.ts` "a take that fails for a reason other than the call's signal passes that failure by reference"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "every page takes its first batch without waiting"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "of two concurrent large pages the second waits for the slot holding one batch, and is pumped once the first page is released"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "three concurrent large pages are pumped one after another in arrival order, each waiting page holding one batch and no slot"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a page of one batch answers at once beside a large page that holds the slot"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a page whose pump is refused or fails, or whose other results fail to close, gives its slot back before the call answers"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a page answered after its call stopped gives its slot back"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a page record released twice is refused by name"
- test `tests/unit/lib/provider-host/core/page-budget-bounds.test.ts` "a large page waiting behind a slot that is never released is stopped at its call's deadline"
- test `tests/unit/lib/provider-host/core/host-core.test.ts` "each host core holds one large-page slot of its own"
- test `tests/unit/lib/api/editor-query.test.ts` "a large page's slot is released once its body is built, so the next large page does not wait"
- test `tests/unit/lib/api/editor-query.test.ts` "two concurrent large pages each answer their whole page"

### C-54 (normative): A wait for a large-page slot that ends

A page whose wait for a large-page slot, C-53, its call's signal ends answers a stop marked as waiting for the slot.
The caller answers `QueryCancelledError` when its own signal ended the wait, and otherwise `StudioTimeoutRefusal` with Studio's sentence naming that wait, both outcome unknown, since the statement ran.
The run's cancel is sent as for any stop, C-48, and the page's first batch is closed with its source.

- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a call whose wait for a slot its caller ends answers a stop marked as waiting for the slot, and holds no slot"
- test `tests/unit/lib/provider-host/core/console-pages.test.ts` "a call whose wait for a slot its deadline ends answers a stop marked as waiting for the slot"
- test `tests/unit/lib/provider-host/core/page-budget-bounds.test.ts` "a large page waiting behind a slot that is never released is stopped at its call's deadline"
- test `tests/unit/lib/api/editor-query.test.ts` "a large page that waits for the slot past its deadline answers StudioTimeoutRefusal naming that wait, outcome unknown"

### C-55 (normative): An open ends at its engine's connect budget

Each open has a deadline, its engine's connect budget from the open's start, M-51, which the host core reads once when the open starts.
At that deadline the open is over: every caller still waiting for it, one without a wait of its own included, is answered that the connection did not open within the budget, as Studio's timeout refusal with outcome not-sent.
The open leaves the open table at its deadline, so the next caller of its key starts a new open instead of joining one that may never settle.
The open itself goes on until its connect settles, then closes what it opened exactly once and admits nothing, and a failure it settles with is logged as C-44 states.
A late settle of an expired open never removes the open that replaced it.
Until it settles, an expired open stays where a cache close still finds it but no caller can join it, so a cache close waits for it as for any open in flight, C-44, and names it when it is still connecting at the close deadline.
A deadline is the host's, not a removal's: a removal keeps an overtaken open in the table so a caller arriving meanwhile joins it, C-44.
A provider that bounds nothing of its own on a server that accepts and never answers keeps its socket until its connect settles, since the host closes what an open opened only once it settles.

- test `tests/unit/lib/provider-host/core/open-once.test.ts` "an open still pending at its deadline fails every waiting caller with the owner's expired error, and leaves the table"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "the next caller after an open's deadline starts a new open"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a late settle of an expired open leaves the open that replaced it in the table"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a late failure of an expired open reaches the unclaimed hook once, never as a detached rejection"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "an open that settled before its deadline is not expired by it afterwards"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a deadline already passed when the open starts expires it at once"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a discard still reaches an open its deadline ended while that open is pending, and no longer once it settled"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "a discard reaches an expired open beside the open that replaced it under its key"
- test `tests/unit/lib/provider-host/core/open-once.test.ts` "the deadline signal is read once per open, with its meta"
- test `tests/unit/lib/provider-host/core/open-once-bounds.test.ts` "an open that never settles is ended by its own deadline"
- test `tests/isolated/factory.test.ts` "an open still connecting at its engine's connect budget answers StudioTimeoutRefusal not-sent to every caller, one without a wait included"
- test `tests/isolated/factory.test.ts` "the next call after an open's deadline builds and connects a new provider"
- test `tests/isolated/factory.test.ts` "a provider whose connect settles after its open's deadline is closed once and never cached"
- test `tests/isolated/factory.test.ts` "an execution-profile open ends at the same budget"
- test `tests/isolated/factory.test.ts` "a cache clear names an open its deadline ended that is still connecting at the cut"
- test `tests/api/db/query-open-wait.test.ts` "a connection whose open never settles is opened afresh by the next request after its connect budget"

### C-56 (normative): Test connection answers within its engine's connect budget

A Test connection has one deadline, its engine's connect budget from the test's start, M-51, over the whole test: the tunnel's open, the provider's build, its connect, the checks a provider runs only for a test and the health read.
At that deadline the test answers a connection error naming the budget, never a caution or a degraded success.
A one-shot tunnel closes at once, a provider already connected is closed at once, and a provider still connecting is closed once its connect settles, since no provider promises a disconnect during its connect.
The same deadline holds on the Test connection route and in the VS Code backend's `connection/test`, which keeps no deadline of its own.

- test `tests/unit/lib/api/test-connection.test.ts` "a connect still pending at the engine's connect budget rejects with the test's ConnectionError, and its provider is closed once the connect settles"
- test `tests/unit/lib/api/test-connection.test.ts` "a connect that fails after the deadline gets its provider closed too, and its failure goes nowhere"
- test `tests/unit/lib/api/test-connection.test.ts` "a deadline that passed while the tunnel opened builds nothing"
- test `tests/unit/lib/api/test-connection.test.ts` "a deadline that passed while the provider was built starts no connect, and closes what was built"
- test `tests/unit/lib/api/test-connection.test.ts` "checks or a health read still pending at the deadline answer the test's ConnectionError, never a caution or a degraded success"
- test `tests/unit/lib/api/test-connection.test.ts` "a health read whose deadline passed before its timer fired answers the test's ConnectionError and reads no health"
- test `tests/unit/lib/api/test-connection.test.ts` "the deadline names the engine's own budget"
- test `tests/unit/lib/api/test-connection-bounds.test.ts` "a connect that never settles is cut at the test's deadline"
- test `tests/api/db/test-connection.test.ts` "a test with no answer within the engine's connect budget answers 503 CONNECTION_ERROR with the test's sentence, and closes its provider once the connect settles"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "hands the core the connection, posture and route only, so the core's deadline bounds the test"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "answers the core's deadline error as CONNECTION_ERROR with its sentence, its own status and code"

### C-57 (normative): The transaction facet

`console.transaction` is one console facet, offered or not in `calls.console.transaction` like every other, and implemented as one function whose request names its action, one of `TRANSACTION_ACTIONS`.
`begin` opens a transaction on the session, and may set `requireReportedState`, so a provider that cannot read the transaction state from the server refuses the begin rather than answer a state it guessed.
`commit` and `rollback` end the transaction, and `state` reads the session state and changes nothing.
Every answer carries `sessionState`, one of `SESSION_STATES`, the state of the session after the call, and only a begin may carry `stateReported`, whether the server reported the transaction state.
A statement inside the transaction is console execute sent with `transaction`: the provider runs it on the transaction's own connection, and its answer carries `sessionState` too.
A statement sent without `transaction` runs outside any transaction the facet opened, on another of the session's connections.
The host reads a transaction answer with `checkTransactionAnswer` and a statement's answer with `checkTransactionStatement`, which refuse by name, as `transaction-answer-unreadable`, a session state that is missing, outside its vocabulary or an accessor, a `stateReported` on another action than begin or of another type, any other key, and an answer that is no plain record.
Each reads the answer by its own property descriptors, never calls a getter, and names no value of the answer, so a state the host cannot read is refused, never read as any state.

- schema `/$defs/consoleCalls/properties/transaction`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "console calls that leave out transaction are refused as missing-key"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the transaction actions are begin, commit, rollback and state"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the transaction facet is declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/transaction.test.ts` "a transaction answer is a session state, and stateReported only for begin"
- test `packages/provider-sdk/tests/calls/transaction.test.ts` "a missing or unknown session state is refused by name, and no getter is called"
- test `packages/provider-sdk/tests/calls/transaction.test.ts` "stateReported on another action, a key a transaction answer cannot have, or no record at all is refused by name"
- test `packages/provider-sdk/tests/calls/transaction.test.ts` "a statement answered inside a transaction carries its session state, and one without is refused by name"
- test `packages/provider-sdk/tests/calls/transaction.test.ts` "no transaction answer refusal carries a value of the answer"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served transaction call crosses its request and answer as frames, and a statement inside the transaction carries its session state back"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a transaction request is one of its actions, and only begin carries requireReportedState"

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

- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "the core asks the session on every call and keeps no state between calls"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "a bridged session reads the provider's state on every call, and keeps none"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a COMMIT the caller leaves answers QueryCancelledError outcome unknown and an unknown state, with no state read"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a COMMIT or ROLLBACK the provider fails answers its error by reference and the state read at once after it"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a state read after a failure that is stopped or fails answers unknown, and a failing read is logged by kind and code"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a state read answers the session's state, and a stopped read answers unknown"
- test `tests/unit/lib/api/editor-transaction.test.ts` "an unknown state is answered as inTransaction null, never false"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the owner's own call settles the record by the state it answered"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the reconcile resolves a record by the state it read, and an end seen on an unknown state is recorded unknown"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a lease that lapses on an unknown state records unknown, never timed-out"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch records unknown for an unresolved record its read finds closed, and nothing for an open or unknown one"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a reload that takes the grant away records unknown for a record whose state is unknown"
- test `tests/api/db/transaction.test.ts` "a statement whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner"
- test `tests/api/db/transaction.test.ts` "a COMMIT whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner"
- test `tests/api/db/transaction.test.ts` "an unknown state answers inTransaction null, and the next read that finds the transaction resolves it"
- test `tests/api/db/transaction.test.ts` "a script whose state read after its statements fails answers the statements' results with inTransaction null, and keeps the transaction and its owner unresolved"
- test `tests/api/db/transaction.test.ts` "while a BEGIN whose caller left still runs, the status read answers inTransaction null, and who holds the record"
- test `tests/api/db/transaction.test.ts` "governance: an unknown state records no terminal event, and a later read that finds no transaction records unknown, never timed-out or rolled-back"
- test `tests/api/db/transaction.test.ts` "governance: an unknown state the next read finds still open is resolved, and a later provider timeout records timed-out"
- test `tests/api/db/transaction.test.ts` "governance: a COMMIT that fails after it may have reached the database and leaves no transaction records unknown, never rolled-back"
- test `tests/api/db/transaction.test.ts` "governance: a COMMIT refused before it was sent that leaves no transaction records rolled-back"
- test `tests/api/db/transaction.test.ts` "governance: a COMMIT whose caller leaves records an open event, and the end a later read finds is recorded unknown"
- test `tests/unit/lib/provider-host/core/console-transaction.test.ts` "a stopped transaction call's record settles once the call it stopped waiting for settles, answered or failed"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a stopped execute's record settles once the run it stopped waiting for settles, answered or failed"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a call Studio stopped waiting for keeps the record unresolved until it settles, whatever a read or answer finds open"
- test `tests/api/db/transaction.test.ts` "governance: a read that finds the transaction open while a COMMIT whose caller left still runs keeps the state unknown, and the end found after it is recorded unknown"
- test `tests/api/db/transaction.test.ts` "governance: a ROLLBACK sent while a COMMIT whose caller left still runs is refused and sends nothing, and the end the read after the COMMIT settled finds is recorded unknown"
- test `tests/api/db/transaction.test.ts` "governance: a COMMIT sent while a ROLLBACK whose caller left still runs is refused and sends nothing, and the end the read after the ROLLBACK settled finds is recorded unknown"
- test `tests/api/db/transaction.test.ts` "a BEGIN, statement, COMMIT or ROLLBACK sent while a COMMIT whose caller left still runs is refused 409 by name and sends nothing, and once it settled the ROLLBACK is sent and answers by its own outcome"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a read that finds no transaction while a call Studio stopped waiting for still runs keeps the record unresolved, and one after it settled releases it"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch records nothing while a call Studio stopped waiting for still runs, and looks again until it has settled"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch records nothing for a read a call Studio stopped waiting for began during, and looks again"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a state read taken before the record was claimed, changed or ended neither settles nor resolves it"
- test `tests/api/db/transaction.test.ts` "a state read that began before the owner's newer BEGIN claimed the record neither releases nor settles it when it answers"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a call of the owner's in flight keeps every read from acting on the record, and its own answer settles it"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch looks again and records nothing while a call of the owner's is in flight, and once it answered a read that finds no transaction records timed-out once"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch records nothing for a read the record changed during, and looks again"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "the watch's repeated looks stop once the record's lease has lapsed"
- test `tests/api/db/transaction.test.ts` "governance: a read that answers while the owner's COMMIT has committed but not yet answered keeps the record and records nothing, and the COMMIT records committed"
- test `tests/api/db/transaction.test.ts` "a BEGIN the owner sends on their own record that Studio stops waiting for holds the record's calls until it settles"
- test `tests/api/db/transaction.test.ts` "governance: a credential change while the owner's stopped COMMIT still runs records unknown, never rolled-back, and answers rolledBack false"
- test `tests/api/db/transaction.test.ts` "governance: a provider timeout that ends the transaction while a statement runs is recorded unknown once the statement answers"
- test `tests/api/db/transaction.test.ts` "governance: a typed COMMIT statement, alone or ending a script, records exactly one terminal event, unknown"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a reload that takes the grant away records unknown while a call of the owner's is in flight or stopped"
- test `tests/api/db/transaction.test.ts` "governance: a reload that tears down the owner's providers while their COMMIT still runs records unknown, never rolled-back"
- test `tests/unit/lib/api/transaction-ownership.test.ts` "a claim over a record whose end was not recorded records that end unknown, once"
- test `tests/api/db/transaction.test.ts` "governance: a BEGIN that opens a new transaction while the owner's statement still runs on the old record records the old one's end unknown"
- test `tests/api/db/transaction.test.ts` "governance: a read that finds no transaction while a BEGIN whose caller left still runs keeps the record, so the transaction it opens stays its caller's and its end is recorded unknown"
- test `tests/api/db/transaction.test.ts` "governance: a lease that lapses on an unknown state records unknown, never timed-out"
- test `tests/api/db/transaction.test.ts` "governance: a credential change on a transaction whose state is unknown records unknown unless a rollback answered"

### C-59 (normative): The transaction route on the host

`POST /api/db/transaction` makes every call on its session through the host core, behind its caller facade: a begin, a COMMIT, a ROLLBACK and the state read are transaction calls, C-57, and one statement inside the transaction is console execute sent with `transaction`.
A begin, a statement, a COMMIT and a ROLLBACK wait until the statement timeout plus 10 s, and the state read until the cleanup deadline, C-47, each also ended by the request's signal.
A call the request left is answered at once as `QueryCancelledError`, and a call past its deadline as `StudioTimeoutRefusal` in a sentence naming the statement and what it may have left, both outcome unknown, or not-sent when refused before the call.
The connection opens within its engine's connect budget and while the request stays, C-51 and C-55.
A statement's page is held to the host's page budget, C-53, and answered as the editor query answers it.
The rollback after a credential change reads the state and rolls back within 5 s of Studio's own, under a signal the request's leaving does not end, since it is Studio's cleanup, which the caller did not ask for.
A begin Studio stopped waiting for, on a key with no record whose session held no transaction before it, is claimed for its caller alone, its state unknown, since it may have opened a transaction only that caller can own.
A begin the session answers with no transaction held claims nothing and is refused in Studio's words.
The transaction route's script of several statements is excepted, C-50.

- test `tests/unit/lib/api/editor-transaction.test.ts` "each transaction call's deadline is the statement timeout plus ten seconds, and a state read's the cleanup deadline"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a begin past its deadline is refused before the provider is called, not-sent"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a BEGIN, COMMIT or ROLLBACK past its deadline answers StudioTimeoutRefusal naming it, outcome unknown, state unknown"
- test `tests/unit/lib/api/editor-transaction.test.ts` "a statement inside the transaction answers its page as runEditorQuery does, with the session state after it"
- test `tests/unit/lib/api/editor-transaction.test.ts` "the rollback after a credential change runs on Studio's own 5 s allowance, never the caller's"
- test `tests/unit/lib/api/editor-transaction-bounds.test.ts` "a rollback after a credential change that never answers is abandoned at its 5 s allowance, unconfirmed"
- test `tests/unit/lib/api/editor-transaction-bounds.test.ts` "a COMMIT that never answers is stopped at its deadline, its state unknown"
- test `tests/api/db/transaction.test.ts` "a begin whose caller leaves claims for its caller alone the transaction it may have opened"
- test `tests/api/db/transaction.test.ts` "a call past its deadline answers 504 with outcome unknown, and keeps the transaction and its owner"
- test `tests/api/db/transaction.test.ts` "a request that leaves while its connection opens answers 499 not-sent and runs nothing"
- test `tests/api/db/transaction.test.ts` "a begin whose session answers it holds no transaction answers 400 with the reason, and holds nothing"
- test `tests/api/db/transaction.test.ts` "a statement's page is held to the host's page budget, as on POST /api/db/query"
- test `tests/api/db/transaction.test.ts` "governance: a rollback after a credential change waits on Studio's own 5 s allowance, and one the host stops waiting for answers 409 unconfirmed"
- test `tests/api/db/transaction.test.ts` "the transaction route reads no session state but through the host"

### C-60 (normative): A run's scope ends through console.endScope, after the run

The caller that runs statements in a scope mints it, one per request, sends it with every execute of the request and only to a session that offers `console.endScope`, C-9, and ends it once through `endScopeCall`, C-48, under a cleanup context the caller's leaving does not end, C-47.
A provider that offers `console.endScope` keeps the connection that holds a transaction a scope's statements opened to that scope while the transaction is open, and lends it to no other scope or caller, until `endScope` for that scope has answered.
The legacy bridge's postgres provider does not hold this rule today: its `query()` returns such a client to its pool, and the end comes after the run's pump, so another request can borrow the client in between and run inside that transaction; the backlog tracks it as [D620](../BACKLOG.md).
The editor query ends its run's scope once its execute answered or failed, before its answer is built, and after a stop once the stopped call's `settled` resolved; a run refused before its call ran nothing and ends none.
An end that fails is answered in the run's place, its error by reference, and an end its deadline stopped answers `StudioTimeoutRefusal` naming the end, outcome unknown; after a stop, either is logged by kind and code, since the stop was already answered.
The answer carries `openTransaction: "rolled-back"` only when the end answered it.
`POST /api/db/query` and the VS Code backend's `query/run` end their run's scope so.
`POST /api/db/multi-query` ends its script's scope so once every statement settled, its statements still calling the provider with the scope themselves, C-50, and answers 504 naming the end when its cleanup deadline stopped it.
Only the legacy bridge calls a provider's `endOpenQueryTransaction`.

- test `tests/unit/lib/api/editor-query.test.ts` "the run on a session that offers console.endScope is sent a scope of its own, and that scope is ended once after the run"
- test `tests/unit/lib/api/editor-query.test.ts` "a provider that declares no transaction ender is sent no scope and asked to end none, and answers no openTransaction key"
- test `tests/unit/lib/api/editor-query.test.ts` "the scope is ended when the statement throws, and the statement's error is answered"
- test `tests/unit/lib/api/editor-query.test.ts` "a transaction the run left open and the provider rolled back is answered (D74)"
- test `tests/unit/lib/api/editor-query.test.ts` "an end that fails is answered in the run's place, its error by reference, and the page record is released once"
- test `tests/unit/lib/api/editor-query.test.ts` "the scope's end is sent before the answer body is built"
- test `tests/unit/lib/api/editor-query.test.ts` "a page refused after the call ends its scope before the refusal is answered"
- test `tests/unit/lib/api/editor-query.test.ts` "a run refused before its call ends no scope"
- test `tests/unit/lib/api/editor-query.test.ts` "the scope's end runs under a cleanup context of its own, ten seconds from its start, which the caller's leaving does not end"
- test `tests/unit/lib/api/editor-query.test.ts` "an end its cleanup deadline stops answers StudioTimeoutRefusal naming the end, outcome unknown"
- test `tests/unit/lib/api/editor-query.test.ts` "an end the host refuses is answered as a defect of Studio's bridge, named by its rule"
- test `tests/unit/lib/api/editor-query.test.ts` "a caller that leaves while the statement runs is answered at once, and the scope is ended once the statement has settled"
- test `tests/unit/lib/api/editor-query.test.ts` "the end of a stopped run's scope that fails or is stopped is logged by kind and code, never its text"
- test `tests/unit/lib/api/editor-scope-bounds.test.ts` "an end that never answers is cut at the cleanup deadline, and the run answers StudioTimeoutRefusal naming it"
- test `tests/api/db/query.test.ts` "ends the transaction its own statement left open and says so"
- test `tests/api/db/query.test.ts` "ends the transaction a FAILING statement left open, which is where they come from"
- test `tests/api/db/query.test.ts` "leaves a provider that cannot name its own session exactly as it found it"
- test `tests/api/db/query.test.ts` "governance: a rollback that fails after the statement answered is answered in the statement's place and recorded as the run's error, as the finally always did"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "answers a transaction the statement left open as rolled back (D74)"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "ends the statement's own scope after the run, and answers an end that fails in the run's place"
- test `tests/api/db/multi-query.test.ts` "the script's scope is ended once through the host core's console.endScope, under a cleanup context the request's leaving does not end"
- test `tests/api/db/multi-query.test.ts` "a script whose end does not answer within 10 s answers 504 naming the end"
- test `tests/api/db/multi-query.test.ts` "a script the request leaves still ends its scope once the statement in flight settled"
- test `tests/api/db/multi-query.test.ts` "every statement and the ender run under ONE scope, this request's own (D87)"
- test `tests/api/db/multi-query.test.ts` "a provider that cannot end one is asked nothing and answers as before"
- test `tests/unit/lib/provider-host/legacy-bridge.test.ts` "only the legacy bridge calls a provider's endOpenQueryTransaction, so a run's open transaction ends through console.endScope alone"

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

- schema `/$defs/calls/properties/objects`
- schema `/$defs/objectsCalls/properties/tree`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "calls that leave out objects, or objects that leave out tree, are refused as missing-key"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the objects facets are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the tree actions are containers, count, list, describe and describeMany"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the objects tree facet is declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the objects tree facet is refused by name to a session that does not offer it"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw objects.tree, and never offer it where the manifest does not"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a tree request is one of its actions, each with its own members"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a tree answer is exactly one of its five forms, each read as its closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a containers answer may carry needsConfiguration as text, read as part of its closed shape"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a containers answer that says the inventory needs configuration crosses as a frame with its sentence"

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

### C-64 (normative): The host's tree call

`treeCall` checks the context with `checkCallStart`, C-27, and the facet with `checkObjectsFacet`, C-17, answering each refusal as a record without calling the provider.
It freezes the context and the request in place, C-12, and waits with `awaitWithin` until the context's signal, C-28.
It answers the session's answer by reference, C-62, a stop with its reason and `settled`, and a provider's error by reference.
A failure after the stop reaches the caller's late handler once, and a later answer is dropped, so no promise the host stopped waiting for is left without a handler.
A session that offers the facet with no function is a defect of the host's session, named.

- test `tests/unit/lib/provider-host/core/objects.test.ts` "a tree call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a tree call to a session without objects.tree is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a tree call answers the session's own answer, with the request and context frozen"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "an error the provider throws reaches the caller as the same object"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a tree call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a tree answer that arrives after the stop is dropped, and settled resolves"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a session that throws its own signal's reason is answered as a stop"
- test `tests/unit/lib/provider-host/core/objects.test.ts` "a session that offers objects.tree with no tree function is a host defect, named"
- test `tests/unit/lib/provider-host/core/objects-bounds.test.ts` "a tree call that never settles is stopped at the call's deadline"

### C-65 (normative): The object tree on the host

The six tree routes and the VS Code backend's tree calls, `selectStatement`'s describe among them, read every container listing, count, object listing and description through one caller facade and the host core's tree call, C-64, on the session the legacy bridge serves, C-50, of the provider the connection's metadata session holds, C-66.
Each read waits until its own deadline, the statement timeout plus 10 s from that read's start, and the caller's signal, the request's or the JSON-RPC request's cancellation.
An inventory's and a search's walks take one deadline per read, not one per request, since a whole walk is a sum of round trips that grows with the server's distance.
A read the caller left is answered at once as `QueryCancelledError`, outcome unknown, or not-sent when refused before the call, and one past its deadline as `StudioTimeoutRefusal` naming the read, the statement timeout and the slack.
A read's later failure is logged by kind and code, never its text.
The facade takes the provider its caller resolved and no catalog, so no catalog choice is honoured on this path, M-57.
Its container listing answers the containers alone, so a top-level listing that says the inventory needs configuration answers no container, as the provider's own listing does, C-61.
Each route's and handler's own checks and scrubs run where they ran.

- test `tests/unit/lib/api/object-tree.test.ts` "each tree read is one host core tree call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start"
- test `tests/unit/lib/api/object-tree.test.ts` "each tree read answers the provider's own answer by reference"
- test `tests/unit/lib/api/object-tree.test.ts` "an error the provider raises reaches the caller as the same object"
- test `tests/unit/lib/api/object-tree.test.ts` "a caller that leaves while the provider reads is answered QueryCancelledError at once, outcome unknown, and the read's later failure is logged by kind and code, never its text"
- test `tests/unit/lib/api/object-tree.test.ts` "a caller already gone reads nothing and is answered QueryCancelledError, not-sent"
- test `tests/unit/lib/api/object-tree.test.ts` "a tree read past its deadline answers StudioTimeoutRefusal naming the read, the statement timeout and the slack"
- test `tests/unit/lib/api/object-tree.test.ts` "a tree read refused for any other reason is answered as a defect of Studio's bridge, named by its rule"
- test `tests/unit/lib/api/object-tree.test.ts` "an answer without its action's member is answered as a defect of Studio's bridge, or of the provider for the batch the bridge passes through, naming the action and the member"
- test `tests/unit/lib/api/object-tree.test.ts` "a tree read before the host core is installed fails by name and reaches no provider"
- test `tests/unit/lib/api/object-tree.test.ts` "a containers answer that says the inventory needs configuration reaches the granted tree whole and the editor's listing as its containers alone"
- test `tests/unit/lib/api/object-tree.test.ts` "a needsConfiguration beside a container, or below the top level, is answered as the provider's defect, named"
- test `tests/unit/lib/api/object-tree-bounds.test.ts` "a tree read that never answers is stopped at its deadline, StudioTimeoutRefusal naming the read"
- test `tests/unit/db/container-walk.test.ts` "the walk reads any container source, not only a provider"
- test `tests/api/db-objects.test.ts` "a tree route whose request leaves while the provider reads answers 499 at once, outcome unknown"
- test `tests/api/db-objects.test.ts` "a tree route whose request is already gone answers 499 not-sent and asks the provider nothing"
- test `tests/api/db-objects.test.ts` "an inventory or a search whose request leaves between its reads sends no further read"
- test `tests/api/db-objects.test.ts` "a tree route past its deadline answers 504 studio-timeout-refusal naming the read"
- test `tests/api/db-objects.test.ts` "every read of an inventory, its container walk included, is a host core tree call with a deadline of its own"
- test `tests/api/db-objects.test.ts` "a tree route reads no catalog, and its provider's forCatalog is never called"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "each tree call reads through the host core's tree call, on the provider of the connection's metadata session"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a tree call whose request is cancelled while the provider reads answers QUERY_CANCELLED at once, outcome unknown"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a tree call whose request is already cancelled reads nothing and answers QUERY_CANCELLED, not-sent"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a tree call past its deadline answers TIMEOUT_ERROR naming the read"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "the columns are read through the host core's tree call, under the request's cancellation"

### C-66 (normative): The metadata session and the host's session capacity class

The host classes each connection's session capacity, one or several, from Studio's own records and the connection, never from a manifest or a provider.
It is one where Studio's record of the engines that serve their tree from one session, `SERVES_ONE_SESSION`, names a reason, which it does for every engine that keeps one handle per file, and where the connection's database is in memory, one database per handle, as the file admission reads it; it is several otherwise.
A manifest has no member for it, and a built provider's declaration never reaches it, M-57.
The class decides only which session a tree read or a kill runs on; it never authorizes anything.
On a connection of class several, the tree routes and the VS Code backend's tree calls, `selectStatement`'s describe among them, read on a metadata session of the connection's own, opened beside the editor's session from the same connection, with the same credentials, file-access posture and owner, through the same checks in the same order, and keyed by the editor session's key with a metadata frame, so it is each owner's own under governance.
Its pool holds at most two sessions and opens none until a read or a kill asks.
The maintenance route runs a kill on the same metadata session, under the editor's posture and through the same checks, and every other operation on the editor's provider, C-70.
On a connection of class one they read, and a kill runs, on the editor's session.
A metadata session opens once per key, C-44, is torn down with the caches under the teardown's deadlines, C-45, leaves with the idle sweep and with every removal that names its connection, its owner or its record's key, and keeps the connection's SSH tunnel open while it serves the connection.
A tree read takes no catalog, so no catalog choice is honoured on it, M-57.
A kill's catalog is honoured on the metadata session through the same catalog choice as on the editor's provider, and a catalog the connection cannot honour is refused in the same words, M-57.
On a server-level connection, a tree read inside one of its databases and a kill in a catalog run on the catalog session the metadata session opens for that database, which takes the pool its provider gives every catalog session in place of the metadata session's two.
The legacy bridge's postgres provider, the one provider that declares catalog sessions, gives each catalog session a pool of at most three sessions that opens none until a read asks, and keeps at most five databases open at once, so its metadata session on a server-level connection holds at most seventeen sessions.
A native provider's metadata session is an open like the editor's with a smaller `pool`, and the open names no role.

- test `tests/unit/db/session-capacity.test.ts` "every shipped engine's session capacity is one exactly where Studio's record names a reason"
- test `tests/unit/db/session-capacity.test.ts` "an in-memory database serves one session on every engine that opens a local file"
- test `tests/unit/db/session-capacity.test.ts` "a name the file admission reads as a file is a file, whatever it spells"
- test `tests/unit/db/session-capacity.test.ts` "the class and the file admission read one in-memory name"
- test `tests/unit/db/session-capacity.test.ts` "the class reads Studio's records and the connection, never a provider or a manifest"
- test `tests/unit/db/compatibility.test.ts` "is exhaustive over the shipped engines and frozen, each reason a sentence"
- test `tests/unit/db/compatibility.test.ts` "names a reason for every engine SINGLE_WRITER_FILE names"
- test `tests/isolated/factory.test.ts` "a tree read's provider is a session of its own beside the editor's, from the same connection and posture, with a pool of at most two that opens none until asked"
- test `tests/isolated/factory.test.ts` "under governance each owner's metadata session is their own, with a pool of at most two beside a pool of poolMaxPerUser"
- test `tests/isolated/factory.test.ts` "a connection that serves one session answers the editor's own provider and builds no other"
- test `tests/isolated/factory.test.ts` "every refusal of the editor's open refuses a metadata open alike, before anything is built"
- test `tests/isolated/factory.test.ts` "two concurrent first tree reads of one connection open one metadata session, and a removal overtakes one in flight"
- test `tests/isolated/factory.test.ts` "a removal closes the metadata session with the editor's, by connection, by owner and by record key"
- test `tests/isolated/factory.test.ts` "the idle sweep evicts an idle metadata session and keeps one with a run in flight"
- test `tests/isolated/factory.test.ts` "the caches' close tears the metadata sessions down under the teardown's deadlines and names one not closed"
- test `tests/isolated/factory.test.ts` "the SSH tunnel stays open while a metadata session still serves the connection"
- test `tests/isolated/factory.test.ts` "a saved query timeout change reopens the metadata session"
- test `tests/api/db-objects.test.ts` "each tree route reads on the connection's metadata session, and the source and edit routes on the editor's"
- test `tests/api/db-objects.test.ts` "a tree route answers while the editor's provider holds every read, without waiting for it"
- test `tests/api/db-objects.test.ts` "handleObjectRequest resolves the editor's provider by default and the metadata session when asked, after the guard and the connection's resolution"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "each tree call reads through the host core's tree call, on the provider of the connection's metadata session"
- test `vscode-extension/test/unit/backend-handlers.test.ts` "a tree call answers while the editor's provider holds every read, without waiting for it"
- test `tests/unit/lib/api/editor-provider.test.ts` "opens the connection's metadata session with the editor's connection and posture, and without a catalog runs on it"
- test `tests/unit/lib/api/editor-provider.test.ts` "a catalog runs on that database's session of the metadata session, and a connection without sessions refuses one"
- test `tests/api/db/maintenance.test.ts` "a kill runs on the connection's metadata session, opened with the editor's connection and posture, and every other operation on the editor's provider"
- test `tests/api/db/maintenance.test.ts` "a kill answers while the editor's provider holds every run, without waiting for it"
- test `tests/api/db/maintenance.test.ts` "a kill's catalog runs on that database's session of the metadata session, and a catalog the connection cannot honour is refused as the editor's provider refuses it, with nothing run or audited"

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

- schema `/$defs/calls/properties/maintenance`
- schema `/$defs/maintenanceCalls/properties/run`
- schema `/$defs/maintenanceCalls/properties/preview`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "calls that leave out maintenance, or maintenance that leaves out run or preview, are refused as missing-key"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the maintenance facets are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the maintenance operations are the schema's"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the maintenance facets are declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine's maintenance is admitted where the package offers maintenance.run, and refused by name as engine-facet-call-not-offered where it does not"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a maintenance spec that previews is admitted where the package offers maintenance.preview, and refused by name where it does not"
- test `packages/provider-sdk/tests/calls/request.test.ts` "the maintenance facets are refused by name to a session that does not offer them"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement may withdraw maintenance.run and maintenance.preview, and never offer one the manifest does not"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a maintenance run request and answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a maintenance preview request and answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served maintenance call crosses its request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable"

### C-68 (normative): A session's maintenance is narrowed by what its server accepts

`open` may answer, in its refinement's `maintenance`, the placements its server accepts for the operations its provider measured at open: one item for each such operation, naming it and whether the server takes it on a row and over the whole database.
`checkRefinement` reads each item as a closed record of exactly its operation, one of the maintenance vocabulary and named once, and its two placements, each a boolean, in a list no longer than the vocabulary, refused by its length before any item is read, so a sparse array's length bounds no loop of the check.
`sessionMaintenance` reads the same shape, refuses an operation the session's engine does not list as `refinement-widens`, and answers the engine's maintenance with every refused placement withdrawn and every operation left with none removed from both lists, `kill` among them.
It adds nothing and changes no label, confirmation, preview or kinds, and an operation the narrowing does not name stays as declared, which is how Studio's `narrowMaintenance` reads a connected provider's measurement.
Its answer is frozen at every depth, and the declaration is left as it is.
The host keeps the narrowed maintenance with the session, beside its calls, and holds every run and preview request to it, C-17.

- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a maintenance narrowing is a list of the placements the server accepts, each read as a closed record of its operation and two booleans"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a maintenance narrowing longer than the operation vocabulary is refused as refinement-unreadable at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/narrowing-bounds.test.ts` "a maintenance narrowing of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "sessionMaintenance refuses an operation the session's engine does not list as refinement-widens"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "sessionMaintenance withdraws what the server refuses and adds nothing, as narrowMaintenance does"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "no maintenance narrowing refusal carries a value of the refinement"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served open whose maintenance narrowing names an operation its engine does not list is refused, and the session it opened is closed"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "a session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a server accepts"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "a bridged session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a connected server accepts"

### C-69 (normative): The host's maintenance calls

`maintenanceRunCall` and `maintenancePreviewCall` check the context with `checkCallStart`, C-27, the facet with `checkMaintenanceFacet` and the request against the session's maintenance, C-17, answering each refusal as a record without calling the provider.
Each freezes the context and the request in place, C-12, and waits with `awaitWithin` until the context's signal, C-28.
Each answers the session's answer by reference, a stop with its reason and `settled`, and a provider's error by reference.
A failure after the stop reaches the caller's late handler once, and a later answer is dropped, so no promise the host stopped waiting for is left without a handler.
A session that offers a facet with no function for it is a defect of the host's session, named.

- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance call to a session without its facet is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance request the session's maintenance does not take is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance call answers the session's own answer, with the request and context frozen"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "an error the provider throws reaches the caller as the same object"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a maintenance answer that arrives after the stop is dropped, and settled resolves"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a session that throws its own signal's reason is answered as a stop"
- test `tests/unit/lib/provider-host/core/maintenance.test.ts` "a session that offers a maintenance facet with no function is a host defect, named"
- test `tests/unit/lib/provider-host/core/maintenance-bounds.test.ts` "a maintenance run that never settles is stopped at the call's deadline"
- test `tests/unit/lib/provider-host/core/maintenance-bounds.test.ts` "a maintenance preview that never settles is stopped at the call's deadline"

### C-70 (normative): Maintenance on the host

Both maintenance routes run and preview through one caller facade and the host core's maintenance calls, C-69, on the session the legacy bridge serves, C-50, of the provider the route resolved: the connection's metadata session for a kill, C-66, and the editor's provider for every other operation and every preview.
Each call waits until its own deadline, the statement timeout plus 10 s from its start, and the request's signal.
A call the caller left is answered at once as `QueryCancelledError`, outcome unknown, or not-sent when refused before the call, and one past its deadline as `StudioTimeoutRefusal` naming the run or the preview, the statement timeout and the slack.
A later failure is logged by kind and code, never its text, and a run that answers later is logged by route and facet, never its answer.
A run the host stopped waiting for is audited as an unknown outcome, and one refused before the call, or failed before it by an error the host raised, writes no audit row.
The routes read the provider's declarations after their own checks.
Each route's doors, checks, confirmations, scrubs and error mapping run where they ran, an operation the engine does not offer is still refused before any provider is built, and a run of an operation placed nowhere, `kill`, still passes.

- test `tests/unit/lib/api/provider-maintenance.test.ts` "each maintenance run and preview is one host core call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a run and a preview answer the provider's own answer by reference, and the preview's offer is the bridged session's"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "an error the provider raises reaches the caller as the same object"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a caller that leaves while the provider runs is answered a stop at once, QueryCancelledError outcome unknown, and the later failure is logged by kind and code, never its text"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a run the caller stopped waiting for that answers afterwards is logged by route and facet, never its text"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a caller already gone sends nothing and is answered not-sent"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a maintenance call past its deadline answers StudioTimeoutRefusal naming the run or the preview, the statement timeout and the slack"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a maintenance call refused for any other reason is answered as a defect of Studio's bridge, named by its rule"
- test `tests/unit/lib/api/provider-maintenance.test.ts` "a maintenance call before the host core is installed fails by name and reaches no provider"
- test `tests/unit/lib/api/provider-maintenance-bounds.test.ts` "a maintenance run that never answers is stopped at its deadline, StudioTimeoutRefusal naming the run"
- test `tests/api/db/maintenance.test.ts` "the route reads the provider's declarations once, after its own checks, and none for a request it refuses"
- test `tests/api/db/maintenance.test.ts` "a run whose request leaves while the provider runs answers 499 at once, outcome unknown, and is audited as an unknown outcome"
- test `tests/api/db/maintenance.test.ts` "a run whose request is already gone answers 499 not-sent, asks the provider nothing and writes no audit row"
- test `tests/api/db/maintenance.test.ts` "a run past its deadline answers 504 studio-timeout-refusal naming the run, and is audited as an unknown outcome"
- test `tests/api/db/maintenance.test.ts` "a run the host refuses before the call answers as a defect of Studio and writes no audit row"
- test `tests/api/db/maintenance.test.ts` "a broken audit sink does not change the answer for a run Studio stopped waiting for"
- test `tests/api/db/maintenance.test.ts` "kill's session target passes the host's placement check, which neither placement describes"
- test `tests/api/db/maintenance.test.ts` "a kill runs on the connection's metadata session, opened with the editor's connection and posture, and every other operation on the editor's provider"
- test `tests/api/db/maintenance.test.ts` "an error the host raises before the provider is called is not audited as an execution failure"
- test `tests/api/db/maintenance.test.ts` "a connection whose connected maintenance is narrower than its declaration is refused the placement its session's maintenance withdrew"
- test `tests/api/db/maintenance.test.ts` "the provider is asked once with the operation, the target the request names, none for an empty one, and the container, and the answer is its result"
- test `tests/api/db/maintenance-preview.test.ts` "a preview whose request leaves while the provider reads answers 499 at once, outcome unknown"
- test `tests/api/db/maintenance-preview.test.ts` "a preview whose request is already gone answers 499 not-sent and asks the provider nothing"
- test `tests/api/db/maintenance-preview.test.ts` "a preview past its deadline answers 504 studio-timeout-refusal naming the preview"
- test `tests/api/db/maintenance-preview.test.ts` "whether a preview is offered is read from the bridged session"

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

- schema `/$defs/calls/properties/monitoring`
- schema `/$defs/monitoringCalls/properties/panel`
- schema `/$defs/monitoringCalls/properties/poolStats`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "calls that leave out monitoring, or monitoring that leaves out panel or poolStats, are refused as missing-key"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the monitoring facets are the schema's"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "the monitoring facets are declared and implemented both ways, like every console facet"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine's offered monitoring panel is admitted where the package offers monitoring.panel, and refused by name as engine-facet-call-not-offered where it does not"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a monitoring panel request is held to the panels the session's engine offers"
- test `packages/provider-sdk/tests/calls/request.test.ts` "no monitoring request refusal carries a value of the request"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a monitoring panel request is the closed shape of the panel it names"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a monitoring panel answer is exactly one of its seven forms, each read as its closed shape"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a timestamp member admits a Date and nothing else"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame"

### C-72 (normative): The health call

Every session answers `health`, a mandatory call beside `open` and `close` that reaches the engine and answers its health.
It answers the count of open connections where the engine can measure it, left out where it cannot and never a zero in its place, the database's size, its cache hit ratio, its slowest queries and its sessions, as Studio's health shape.
It takes no request, and no refinement withdraws it, since it is no member of `calls`.
The answer shape is Studio's own health answer, declared by the SDK and held mutually assignable with Studio's, C-7.

- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a mandatory call that is missing or no function is refused as call-missing"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a call inherited from a prototype is not read, so a class instance is refused as call-missing"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a calls segment the contract does not define is refused by name, and never read as the objects segment"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a pool statistics answer and a health answer are each read as their closed shape"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served health call crosses its context and answer as frames, and the host receives a decoded copy"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a closed or foreign session token is refused as session-not-open before any frame"

### C-73 (normative): The host's monitoring calls

`panelCall` and `poolStatsCall` check the context with `checkCallStart`, C-27, the facet with `checkMonitoringFacet` and, for a panel, the request against the session's panels with `checkMonitoringPanelRequest`, C-17, answering each refusal as a record without calling the provider.
Each freezes the context and the request in place, C-12, and waits with `awaitWithin` until the context's signal, C-28.
Each answers the session's answer by reference, a stop with its reason and `settled`, and a provider's error by reference.
A failure after the stop reaches the caller's late handler once, and a later answer is dropped, so no promise the host stopped waiting for is left without a handler.
A session that offers a facet with no function for it is a defect of the host's session, named.
The core does not read a panel answer's form: the caller reads the member its request names.
`healthCall` checks the context with `checkCallStart`, C-27, and no facet, since every session answers `health`, C-72, freezes the context in place, waits with `awaitWithin` until the context's signal, and answers the session's health by reference, a stop with its reason and `settled`, and a provider's error by reference, a later failure reaching the caller's late handler once.

- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a monitoring call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a monitoring call to a session without its facet is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a panel request for a panel the session's engine does not offer is refused as a record before the call"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a monitoring call answers the session's own answer, with the request and context frozen"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "an error the provider throws reaches the caller as the same object"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a monitoring call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a monitoring answer that arrives after the stop is dropped, and settled resolves"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a session that throws its own signal's reason is answered as a stop"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a session that offers a monitoring facet with no function is a host defect, named"
- test `tests/unit/lib/provider-host/core/monitoring-bounds.test.ts` "a panel read that never settles is stopped at the call's deadline"
- test `tests/unit/lib/provider-host/core/monitoring-bounds.test.ts` "a pool statistics read that never settles is stopped at the call's deadline"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a health call whose signal aborted or whose deadline passed is refused as a record, and the session's health is never called"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a health call reads no facet and answers the session's own health, its context frozen"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a health error the session raises reaches the caller as the same object, a synchronous throw as the call's rejection"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a health call the caller stops waiting for answers a stop at once, its later failure reaches the late handler once, and a later answer is dropped"
- test `tests/unit/lib/provider-host/core/monitoring.test.ts` "a session that throws its health call's own signal reason is answered as a stop"
- test `tests/unit/lib/provider-host/core/monitoring-bounds.test.ts` "a health read that never settles is stopped at the call's deadline"

### C-74 (normative): Monitoring on the host

The monitoring and pool-stats routes read every panel and the pool statistics through one caller facade and the host core's monitoring calls, C-73, on the session the legacy bridge serves, C-50, of the provider the route resolved.
A dashboard read is the host's one orchestration of the declared panels, which asks only the panels the engine offers and the caller requests, each through one panel request with the limits resolved and a schema only where the caller named one.
It answers each panel answered, failed with its sentence, not requested or not offered, and holds each answer to the requested panel's form, failing that panel by name otherwise.
A dashboard whose every panel failed answers the first panel's error as raised when they failed with one sentence, and Studio's mapping of the joined sentences for the session's engine when they failed with several, the mapping every provider's own applies.
Each read waits until its own deadline, the statement timeout plus 10 s from its start, and the request's signal, and every read of one dashboard starts at once, so the dashboard has no deadline of its own.
A read the caller left is answered as `QueryCancelledError`, outcome unknown, or not-sent when refused before the call, and one past its deadline as `StudioTimeoutRefusal` naming the read, the statement timeout and the slack.
A later failure is logged by kind and code, never its text.
The monitoring route refuses, by name and before any connection resolves, a slow query or session limit that is not a whole number of at least 1 and a schema filter that is not text naming a schema.
Each route's doors, checks, scrubs and answers run where they ran, and a session that offers no pool statistics is answered with today's zeros and sentence.

- test `tests/unit/db/engine-facets/monitoring.test.ts` "each panel is read through one request of its own, the limits resolved and the schema present only when the caller named one"
- test `tests/unit/db/engine-facets/monitoring.test.ts` "an answer whose form is not the requested panel's fails that panel by name, and the others answer"
- test `tests/unit/db/engine-facets/monitoring.test.ts` "a dashboard whose one panel answered a form other than its own rejects with that panel's sentence as a plain Error"
- test `tests/unit/db/engine-facets/monitoring.test.ts` "readPanel calls the panel's member with today's argument and answers its answer by reference under the panel's key"
- test `tests/isolated/monitoring-panels-census.test.ts` "no provider overrides mapError, so the host's mapping of a dashboard's several sentences is each provider's own"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "each panel read and each pool statistics read is one host core call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a dashboard read answers each panel's own answer by reference in the orchestration's four states, and a pool statistics read the provider's own"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "an error the provider raises reaches the caller as the same object, and several sentences answer the engine's mapping of them"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a caller that leaves while the reads are pending is answered a stop at once, QueryCancelledError outcome unknown, and each later failure is logged by kind and code, never its text"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a pool statistics read whose caller leaves is answered a stop at once, and its later failure is logged by kind and code, never its text"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a caller already gone sends nothing and is answered not-sent"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a monitoring read past its deadline answers StudioTimeoutRefusal naming the panel read or the pool statistics read, the statement timeout and the slack"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a monitoring read refused for any other reason is answered as a defect of Studio's bridge, named by its rule"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a monitoring read before the host core is installed fails by name and reaches no provider"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "the monitoring options are refused by name when a limit is not a whole number of at least 1 or the schema is not text that names one"
- test `tests/unit/lib/api/provider-monitoring-bounds.test.ts` "a dashboard read whose panels never answer is stopped at their deadline, StudioTimeoutRefusal naming the panel read"
- test `tests/api/db/monitoring.test.ts` "the route reads every panel through the host core and never the provider's getMonitoringData"
- test `tests/api/db/monitoring.test.ts` "a dashboard whose request leaves while its panels are read answers 499 at once, outcome unknown"
- test `tests/api/db/monitoring.test.ts` "a dashboard whose request is already gone answers 499 not-sent and reads no panel"
- test `tests/api/db/monitoring.test.ts` "a dashboard past its deadline answers 504 studio-timeout-refusal, and a panel stopped beside answered ones carries the sentence in errors"
- test `tests/api/db/monitoring.test.ts` "options with a limit that is not a whole number of at least 1, or a schema filter that is not text naming a schema, are refused by name before any connection resolves"
- test `tests/api/db/monitoring.test.ts` "a panel answer whose form is not the requested panel's fails that panel by name"
- test `tests/api/db/monitoring.test.ts` "a provider error that reads like an abort answers by its class, and only the request's own signal answers 499"
- test `tests/api/db/monitoring.test.ts` "a provider error with the code ECONNRESET answers by its class, not as a request the caller left"
- test `tests/api/db/pool-stats.test.ts` "a pool statistics read whose request leaves answers 499 at once, outcome unknown"
- test `tests/api/db/pool-stats.test.ts` "a pool statistics read whose request is already gone answers 499 not-sent and reads nothing"
- test `tests/api/db/pool-stats.test.ts` "a pool statistics read past its deadline answers 504 studio-timeout-refusal naming the read"
- test `tests/api/db/pool-stats.test.ts` "whether pool statistics are offered is read from the bridged session"

### C-75 (normative): Health on the host

The health route and fleet health read a connection's health through the monitoring facade and the host core's health call, C-73, on the session the legacy bridge serves, C-50, of the provider the route resolved.
Each health read, and fleet health's overview read, waits until its own deadline, the statement timeout plus 10 s from its start, and the request's signal.
A read the caller left answers `QueryCancelledError`, outcome unknown, or not-sent when refused before the call, and one past its deadline `StudioTimeoutRefusal` naming the read, the statement timeout and the slack.
A later failure is logged by kind and code, never its text.
Fleet health reads the overview only where the session's engine offers the overview panel, through one panel call held to the overview panel's form, and drops a failed or stopped overview read, its row's status from the health read alone.
A fleet row whose health read failed or was stopped answers `error` with that error's sentence.
Test Connection reads health through the same call on the session the bridge serves for the provider the test holds, the call's deadline the test's own and its signal the test's deadline signal, so the test keeps one deadline, C-56.
The wait's end answers the test's connection error naming the budget, a health failure the degraded success, and a failure after the wait ended is logged by kind and code.
A health read made before the host core is installed fails by name, and Test Connection never answers that defect as a degraded success.
Each route's doors, checks, scrubs and answers run where they ran.

- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read is one host core health call on a deadline of the statement timeout plus ten seconds from its own start and the caller's signal, answering the provider's own health by reference"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read's provider error reaches the caller as the same object"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read whose caller leaves is answered a stop at once, QueryCancelledError outcome unknown, and its later failure is logged by kind and code, never its text"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read whose caller is already gone sends nothing and is answered not-sent"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read past its deadline answers StudioTimeoutRefusal naming the health read, the statement timeout and the slack"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "an overview read is one host core panel call where the engine offers the overview, answering its figures by reference, and reads nothing where it does not"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "an overview answer whose form is not the overview panel's fails by name"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a monitoring read before the host core is installed fails by name and reaches no provider"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read within a wait the caller holds runs on that deadline and that signal itself, and answers the provider's health by reference"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read within a wait that ended answers that it ended, before the call or while it was pending, and a later failure is logged by kind and code"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a health read within a wait passes the provider's error as the same object"
- test `tests/unit/lib/api/provider-monitoring-bounds.test.ts` "a health read whose provider never answers is stopped at its deadline, StudioTimeoutRefusal naming the health read"
- test `tests/unit/lib/api/editor-query.test.ts` "contextOn carries the caller's own signal and deadline, and callContext is contextOn on a deadline signal of its own"
- test `tests/api/db/health.test.ts` "a health read whose request leaves answers 499 at once, outcome unknown"
- test `tests/api/db/health.test.ts` "a health read whose request is already gone answers 499 not-sent and reads nothing"
- test `tests/api/db/health.test.ts` "a health read past its deadline answers 504 studio-timeout-refusal naming the health read"
- test `tests/api/admin/fleet-health.test.ts` "each row's health and overview are read through the host core, the overview only where the engine offers it"
- test `tests/api/admin/fleet-health.test.ts` "a row whose health read the host stopped at its deadline answers error with the health read's sentence"
- test `tests/api/admin/fleet-health.test.ts` "a row whose overview read the host stopped stays healthy and carries no byte figure"
- test `tests/api/admin/fleet-health.test.ts` "a request already gone answers each row error with the cancelled sentence and reads no health"
- test `tests/unit/lib/api/test-connection.test.ts` "the health read is one host core health call on the bridged session of the provider the test holds, under the test's own deadline"
- test `tests/unit/lib/api/test-connection.test.ts` "a health failure after the test's deadline is logged by kind and code, never its text, and the answer stays the test's ConnectionError"
- test `tests/unit/lib/api/test-connection.test.ts` "a health read made before the host core is installed fails by name, never a degraded success, and the provider is closed"
- test `tests/unit/lib/api/test-connection.test.ts` "checks or a health read still pending at the deadline answer the test's ConnectionError, never a caution or a degraded success"
- test `tests/unit/lib/api/test-connection-bounds.test.ts` "a health read that never settles is cut at the test's deadline"

### C-76 (normative): The agent's curated readings on the host

The agent's curated readings read through the monitoring facade and the host core, C-73, on the session the legacy bridge serves, C-50, of the provider the run acquired under the operations profile.
A panel reading is one panel call for the panel `AGENT_READING_PANELS` names for it, its request the limit or the schema the reading takes, and the health reading is one health call.
Each call's deadline is the time its call was granted, the run's statement timeout already clamped to what is left of the run, from the reading's start, with no slack, and its signal is that deadline's alone.
Its caller signal is one that never aborts, made for that call, since the agent's drive has no signal of its own and cannot leave a call mid-way, its cancellation being the run's checkpoint between tool calls, so the accessor, C-51, reads a call that ended as its deadline's.
Its context carries the deadline, that signal and the empty environment, never a credential, and its request is a fresh copy.
A panel the session does not offer answers that it is not offered, with no call, and the reading is refused as a kind the provider does not serve.
So a run whose header predates the engine field, offered every kind, has a kind whose panel its engine does not offer refused that way, and the provider's member is never called.
A reading its deadline stopped is `StudioTimeoutRefusal` with a sentence naming the reading and the time granted, outcome unknown, refused to the model as a repairable failure, and the stopped call's settlement is handed to the run, which counts the call as an execution until it settles.
A refused start is `StudioTimeoutRefusal`, outcome not-sent, and no member is called.
A provider's error passes as the same object, and a failure after the stop is logged under the reading's route, the facet and the panel by kind and code, never its text.
A reading made before the host core is installed throws by name before any promise, so it is never taken for a provider's failure.

- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted panel read answers the panel's member through one host core panel call, on a fresh request and a context of deadline, signal and env alone"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted panel read of a panel the session does not offer answers not-offered and reads nothing"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted read whose deadline passed before it started is StudioTimeoutRefusal not-sent and reads nothing"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted read its deadline stopped is StudioTimeoutRefusal, hands its caller the stopped call's settlement and logs a later failure by kind and code only"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted read passes the provider's error as the same object"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted read before the host core is installed throws by name before any read"
- test `tests/unit/lib/api/provider-monitoring.test.ts` "a granted health read follows the same rules over the host core's health call"
- test `tests/unit/lib/api/provider-monitoring-bounds.test.ts` "a granted panel read and a granted health read whose provider never answers each end at their own deadline"
- test `tests/unit/lib/agent/tools.test.ts` "a curated reading reads through the host core's panel call, with the reading's panel, the model's limit or the run's ceiling, and the schema where named"
- test `tests/unit/lib/agent/tools.test.ts` "the health reading reads through the host core's health call"
- test `tests/unit/lib/agent/tools.test.ts` "a curated reading that outlives the time its call was granted is refused as a timeout, and the run counts it until the provider's call settles"
- test `tests/unit/lib/agent/tools.test.ts` "a provider that does not serve a kind is REFUSED, not crashed"
- test `tests/unit/lib/agent/operations-readings.test.ts` "a context without an engine on kafka asking for a kind whose panel kafka's row does not offer is refused as KIND_UNSUPPORTED_BY_PROVIDER, its member never called"

### C-77 (normative): The agent routes' opens

The hand-over route and the agent runs route wait for their opens within the engine's connect budget and the request's signal, as the query route does, C-44 and C-55: the hand-over for its execution-profile provider, the runs route for the database session a run names.
An execution-profile acquisition takes the caller's own wait as the editor's acquisition does: a caller whose wait ends rejects with its reason by reference while the open goes on for every other caller and admits its provider into the profiled cache once, and without a wait it waits for the open as before.
A request that leaves while its open is pending answers `QueryCancelledError`, 499, and an open past the budget `StudioTimeoutRefusal`, 504, naming the budget, both outcome not-sent, and nothing is read and no run is opened.
The agent's drive passes no wait of its own: it has no signal of its own, C-76, so its acquisitions end where their open's own deadline, the engine's connect budget, ends them.

- test `tests/isolated/factory.test.ts` "a caller whose wait ends stops waiting while the open goes on and admits itself once"
- test `tests/isolated/factory.test.ts` "a profile acquisition without a wait waits for the open as before"
- test `tests/api/agent/handover.test.ts` "a hand-over whose client leaves while its provider opens answers 499 not-sent and never reads"
- test `tests/api/agent/handover.test.ts` "a hand-over whose open outlasts its engine's connect budget answers 504 studio-timeout-refusal not-sent"
- test `tests/api/agent/runs.test.ts` "a run whose client leaves while its catalog opens answers 499 and opens no run"
- test `tests/api/agent/runs.test.ts` "a run whose catalog open outlasts its engine's connect budget answers 504 studio-timeout-refusal not-sent"
- test `tests/isolated/agent-runtime.test.ts` "the drive's acquisitions pass no wait of their own: the open's own deadline bounds them"

### C-78 (normative): The read-only execute

A read-only execute is console execute sent with `readOnly`: the statement runs on the session's read-only boundary, and `readOnly` carries its budget, the most rows and the most UTF-8 JSON bytes of those rows it may answer, and its mode, of `READ_ONLY_MODES`.
A request without a mode executes the statement, and `estimate-plan` asks for the engine's estimated plan, which the provider answers or refuses and never runs the statement instead.
Its time is the call's deadline, C-26, so `readOnly` carries no timeout of its own.
A provider answers within the budget's rows and bytes or refuses, and never truncates; an estimating plan's rows are the optimizer's operators, so its answer is held to the bytes alone.
`readOnly` is a request field, so a package lists it in `honours`, C-5, and the host sends it only to a session that honours it, C-9.
A read-only statement session is a session whose open policy has both `readOnly` and `sendsStatements`.
The host holds every execute to its session's read-only policy with `checkReadOnlyRequest` before the call: a read-only execute to a session that is not one is refused `request-read-only-not-opened`, and an execute without `readOnly` to one that is is refused `request-read-only-missing`, so the plain path is never the fallback on such a session.
Both refusals name the pointer `/readOnly` and never a value of the request.
The host core keeps whether each session is a read-only statement session with the session and refuses both as records before the call, C-48.
The memory transport keeps the policy its session was opened under and refuses both before any frame, and its frame reads `readOnly` as a closed shape of a budget of two numbers and an optional mode of the vocabulary.
`readOnly` is also the name of the open policy's flag: the request reuses the word because the request is the read-only execute.
The billed-read allowance a run spends stays with the host: it is a ledger charged as each request is sent, which no frame carries, so a provider of an engine that bills every read is handed none through the contract and refuses every statement, as its own rule refuses a budget that carries none.

- schema `/$defs/executeRequestField`
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the console facets and execute's request fields are the schema's"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the read-only modes are execute and estimate-plan, frozen"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a request field the session does not honour is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a read-only execute goes only to a session opened under the read-only policy to be sent statements, and such a session takes no other execute"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a request field execute does not know, or one listed twice, is refused"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a read-only execute crosses to a session opened for read-only statements, and every other pairing is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a read-only execute to a session whose module does not honour readOnly is refused by the field before any frame"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a read-only execute's budget and mode are read as a closed shape"
- test `tests/unit/lib/provider-host/core/console.test.ts` "a read-only execute is refused before the call on a session not opened for read-only statements, and a plain execute on one that is"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's read-only statement surface has a place in the console calls or with the host"

### C-79 (normative): The agent's statements and the hand-over replay on the host

Every statement the agent's run sends, the model's and every composed grounding statement, and the editor's hand-over replay of the run's answer, runs through the host core's execute, C-48, on the legacy bridge's read-only statement session, C-50, of the provider acquired under the agent's read-only execution profile or the hand-over's, each with an open policy of both `readOnly` and `sendsStatements`, C-78.
In this order: an engine Studio's review record does not list is refused by name, then a budget that is not whole positive numbers, so neither reads the host core or reaches the provider; then the host core is read, so a call made before its install fails by name; then the session is opened, which refuses a provider without `queryReadOnly` by name, C-39, and the run propagates that refusal as a server fault, never a repairable failure.
The request is a fresh copy of the statement, every row as its page, and the read-only execute of the budget's rows and bytes and the caller's mode; the context carries the deadline, the statement timeout from the call's start, a signal that aborts at it or when the caller's does, and the empty environment, never a credential.
The statement timeout and the billed-read allowance reach the provider through the session's open, the allowance by reference.
The agent's caller signal is one that never aborts, made for that call, as for its curated readings, C-76, and the hand-over's is its request's signal, so a client that leaves while the statement runs is answered at once.
The answer is the provider's result by reference, held to the row budget, except for an estimating plan, whose rows are the optimizer's operators, and to the byte budget, each row's UTF-8 JSON bytes summed, in the providers' sentences, the check MCP's path and the agent's other budgeted readings make too.
The host pumps the first result within one page, C-53, so a row larger than one page is refused as `StudioByteBudgetRefusal` with the page's sentence, outcome unknown.
An answer over 1 MiB waits for the host's large-page slot, C-53, within its deadline, so while another caller such as the editor holds that slot it can end in the time refusal rather than the byte refusal.
A stop the deadline ended, at whatever wait of the run, is `StudioTimeBudgetRefusal` in the time budget's sentence, outcome unknown, through the accessor's budget view, C-51, and a refused start at the deadline is the same, outcome not-sent; a caller that leaves is `QueryCancelledError`.
A stopped call's settlement is handed to the run, which counts the call as an execution until it settles.
The session offers no cancel, so a stopped statement runs on, and its later failure is logged under the caller's route by kind and code, never its text, and a later answer is not logged.
A provider's error passes as the same object.
MCP's statements keep their own read path until they move onto the host core.

- test `tests/unit/lib/api/read-only-execute.test.ts` "a read-only execute runs the provider's read-only path once through one host core execute call, on a fresh request and a context of deadline, signal and env alone"
- test `tests/unit/lib/api/read-only-execute.test.ts` "its answer is the provider's result by reference, held to the row budget, except for an estimating plan, and to the byte budget, in the providers' sentences"
- test `tests/unit/lib/api/read-only-execute.test.ts` "an engine off the review record, a budget that is not whole positive numbers and a provider without a read-only path are each refused by name before any provider call"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a statement its deadline stopped is refused in the time budget's sentence, its settlement handed to the caller's hold, and a later failure is logged by kind and code only"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a stop at any wait of the run answers the time refusal"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a statement whose deadline passed before its call starts is refused in the time budget's sentence, outcome not-sent, and never reaches the provider"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a statement whose caller left is QueryCancelledError: outcome unknown once sent, not-sent before"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a row larger than one page is refused by the host's page budget"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a provider's error passes as the same object"
- test `tests/unit/lib/api/read-only-execute.test.ts` "before the host core is installed the read fails by name and calls no provider"
- test `tests/unit/lib/api/read-only-execute.test.ts` "a time budget at the longest a timer waits builds its deadline"
- test `tests/unit/lib/api/read-only-execute-bounds.test.ts` "a read-only execute whose provider never answers ends at its own deadline in the time budget's sentence"
- test `tests/unit/lib/agent/tools.test.ts` "a statement runs through the host core's read-only execute on a read-only statement session, never the provider's plain query"
- test `tests/unit/lib/agent/tools.test.ts` "an acquired provider without a read-only path is refused by the host at the session's open, and the run propagates it"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "no module outside the providers calls queryReadOnly except runReadOnlyStatement and the legacy bridge's read-only statement session"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "runReadOnlyExecute reads the review record before it reads the budget, the host core or the provider"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "the agent and the hand-over call no runReadOnlyStatement: their statements run through the host core's read-only execute"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "only the agent's statement path and the hand-over route open a read-only statement session, each under a profile that sends statements"
- test `tests/api/agent/handover.test.ts` "a hand-over whose client leaves while its statement runs answers 499 QUERY_CANCELLED, outcome unknown, and its later failure is logged by kind and code"
- test `tests/api/agent/handover.test.ts` "a hand-over row larger than one page is refused by the host's page budget"
- test `tests/api/agent/handover.test.ts` "a provider with no read-only statement path is a server fault, not a fallback"

### C-80 (normative): The agent's grounding walk and statistics read on the host

The agent's grounding inventory walk reads every container listing, count, object listing and bulk description through the granted tree facade and the host core's tree call, C-64, on one session the legacy bridge serves for the whole walk, C-50, of the provider the run acquired for its grounding.
The walk holds one deadline, the time its call was granted, the run's statement timeout already clamped to what is left of the run, taken right after the acquisition, and one signal that aborts at it alone, so it keeps one timer however many reads it makes.
Each read's context is fresh and carries that deadline, that signal and the empty environment, never a credential, and its request is a fresh copy with copies of the walk's arrays.
Its caller signal is one that never aborts, made for the walk, as for the curated readings, C-76, so the accessor, C-51, reads every end as the deadline's: a read its deadline stopped, or a read refused at its start because the deadline passed between reads, answers the walk's own time refusal, which the run reports as an inventory that timed out.
A stopped read's settlement is handed to the run before the refusal is thrown, so the run counts the read in flight as an execution until it settles, and the walk sends no further read.
A read's failure after the stop is logged under the walk's route, the tree action, kind and code, never its text, and a later answer is dropped.
A provider's error passes as the same object into the walk's own handling.
The run's billed-read allowance reaches each count, listing and bulk description by reference through the bridge's session input, C-50, never through the tree request, which carries no allowance.
The walk's first read, where the engine declares a container level, is the top-level listing: a listing that says the inventory needs configuration, C-61, marks every kind unavailable with the provider's sentence, scrubbed, and no further read is sent; otherwise its containers are the walk's first level.
The facade reads the host core and builds the session when the walk starts, so a walk made before the host core is installed throws by name before any read and is never taken for a provider's failure.

Plan mode's statistics read under the operations profile, a statement Studio composed and its statement guard admitted, runs through the composed statement facade and the host core's console execute, C-48, on the composed statement session the legacy bridge serves, C-50, so the provider receives the statement exactly as composed, with no page bound appended.
The facade reads the host core and builds the session when the read starts, so a read made before the install throws by name before any promise.
Its request is a fresh one of the statement and every row as its page, and its context carries the time its call was granted, a signal that aborts at it alone and the empty environment.
The answer is the provider's result by reference, its page released once read, and the read holds its rows to the run's row budget and to its byte budget by each row's UTF-8 JSON bytes summed, a bigint measured as its decimal text, refusing a reading past either.
The host pumps the first result within one page, C-53, so a row larger than one page is refused as `StudioByteBudgetRefusal` with the page's sentence, and an answer over 1 MiB waits for the host's large-page slot within the time granted.
A stop at whatever wait of the run, and a start refused at the deadline, is the read's own time refusal, the stopped call's settlement handed to the run first, and a failure after the stop is logged under the read's route by kind and code, never its text.

- test `tests/unit/lib/api/object-tree.test.ts` "each granted read is one host core tree call on the walk's one bridged session, a fresh request, and a fresh context on the grant's one deadline and one signal, of deadline, signal and env alone"
- test `tests/unit/lib/api/object-tree.test.ts` "a granted read hands the grant's read allowance to the bridge by reference, and none where the grant has none"
- test `tests/unit/lib/api/object-tree.test.ts` "a granted read its deadline stopped answers the grant's own time refusal, hands the stopped read's settlement to the grant's hold, and logs a later failure by kind and code only"
- test `tests/unit/lib/api/object-tree.test.ts` "a granted read after the grant's deadline is refused before the call with the grant's own time refusal and reads nothing"
- test `tests/unit/lib/api/object-tree.test.ts` "a granted read passes the provider's error as the same object"
- test `tests/unit/lib/api/object-tree.test.ts` "a granted tree before the host core is installed throws by name and reads nothing"
- test `tests/unit/lib/api/object-tree-bounds.test.ts` "a granted tree read that never answers ends at the grant's deadline in the grant's own time refusal"
- test `tests/unit/lib/agent/grounding-walk.test.ts` "every read of the walk is a host core tree call on one deadline, the time its call was granted"
- test `tests/unit/lib/agent/grounding-walk.test.ts` "the drive's allowance reaches each count, listing and bulk describe by reference through the host's tree call"
- test `tests/unit/lib/agent/grounding-walk.test.ts` "a walk whose grant ends sends no further read and answers timed-out, and the run counts only the read in flight until it settles"
- test `tests/unit/lib/agent/grounding-walk.test.ts` "the walk reads its top-level listing once, and it is the walk's first level"
- test `tests/unit/lib/agent/grounding-walk.test.ts` "is read from the provider's declaration, lists nothing and carries the reason on every kind"
- test `tests/unit/lib/agent/context-snapshot.test.ts` "a reading that overruns the time it was granted loses the whole snapshot, under its own code"
- test `tests/unit/lib/agent/context-snapshot.test.ts` "a reading that overruns its grant counts against the run's concurrency until its provider call settles"
- test `tests/unit/lib/api/composed-statement.test.ts` "a composed statement runs once through one host core execute call on a composed statement session, on a fresh request of its statement and every row and a context of deadline, signal and env alone"
- test `tests/unit/lib/api/composed-statement.test.ts` "its answer is the provider's result by reference, and its page is released"
- test `tests/unit/lib/api/composed-statement.test.ts` "a composed statement its deadline stopped answers the grant's own time refusal, its settlement handed to the hold, and a later failure is logged by kind and code only"
- test `tests/unit/lib/api/composed-statement.test.ts` "a stop at any wait of the run answers the grant's time refusal"
- test `tests/unit/lib/api/composed-statement.test.ts` "a composed statement whose deadline passed before its call is refused with the grant's time refusal, not-sent, and never reaches the provider"
- test `tests/unit/lib/api/composed-statement.test.ts` "a row larger than one page is refused by the host's page budget"
- test `tests/unit/lib/api/composed-statement.test.ts` "a provider's error passes as the same object"
- test `tests/unit/lib/api/composed-statement.test.ts` "before the host core is installed it throws by name and calls no provider"
- test `tests/unit/lib/api/composed-statement-bounds.test.ts` "a composed statement whose provider never answers ends at the grant's deadline in the grant's own time refusal"
- test `tests/unit/lib/agent/schema-stats.test.ts` "the operations-profile statistics read runs through the host core's console execute on a composed statement session, its statement exactly as composed"
- test `tests/unit/lib/agent/schema-stats.test.ts` "a statistics reading past the byte budget in UTF-8 bytes is refused, though its text is shorter than the budget"
- test `tests/unit/lib/agent/schema-stats.test.ts` "a bigint cell in a statistics reading is measured as its decimal text"
- test `tests/unit/lib/agent/schema-stats.test.ts` "the statistics read that outlasts its time is recorded as Studio's refusal"
- test `tests/isolated/composed-statistics-statement.test.ts` "every dialect that reads statistics under the operations profile hands its provider the composed statement unchanged"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "only the agent's statistics read opens a composed statement session, under the operations profile"
- test `tests/unit/db/operations/read-only-statement-callers.test.ts` "the agent, hand-over and MCP sources call query() nowhere: the statistics read sends its statement through the host core's composed statement session"

## Not yet in this contract

These chapters are added by the changes that bring their enforcers:

- The machine redaction a provider declares once built and the object kinds a maintenance spec names, with the object model; and presentation (an icon and a colour).
- The API report of each SDK entry.

## Change notes

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
