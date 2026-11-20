/**
 * A SQL Server column's declaration, length, precision and scale included, from the `sys.columns` row the object
 * detail reads (R6).
 *
 * `sys.types.name` is the bare word (`varchar`, `decimal`, `nvarchar`), and DDL written from it alone is not the
 * column it came from: SQL Server reads `varchar` as `varchar(1)`, `decimal` as `decimal(18,0)` and `nvarchar` as
 * `nvarchar(1)` (measured on SQL Server 2022 through Schema Diff > SQL Migration, RG-DIGER1-12), so a migration
 * re-creating `name varchar(50)` truncated every value to one character.
 */

/** The `sys.columns` facts a declaration is built from; `max_length` is in BYTES and `-1` is `max`. */
interface MssqlTypeFacts {
  readonly data_type: string;
  readonly max_length?: number | null;
  readonly precision?: number | null;
  readonly scale?: number | null;
}

/** The length-declared types, and how many bytes one unit of their length takes: an `nchar`'s is two (UTF-16). */
const BYTES_PER_UNIT: Readonly<Record<string, number>> = {
  binary: 1,
  char: 1,
  nchar: 2,
  nvarchar: 2,
  varbinary: 1,
  varchar: 1,
};

/** The types declared with a precision and a scale. */
const PRECISION_AND_SCALE = new Set(["decimal", "numeric"]);

/** The types declared with a fractional-seconds scale alone. */
const SCALE_ONLY = new Set(["datetime2", "datetimeoffset", "time"]);

/**
 * The declaration, or `undefined` for a row that carries no length, which is a read that did not select one. A type
 * outside the three families above (`int`, `float`, `uniqueidentifier`, an alias type such as `Phone`) declares no
 * modifier and is its own name.
 */
export function mssqlDeclaredType(row: MssqlTypeFacts): string | undefined {
  if (typeof row.max_length !== "number") return undefined;
  const type = row.data_type;
  const unit = BYTES_PER_UNIT[type];
  if (unit !== undefined) return `${type}(${row.max_length === -1 ? "max" : row.max_length / unit})`;
  if (PRECISION_AND_SCALE.has(type)) return `${type}(${row.precision ?? 18},${row.scale ?? 0})`;
  if (SCALE_ONLY.has(type)) return `${type}(${row.scale ?? 7})`;
  return type;
}
