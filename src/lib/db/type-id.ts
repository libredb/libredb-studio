/**
 * The one check of a connection's `type` against the `DatabaseType` union (FND-1).
 *
 * A record read from storage or from a request may carry any value in `type`: a connection saved by a newer Studio that
 * shares the same server storage, a hand-edited record, one with no type at all, or one whose type is not text. A value
 * that is not exactly a type id is refused by name, never normalised (no trimming, no lowercasing).
 *
 * The provider factory, `resolveConnection`, the `db-ui-config` lookups, the Studio connection lists, the connection
 * hook, the embedded workspace's connection adapter and the connection form hook ask this module first; so do the five
 * contract registry lookups and the query generators' SQL engine rows (through `typeIdRow`) and the migration's dialect
 * header, and the published
 * `QuerySafetyDialog`, `TestDataGenerator`, `QueryEditor` and `ResultsGrid`, the components that read a per-engine fact
 * with a type a host hands them. The capability tables are read through `typeIdRow` as well: `GRANTED_WRITE_REACH` by
 * the read-only marker and the connection form hook and `GRANTED_SSH_TUNNEL_REFUSAL` by the connection dialog (each
 * Studio's grant of a claim, ./claim-grants); `CONNECTION_FORM` by `offersSslPanel`, and the destructive vocabulary by
 * its six readers. The open check (./open-check), core's tunnel decision (./tunnel-decision), the provider factory's
 * other reads of a grant, the provider cache key, `clientCapabilities`, `catalogChoice`, the provider's fields, the
 * file and host path admissions, the session capacity class and the seed schema's grant refusals read none of these
 * tables: they read the grants of the engine's record (`EngineRecord` in ./server-catalog), which they look up through
 * `legacyProviderEngine` or `servedEngineRecord`, and which refuse a value naming no engine with this module's
 * sentence. Other reads are still by bare index, of other per-engine tables and of some of these (the VS Code backend's
 * `CONNECTION_FORM` reads), so a new per-engine lookup is not covered by this module unless it calls it.
 *
 * `compatibility.ts` never imports this module: the set below is built from `SHIPPED_DATABASE_TYPES` as this module
 * loads, so a value import back would throw a `ReferenceError` whenever `compatibility.ts` loads first. So no checked
 * accessor can live there: its tables are checked where they are read, through `typeIdRow`.
 *
 * The set is `SHIPPED_DATABASE_TYPES`, the engine catalog's ids, which the compiler holds to the union through the
 * catalog's generated `Record<DatabaseType, CatalogEntry>`, so this module has no list of its own. Membership is a
 * `Set` lookup, so a prototype key such as `"constructor"` is unknown rather than answered by `Object.prototype`.
 */
import { quoteOneLine } from "@/lib/one-line-quote";
import type { DatabaseType } from "@/lib/types";
import { SHIPPED_DATABASE_TYPES } from "./compatibility";
import { type TypeIdRefusal, UnknownProviderError } from "./errors";

export type { TypeIdRefusal } from "./errors";

const TYPE_IDS: ReadonlySet<string> = new Set(SHIPPED_DATABASE_TYPES);

/** The refusal of a connection whose `type` is missing, `null` or empty. */
export const ABSENT_TYPE_SENTENCE = "This connection names no type, so no provider in this LibreDB Studio can open it.";

/**
 * The refusal of a connection whose `type` is present and not a string: a number, a boolean, an array or an object.
 * It quotes nothing, so a value that is not text is never repeated in a sentence or a log line.
 */
export const MALFORMED_TYPE_SENTENCE =
  "This connection's type is not text, so it is not a type id, and no provider in this LibreDB Studio can open it.";

/**
 * A type value quoted for a sentence or a log line by `quoteOneLine` (src/lib/one-line-quote.ts): one line, in reading
 * order, not truncated.
 */
export function quoteTypeId(typeId: string): string {
  return quoteOneLine(typeId);
}

/**
 * The refusal of a connection whose `type` names no provider, with the value quoted by `quoteTypeId`. The error that
 * carries it keeps the value as given in `typeId`.
 */
export function unknownTypeSentence(typeId: string): string {
  return `No provider for the connection type ${quoteTypeId(typeId)} is installed in this LibreDB Studio.`;
}

/** Whether `value` is exactly one of the type ids this Studio has a provider for. */
export function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === "string" && TYPE_IDS.has(value);
}

/** `null` for a type id, otherwise why the value is refused and the sentence that says so. */
export function typeIdRefusal(value: unknown): TypeIdRefusal | null {
  if (isDatabaseType(value)) return null;
  if (value === undefined || value === null || value === "")
    return { reason: "absent", sentence: ABSENT_TYPE_SENTENCE };
  if (typeof value !== "string") return { reason: "malformed", sentence: MALFORMED_TYPE_SENTENCE };
  return { reason: "unknown", typeId: value, sentence: unknownTypeSentence(value) };
}

/**
 * Refuses a value that is not a type id with `UnknownProviderError`.
 *
 * @throws {UnknownProviderError} When `value` is absent, not text, or names no provider.
 */
export function assertDatabaseType(value: unknown): asserts value is DatabaseType {
  const refusal = typeIdRefusal(value);
  if (refusal !== null) throw new UnknownProviderError(refusal);
}

/**
 * The refusal of a published component handed a connection's capabilities without the connection's type. An SQL
 * engine's own identifier quoting and forms, and a document language's insert, are read by the type, so the
 * declaration alone cannot say how to write for its engine.
 */
export const UNTYPED_CAPABILITIES_SENTENCE =
  "This connection's capabilities were handed over without its type, and the call needs the connection's type (databaseType) to write for its engine.";

/**
 * Why a published component cannot write for the connection a host describes with `databaseType` and `capabilities`,
 * or `null` when it can: a type id, with or without capabilities, or neither value, which is no connection open.
 * Capabilities without a type are refused as `absent` with `UNTYPED_CAPABILITIES_SENTENCE`; any other type as
 * `typeIdRefusal` refuses it.
 */
export function connectionTypeRefusal(databaseType: unknown, capabilities: unknown): TypeIdRefusal | null {
  if (databaseType === undefined) {
    return capabilities === undefined ? null : { reason: "absent", sentence: UNTYPED_CAPABILITIES_SENTENCE };
  }
  return typeIdRefusal(databaseType);
}

/**
 * Refuses, with `UnknownProviderError`, the connection `connectionTypeRefusal` refuses.
 *
 * @throws {UnknownProviderError} When capabilities come without a type, or the type is not a type id.
 */
export function assertConnectionType(databaseType: unknown, capabilities: unknown): void {
  const refusal = connectionTypeRefusal(databaseType, capabilities);
  if (refusal !== null) throw new UnknownProviderError(refusal);
}

/**
 * Reads `table`'s row for `value` after `assertDatabaseType`, so a value that is not a type id is refused by name
 * before the table is read, and a prototype key such as `"constructor"` never reaches an `Object.prototype` member. It
 * reads only a table's own rows: a total table answers its row, and a partial table answers `undefined` for a type id
 * it holds no row of its own for. The table is an argument, so any module holding a per-engine table reads it through
 * this one function.
 *
 * @throws {UnknownProviderError} When `value` is absent, not text, or names no provider.
 */
export function typeIdRow<T extends Readonly<Partial<Record<DatabaseType, unknown>>>>(
  table: T,
  value: unknown,
): T[DatabaseType] {
  assertDatabaseType(value);
  return Object.hasOwn(table, value) ? table[value] : undefined;
}
