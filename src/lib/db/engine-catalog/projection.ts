/**
 * Studio's engine catalog and its data-only connection tables as projections of a set of admitted engine declarations
 * (docs/providers/CONTRACT.md, clauses M-70 and M-71).
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
 * Every member either projection reads is one a declaration authors (scripts/generate-engine-catalog.ts,
 * `AUTHORED_MEMBERS`), so neither reads anything the declaration generator writes, and none of them is a claim. Each
 * takes `AuthoredDeclaration`, those members alone: an admitted `EngineDeclaration` is one, and so are the authored
 * members the catalog generator's `--write` reads from a file whose generated members are not yet rewritten.
 *
 * Both projections are pure: their keys are the ids in ascending code-unit order, so the same set gives the same
 * answer whatever order it is admitted in, and removing a declaration gives exactly what a fresh build from the rest
 * gives. Two declarations of one id are refused by name before any entry is built. Every record, row and member they
 * answer is frozen.
 *
 * `scripts/generate-engine-catalog.ts` projects the committed declarations' authored members here and renders the
 * results into `catalog.generated.ts`, `connection.generated.ts` and `connection-flags.generated.ts`, the modules
 * Studio's readers read, and holds each module to the projection of the set it admits through the SDK's validator. A
 * loader that admits a provider package at run time projects its set through these same functions.
 */
import type {
  ConnectBudget,
  CredentialWarning,
  EngineDeclaration,
  EngineLocation,
  FieldName,
} from "@libredb/provider-sdk/manifest";

type Connection = EngineDeclaration["connection"];

/** The members of a declaration the projections read, every one a member the declaration authors. */
export interface AuthoredDeclaration {
  readonly id: string;
  readonly location: EngineLocation;
  readonly connection: {
    readonly fields: Connection["fields"];
    readonly seedOnly: Connection["seedOnly"];
    readonly refused: Connection["refused"];
    readonly connectionString: {
      readonly accepted: Connection["connectionString"]["accepted"];
      readonly dialogOffersUri: Connection["connectionString"]["dialogOffersUri"];
    };
    readonly readsTrustMaterial: Connection["readsTrustMaterial"];
    readonly credentialWarnings: Connection["credentialWarnings"];
    readonly connectBudgetMs: Connection["connectBudgetMs"];
  };
}

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
