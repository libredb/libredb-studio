/**
 * What enforces each clause of `docs/providers/CONTRACT.md`, by clause id, and where each removed clause's rule is
 * stated now.
 *
 * `CLAUSE_ENFORCERS` lists a clause's tests, by file and exact title, and its manifest schema locations, by JSON
 * Pointer into `packages/provider-sdk/src/manifest/manifest.schema.json`. The document states each rule and this map
 * names what checks it, so the contract reads as rules and the checks stay machine-checked:
 * tests/unit/provider-contract-clauses.test.ts fails, by clause id, on a normative clause with no entry here, on an id
 * here the document has no clause for, on a test file or title that does not exist (a renamed or deleted test), and on
 * a pointer that resolves to nothing (a moved schema member). Order inside an entry carries no meaning.
 *
 * `REMOVED_CLAUSES` maps each id the document no longer holds to the tracked file whose docblock states that rule. A
 * removed clause stated Studio's own mechanics, which a provider package can neither follow nor rely on, so its rule
 * lives beside the code that implements it, and its tests stay where they are. A removed id is never reused, and every
 * citation of it across the repository still resolves here: the clause test fails on a removed id that is a clause
 * again, on a home that does not exist, and on a clause id cited anywhere that is neither a clause nor removed.
 */

/** A clause's enforcers: test files to their exact titles, then schema JSON Pointers. */
export interface ClauseEnforcers {
  readonly tests?: Readonly<Record<string, readonly string[]>>;
  readonly schema?: readonly string[];
}

export const CLAUSE_ENFORCERS: Readonly<Record<string, ClauseEnforcers>> = {
  "M-1": {
    tests: {
      "packages/provider-sdk/tests/manifest/digest.test.ts": [
        "MANIFEST_SCHEMA_SHA256 is the SHA-256 of the schema file's bytes",
        "a schema whose bytes differ is refused before it is parsed, naming both digests",
      ],
    },
  },
  "M-2": {
    tests: {
      "tests/unit/provider-sdk/manifest-types.test.ts": [
        "the generated manifest types are what the schema renders",
        "rendering refuses a keyword it does not read, naming it",
      ],
    },
  },
  "M-3": {
    tests: {
      "packages/provider-sdk/tests/manifest/schema.test.ts": [
        "every object schema is closed except vendor and the envelope",
      ],
    },
    schema: ["/additionalProperties", "/properties/vendor"],
  },
  "M-4": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a manifest built against another contract is refused as PROVIDER_CONTRACT_UNSUPPORTED without schema refusals",
        "the envelope is read first: a missing contract is the only refusal",
      ],
    },
    schema: ["/$defs/envelope/properties/contract/pattern", "/properties/contract/const"],
  },
  "M-5": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "no refusal carries a value of the manifest",
        "a failed variant is one no-variant refusal and nothing under it",
        "several failures are each refused, ordered by pointer",
        "words each rule in one sentence naming the pointer, and the key where there is one",
        "quotes an unknown key as a JSON string, so a key with a line break stays on one line",
        "names the contract a manifest declares that the host does not serve",
      ],
    },
  },
  "M-6": {
    tests: {
      "packages/provider-sdk/tests/manifest/schema.test.ts": ["package, name, version and publisher are unknown keys"],
    },
    schema: ["/additionalProperties"],
  },
  "M-7": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "two engines with one id are refused as engine-id-duplicate at the second",
      ],
    },
    schema: ["/$defs/engineId/pattern"],
  },
  "M-8": {
    schema: [
      "/$defs/engineDeclaration/required",
      "/$defs/connection/required",
      "/$defs/monitoringPanels/required",
      "/$defs/facets/required",
    ],
  },
  "M-9": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "the schema's field names are the connection fields and the seed-only fields",
        "the schema's secret, identity and public lists are the storage layer's classes of those fields",
      ],
    },
    schema: ["/$defs/fieldName", "/$defs/secretFieldName", "/$defs/identityFieldName", "/$defs/publicFieldName"],
  },
  "M-10": {
    tests: { "tests/unit/lib/db/provider-cache-key.test.ts": ["changing any one of them alone changes the key"] },
  },
  "M-11": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a refused field that is also declared is refused as refused-field-declared",
        "a seed-only field neither declared nor a seed-only name is refused as seed-only-field-undeclared",
        "a host path field that is not a seed-only field of its engine is refused as host-path-field-undeclared",
        "an engine declaration is held to the rules of its own connection",
      ],
    },
    schema: ["/$defs/seedOnlyFieldName", "/$defs/hostPathField"],
  },
  "M-12": {
    tests: {
      "tests/unit/lib/db/provider-files.test.ts": [
        "either path naming one of Studio's own storage files is refused by name, with the field and the connection's type, before any provider is built",
        "every field HOST_PATH_FIELDS names is a seed-only field, so only an operator's seed file or an embedder's own code names one",
      ],
    },
  },
  "M-13": {
    schema: [
      "/$defs/runtime/properties/entry/pattern",
      "/$defs/nativePackage/properties/version/pattern",
      "/$defs/envDeclaration/properties/name/pattern",
    ],
  },
  "M-14": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an engine with no compatibility entry is refused as compatibility-engine-missing",
        "a compatibility entry for an undeclared engine is refused as compatibility-engine-undeclared",
        "a range endpoint missing from the tested versions is refused as compatibility-endpoint-untested",
      ],
    },
    schema: ["/properties/compatibility", "/$defs/imageReference/properties/digest/pattern"],
  },
  "M-17": {
    tests: {
      "tests/unit/package-imports.test.ts": [
        "the repository's packages import only what they declare",
        "core reaches no workspace package by path",
      ],
    },
  },
  "M-18": {
    tests: {
      "tests/unit/provider-source-coupling-lint.test.ts": [
        "process.env is refused in provider source, in each form a provider reads it today",
        "the SDK's source is covered",
      ],
    },
  },
  "M-19": {
    tests: {
      "packages/provider-sdk/tests/sdk-purity.test.ts": [
        "SDK source declares no top-level let or var",
        "SDK source creates no top-level Map, Set, WeakMap or WeakSet",
        "SDK source never reads process",
        "SDK source's module-level typed arrays are the codec's lookup tables and its encode buffer",
        "two validators compiled from the same bytes are independent objects",
      ],
    },
  },
  "M-22": {
    tests: {
      "packages/provider-sdk/tests/calls/env.test.ts": [
        "a declared name is read through the host's reader",
        "an undeclared name is refused by name and never read",
        "a package that declares no environment reads none",
      ],
    },
  },
  "M-24": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an empty placeholder is admitted: it means the field shows no example",
        "%s for a field the engine does not take is refused as field-undeclared",
        "two entries of one list naming one field are refused as dialog-entry-duplicate at the second",
        "an engine declaration's dialog is held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/db/engine-declarations.test.ts": ["connection.dialog.labels, hints and placeholders are the form's"],
    },
    schema: ["/$defs/connectionDialog"],
  },
  "M-25": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a condition with a second key is refused as unknown-key",
        "a condition on, or reading, a field the engine does not take is refused as field-undeclared",
        "a condition reading a field that has a condition of its own is refused as shown-when-chained",
        "a condition on a select naming a value none of its choices is refused as shown-when-value-not-an-option",
        "an absent value that is none of its field's choices is refused as absent-value-not-an-option",
        "an absent value for a field no condition reads is refused as absent-value-unread",
        "a select field a condition reads with no absent value is refused as absent-value-missing",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "a form read from the declaration shows the same fields as the connection form for every value of each controlling field",
      ],
      "tests/unit/lib/db-ui-config.test.ts": ["the dialog refuses exactly what core refuses of a required secret"],
    },
    schema: ["/$defs/fieldCondition", "/$defs/fieldAbsentValue"],
  },
  "M-26": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a placement for a field that is not placeable is refused as value-not-allowed",
        "a placeable field the engine takes with no placement is refused as placement-missing",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select",
      ],
      "tests/unit/lib/db-ui-config-placement.test.ts": [
        "each engine declares a placement for exactly the placeable fields it takes, and no other",
      ],
    },
    schema: ["/$defs/placeableFieldName", "/$defs/fieldPlacement"],
  },
  "M-27": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "choices for a field that is not a select are refused as value-not-allowed",
        "a select field the engine takes with no options is refused as options-missing",
        "two choices of one field with one value are refused as option-value-duplicate at the second",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "the placeable fields are PLACEABLE_FIELDS and the select fields are those the descriptors draw as a select",
      ],
    },
    schema: ["/$defs/selectFieldName", "/$defs/fieldOptions"],
  },
  "M-28": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an order item naming a field the engine does not take is refused as field-undeclared",
      ],
      "tests/unit/db/engine-declarations.test.ts": ["connection.dialog.order is the form's dialogOrder"],
    },
    schema: ["/$defs/connectionDialog/properties/order"],
  },
  "M-29": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "URI schemes on an engine without a host field are refused as host-uri-schemes-without-host",
      ],
      "tests/unit/db/engine-declarations.test.ts": ["connection.hostUriSchemes is the form's hostAcceptsUri, in order"],
    },
    schema: ["/$defs/hostUriScheme"],
  },
  "M-30": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "the three credential warning kinds are admitted, a pair with an empty password among them",
        "a credential warning on a field the engine does not take is refused as credential-warning-field-undeclared",
        "a second no-secret warning is refused as no-secret-warning-duplicate",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.credentialWarnings is the engine's CREDENTIAL_WARNINGS row, and the form reads that same row",
      ],
      "tests/unit/lib/db/credential-warnings.test.ts": ["refuses the declared pair with the dialog's own sentence"],
    },
    schema: ["/$defs/credentialWarning"],
  },
  "M-31": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an importer named in another form is refused as pattern-mismatch",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every function a declaration names is, through the census's own resolver, the very function the connection form runs",
        "every function the connection form holds is named by its engine's declaration, and the resolver names nothing else",
        "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names",
        "every function a connection string row holds is named by its engine's declaration",
        "every function a grammar row holds is, through the census's own resolver, the very slot its declaration names",
        "every function a grammar row holds is named by its engine's declaration",
        "every name an SQL writing declaration states is its member's slot, and Studio's SQL writing function table binds it there to the function the engine's row runs",
        "every function an SQL writing row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named",
        "every name a migration DDL declaration states is its member's slot, and Studio's migration DDL function table binds it there to the function the engine's row runs",
        "every function a migration DDL row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named",
        "every name an SQL generator declaration states is its member's slot, and Studio's SQL generator function table binds it there to the function the engine's row runs",
        "every function an SQL generator row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named",
        "every name an agent overlay declaration states is its member's slot, and resolves through the census's slot table to the very function the engine's own overlay module exports there",
        "every function an engine's server overlay holds is named at its slot by its engine's declaration, and no slot the overlay leaves empty is named",
      ],
      "tests/unit/lib/db/connection-form.test.ts": [
        "Studio's function table holds exactly the functions the committed declarations name, each at its own slot",
      ],
      "tests/unit/db/connection-string/compose.test.ts": [
        "Studio's connection string function table holds exactly the functions the committed declarations name, each at its own slot",
      ],
      "tests/unit/lib/db/function-table.test.ts": [
        "a name the table holds for the engine is bound, and any other name is refused by name, an inherited one included",
        "a slot's table holds each engine's function under the slot's name, and nothing else",
      ],
      "tests/unit/db/sql-writing/compose.test.ts": [
        "Studio's SQL writing function table holds exactly the functions the committed declarations name, each at its own slot",
      ],
      "tests/unit/db/migration-ddl/compose.test.ts": [
        "Studio's migration DDL function table holds exactly the functions the committed declarations name, each at its own slot",
      ],
      "tests/unit/lib/query-generators-compose.test.ts": [
        "Studio's SQL generator function table holds exactly the functions the committed declarations name, each at its own slot",
      ],
    },
    schema: ["/$defs/functionName"],
  },
  "M-33": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a field rule for a field the engine does not take is refused as field-undeclared",
        "two field rules naming one field are refused as field-rule-duplicate at the second",
        "a field rule that states nothing is refused as field-rule-empty",
        "a character range whose minimum exceeds its maximum is refused as char-range-inverted",
        "an engine declaration's field rules and host readers are held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.fieldRules are the form's fieldRules, each pattern by its source and flags",
        "a form whose rules are read from the declaration refuses exactly what the connection form refuses",
      ],
      "tests/unit/lib/db-ui-config.test.ts": [
        "connectionFieldRefusal checks charRange after format",
        "the dialog refuses exactly what core refuses of a required secret",
      ],
      "tests/unit/lib/db/connection-field-rules.test.ts": [
        "its run-time graph reaches no React, component, provider or Node built-in module",
        "fieldRuleRefusal answers what connectionFieldRefusal answers on the engine's form entry, and refuses a type outside the union by name",
        "a field holding null holds no value: its required rule refuses it and no other check reads it",
      ],
      "tests/unit/db/connection-field-rules/provider-acceptance.test.ts": [
        "every connection the shared field rules refuse, its engine's provider refuses before it opens a socket",
        "each engine's base connection passes its provider's checks and reaches the loopback socket",
      ],
      "tests/api/db/test-connection-field-rules.test.ts": [
        "Test Connection's route refuses exactly the connections the dialog refuses, with the dialog's sentence, over every engine's field rules",
        "every connection the dialog lets through reaches the tunnel and the build on Test Connection's route",
      ],
      "tests/unit/lib/api/test-connection.test.ts": [
        "a connection its engine's field rules refuse is refused with the rule's sentence before the tunnel opens or anything is built, and its statement was not sent",
      ],
    },
    schema: ["/$defs/fieldRule"],
  },
  "M-34": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a field rule's pattern longer than 512 characters is refused as out-of-range",
        "a field rule's pattern with a flag other than u is refused as value-not-allowed",
        "a pattern that does not compile is refused as pattern-invalid",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.fieldRules are the form's fieldRules, each pattern by its source and flags",
      ],
    },
    schema: ["/$defs/boundedPattern"],
  },
  "M-36": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a host hint named in another form is one no-variant refusal",
        "a host reader on an engine without a host field is refused as host-reader-without-host",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every function a declaration names is, through the census's own resolver, the very function the connection form runs",
        "connection.hostHint, hostIdentity and import are the form's, the import with its label",
      ],
      "tests/components/ConnectionModal.test.tsx": [
        "draws no Port box, lets the Account span the row, and shows the host Studio connects to",
      ],
      "tests/components/ConnectionModal-snowflake.test.tsx": [
        "a second paste naming another account drops the first account's token, database and schema",
      ],
    },
    schema: ["/$defs/connection/properties/hostHint", "/$defs/connection/properties/hostIdentity"],
  },
  "M-37": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an import without its importer is refused as missing-key, and a label longer than 128 characters as out-of-range",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every function a declaration names is, through the census's own resolver, the very function the connection form runs",
      ],
      "tests/components/ConnectionModal-kubeconfig.test.tsx": [
        "the entry declares it, and its loader resolves to the browser importer itself",
      ],
      "tests/unit/lib/connection-import-declaration.test.ts": ["is declared by exactly the listed entries"],
      "tests/unit/lib/kubernetes/kubeconfig-import.test.ts": [
        "never throws, whatever the text",
        "a context that cannot be imported is refused by its place, never by a value",
      ],
    },
    schema: ["/$defs/connectionImport"],
  },
  "M-38": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a refused entry without its sentence is refused as missing-key",
        "two refused entries naming one field are refused as refused-field-duplicate at the second",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.refused is the engine's REFUSED_CONNECTION_FIELDS row, each field with its sentence, in the order core checks them",
        "core refuses a connection that sets a refused field with the sentence its declaration states",
      ],
      "tests/unit/lib/db/open-check.test.ts": ["the first set field in the row's order answers its sentence"],
    },
    schema: ["/$defs/refusedField"],
  },
  "M-39": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a connection string scheme that is not a lower-case URI scheme is refused as pattern-mismatch",
        "a scheme on an engine whose connection string names no paste reader is refused as scheme-without-paste",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.connectionString.scheme is the row's scheme",
        "ENGINE_URI_SCHEMES is the scheme of each declaration that states one",
      ],
      "tests/components/ConnectionSignature.test.tsx": [
        "shows only schemes parseConnectionString accepts, one per engine that has one",
      ],
    },
    schema: ["/$defs/connectionStringOffer/properties/scheme"],
  },
  "M-40": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a paste reader named in another form is refused as pattern-mismatch",
        "a paste with no format is refused as too-few, and one naming a format twice as duplicate",
        "a paste format longer than 128 characters is refused as out-of-range",
        "a paste without its catch-all flag is refused as missing-key",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.connectionString names a URL TLS reader, a paste reader and a seed check exactly where the row has one, the paste with its catch-all and formats in order",
        "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names",
        "a parser walking core's paste order over the readers the declarations name parses and detects as the parser does",
        "the Paste URL box's formats are the declarations' formats in the engine picker's order",
      ],
      "tests/unit/db/connection-string/census.test.ts": [
        "each row is its declaration's connection string composed with Studio's function table",
      ],
      "tests/unit/db/connection-string/paste.test.ts": [
        "every row that reads a paste names at least one format",
        "the box's list is the rows' formats in the order the engine picker lists them, and nothing else",
      ],
    },
    schema: ["/$defs/connectionStringPaste"],
  },
  "M-41": {
    tests: {
      "tests/unit/db/connection-string/paste.test.ts": [
        "a catch-all row comes after every row that claims its own spellings",
        "each declared overlap names two rows in the order, the first walked first, and its text is claimed by both",
        "every pasted fixture has one claimant or a declared pair, and the first is the engine it parsed as",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "core's paste order walks exactly the engines whose declaration names a paste reader, every catch-all after the rest",
      ],
    },
  },
  "M-42": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a URL TLS reader or a seed check named in another form is one no-variant refusal",
        "a URL TLS reader on an engine whose connection string names no paste reader is refused as url-tls-without-paste",
        "an engine declaration's connection string is held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names",
      ],
      "tests/unit/db/connection-string/census.test.ts": [
        "each row is its declaration's connection string composed with Studio's function table",
      ],
      "tests/unit/lib/connection-string-parser.test.ts": [
        "an unrecognised sslmode does not become disable",
        "maps the JDBC/Heroku ssl=true form to verify-system, not to require",
        "refuses to map ssl-mode=PREFERRED",
        "an unrecognised Encrypt does not become disable",
      ],
    },
    schema: ["/$defs/connectionStringOffer/properties/urlTls"],
  },
  "M-43": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "every function a connection string row holds is, through the census's own resolver, the very slot its declaration names",
      ],
      "tests/unit/db/connection-string/census.test.ts": [
        "each row is its declaration's connection string composed with Studio's function table",
      ],
      "tests/unit/seed/types.test.ts": [
        "refuses an account connect() refuses, naming the entry and the field and never the value",
        "leaves root, and a user written as a reference, to the editor and to the check at open",
        "refuses anything but a list of strings in the table's words, not zod's",
      ],
    },
    schema: ["/$defs/connectionStringOffer/properties/seedCheck"],
  },
  "M-44": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a commit keyword that is not one word is refused as pattern-mismatch",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.commitKeyword and editor.consentDeadline are the engine's EXECUTION_UI row",
        "executionUiFor answers, for every engine, the spec its declaration states",
        "every member of an execution UI row has its member in the declaration",
      ],
      "tests/unit/db/execution-ui/census.test.ts": [
        "each row is its declaration's commit keyword and consent deadline, read from the generated execution UI record",
      ],
      "tests/unit/db/execution-ui/shared.test.ts": ["the postgres golden names it in the rolled-back notice"],
    },
    schema: ["/$defs/editor/properties/commitKeyword"],
  },
  "M-45": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a consent deadline chip longer than 128 characters or a sentence longer than 2000 is refused as out-of-range",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.commitKeyword and editor.consentDeadline are the engine's EXECUTION_UI row",
        "executionUiFor answers, for every engine, the spec its declaration states",
      ],
      "tests/unit/db/execution-ui/census.test.ts": [
        "the commit keyword and consent deadline rows are the ones today's code has",
        "each row is its declaration's commit keyword and consent deadline, read from the generated execution UI record",
      ],
    },
    schema: ["/$defs/consentDeadline"],
  },
  "M-46": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a fence alias that is not a lower-case tag is refused as pattern-mismatch, one listed twice as duplicate, and a seventeenth as too-many",
        "a fence alias equal to an engine id of the manifest is refused as fence-alias-engine-id",
        "a fence alias an earlier engine declares is refused as fence-alias-duplicate at the later",
        "a generic fence tag declared as an alias is refused as fence-alias-generic",
        "an engine declaration's fence aliases are held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.fenceAliases are the aliases ALIAS_ENGINES maps to the engine",
        "ALIAS_ENGINES and QUERY_FENCE_ALIASES are the declarations' aliases and the schema's generic fence tags",
        "a reader built from the declarations names and admits every fence tag as fenceTagEngine and isQueryFenceTag do",
      ],
      "tests/unit/lib/sql/fence-tags.test.ts": [
        "an alias names the engine it is an alias for",
        "a generic tag and an absent one name no engine, so they contradict none",
      ],
      "tests/unit/db/engine-catalog.test.ts": [
        "an alias two declarations state, or one equal to another admitted engine id, is refused by name",
      ],
    },
    schema: ["/$defs/fenceTag", "/$defs/genericFenceTag"],
  },
  "M-48": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an explain format outside Studio's strategies is one refusal at the editor's explain format",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.explainFormat is the format the engine's unconnected provider declares, null exactly where it supports no explain",
        "a variable a provider reads before it connects, set where the generator runs, changes no declaration",
        "the census reads each provider's capabilities in its stated environment, so a variable set where it runs changes none",
        "every declared explain format has Studio's strategy for it",
        "the explain formats, the query dialects and the generic fence tags are Studio's",
      ],
      "tests/unit/lib/explain/registry.test.ts": ["returns null for undefined (provider without explain support)"],
    },
    schema: ["/$defs/explainFormat"],
  },
  "M-50": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a dialect outside Studio's dialects is refused as value-not-allowed",
        "a history mask with no flag is refused as too-few, and a flag that is not a long option as pattern-mismatch",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.dialect is the provider's query dialect with its QUERY_DIALECTS row",
        "QUERY_DIALECTS is the dialect rows the declarations state, one per dialect, each opening tabs of its own name",
        "history keeps no value of a flag the declarations name, as it keeps none of the registry's",
        "every member of a dialect row has its member in the declaration",
      ],
      "tests/unit/lib/history-mask.test.ts": ["a registered dialect answers its record's mask"],
      "tests/unit/db/kubernetes/history-mask.test.ts": ["the dialect declares exactly the console's credential flags"],
      "tests/unit/editor/tab-language-registry.test.ts": [
        "resolveTabType answers the registry record's tabType before reading the language",
      ],
      "tests/unit/db/dialect-gates-registry.test.ts": [
        "a record that offers profiling, code generation and a count is offered all three",
      ],
    },
    schema: ["/$defs/queryDialectRow", "/$defs/historyMask"],
  },
  "M-51": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a connect budget of null or within 30,000 to 300,000 ms is admitted",
        "a connect budget below 30,000 ms or above 300,000 ms is refused as out-of-range at the connection's connectBudgetMs",
        "a connect budget that is not a whole number is refused as wrong-type",
        "a connection without connectBudgetMs is refused as missing-key",
      ],
      "packages/provider-sdk/tests/calls/deadline.test.ts": [
        "the host's default connect budget is 70 s, inside the bounds the schema gives a declared one",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connectBudgetFor answers, for every engine, the budget its declaration states, or the host's default where it states null",
      ],
      "tests/unit/db/connect-budget.test.ts": [
        "the host's default is the pools' 60 s acquire bound plus 10 s",
        "only BigQuery and Snowflake declare a connect budget of their own",
      ],
      "tests/unit/db/bigquery/connect-budget.test.ts": [
        "BigQuery's connect budget covers its connect's dataset list and probe job at the default statement timeout, plus 10 s",
      ],
      "tests/unit/db/snowflake/connect-budget.test.ts": [
        "Snowflake's connect budget covers its connect's two Studio statements at their deadline, plus 10 s",
      ],
    },
    schema: ["/$defs/connectBudget"],
  },
  "M-52": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "every claim of the policy and MCP segments is the row of Studio's review record of it",
        "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it",
        "each claim the census reads back is a member of the schema's engine declaration",
        "agent mode opens a workflow on exactly the engines the declarations' statement languages and readings and Studio's agent execution record give it",
        "READ_ONLY_ENFORCED is true exactly where the declaration's write reach is not open",
        "each declaration's policy and MCP segments hold exactly the claims Studio keeps a review record of",
        "MCP serves statements on exactly the engines the declarations' claims and Studio's agent execution record give it",
      ],
      "tests/unit/db/engine-declaration-readers.test.ts": [
        "only the modules DECLARATION_READERS lists read an engine declaration or a projection of the declarations",
        "a listed reader reads a claim only where CLAIM_READERS lists it, so a declared claim reaches a gate only as Studio's grant of it",
        "the scan finds each way a module could read a declaration or a projection, and passes over a backticked path in a comment",
        "every claim record Studio keeps in core is written by hand, so no projection of the declarations can feed one",
        "the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module, the SQL grammar and the server catalog's composition, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW",
      ],
      "tests/unit/mcp/served-engines.test.ts": [
        "an engine agent mode does not execute on is not served, whatever its rows say",
      ],
      "tests/unit/db/claim-record-readers.test.ts": [
        "every policy, MCP, connection and agent mode claim record is read only by the grant reader",
      ],
      "tests/unit/db/write-reach-capability.test.ts": [
        "READ_ONLY_ENFORCED, now derived from the record, answers what it answered before, bar the flipped entries",
      ],
    },
    schema: ["/$defs/policyClaims", "/$defs/mcpClaims"],
  },
  "M-53": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a policy and an MCP segment at every claim's restrictive value are admitted",
        "an engine whose connection, facets, agent and SQL text claims are at their restrictive values is admitted",
        "a catalog read that claims no command, the claim's restrictive value, is admitted",
      ],
      "tests/unit/seed/types.test.ts": [
        "refuses readOnly: true on every engine whose write reach is open, naming the type and the field",
        "refuses mcp: true without read roots, at the mcp field, and loads it with them",
        "refuses only the engine the record answers false for",
        "fails a seed with mcp: true and no agent key, naming mcp and the type",
        "refuses either field on a %s seed, which takes no agent credential",
      ],
      "tests/isolated/factory.test.ts": [
        "a databend connection with readOnly: true is refused before anything is built (Databend design 5.7)",
        "libredb takes no agent credential and refuses %s before it connects",
      ],
      "tests/unit/lib/db/provider-cache-key.test.ts": [
        "a non-admin (deny) DuckDB handle keys apart from an admin (allow) one, so they never share a handle",
        "an owner appends a framed segment, no owner is byte-identical, and duckdb and libredb ignore the owner",
      ],
      "tests/unit/db/refuses-denied-file-access.test.ts": [
        "SQLite refuses a handle opened with file access denied, and DuckDB confines one",
      ],
      "tests/api/agent/runs.test.ts": [
        "an OPC UA run that sends statements is refused on a connection without read roots, before a run exists",
      ],
      "tests/unit/mcp/served-engines.test.ts": [
        "an engine MCP is not offered for is not served, whatever its MCP read row says",
        "an agent engine whose MCP read row is false is not served, though every other record lets it through",
      ],
      "tests/unit/mcp/annotations.test.ts": [
        "answers not read-only and not destructive, closed-world, for a reach holding an engine whose row is true",
      ],
      "tests/integration/mcp/context.test.ts": [
        "refuses a connection with no agent credential in Studio's words, naming the connection",
      ],
      "tests/unit/lib/governance/admission.test.ts": [
        "every engine that opens a local file stays ENGINE_UNSUPPORTED, named in GOVERNANCE_ALLOWED_ENGINES or not",
        "a postgres definition without database is skipped as SERVER_LEVEL_NOT_ALLOWED",
      ],
      "tests/unit/lib/db/provider-files.test.ts": [
        "one of Studio's own files is refused by name with the reserved sentence and the connection's own type",
        "either path naming one of Studio's own storage files is refused by name, with the field and the connection's type, before any provider is built",
      ],
      "tests/unit/lib/db/tunnel-decision.test.ts": [
        "%s: a tunnel that is on is refused exactly when its row names a reason",
      ],
      "tests/unit/lib/agent/agent-manifest.test.ts": [
        "%s opens operations and planning, and refuses a statement workflow in agent mode",
        "the operations arm refuses an engine the tables leave out of the agent-readings requirement",
      ],
      "tests/unit/lib/query-events/redact.test.ts": [
        "every redaction vector produces its redacted text and fingerprint",
      ],
      "tests/unit/components/results-grid-masking-exemption.test.ts": [
        "the rules themselves are untouched: with no declaration the same column is still masked",
      ],
      "tests/unit/lib/agent/composed-catalog-admission-drive.test.ts": [
        "an overlay that does not declare its catalog read a command gets the ordinary refusal",
      ],
    },
  },
  "M-54": {
    tests: {
      "tests/unit/db/claim-grants.test.ts": [
        "a write reach request is capped at the grant, and read open where no record exists",
        "a claim whose restrictive value is true is granted true where the request or the record is, or no record exists: %s, request %p, record %p",
        "a claim whose restrictive value is false is granted true only where both the request and the record are: %s, request %p, record %p",
        "a denied file access refusal requested keeps its own sentence, one offered against a record's refusal takes the record's, and one offered where no record exists takes core's own",
        "a single-writer file request equal to its grant is read as granted, and any other request leaves the engine refused at every open, by name",
        "an agent credential form request equal to the record, pair for its null row, is read as the record's, and any other, or one with no record, as none",
        "a masking exemption request equal to the record's row is granted, and any other, or one with no record, is read as null",
        "a claim value outside its vocabulary is refused by name, naming the claim and the engine",
        "READ_ONLY_ENFORCED is true exactly where the granted write reach is not open",
        "the granted tables are frozen, each row too, keyed exactly by the shipped engines",
        "the host path fields granted are the union of the request and the record, and every host path field among the seed-only fields where no record exists",
        "a server level request is read per gate: true at governance admission where either is or no record exists, true at the choice of database only where both are: request %p, record %p",
        "a refused tunnel request keeps its own sentence, one offered against a refusing record takes the record's, and one offered where no record exists takes core's own",
        "a seed agent credential request equal to the record's row is granted as that row, and any other, or one with no record, is read as null",
        "a value outside its vocabulary in Studio's record is refused naming the record, the claim and the engine, never as the engine's request",
      ],
      "tests/unit/lib/db/claim-grant-refusal.test.ts": [
        "assertClaimsGranted refuses an engine whose claims leave a refusal at open, naming the type, and passes one with none",
      ],
      "tests/isolated/claim-grant-open-refusal.test.ts": [
        "each of the factory's four entry points refuses an engine left refused at open before any cache lookup, tunnel or build",
      ],
      "tests/unit/db/engine-declaration-readers.test.ts": [
        "every claim record Studio keeps in core is written by hand, so no projection of the declarations can feed one",
      ],
      "tests/unit/db/sql-grammar/compose.test.ts": [
        "the redaction is the record's row, a command reader bound through the function table, never the entry's",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it",
      ],
    },
  },
  "M-55": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a statement read on an engine not exposed to MCP is refused as statement-read-unexposed",
        "an agent credential required of an engine whose seeds take none is refused as agent-credential-form-missing",
        "a seed agent credential whose form is not the one the agent credential form request names is refused as agent-credential-seed-form-differs, a request of none excepted",
        "read roots required of an engine whose seeds cannot declare them are refused as read-roots-field-undeclared",
        "a denied file access refusal on an engine that reads no file-access posture is refused as denied-file-access-unread",
        "an engine declaration's claims are held to the rules the schema cannot state, at pointers into it",
        "a policy and an MCP segment at every claim's restrictive value are admitted",
      ],
      "tests/unit/db/claim-grants.test.ts": [
        "an engine read as requiring an agent credential its seeds take none of is closed to MCP",
        "an engine read as requiring an agent credential whose granted credential is null, or whose granted form is none, is closed to MCP",
      ],
    },
  },
  "M-56": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.readsTrustMaterial is the engine's READS_TRUST_MATERIAL row",
      ],
      "tests/security/provider-trust-material.test.ts": [
        "READS_TRUST_MATERIAL names db2 alone, the engine whose TLS the probe found outside Node's trust store",
        "a caller's trust in the execution context never reaches a provider",
      ],
    },
    schema: ["/$defs/connection/properties/readsTrustMaterial"],
  },
  "M-58": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an agent credential form outside the claim's values is refused as value-not-allowed, and null as wrong-type beside it",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every claim of the policy and MCP segments is the row of Studio's review record of it",
        "the generated unions are Studio's own types",
      ],
      "tests/unit/db/agent-credential-capability.test.ts": [
        "%s: AGENT_CREDENTIAL_FORM is the form its provider declares, null where it declares none",
      ],
    },
    schema: ["/$defs/agentCredentialFormClaim"],
  },
  "M-59": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a masking exemption or inline edit refusal whose pattern or reason is empty or past its bound is refused as out-of-range",
        "a masking exemption whose column pattern does not match whole names only is refused as masking-exemption-unanchored",
        "a masking exemption or inline edit refusal pattern that does not compile is refused as pattern-invalid",
      ],
      "tests/unit/db/masking-exemption-guard.test.ts": ["an unanchored pattern reaches into a rule it was never about"],
    },
    schema: ["/$defs/maskingExemption"],
  },
  "M-60": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "every fact of the safeguards segment is its provider's own declaration",
        "each declaration's safeguards segment holds exactly the facts the census reads back to the providers",
        "a declared write reach that misses a path is refused by name by the census, and the generator writes the authored safeguards whatever the provider declares",
      ],
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "the machine redaction, billed compute and the write paths are no claims, each refused as unknown-key where it is not a member",
        "an engine declaration's safeguards and its new claims are held to their rules, at pointers into it",
      ],
    },
    schema: ["/$defs/safeguards"],
  },
  "M-61": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a write path that is not one of the three reaches, or whose gate or proof is not a .ts module under src with an export name, is refused as no-variant at the path",
        "a write reach claim that is not the summary of the engine's write paths is refused as write-reach-summary-differs",
        "an absent editor write path that names no proof is refused as editor-write-path-unproven",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "the validator admits a write reach claim exactly where it is Studio's summary of the write paths",
      ],
      "tests/unit/db/write-reach-proofs.test.ts": ["every write-reach gate and proof names a real export"],
    },
    schema: ["/$defs/writePaths", "/$defs/writePathProof"],
  },
  "M-62": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a metadata-only answer with no operation or an operation with no column is refused as too-few, and a kind outside name, count and flag as value-not-allowed",
        "a metadata operation or column name outside its pattern is refused as pattern-mismatch",
        "a metadata operation named twice is refused as metadata-operation-duplicate, at the later one",
        "a column named twice in one metadata operation is refused as metadata-column-duplicate, and the same column in two operations is admitted",
        "a masking exemption or inline edit refusal pattern that does not compile is refused as pattern-invalid",
      ],
    },
    schema: ["/$defs/metadataOnlyOperation", "/$defs/inlineEditRefusal"],
  },
  "M-64": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a maintenance spec whose label, title or description is empty or past its bound is refused as out-of-range",
        "a maintenance spec for an operation the maintenance facet does not list is refused as maintenance-spec-unlisted",
        "a maintenance operation given two specs is refused as maintenance-spec-duplicate, at the later one",
        "a listed maintenance operation with no spec is refused as maintenance-spec-missing, at the operation",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "facets.maintenanceSpecs is its provider's own maintenance specs, one for each operation its facet lists, in the facet's order",
        "maintenanceControl and declaredEntityOperations answer from each declaration what they answer from its provider, for every operation, placement and kind",
        "each declaration's maintenance specs hold exactly Studio's spec members and the operation they name",
        "a provider's maintenance spec missing for a listed operation, or given for an unlisted one, is refused by name, by the generator and by the census",
      ],
      "tests/api/db/maintenance.test.ts": ["non-admin user returns 403"],
      "tests/components/admin/OperationsTab.test.tsx": [
        "confirming sends exactly one request for the whole database",
        "kill button opens confirmation dialog",
      ],
    },
    schema: ["/$defs/maintenanceSpec", "/$defs/facets/properties/maintenanceSpecs"],
  },
  "M-65": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a maintenance spec that places its operation nowhere is refused as maintenance-spec-unplaced, and kill's is admitted",
        "a typed confirmation is admitted only on a spec placed over the whole database alone, with a title and a description, and refused elsewhere as maintenance-typed-confirmation-unasked",
        "a typed target is admitted only on a spec placed on a row alone, and refused elsewhere as maintenance-typed-target-unasked",
        "a maintenance preview no per-row control shows is refused as maintenance-preview-unplaced",
        "an engine declaration's maintenance specs are held to their rules, at pointers into it",
      ],
      "tests/api/db/maintenance.test.ts": [
        "an operation that takes no target refuses a request that names one",
        "an operation that requires a target refuses a request without one",
        "kill keeps its session-id target, which neither placement describes",
      ],
      "tests/components/admin/OperationsTab.test.tsx": [
        "a typed-target control sends nothing until the row's own name is typed exactly, then sends once",
        "a whole-database card with a typed confirmation still asks for the connection's name, not a row's",
      ],
    },
  },
  "M-67": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an agent overlay member Studio's declaration has no place for is refused as unknown-key",
        "an engine that speaks a statement language with no agent overlay is refused as agent-overlay-missing",
        "an agent overlay on an engine that speaks no statement language is refused as agent-overlay-unspoken",
        "an SQL engine with no dialect is refused as agent-dialect-missing",
        "a dialect on an engine of another family is refused as agent-dialect-unspoken",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "the server registry holds each engine module's overlay, member by member",
        "every data member of each declared dialect is what the server registry's dialect holds, null where it is unsupported",
        "every engine's server facet, through runServerPack, is its family's with exactly the derivations its declaration names",
        "each engine's family and client dialect, through the client registry, are its declared language and the client view of its declared dialect",
        "the SQL catalog and composer requirements and the composed capture hold on exactly the engines whose declared dialect supplies them",
        "each declaration's agent overlay holds exactly the members of the schema's overlay and SQL dialect",
        "an agent overlay member the declaration has no place for, a grounding given as a value, and a pattern flag it does not take are refused by name by the generator",
        "agent mode opens a workflow on exactly the engines the declarations' statement languages and readings and Studio's agent execution record give it",
      ],
    },
    schema: ["/$defs/agentOverlay", "/$defs/agent/properties/overlay"],
  },
  "M-68": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an estimating plan that is neither an EXPLAIN prefix nor the session mode is refused as no-variant",
        "a statistics reading without a catalog read is refused as statistics-without-catalog-read",
        "a catalog capture without a catalog read is refused as catalog-capture-without-catalog-read",
        "a kind word given twice is refused as capture-kind-word-duplicate, at the later one",
        "an estimating prefix that executes the plan is refused as plan-estimate-prefix-executes",
        "a profile type pattern that does not compile is refused as pattern-invalid",
        "an engine declaration's agent overlay is held to its rules, at pointers into it",
      ],
      "tests/unit/lib/agent/engine-overlays.test.ts": [
        "an engine that reads statistics also reads its catalog, since the statistics read is a catalog kind",
        "an engine that captures its catalog also composes every kind it captures",
      ],
    },
    schema: ["/$defs/sqlDialect", "/$defs/catalogRead", "/$defs/planEstimatePrefix", "/$defs/captureKindWord"],
  },
  "M-69": {
    tests: {
      "tests/unit/db/operations/statement-guard.test.ts": [
        "only the plan-execution schema admits EXPLAIN ANALYZE",
        "the query read admits the statement the server composed, though its verb is no read",
        "the same text with no admission is refused as it always was",
        "an admission a caller wrote itself is refused, as any text a model sends would be",
        "only the query read takes an admission: plan inspection and the profile keep the strict read input",
        "only the catalog read mints an admission, for the catalog statement itself or for its statistics kind",
      ],
      "tests/unit/lib/agent/composed-catalog-admission-drive.test.ts": [
        "the identical command written by the model is refused before it is sent, as it always was",
      ],
      "tests/unit/lib/agent/elasticsearch-catalog-read.test.ts": [
        "each composed command is admitted by identity, and refused as model text",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "every claim of the connection, facets, agent and SQL text segments is the row of Studio's review record of it",
      ],
    },
  },
  "M-73": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "TLS modes in the provider contract's order, %s, are admitted",
        "a TLS mode outside the provider contract's modes is refused as value-not-allowed at its own pointer",
        "a TLS mode listed twice is refused as duplicate at the second",
        "a TLS mode listed after one the provider contract orders after it is refused as tls-mode-order, at each such mode",
        "a TLS mode out of order is refused in one sentence naming its pointer and no mode",
        "a TLS offer stated as the word %s is refused as wrong-type",
        "a TLS offer with no modes member is refused as missing-key, and one with another member as unknown-key",
      ],
      "tests/unit/provider-sdk/call-surface-parity.test.ts": [
        "the manifest's TLS modes are Studio's published SSL modes, in its order",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "connection.tls lists TLS modes exactly where the dialog offers the SSL panel",
      ],
      "tests/unit/lib/db/connection-form.test.ts": [
        "a composed form offers the SSL / TLS panel exactly where its engine lists any TLS mode, one or several",
      ],
      "tests/unit/lib/db/provider-field-census.test.ts": [
        "every engine that lists TLS modes lists each of the provider contract's modes, in its order, and an engine lists none exactly where the dialog offers no SSL / TLS panel",
      ],
      "tests/unit/db/engine-projections-removal.test.ts": [
        "the connection forms built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module",
      ],
    },
    schema: ["/$defs/tlsMode", "/$defs/tlsOffer"],
  },
  "M-76": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an agent reading whose monitoring panel the engine does not offer is refused as agent-reading-panel-not-offered",
        "the health reading and a reading whose panel the engine offers are admitted",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "each declaration is admitted by the schema's engine declaration and its rules",
      ],
      "tests/unit/db/engine-facets/census.test.ts": [
        "every agent reading is the kind of a panel the row offers, or health",
      ],
    },
    schema: ["/$defs/agentReading"],
  },
  "V-1": {
    tests: {
      "packages/provider-sdk/tests/values/tags.test.ts": [
        "the codec writes and reads exactly the schema's value tags",
        "a tag the schema does not name is refused on decode",
      ],
    },
    schema: ["/$defs/valueTag"],
  },
  "V-2": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "every bigint from -2^63 to 2^64 - 1 round-trips as its decimal digits",
        "every Uint8Array and Buffer round-trips as canonical base64, byte for byte",
        "every valid Date round-trips as its toISOString text, the range ends included",
        "NaN, Infinity and -Infinity round-trip as their words",
        "a JSON value with no tagged kind passes through both ways unchanged",
      ],
    },
  },
  "V-3": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "an object whose keys are exactly $ and v round-trips at any depth and is never read as a tag",
        "an object with $ alone or with a third key is not wrapped",
        "a __proto__ key stays an own key",
      ],
    },
  },
  "V-4": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "every value outside the codec's domain is refused by kind, naming its JSON Pointer and never its value",
        "a bigint outside the 64-bit range is refused, naming its path",
        "an invalid Date is refused on encode",
        "a ValueCodecError is an Error with its own name",
      ],
    },
  },
  "V-5": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "digits with a plus sign, a leading zero, an exponent, spaces or -0 are refused on decode",
        "base64 that is malformed, unpadded, URL-safe or non-canonical is refused on decode",
        "a timestamp that is not exactly toISOString's text is refused on decode",
        "an obj payload whose keys are not exactly $ and v is refused on decode",
        "an unknown tag or a payload of the wrong type is refused on decode, naming its path",
        "decode refuses a value JSON cannot produce",
      ],
    },
  },
  "V-8": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "a value inside MAX_VALUE_DEPTH arrays and objects round-trips, and one level more is refused on encode and decode, naming its path",
        "a tagged value adds no level, so the bound counts the value's own arrays and objects",
      ],
      "packages/provider-sdk/tests/values/codec-depth.test.ts": [
        "a value nested far past any stack is refused by the depth rule in a bounded Node child, never a RangeError",
      ],
    },
  },
  "V-9": {
    tests: {
      "packages/provider-sdk/tests/values/codec.test.ts": [
        "an object member whose value is undefined is left out, and undefined anywhere else is refused",
        "the obj escape is decided on the members written",
      ],
    },
  },
  "E-1": {
    tests: {
      "packages/provider-sdk/tests/errors/kinds.test.ts": [
        "the kinds a provider raises and the kinds only core raises partition the record's kinds",
      ],
      "tests/unit/db/provider-error-kinds.test.ts": [
        "every error class Studio declares has a kind the contract places",
        "provider code constructs and extends only classes of the kinds a provider may raise",
        "provider code charges the read allowance only where the record names, so its refusal is the one core kind a provider passes on",
      ],
      "tests/unit/lib/db/error-record.test.ts": [
        "every class errors.ts exports has exactly one kind, and no two share one",
      ],
    },
  },
  "E-2": {
    tests: {
      "tests/unit/lib/db/error-record.test.ts": [
        "a TransportError answers connection, whatever its own kind field says",
        "a value that is no error class answers internal",
      ],
    },
  },
  "E-3": {
    tests: {
      "tests/unit/lib/db/error-record.test.ts": [
        "a missing or unknown kind or code is refused, naming the field",
        "a malformed sqlState or engineCode is refused, naming the field and not the value",
        "an unknown outcome or session state is refused",
        "an extra key is refused",
        "every generated record over the whole shape crosses JSON and the reader unchanged",
      ],
    },
  },
  "E-4": { tests: { "tests/unit/lib/db/error-record.test.ts": ["no record holds any text the error carries"] } },
  "E-5": {
    tests: {
      "tests/unit/db/provider-error-kinds.test.ts": ["provider code never writes an error's outcome"],
      "tests/unit/lib/db/error-record.test.ts": [
        "a refusal before send answers not-sent wherever it is raised",
        "every other class answers unknown",
        "Studio's refusal of an offset it did not see applied answers not-sent wherever it is raised",
      ],
      "tests/unit/db/errors.test.ts": [
        "is an OffsetUnsupportedError only Studio raises, outcome not-sent",
        "a failure the connect raises keeps its identity and answers not-sent",
        "a connect deadline becomes a ConnectionError that answers not-sent",
        "a failure the checkout raises is thrown as its mapped class and answers not-sent",
        "a checkout deadline becomes a ConnectionError naming the wait that answers not-sent, the deadline kept as its cause",
        "a TransactionLostError raised before anything was sent answers not-sent, and one raised without beforeSend answers unknown",
      ],
      "tests/integration/db/postgres-provider.test.ts": [
        "a pool checkout that fails answers its mapped class with outcome not-sent and sends nothing",
        "a begin whose pool checkout fails answers its mapped class with outcome not-sent, sends nothing and holds no transaction",
        "%s on a held transaction whose session already ended answers TRANSACTION_LOST with outcome not-sent and sends nothing",
      ],
      "tests/integration/db/mysql-provider.test.ts": [
        "a pool checkout that fails answers its mapped class with outcome not-sent, not an internal error",
        "a begin whose pool checkout fails answers its mapped class with outcome not-sent, not an internal error",
      ],
      "tests/integration/db/oracle-provider.test.ts": [
        "a pool checkout that fails answers its mapped class with outcome not-sent and sends nothing",
        "a begin whose pool checkout fails answers its mapped class with outcome not-sent and holds no transaction",
      ],
      "tests/unit/lib/provider-host/host-rules.test.ts": ["a checkout failure inside execute answers not-sent"],
      "tests/unit/lib/provider-host/access.test.ts": [
        "a call the caller left is answered as QueryCancelledError, not-sent before the call and unknown after it",
        "a call past its deadline is answered as StudioTimeoutRefusal, not-sent before the call and unknown after it",
      ],
    },
  },
  "E-7": {
    tests: {
      "tests/unit/db/driver-row-kinds.test.ts": [
        "each answer a driver row gives maps to one error kind, keeping the driver's SQLSTATE",
      ],
      "tests/unit/db/driver-errors.test.ts": [
        "answers every corpus input exactly as the shared mapping answered it before the move",
      ],
    },
  },
  "E-8": {
    tests: {
      "tests/unit/lib/api/retryable-readers.test.ts": [
        "every read of an answer's retryable is a recorded copy, so nothing resends on it",
      ],
    },
  },
  "S-1": {
    tests: {
      "packages/provider-sdk/tests/sql/grammar.test.ts": [
        "DEFAULT_SQL_GRAMMAR is the compatibility reading",
        "DEFAULT_SQL_GRAMMAR is frozen to its leaves, so no importer changes it for another",
      ],
      "tests/unit/sql/grammar.test.ts": [
        "the module that resolves a grammar by engine id exports only its two readers",
      ],
      "tests/unit/db/sql-grammar/shared.test.ts": ["the shared blocks are NO_EXTRA_WORDS and REDACTED_VALUE"],
    },
  },
  "S-3": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a SQL text segment with every grammar fact stated, a command redaction and both completion readers is admitted",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlText.readsSqlText is the engine's SQL_GRAMMAR row's",
        "sqlText.grammar is the row's grammar, each fact the row leaves out at its reading when left out and each trailing limit clause by its source and flags",
        "every member of a grammar row has its member in the declaration",
      ],
    },
    schema: ["/$defs/sqlText", "/$defs/grammarFacts"],
  },
  "S-4": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlText.grammar is the row's grammar, each fact the row leaves out at its reading when left out and each trailing limit clause by its source and flags",
        "a grammar read from the declaration reads every statement of the census corpus as the row's grammar does",
      ],
      "tests/components/QuerySafetyDialog.test.tsx": ["absent: a RESET and a listed key ask nothing"],
      "tests/unit/sql/spans.test.ts": [
        "absent, with backslashAlwaysEscapes true: the backslash escapes the quote and the run does not close",
      ],
    },
    schema: ["/$defs/grammarFacts/properties/confirmConfigKeys"],
  },
  "S-5": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a trailing limit clause longer than 512 characters is refused as out-of-range",
        "a trailing limit clause whose flags are not i or iu is refused as value-not-allowed",
        "a trailing limit clause that does not compile is refused as pattern-invalid",
        "an engine declaration's trailing limit clauses are held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/sql/spark-grammar.test.ts": [
        "a trailing OFFSET follows the row bound, and LIMIT before OFFSET reads as bounded",
      ],
    },
    schema: ["/$defs/clausePattern"],
  },
  "S-7": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a redaction of no listed kind, a name quote outside the vocabulary and a reader that is not a function name are each one refusal at the redaction",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlText.redaction is the row's redaction, a command reader named by its slot",
        "every function a grammar row holds is, through the census's own resolver, the very slot its declaration names",
      ],
      "tests/unit/lib/query-events/redact.test.ts": [
        "the vectors hold every literal form for postgres, mysql, mssql and oracle, and MongoDB and Redis commands",
      ],
      "tests/unit/lib/query-events/build.test.ts": [
        "an event of a package engine keeps no statement and no error text in any capture mode, and reads its statement as OTHER",
      ],
    },
    schema: ["/$defs/statementRedaction", "/$defs/nameQuote"],
  },
  "S-8": {
    tests: {
      "tests/unit/sql/confirmation-claim-review-gate.test.ts": [
        "mongodb and redis text is not read as SQL",
        "snowflake's session forms stay exempt",
      ],
      "tests/unit/lib/db/confirmation-claim-review.test.ts": [
        "lists every exempt form a shipped grammar row declares, and no other",
        "lists every text-not-sql claim a shipped grammar row makes, and no other",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "the confirmation gate's claims each declaration makes are the entries Studio's review record lists for its engine",
      ],
      "tests/unit/db/engine-declaration-readers.test.ts": [
        "the confirmation gate's claims are authored only in the SQL text, read only by its projection, its module, the SQL grammar and the server catalog's composition, and counted by the gate only through CONFIRMATION_CLAIM_REVIEW",
      ],
      "tests/unit/lib/api/run-confirmation.test.ts": [
        "a package run is classified under its declared grammar: a read runs, a write asks, a production connection asks its name",
        "a package's loosening claims are not counted: text-not-SQL and an exempt form still ask",
        "a package's explain claim is read both ways: an analyzed write and a planned write each ask, whatever it declares",
      ],
      "tests/api/db/query-package-engine.test.ts": [
        "the statement is read under the package's declared grammar, and a write asks for a confirmation",
      ],
    },
  },
  "S-9": {
    tests: {
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlText.updateTarget is the row's, each word set in its order",
        "sqlText.completion names a segment formatter and a quoted qualifier reader exactly where the row has one",
        "every function a grammar row holds is named by its engine's declaration",
      ],
    },
    schema: ["/$defs/updateTargetWords", "/$defs/completionReaders"],
  },
  "S-11": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an SQL writing segment with every hook named, a create table key, a bare spelling and every key float64 is admitted",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlWriting.inlineEdit is the row's, each type name set in its order and float64 as all where every key is",
        "sqlWriting.export states the row's DDL types, standing-alone names, bare spellings, non-finite literals and insert form",
        "every member of an SQL writing row has its member in the declaration",
      ],
    },
    schema: ["/$defs/sqlWriting", "/$defs/inlineEditFacts", "/$defs/exportFacts"],
  },
  "S-12": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an inline edit type name that is not one lower-case word is refused as pattern-mismatch",
        "a declared type name that is not lower-case words separated by single spaces is refused as pattern-mismatch",
        "float64 type names that are neither a list nor all are one refusal at the member",
        "a type name under two families, or a bare spelling named twice, is refused as type-name-duplicate at the later",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlWriting.inlineEdit is the row's, each type name set in its order and float64 as all where every key is",
        "sqlWriting.export states the row's DDL types, standing-alone names, bare spellings, non-finite literals and insert form",
      ],
      "tests/unit/db/sql-writing/golden.test.ts": ["SQL writing golden output"],
      "tests/unit/db/sql-writing/compose.test.ts": [
        "each row is its declaration's SQL writing composed with Studio's SQL writing function table",
      ],
    },
    schema: ["/$defs/keyTypeName", "/$defs/declaredTypeName", "/$defs/float64TypeNames"],
  },
  "S-13": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a DDL type, a bare spelling or a non-finite literal that would not stay on its line is refused as pattern-mismatch",
        "a DDL type or a bare spelling that is more than one type at the top level is refused as pattern-mismatch",
        "a create table key note that is not whole comment lines is refused as pattern-mismatch",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlWriting.export.createTableKey carries the row's note where the row has a key",
      ],
    },
    schema: ["/$defs/sqlTypeSpelling", "/$defs/nonFiniteLiteral", "/$defs/commentLines"],
  },
  "S-14": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a type pattern longer than 512 characters is refused as out-of-range, and one not written with ^ and $ as pattern-mismatch",
        "a type pattern whose flags are not none, i, u or iu is refused as value-not-allowed",
        "a type pattern that does not compile is refused as pattern-invalid",
        "a wrapper pattern that does not capture exactly one group is refused as wrapper-group-count",
        "a wrapper pattern that backtracks without end on the empty string is still counted at once",
        "an engine declaration's SQL writing facts are held to the rules the schema cannot state, at pointers into it",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlWriting.export.typeVocabulary is the row's, its bare type families grouped by kind and each pattern by its source and flags",
      ],
      "tests/unit/db/sql-writing/golden.test.ts": ["SQL writing golden output"],
      "tests/unit/db/sql-writing/compose.test.ts": [
        "each row is its declaration's SQL writing composed with Studio's SQL writing function table",
      ],
    },
    schema: ["/$defs/typeVocabulary", "/$defs/typePattern", "/$defs/typeFamilies"],
  },
  "S-15": {
    tests: {
      "tests/unit/lib/export/numeric-wrapper-bounds.test.ts": [
        "a wrapper whose capture is not shorter than the type ends the unwrapping, so the export reads the type as it is",
        "a wrapper whose group is absent ends the unwrapping",
      ],
    },
  },
  "S-17": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a migration DDL segment that refuses table DDL, one that writes it with a transaction wrapper, and one whose CREATE TABLE is refused are admitted",
        "a migration DDL member of the other form, a missing one or an unknown one is one no-variant refusal at the segment",
        "a create table of no listed kind, or with a member of the other kind, is one no-variant refusal at the segment",
        "an engine declaration's migration DDL is refused at its own pointer under validateEngine",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "migrationDdl states the row's table DDL, its refusal line, its transaction wrapper and its reasons in order",
        "migrationDdl.createTable states the row's create table form",
        "every member of a migration DDL row has its member in the declaration",
      ],
      "tests/unit/db/migration-ddl/compose.test.ts": [
        "each row is its declaration's migration DDL composed with Studio's migration DDL function table",
        "a refused declaration composes to its refusal line, no wrapper and its reasons, naming no function",
      ],
      "tests/unit/db/migration-ddl/golden.test.ts": ["migration DDL golden files"],
    },
    schema: ["/$defs/migrationDdl", "/$defs/migrationDdlRefused", "/$defs/migrationDdlWritten", "/$defs/createTable"],
  },
  "S-18": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a migration DDL refusal that is not one comment line is one no-variant refusal at the segment",
        "a migration DDL reason that is not one line, or is listed twice, is one no-variant refusal at the segment",
        "a transaction wrapper statement that is not words ending in one semicolon is one no-variant refusal at the segment",
      ],
      "tests/unit/db/migration-ddl/golden.test.ts": ["migration DDL golden files"],
    },
    schema: ["/$defs/migrationRefusal", "/$defs/wrapperStatement", "/$defs/transactionWrapper", "/$defs/ddlReason"],
  },
  "S-20": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an SQL generator segment naming every form, one naming only its quoting, and a null one are admitted",
        "an SQL generator form named in another form is refused at the form",
        "an engine declaration's SQL generators are refused at their own pointer under validateEngine",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "sqlGenerators is null exactly where the engine has no SQL_ENGINE_GENERATORS row, and states the row's count expression, COUNT(*) where it has none",
        "every name an SQL generator declaration states is its member's slot, and Studio's SQL generator function table binds it there to the function the engine's row runs",
        "every function an SQL generator row holds is named at its slot by its engine's declaration, and no slot the row leaves empty is named",
        "every member of an SQL generator row has its member in the declaration",
      ],
      "tests/unit/lib/query-generators-compose.test.ts": [
        "each SQL engine's generator row is its declaration's forms composed with Studio's SQL generator function table",
        "an engine whose declaration states no generator forms has no row",
      ],
      "tests/isolated/query-generator-parity.test.ts": [
        "every declaration answers exactly what the committed digests record",
      ],
    },
    schema: ["/$defs/sqlGenerators"],
  },
  "S-21": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a count expression that is not one aggregate call over every row is refused as pattern-mismatch, and one longer than 64 characters as out-of-range",
      ],
      "tests/isolated/query-generator-parity.test.ts": [
        "every declaration answers exactly what the committed digests record",
      ],
    },
    schema: ["/$defs/countExpression"],
  },
  "S-23": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "an editor language with Studio's query language, Monaco language and accent is admitted, and a console language too",
        "a query language or a Monaco language outside Studio's is refused as value-not-allowed",
        "an accent that is not one border hue class of Studio's palette, or is a status hue, is refused as pattern-mismatch",
        "an editor language that states a tab type or a console dialect id is refused as unknown-key",
        "an engine declaration's editor language is refused at its own pointer under validateEngine",
      ],
      "tests/unit/db/engine-declarations.test.ts": [
        "editor.language.queryLanguage is the query language the engine's unconnected provider declares",
        "a dialect-less engine's tabs take its query language's tab type, and a dialect engine's its dialect's name",
        "editor.language.monacoId is the Monaco language Studio's editor renders the engine's tabs in",
        "editor.language.accent and console are the EDITOR_LANGUAGES row's, a console registered under its own Monaco id",
        "EDITOR_LANGUAGES and DIALECT_EDITORS are the editor language facts the declarations state, one per language and one per tab type",
        "every member of an editor language row and of a tab type's editor row has its member in the declaration, or stays browser code",
        "the query languages and the editor languages are Studio's",
      ],
      "tests/unit/editor/editor-language-registry.test.ts": [
        "each language takes an accent of its own, and none is a status hue",
      ],
    },
    schema: ["/$defs/editorLanguageFacts", "/$defs/queryLanguage", "/$defs/monacoLanguageId", "/$defs/editorAccent"],
  },
  "C-1": {
    tests: {
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "a provider whose implementation matches its declared calls is defined, and its record is frozen",
        "the manifest in the record is a deep-frozen copy, and the package's own object is left as it was",
        "a value that is not a provider module record is refused as module-not-a-record",
        "a manifest or record built against another contract is refused as contract-not-served",
        "no refusal and no message carries a value of the manifest or the implementation",
        "an accessor the check would read is refused as property-not-data, and its getter is never called",
        "an honours list longer than the request fields is refused as manifest-unreadable at the list, and no item is read",
        "an engine list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no engine is read",
        "a maintenance or agent readings list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read",
        "a maintenance specs list longer than the schema's maxItems is refused as manifest-unreadable at the list, and no item is read",
      ],
      "packages/provider-sdk/tests/calls/honours-bounds.test.ts": [
        "a manifest honours list of the longest length is refused at the list, in a bounded child",
      ],
      "packages/provider-sdk/tests/calls/list-bounds.test.ts": [
        "an engine list of the longest length is refused at the list, in a bounded child",
        "a maintenance list of the longest length is refused at the list, in a bounded child",
        "a maintenance specs list of the longest length is refused at the list, in a bounded child",
        "an agent readings list of the longest length is refused at the list, in a bounded child",
      ],
      "packages/provider-sdk/tests/manifest/schema.test.ts": [
        "the engine list is bounded at 64, and each facet list by the size of its vocabulary",
      ],
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a list longer than its maxItems is refused as too-many",
      ],
    },
    schema: [
      "/properties/engines/maxItems",
      "/$defs/facets/properties/maintenance/maxItems",
      "/$defs/facets/properties/maintenanceSpecs/maxItems",
      "/$defs/facets/properties/agentReadings/maxItems",
    ],
  },
  "C-3": {
    tests: {
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "a mandatory call that is missing or no function is refused as call-missing",
        "a calls segment of the implementation that is not a record is refused as impl-segment-not-a-record, and nothing under it is read",
        "an implementation key the contract does not define is refused as impl-key-unknown",
      ],
    },
  },
  "C-4": {
    tests: {
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "an offered facet the implementation lacks is refused as facet-unimplemented",
        "an implemented facet the manifest does not offer is refused as facet-undeclared",
        "the transaction facet is declared and implemented both ways, like every console facet",
        "the objects tree facet is declared and implemented both ways, like every console facet",
        "the maintenance facets are declared and implemented both ways, like every console facet",
        "an engine's maintenance is admitted where the package offers maintenance.run, and refused by name as engine-facet-call-not-offered where it does not",
        "a maintenance spec that previews is admitted where the package offers maintenance.preview, and refused by name where it does not",
        "the monitoring facets are declared and implemented both ways, like every console facet",
        "an engine's offered monitoring panel is admitted where the package offers monitoring.panel, and refused by name as engine-facet-call-not-offered where it does not",
        "an agent reading is admitted where the call that serves it is offered: a panel reading where the package offers monitoring.panel, and health on every package",
        "a panel reading is refused by name as engine-facet-call-not-offered, naming monitoring.panel, where the package does not offer it",
        "no definition check answers engine-facet-without-call, which left the vocabulary with the agent readings' calls",
      ],
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": [
        "the console facets and execute's request fields are the schema's",
        "the objects facets are the schema's",
        "the maintenance facets are the schema's",
        "the monitoring facets are the schema's",
        "each agent reading names the monitoring panel that serves it, or none for health",
      ],
    },
    schema: ["/$defs/consoleCalls", "/$defs/objectsCalls", "/$defs/maintenanceCalls", "/$defs/monitoringCalls"],
  },
  "C-5": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a request field execute does not know, or one listed twice, is refused",
        "a manifest without its calls is refused as missing-key",
      ],
    },
    schema: ["/$defs/executeCall/properties/honours", "/$defs/executeRequestField"],
  },
  "C-6": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a proxy variable declared in runtime.env is refused as env-proxy-variable",
        "a lower-case proxy variable is refused by the name pattern",
      ],
      "tests/unit/provider-source-coupling-lint.test.ts": [
        "process.env is refused in provider source, in each form a provider reads it today",
      ],
    },
  },
  "C-9": {
    tests: {
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "a request field the session does not honour is refused before the call",
        "a session that honours every field and offers endScope takes each",
        "a request on a refined session is held to the narrowed calls",
        "a statement sent inside a transaction to a session without console.transaction is refused before the call",
        "a statement sent inside a transaction never carries a scope",
        "a session that offers console.transaction takes a statement inside its transaction with its params and offset",
        "a CallRefusalError carries every refusal and words each",
      ],
    },
  },
  "C-10": {
    tests: {
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones",
        "a refinement that widens a declared value is refused as refinement-widens",
        "a refinement may withdraw console.transaction, and never offer it where the manifest does not",
        "a refinement may withdraw objects.tree, and never offer it where the manifest does not",
        "a refinement may withdraw maintenance.run and maintenance.preview, and never offer one the manifest does not",
        "a refinement may withdraw monitoring.panel and monitoring.poolStats, and never offer one the manifest does not",
        "an honours list longer than the declared one is refused as refinement-widens at the list, and no item is read",
        "a key a refinement cannot have is refused as refinement-key-unknown",
        "a calls segment the contract does not define is refused by name, and never read as the objects segment",
        "a refinement value of the wrong type, an accessor or a repeated field is refused as refinement-unreadable",
        "no refinement refusal carries a value of the refinement",
      ],
      "packages/provider-sdk/tests/calls/honours-bounds.test.ts": [
        "a refinement honours list of the longest length is refused at the list, in a bounded child",
      ],
    },
  },
  "C-11": {
    tests: {
      "packages/provider-sdk/tests/calls/freeze.test.ts": [
        "a context is frozen at every depth, and a write to any of it throws",
        "the signal and the environment reader are left as the host passed them, and the signal still aborts",
        "a request is frozen at every depth, except its typed arrays and dates",
        "a value that holds itself is frozen once",
        "an object outside the value codec's domain is refused by its pointer",
        "an accessor property is refused by its pointer, its getter never runs, and nothing is frozen",
        "a symbol-keyed property is refused by the pointer of the object that holds it, and nothing is frozen",
        "an invalid Date is refused by its pointer, as the value codec refuses it, and nothing is frozen",
      ],
    },
  },
  "C-12": {
    tests: {
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "every call gets a fresh context and request, frozen at every depth",
        "a cancel of a run the provider does not know answers not cancelled",
      ],
    },
  },
  "C-13": {
    tests: {
      "packages/provider-sdk/tests/calls/results.test.ts": [
        "the batch and page budgets are one MiB and 32 MiB",
        "a row's size is the UTF-8 length of its encoded JSON text",
      ],
    },
  },
  "C-14": {
    tests: {
      "packages/provider-sdk/tests/calls/results.test.ts": [
        "a batch held to batch.maxBytes",
        "a row larger than the batch budget comes alone, and is refused only when no page can hold it",
      ],
    },
  },
  "C-15": {
    tests: {
      "packages/provider-sdk/tests/calls/results.test.ts": [
        "a page cut by size at page.maxBytes",
        "a page ends at its row limit or when the source is done",
        "a batch a source should not have answered is refused by name, and the source is closed once",
        "a failure to pull or to close is thrown, and neither is lost",
        "the limits a source is asked for are frozen and within the page",
        "each pull hands the source the pump's own measure, and a row the source sized with it is not measured again",
        "a row the source did not size with its pull's measure is measured by the pump",
        "a pull's measure called after its pull answered is refused by name",
        "a pump limit that is not a positive safe integer is refused before any pull",
      ],
      "packages/provider-sdk/tests/calls/pump-bounds.test.ts": [
        "a source that never progresses is refused after one pull, in a bounded child",
        "a source that never ends is cut at the page's byte budget, in a bounded child",
      ],
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "the first result is pumped within the limits set from the answer, and every other result is closed once",
      ],
    },
  },
  "C-16": {
    tests: {
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "the first result is pumped within the limits set from the answer, and every other result is closed once",
      ],
      "packages/provider-sdk/tests/calls/results.test.ts": [
        "each pull hands the source the pump's own measure, and a row the source sized with it is not measured again",
      ],
      "tests/unit/lib/provider-host/legacy-bridge.test.ts": [
        "the bridge sizes every row it answers with the pull's measure, and answers that same array",
        "a cell outside the value codec is measured in its JSON form and answered unchanged",
        "the page's row limit is the probe limit for a bound Studio wrote, and every returned row otherwise",
      ],
    },
  },
  "C-17": {
    tests: {
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "a console facet the session does not offer is refused before the call",
        "a console facet the session offers is called",
        "the transaction facet is refused by name to a session that does not offer it",
        "the objects tree facet is refused by name to a session that does not offer it",
        "a session that offers objects.tree is called",
        "the maintenance facets are refused by name to a session that does not offer them",
        "a session that offers maintenance.run and maintenance.preview is called",
        "a maintenance run is held to the operations and placements the session's maintenance offers, kill placed nowhere",
        "a maintenance preview is held to an operation whose spec previews on a row",
        "a maintenance request with empty text where it names something is refused by the field",
        "no maintenance request refusal carries a value of the request",
        "the monitoring facets are refused by name to a session that does not offer them",
        "a session that offers monitoring.panel and monitoring.poolStats is called",
        "a monitoring panel request is held to the panels the session's engine offers",
        "no monitoring request refusal carries a value of the request",
        "every call refusal rule is worded in one sentence",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served maintenance call whose request the session's maintenance does not take is refused before any frame",
        "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame",
      ],
    },
  },
  "C-18": {
    tests: {
      "packages/provider-sdk/tests/manifest/digest.test.ts": ["the package root does not export the testing surface"],
      "tests/unit/package-imports.test.ts": [
        "Studio's runtime source never imports the SDK's testing entry",
        "a planted runtime file that imports the testing entry fails by file and specifier",
      ],
    },
  },
  "C-19": {
    tests: {
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served module answers every call through one request frame and one answer frame",
        "the provider receives decoded copies, frozen at every depth, with the host's signal and environment reader by reference",
        "the host's own context and request are left as the host built them, and the host receives decoded copies of each answer",
        "a value the codec cannot carry, or a frame key the call does not define, fails the call before the provider is called",
        "an error a call or a source throws reaches the host as the same object",
        "a served source's provider receives the limit's numbers decoded and frozen with the host's measure by reference, and the frame carries the numbers only",
        "a served transaction call crosses its request and answer as frames, and a statement inside the transaction carries its session state back",
        "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies",
        "a served maintenance call crosses its request and answer as frames, and the provider receives decoded frozen copies",
        "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies",
        "a served health call crosses its context and answer as frames, and the host receives a decoded copy",
        "a value that is not a provider module record is refused with every refusal before anything is served",
        "the served implementation is an implementation of the module's manifest, with the module's facets",
      ],
    },
  },
  "C-20": {
    tests: {
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a well-formed frame of every call and part is admitted",
        "a key a frame's shape does not define is refused as frame-key-unknown at its pointer",
        "a required key a frame lacks is refused as frame-key-missing",
        "a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable",
        "a page bound is exactly one of its two forms",
        "a transaction request is one of its actions, and only begin carries requireReportedState",
        "a tree request is one of its actions, each with its own members",
        "a tree answer is exactly one of its five forms, each read as its closed shape",
        "a maintenance run request and answer are each read as their closed shape",
        "a maintenance preview request and answer are each read as their closed shape",
        "a monitoring panel request is the closed shape of the panel it names",
        "a monitoring panel answer is exactly one of its seven forms, each read as its closed shape",
        "a pool statistics answer and a health answer are each read as their closed shape",
        "a timestamp member admits a Date and nothing else",
        "a connection's keys are the contract's field names and each value a connection field value",
        "no frame refusal and no sentence carries a value of the frame",
        "every frame refusal rule is worded in one sentence",
        "a FrameRefusalError carries every refusal and words each",
      ],
    },
  },
  "C-21": {
    tests: {
      "packages/provider-sdk/tests/testing/round-trip.test.ts": [
        "a value the codec carries is admitted, with -0, a Buffer, a null-prototype object and Date and Uint8Array subclasses compared as the codec defines them",
        "a symbol-keyed property is refused as round-trip-changed at the pointer of the object that holds it",
        "a non-enumerable property is refused as round-trip-changed at its pointer",
        "an accessor is refused as round-trip-changed at its pointer, and the comparison never calls its getter",
        "an array's own property that is not an index is refused as round-trip-changed at the array",
        "a received value that differs from the sent one is refused at the pointer where it differs",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies",
        "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies",
        "a served health call crosses its context and answer as frames, and the host receives a decoded copy",
      ],
    },
  },
  "C-22": {
    tests: {
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "the session handle and each result source stay in the served instance's tables, and only their ids cross",
        "a closed or foreign session token is refused as session-not-open before any frame",
        "a closed result source is refused as result-not-open before any frame",
        "a close takes the session out of both tables even when the provider's close throws",
      ],
    },
  },
  "C-23": {
    tests: {
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a request field or a console facet the session does not offer is refused before any frame",
        "a transaction call or a statement inside a transaction on a session without console.transaction is refused before any frame",
        "a tree call on a session without objects.tree is refused before any frame",
        "a maintenance call on a session without the facet is refused before any frame",
        "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame",
        "a refinement open answers narrows the served session's calls",
        "a served open whose maintenance narrowing names an operation its engine does not list is refused, and the session it opened is closed",
        "a served open is held to the maintenance of the engine its context names, which the module declares",
        "an open answer the host refuses closes its session, and an execute answer the host refuses closes its sources",
        "a close that fails beside a refused answer is thrown with the refusal first",
      ],
    },
  },
  "C-24": {
    tests: {
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served result source pulled by pumpPage answers the provider's rows, one frame a batch",
      ],
      "packages/provider-sdk/tests/testing/serve-bounds.test.ts": [
        "a batch whose rows are a sparse list of the longest length is refused at its first hole, in a bounded child",
        "an execute answer whose results are a sparse list of the longest length is refused at its first hole, in a bounded child",
        "a served source that never ends is cut at the page's byte budget, in a bounded child",
      ],
    },
  },
  "C-26": {
    tests: {
      "packages/provider-sdk/tests/calls/deadline.test.ts": [
        "a call signal aborts at its deadline with a TimeoutError",
        "a call signal aborts with the caller's reason when the caller goes first",
        "a deadline already past answers a signal already aborted",
        "a deadline that is not a finite number is a host defect, refused before any signal is built",
        "a deadline further ahead than a timer can wait is refused before any signal is built",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "the provider's context carries the host's deadline and signal, and its signal aborts at the deadline",
      ],
    },
  },
  "C-27": {
    tests: {
      "packages/provider-sdk/tests/calls/deadline.test.ts": [
        "checkCallStart refuses a call whose deadline passed or whose signal aborted, naming each",
        "a CallRefusalError carries the signal's reason as its cause",
      ],
      "packages/provider-sdk/tests/calls/results.test.ts": [
        "the pump pulls no batch once the call's signal aborted or its deadline passed, and closes the source once",
        "a call signal that aborts during a page stops the pump before its next pull",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a call whose signal aborted or whose deadline passed is refused before any frame, and the provider is never called",
      ],
      "tests/unit/lib/provider-host/host-rules.test.ts": ["no statement starts once the call's signal aborted"],
      "tests/api/db/cancel.test.ts": ["a cancel whose caller already left calls nothing and answers 499"],
    },
  },
  "C-28": {
    tests: {
      "packages/provider-sdk/tests/calls/deadline.test.ts": [
        "the host's wait settles as the answer does when the answer comes first, and leaves no listener on the signal",
        "the host's wait ends at the signal, and the abandoned answer's outcome reaches the late handler once",
        "a signal aborted before the wait ends it at once, and the answer still reaches the late handler",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "an answer the host stopped waiting for reaches its late handler whole, and the host closes what it handed over once",
      ],
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "an answer that arrives after the stop has its sources closed and is never pumped",
        "a failure after the stop reaches the late handler once and is never a detached rejection",
      ],
      "tests/unit/lib/api/editor-query.test.ts": [
        "a failure after the caller left is logged by kind and code, never its text",
        "the cancellation answer of a run whose cancel the host sent is its expected end, and is not logged",
        "any other late failure is still logged: another error after the cancel, or a cancellation with no cancel sent",
      ],
      "tests/unit/lib/provider-host/host-rules.test.ts": [
        "an answer the host abandoned keeps its handler",
        "every provider promise the host abandons keeps a rejection handler",
      ],
    },
  },
  "C-30": {
    tests: {
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "a console facet the session does not offer is refused before the call",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a request field or a console facet the session does not offer is refused before any frame",
      ],
      "tests/api/db/cancel.test.ts": ["provider without cancelQuery returns 400"],
      "tests/unit/lib/provider-host/host-rules.test.ts": [
        "an engine that cannot cancel is reported still running, and nothing is called",
      ],
    },
  },
  "C-31": {
    tests: {
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "an error a call or a source throws reaches the host as the same object",
        "a call that throws fails only that call, and its session and the served instance keep serving",
      ],
      "tests/unit/lib/provider-host/host-rules.test.ts": [
        "a socket lost mid-statement answers CONNECTION_ERROR with outcome unknown",
      ],
    },
  },
  "C-32": {
    tests: {
      "packages/provider-sdk/tests/sdk-purity.test.ts": [
        "SDK source declares no top-level let or var",
        "SDK source creates no top-level Map, Set, WeakMap or WeakSet",
        "SDK source never reads process",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "two sessions of one served module reach only their own handles, and one session's error or close leaves the other serving",
        "two served instances of one module share no session",
      ],
    },
  },
  "C-35": {
    tests: {
      "tests/unit/lib/uncaught-exception.test.ts": [
        "the listener logs the line once, with no stack even under NODE_ENV=development, then exits with 70",
        "attaches one uncaughtException listener and nothing else",
        "logs an unhandled rejection that Node.js raised as an uncaught exception by that origin, then exits with 70",
      ],
      "tests/unit/uncaught-exception-documentation.test.ts": [
        "it says an unhandled promise rejection does not stop the server, unless Node.js raises it as an exception",
      ],
    },
  },
  "C-36": {
    tests: {
      "tests/unit/lib/shutdown-handler.test.ts": [
        "a cache close that never settles is cut after 15 s and the exit code is 143",
        "where Next.js owns the exit it runs the hooks, closes no provider cache and never exits",
      ],
    },
  },
  "C-38": {
    tests: {
      "tests/unit/editor/statement-analysis.test.ts": [
        "answers run for a read",
        "answers confirm for a write",
        "refuses a connection-name ask on a nameless connection",
      ],
      "tests/unit/lib/api/run-confirmation.test.ts": [
        "a reader that throws asks, marked classificationFailed, and logs no text",
      ],
    },
  },
  "C-39": {
    tests: {
      "tests/integration/mcp/run-read-query.test.ts": [
        "without queryReadOnly is refused, and query() is never the fallback",
      ],
      "tests/isolated/factory.test.ts": [
        "refuses %s on an engine on the review record whose provider implements no read-only statement path, before connecting it, and query() is never the fallback",
      ],
      "tests/api/agent/handover.test.ts": [
        "refuses to replay on an engine the review record does not list, naming it, and never calls queryReadOnly",
      ],
      "tests/unit/lib/provider-host/host-rules.test.ts": [
        "the host never falls back from the protected read path to the plain one: a read-only statement session without queryReadOnly is refused at its open, a plain statement on one is refused before the call, and query() is never called",
      ],
    },
  },
  "C-40": {
    tests: {
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "a mandatory call that is missing or no function is refused as call-missing",
        "an implementation key the contract does not define is refused as impl-key-unknown",
      ],
    },
    schema: ["/$defs/consoleCalls/required"],
  },
  "C-42": {
    tests: {
      "tests/unit/package-imports.test.ts": [
        "no workspace package imports or declares another provider package",
        "a planted package that imports or declares another provider package fails by file and name, the kit admitted in its tests only",
      ],
    },
  },
  "C-43": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "the entries' order changes no result",
        "a lock with no entries names no package",
      ],
      "tests/unit/lib/provider-host/providers-dir.test.ts": [
        "an unset, empty or blank LIBREDB_PROVIDERS_DIR is no providers directory",
      ],
      "tests/unit/lib/provider-loader/registry.test.ts": [
        "a record enters the registry only through registerAdmitted, listed frozen in the order registered",
      ],
      "tests/unit/lib/db/server-catalog.test.ts": [
        "a fence alias or an engine id two claimants state refuses every admitted claimant, whatever their order",
      ],
    },
  },
  "C-44": {
    tests: {
      "tests/unit/lib/provider-host/core/open-once.test.ts": [
        "concurrent callers of one key share one open",
        "a failed open reaches every caller and frees its key",
        "a caller whose signal aborts stops waiting, and the others still get the open",
        "a caller whose signal already aborted starts nothing and joins nothing",
        "an open no caller waits for any more is admitted exactly once by its own start",
        "an open that fails with no caller left reaches the unclaimed hook once, never as a detached rejection",
        "a discard aborts the matching flights' signals and answers them",
      ],
      "tests/unit/lib/provider-host/core/open-once-bounds.test.ts": [
        "a caller's signal frees it from an open that never settles",
      ],
      "tests/isolated/factory.test.ts": [
        "two concurrent first calls for one connection build, connect and cache one provider",
        "a connect two concurrent callers share fails once for both, releases the tunnel once and caches nothing",
        "twelve concurrent first acquisitions of one connection and profile construct one provider",
        "two concurrent first tree reads of one connection open one metadata session, and a removal overtakes one in flight",
        "a removal of the connection closes an open it overtook and caches nothing",
        "a cache clear closes an open in flight and names one still opening at the cut",
        "an open that settles while the caches close is closed once, admits nothing and answers not-sent, in either cache",
        "a caller whose wait ends stops waiting with its reason, and the others still get the open",
        "an open every caller stopped waiting for is admitted once and served from the cache",
        "an open that fails after every caller stopped waiting is logged by its connection, kind and code, never its text",
        "a caller whose wait already ended builds and connects nothing",
      ],
      "tests/integration/db/factory-open-once.test.ts": [
        "two concurrent first writes for one DuckDB connection both reach the file",
      ],
      "tests/unit/lib/api/editor-open-bounds.test.ts": [
        "an open that never settles is cut at the call's open allowance, not-sent",
      ],
      "tests/api/db/query.test.ts": ["the provider opens under the request's own open wait"],
      "tests/api/db/cancel.test.ts": [
        "a cancel that leaves while its connection opens answers 499 not-sent and cancels nothing",
      ],
      "tests/api/db/query-open-wait.test.ts": [
        "a request that leaves while its connection opens is answered at once, and the open's later failure is logged by connection, kind and code",
      ],
      "vscode-extension/test/unit/backend-handlers.test.ts": [
        "query/run opens its provider under the run's own open wait, and a token cancelled while it opens answers QUERY_CANCELLED not-sent",
        "query/cancel takes its request's cancellation as its caller signal, while the provider opens and while the engine answers",
        "query/cancel with a token already cancelled calls nothing",
      ],
      "tests/isolated/editor-cache-package-engines.test.ts": [
        "two concurrent first opens open one session",
        "a caller whose wait ends stops waiting, and an open no caller waits for is admitted once",
        "a removal or a cache clear closes an open it overtook, once, and caches nothing",
      ],
    },
  },
  "C-45": {
    tests: {
      "tests/unit/lib/provider-host/core/teardown.test.ts": [
        "a rollback settles before the close starts",
        "a rollback that never settles is cut at its deadline and the close still runs",
        "a close that never settles is cut at its deadline",
        "a step that fails is reported with its error and the next step still runs",
        "a step that fails after its cut changes nothing and is never a detached rejection",
        "a teardown leaves no timer pending once it answers",
      ],
      "tests/unit/lib/provider-host/core/teardown-bounds.test.ts": [
        "a close that never settles is cut by the teardown's own deadline",
      ],
      "tests/isolated/factory.test.ts": [
        "a shared provider in a transaction is rolled back before it is closed when the caches close",
        "a shared provider whose disconnect never settles is cut at 10 s and named",
        "a shared provider whose rollback never settles is cut at 5 s and still closed",
        "the providers not closed at shutdown are named with their author and Studio's version",
        "the close the factory registers for the shutdown names an owned provider whose rollback or disconnect timed out or failed, and a profiled one whose close failed",
        "the caches' close tears the metadata sessions down under the teardown's deadlines and names one not closed",
      ],
      "tests/isolated/editor-cache-package-engines.test.ts": [
        "teardown cuts a close that never settles at the deadline",
        "teardown cuts a close that never settles at the deadline, in a child with its own heap and timeout",
      ],
      "tests/isolated/factory-package-engines.test.ts": [
        "removeProvider by connection, by owner and by key closes a package engine's cached session with today's teardown deadlines",
        "clearProviderCache closes package sessions and names a close that never settles as not closed, by connection and package",
      ],
    },
  },
  "C-47": {
    tests: {
      "packages/provider-sdk/tests/calls/deadline.test.ts": [
        "a cleanup call gets a context of its own, ten seconds ahead and never aborted",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a refused open answer's session is closed with a context of its own, not the open's aborted one",
      ],
      "tests/unit/lib/provider-host/core/teardown.test.ts": ["the close deadline is the SDK's cleanup deadline"],
      "tests/unit/lib/api/editor-query.test.ts": [
        "the scope's end runs under a cleanup context of its own, ten seconds from its start, which the caller's leaving does not end",
      ],
    },
  },
  "C-55": {
    tests: {
      "tests/unit/lib/provider-host/core/open-once.test.ts": [
        "an open still pending at its deadline fails every waiting caller with the owner's expired error, and leaves the table",
        "the next caller after an open's deadline starts a new open",
        "a late settle of an expired open leaves the open that replaced it in the table",
        "a late failure of an expired open reaches the unclaimed hook once, never as a detached rejection",
        "an open that settled before its deadline is not expired by it afterwards",
        "a deadline already passed when the open starts expires it at once",
        "a discard still reaches an open its deadline ended while that open is pending, and no longer once it settled",
        "a discard reaches an expired open beside the open that replaced it under its key",
        "the deadline signal is read once per open, with its meta",
      ],
      "tests/unit/lib/provider-host/core/open-once-bounds.test.ts": [
        "an open that never settles is ended by its own deadline",
      ],
      "tests/isolated/factory.test.ts": [
        "an open still connecting at its engine's connect budget answers StudioTimeoutRefusal not-sent to every caller, one without a wait included",
        "the next call after an open's deadline builds and connects a new provider",
        "a provider whose connect settles after its open's deadline is closed once and never cached",
        "an execution-profile open ends at the same budget",
        "a cache clear names an open its deadline ended that is still connecting at the cut",
      ],
      "tests/api/db/query-open-wait.test.ts": [
        "a connection whose open never settles is opened afresh by the next request after its connect budget",
      ],
    },
  },
  "C-56": {
    tests: {
      "tests/unit/lib/api/test-connection.test.ts": [
        "a connect still pending at the engine's connect budget rejects with the test's ConnectionError, and its provider is closed once the connect settles",
        "a connect that fails after the deadline gets its provider closed too, and its failure goes nowhere",
        "a deadline that passed while the tunnel opened builds nothing",
        "a deadline that passed while the provider was built starts no connect, and closes what was built",
        "checks or a health read still pending at the deadline answer the test's ConnectionError, never a caution or a degraded success",
        "a health read whose deadline passed before its timer fired answers the test's ConnectionError and reads no health",
        "the deadline names the engine's own budget",
      ],
      "tests/unit/lib/api/test-connection-bounds.test.ts": [
        "a connect that never settles is cut at the test's deadline",
      ],
      "tests/api/db/test-connection.test.ts": [
        "a test with no answer within the engine's connect budget answers 503 CONNECTION_ERROR with the test's sentence, and closes its provider once the connect settles",
      ],
      "vscode-extension/test/unit/backend-handlers.test.ts": [
        "hands the core the connection, posture and route only, so the core's deadline bounds the test",
        "answers the core's deadline error as CONNECTION_ERROR with its sentence, its own status and code",
      ],
    },
  },
  "C-57": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "console calls that leave out transaction are refused as missing-key",
      ],
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": [
        "the transaction actions are begin, commit, rollback and state",
      ],
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "the transaction facet is declared and implemented both ways, like every console facet",
      ],
      "packages/provider-sdk/tests/calls/transaction.test.ts": [
        "a transaction answer is a session state, and stateReported only for begin",
        "a missing or unknown session state is refused by name, and no getter is called",
        "stateReported on another action, a key a transaction answer cannot have, or no record at all is refused by name",
        "a statement answered inside a transaction carries its session state, and one without is refused by name",
        "no transaction answer refusal carries a value of the answer",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served transaction call crosses its request and answer as frames, and a statement inside the transaction carries its session state back",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a transaction request is one of its actions, and only begin carries requireReportedState",
      ],
    },
    schema: ["/$defs/consoleCalls/properties/transaction"],
  },
  "C-58": {
    tests: {
      "tests/unit/lib/provider-host/core/console-transaction.test.ts": [
        "the core asks the session on every call and keeps no state between calls",
        "a stopped transaction call's record settles once the call it stopped waiting for settles, answered or failed",
      ],
      "tests/unit/lib/provider-host/legacy-bridge.test.ts": [
        "a bridged session reads the provider's state on every call, and keeps none",
      ],
      "tests/unit/lib/api/editor-transaction.test.ts": [
        "a COMMIT the caller leaves answers QueryCancelledError outcome unknown and an unknown state, with no state read",
        "a COMMIT or ROLLBACK the provider fails answers its error by reference and the state read at once after it",
        "a state read after a failure that is stopped or fails answers unknown, and a failing read is logged by kind and code",
        "a state read answers the session's state, and a stopped read answers unknown",
        "an unknown state is answered as inTransaction null, never false",
      ],
      "tests/unit/lib/api/transaction-ownership.test.ts": [
        "the owner's own call settles the record by the state it answered",
        "the reconcile resolves a record by the state it read, and an end seen on an unknown state is recorded unknown",
        "a lease that lapses on an unknown state records unknown, never timed-out",
        "the watch records unknown for an unresolved record its read finds closed, and nothing for an open or unknown one",
        "a reload that takes the grant away records unknown for a record whose state is unknown",
        "a call Studio stopped waiting for keeps the record unresolved until it settles, whatever a read or answer finds open",
        "a read that finds no transaction while a call Studio stopped waiting for still runs keeps the record unresolved, and one after it settled releases it",
        "the watch records nothing while a call Studio stopped waiting for still runs, and looks again until it has settled",
        "the watch records nothing for a read a call Studio stopped waiting for began during, and looks again",
        "a state read taken before the record was claimed, changed or ended neither settles nor resolves it",
        "a call of the owner's in flight keeps every read from acting on the record, and its own answer settles it",
        "the watch looks again and records nothing while a call of the owner's is in flight, and once it answered a read that finds no transaction records timed-out once",
        "the watch records nothing for a read the record changed during, and looks again",
        "the watch's repeated looks stop once the record's lease has lapsed",
        "a reload that takes the grant away records unknown while a call of the owner's is in flight or stopped",
        "a claim over a record whose end was not recorded records that end unknown, once",
      ],
      "tests/api/db/transaction.test.ts": [
        "a statement whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner",
        "a COMMIT whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner",
        "an unknown state answers inTransaction null, and the next read that finds the transaction resolves it",
        "a script whose state read after its statements fails answers the statements' results with inTransaction null, and keeps the transaction and its owner unresolved",
        "while a BEGIN whose caller left still runs, the status read answers inTransaction null, and who holds the record",
        "governance: an unknown state records no terminal event, and a later read that finds no transaction records unknown, never timed-out or rolled-back",
        "governance: an unknown state the next read finds still open is resolved, and a later provider timeout records timed-out",
        "governance: a COMMIT that fails after it may have reached the database and leaves no transaction records unknown, never rolled-back",
        "governance: a COMMIT refused before it was sent that leaves no transaction records rolled-back",
        "governance: a COMMIT whose caller leaves records an open event, and the end a later read finds is recorded unknown",
        "governance: a read that finds the transaction open while a COMMIT whose caller left still runs keeps the state unknown, and the end found after it is recorded unknown",
        "governance: a ROLLBACK sent while a COMMIT whose caller left still runs is refused and sends nothing, and the end the read after the COMMIT settled finds is recorded unknown",
        "governance: a COMMIT sent while a ROLLBACK whose caller left still runs is refused and sends nothing, and the end the read after the ROLLBACK settled finds is recorded unknown",
        "a BEGIN, statement, COMMIT or ROLLBACK sent while a COMMIT whose caller left still runs is refused 409 by name and sends nothing, and once it settled the ROLLBACK is sent and answers by its own outcome",
        "a state read that began before the owner's newer BEGIN claimed the record neither releases nor settles it when it answers",
        "governance: a read that answers while the owner's COMMIT has committed but not yet answered keeps the record and records nothing, and the COMMIT records committed",
        "a BEGIN the owner sends on their own record that Studio stops waiting for holds the record's calls until it settles",
        "governance: a credential change while the owner's stopped COMMIT still runs records unknown, never rolled-back, and answers rolledBack false",
        "governance: a provider timeout that ends the transaction while a statement runs is recorded unknown once the statement answers",
        "governance: a typed COMMIT statement, alone or ending a script, records exactly one terminal event, unknown",
        "governance: a reload that tears down the owner's providers while their COMMIT still runs records unknown, never rolled-back",
        "governance: a BEGIN that opens a new transaction while the owner's statement still runs on the old record records the old one's end unknown",
        "governance: a read that finds no transaction while a BEGIN whose caller left still runs keeps the record, so the transaction it opens stays its caller's and its end is recorded unknown",
        "governance: a lease that lapses on an unknown state records unknown, never timed-out",
        "governance: a credential change on a transaction whose state is unknown records unknown unless a rollback answered",
        "a script unit that does not answer within its deadline is that unit's error inside the 200 answer, no further unit starts, and the transaction is kept with its state unknown until that unit settles",
        "governance: a script unit Studio stopped waiting for records the script's open row with its code, and the end found after it settled is recorded unknown",
      ],
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "a stopped execute's record settles once the run it stopped waiting for settles, answered or failed",
      ],
    },
  },
  "C-60": {
    tests: {
      "tests/unit/lib/api/editor-query.test.ts": [
        "the run on a session that offers console.endScope is sent a scope of its own, and that scope is ended once after the run",
        "a provider that declares no transaction ender is sent no scope and asked to end none, and answers no openTransaction key",
        "the scope is ended when the statement throws, and the statement's error is answered",
        "a transaction the run left open and the provider rolled back is answered (D74)",
        "an end that fails is answered in the run's place, its error by reference, and the page record is released once",
        "the scope's end is sent before the answer body is built",
        "a page refused after the call ends its scope before the refusal is answered",
        "a run refused before its call ends no scope",
        "the scope's end runs under a cleanup context of its own, ten seconds from its start, which the caller's leaving does not end",
        "an end its cleanup deadline stops answers StudioTimeoutRefusal naming the end, outcome unknown",
        "an end the host refuses is answered as a defect of Studio's bridge, named by its rule",
        "a caller that leaves while the statement runs is answered at once, and the scope is ended once the statement has settled",
        "the end of a stopped run's scope that fails or is stopped is logged by kind and code, never its text",
      ],
      "tests/unit/lib/api/editor-scope-bounds.test.ts": [
        "an end that never answers is cut at the cleanup deadline, and the run answers StudioTimeoutRefusal naming it",
      ],
      "tests/api/db/query.test.ts": [
        "ends the transaction its own statement left open and says so",
        "ends the transaction a FAILING statement left open, which is where they come from",
        "leaves a provider that cannot name its own session exactly as it found it",
        "governance: a rollback that fails after the statement answered is answered in the statement's place and recorded as the run's error, as the finally always did",
      ],
      "vscode-extension/test/unit/backend-handlers.test.ts": [
        "answers a transaction the statement left open as rolled back (D74)",
        "ends the statement's own scope after the run, and answers an end that fails in the run's place",
      ],
      "tests/api/db/multi-query.test.ts": [
        "the script's scope is ended once through the host core's console.endScope, under a cleanup context the request's leaving does not end",
        "a script whose end does not answer within 10 s answers 504 naming the end",
        "a script the request leaves still ends its scope once the statement in flight settled",
        "every statement and the ender run under ONE scope, this request's own (D87)",
        "a provider that cannot end one is asked nothing and answers as before",
      ],
      "tests/unit/lib/provider-host/legacy-bridge.test.ts": [
        "only the legacy bridge calls a provider's endOpenQueryTransaction, so a run's open transaction ends through console.endScope alone",
      ],
    },
  },
  "C-61": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "calls that leave out objects, or objects that leave out tree, are refused as missing-key",
      ],
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": [
        "the objects facets are the schema's",
        "the tree actions are containers, count, list, describe and describeMany",
      ],
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "the objects tree facet is declared and implemented both ways, like every console facet",
      ],
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "the objects tree facet is refused by name to a session that does not offer it",
      ],
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a refinement may withdraw objects.tree, and never offer it where the manifest does not",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a tree request is one of its actions, each with its own members",
        "a tree answer is exactly one of its five forms, each read as its closed shape",
        "a containers answer may carry needsConfiguration as text, read as part of its closed shape",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served tree call crosses each action's request and answer as frames, and the provider receives decoded frozen copies",
        "a containers answer that says the inventory needs configuration crosses as a frame with its sentence",
      ],
    },
    schema: ["/$defs/calls/properties/objects", "/$defs/objectsCalls/properties/tree"],
  },
  "C-66": {
    tests: {
      "tests/unit/db/session-capacity.test.ts": [
        "every shipped engine's session capacity is one exactly where Studio's record names a reason",
        "an in-memory database serves one session on every engine that opens a local file",
        "a name the file admission reads as a file is a file, whatever it spells",
        "the class and the file admission read one in-memory name",
        "the class reads Studio's records and the connection, never a provider or a manifest",
      ],
      "tests/unit/db/compatibility.test.ts": [
        "is exhaustive over the shipped engines and frozen, each reason a sentence",
        "names a reason for every engine SINGLE_WRITER_FILE names",
      ],
      "tests/isolated/factory.test.ts": [
        "a tree read's provider is a session of its own beside the editor's, from the same connection and posture, with a pool of at most two that opens none until asked",
        "under governance each owner's metadata session is their own, with a pool of at most two beside a pool of poolMaxPerUser",
        "a connection that serves one session answers the editor's own provider and builds no other",
        "every refusal of the editor's open refuses a metadata open alike, before anything is built",
        "two concurrent first tree reads of one connection open one metadata session, and a removal overtakes one in flight",
        "a removal closes the metadata session with the editor's, by connection, by owner and by record key",
        "the idle sweep evicts an idle metadata session and keeps one with a run in flight",
        "the caches' close tears the metadata sessions down under the teardown's deadlines and names one not closed",
        "the SSH tunnel stays open while a metadata session still serves the connection",
        "a saved query timeout change reopens the metadata session",
      ],
      "tests/api/db-objects.test.ts": [
        "each tree route reads on the connection's metadata session, and the source and edit routes on the editor's",
        "a tree route answers while the editor's provider holds every read, without waiting for it",
        "handleObjectRequest resolves the editor's provider by default and the metadata session when asked, after the guard and the connection's resolution",
      ],
      "vscode-extension/test/unit/backend-handlers.test.ts": [
        "each tree call reads through the host core's tree call, on the provider of the connection's metadata session",
        "a tree call answers while the editor's provider holds every read, without waiting for it",
      ],
      "tests/unit/lib/api/editor-provider.test.ts": [
        "opens the connection's metadata session with the editor's connection and posture, and without a catalog runs on it",
        "a catalog runs on that database's session of the metadata session, and a connection without sessions refuses one",
      ],
      "tests/api/db/maintenance.test.ts": [
        "a kill runs on the connection's metadata session, opened with the editor's connection and posture, and every other operation on the editor's provider",
        "a kill answers while the editor's provider holds every run, without waiting for it",
        "a kill's catalog runs on that database's session of the metadata session, and a catalog the connection cannot honour is refused as the editor's provider refuses it, with nothing run or audited",
      ],
      "tests/api/db/monitoring.test.ts": [
        "the dashboard reads every panel on the connection's metadata session, opened with the editor's connection and posture, and answers that session's maintenance",
        "a dashboard answers while the editor's provider holds every panel read, without waiting for it",
        "a dashboard's catalog reads on that database's session of the metadata session, and a catalog the connection cannot honour is refused in the editor's provider's words with no panel read",
      ],
      "tests/api/db/health.test.ts": [
        "the health read runs on the connection's metadata session, opened with the editor's connection and posture",
        "a health read answers while the editor's provider holds every read, without waiting for it",
        "a health read's catalog reads on that database's session of the metadata session, and a catalog the connection cannot honour is refused in the editor's provider's words",
      ],
      "tests/api/admin/fleet-health.test.ts": [
        "each row's health and overview are read on the connection's metadata session, opened under the posture its declarations were read with",
        "a row answers while the editor's provider holds every read, without waiting for it",
      ],
    },
  },
  "C-67": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "calls that leave out maintenance, or maintenance that leaves out run or preview, are refused as missing-key",
      ],
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": [
        "the maintenance facets are the schema's",
        "the maintenance operations are the schema's",
      ],
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "the maintenance facets are declared and implemented both ways, like every console facet",
        "an engine's maintenance is admitted where the package offers maintenance.run, and refused by name as engine-facet-call-not-offered where it does not",
        "a maintenance spec that previews is admitted where the package offers maintenance.preview, and refused by name where it does not",
      ],
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "the maintenance facets are refused by name to a session that does not offer them",
      ],
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a refinement may withdraw maintenance.run and maintenance.preview, and never offer one the manifest does not",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a maintenance run request and answer are each read as their closed shape",
        "a maintenance preview request and answer are each read as their closed shape",
        "a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served maintenance call crosses its request and answer as frames, and the provider receives decoded frozen copies",
      ],
    },
    schema: [
      "/$defs/calls/properties/maintenance",
      "/$defs/maintenanceCalls/properties/run",
      "/$defs/maintenanceCalls/properties/preview",
    ],
  },
  "C-68": {
    tests: {
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a maintenance narrowing is a list of the placements the server accepts, each read as a closed record of its operation and two booleans",
        "a maintenance narrowing longer than the operation vocabulary is refused as refinement-unreadable at the list, and no item is read",
        "sessionMaintenance refuses an operation the session's engine does not list as refinement-widens",
        "sessionMaintenance withdraws what the server refuses and adds nothing, as narrowMaintenance does",
        "no maintenance narrowing refusal carries a value of the refinement",
      ],
      "packages/provider-sdk/tests/calls/narrowing-bounds.test.ts": [
        "a maintenance narrowing of the longest length is refused at the list, in a bounded child",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served open whose maintenance narrowing names an operation its engine does not list is refused, and the session it opened is closed",
      ],
      "tests/unit/provider-sdk/call-surface-parity.test.ts": [
        "a session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a server accepts",
        "a bridged session's maintenance is narrowMaintenance's answer for every shipped spec and every placement a connected server accepts",
      ],
    },
  },
  "C-71": {
    tests: {
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "calls that leave out monitoring, or monitoring that leaves out panel or poolStats, are refused as missing-key",
      ],
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": ["the monitoring facets are the schema's"],
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "the monitoring facets are declared and implemented both ways, like every console facet",
        "an engine's offered monitoring panel is admitted where the package offers monitoring.panel, and refused by name as engine-facet-call-not-offered where it does not",
      ],
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "a monitoring panel request is held to the panels the session's engine offers",
        "no monitoring request refusal carries a value of the request",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a monitoring panel request is the closed shape of the panel it names",
        "a monitoring panel answer is exactly one of its seven forms, each read as its closed shape",
        "a timestamp member admits a Date and nothing else",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served monitoring call crosses its request and answer as frames, and the provider receives decoded frozen copies",
        "a monitoring call on a session without the facet, or for a panel its engine does not offer, is refused before any frame",
      ],
    },
    schema: [
      "/$defs/calls/properties/monitoring",
      "/$defs/monitoringCalls/properties/panel",
      "/$defs/monitoringCalls/properties/poolStats",
    ],
  },
  "C-72": {
    tests: {
      "packages/provider-sdk/tests/calls/define-provider.test.ts": [
        "a mandatory call that is missing or no function is refused as call-missing",
        "a call inherited from a prototype is not read, so a class instance is refused as call-missing",
      ],
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a calls segment the contract does not define is refused by name, and never read as the objects segment",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a pool statistics answer and a health answer are each read as their closed shape",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a served health call crosses its context and answer as frames, and the host receives a decoded copy",
        "a closed or foreign session token is refused as session-not-open before any frame",
      ],
    },
  },
  "C-78": {
    tests: {
      "packages/provider-sdk/tests/calls/vocabulary.test.ts": [
        "the console facets and execute's request fields are the schema's",
        "the read-only modes are execute and estimate-plan, frozen",
      ],
      "packages/provider-sdk/tests/calls/request.test.ts": [
        "a request field the session does not honour is refused before the call",
        "a read-only execute goes only to a session opened under the read-only policy to be sent statements, and such a session takes no other execute",
      ],
      "packages/provider-sdk/tests/calls/refinement.test.ts": [
        "a refinement that narrows the declared calls is admitted, and the session's calls are the narrowed ones",
      ],
      "packages/provider-sdk/tests/manifest/validate.test.ts": [
        "a request field execute does not know, or one listed twice, is refused",
      ],
      "packages/provider-sdk/tests/testing/serve.test.ts": [
        "a read-only execute crosses to a session opened for read-only statements, and every other pairing is refused before any frame",
        "a read-only execute to a session whose module does not honour readOnly is refused by the field before any frame",
      ],
      "packages/provider-sdk/tests/testing/frames.test.ts": [
        "a read-only execute's budget and mode are read as a closed shape",
      ],
      "tests/unit/lib/provider-host/core/console.test.ts": [
        "a read-only execute is refused before the call on a session not opened for read-only statements, and a plain execute on one that is",
      ],
      "tests/unit/provider-sdk/call-surface-parity.test.ts": [
        "every member of today's read-only statement surface has a place in the console calls or with the host",
      ],
    },
    schema: ["/$defs/executeRequestField"],
  },
  "C-85": {
    tests: {
      "tests/unit/lib/provider-host/legacy-bridge.test.ts": [
        "a read-only statement session honours offset, runs the provider's prepare on a bounded page with a fresh copy of it, and sends the statement it prepared to queryReadOnly",
        "a bounded page the prepare did not apply with no offset sends the prepared statement and answers its page not applied",
        "an offset the provider's prepare did not apply is refused as Studio's own refusal, not-sent, and no read-only path is called",
        "a refusal or failure the prepare raises passes by reference, and no read-only path is called",
        "a read-only execute with an offset reaches the bridged read-only statement session through the host core",
      ],
      "tests/unit/db/errors.test.ts": ["is an OffsetUnsupportedError only Studio raises, outcome not-sent"],
      "tests/unit/db/operations/provider-text.test.ts": [
        "Studio's refusal of an offset is Studio's, and a provider's OffsetUnsupportedError is not",
      ],
      "tests/unit/db/operations/provider-text-census.test.ts": [
        "only the legacy bridge's read-only paging and the accessor's refusal of a package session's offset construct a StudioOffsetRefusal, and no provider module does",
      ],
      "tests/unit/lib/api/read-only-execute.test.ts": [
        "a paged read-only execute sends its page through one host core execute call and answers whether the provider applied it",
        "a paged read-only execute whose offset the provider's prepare did not apply is refused as Studio's own refusal before the read-only path is called",
      ],
      "tests/integration/mcp/run-read-query.test.ts": [
        "run_read_query's page, one row past max_rows from the offset, is applied by the read-only statement session through the host core, never by MCP",
        "the next page with offset 100 answers rows 101 to 150 and no more",
        "a query with its own LIMIT is cut without a next offset, and says how to page in SQL",
        "whose preparation refuses an offset is answered in the provider's words behind a notice naming it, and nothing runs",
        "an offset the provider's read path refuses with OffsetUnsupportedError is answered in its words behind the notice, as its prepare's refusal is",
        "a call whose deadline passed while its connection opened is answered with the timeout before its offset is read",
        "without queryReadOnly is refused, and query() is never the fallback",
      ],
      "tests/unit/db/operations/read-only-statement-callers.test.ts": [
        "no MCP module calls a provider's prepareQuery: run_read_query's page is applied by the read-only statement session",
        "only the agent's statement path, the hand-over route and MCP's statement path open a read-only statement session, each under a profile that sends statements",
      ],
    },
  },
  "C-87": {
    tests: {
      "tests/unit/lib/provider-loader/load.test.ts": [
        "a package's entry is imported from its file URL, and its default record is answered as it was exported",
        "a package's entry resolves its own dependencies from its own node_modules",
        "a record with a null prototype is answered as loaded",
        "a namespace with no default is refused as PROVIDER_LOAD_FAILED, default-missing",
        "an interop wrapper is refused as PROVIDER_LOAD_FAILED, interop-wrapper, and its inner default is never read",
        "a default that is not a plain record is refused as PROVIDER_LOAD_FAILED, not-a-record, and none of its code runs",
        "under Bun, a CommonJS entry's interop wrapper is unwrapped by Bun itself, so only an ES module entry reads alike on every runtime",
      ],
      "tests/unit/lib/provider-loader/node-runtime.test.ts": [
        "under Node, a CommonJS entry's interop wrapper is refused as interop-wrapper, in a bounded child",
        "under Node, a default record loads with its own dependency, in a bounded child",
      ],
    },
  },
  "C-88": {
    tests: {
      "tests/unit/lib/provider-loader/load.test.ts": [
        "an import that throws is refused as PROVIDER_LOAD_FAILED, import-threw, with the thrown value as its cause and no text of it in the refusal",
        "a missing entry file is refused as PROVIDER_LOAD_FAILED, import-threw",
        "a relative entry, a deadline outside 1 to 2147483647 ms and a port that is not a function are refused before any import",
      ],
      "tests/unit/lib/provider-loader/node-runtime.test.ts": [
        "under Node, an import that never settles is refused at its deadline and holds no exit, in a bounded child",
      ],
    },
  },
  "C-89": {
    tests: {
      "tests/unit/lib/provider-loader/load.test.ts": [
        "an import past its deadline is refused as PROVIDER_LOAD_FAILED, deadline-passed, and its late success reaches the port once and is never answered as loaded",
        "an import that rejects after its deadline reaches the port once with its cause, and leaves no unhandled rejection",
      ],
      "tests/unit/lib/provider-loader/node-runtime.test.ts": [
        "under Node with --unhandled-rejections=strict, a rejection after the deadline reaches the port once and the child exits 0, in a bounded child",
      ],
    },
  },
  "C-91": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "an entry whose directory resolves outside the providers directory, a symbolic link included, is refused as PROVIDER_PATH_OUTSIDE",
        "a directory that resolves inside the providers directory through a link is read as its real path",
        "an entry the lock names that is not a regular file of the artifact is refused as PROVIDER_PATH_OUTSIDE",
        "a providers directory named through another spelling of itself reads as its real path does",
        "the lock's name, version, engine id and entry forms are the provider contract's",
      ],
      "tests/unit/lib/provider-host/providers-dir.test.ts": [
        "the providers directory, everything in it and its lock, by real path too, are reserved in any letter case, normalization form or spelling",
      ],
      "tests/unit/lib/db/provider-files.test.ts": [
        "a file or host path naming the providers directory, a path in it or its lock is refused by name before any provider is built",
      ],
      "tests/unit/scripts/providers-lock.test.ts": [
        "the lock the command writes is admitted unchanged, and a later edit to the artifact is refused",
      ],
    },
  },
  "C-92": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "an artifact that holds a symbolic link or junction is refused as PROVIDER_PATH_OUTSIDE, and the link is never followed",
        "an artifact that holds a named pipe or a link to a device is refused at once, and neither is opened",
      ],
      "tests/unit/lib/provider-host/provider-artifact.test.ts": [
        "a name outside letters, digits and . _ - @ + ~ is refused as PROVIDER_DIGEST_MISMATCH",
        "more files or deeper directories than the limits are refused as PROVIDER_DIGEST_MISMATCH, and the limits are 10000 files and 32 levels",
      ],
    },
  },
  "C-93": {
    tests: {
      "tests/unit/lib/provider-host/provider-artifact.test.ts": [
        "the digest is SHA-256 over each file's mode, SHA-256 and path, one line each in path order",
        "a fixed artifact has the same digest on every platform",
        "a file's mode is 755 where its owner execute bit is set, which Windows never reports, and 644 otherwise",
        "only the owner execute bit moves the digest: group and other bits and the umask do not",
        "an empty directory moves no digest",
        "the digest lists each import after the files, one line each in order, and an empty record leaves the files' digest",
      ],
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "an artifact whose files differ from the lock digest is refused as PROVIDER_DIGEST_MISMATCH",
        "a byte changed in any file of an artifact is refused at the next read, and nothing is kept between reads",
        "a missing or unreadable artifact is refused as PROVIDER_DIGEST_MISMATCH, naming why",
        "the digest covers the import record, so a record edited without its files is refused as PROVIDER_DIGEST_MISMATCH",
      ],
    },
  },
  "C-94": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "a package.json whose name, version or engine ids differ from its entry is refused naming the field",
      ],
      "tests/unit/lib/provider-host/provider-artifact.test.ts": [
        "the identity is read from package.json and libredb-provider.json at the artifact's root, each within its byte limit",
        "a manifest whose engines or runtime.entry are not in their form is refused naming the manifest, and its other members are never read",
      ],
    },
  },
  "C-95": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "an entry serving an engine id the bundled catalog serves is refused as PROVIDER_ID_COLLISION",
        "two entries serving one engine id are both refused as PROVIDER_ID_COLLISION, each naming the other, before any of their files is read",
      ],
    },
  },
  "C-96": {
    tests: {
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "no refusal carries a value read from the package beyond its name and version",
        "the refusal codes are one closed list, and every refusal names a code and a rule of its lists",
        "reading and writing a lock run no code of a package",
        "a refused package carries its lock entry's engine ids",
      ],
      "tests/unit/lib/provider-host/admission.test.ts": [
        "no refusal carries a value read from the package beyond its name and version",
        "the admission codes join the closed list, each with its closed rules, and the loader's reasons are the loader's",
      ],
    },
  },
  "C-97": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a manifest for another contract major is refused before the schema validator runs",
        "a CommonJS entry is refused as PROVIDER_MODULE_FORMAT and its top level never runs",
        "a dependency only an ancestor node_modules holds is refused as closure-outside and its top level never runs",
        "a bare require is refused as closure-outside even when the package's own node_modules holds the folder, since the resolver moves on past it",
        "a bare import is refused as closure-outside even when the package's own node_modules holds the folder, since Bun's resolver moves on past it",
        "a package holding a TypeScript file of any kind, a declaration file among them, is refused as PROVIDER_MODULE_FORMAT",
        "a .node file in the artifact is refused as PROVIDER_NATIVE_UNSUPPORTED",
        "a package passing admission is answered with Studio's record of its implementation and its file's manifest, which registerAdmission registers through registerAdmitted",
        "admission refuses no claim request and grants none",
      ],
    },
  },
  "C-98": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a manifest for another contract major is refused before the schema validator runs",
        "the admitted manifest is deep-frozen",
        "HOST_CONTRACT is the contract the schema serves and the SDK's PROVIDER_CONTRACT",
        "a validator for another contract is a host defect, refused before any file is read",
        "a manifest the schema refuses is refused as PROVIDER_SCHEMA_INVALID, naming the first rule and its pointer and never a key",
        "a manifest or package.json changed after the lock read is refused as PROVIDER_DIGEST_MISMATCH before any import",
        "an unreadable manifest is refused naming its errno, and an error without one is raised",
      ],
    },
  },
  "C-99": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a package naming functions in every slot, none of which Studio's tables hold, is admitted",
        "admission reads no table of Studio's keyed by engine id",
      ],
    },
  },
  "C-100": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "an engine id already served is refused",
        "a lock entry named @libredb/studio is refused as PROVIDER_ID_COLLISION",
        "two admissions that overlap never register two packages serving one engine id, or one name twice",
      ],
    },
  },
  "C-101": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a CommonJS entry is refused as PROVIDER_MODULE_FORMAT and its top level never runs",
        "an .mjs entry and a .js entry under a package.json of type module are admitted",
      ],
    },
  },
  "C-102": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a dependency only an ancestor node_modules holds is refused as closure-outside and its top level never runs",
        "a bare require is refused as closure-outside even when the package's own node_modules holds the folder, since the resolver moves on past it",
        "a bare import is refused as closure-outside even when the package's own node_modules holds the folder, since Bun's resolver moves on past it",
        "a package holding a TypeScript file of any kind, a declaration file among them, is refused as PROVIDER_MODULE_FORMAT",
        "an entry importing ./types.d beside a types.d.ts is refused before the import, so the declaration file's import never runs",
      ],
      "tests/unit/lib/provider-host/provider-closure.test.ts": [
        "a built-in and a relative file inside the artifact are inside, named by an import or a require",
        "a relative import that leaves the artifact, or holds %, ?, # or a backslash, is outside",
        "every bare specifier, named by an import or a require, is outside whatever node_modules folder the package holds",
        "an absolute path, a URL, another scheme and a subpath import are outside",
        "the answer reads only the record, so it is the same on every platform",
      ],
      "tests/unit/lib/provider-host/providers-lock.test.ts": [
        "a lock entry's import record is closed and capped, each import in its forms and listed once",
        "a verified package carries its import record as the lock wrote it, frozen",
      ],
      "tests/unit/scripts/providers-lock.test.ts": [
        "the command records every static import of each module file, sorted and once each, and Studio's read admits the lock",
        "the command refuses a module file its parser cannot read, a specifier outside its form, too many imports and a lock over its byte limit, writing nothing",
        "an import's kind is require for a require call and import for every import form, and any other kind is a defect",
      ],
    },
  },
  "C-103": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a .node file in the artifact is refused as PROVIDER_NATIVE_UNSUPPORTED",
        "a manifest declaring native packages is refused as PROVIDER_NATIVE_UNSUPPORTED",
      ],
    },
  },
  "C-104": {
    tests: {
      "tests/unit/lib/provider-host/admission.test.ts": [
        "a record whose manifest differs from its file is refused",
        "a record the SDK's check refuses is refused as PROVIDER_RECORD_INVALID, naming the rule",
        "an implementation or a segment that is a Proxy is refused, and none of its traps runs",
        "a loader refusal is the package's PROVIDER_LOAD_FAILED with the loader's reason, its cause kept out of the sentence",
        "a package passing admission is answered with Studio's record of its implementation and its file's manifest, which registerAdmission registers through registerAdmitted",
      ],
    },
  },
  "C-105": {
    tests: {
      "tests/unit/lib/provider-host/boot.test.ts": [
        "a refused package leaves Studio running without its engines, named once by code",
        "an unreadable lock exits 1 with a named line",
        "an unset directory admits nothing and boots",
        "a package whose entry throws at import is refused with its code, its cause logged on the same line call and out of the sentence",
        "an import that settles after its deadline is logged once by its package and never registered",
        "a package a set rule refuses is absent from the loader's registry, which names exactly the packages the catalog serves",
        "the boot's validator is compiled once from the SDK's schema module, whose digest is the SDK's",
        "admission runs once per process: a second call reads nothing and keeps the installed catalog",
        "each package is admitted under the 10 s import deadline, in lock order, one after another",
      ],
      "tests/unit/instrumentation.test.ts": [
        "register() admits providers once, after the host core and before governance and the samples",
        "a boot a check refuses admits no provider",
        "a providers lock that cannot be read stops register before governance, the banner and the samples",
      ],
      "tests/unit/provider-sdk/manifest-types.test.ts": [
        "the schema text module is the schema's bytes, line for line, and its SHA-256 is MANIFEST_SCHEMA_SHA256",
      ],
    },
  },
  "C-106": {
    tests: {
      "tests/unit/lib/db/server-catalog.test.ts": [
        "an admitted engine is a known type to the server and its connection fields come from its declaration",
        "the library's DatabaseType guard is unchanged",
        "a refused package's engine is unavailable naming every code that refused it, and a bundled id stays bundled",
        "a type a client sends that is an Object.prototype key is unknown, never an inherited member",
        "the catalog composes once: a second install is refused by name, and nothing installed answers the bundled catalog",
        "the composed catalog holds no engine knowledge the declaration did not state: no SQL writing, connection form, connection string, grammar, migration DDL or generator row",
        "composing a set that still conflicts, or an engine both served and unavailable, is a host defect",
        "a field rule naming a check refuses a value with core's sentence naming the field, and passes an empty field",
        "a fence alias or an engine id two claimants state refuses every admitted claimant, whatever their order",
        "an engine id that is a bundled fence alias refuses the admitted claimant, so no fence tag names two engines",
        "an editor fact stated otherwise than Studio's catalog refuses the admitted claimant, and one two packages state differently refuses both",
        "a set rule refusal carries the package's name, version and rule and no value of its declaration",
      ],
      "tests/unit/lib/db/server-catalog-cross-bundle.test.ts": [
        "a catalog installed by the boot bundle is the one a route bundle reads",
      ],
      "tests/unit/lib/provider-host/boot.test.ts": [
        "packages the catalog's set rules refuse are logged with PROVIDER_CATALOG_CONFLICT and serve none of their engines",
      ],
      "tests/unit/db/claim-grants.test.ts": [
        "an admitted package with no grant record reads every claim at its restrictive value",
      ],
    },
  },
  "C-107": {
    tests: {
      "tests/unit/seed/resolve-connection-package-engines.test.ts": [
        "an inline connection or a seed of a refused package's engine is refused as PROVIDER_UNAVAILABLE naming the code",
        "an admitted engine's connection is refused on a route that does not serve package engines, by name, and accepted by the package-aware resolve",
        "resolveServedConnection answers a package engine's connection with its record, and resolveConnection takes no source parameter",
      ],
      "tests/api/db/test-connection-package-engine.test.ts": [
        "Test Connection opens an admitted engine's session through its package, reads its health and closes it",
        "Test Connection answers PROVIDER_UNAVAILABLE naming the refusal code for a refused package's engine",
      ],
      "tests/isolated/factory-package-engines.test.ts": [
        "an engine whose package was refused answers PROVIDER_UNAVAILABLE naming the refusal at each factory entry point, before any cache, tunnel or build",
        "an admitted package's engine is refused at each factory entry point that answers a legacy provider, its session opening through the factory's editor session",
      ],
      "tests/unit/lib/api/error-body.test.ts": [
        "PROVIDER_UNAVAILABLE answers 503 naming the codes and the quoted type, PACKAGE_ENGINE_UNSUPPORTED answers 501",
      ],
      "tests/unit/mcp/availability.test.ts": [
        "answers the server catalog's refusal for an engine a provider package serves or a refused package names",
      ],
      "tests/unit/mcp/statement-arms.test.ts": [
        "lists its type as written, no read tool and the server catalog's refusal, reading no per-engine fact",
      ],
      "tests/integration/mcp/context.test.ts": [
        "both open checks refuse a refused package's engine as PROVIDER_UNAVAILABLE naming the code, and an admitted one as no session opens on it",
      ],
      "tests/api/db/query-package-engine.test.ts": [
        "a query on an admitted engine answers the package's rows through the host core",
        "a refused package's engine and an unknown type answer as the server catalog answers them",
      ],
    },
  },
  "C-109": {
    tests: {
      "tests/isolated/editor-cache-package-engines.test.ts": [
        "an engine an admitted package serves opens through the package's open with core's context, and no legacy class is built",
        "each open check refuses before the package's open is called and before any file is read",
        "a refinement the host refuses fails the open as the package's defect, and Test Connection's one open is never cached",
      ],
      "tests/unit/lib/provider-host/open-context.test.ts": [
        "the open context carries the deadline, the connect budget and only the fields the declaration admits",
        "a field value outside the contract's value forms is refused by field, never by value",
        "tls is the connection's ssl only for a mode the declaration lists, and refused by name otherwise",
        "trust material is read only for a declaration that reads it, and egress is core's decision",
        "the environment reader answers a declared name from the process and refuses any other by name, never reading it",
        "the pool is core's default for a shared session and the owner's share for an owned one",
      ],
      "tests/unit/lib/provider-host/core/contract-session.test.ts": [
        "a refinement narrows the calls and the maintenance; a widening one is refused and the handle is closed under a cleanup context",
        "an open answer with no handle throws by name, and one that arrives after the stop is closed once and never answered",
        "a close of a handle Studio does not admit that fails or is cut reaches the late port, and the open still answers",
        "an open refused at its start calls nothing",
      ],
      "tests/api/db/test-connection-package-engine.test.ts": ["the open checks refuse before the budget starts"],
    },
  },
  "C-111": {
    tests: {
      "tests/unit/lib/provider-host/core/contract-session.test.ts": [
        "an open answer becomes a session whose members are exactly the calls it offers, each calling the package with its handle first",
        "the host core's execute, cancel, endScope, tree, panel, pool statistics and health run on the session unchanged",
      ],
      "tests/isolated/editor-cache-package-engines.test.ts": [
        "a call the package does not offer is refused before the call",
        "a console execute on a package session answers the package's rows through the host core",
      ],
      "tests/unit/lib/provider-host/access.test.ts": [
        "a refused offset of a session that refuses it is Studio's own offset refusal, not-sent",
        "refused params of a session that refuses them are FacetNotOfferedError, not-sent",
        "a facet the session does not offer is FacetNotOfferedError naming the call, not-sent",
      ],
      "tests/api/db/query-package-engine.test.ts": [
        "bound params and an offset the package does not honour are refused before the call, not-sent",
        "a query whose caller leaves sends the package's cancel through the host core",
      ],
    },
  },
  "C-112": {
    tests: {
      "tests/api/db/query-package-engine.test.ts": [
        "a package's error answers Studio's sentence naming its code, and its words go to the log only",
        "a package's warnings reach the client only as Studio's sentence with their count, each logged once through core's scrub",
      ],
      "tests/api/db/test-connection-package-engine.test.ts": [
        "a health failure answers the degraded success with Studio's sentence naming its code, and the session is still closed",
        "an open that fails answers Studio's sentence naming its code, not-sent, and a close that fails does not change the answer",
      ],
      "tests/unit/lib/api/package-errors.test.ts": [
        "a refusal of what the package answered is the package's failure, answered with Studio's sentence",
        "the log line of a refusal of what the package answered names the package as its author, never Studio",
        "a value the package rejects with is the package's failure, whatever its message says",
        "answers nothing for no warning, and Studio's sentence naming the count for one, logged once",
      ],
    },
  },
};

/** Each id the document no longer holds, to the tracked file whose docblock states its rule. Never reused. */
export const REMOVED_CLAUSES: Readonly<Record<string, string>> = {
  "M-15": "scripts/generate-engine-declarations.ts",
  "M-16": "tests/unit/db/engine-table-inventory.test.ts",
  "M-57": "src/lib/db/claim-grants.ts",
  "M-70": "scripts/generate-engine-catalog.ts",
  "M-71": "scripts/generate-engine-catalog.ts",
  "M-72": "src/lib/db/connection-form.ts",
  "M-74": "src/lib/db/connection-string/index.ts",
  "M-75": "src/lib/db/engine-catalog/projection.ts",
  "M-77": "src/lib/db/engine-catalog/projection.ts",
  "M-78": "src/lib/db/sql-grammar/index.ts",
  "M-79": "src/lib/db/sql-writing/index.ts",
  "M-80": "src/lib/db/migration-ddl/index.ts",
  "M-81": "src/lib/db/query-generators/index.ts",
  "M-82": "src/lib/db/claim-grants.ts",
  "M-83": "src/lib/db/claim-grants.ts",
  "S-2": "src/lib/db/sql-grammar/index.ts",
  "C-7": "src/lib/db/types.ts",
  "C-46": "tests/unit/lib/db/database-provider-members.test.ts",
  "C-48": "src/lib/provider-host/core/console.ts",
  "C-49": "src/lib/provider-host/core/turns.ts",
  "C-50": "src/lib/provider-host/legacy-bridge.ts",
  "C-51": "src/lib/provider-host/access.ts",
  "C-52": "src/lib/provider-host/core/host-core.ts",
  "C-53": "src/lib/provider-host/core/page-budget.ts",
  "C-54": "src/lib/provider-host/core/console.ts",
  "C-59": "src/lib/api/editor-transaction.ts",
  "C-64": "src/lib/provider-host/core/objects.ts",
  "C-65": "src/lib/api/object-tree.ts",
  "C-69": "src/lib/provider-host/core/maintenance.ts",
  "C-70": "src/app/api/db/maintenance/route.ts",
  "C-73": "src/lib/provider-host/core/monitoring.ts",
  "C-74": "src/lib/api/provider-monitoring.ts",
  "C-75": "src/app/api/db/health/route.ts",
  "C-76": "src/lib/api/provider-monitoring.ts",
  "C-77": "src/lib/db/factory.ts",
  "C-79": "src/lib/api/read-only-execute.ts",
  "C-80": "src/lib/api/object-tree.ts",
  "C-81": "src/lib/mcp/context.ts",
  "C-82": "src/lib/mcp/tools/inspect-schema.ts",
  "C-83": "src/app/api/db/multi-query/route.ts",
  "C-84": "src/app/api/db/transaction/route.ts",
  "C-86": "src/app/api/db/profile/route.ts",
  "C-90": "src/lib/provider-loader/index.cjs",
  "C-108": "src/lib/uncaught-exception.ts",
  "C-110": "src/lib/db/factory.ts",
  "C-113": "src/lib/api/package-editor-query.ts",
};
