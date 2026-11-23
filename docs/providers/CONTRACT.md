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
- [`calls/index.ts`](../../packages/provider-sdk/src/calls/index.ts), the call and context types, `defineProvider`, `checkProviderModule` and `envReader`, the host's checks of a call, `checkExecuteRequest`, `checkConsoleFacet`, `checkRefinement` and `sessionCalls`, `freezeContext` and `freezeData`, the byte budgets `BATCH_MAX_BYTES` and `PAGE_MAX_BYTES` with `encodedRowBytes`, `rowsSource` and `pumpPage`, and a call's deadline, `deadlineSignal`, `checkCallStart` and `awaitWithin`, exported from `@libredb/provider-sdk/calls`.
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

### M-15 (normative): Every shipped engine has a declaration generated from Studio's tables

Every engine Studio ships has an engine declaration, `src/lib/db/engine-declarations/<type-id>.json`, generated by `scripts/generate-engine-declarations.ts` from the per-engine tables it comes from, and committed.
Each is admitted by the schema's `engineDeclaration` and the rules of its own connection.
A census reads each declaration back to every table it came from, with read-back functions of its own, so the schema is shown to hold every fact of those tables without loss.
After a table change, `bun run engines:generate` writes the declarations again.
A declaration is not a full manifest: the runtime and compatibility segments describe a package and its measurements, which a provider gains when it moves into a package of its own.

- test `tests/unit/db/engine-declarations.test.ts` "the directory holds exactly one declaration per shipped type-id"
- test `tests/unit/db/engine-declarations.test.ts` "each declaration is what the generator builds from the tables"
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
Studio's own declarations name each function by the slot it fills: `<field>Check` for a field rule's check, `hostHint`, `hostIdentity`, and `importer` for the connection import.
Studio's census holds every name its declarations give to the very function Studio runs, by identity and never by the function's own name, and finds no function Studio runs that a declaration does not name.

- schema `/$defs/functionName`
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "an importer named in another form is refused as pattern-mismatch"
- test `tests/unit/db/engine-declarations.test.ts` "every function a declaration names is, through the census's own resolver, the very function the connection form runs"
- test `tests/unit/db/engine-declarations.test.ts` "every function the connection form holds is named by its engine's declaration, and the resolver names nothing else"

### M-32 (informative): How a package's named functions are found and called

A package will export its named functions in one table, which the SDK's definition step checks against the names its manifest gives.
The host will call a named function through that table by its name, through one fixed entry point, never as a provider method of its own per function.
No package function runs in a browser, so Studio calls a named check, hint or identity reader on its server.
Nothing resolves a package's names yet: until the definition step does, Studio runs its own functions, which its census holds to their names.
Where an engine names no identity reader, Studio reads a Host text's identity as the text trimmed and lower-cased.

### M-33 (normative): Field rules

An engine may give a field it takes one rule, in `connection.fieldRules`, and a rule states at least one check: `required`, `format`, `charRange` or a named `check`.
The dialog checks the fields in the order of `connection.fields`, so the order of the rules carries no meaning, and it answers the first refusal it meets.
On each field it reads `required` first, which refuses a blank field, then, only for a field that is not blank, `format`, `charRange` and `check`, in that order.
A field hidden by its condition is not checked.
A field is blank when it holds no value or an empty one; a secret field is also blank when its value is not text or holds only whitespace.
Core refuses a connection that leaves a shown required secret blank before it builds a provider, with that rule's sentence, and the provider checks again when it connects, because a seed or an API call never passes the dialog.

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
The host marks every failure of a provider's connect, and a provider claims not-sent only by raising `refused-before-send`, whose class marks it.
No provider writes an error's `outcome` itself, and every other failure is `unknown`.

- test `tests/unit/db/provider-error-kinds.test.ts` "provider code never writes an error's outcome"
- test `tests/unit/lib/db/error-record.test.ts` "a refusal before send answers not-sent wherever it is raised"
- test `tests/unit/lib/db/error-record.test.ts` "every other class answers unknown"
- test `tests/unit/db/errors.test.ts` "a failure the connect raises keeps its identity and answers not-sent"
- test `tests/unit/db/errors.test.ts` "a connect deadline becomes a ConnectionError that answers not-sent"

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
Studio's readers and every engine's grammar row import `SqlGrammar` and `DEFAULT_SQL_GRAMMAR` from `@libredb/provider-sdk/sql` by name, a fact a dialect has not established takes the default's value, and the module that resolves a grammar by engine id declares neither.

- test `packages/provider-sdk/tests/sql/grammar.test.ts` "DEFAULT_SQL_GRAMMAR is the compatibility reading"
- test `tests/unit/sql/grammar.test.ts` "the module that resolves a grammar by engine id exports only its two readers"
- test `tests/unit/db/sql-grammar/shared.test.ts` "the shared blocks are SQLITE_GRAMMAR, NO_EXTRA_WORDS and REDACTED_VALUE"

### S-2 (informative): The grammar facts are not yet manifest data

A grammar row is still code beside its provider, read by Studio's registry.
The manifest segment that declares the facts, each pattern as a bounded pattern string, is a later part of this chapter.

## Calls

The host calls a provider's implementation in its own process, as async functions.
Every request and answer is data in the value codec's domain, except the session handle `open` answers, so the calls need no framing.
The handle holds the session's state and is the package's own: the host never reads it, which the memory test transport checks, C-22.
The manifest's `calls` segment declares what the package's code answers beyond the mandatory calls: the optional console facets and the optional request fields its execute honours.
One implementation serves every engine the package declares, so `calls` is a fact of the package, a sibling of `runtime`, and never a fact of an engine.
The shapes of each call, its request, its answer and the contexts the host passes are the types `@libredb/provider-sdk/calls` exports.
Every other surface of today's provider interface, health among them, joins this chapter with the change that carries it.

### C-1 (normative): A package's entry exports the record defineProvider returns

A package's entry default-exports the record `defineProvider` returns, `{ contract, manifest, impl }`.
`checkProviderModule` refuses any other value by a rule of `DEFINITION_REFUSAL_RULES`, each refusal naming a JSON Pointer into the record and never a value of the manifest or the implementation.
The record is frozen, its implementation is frozen in place, and its manifest is a deep-frozen copy, so the package's own manifest object is never changed.
The record is a plain object with no brand, because several copies of the SDK may share Studio's process.
Every key the check reads is read as a data property, and an accessor there is refused without its getter being called, so the functions checked are the functions the host calls.
An `honours` list longer than the request fields is refused by its length, before any item is read, so a sparse array's length bounds no loop of the check.
So is an engine list, and an engine's maintenance and agent readings lists, longer than the schema's `maxItems` for it: the engine list holds at most 64 engines, a contract limit for a package that serves one provider's engines, and each facet list at most the size of its vocabulary, since each item is listed once.

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
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "an engine list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "a maintenance list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/list-bounds.test.ts` "an agent readings list of the longest length is refused at the list, in a bounded child"
- schema `/properties/engines/maxItems`
- schema `/$defs/facets/properties/maintenance/maxItems`
- schema `/$defs/facets/properties/agentReadings/maxItems`
- test `packages/provider-sdk/tests/manifest/schema.test.ts` "the engine list is bounded at 64, and each facet list by the size of its vocabulary"
- test `packages/provider-sdk/tests/manifest/validate.test.ts` "a list longer than its maxItems is refused as too-many"

### C-2 (informative): The loader checks the record with the host's SDK

The loader reads only the entry's `default` export and runs `checkProviderModule` on it, so a record another copy of the SDK built is checked by the host's copy.
Validating the manifest against the schema is the loader's too, since it holds the schema bytes.
No loader exists yet, so nothing checks this.

### C-3 (normative): The mandatory calls

The mandatory calls are `open`, `close` and `console.execute`, each a function of the implementation's own, found at the path its name spells.
An implementation defines no other key than the calls this contract defines.

- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "a mandatory call that is missing or no function is refused as call-missing"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an implementation key the contract does not define is refused as impl-key-unknown"

### C-4 (normative): An optional facet is declared and implemented, both ways

An optional console facet, one of `CONSOLE_FACETS`, is offered in the manifest's `calls.console` exactly when the implementation has its function.
A facet is never discovered by calling it or by its shape.
An engine facet for which this contract has no call yet, a monitoring panel, a maintenance operation or an agent reading, is refused when it is offered.

- schema `/$defs/consoleCalls`
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an offered facet the implementation lacks is refused as facet-unimplemented"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an implemented facet the manifest does not offer is refused as facet-undeclared"
- test `packages/provider-sdk/tests/calls/define-provider.test.ts` "an engine facet this contract has no call for is refused as engine-facet-without-call"
- test `packages/provider-sdk/tests/calls/vocabulary.test.ts` "the console facets and execute's request fields are the schema's"

### C-5 (normative): A package declares the request fields its execute honours

A package lists in `calls.console.execute.honours` the optional request fields, of `EXECUTE_REQUEST_FIELDS`, its execute honours.
How the host uses that list is C-9, and how a provider does is C-8.

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

- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every input a provider is built with has a place in the open context or a reason it stays with the host"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "every member of today's console answer and request has a place in the console calls"
- test `tests/unit/provider-sdk/call-surface-parity.test.ts` "the context's shared shapes are Studio's own"

### C-8 (informative): A provider never ignores a request field it does not honour

A provider that receives a request field it does not honour answers a named error and never ignores it.
The kit checks it, and no such check exists yet.
The host's half, which sends no such field, is C-9.

### C-9 (normative): The host sends only the request fields a session honours

The host holds every execute request to the session's calls with `checkExecuteRequest` before the call, and refuses it by a rule of `CALL_REFUSAL_RULES` when it carries an optional request field the session does not honour, or a `scope` to a session that does not offer `console.endScope`.
A present `params` key is sent whatever its length, and an offset is sent when it is not zero.
A refusal names the field and a JSON Pointer into the request, never a value of it.

- test `packages/provider-sdk/tests/calls/request.test.ts` "a request field the session does not honour is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a session that honours every field and offers endScope takes each"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a request on a refined session is held to the narrowed calls"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a CallRefusalError carries every refusal and words each"

### C-10 (normative): A refinement only narrows a session's calls

`open` may answer a refinement beside its handle: a closed object at the paths of the manifest's `calls`, every key optional, every value of which is a subset of the declared one.
`checkRefinement` refuses a widening, an unknown key and an unreadable value by name, reading every value as a data property and never calling a getter, and no refusal carries a value of the refinement.
An `honours` list longer than the declared one is refused as a widening by its length, before any item is read, so a sparse array's length bounds no loop of the check.
`sessionCalls` answers the narrowed calls, frozen, and the host keeps them with the session and nowhere else, with no cache and no invalidation event.
A refinement is a call's answer, not a manifest fact, so the schema has no place for it.

- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a refinement that widens a declared value is refused as refinement-widens"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "an honours list longer than the declared one is refused as refinement-widens at the list, and no item is read"
- test `packages/provider-sdk/tests/calls/honours-bounds.test.ts` "a refinement honours list of the longest length is refused at the list, in a bounded child"
- test `packages/provider-sdk/tests/calls/refinement.test.ts` "a key a refinement cannot have is refused as refinement-key-unknown"
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

### C-12 (informative): The host freezes on every call, in every environment

The host passes every context and request through `freezeContext` and `freezeData` on every call, in every environment, production included, so a provider that writes to what the host passed fails the same way in a test and in production, at the line that writes.
Both freeze in place, so the host builds a fresh context and request for each call, and a value it shares across calls ends frozen.
The host core that does so arrives with the first host surface, and its test holds it; until then this clause is informative.

### C-13 (normative): The byte budgets and the row measure

The byte budgets of a result are `BATCH_MAX_BYTES`, for one batch, and `PAGE_MAX_BYTES`, for one page.
A row's size is the UTF-8 length of its encoded JSON text, `encodedRowBytes`, and a batch's and a page's size is the sum of their rows' sizes.
Measuring a row encodes every cell, so a cell outside the value codec's domain is refused by the codec's own error.

- test `packages/provider-sdk/tests/calls/results.test.ts` "the batch and page budgets are one MiB and 32 MiB"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a row's size is the UTF-8 length of its encoded JSON text"

### C-14 (normative): A result source answers within the limit it is asked for

A result source answers each `next` with at most the rows and the bytes it is asked for, and never splits a row, so a batch of exactly one row may be larger than its byte limit and one row always makes progress.
`rowsSource` does so over rows a driver already holds in memory.

- test `packages/provider-sdk/tests/calls/results.test.ts` "a batch held to batch.maxBytes"
- test `packages/provider-sdk/tests/calls/results.test.ts` "a row larger than the batch budget comes alone, and is refused only when no page can hold it"

### C-15 (normative): The host pulls a page with pumpPage

The host pulls a page from a result source with `pumpPage`, one batch at a time, the pull being the credit.
Each pull asks for no more than the page has left, with a frozen limit.
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
- test `packages/provider-sdk/tests/calls/results.test.ts` "a pump limit that is not a positive safe integer is refused before any pull"
- test `packages/provider-sdk/tests/calls/pump-bounds.test.ts` "a source that never progresses is refused after one pull, in a bounded child"
- test `packages/provider-sdk/tests/calls/pump-bounds.test.ts` "a source that never ends is cut at the page's byte budget, in a bounded child"

### C-16 (informative): What the byte budgets bound

The pump runs in the host's copy of the SDK, so every package's batches are measured by one rule.
The budgets bound what crosses from a provider, not what a driver buffers: a driver without a cursor materialises a page before the SDK sees it.
A page of very small rows is bounded in the heap by the host's row limit, not by its bytes, so the host always passes a finite row limit.
The pump measures a row once, as it reads the batch, and hands on the provider's own row arrays, so a source whose cells change after that read, through a getter or a later write, answers more than was measured; whether the host measures the frames it sends instead is decided with the first host surface.
The host core that pumps every result arrives with the first host surface; until then this clause is informative.

### C-17 (normative): The host calls a console facet only when the session offers it

The host holds every call to a console facet to the session's calls with `checkConsoleFacet` before the call, and refuses it by `facet-not-offered`, a rule of `CALL_REFUSAL_RULES`, when the session's calls do not offer that facet.
The session's calls are the ones `sessionCalls` answers, so a facet the manifest offers and a refinement narrowed to not-offered is refused too.
The refusal names the facet by its call name and a JSON Pointer into the session's calls.

- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session does not offer is refused before the call"
- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session offers is called"

### C-18 (normative): The testing entry is for tests

`@libredb/provider-sdk/testing` holds the memory test transport's pieces, and only tests import it.
The package root never re-exports it, and Studio's runtime source under `src/`, `bin/` and `vscode-extension/src/` never imports it, in any form, a type import included.

- test `packages/provider-sdk/tests/manifest/digest.test.ts` "the package root does not export the testing surface"
- test `tests/unit/package-imports.test.ts` "Studio's runtime source never imports the SDK's testing entry"
- test `tests/unit/package-imports.test.ts` "a planted runtime file that imports the testing entry fails by file and specifier"

### C-19 (normative): serve crosses every call as JSON frames through the value codec

`serve` puts a provider module record behind the memory test transport: every call crosses as one request frame and one answer frame, each the JSON text of what `encodeValue` wrote, parsed and decoded with `decodeValue` on the other side.
The provider receives decoded copies, its context frozen by `freezeContext` with the host's `signal` and `env` attached by reference, and its request by `freezeData`, and the host's own context and request are left as the host built them.
The host receives decoded copies of each answer.
A value outside the codec's domain fails where it is encoded, with the codec's own `ValueCodecError`, before the other side is called.
An `undefined` optional member, which the codec leaves out (V-9), is refused by the round trip as `round-trip-changed` at its pointer, and a frame that `readFrame` or `roundTripRefusals` refuses fails as one `FrameRefusalError`.
An error either side throws crosses by reference.
`serve` checks the module with `checkProviderModule` first and serves nothing it refuses, and what it serves is itself an implementation of the module's manifest, with the module's facets.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "a served module answers every call through one request frame and one answer frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the provider receives decoded copies, frozen at every depth, with the host's signal and environment reader by reference"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the host's own context and request are left as the host built them, and the host receives decoded copies of each answer"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a value the codec cannot carry, or a frame key the call does not define, fails the call before the provider is called"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "an error a call or a source throws reaches the host as the same object"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a value that is not a provider module record is refused with every refusal before anything is served"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "the served implementation is an implementation of the module's manifest, with the module's facets"

### C-20 (normative): Each part of each frame is read as a closed shape

`readFrame` reads each part of each call's frame, its context, its request and its answer, as the closed shape of the call type it carries.
A key the shape does not define, a required key the part lacks, and a value of the wrong type, outside its vocabulary, behind an accessor or in a list with a hole are each refused by a rule of `FRAME_REFUSAL_RULES`, at a JSON Pointer into the part, and never with a value of it.
A page bound is exactly one of its two forms, and a connection's keys are the contract's field names.
Each reader is declared as the shape of its call type, so a member added to a call type, or to a union it reads, fails typecheck until its reader names it.

- test `packages/provider-sdk/tests/testing/frames.test.ts` "a well-formed frame of every call and part is admitted"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a key a frame's shape does not define is refused as frame-key-unknown at its pointer"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a required key a frame lacks is refused as frame-key-missing"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable"
- test `packages/provider-sdk/tests/testing/frames.test.ts` "a page bound is exactly one of its two forms"
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
It reads the refinement `open` answers by C-10, so the session's calls are the narrowed ones.
An answer the host refuses holds nothing open afterwards: a refused open answer closes its session through the provider's `close`, with the open's own context, and a refused execute answer closes each result source it handed over through its own `close`.
An item of an execute answer's `results` that is not an object is refused at its index, as a hole is, and a source whose `columns` or `rowCount` read throws is closed with the sources before it, the read's own error thrown.
Every close runs, and when one fails the host receives an `AggregateError` with the refusal first and each close's error after it.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "a request field or a console facet the session does not offer is refused before any frame"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a refinement open answers narrows the served session's calls"
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

### C-28 (normative): The host stops waiting at the signal, and an abandoned answer keeps its handler

The host waits on a provider's answer with `awaitWithin`.
When the answer comes first, the wait settles as the answer does and leaves no listener on the signal.
When the signal aborts first, or had aborted already, the wait rejects with the signal's reason at once, and the answer keeps a handler for its value and for its error, which hands its late outcome to the host's late handler once, by reference.
So no abandoned rejection goes unhandled, and the host's late handler closes what a late answer handed over and logs a late failure.
A late handler that throws is a host defect, and its error is a detached rejection.
A result source runs under the context of the execute call that answered it, so `next` takes no context, and the host's wait on a page is its wait on that call.
The memory transport races nothing: an answer the host stopped waiting for is delivered whole, its session token and served sources included, so the late handler closes it once, and what the served host side refuses of a late answer it closes itself, C-23, and hands on as a failure.

- test `packages/provider-sdk/tests/calls/deadline.test.ts` "the host's wait settles as the answer does when the answer comes first, and leaves no listener on the signal"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "the host's wait ends at the signal, and the abandoned answer's outcome reaches the late handler once"
- test `packages/provider-sdk/tests/calls/deadline.test.ts` "a signal aborted before the wait ends it at once, and the answer still reaches the late handler"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "an answer the host stopped waiting for reaches its late handler whole, and the host closes what it handed over once"

### C-29 (informative): What a provider does with the deadline and the signal

A provider derives every driver timeout from `ctx.deadline`, for checkout, connect and execute alike, starts no work on a signal already aborted, and ends its waits when the signal aborts.
It answers `cancelled: false` for a run it does not know.
A result source's pulls honour the context of the execute call that answered it.
The kit checks these, and no such check exists yet.

### C-30 (normative): A session without console.cancel is reported as still running, without a call

The host refuses a cancel to a session that does not offer `console.cancel` before the call, C-17, and reports the run as not cancelled.
Studio's cancel route answers such a connection with `cancelled: false` and calls nothing.

- test `packages/provider-sdk/tests/calls/request.test.ts` "a console facet the session does not offer is refused before the call"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a request field or a console facet the session does not offer is refused before any frame"
- test `tests/api/db/cancel.test.ts` "provider without cancelQuery returns 400"

### C-31 (normative): A throw inside a call fails only that call

An error a provider's call throws reaches the host by reference, and that session and every other session keep serving.
The host core's reading of such an error into an error record arrives with the first host surface.

- test `packages/provider-sdk/tests/testing/serve.test.ts` "an error a call or a source throws reaches the host as the same object"
- test `packages/provider-sdk/tests/testing/serve.test.ts` "a call that throws fails only that call, and its session and the served instance keep serving"

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

- test `tests/integration/mcp/run-read-query.test.ts` "without queryReadOnly is refused, and query() is never the fallback"
- test `tests/isolated/factory.test.ts` "refuses %s on an engine on the review record whose provider implements no read-only statement path, before connecting it, and query() is never the fallback"
- test `tests/api/agent/handover.test.ts` "refuses to replay on an engine the review record does not list, naming it, and never calls queryReadOnly"

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
An open that fails with no caller left is handled by the host, never left as a detached rejection.

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
- test `tests/isolated/factory.test.ts` "a removal of the connection closes an open it overtook and caches nothing"
- test `tests/isolated/factory.test.ts` "a cache clear closes an open in flight and names one still opening at the cut"
- test `tests/isolated/factory.test.ts` "an open that settles while the caches close is closed once, admits nothing and answers not-sent, in either cache"
- test `tests/integration/db/factory-open-once.test.ts` "two concurrent first writes for one DuckDB connection both reach the file"

### C-45 (normative): Teardown under fixed deadlines

When the host closes its sessions, at a shutdown or when its caches are cleared, it tears each one down under fixed deadlines, shared and owned sessions alike.
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

### C-46 (normative): Contract first

The legacy provider interface, `DatabaseProvider` in `src/lib/db/types.ts`, gains no member.
A new capability lands in the manifest schema or a facet first, then in the bridge that serves today's providers as contract providers, then in the facade today's callers use.
The lint holds the members `DatabaseProvider` declares, so a capability read by duck typing outside the interface, as the factory's `openTransaction` reads `isInTransaction` and `rollbackTransaction`, is not a member it can see, and such a read is held by review.

- test `tests/unit/lib/db/database-provider-members.test.ts` "DatabaseProvider gains no member, so every SPI change lands contract-first"
- test `tests/unit/lib/db/database-provider-members.test.ts` "a planted member is refused by name"
- test `tests/unit/lib/db/database-provider-members.test.ts` "a removed member is refused by name, so the list stays exact"

## Not yet in this contract

These chapters are added by the changes that bring their enforcers:

- Connection string rows: their schemes, their URL TLS and paste readers, and their seed checks.
- Editor and SQL text: execution UI, the SQL grammar facts as manifest data, SQL writing, migration DDL, generators, editor languages, explain formats and discovery fence tags.
- Policy and MCP claims, each a request a provider makes that only Studio's review record grants, the agent overlay, and presentation (an icon and a colour).
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
- The connection dialog's per-field facts, its labels, hints, placeholders, placement, choices, conditions and absent values, are lists of entries that each name their field, rather than maps keyed by field, M-24.
- A condition is one field equal to one value, with no list of values and no combination of conditions in this contract, M-25.
- A `calls` segment declares the package's optional console facets and the request fields its execute honours.
  The sketch's dotted facet list is not adopted for calls, which are keyed by the path to their function.
- A function the manifest names is a name, never code, M-31.
- A refused field carries the sentence core refuses it with, M-38.
- The sketch's frame cap is replaced by the byte budgets, since calls are unframed in process; the memory test transport keeps frames for tests only.
