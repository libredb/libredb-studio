# Provider contract

This is the contract a LibreDB Studio provider package builds on and Studio reads it by.
A provider package is code that serves one or more engines, loaded into Studio's own process, and the contract is everything the two sides may rely on from each other.
The contract is versioned on its own, apart from Studio's releases, and this document states the version in force.

The SDK package `@libredb/provider-sdk`, under [`packages/provider-sdk`](../../packages/provider-sdk), carries the contract's machine-readable parts:

- [`manifest.schema.json`](../../packages/provider-sdk/src/manifest/manifest.schema.json), the manifest schema, JSON Schema 2020-12, published as `@libredb/provider-sdk/manifest.schema.json`.
- [`manifest-types.generated.ts`](../../packages/provider-sdk/src/manifest/manifest-types.generated.ts), the manifest's TypeScript types, generated from the schema.
- `compileManifestValidator`, `refusalSentence` and the refusal types, exported from `@libredb/provider-sdk/manifest`.

The schema and the generated types are the source for every vocabulary named here, and this document lists none of them by hand.

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

A refused field, which the provider receives only to refuse a value in it, is never also one of the engine's fields.
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

- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source declares no top-level let or var"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source creates no top-level Map, Set, WeakMap or WeakSet"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "SDK source never reads process"
- test `packages/provider-sdk/tests/sdk-purity.test.ts` "two validators compiled from the same bytes are independent objects"

### M-20 (informative): Studio never reads `vendor`

`vendor` is the package's own, and Studio reads none of it.
No manifest reader exists in Studio yet, so nothing checks this.

### M-21 (informative): How a host admits a contract

The version rule under "Contract version" is applied by the loader's admission, which does not exist yet.
Until it does, the validator serves exactly one contract, the one its schema names, and refuses every other.

### M-22 (informative): How a package reads its declared environment

A package declares the environment variables it reads in `runtime.env`, so every setting it reads is listable before its code runs.
The accessor that returns a declared name and refuses any other is a later part of the SDK; until it exists the declaration is the whole of this clause.

### M-23 (informative): The validator compiles code

ajv compiles a schema into a JavaScript function, built with `new Function`.
The validator runs on the server and in the kit, never in a browser, so a content security policy there does not apply to it.

## Not yet in this contract

These chapters are added by the changes that bring their enforcers:

- Connection presentation: the dialog's labels, hints, placeholders, placement, field rules and options, the connection string schemes and their paste readers, and credential warnings.
- Editor and SQL text: execution UI, SQL grammar, SQL writing, migration DDL, generators, editor languages, explain formats and discovery fence tags.
- Policy and MCP claims, each a request a provider makes that only Studio's review record grants, the agent overlay, and presentation (an icon and a colour).
- Values and errors: the value tags of results and the error kinds a provider raises.
- Calls: how the host calls a provider in its own process, with its deadlines, cancellation and byte budgets.
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
- Facet names keep Studio's own vocabulary, the seven monitoring panels, the maintenance operations and the curated agent readings, rather than new dotted names.
