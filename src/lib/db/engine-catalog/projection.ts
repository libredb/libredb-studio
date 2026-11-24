/**
 * Studio's engine catalog, its data-only connection tables, its connection forms, its connection strings, each
 * engine's execution UI and fence aliases, its query dialects, tab type editors and editor languages, and each engine's
 * SQL text as projections of a set of admitted engine declarations (docs/providers/CONTRACT.md, clauses M-70, M-71,
 * M-72, M-74, M-75, M-77 and M-78).
 *
 * The catalog answers which engines Studio ships, whether each is an engine the user already runs (`external`) or the
 * store Studio carries with it (`embedded`), and how long the host waits for an open of each: one entry per declaration,
 * holding its `location` and its `connection.connectBudgetMs`, keyed by its `id`.
 *
 * The connection tables answer, per engine, the fields its connection takes (`connection.fields`), the fields only its
 * provider reads and how a seed of another type that carries one is refused (`connection.seedOnly`), the fields it
 * refuses by name (`connection.refused`), the credentials it warns about (`connection.credentialWarnings`), whether its
 * provider is handed the operator's trust material (`connection.readsTrustMaterial`), and whether its provider opens a
 * connection string and its dialog offers one (`connection.connectionString.accepted` and `dialogOffersUri`).
 *
 * The connection forms answer, per engine, what its connection dialog draws: its `displayName`, and of its
 * `connection` the `defaults`, the `tls` offer, the `dialog`, the `hostUriSchemes`, the `fieldRules`, the `hostHint`,
 * the `hostIdentity` and the `import`, each as the declaration states it: a pattern as its source and flags, and a
 * function as the name the declaration gives it, which src/lib/db/connection-form.ts binds to Studio's own function.
 *
 * The connection strings answer, per engine, the scheme shown for it and the functions that read its connection string,
 * the `scheme`, `urlTls`, `paste` and `seedCheck` of its `connection.connectionString`, each as the declaration states
 * it: a function as its name, which src/lib/db/connection-string/index.ts binds to Studio's own function.
 *
 * The editor facts answer, per engine, its execution UI, the keyword the rolled-back notice names and the consent card's
 * deadline (`editor.commitKeyword` and `editor.consentDeadline`), and, per alias, the engine each of its
 * `editor.fenceAliases` names. Every alias names one engine: an alias two declarations state, and an alias equal to
 * another declaration's engine id, are refused by name before any entry is built, the rules across a set of
 * declarations that admitting each declaration on its own cannot see. An alias equal to its own declaration's id, and
 * an alias that is a generic fence tag, are refused by the SDK's validator when the declaration is admitted.
 *
 * The query editor facts answer, per query dialect, the row its declarations state (`editor.dialect`), its tab type the
 * dialect's name; per tab type, the Monaco language its tabs render in (`editor.language.monacoId`), the tab type a
 * declaration's tabs open under being its dialect's name or, for a declaration with no dialect, its query language's
 * tab type; and per Monaco language, its accent and whether it is a console dialect (`editor.language.accent` and
 * `console`). Several declarations may state one dialect, one tab type or one language, and each must state it alike:
 * a dialect stated with different rows, a tab type stated in different languages and a language stated with a
 * different accent or console are refused by name, naming both engines, before any entry is built. The dialect, tab
 * type and Monaco language vocabularies are closed, so the SDK's validator refuses a value outside them.
 *
 * The SQL text answers, per engine, whether its statement text is SQL, its grammar facts, its update target words and
 * the names of its completion readers (`sqlText.readsSqlText`, `grammar`, `updateTarget` and `completion`), each as the
 * declaration states it: a clause as its source and flags, each word list a list, each function as its name, which
 * src/lib/db/sql-grammar/index.ts binds to Studio's own function when it composes each engine's grammar row. Its
 * `sqlText.redaction` is a claim, so it is never projected: src/lib/db/sql-grammar/redaction.ts is Studio's record of it.
 *
 * Every member a projection reads is one a declaration authors (scripts/generate-engine-catalog.ts,
 * `AUTHORED_MEMBERS`), so none reads anything the declaration generator writes, and none of them is a claim but the
 * confirmation gate's two, `sqlText.readsSqlText` and an exempt form of the grammar, which the gate counts only where
 * Studio's review record lists them (docs/providers/CONTRACT.md, clause S-8). Each
 * takes `AuthoredDeclaration`, those members alone: an admitted `EngineDeclaration` is one, and so are the authored
 * members the catalog generator's `--write` reads from a file whose generated members are not yet rewritten.
 *
 * The projections are pure: their keys are the ids in ascending code-unit order, so the same set gives the same answer
 * whatever order it is admitted in, and removing a declaration gives exactly what a fresh build from the rest gives.
 * Two declarations of one id are refused by name before any entry is built. Every record, row and member they answer
 * is frozen, and a copy: no list or record of a declaration is handed out.
 *
 * `scripts/generate-engine-catalog.ts` projects the committed declarations' authored members here and renders the
 * results into `catalog.generated.ts`, `connection.generated.ts`, `connection-flags.generated.ts`,
 * `connection-form.generated.ts`, `connection-string.generated.ts`, `editor.generated.ts`,
 * `query-editor.generated.ts` and `sql-text.generated.ts`, the modules Studio's readers read, and holds
 * each module to the projection of the set it admits through the SDK's validator. A loader that admits a provider
 * package at run time projects its set through these same functions.
 */
import type {
  ConnectBudget,
  CredentialWarning,
  Editor,
  EditorAccent,
  EngineDeclaration,
  EngineLocation,
  FieldName,
  HistoryMask,
  MonacoLanguageId,
  QueryDialect,
  QueryLanguage,
  SqlText,
} from "@libredb/provider-sdk/manifest";

type Connection = EngineDeclaration["connection"];
type ConnectionStringOffer = Connection["connectionString"];

/** The members of a declaration the projections read, every one a member the declaration authors. */
export interface AuthoredDeclaration {
  readonly id: string;
  readonly displayName: EngineDeclaration["displayName"];
  readonly location: EngineLocation;
  readonly connection: {
    readonly fields: Connection["fields"];
    readonly defaults: Connection["defaults"];
    readonly seedOnly: Connection["seedOnly"];
    readonly refused: Connection["refused"];
    readonly connectionString: {
      readonly accepted: ConnectionStringOffer["accepted"];
      readonly dialogOffersUri: ConnectionStringOffer["dialogOffersUri"];
      readonly scheme: ConnectionStringOffer["scheme"];
      readonly urlTls: ConnectionStringOffer["urlTls"];
      readonly paste: ConnectionStringOffer["paste"];
      readonly seedCheck: ConnectionStringOffer["seedCheck"];
    };
    readonly tls: Connection["tls"];
    readonly readsTrustMaterial: Connection["readsTrustMaterial"];
    readonly dialog: Connection["dialog"];
    readonly hostUriSchemes: Connection["hostUriSchemes"];
    readonly credentialWarnings: Connection["credentialWarnings"];
    readonly fieldRules: Connection["fieldRules"];
    readonly hostHint: Connection["hostHint"];
    readonly hostIdentity: Connection["hostIdentity"];
    readonly import: Connection["import"];
    readonly connectBudgetMs: Connection["connectBudgetMs"];
  };
  readonly editor: {
    readonly commitKeyword: Editor["commitKeyword"];
    readonly consentDeadline: Editor["consentDeadline"];
    readonly fenceAliases: Editor["fenceAliases"];
    readonly dialect: Editor["dialect"];
    readonly language: Editor["language"];
  };
  readonly sqlText: SqlTextEntry;
}

/**
 * One engine's SQL text as its declaration authors it: every member of the SDK's `SqlText` but its `redaction`, which
 * is a claim. A clause is its source and flags, each word list a list and each function its name.
 */
export interface SqlTextEntry {
  readonly readsSqlText: SqlText["readsSqlText"];
  readonly grammar: SqlText["grammar"];
  readonly updateTarget: SqlText["updateTarget"];
  readonly completion: SqlText["completion"];
}

/** The SQL text: one frozen entry per engine id, keyed in ascending code-unit order of the ids. */
export type SqlTexts = Readonly<Record<string, SqlTextEntry>>;

/** One engine's catalog entry: where the engine lives and its connect budget, null for the host's default. */
export interface CatalogEntry {
  readonly location: EngineLocation;
  readonly connectBudgetMs: ConnectBudget;
}

/** A catalog: one frozen entry per engine id, keyed in ascending code-unit order of the ids. */
export type EngineCatalog = Readonly<Record<string, CatalogEntry>>;

/**
 * The fields only one engine's provider reads, and how a seed of another type that carries one is refused: the
 * declaration's `connection.seedOnly`, its `scope` read as `kind`, and both sentences as the templates it states.
 */
export interface SeedOnlyTemplate {
  readonly fields: readonly FieldName[];
  /** "each": one refusal per present field; "set": one refusal for the whole set, at the first present field. */
  readonly kind: "each" | "set";
  /** The refusal sentence, in which `{field}` stands for the field refused. */
  readonly refusal: string;
  /** The projection gate's sentence, in which `{id}` and `{type}` stand for the connection's id and type, or null. */
  readonly projectionRefusal: string | null;
}

/** The data-only connection tables, each keyed in ascending code-unit order of the ids, frozen at every level. */
export interface ConnectionTables {
  readonly fields: Readonly<Record<string, readonly FieldName[]>>;
  readonly seedOnly: Readonly<Record<string, SeedOnlyTemplate | null>>;
  /**
   * Each refused field mapped to its sentence, in the order the declaration lists them, which is the order core
   * checks.
   */
  readonly refused: Readonly<Record<string, Readonly<Partial<Record<FieldName, string>>>>>;
  /** A row only for an engine that declares at least one warning. */
  readonly credentialWarnings: Readonly<Record<string, readonly CredentialWarning[]>>;
  readonly readsTrustMaterial: Readonly<Record<string, boolean>>;
  readonly connectionStringAccepted: Readonly<Record<string, boolean>>;
  readonly dialogOffersUri: Readonly<Record<string, boolean>>;
}

/**
 * One engine's connection form: its display name and the connection members its dialog reads, each as the declaration
 * states it, a function as its name. The SDK's types are read-only at every level, and the projection freezes them.
 */
export interface ConnectionFormEntry {
  readonly displayName: EngineDeclaration["displayName"];
  readonly defaults: Connection["defaults"];
  readonly tls: Connection["tls"];
  readonly dialog: Connection["dialog"];
  readonly hostUriSchemes: Connection["hostUriSchemes"];
  readonly fieldRules: Connection["fieldRules"];
  readonly hostHint: Connection["hostHint"];
  readonly hostIdentity: Connection["hostIdentity"];
  readonly import: Connection["import"];
}

/** The connection forms: one frozen entry per engine id, keyed in ascending code-unit order of the ids. */
export type ConnectionForms = Readonly<Record<string, ConnectionFormEntry>>;

/**
 * One engine's connection string: the scheme shown for it, and the names of its URL TLS reader, its paste reader with
 * its catch-all flag and formats, and its seed check, each as the declaration states it, a function as its name.
 */
export interface ConnectionStringEntry {
  readonly scheme: ConnectionStringOffer["scheme"];
  readonly urlTls: ConnectionStringOffer["urlTls"];
  readonly paste: ConnectionStringOffer["paste"];
  readonly seedCheck: ConnectionStringOffer["seedCheck"];
}

/** The connection strings: one frozen entry per engine id, keyed in ascending code-unit order of the ids. */
export type ConnectionStrings = Readonly<Record<string, ConnectionStringEntry>>;

/** One engine's execution UI: the keyword the rolled-back notice names, and the consent card's deadline or null. */
export interface ExecutionUiEntry {
  readonly commitKeyword: Editor["commitKeyword"];
  readonly consentDeadline: Editor["consentDeadline"];
}

/**
 * The editor facts: one frozen execution UI entry per engine id, keyed in ascending code-unit order of the ids, and one
 * frozen record mapping each fence alias to the engine id that declares it, keyed in ascending order of those ids and
 * then in each declaration's own order of its aliases.
 */
export interface EditorFacts {
  readonly executionUi: Readonly<Record<string, ExecutionUiEntry>>;
  readonly fenceAliases: Readonly<Record<string, string>>;
}

/**
 * One query dialect's row: the tab type its tabs open as, the dialect's name, and what the editor offers for it, every
 * member present, the history mask null where history keeps a statement as typed.
 */
export interface QueryDialectEntry {
  readonly tabType: QueryDialect;
  readonly offersColumnProfiling: boolean;
  readonly offersCodeGeneration: boolean;
  readonly offersCountQuery: boolean;
  readonly offersSqlExport: boolean;
  readonly historyMask: HistoryMask;
}

/** One tab type's editor: the Monaco language its tabs render in. */
export interface DialectEditorEntry {
  readonly monacoId: MonacoLanguageId;
}

/** One Monaco language's facts: the accent an agent answer's statement block takes, and whether it is a console. */
export interface EditorLanguageEntry {
  readonly accent: EditorAccent;
  readonly console: boolean;
}

/**
 * The query editor facts: one frozen row per stated query dialect, one frozen editor per tab type and one frozen entry
 * per stated Monaco language, each record keyed in ascending code-unit order of its keys.
 */
export interface QueryEditorFacts {
  readonly queryDialects: Readonly<Record<string, QueryDialectEntry>>;
  readonly dialectEditors: Readonly<Record<string, DialectEditorEntry>>;
  readonly editorLanguages: Readonly<Record<string, EditorLanguageEntry>>;
}

/**
 * The tab type a declaration with no query dialect opens its tabs under, per query language
 * (docs/providers/CONTRACT.md, clause S-23); a declaration with a dialect opens them under the dialect's name.
 */
const QUERY_LANGUAGE_TAB_TYPES: Readonly<Record<QueryLanguage, string>> = Object.freeze({
  sql: "sql",
  json: "mongodb",
  promql: "promql",
  cypher: "cypher",
  influxql: "influxql",
});

/**
 * `declarations` in ascending code-unit order of their ids.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
function inIdOrder(declarations: readonly AuthoredDeclaration[]): AuthoredDeclaration[] {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    if (seen.has(declaration.id)) throw new Error(`The engine id ${JSON.stringify(declaration.id)} is declared twice.`);
    seen.add(declaration.id);
  }
  return [...declarations].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * One frozen record over `ordered`, each declaration's value read by `read`, or no entry where `read` answers
 * undefined.
 */
function recordOf<Value>(
  ordered: readonly AuthoredDeclaration[],
  read: (declaration: AuthoredDeclaration) => Value | undefined,
): Readonly<Record<string, Value>> {
  const entries: [string, Value][] = [];
  for (const declaration of ordered) {
    const value = read(declaration);
    if (value !== undefined) entries.push([declaration.id, value]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * The catalog of `declarations`, frozen with every entry.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectCatalog(declarations: readonly AuthoredDeclaration[]): EngineCatalog {
  return recordOf(inIdOrder(declarations), (declaration) =>
    Object.freeze({ location: declaration.location, connectBudgetMs: declaration.connection.connectBudgetMs }),
  );
}

/** One credential warning, member by member in one order for every engine, frozen with its access list. */
function warningOf(warning: CredentialWarning): CredentialWarning {
  switch (warning.kind) {
    case "pair":
      return Object.freeze({
        kind: warning.kind,
        user: warning.user,
        password: warning.password,
        message: warning.message,
      });
    case "jwt":
      return Object.freeze({
        kind: warning.kind,
        noExp: warning.noExp,
        access: Object.freeze([...warning.access]),
        message: warning.message,
      });
    case "no-secret":
      return Object.freeze({ kind: warning.kind, message: warning.message });
  }
}

/**
 * The data-only connection tables of `declarations`, each read from the members every declaration authors.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectConnectionTables(declarations: readonly AuthoredDeclaration[]): ConnectionTables {
  const ordered = inIdOrder(declarations);
  return Object.freeze({
    fields: recordOf(ordered, ({ connection }) => Object.freeze([...connection.fields])),
    seedOnly: recordOf(ordered, ({ connection: { seedOnly } }) =>
      seedOnly === null
        ? null
        : Object.freeze({
            fields: Object.freeze([...seedOnly.fields]),
            kind: seedOnly.scope,
            refusal: seedOnly.refusal,
            projectionRefusal: seedOnly.projectionRefusal,
          }),
    ),
    refused: recordOf(ordered, ({ connection }) =>
      Object.freeze(Object.fromEntries(connection.refused.map(({ field, refusal }) => [field, refusal]))),
    ),
    credentialWarnings: recordOf(ordered, ({ connection: { credentialWarnings } }) =>
      credentialWarnings.length === 0
        ? undefined
        : Object.freeze(credentialWarnings.map((warning) => warningOf(warning))),
    ),
    readsTrustMaterial: recordOf(ordered, ({ connection }) => connection.readsTrustMaterial),
    connectionStringAccepted: recordOf(ordered, ({ connection }) => connection.connectionString.accepted),
    dialogOffersUri: recordOf(ordered, ({ connection }) => connection.connectionString.dialogOffersUri),
  });
}

/**
 * A frozen copy of `value`, a member of a parsed declaration: each list and record copied in its own order and frozen,
 * each string, number, boolean and null as it is.
 */
function frozenCopy<Value>(value: Value): Value {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => frozenCopy(item))) as Value;
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([member, inner]) => [member, frozenCopy(inner)])),
    ) as Value;
  }
  return value;
}

/**
 * The connection forms of `declarations`, each entry read from the members every declaration authors.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectConnectionForms(declarations: readonly AuthoredDeclaration[]): ConnectionForms {
  return recordOf(inIdOrder(declarations), ({ displayName, connection }) =>
    frozenCopy<ConnectionFormEntry>({
      displayName,
      defaults: connection.defaults,
      tls: connection.tls,
      dialog: connection.dialog,
      hostUriSchemes: connection.hostUriSchemes,
      fieldRules: connection.fieldRules,
      hostHint: connection.hostHint,
      hostIdentity: connection.hostIdentity,
      import: connection.import,
    }),
  );
}

/**
 * The connection strings of `declarations`, each entry read from the members every declaration authors.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectConnectionStrings(declarations: readonly AuthoredDeclaration[]): ConnectionStrings {
  return recordOf(inIdOrder(declarations), ({ connection: { connectionString } }) =>
    frozenCopy<ConnectionStringEntry>({
      scheme: connectionString.scheme,
      urlTls: connectionString.urlTls,
      paste: connectionString.paste,
      seedCheck: connectionString.seedCheck,
    }),
  );
}

/**
 * Each fence alias of `ordered` mapped to the engine id that declares it, in `ordered`'s order and then each
 * declaration's own order of its aliases.
 *
 * @throws {Error} When an alias is another declaration's engine id, naming the alias and its engine; when one
 * declaration states one alias twice, naming the alias and its engine; and when two declarations state one alias,
 * naming the alias and both engines in ascending id order.
 */
function fenceAliasesOf(ordered: readonly AuthoredDeclaration[]): Readonly<Record<string, string>> {
  const ids = new Set(ordered.map(({ id }) => id));
  const engines = new Map<string, string>();
  for (const { id, editor } of ordered) {
    for (const alias of editor.fenceAliases) {
      if (alias !== id && ids.has(alias)) {
        throw new Error(
          `The fence alias ${JSON.stringify(alias)} of ${id} is the engine id of another admitted declaration.`,
        );
      }
      const earlier = engines.get(alias);
      if (earlier === id) {
        throw new Error(`The fence alias ${JSON.stringify(alias)} of ${id} is stated twice by its declaration.`);
      }
      if (earlier !== undefined) {
        throw new Error(`The fence alias ${JSON.stringify(alias)} is declared by both ${earlier} and ${id}.`);
      }
      engines.set(alias, id);
    }
  }
  return Object.freeze(Object.fromEntries(engines));
}

/**
 * The editor facts of `declarations`, each read from the members every declaration authors.
 *
 * @throws {Error} When two declarations state the same `id`, naming it; when a fence alias is another declaration's
 * engine id, naming the alias and its engine; when one declaration states one fence alias twice, naming the alias and
 * its engine; and when two declarations state one fence alias, naming the alias and both engines.
 */
export function projectEditorFacts(declarations: readonly AuthoredDeclaration[]): EditorFacts {
  const ordered = inIdOrder(declarations);
  const fenceAliases = fenceAliasesOf(ordered);
  return Object.freeze({
    executionUi: recordOf(ordered, ({ editor }) =>
      frozenCopy<ExecutionUiEntry>({ commitKeyword: editor.commitKeyword, consentDeadline: editor.consentDeadline }),
    ),
    fenceAliases,
  });
}

/** A frozen record of `entries`, keyed in ascending code-unit order of their keys. */
function inKeyOrder<Value>(entries: ReadonlyMap<string, Value>): Readonly<Record<string, Value>> {
  return Object.freeze(Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** The statements of one kind of query editor fact, each value under its key with the first declaration stating it. */
type Statements<Value> = Map<string, { readonly value: Value; readonly id: string }>;

/**
 * Records `value` under `key` in `stated`, the entry the declaration `id` states, or refuses it by name when an earlier
 * declaration stated another value under that key. Values are compared member by member, lists in their order, through
 * their JSON text: each value is built member by member in one order, so equal statements have equal text.
 *
 * @throws {Error} Naming the `subject` and its key, what differs (`difference`), the earlier declaration and `id`.
 */
function stateOnce<Value>(
  stated: Statements<Value>,
  { key, value, id }: { readonly key: string; readonly value: Value; readonly id: string },
  subject: string,
  difference: string,
): void {
  const earlier = stated.get(key);
  if (earlier === undefined) {
    stated.set(key, { value, id });
    return;
  }
  if (JSON.stringify(earlier.value) !== JSON.stringify(value)) {
    throw new Error(`The ${subject} ${JSON.stringify(key)} is stated ${difference} by ${earlier.id} and ${id}.`);
  }
}

/** The values of `stated`, each under its key. */
function valuesOf<Value>(stated: ReadonlyMap<string, { readonly value: Value }>): Map<string, Value> {
  return new Map([...stated].map(([key, { value }]) => [key, value]));
}

/** The dialect row `dialect` states, frozen, member by member in one order, its flag list copied. */
function dialectEntryOf(dialect: NonNullable<Editor["dialect"]>): QueryDialectEntry {
  return frozenCopy<QueryDialectEntry>({
    tabType: dialect.name,
    offersColumnProfiling: dialect.offersColumnProfiling,
    offersCodeGeneration: dialect.offersCodeGeneration,
    offersCountQuery: dialect.offersCountQuery,
    offersSqlExport: dialect.offersSqlExport,
    historyMask: dialect.historyMask === null ? null : { credentialFlags: dialect.historyMask.credentialFlags },
  });
}

/**
 * The query editor facts of `declarations`, each read from `editor.dialect` and `editor.language`, members every
 * declaration authors.
 *
 * @throws {Error} When two declarations state the same `id`, naming it; and, declarations taken in ascending id order,
 * when a later one states a dialect with another row, a tab type in another language or a language with another accent
 * or console than an earlier one, naming the dialect, tab type or language and both engines.
 */
export function projectQueryEditorFacts(declarations: readonly AuthoredDeclaration[]): QueryEditorFacts {
  const dialects: Statements<QueryDialectEntry> = new Map();
  const editors: Statements<DialectEditorEntry> = new Map();
  const languages: Statements<EditorLanguageEntry> = new Map();
  for (const { id, editor } of inIdOrder(declarations)) {
    const { dialect, language } = editor;
    if (dialect !== null) {
      stateOnce(dialects, { key: dialect.name, value: dialectEntryOf(dialect), id }, "dialect", "with different rows");
    }
    const tabType = dialect === null ? QUERY_LANGUAGE_TAB_TYPES[language.queryLanguage] : dialect.name;
    const tabEditor = Object.freeze({ monacoId: language.monacoId });
    stateOnce(editors, { key: tabType, value: tabEditor, id }, "tab type", "in different editor languages");
    const facts = Object.freeze({ accent: language.accent, console: language.console });
    stateOnce(
      languages,
      { key: language.monacoId, value: facts, id },
      "editor language",
      "with a different accent or console",
    );
  }
  return Object.freeze({
    queryDialects: inKeyOrder(valuesOf(dialects)),
    dialectEditors: inKeyOrder(valuesOf(editors)),
    editorLanguages: inKeyOrder(valuesOf(languages)),
  });
}

/**
 * The SQL text of `declarations`, each entry read from `sqlText.readsSqlText`, `grammar`, `updateTarget` and
 * `completion`, members every declaration authors, the grammar in the declaration's own member order. No entry holds
 * the declaration's `sqlText.redaction`: it is a claim, and Studio's record of it is src/lib/db/sql-grammar/redaction.ts.
 *
 * @throws {Error} When two declarations state the same `id`, naming it.
 */
export function projectSqlText(declarations: readonly AuthoredDeclaration[]): SqlTexts {
  return recordOf(inIdOrder(declarations), ({ sqlText }) =>
    frozenCopy<SqlTextEntry>({
      readsSqlText: sqlText.readsSqlText,
      grammar: sqlText.grammar,
      updateTarget: sqlText.updateTarget,
      completion: sqlText.completion,
    }),
  );
}
