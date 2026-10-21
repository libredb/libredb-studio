/**
 * The engine-neutral helpers the result export's SQL forms share across engines: reading
 * a binary cell, writing a value as JSON text, the binary literal forms, and the parsers
 * the typed-literal grammars read a declared type with.
 *
 * A leaf one level above `./shared`: it imports that module, the non-finite words and
 * types, and nothing from the export path or any registry, so an engine module can import
 * it first in a fresh process (spec 5.3).
 */
import { isNonFiniteWord, nonFiniteWord, type NonFiniteWord } from "@/lib/non-finite";
import { literalBackslash } from "./shared";

/**
 * A cell the dialect has no literal for: a composite whose value does not have the shape
 * its declared type says (a tuple of the wrong length, a scalar where a list belongs).
 * Thrown rather than written in the generic form, because that form is exactly what the
 * engine refuses on replay, and one refused statement stops the whole file; the caller
 * skips the row with a comment instead.
 */
export class UnwritableValue extends Error {}

function isByte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * `value` as its bytes, or `undefined` when it is not a binary value.
 *
 * Two shapes, because two paths reach the grid: the HTTP path hands the JSON that
 * a `Buffer` serialized to, and the embeddable shell
 * (`src/workspace/StudioWorkspace.tsx`) hands the live object the host passed in.
 * A real `Buffer` IS a `Uint8Array`, so one check covers both live forms.
 *
 * Every element is checked rather than the first, because the whole point of the
 * shape test is that a user's own document may carry a `type` field: a row of
 * `{type: "Buffer", data: [1, "two"]}` is a document, and turning it into bytes
 * would lose it as surely as the defect this fixes.
 */
export function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as { type?: unknown; data?: unknown };
  if (candidate.type !== "Buffer" || !Array.isArray(candidate.data)) return undefined;
  if (!candidate.data.every(isByte)) return undefined;
  return Uint8Array.from(candidate.data as number[]);
}

/**
 * Every byte of `bytes` as hex. What the detail sheet and the exported file write.
 *
 * The text is lowercase hex behind `\x`: the escape form a `bytea` column's own
 * output uses, so it is recognisable on sight and can be pasted back into a
 * statement. Base64 is shorter and neither.
 */
export function binaryText(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

/** What stands in for a value that contains itself. */
const CIRCULAR_PLACEHOLDER = "[Circular]";

/**
 * `value` rebuilt as something `JSON.stringify` cannot throw on.
 *
 * `ancestors` is the chain of containers this value sits INSIDE, not every container
 * already seen: the same object referenced twice under different keys is ordinary in
 * a result set, and reporting it as a cycle would corrupt the second copy.
 *
 * `toJSON` is honoured first and its result walked, which is how `JSON.stringify`
 * itself treats a `Date` or a BSON value — dropping it would turn a timestamp into
 * `{}`.
 */
function jsonSafe(value: unknown, ancestors: readonly object[]): unknown {
  if (typeof value === "bigint") return value.toString();
  // Not a throw but a silent change: `JSON.stringify` writes NaN and the infinities as
  // `null`, which the file's reader takes for SQL NULL. The word survives instead.
  if (typeof value === "number") return nonFiniteWord(value) ?? value;
  if (value === null || typeof value !== "object") return value;

  const custom = (value as { toJSON?: unknown }).toJSON;
  if (typeof custom === "function") return jsonSafe((custom as () => unknown).call(value), ancestors);

  if (ancestors.includes(value)) return CIRCULAR_PLACEHOLDER;
  const inside = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, inside));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item, inside);
  return out;
}

/**
 * `value` as JSON text, for a value that may hold anything: the one JSON serializer the
 * export path uses.
 *
 * `JSON.stringify` THROWS on two values an export can genuinely be handed, and it
 * throws out of the click handler that started the export: no file, no toast, and
 * nothing in the UI to say why. Both arrive through the embeddable shell
 * (`src/workspace/StudioWorkspace.tsx`), where the rows are live JavaScript objects
 * the host passed in rather than a parsed HTTP response:
 *
 * 1. A `BigInt` anywhere inside a value — what `mysql2` with `supportBigNumbers`, a
 *    `bun:sqlite` with safe integers, or a Mongo `Long` can hand back. Written as its
 *    decimal digits in a string, which is lossless as text; a JSON number would not
 *    be past 2^53.
 * 2. A cycle. A document that references itself has no JSON form at all, so the cycle
 *    is named rather than followed, and every acyclic part of the value survives.
 *
 * An export that writes SOMETHING for a value it cannot represent exactly is worth
 * more than one that writes nothing and reports nothing — and a value this rare is
 * better labelled in the file than left to a stack trace in the console.
 *
 * `indent` is passed to `JSON.stringify`, so 0 (the default) is the compact form a
 * CSV cell or a SQL literal wants and 2 is the pretty form the JSON export writes.
 */
export function jsonText(value: unknown, indent = 0): string {
  return JSON.stringify(jsonSafe(value, []), null, indent);
}

// The binary literal forms, one per spelling an engine reads a binary value in. There is
// no portable spelling, so each engine names its form. The hex comes from `binaryText`,
// minus the `\x` prefix that is Postgres's own spelling rather than every dialect's;
// sharing that function is what keeps the file and the screen showing the same bytes. It
// is `[0-9a-f]*` by construction, so interpolating it needs no quoting: there is no
// character in it that could end the literal it sits in (#290).

/** The hex digits of `bytes`, without the `\x` prefix. */
function hexDigits(bytes: Uint8Array): string {
  return binaryText(bytes).slice(2);
}

/** `X'0102'`, the SQL standard's binary string literal. */
export const binaryStandardHex = (bytes: Uint8Array): string => `X'${hexDigits(bytes)}'`;

/** `0x0102`, for the dialects that reject `X'…'`. */
export const binaryZeroX = (bytes: Uint8Array): string => `0x${hexDigits(bytes)}`;

/**
 * `BX'0102'`, Db2's binary string literal. Db2 parses `X'…'` too, but as a CHARACTER
 * string (FOR BIT DATA), which a `BLOB` or a `VARBINARY` column refuses.
 */
export const binaryBinaryHex = (bytes: Uint8Array): string => `BX'${hexDigits(bytes)}'`;

/**
 * `'\x0102'::bytea`. Postgres's `X'…'` is a BIT STRING, not bytea, and there is no cast
 * between the two: measured on 18.4, `SELECT pg_typeof(X'0102')` answers `bit` and `SELECT
 * X'0102'::bytea` is `ERROR: cannot cast type bit to bytea`. The hex-input form is what
 * remains, and it is written as a PLAIN literal rather than `E'\\x…'` because it survives
 * `standard_conforming_strings` in both positions: with the setting `off`, `SELECT
 * length('\x0102deadbeef'::bytea)` still answers 6.
 */
export const binaryPgBytea = (bytes: Uint8Array): string => `'${binaryText(bytes)}'::bytea`;

/**
 * `HEXTORAW('0102')`. Oracle parses neither of the two literal forms (`SELECT
 * rawtohex(x'0102') FROM dual` is `ORA-00907`), so the conversion function is the literal.
 * `HEXTORAW('')` is NULL, which is also what Oracle stores for a zero-length RAW, so the
 * empty case needs no special spelling.
 */
export const binaryHexToRaw = (bytes: Uint8Array): string => `HEXTORAW('${hexDigits(bytes)}')`;

/** `unhex('0102')`, for the same reason as `binaryHexToRaw`, for ClickHouse, whose byte container is `String`. */
export const binaryUnhex = (bytes: Uint8Array): string => `unhex('${hexDigits(bytes)}')`;

/**
 * The `\x…` text quoted as a string, for a dialect with no binary value at all. SQL++ is
 * JSON, and JSON has no byte type; the least-wrong option is the same `\x…` text every
 * other surface shows, so a reader can at least decode it by hand. Quoted with
 * `literalBackslash`, the escape both engines on this form use.
 */
export const binaryTextBackslash = (bytes: Uint8Array): string => literalBackslash(binaryText(bytes));

// The parsers the typed-literal grammars share.

/** A plain object: what JSON makes of a record, and not an array or a byte container. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && asBytes(value) === undefined;
}

/** A declared type with its case and inner runs of spaces normalized, since both are engine output. */
export function normalized(declared: string | undefined): string {
  return declared?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

/** A ClickHouse type split into its name and its top-level arguments: `Map(String, Int32)`. */
export interface ClickHouseType {
  name: string;
  args: string[];
}

/**
 * The top-level comma-separated arguments of a type's argument list, with single- and
 * double-quoted runs and `()`/`<>` nesting respected (`Enum8('a,b' = 1)`, `STRUCT("a,b"
 * INTEGER)`, `map<int, set<text>>`).
 */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(" || char === "<") depth++;
    else if (char === ")" || char === ">") depth--;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/** `Name(args)` or `name<args>`, split into its name and its top-level arguments. */
export function parseTypeCall(declared: string, open = "(", close = ")"): ClickHouseType {
  const text = declared.trim();
  const at = text.indexOf(open);
  if (at <= 0 || !text.endsWith(close) || !/^[A-Za-z0-9_ ]+$/.test(text.slice(0, at))) return { name: text, args: [] };
  return { name: text.slice(0, at).trim(), args: splitArguments(text.slice(at + 1, -1)) };
}

export const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/** A number, or the text of one (how a JSON result keeps a wide integer's digits), written bare. */
export function bareNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && NUMERIC_TEXT.test(value) ? value : undefined;
}

/**
 * NaN or an infinity, as the word it travels as (`src/lib/non-finite.ts`): a number from a
 * host that built its rows itself, or the word a result carried through JSON.
 */
export function floatWord(value: unknown): NonFiniteWord | undefined {
  if (typeof value === "number") return nonFiniteWord(value);
  return isNonFiniteWord(value) ? value : undefined;
}

/**
 * The type names with a space in them that a Trino `row(...)` field can be WITHOUT a field
 * name, so `timestamp(3) with time zone` is not read as a field `timestamp(3)` of type
 * `with time zone`.
 */
const MULTI_WORD_TYPE =
  /^((timestamp|time)(\(\d+\))? with(out)? time zone|double precision|interval (day to second|year to month))$/i;

/** A `name type` field of a Trino `row(...)` or a DuckDB `STRUCT(...)`, its name unquoted. */
export function namedField(arg: string): { name: string; type: string } | undefined {
  if (MULTI_WORD_TYPE.test(arg.trim())) return undefined;
  const match = /^("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)\s+(\S.*)$/.exec(arg);
  if (match === null) return undefined;
  const name = match[1].startsWith('"') ? match[1].slice(1, -1).replace(/""/g, '"') : match[1];
  return { name, type: match[2] };
}
