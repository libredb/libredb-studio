import type { ProviderCapabilities } from "@/lib/db/types";
import type { QueryTab } from "@/lib/types";

/**
 * The dialect registry: what each query dialect a provider may declare means for the editor's readers.
 *
 * A dialect is JSON or a command line that is not MongoDB's JSON (Redis, LibreDB, Kafka, etcd), so every reader
 * keyed on the language alone would treat its text as a MongoDB document, which is the #427 class. Before this
 * module each reader carried an arm per dialect, about twenty of them, and a missed arm made a tree click
 * auto-run a MongoDB `find`. Each dialect is now one record here, one in `DIALECT_EDITORS`
 * (`src/lib/editor/dialect-editors.ts`) and one in the query generators' `DIALECT_GENERATORS`, and each is a
 * `Record` over the union, so a new member of `ProviderCapabilities.queryDialect` does not compile until all three
 * exist. `tests/unit/lib/dialect-reader-allowlist.test.ts` holds every other reader of the two fields to a closed
 * list with its owner.
 *
 * Pure and browser-safe: the row menus, the editor and the server routes all read it. Not published:
 * `src/exports/` does not name it.
 */
export type QueryDialect = NonNullable<ProviderCapabilities["queryDialect"]>;

/** One dialect's answers to the readers that used to branch on it. */
export interface DialectSpec {
  /** The tab type a connection declaring this dialect opens its tabs as (`resolveTabType`). */
  readonly tabType: QueryTab["type"];
  /** Whether Profile is offered, read only where the language is JSON (`offersColumnProfiling`). */
  readonly offersColumnProfiling: boolean;
  /** Whether the code generator is offered (`offersCodeGeneration`). */
  readonly offersCodeGeneration: boolean;
  /** Whether Generate Count Query is offered, read for every language (`offersCountQuery`). */
  readonly offersCountQuery: boolean;
  /**
   * Whether the result export menu offers SQL `INSERT` and `CREATE TABLE` DDL (`offersSqlExport` in
   * `src/lib/db/types.ts`). Absent means it does, which is every record today, so no shipped engine's menu changes.
   */
  readonly offersSqlExport?: boolean;
}

/**
 * Today's answers, each exactly what the per-dialect arms gave before the registry: Redis and LibreDB keep the
 * code generator because it names a row rather than addressing it (#427), Kafka's topic columns and etcd's group
 * columns are the fixed shape of a read result and model nothing an application stores (#1088, #1089), and no
 * dialect has a profile statement or a count statement in its grammar. Kafka renders in Monaco's built-in `json`
 * mode, which `DIALECT_EDITORS` says, and not here: this record is keyed by dialect, that one by tab type.
 */
export const QUERY_DIALECTS: Readonly<Record<QueryDialect, DialectSpec>> = Object.freeze({
  libredb: Object.freeze({
    tabType: "libredb",
    offersColumnProfiling: false,
    offersCodeGeneration: true,
    offersCountQuery: false,
  }),
  redis: Object.freeze({
    tabType: "redis",
    offersColumnProfiling: false,
    offersCodeGeneration: true,
    offersCountQuery: false,
  }),
  kafka: Object.freeze({
    tabType: "kafka",
    offersColumnProfiling: false,
    offersCodeGeneration: false,
    offersCountQuery: false,
  }),
  etcd: Object.freeze({
    tabType: "etcd",
    offersColumnProfiling: false,
    offersCodeGeneration: false,
    offersCountQuery: false,
  }),
});

/**
 * The dialect a declaration names, when this registry has a record for it.
 *
 * Undefined both when no dialect is declared and when the declared one has no record. Only a host's own
 * declaration to `StudioWorkspace` can carry the second, since every shipped provider's dialect is a member of the
 * union; it is looked up as an own key, so a name such as `constructor` finds nothing either, and each reader
 * keeps the answer it gave such a declaration before the registry existed (`declaresDialect` tells the two apart).
 * A value that is not a string finds nothing too: nothing checks a host's declaration against the union at run
 * time, and an own-key lookup would coerce `["kafka"]` to `kafka` and throw on an object whose `toString` is not
 * callable, where every per-dialect comparison before the registry simply missed.
 */
export function registeredDialect(capabilities: ProviderCapabilities | undefined): QueryDialect | undefined {
  const dialect: unknown = capabilities?.queryDialect;
  return typeof dialect === "string" && Object.hasOwn(QUERY_DIALECTS, dialect) ? (dialect as QueryDialect) : undefined;
}

/** The registry record of the dialect a declaration names, or undefined as `registeredDialect` is. */
export function dialectSpec(capabilities: ProviderCapabilities | undefined): DialectSpec | undefined {
  const dialect = registeredDialect(capabilities);
  return dialect === undefined ? undefined : QUERY_DIALECTS[dialect];
}

/** Whether a declaration names any dialect at all, a registered one or not. */
export function declaresDialect(capabilities: ProviderCapabilities | undefined): boolean {
  return capabilities?.queryDialect !== undefined;
}
