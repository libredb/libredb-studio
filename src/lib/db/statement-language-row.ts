import type { OperationReaderKind, StatementLanguageData } from "@libredb/provider-sdk/manifest";
import type { EngineGrants } from "@/lib/db/claim-grants";
import type { DestructiveVocabulary, OperationReader } from "@/lib/db/destructive-vocabulary";
import type { TypedConfirmationAsk } from "@/lib/db/types";

/**
 * One engine's statement language row, and the confirmation gate's readers of it, the row the gate is handed with the
 * statement and never looks up: what the row's reader names, whether the row is the gate's whole answer, what the row
 * asks the person to type, the console text bound it states and why it refuses a text.
 *
 * A row has the shape `DestructiveVocabulary` in `./destructive-vocabulary.ts` states. Null is no row: the engine's
 * statements are SQL, or it states no SQL text and no statement language data, and the gate reads them under its
 * grammar or asks about every one.
 * `statementLanguageRow` is the one answer to which row an engine has: the row compiled from the statement language
 * data its declaration states, else Studio's code row of a legacy engine whose language is still a module of Studio's,
 * else none. Both composers of the server's engine records call it, so a record holds its row (`EngineRecord` in
 * `./server-catalog.ts`). This module imports nothing but types and names no engine and no language, so the gate reads
 * every engine's row through the same steps, in the browser and on the server.
 */

/**
 * Core's engine-neutral operation readers, by the kind a statement language's data names (`OperationReaderKind` of
 * the manifest schema). `names-no-operation` reads a request language whose statements name no operation, so it names
 * none for any text.
 */
const OPERATION_READERS: Readonly<Record<OperationReaderKind, OperationReader>> = Object.freeze({
  "names-no-operation": () => [],
});

/**
 * The row compiled from statement language data `data` engine `engine` declares: its operations as a frozen set, core's
 * reader of the kind it names, its decides-alone claim as declared, `safetyAnalysis: false` only where it declares
 * false, since the row's shape reads an absent key as sending, and `maxTextBytes` only where it states a bound. The row
 * states no typed confirmation and no refusal, which the data cannot state. A frozen `Set` still answers `add`: its
 * type is `ReadonlySet` and no reader writes it.
 *
 * @throws {Error} Naming the engine and the kind, a host defect, for a reader kind core does not hold: the manifest
 * schema's enum holds only core's kinds, so an admitted declaration never names another.
 */
function compiledRow(engine: string, data: NonNullable<StatementLanguageData>): DestructiveVocabulary {
  const { operations, reader, decidesAlone, safetyAnalysis, maxTextBytes } = data.confirmation;
  if (!Object.hasOwn(OPERATION_READERS, reader)) {
    throw new Error(
      `The engine ${JSON.stringify(engine)} declares the operation reader kind ${JSON.stringify(reader)}, which core does not hold: a host defect, since admission validates the kind against the manifest schema.`,
    );
  }
  return Object.freeze({
    operations: Object.freeze(new Set(operations)),
    read: OPERATION_READERS[reader],
    decidesAlone,
    ...(safetyAnalysis ? {} : { safetyAnalysis: false as const }),
    ...(maxTextBytes === null ? {} : { maxTextBytes }),
  });
}

/**
 * Engine `engine`'s statement language row: the row compiled from `declared`, the statement language data its
 * declaration states, where that is not null; else `codeRow`, Studio's code row of a legacy engine whose language is
 * still a module of Studio's (`codeStatementLanguageRow` in `./destructive-commands.ts`); else null, where the engine's
 * statements are SQL or it states no SQL text.
 *
 * The legacy composer hands the data its declaration states, projected into `BUNDLED_STATEMENT_LANGUAGE_DATA`, through
 * `typeStatementLanguageRow` in `./destructive-commands.ts`, and the package composer hands no code row, since Studio
 * holds none of a package's engine. What the row's claims count for is the engine's record's grants, read by the gate
 * (`rowDecidesAlone`); this grants nothing.
 *
 * @throws {Error} Naming the engine, a host defect, where both are present: Studio holds a code row only for an engine
 * whose declaration states no data. Naming the engine and the kind, for a reader kind core does not hold.
 */
export function statementLanguageRow(
  engine: string,
  declared: StatementLanguageData,
  codeRow: DestructiveVocabulary | null,
): DestructiveVocabulary | null {
  if (declared !== null && codeRow !== null) {
    throw new Error(
      `The engine ${JSON.stringify(engine)} declares its statement language as data and Studio also holds a code row for it: a host defect, since the change that writes a language as data deletes its code row.`,
    );
  }
  if (declared !== null) return compiledRow(engine, declared);
  return codeRow;
}

/**
 * The grants of an engine's record the confirmation gate reads (`EngineGrants` in `./claim-grants.ts`): whether its
 * register row reviewed the grammar it declares, and the grant of each claim that loosens the gate for that grammar.
 */
export type GateGrants = Pick<EngineGrants, "reviewedGrammar" | "readsSqlText" | "confirmExemptForms" | "decidesAlone">;

/**
 * Whether `row`'s reader names an operation the row asks about in `statement`, handed as it was written: true where
 * the reader cannot tell what would run (`undefined`), false where it names none of the row's operations, and false
 * for no row.
 */
export function rowNamesAsked(row: DestructiveVocabulary | null, statement: string): boolean {
  if (row === null) return false;
  const named = row.read(statement);
  if (named === undefined) return true;
  return named.some((name) => row.operations.has(name));
}

/**
 * Whether `row` is the gate's whole answer: the row claims it (`decidesAlone`) and `grants`, the engine's record's
 * grants, grant that claim. A claim the grants leave out is read as if the row had not made it, so the gate reads the
 * text as SQL and reads the row beside it. False for no row.
 */
export function rowDecidesAlone(row: DestructiveVocabulary | null, grants: GateGrants): boolean {
  return row !== null && row.decidesAlone && grants.decidesAlone;
}

/**
 * What `row` asks the person to type before `statement` runs, or undefined where the row asks nothing typed, or for
 * no row (#1089, section 5.5). The text reaches the row as it was written.
 */
export function rowTypedAsk(row: DestructiveVocabulary | null, statement: string): TypedConfirmationAsk | undefined {
  return row?.typedConfirmation?.(statement);
}

/** The console text bound `row` states, in UTF-8 bytes, or undefined where it states none, and for no row. */
export function rowTextByteLimit(row: DestructiveVocabulary | null): number | undefined {
  return row?.maxTextBytes;
}

/**
 * The UTF-8 length of a text, counted without encoding it: a surrogate pair is one code point of four bytes, and a
 * lone surrogate counts three, as `TextEncoder` and `Buffer.byteLength` write it as U+FFFD.
 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** The sentence a text over `limit` bytes is refused with, naming its size and the bound and never quoting it. */
export function consoleTextOverLimit(text: string, limit: number): string | undefined {
  const bytes = utf8Bytes(text);
  if (bytes <= limit) return undefined;
  return `The statement is ${bytes} bytes in UTF-8, over the ${limit}-byte limit for this connection type. Shorten it to run it.`;
}

/**
 * Why `row` refuses `text`, or undefined to send it: the row's text bound first, so the row's own verdict never reads
 * an oversize text, then the row's `refuse`. Undefined for no row, and for a row that states neither.
 */
export function rowRefusal(row: DestructiveVocabulary | null, text: string): string | undefined {
  if (row === null) return undefined;
  if (row.maxTextBytes !== undefined) {
    const over = consoleTextOverLimit(text, row.maxTextBytes);
    if (over !== undefined) return over;
  }
  return row.refuse?.(text);
}
