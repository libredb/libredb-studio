/**
 * The connection dialog's form data for every engine: the label, the default host and port, the fields and their
 * labels, hints, placeholders, placement, rules, options and conditions, the SSL, SSH and host-URI flags, the
 * credential warnings and the import, with the readers of them. Everything an entry of `DB_UI_CONFIG` says apart from
 * its icon and its colour.
 *
 * Each engine's entry is a projection of its declaration (docs/providers/CONTRACT.md, clause M-72): the declaration
 * authors its `displayName` and, of its `connection`, the `defaults`, `tls`, `dialog`, `hostUriSchemes`, `fieldRules`,
 * `hostHint`, `hostIdentity` and `import`, which src/lib/db/engine-catalog/connection-form.generated.ts holds as
 * `BUNDLED_CONNECTION_FORMS`, and `composeConnectionForm` reads them into today's `ConnectionFormSpec`. A declaration
 * names a function and never carries one: `CONNECTION_FORM_FUNCTIONS`, Studio's function table, binds each name to the
 * function Studio's own source holds for that engine at that slot, looked up through src/lib/db/function-table.ts, and
 * a name it holds no function for is refused by name when the form is composed, with no default. The dialog's own words
 * for an engine, its hints and its refusal sentences, are therefore edited in the engine's declaration under
 * src/lib/db/engine-declarations and regenerated with `bun run engines:generate`; a sentence a provider also refuses
 * with is a copy of the provider's, held to it by tests/unit/lib/db-ui-config.test.ts, since the dialog may not import
 * provider modules.
 *
 * UI-free: nothing here imports `react`, `lucide-react` or a module under src/components/, so a bundle with no React
 * can load it. The web dialog reads it through `DB_UI_CONFIG` (src/lib/db-ui-config.ts), which adds each engine's icon
 * and colour to its entry here; the VS Code extension's child reads it through `engines/list`.
 * tests/unit/lib/db/connection-form.test.ts holds both: the run-time import graph, and `DB_UI_CONFIG` as this table
 * plus an icon and a colour.
 */
import type { FieldName, FieldRule } from "@libredb/provider-sdk/manifest";
import type { HostUriScheme } from "@/lib/connection-host-uri";
import type { ConnectionImportDeclaration } from "@/lib/connection-import";
import { CONNECTION_FORM_URI_MODE } from "@/lib/db/compatibility";
import {
  CONNECTION_FIELD_DESCRIPTORS,
  CONNECTION_FIELDS,
  type ConnectionField,
  type FieldPlacement,
  type PlaceableField,
} from "@/lib/db/connection-fields";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";
import { CREDENTIAL_WARNINGS, type CredentialWarning } from "@/lib/db/credential-warnings";
import { BUNDLED_CONNECTION_FORMS } from "@/lib/db/engine-catalog/connection-form.generated";
import type { ConnectionFormEntry } from "@/lib/db/engine-catalog/projection";
import {
  snowflakeAccountRefusal,
  snowflakeHostHint,
  snowflakeHostIdentity,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { boundFunction, type FunctionTable } from "@/lib/db/function-table";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";

/** What the connection dialog reads for one engine, apart from the icon and colour `DB_UI_CONFIG` adds. */
export interface ConnectionFormSpec {
  label: string;
  defaultPort: string;
  /**
   * What the Host box holds when this engine is chosen after another one, where the previous engine's host means
   * nothing here: a Snowflake account is not a host name, so a carried `localhost` would sign in to an account of
   * that name. Absent, the box keeps what it held, as it always has.
   */
  defaultHost?: string;
  showConnectionStringToggle: boolean;
  /**
   * The fields the dialog draws and `buildConnection` saves, taken by reference from `CONNECTION_FIELDS` in
   * src/lib/db/connection-fields.ts, which holds the lists in a module of their own so the seed loader reads them
   * without this form table.
   */
  connectionFields: readonly ConnectionField[];
  /**
   * The order the connection dialog draws this engine's fields in, where it differs from `connectionFields`, which
   * stays the order the VS Code extension prompts in. Each of the engine's fields once; a field left out is drawn
   * after the ones named. Read by src/lib/db/connection-field-layout.ts.
   */
  dialogOrder?: readonly ConnectionField[];
  /**
   * The connection dialog's label for a field, where this engine names the field differently from
   * the dialog's own word (#1085). Read through `connectionFieldLabel`, so an engine relabels a
   * field by declaring it here rather than by another per-type branch in `ConnectionModal.tsx`.
   */
  fieldLabels?: Partial<Record<ConnectionField, string>>;
  /**
   * A sentence the connection dialog draws under a field, where this engine needs one said before
   * the user reaches an error (#1085). Read through `connectionFieldHint`.
   */
  fieldHints?: Partial<Record<ConnectionField, string>>;
  /**
   * The connection dialog's placeholder for a field, where this engine's example differs from the dialog's own.
   * Read through `connectionFieldPlaceholder`; the `host`, `user`, `password`, `database`, `schema`, `region`,
   * `location`, `privateKey`, `amqpPort` and `connectionString` boxes read it. A declared `schema` example also stands in for the dialog's
   * own sentence under that box, so the engine's hint is the only one drawn there.
   */
  fieldPlaceholders?: Partial<Record<ConnectionField, string>>;
  /**
   * Where the connection dialog draws each of the `PLACEABLE_FIELDS` this engine takes: `"advanced"` behind the
   * Advanced accordion, `"open"` with the other fields. Read through `connectionFieldPlacement`. The SDK's validator
   * requires a placement for every placeable field the engine takes and refuses one for any other field, when the
   * declaration is admitted, so there is no default to fall through to. The dialog draws the accordion only for an
   * engine that places one there.
   */
  fieldPlacement?: Readonly<Partial<Record<PlaceableField, FieldPlacement>>>;
  /**
   * The sentence under the Host box derived from what is typed in it, such as the host a Snowflake account
   * identifier resolves to, or `undefined` while the text derives nothing. Drawn in place of the static `fieldHints`
   * entry for `host` while it answers; absent, the static hint is drawn as before.
   */
  hostHint?: (host: string) => string | undefined;
  /**
   * The server a Host text names, for telling whether a pasted connection string names the server already in the box
   * or another one, whose credentials the form then drops. Read through `hostIdentity`; absent, the text trimmed and
   * lower-cased.
   */
  hostIdentity?: (host: string) => string;
  /**
   * The checks the connection dialog runs on a field before Test Connection and Save send anything, each refusal a
   * sentence that names the field and never repeats its value. Read through `connectionFieldRefusal` in
   * ./connection-field-rules, the one module that evaluates them, in the dialog and again on the test-connection path
   * Test Connection and Save post to, before a tunnel opens or a provider is built. The provider runs the same checks
   * again at connect, because a seed opened in the editor or an API call never passes either; so each rule takes every
   * value the provider takes.
   */
  fieldRules?: Partial<Record<ConnectionField, ConnectionFieldRule>>;
  /**
   * The choices of a field the connection dialog draws as a select rather than a text box, each a
   * stored value and its label, offered after an empty "None" choice that stores nothing (#1088).
   * The dialog draws the select where the engine takes the field, the same condition
   * `buildConnection` writes it on, so an entry that declares options names the field in
   * `connectionFields` too. Only Kafka's SASL mechanism is declared this way; a per-type boolean in
   * `ConnectionModal.tsx` is what this replaces.
   */
  fieldOptions?: Partial<Record<ConnectionField, readonly { readonly value: string; readonly label: string }[]>>;
  /**
   * A field the connection dialog draws only while another field holds one value, such as Snowflake's private key,
   * drawn only while Sign-in is Key pair. Read through `connectionFieldShown` in ./connection-field-rules: the dialog
   * draws such a field only while the condition holds, `buildConnection` writes it only then, and
   * `connectionFieldRefusal` checks its rules only then, so a hidden field is neither saved nor required. A
   * controlling field the connection leaves absent reads as its `fieldDefaults` value. Absent means every field the
   * engine takes is drawn.
   */
  fieldShownWhen?: Partial<Record<ConnectionField, { readonly field: ConnectionField; readonly equals: string }>>;
  /**
   * The value the provider reads for a field a connection leaves absent (undefined or null), declared for a field a
   * `fieldShownWhen` condition reads, so the dialog and core decide which fields such a connection shows, and so
   * requires, as the provider does: Snowflake's absent Sign-in is the key pair, `SNOWFLAKE_SIGN_IN_DEFAULT`. Where the
   * field has `fieldOptions`, the value is one of them; tests/unit/lib/db-ui-config.test.ts holds both. Absent, an
   * absent controlling field meets no condition.
   */
  fieldDefaults?: Partial<Record<ConnectionField, string>>;
  /**
   * `false` where the engine's declaration lists no TLS mode (`connection.tls.modes` empty), since its endpoint fixes
   * its own TLS, so an SSL mode would be read by nothing. Absent means the dialog offers the panel. Read through
   * `offersSslPanel`, never directly.
   */
  showSslPanel?: false;
  /**
   * The schemes the connection dialog's Host box takes as a whole address, split into Host and Port on paste
   * and at save (src/lib/connection-host-uri.ts), absent meaning the box takes a host alone, as it always has.
   * Read through `hostUriSchemes`, never directly. The connection-string box is a different reader and keeps
   * `http://` and `https://` for ClickHouse.
   */
  hostAcceptsUri?: readonly HostUriScheme[];
  /**
   * The credentials this engine warns about, taken by reference from `CREDENTIAL_WARNINGS` in
   * src/lib/db/credential-warnings.ts through a getter every entry is given below, and never written out in an
   * entry, so the dialog's warning and the seed loader's refusal read one record. That module holds the data in a
   * module of its own so the seed loader reads it without this form table.
   */
  credentialWarnings?: readonly CredentialWarning[];
  /**
   * An import the connection dialog offers for this engine: the action's label and a loader of a browser-side parser
   * that reads a pasted text into entries, one of which fills the form (src/lib/connection-import.ts). Absent means the
   * dialog offers no import. The dialog reads it from the entry, never from a type branch, and offers it only for a new
   * connection.
   */
  connectionImport?: ConnectionImportDeclaration;
}

/** A check the connection dialog runs on one field before Test Connection and Save (`fieldRules`). */
export interface ConnectionFieldRule {
  /**
   * The refusal of a blank field; absent, a blank field passes. A field is blank when it holds no value, being absent
   * or null, or an empty one; a field the storage classification (`CONNECTION_FIELDS` in
   * src/lib/storage/secret-fields.ts) calls `secret` is blank, as its provider reads it, also when the value is not
   * text or holds only whitespace. Such a required secret, while `connectionFieldShown` shows it, is also refused by
   * core, with this sentence, before the provider is built (`requiredSecretRefusal` in ./connection-field-rules), so
   * the sentence names the field as the dialog labels it.
   */
  readonly required?: string;
  /** A field that is not blank must match `pattern` whole, or `sentence` is the refusal. */
  readonly format?: { readonly pattern: RegExp; readonly sentence: string };
  /** A field that is not blank and passes `format` must hold `min` to `max` characters, or `sentence` is the refusal. */
  readonly charRange?: { readonly min: number; readonly max: number; readonly sentence: string };
  /**
   * A field that is not blank and passes the two above is read by this function, whose answer is the refusal, or
   * undefined where it passes: for a check a pattern cannot state, such as Snowflake's Account, which the dialog reads
   * with the very function `connect()` reads it with.
   */
  readonly check?: (value: string) => string | undefined;
}

/**
 * Studio's form function table: for each slot kind a declaration's connection form names a function at, the functions
 * Studio's own source holds, per engine and name. A name is bound only at its own kind, so a function held as a host
 * hint is never run as a check.
 */
export interface ConnectionFormFunctions {
  /** A field rule's `check`: reads a field that passes its format and range, and answers its refusal or undefined. */
  readonly checks: FunctionTable<NonNullable<ConnectionFieldRule["check"]>>;
  /** `hostHint`: the sentence drawn under the Host box from what is typed in it, or undefined. */
  readonly hostHints: FunctionTable<NonNullable<ConnectionFormSpec["hostHint"]>>;
  /** `hostIdentity`: the server a Host text names. */
  readonly hostIdentities: FunctionTable<NonNullable<ConnectionFormSpec["hostIdentity"]>>;
  /** An import's `importer`: a loader of the browser-side parser, called when the import opens, never before. */
  readonly importers: FunctionTable<ConnectionImportDeclaration["load"]>;
}

/**
 * The functions the committed declarations name (docs/providers/CONTRACT.md, clause M-72), each the one Studio's source
 * holds for that engine at that slot: Snowflake's Account check, hint and identity, the very functions `connect()`
 * reads the account with (src/lib/db/providers/sql/snowflake/account-host.ts, a pure module with no import of its own,
 * so the dialog runs them in the browser), and Kubernetes' kubeconfig import, whose loader imports the parser, and the
 * yaml parser it reads with, only when the import opens. A function only a package would hold has no place here: no
 * package function runs in a browser, and a name this table does not hold is refused when the form is composed.
 * tests/unit/lib/db/connection-form.test.ts holds the table to exactly the names the committed declarations give.
 */
export const CONNECTION_FORM_FUNCTIONS: ConnectionFormFunctions = Object.freeze({
  checks: Object.freeze({ snowflake: Object.freeze({ hostCheck: snowflakeAccountRefusal }) }),
  hostHints: Object.freeze({ snowflake: Object.freeze({ hostHint: snowflakeHostHint }) }),
  hostIdentities: Object.freeze({ snowflake: Object.freeze({ hostIdentity: snowflakeHostIdentity }) }),
  importers: Object.freeze({
    kubernetes: Object.freeze({
      importer: () => import("@/lib/kubernetes/kubeconfig-import").then((module) => module.importKubeconfig),
    }),
  }),
});

/**
 * `field` as a field of Studio's connection dialog.
 *
 * @throws {Error} Naming the engine and the field, for a field the dialog does not draw, such as a seed-only field,
 * which the SDK's validator already refuses in a dialog entry or a field rule of an admitted declaration.
 */
function dialogField(id: DatabaseType, field: FieldName): ConnectionField {
  if (!Object.hasOwn(CONNECTION_FIELD_DESCRIPTORS, field)) {
    throw new Error(
      `${id} declares a connection form entry for ${field}, which Studio's connection dialog does not draw.`,
    );
  }
  return field as ConnectionField;
}

/** The entries of `list` as a frozen record keyed by each entry's field in list order, or undefined where it is empty. */
function perField<Entry extends { readonly field: FieldName }, Value>(
  id: DatabaseType,
  list: readonly Entry[],
  read: (entry: Entry) => Value,
): Readonly<Partial<Record<ConnectionField, Value>>> | undefined {
  if (list.length === 0) return undefined;
  return Object.freeze(Object.fromEntries(list.map((entry) => [dialogField(id, entry.field), read(entry)])));
}

/**
 * The form's Host text readers: `hostHint` and `hostIdentity`, each only where the entry names one, bound through
 * `functions`.
 */
function hostReaders(
  id: DatabaseType,
  entry: ConnectionFormEntry,
  functions: ConnectionFormFunctions,
): Pick<ConnectionFormSpec, "hostHint" | "hostIdentity"> {
  return {
    ...(entry.hostHint === null ? {} : { hostHint: boundFunction(id, functions.hostHints, entry.hostHint) }),
    ...(entry.hostIdentity === null
      ? {}
      : { hostIdentity: boundFunction(id, functions.hostIdentities, entry.hostIdentity) }),
  };
}

/** One declared field rule as the dialog checks it: its pattern compiled once, its check bound through `functions`. */
function ruleOf(id: DatabaseType, rule: FieldRule, functions: ConnectionFormFunctions): ConnectionFieldRule {
  const { required, format, charRange, check } = rule;
  return Object.freeze({
    ...(required === null ? {} : { required }),
    ...(format === null
      ? {}
      : {
          format: Object.freeze({
            pattern: new RegExp(format.pattern.source, format.pattern.flags),
            sentence: format.sentence,
          }),
        }),
    ...(charRange === null
      ? {}
      : { charRange: Object.freeze({ min: charRange.min, max: charRange.max, sentence: charRange.sentence }) }),
    ...(check === null ? {} : { check: boundFunction(id, functions.checks, check) }),
  });
}

/**
 * Engine `id`'s form entry, composed from `entry`, its projected connection form, and `functions`: the label is the
 * declared `displayName`; the default port the decimal text of `defaults.port`, or empty; the default host only where
 * declared; the connection string toggle `CONNECTION_FORM_URI_MODE`'s answer; the fields `CONNECTION_FIELDS`' row, by
 * reference; each per-field record built from its dialog list, keyed in field order, and only where the list is not
 * empty; each field rule's pattern compiled once; `showSslPanel: false` only where `tls` lists no mode; the Host
 * box's schemes only where it takes any; each named function bound through `functions`; and `credentialWarnings` a
 * getter onto `CREDENTIAL_WARNINGS`, so the dialog's warning and the seed loader's refusal read one record. The entry
 * and every record in it are frozen.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot; naming
 * the engine and the field, for a dialog entry or a field rule of a field the connection dialog does not draw.
 */
export function composeConnectionForm(
  id: DatabaseType,
  entry: ConnectionFormEntry,
  functions: ConnectionFormFunctions,
): ConnectionFormSpec {
  const { dialog, defaults } = entry;
  const fieldLabels = perField(id, dialog.labels, ({ text }) => text);
  const fieldHints = perField(id, dialog.hints, ({ text }) => text);
  const fieldPlaceholders = perField(id, dialog.placeholders, ({ text }) => text);
  const fieldPlacement = perField(id, dialog.placement, ({ where }) => where);
  const fieldRules = perField(id, entry.fieldRules, (rule) => ruleOf(id, rule, functions));
  const fieldOptions = perField(id, dialog.options, ({ choices }) => choices);
  const fieldShownWhen = perField(id, dialog.shownWhen, ({ when }) =>
    Object.freeze({ field: dialogField(id, when.field), equals: when.equals }),
  );
  const fieldDefaults = perField(id, dialog.absentValues, ({ value }) => value);
  const spec: ConnectionFormSpec = {
    label: entry.displayName,
    defaultPort: defaults.port === undefined ? "" : String(defaults.port),
    ...(defaults.host === undefined ? {} : { defaultHost: defaults.host }),
    showConnectionStringToggle: CONNECTION_FORM_URI_MODE[id],
    connectionFields: CONNECTION_FIELDS[id],
    ...(dialog.order === null
      ? {}
      : { dialogOrder: Object.freeze(dialog.order.map((field) => dialogField(id, field))) }),
    ...(fieldLabels === undefined ? {} : { fieldLabels }),
    ...(fieldHints === undefined ? {} : { fieldHints }),
    ...(fieldPlaceholders === undefined ? {} : { fieldPlaceholders }),
    ...(fieldPlacement === undefined ? {} : { fieldPlacement }),
    ...hostReaders(id, entry, functions),
    ...(fieldRules === undefined ? {} : { fieldRules }),
    ...(fieldOptions === undefined ? {} : { fieldOptions }),
    ...(fieldShownWhen === undefined ? {} : { fieldShownWhen }),
    ...(fieldDefaults === undefined ? {} : { fieldDefaults }),
    ...(entry.tls.modes.length === 0 ? { showSslPanel: false as const } : {}),
    ...(entry.hostUriSchemes.length === 0 ? {} : { hostAcceptsUri: entry.hostUriSchemes }),
    ...(entry.import === null
      ? {}
      : {
          connectionImport: Object.freeze({
            label: entry.import.label,
            load: boundFunction(id, functions.importers, entry.import.importer),
          }),
        }),
  };
  Object.defineProperty(spec, "credentialWarnings", { get: () => CREDENTIAL_WARNINGS[id], enumerable: true });
  return Object.freeze(spec);
}

/**
 * Every engine's form entry, composed when this module loads from `BUNDLED_CONNECTION_FORMS` and Studio's function
 * table, so a committed module naming a function Studio holds none for fails every importer by that sentence. Keyed in
 * the projection's ascending id order.
 */
export const CONNECTION_FORM: Readonly<Record<DatabaseType, ConnectionFormSpec>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_CONNECTION_FORMS) as DatabaseType[]).map((id) => [
      id,
      composeConnectionForm(id, BUNDLED_CONNECTION_FORMS[id], CONNECTION_FORM_FUNCTIONS),
    ]),
  ) as Record<DatabaseType, ConnectionFormSpec>,
);

/**
 * One member of engine `type`'s composed entry, for the per-engine constants below.
 *
 * @throws {Error} Naming the engine and the member, where its entry declares none.
 */
function declaredMember<Member extends "fieldHints" | "fieldRules">(
  type: DatabaseType,
  member: Member,
): NonNullable<ConnectionFormSpec[Member]> {
  const value = CONNECTION_FORM[type][member];
  if (value === undefined) throw new Error(`${type}'s connection form declares no ${member}`);
  return value;
}

/**
 * Databend's form checks (design 6.3), in the provider's own sentences, as its declaration states them. The provider
 * module is server code the dialog cannot import, so the warehouse pattern is a copy of its `WAREHOUSE_NAME`, and
 * tests/unit/lib/db-ui-config.test.ts holds the copy, and both sentences, to the provider's.
 */
export const DATABEND_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "databend",
  "fieldRules",
);

/**
 * The sentences the connection dialog draws under Databend's fields (design 6.1), as its declaration states them,
 * exported so the docs and the form's own refusals can be held to the same words.
 */
export const DATABEND_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember(
  "databend",
  "fieldHints",
);

/**
 * The sentences the connection dialog draws under Snowflake's fields, as its declaration states them, exported so the
 * docs can be held to them. The Host hint is drawn while the Account text does not read yet; once it reads, the
 * derived "Studio connects to" hint replaces it.
 */
export const SNOWFLAKE_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember(
  "snowflake",
  "fieldHints",
);

/**
 * Snowflake's form checks, as its declaration states them: each sentence is the account module's own
 * (`SNOWFLAKE_FIELD_SENTENCES` in src/lib/db/providers/sql/snowflake/account-host.ts), which
 * tests/unit/lib/db-ui-config.test.ts holds the declared copy to, and the Account check is `connect()`'s own reading
 * of the text (SF-025), bound through Studio's function table, so the dialog refuses exactly what Test would, a padded
 * account passes, and the hint under the box appears only for a text both take. Each credential is required only
 * under its own sign-in method: `fieldShownWhen` hides the other one, and a hidden field's rules are not checked. Both
 * are secrets, so a key or token that is not text or holds only whitespace is blank, as connect() reads it, and core
 * refuses the one the Sign-in needs before the build.
 */
export const SNOWFLAKE_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "snowflake",
  "fieldRules",
);

/**
 * The sentences the connection dialog draws under Apache Spark's fields, as its declaration states them, exported so
 * the provider doc and its test can be held to the same words.
 */
export const SPARK_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember(
  "spark",
  "fieldHints",
);

/**
 * Apache Spark's form checks, in the provider's own sentences, as its declaration states them. The provider's modules
 * are server code the dialog may not import, so each rule takes exactly what the provider's reading in
 * src/lib/db/providers/sql/spark/namespace.ts and connection-options.ts takes: Token is a copy of its pattern,
 * Namespace is only white space (which the provider reads as none) or its pattern, and Catalog is its pattern read on
 * the trimmed text, so a Catalog of only white space is none and a padded one, a tab or a line feed at its ends
 * included, is the trimmed name. tests/unit/lib/db-ui-config.test.ts holds each rule and sentence to the provider's.
 */
export const SPARK_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "spark",
  "fieldRules",
);

/**
 * The form checks of S3-compatible object storage, in the provider's own sentences, as its declaration states them.
 * The provider module is server code the dialog cannot import, so the three patterns and the access key ID's range are
 * copies of the exports of src/lib/db/providers/objectstore/s3/connection-options.ts and constants.ts, and
 * tests/unit/lib/db-ui-config.test.ts holds each copy, and each sentence, to the provider's.
 */
export const S3_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "s3",
  "fieldRules",
);

/**
 * The sentences the connection dialog draws under the fields of S3-compatible object storage, as its declaration
 * states them, exported so the docs and the tests can be held to the same words.
 */
export const S3_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember("s3", "fieldHints");

/**
 * Kubernetes' form checks, in the provider's own sentences, as its declaration states them. The provider module is
 * server code the dialog cannot import, so each pattern states its rule, and tests/unit/lib/db-ui-config.test.ts
 * holds each pattern and sentence to the provider's: Default namespace is a copy of the provider's label pattern, and
 * Namespaces takes a list of labels or text of only white space and commas, which the provider reads as no list. The
 * API path, the TLS server name and the token are checked by the provider at Test Connection, and so is the count of
 * the Namespaces list (at most 1,000), which a pattern does not hold.
 */
export const KUBERNETES_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "kubernetes",
  "fieldRules",
);

/**
 * The sentences the connection dialog draws under Kubernetes' fields, as its declaration states them, exported so the
 * docs can be held to them.
 */
export const KUBERNETES_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember(
  "kubernetes",
  "fieldHints",
);

/**
 * RabbitMQ's form checks, in the provider's own sentences, as its declaration states them. The provider module is
 * server code the dialog cannot import, so each pattern is a copy of `readAmqpPort` and `readPathPrefix` in
 * src/lib/db/providers/stream/rabbitmq/connection-options.ts, and tests/unit/lib/db-ui-config.test.ts holds each copy
 * to the provider's rule over the same values. A field holding null holds no value, as the provider reads it. The
 * provider names the exact Path prefix shape it refuses; the dialog's one pattern names all of them at once.
 */
export const RABBITMQ_FIELD_RULES: Readonly<Partial<Record<ConnectionField, ConnectionFieldRule>>> = declaredMember(
  "rabbitmq",
  "fieldRules",
);

/**
 * The sentences the connection dialog draws under RabbitMQ's fields, as its declaration states them, exported so the
 * docs can be held to them.
 */
export const RABBITMQ_FIELD_HINTS: Readonly<Partial<Record<ConnectionField, string>>> = declaredMember(
  "rabbitmq",
  "fieldHints",
);

/** The engine a new connection opens on, the picker's first; the form hook holds it rather than spelling a type id. */
export { DEFAULT_CONNECTION_TYPE };

/**
 * The order the connection dialog's engine picker offers the engines in, for display (the dialog renders them as a
 * two-column grid).
 *
 * It covers the whole `DatabaseType` union, because the same form edits saved connections, so an omitted type leaves
 * the picker with nothing selected. An engine missing from this list cannot be created at all, and the compiler cannot
 * see the omission: the array is typed `readonly DatabaseType[]`, and every subset of a union satisfies that. So
 * registering an engine everywhere else is not enough; it has to be named here too.
 * tests/unit/lib/db/connection-form.test.ts enforces the coverage.
 */
export const CONNECTION_PICKER_ORDER: readonly DatabaseType[] = Object.freeze([
  DEFAULT_CONNECTION_TYPE,
  "mysql",
  "sqlite",
  "oracle",
  "mssql",
  "mongodb",
  "couchbase",
  "redis",
  "libredb",
  "clickhouse",
  "druid",
  "elasticsearch",
  "opensearch",
  "trino",
  "cassandra",
  "libsql",
  "duckdb",
  "prometheus",
  "kafka",
  "etcd",
  "db2",
  "neo4j",
  "milvus",
  "qdrant",
  "influxdb",
  "influxdb3",
  "oxia",
  "databend",
  "bigquery",
  "s3",
  "kubernetes",
  "mqtt",
  "firestore",
  "rabbitmq",
  "snowflake",
  "opcua",
  "snmp",
  "sparkplug",
  "spark",
  "mtconnect",
  "modbus",
  "netconf",
  "weaviate",
]);

/**
 * Whether the dialog offers the SSL / TLS panel: false only where the entry declares `showSslPanel: false`. The entry is
 * read through `typeIdRow` (FND-1), so a type outside the `DatabaseType` union is refused by name.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function offersSslPanel(type: DatabaseType): boolean {
  return typeIdRow(CONNECTION_FORM, type).showSslPanel !== false;
}

/**
 * The connection dialog's label for one field: the engine's declared `fieldLabels` entry, or the
 * dialog's own word when the engine declares none (#1085).
 *
 * The fallback is the caller's because the dialog's own words are not one table: the `database`
 * field alone reads "Database Name", "Database File Path" or "Database Name (optional override)"
 * by the mode the form is in. `port` shares the
 * host row's label, so the dialog draws one for it only where one is declared: an engine that
 * declares none keeps the row it always had.
 */
export function connectionFieldLabel(config: ConnectionFormSpec, field: ConnectionField, fallback: string): string {
  return config.fieldLabels?.[field] ?? fallback;
}

/** The connection dialog's placeholder for one field: the engine's declared one, or the dialog's own example. */
export function connectionFieldPlaceholder(
  config: ConnectionFormSpec,
  field: ConnectionField,
  fallback: string,
): string {
  return config.fieldPlaceholders?.[field] ?? fallback;
}

/**
 * The sentence the connection dialog draws under one field, or `undefined` where the engine
 * declares none (#1085). There is no fallback: a field with no declared hint draws nothing.
 */
export function connectionFieldHint(config: ConnectionFormSpec, field: ConnectionField): string | undefined {
  return config.fieldHints?.[field];
}

/**
 * Where the connection dialog draws one placeable field the engine takes: its declared `fieldPlacement`. A field with
 * no declaration is refused rather than drawn in the open, since the SDK's validator requires one wherever the engine
 * takes the field.
 */
export function connectionFieldPlacement(config: ConnectionFormSpec, field: PlaceableField): FieldPlacement {
  const placement = config.fieldPlacement?.[field];
  if (placement === undefined) throw new Error(`${config.label} declares no placement for ${field}`);
  return placement;
}

/**
 * The sentence under the Read-only toggle, which the dialog draws where every write path of the engine is gated
 * (`WRITE_REACH` `guarded`): there the mode changes what the connection may send, and it can be turned off.
 */
export const READ_ONLY_TOGGLE_HINT =
  "Writes, value edits and maintenance are refused on this connection. You can turn this off here, so on your own connection it is a safety rail, not a permission.";

/**
 * The sentence under the fixed Read-only label, one for every engine Studio has no write path on (`WRITE_REACH`
 * `none`): there is no box, because no setting is what keeps such a connection read-only.
 */
export const READ_ONLY_FIXED_HINT = "Studio has no write path on this engine, so every connection to it is read-only.";
