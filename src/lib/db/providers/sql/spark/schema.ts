/**
 * A result's columns as Studio shows them: the value kind values.ts maps a cell by, and Spark's
 * own spelling of the column type for `columnTypes`, the form Spark's simpleString writes, never cut (`decimal(10,2)`,
 * `interval year to month`), but with each struct field name spelled as Spark's quoteIfNeeded spells it
 * (``struct<`a b`:int,ok:bigint>``), so a struct's spelling is type text Spark parses back as the same struct, which
 * the SQL export hands to FROM_JSON. The relation path reads the `DataType` proto Spark sends first, as Spark's own
 * client reads it (DataTypeProtoConverter), held to the 64 levels, the 10,000 fields and the decimal bound the IPC
 * schema is held to; the command path, which sends no `DataType`, reads the Arrow types as Spark reads them
 * back (ArrowUtils). On the relation path the two must name the same columns, of the same type at every depth.
 * Pure: no I/O, no logger.
 */
import type { ArrowColumnData, ArrowColumns } from "./arrow";
import { SPARK_SCHEMA_MAX_DEPTH, SPARK_SCHEMA_MAX_FIELDS } from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import { spellSparkName } from "./namespace";
import type { IntervalFields, IntervalUnit } from "./temporal";

/** The kind of a column's values, which values.ts maps each cell by. */
export type SparkValueKind =
  | {
      readonly type:
        | "boolean"
        | "tinyint"
        | "smallint"
        | "int"
        | "bigint"
        | "float"
        | "double"
        | "string"
        | "binary"
        | "date"
        | "timestamp"
        | "timestamp_ntz"
        | "variant"
        | "void"
        | "calendar-interval";
    }
  | { readonly type: "decimal"; readonly precision: number; readonly scale: number }
  | { readonly type: "time"; readonly precision: number }
  | { readonly type: "year-month-interval" | "day-time-interval"; readonly fields: IntervalFields }
  | { readonly type: "array"; readonly element: SparkValueKind }
  | { readonly type: "map"; readonly key: SparkValueKind; readonly value: SparkValueKind }
  | { readonly type: "struct"; readonly fields: readonly { readonly name: string; readonly kind: SparkValueKind }[] }
  | { readonly type: "geometry" | "geography"; readonly srid: number };

export interface SparkColumn {
  name: string;
  spelling: string;
  kind: SparkValueKind;
}

/** A type with no children: its kind and its whole spelling. */
interface Leaf {
  readonly kind: SparkValueKind;
  readonly spelling: string;
}

const YEAR_MONTH: readonly IntervalUnit[] = ["YEAR", "MONTH"];
const DAY_TIME: readonly IntervalUnit[] = ["DAY", "HOUR", "MINUTE", "SECOND"];
/** The precision Spark gives a decimal whose proto names none: DecimalType() is decimal(10,0). */
const DECIMAL_DEFAULT_PRECISION = 10;
/** Spark's DecimalType.MAX_PRECISION. */
const DECIMAL_MAX_PRECISION = 38;
/** Studio's floor for a legacy negative scale, which Spark leaves unbounded, as ipc-guard.ts holds it. */
const DECIMAL_MIN_SCALE = -38;
/** TimeType.DEFAULT_PRECISION: Spark's time with no precision named, and its reading of an Arrow Time64(ns). */
const TIME_DEFAULT_PRECISION = 6;
/** SpatialType.MIXED_SRID: a geospatial type whose values each carry their own srid, which Spark spells `any`. */
const MIXED_SRID = -1;
/** An srid as Spark writes it into the metadata of a geospatial struct's wkb field: an int32 in decimal digits. */
const SRID_TEXT = /^-?\d{1,10}$/;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/** A type with no parameters, shared by every column of it, so it is frozen: no caller can change it for the next. */
const scalar = (kind: SparkValueKind, spelling: string): Leaf => Object.freeze({ kind: Object.freeze(kind), spelling });

/** The types with no parameters, by their `DataType` member name. */
const SCALARS: Readonly<Record<string, Leaf>> = Object.freeze({
  null: scalar({ type: "void" }, "void"),
  boolean: scalar({ type: "boolean" }, "boolean"),
  byte: scalar({ type: "tinyint" }, "tinyint"),
  short: scalar({ type: "smallint" }, "smallint"),
  integer: scalar({ type: "int" }, "int"),
  long: scalar({ type: "bigint" }, "bigint"),
  float: scalar({ type: "float" }, "float"),
  double: scalar({ type: "double" }, "double"),
  binary: scalar({ type: "binary" }, "binary"),
  date: scalar({ type: "date" }, "date"),
  timestamp: scalar({ type: "timestamp" }, "timestamp"),
  timestamp_ntz: scalar({ type: "timestamp_ntz" }, "timestamp_ntz"),
  calendar_interval: scalar({ type: "calendar-interval" }, "interval"),
  variant: scalar({ type: "variant" }, "variant"),
});
/** A string of the default collation, UTF8_BINARY, which Spark spells plain `string` (StringType.typeName). */
const STRING = scalar({ type: "string" }, "string");

function unreadable(what: string): never {
  throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(what));
}

/** Writes a leaf type's spelling and answers its kind. */
function emit(out: string[], leaf: Leaf): SparkValueKind {
  out.push(leaf.spelling);
  return leaf.kind;
}

/**
 * An interval's fields from the unit indexes the proto names, as Spark reads them: both named, that range; the start
 * alone, that one unit; otherwise the type's whole range. An index outside the unit list, or a start after the end, is
 * refused here once at schema time, so an empty or all-null column of that type is refused too; temporal.ts refuses
 * the same per cell as the second line of defence.
 */
function intervalFields(units: readonly IntervalUnit[], start: unknown, end: unknown): IntervalFields {
  const from = typeof start === "number" ? start : 0;
  const to = typeof start !== "number" ? units.length - 1 : typeof end === "number" ? end : start;
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to < units.length)) {
    unreadable(`an interval column whose fields run from ${from} to ${to}`);
  }
  return { start: units[from], end: units[to] };
}

/**
 * An interval type, its fields spelled in lower case as Spark spells them: `interval year to month`, `interval hour`.
 */
function intervalOf(yearMonth: boolean, fields: IntervalFields): Leaf {
  const range = fields.start === fields.end ? fields.start : `${fields.start} to ${fields.end}`;
  return {
    kind: { type: yearMonth ? "year-month-interval" : "day-time-interval", fields },
    spelling: `interval ${range.toLowerCase()}`,
  };
}

/**
 * A decimal, held to the bound ipc-guard.ts holds an Arrow Decimal to: Spark's precision 1 to 38 and a scale
 * at most the precision, and Studio's own floor of -38 for a legacy negative scale, so the text of one value stays
 * short.
 */
function decimalOf(precision: number | undefined, scale: number | undefined): Leaf {
  if (
    !(
      precision !== undefined &&
      scale !== undefined &&
      Number.isInteger(precision) &&
      Number.isInteger(scale) &&
      precision >= 1 &&
      precision <= DECIMAL_MAX_PRECISION &&
      scale >= DECIMAL_MIN_SCALE &&
      scale <= precision
    )
  ) {
    unreadable(`a result column of the Spark type decimal(${precision},${scale})`);
  }
  return { kind: { type: "decimal", precision, scale }, spelling: `decimal(${precision},${scale})` };
}

function timeOf(precision: number): Leaf {
  return { kind: { type: "time", precision }, spelling: `time(${precision})` };
}

/** A geospatial type, its srid spelled `any` when mixed (GeometryType.typeName, GeographyType.typeName). */
function geospatialOf(type: "geometry" | "geography", srid: number): Leaf {
  return { kind: { type, srid }, spelling: `${type}(${srid === MIXED_SRID ? "any" : srid})` };
}

/**
 * The nested types write their parts around their children's into one list a column joins once, so no level copies
 * the text below it and a deep schema's spellings cost what their text does.
 */
function arrayKind(out: string[], element: () => SparkValueKind): SparkValueKind {
  out.push("array<");
  const kind = element();
  out.push(">");
  return { type: "array", element: kind };
}

function mapKind(out: string[], key: () => SparkValueKind, value: () => SparkValueKind): SparkValueKind {
  out.push("map<");
  const keyKind = key();
  out.push(",");
  const valueKind = value();
  out.push(">");
  return { type: "map", key: keyKind, value: valueKind };
}

/**
 * A struct, each field name spelled by spellSparkName: bare where Spark's QuotingUtils.quoteIfNeeded leaves it bare (a
 * name matching [a-zA-Z_][a-zA-Z0-9_]*) and backticked otherwise, since Spark's type grammar reads a field name as an
 * identifier (complexColType). Spark's simpleString writes every name bare, which Spark cannot parse back for a name
 * such as `a b` and reads as another shape for one such as `x:int,y`. The kind keeps each name as it is.
 */
function structKind<F extends { readonly name: string }>(
  out: string[],
  fields: readonly F[],
  kindOf: (field: F) => SparkValueKind,
): SparkValueKind {
  out.push("struct<");
  const kinds = fields.map((field, index) => {
    if (index > 0) out.push(",");
    out.push(spellSparkName(field.name), ":");
    return { name: field.name, kind: kindOf(field) };
  });
  out.push(">");
  return { type: "struct", fields: kinds };
}

/** One column: its spelling written into one list of parts and joined once. */
function columnOf(name: string, write: (out: string[]) => SparkValueKind): SparkColumn {
  const out: string[] = [];
  const kind = write(out);
  return { name, spelling: out.join(""), kind };
}

/** A struct's fields as the proto lists them, at most 10,000, each named as the proto names it. */
function protoFields(body: Record<string, unknown>): { readonly name: string; readonly dataType: unknown }[] {
  const fields: unknown[] = Array.isArray(body.fields) ? body.fields : [];
  if (fields.length > SPARK_SCHEMA_MAX_FIELDS) unreadable("a result schema with more than 10,000 fields");
  return fields.map((field) => {
    const { name, data_type: dataType } = (field ?? {}) as { name?: unknown; data_type?: unknown };
    return { name: typeof name === "string" ? name : "", dataType };
  });
}

/**
 * One `DataType`: writes its spelling into `out` and answers its kind, a field the proto leaves out read as Spark reads
 * it. `depth` is the level of this type, a top-level column's being 1, and `budget.fields` counts every type node
 * against the 10,000 bound.
 */
function typed(dataType: unknown, depth: number, budget: { fields: number }, out: string[]): SparkValueKind {
  if (depth > SPARK_SCHEMA_MAX_DEPTH) unreadable("a result schema nested deeper than 64 levels");
  budget.fields += 1;
  if (budget.fields > SPARK_SCHEMA_MAX_FIELDS) unreadable("a result schema with more than 10,000 fields");
  // The proto's `kind` oneof names the member that is set, under SPARK_LOADER_OPTIONS (`oneofs: true`).
  const node = (typeof dataType === "object" && dataType !== null ? dataType : {}) as Record<string, unknown>;
  const name = typeof node.kind === "string" ? node.kind : "";
  const body = (node[name] ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(SCALARS, name)) return emit(out, SCALARS[name]);
  switch (name) {
    case "decimal": {
      // Both named, that type; the precision alone, scale 0; otherwise Spark's default, decimal(10,0).
      const precision = typeof body.precision === "number" ? body.precision : undefined;
      const scale = typeof body.scale === "number" ? body.scale : undefined;
      return emit(
        out,
        precision === undefined ? decimalOf(DECIMAL_DEFAULT_PRECISION, 0) : decimalOf(precision, scale ?? 0),
      );
    }
    case "string": {
      // 4.1 names the default collation UTF8_BINARY and 4.2 leaves it empty; Spark spells both plain `string`.
      const collation = typeof body.collation === "string" ? body.collation : "";
      return collation === "" || collation === "UTF8_BINARY"
        ? emit(out, STRING)
        : emit(out, { kind: { type: "string" }, spelling: `string collate ${collation}` });
    }
    case "char":
    case "var_char":
      return emit(out, {
        kind: { type: "string" },
        spelling: `${name === "char" ? "char" : "varchar"}(${typeof body.length === "number" ? body.length : 0})`,
      });
    case "time":
      return emit(out, timeOf(typeof body.precision === "number" ? body.precision : TIME_DEFAULT_PRECISION));
    case "year_month_interval":
      return emit(out, intervalOf(true, intervalFields(YEAR_MONTH, body.start_field, body.end_field)));
    case "day_time_interval":
      return emit(out, intervalOf(false, intervalFields(DAY_TIME, body.start_field, body.end_field)));
    case "array":
      return arrayKind(out, () => typed(body.element_type, depth + 1, budget, out));
    case "map":
      return mapKind(
        out,
        () => typed(body.key_type, depth + 1, budget, out),
        () => typed(body.value_type, depth + 1, budget, out),
      );
    case "struct":
      return structKind(out, protoFields(body), (field) => typed(field.dataType, depth + 1, budget, out));
    case "geometry":
    case "geography":
      return emit(out, geospatialOf(name, typeof body.srid === "number" ? body.srid : 0));
    case "udt":
      // A user-defined type travels as its storage type (Spark's ArrowUtils writes a UDT as its sqlType), so
      // it is read and spelled as that type, at the same depth and counted once, as the Arrow schema carries it. A
      // storage type that is itself user-defined is bounded by protobufjs, which refuses a message nested past 100
      // levels.
      budget.fields -= 1;
      return typed(body.sql_type, depth, budget, out);
    default:
      return unreadable(`a result column of the Spark type ${name === "" ? "(none)" : name}`);
  }
}

/** The relation path's result schema, a struct `DataType`, to Studio columns; refused past the IPC schema's bounds. */
export function columnsFromDataType(dataType: object): SparkColumn[] {
  if ((dataType as { kind?: unknown }).kind !== "struct") unreadable("a result schema that is not a struct");
  const body = ((dataType as { struct?: unknown }).struct ?? {}) as Record<string, unknown>;
  const budget = { fields: 0 };
  return protoFields(body).map((field) => columnOf(field.name, (out) => typed(field.dataType, 1, budget, out)));
}

/** The srid in a geospatial struct's wkb field, as Spark reads it (ArrowUtils, an int32 in digits), else refused. */
function sridOf(text: string | undefined, type: "geometry" | "geography"): number {
  const srid = text !== undefined && SRID_TEXT.test(text) ? Number(text) : Number.NaN;
  if (!(srid >= INT32_MIN && srid <= INT32_MAX)) unreadable(`a ${type} column without a readable srid`);
  return srid;
}

/**
 * A struct in one of Spark's own layouts (ArrowUtils): a variant is `value` and `metadata`, the second tagged
 * variant=true; a geometry or a geography is `srid` and `wkb`, the second tagged with its type and its srid. Spark's
 * reader finds the two by name; Studio holds a struct to exactly those two children in that order, the order values.ts
 * reads them in, and reads any other struct as a struct.
 */
function sparkLayout(column: ArrowColumnData): Leaf | undefined {
  if (column.children.length !== 2) return undefined;
  const [first, second] = column.children;
  if (first.name === "value" && second.name === "metadata" && second.metadata.get("variant") === "true") {
    return SCALARS.variant;
  }
  if (first.name !== "srid" || second.name !== "wkb") return undefined;
  for (const type of ["geometry", "geography"] as const) {
    if (second.metadata.get(type) === "true") return geospatialOf(type, sridOf(second.metadata.get("srid"), type));
  }
  return undefined;
}

/** One Arrow column: writes its spelling into `out` and answers its kind, as Spark reads the type back (ArrowUtils). */
function arrowTyped(column: ArrowColumnData, out: string[]): SparkValueKind {
  switch (column.type) {
    case "null":
      return emit(out, SCALARS.null);
    case "bool":
      return emit(out, SCALARS.boolean);
    case "int8":
      return emit(out, SCALARS.byte);
    case "int16":
      return emit(out, SCALARS.short);
    case "int32":
      return emit(out, SCALARS.integer);
    case "int64":
      return emit(out, SCALARS.long);
    case "float32":
      return emit(out, SCALARS.float);
    case "float64":
      return emit(out, SCALARS.double);
    case "utf8":
      return emit(out, STRING);
    case "binary":
      return emit(out, SCALARS.binary);
    case "date32":
      return emit(out, SCALARS.date);
    case "timestamp":
      // Spark writes the session's zone on a timestamp and none on a timestamp_ntz; Arrow reads a timestamp whose zone
      // is unset or empty as one without a zone (Schema.fbs).
      return emit(out, column.timezone ? SCALARS.timestamp : SCALARS.timestamp_ntz);
    case "time64":
      return emit(out, timeOf(TIME_DEFAULT_PRECISION));
    case "interval-month-day-nano":
      return emit(out, SCALARS.calendar_interval);
    case "decimal128":
      // arrow.ts names both for every Decimal128, and checkIpcStream already held them to this bound.
      return emit(out, decimalOf(column.precision, column.scale));
    case "interval-year-month":
      // Spark reads Interval(YEAR_MONTH) back as interval year to month, and Duration(MICROSECOND) as interval day to
      // second, the fields yearMonthText and dayTimeText then write.
      return emit(out, intervalOf(true, { start: "YEAR", end: "MONTH" }));
    case "duration":
      return emit(out, intervalOf(false, { start: "DAY", end: "SECOND" }));
    case "list":
      return arrayKind(out, () => arrowTyped(column.children[0], out));
    case "map": {
      // checkIpcStream already refused a map whose one child is not a struct of exactly two children, so the entries'
      // two children are the key and the value here.
      const [entries] = column.children;
      return mapKind(
        out,
        () => arrowTyped(entries.children[0], out),
        () => arrowTyped(entries.children[1], out),
      );
    }
    case "struct": {
      const layout = sparkLayout(column);
      return layout === undefined
        ? structKind(out, column.children, (child) => arrowTyped(child, out))
        : emit(out, layout);
    }
  }
}

/** The command path's columns, read from the Arrow types (their depth and width already bounded by checkIpcStream). */
export function columnsFromArrow(columns: ArrowColumns): SparkColumn[] {
  return columns.columns.map((column) => columnOf(column.name, (out) => arrowTyped(column, out)));
}

/**
 * The names Spark's Arrow writer gives a struct's fields: both result paths write the Arrow schema with
 * errorOnDuplicatedFieldNames = false, so ArrowUtils.deduplicateFieldNames numbers a name the struct holds more than
 * once name_0, name_1 and on, in order, and keeps a name it holds once. The DataType keeps every name as the plan
 * gives it, so struct(a.id, b.id) is id, id there and id_0, id_1 in the batch (4.1.3 and 4.2.0 alike). A top-level
 * column's name is never renamed.
 */
export function arrowFieldNames(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const numbered = new Map<string, number>();
  return names.map((name) => {
    if (counts.get(name) === 1) return name;
    const index = numbered.get(name) ?? 0;
    numbered.set(name, index + 1);
    return `${name}_${index}`;
  });
}

/** Whether `fields` are named `names`, in order. */
const namedAs = (fields: readonly { readonly name: string }[], names: readonly string[]): boolean =>
  names.every((name, index) => fields[index].name === name);

/**
 * Whether a batch holds a column's values as its `DataType` declares them, values.ts reading each cell by the declared
 * kind: the same type at every depth, a decimal's precision and scale, and a struct's field count and names, the
 * batch's names being the DataType's or those Spark's Arrow writer numbers from them (arrowFieldNames). Interval
 * fields, time precision and srid are left out: Spark's two readings of its own answers differ on them (Arrow carries
 * no interval fields, and one Time64 unit for every time precision), or values.ts does not read them from the kind.
 */
function sameKind(declared: SparkValueKind, read: SparkValueKind): boolean {
  switch (declared.type) {
    case "decimal":
      return read.type === "decimal" && declared.precision === read.precision && declared.scale === read.scale;
    case "array":
      return read.type === "array" && sameKind(declared.element, read.element);
    case "map":
      return read.type === "map" && sameKind(declared.key, read.key) && sameKind(declared.value, read.value);
    case "struct": {
      if (read.type !== "struct" || declared.fields.length !== read.fields.length) return false;
      const names = declared.fields.map((field) => field.name);
      return (
        (namedAs(read.fields, names) || namedAs(read.fields, arrowFieldNames(names))) &&
        declared.fields.every((field, index) => sameKind(field.kind, read.fields[index].kind))
      );
    }
    default:
      return declared.type === read.type;
  }
}

/**
 * On the relation path the `DataType` schema and the Arrow batch must name the same columns, each of the
 * same kind (sameKind), so no cell is read by a kind its batch does not hold. A column's name is compared as it is,
 * since Spark numbers a repeated name only inside a struct.
 */
export function assertSchemasAgree(fromDataType: readonly SparkColumn[], fromArrow: readonly SparkColumn[]): void {
  if (
    fromDataType.length !== fromArrow.length ||
    fromDataType.some(
      (column, index) => column.name !== fromArrow[index].name || !sameKind(column.kind, fromArrow[index].kind),
    )
  ) {
    unreadable("a result whose schema and batches name different columns");
  }
}
