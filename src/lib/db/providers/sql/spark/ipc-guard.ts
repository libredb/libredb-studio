/**
 * The pre-check of every Arrow IPC stream before apache-arrow reads it: a minimal, bounds-checked reader of
 * the IPC framing and of the four FlatBuffers tables it needs (Message, Schema, Field, RecordBatch). apache-arrow
 * decodes a schema recursively with no depth limit and was never fed a malformed stream, so Studio reads the
 * structure first and refuses the result as unreadable when anything is out of bounds. Pure: no I/O, no logger.
 *
 * The check reads each field where apache-arrow 21.2.0 and its flatbuffers reader read it, a map's type table among
 * them, and holds the stream to the shape apache-arrow walks: no body after a schema message; the children each type
 * keeps (one for a list or map, none for a type without children); buffers where metadata version V4 and later place
 * them, at the 8-byte alignment Arrow gives them, and no variadic buffer counts, which only a view column has; and
 * every string and list apache-arrow decodes (names, time zones, custom metadata) inside the header and stored in it
 * once. The stream apache-arrow reads is then the stream checked here.
 *
 * Two types are also held to what Studio reads: a map's child to the struct of a key and a value Arrow defines it as,
 * and a decimal to Spark's DecimalType (precision 1 to 38, a scale no larger than the precision) with a scale no lower
 * than -38, Studio's own floor where Spark has none, so the text of one value stays within about 80 characters.
 */
import { SPARK_IPC_METADATA_MAX_BYTES, SPARK_SCHEMA_MAX_DEPTH, SPARK_SCHEMA_MAX_FIELDS } from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";

/** What each refusal names inside `SPARK_ERROR_SENTENCES.unreadable`. */
export const SPARK_IPC_FAILURES = Object.freeze({
  framing: "a message without the continuation marker",
  metadata: "a message header longer than 1 MiB or past the end of the stream",
  body: "a message body past the end of the stream",
  schemaBody: "a schema message with a body",
  endMarker: "a stream without its end-of-stream marker",
  header: "a message header whose offsets point outside it",
  overlap: "a message header whose strings and lists overlap",
  order: "a stream that does not start with its schema",
  messageType: "a message type Spark does not send",
  version: "a batch in an Arrow metadata version older than V4",
  dictionary: "a dictionary-encoded column",
  depth: "a schema nested deeper than 64 levels",
  fields: "a schema with more than 10,000 fields",
  type: "a column of an Arrow type Studio does not read",
  rowCount: "a batch whose row count differs from the count Spark declared",
  nodes: "a batch whose columns or buffers differ from its schema",
  buffers: "a buffer outside its batch's body",
  alignment: "a buffer not aligned to 8 bytes",
  bufferOrder: "a buffer that starts before the previous buffer ends",
  length: "a column whose length or null count does not fit its batch",
  validity: "a validity bitmap shorter than its column",
  values: "a values buffer shorter than its column",
  offsets: "offsets that decrease or point past their data",
  child: "a nested column shorter than its parent",
});

type Failure = keyof typeof SPARK_IPC_FAILURES;
type Layout = "null" | "fixed" | "bool" | "var" | "list" | "map" | "struct";

interface Column {
  readonly layout: Layout;
  readonly width: number;
  readonly parent: number;
  readonly children: number[];
}

const CONTINUATION = 0xffffffff;
const INT32_MAX = 2 ** 31 - 1;
const MESSAGE_SCHEMA = 1;
const MESSAGE_RECORD_BATCH = 3;
/** MetadataVersion V4: apache-arrow reads the buffers of an older batch at other positions (they held a page id). */
const METADATA_V4 = 3;
/** Buffers per layout in a record batch (Arrow's buffer listing): Null none, a struct its validity only. */
const BUFFERS: Readonly<Record<Layout, number>> = { null: 0, fixed: 2, bool: 2, var: 3, list: 2, map: 2, struct: 1 };
/** Spark's DecimalType.MAX_PRECISION. */
const DECIMAL_MAX_PRECISION = 38;
/** Studio's floor for a negative decimal scale, which Spark leaves unbounded: the text of a value stays short. */
const DECIMAL_MIN_SCALE = -38;

function refuse(what: Failure): never {
  throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(SPARK_IPC_FAILURES[what]));
}

/** A bounds-checked reader of one message's FlatBuffers header, the bytes [start, end) of the stream. */
class Header {
  /** Bytes of the strings and lists read so far: a writer stores each once, so together they fit in the header. */
  private spent = 0;

  constructor(
    private readonly view: DataView,
    private readonly start: number,
    private readonly end: number,
  ) {}

  private at(position: number, size: number): number {
    if (!Number.isInteger(position) || position < this.start || position + size > this.end) refuse("header");
    return position;
  }

  u8(position: number): number {
    return this.view.getUint8(this.at(position, 1));
  }

  i16(position: number): number {
    return this.view.getInt16(this.at(position, 2), true);
  }

  i32(position: number): number {
    return this.view.getInt32(this.at(position, 4), true);
  }

  u32(position: number): number {
    return this.view.getUint32(this.at(position, 4), true);
  }

  i64(position: number): number {
    const value = Number(this.view.getBigInt64(this.at(position, 8), true));
    if (!Number.isSafeInteger(value)) refuse("header");
    return value;
  }

  root(): number {
    return this.start + this.u32(this.start);
  }

  /**
   * Where a table's field lies, or -1 when the field is absent, found as flatbuffers finds it: the vtable's size and
   * entries are signed 16-bit values (a negative one is refused), and a slot is present while it starts inside the size.
   */
  field(table: number, slot: number): number {
    const vtable = table - this.i32(table);
    const size = this.i16(vtable);
    if (size < 0) refuse("header");
    const entry = 4 + slot * 2;
    if (entry >= size) return -1;
    const offset = this.i16(vtable + entry);
    if (offset < 0) refuse("header");
    return offset === 0 ? -1 : this.at(table + offset, 1);
  }

  /** The table, string or vector an offset field points at, or -1 when the field is absent. */
  target(table: number, slot: number): number {
    const field = this.field(table, slot);
    return field === -1 ? -1 : field + this.u32(field);
  }

  /** A table-typed field that must be present. */
  required(table: number, slot: number): number {
    const target = this.target(table, slot);
    if (target === -1) refuse("header");
    return target;
  }

  scalar(table: number, slot: number, size: 1 | 2 | 4 | 8, fallback: number): number {
    const field = this.field(table, slot);
    if (field === -1) return fallback;
    return size === 1 ? this.u8(field) : size === 2 ? this.i16(field) : size === 4 ? this.i32(field) : this.i64(field);
  }

  /**
   * A vector or string field's first element and length, every element inside the header and its bytes counted, so a
   * header that points two fields at one string or list is refused; empty when absent.
   */
  vector(table: number, slot: number, elementSize: number): { readonly start: number; readonly length: number } {
    const at = this.target(table, slot);
    if (at === -1) return { start: 0, length: 0 };
    const length = this.u32(at);
    this.at(at + 4, length * elementSize);
    this.spent += 4 + length * elementSize;
    if (this.spent > this.end - this.start) refuse("overlap");
    return { start: at + 4, length };
  }

  /** The table a vector of tables holds at `index`. */
  tableAt(vector: { readonly start: number }, index: number): number {
    const at = vector.start + index * 4;
    return at + this.u32(at);
  }

  /** A custom_metadata field: apache-arrow decodes every key and value of it, so each is checked and counted. */
  metadata(table: number, slot: number): void {
    const entries = this.vector(table, slot, 4);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = this.tableAt(entries, index);
      this.vector(entry, 0, 1);
      this.vector(entry, 1, 1);
    }
  }
}

/** A field's layout and value width, or a refusal for a type Studio does not read. */
function layoutOf(header: Header, field: number): { readonly layout: Layout; readonly width: number } {
  const id = header.scalar(field, 2, 1, 0);
  const type = header.target(field, 3);
  const fixed = (width: number) => ({ layout: "fixed" as const, width });
  const unit = (fallback: number) => header.scalar(type, 0, 2, fallback);
  let found: { readonly layout: Layout; readonly width: number } | undefined;
  if (id === 1) found = { layout: "null", width: 0 };
  else if (id === 2) {
    const bits = header.scalar(type, 0, 4, 0);
    if (header.scalar(type, 1, 1, 0) === 1 && [8, 16, 32, 64].includes(bits)) found = fixed(bits / 8);
  } else if (id === 3) found = unit(0) === 1 ? fixed(4) : unit(0) === 2 ? fixed(8) : undefined;
  else if (id === 4 || id === 5) found = { layout: "var", width: 0 };
  else if (id === 6) found = { layout: "bool", width: 0 };
  else if (id === 7) {
    const precision = header.scalar(type, 0, 4, 0);
    const scale = header.scalar(type, 1, 4, 0);
    const spark =
      precision >= 1 && precision <= DECIMAL_MAX_PRECISION && scale >= DECIMAL_MIN_SCALE && scale <= precision;
    found = spark && header.scalar(type, 2, 4, 128) === 128 ? fixed(16) : undefined; // Decimal128
  } else if (id === 8)
    found = unit(1) === 0 ? fixed(4) : undefined; // Date: DAY only
  else if (id === 9)
    found = unit(1) === 3 && header.scalar(type, 1, 4, 32) === 64 ? fixed(8) : undefined; // Time64 ns
  else if (id === 10) {
    header.vector(type, 1, 1); // the time zone, which apache-arrow decodes
    found = unit(0) === 2 ? fixed(8) : undefined; // Timestamp us
  } else if (id === 11)
    found = unit(0) === 0 ? fixed(4) : unit(0) === 2 ? fixed(16) : undefined; // YEAR_MONTH, MONTH_DAY_NANO
  else if (id === 12) found = { layout: "list", width: 0 };
  else if (id === 13) found = { layout: "struct", width: 0 };
  else if (id === 17) {
    header.scalar(type, 0, 1, 0); // keysSorted, which apache-arrow reads, so the map's type table must be in the header
    found = { layout: "map", width: 0 };
  } else if (id === 18)
    found = unit(1) === 2 ? fixed(8) : undefined; // Duration us
  else if (id === 19 || id === 20) throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.largeVarTypes);
  if (found === undefined) refuse("type");
  return found;
}

/** The schema's fields in pre-order, walked with an explicit stack, depth and count bounded. */
function readSchema(header: Header, message: number): { readonly columns: Column[]; readonly depth: number } {
  const schema = header.required(message, 2);
  const top = header.vector(schema, 1, 4);
  if (top.length > SPARK_SCHEMA_MAX_FIELDS) refuse("fields");
  header.metadata(schema, 2);
  const columns: Column[] = [];
  const stack: { readonly field: number; readonly depth: number; readonly parent: number }[] = [];
  for (let index = top.length - 1; index >= 0; index -= 1)
    stack.push({ field: header.tableAt(top, index), depth: 1, parent: -1 });
  let deepest = 0;
  while (stack.length > 0) {
    const { field, depth, parent } = stack.pop()!;
    if (depth > SPARK_SCHEMA_MAX_DEPTH) refuse("depth");
    deepest = Math.max(deepest, depth);
    if (header.target(field, 4) !== -1) refuse("dictionary");
    const children = header.vector(field, 5, 4);
    // Every field on the stack is counted before it is visited, so the walk never holds more than the bound.
    if (columns.length + 1 + stack.length + children.length > SPARK_SCHEMA_MAX_FIELDS) refuse("fields");
    header.vector(field, 0, 1); // the name
    header.metadata(field, 6);
    const shape = layoutOf(header, field);
    // apache-arrow keeps the first child of a list or map and none of a type without children, so any other count
    // would give every later column nodes and buffers other than the ones checked here.
    const kept =
      shape.layout === "list" || shape.layout === "map" ? 1 : shape.layout === "struct" ? children.length : 0;
    if (children.length !== kept) refuse("type");
    // Arrow defines a map's child as a struct of a key and a value, and Studio reads the two from that struct's two
    // children. apache-arrow reads a map of any child, but a value read from another shape throws or comes out wrong.
    if (parent !== -1 && columns[parent].layout === "map" && (shape.layout !== "struct" || children.length !== 2))
      refuse("type");
    const index = columns.length;
    columns.push({ ...shape, parent, children: [] });
    if (parent !== -1) columns[parent].children.push(index);
    for (let child = children.length - 1; child >= 0; child -= 1) {
      stack.push({ field: header.tableAt(children, child), depth: depth + 1, parent: index });
    }
  }
  return { columns, depth: deepest };
}

function checkOffsets(
  view: DataView,
  span: { readonly at: number; readonly length: number },
  length: number,
  limit: number,
): void {
  if (length === 0 && span.length === 0) return;
  if (span.length < (length + 1) * 4) refuse("offsets");
  let previous = view.getInt32(span.at, true);
  if (previous < 0) refuse("offsets");
  for (let index = 1; index <= length; index += 1) {
    const current = view.getInt32(span.at + index * 4, true);
    if (current < previous) refuse("offsets");
    previous = current;
  }
  if (previous > limit) refuse("offsets");
}

/** One record batch against its schema; answers the batch's row count. */
function checkBatch(
  header: Header,
  view: DataView,
  message: number,
  body: number,
  bodyLength: number,
  columns: readonly Column[],
): number {
  if (header.scalar(message, 0, 2, 0) < METADATA_V4) refuse("version");
  const batch = header.required(message, 2);
  const compression = header.target(batch, 3);
  if (compression !== -1) {
    const codec = header.scalar(compression, 0, 1, 0) === 1 ? "zstd" : "lz4";
    throw new SparkError("unreadable", SPARK_ERROR_SENTENCES.compressed(codec));
  }
  const rows = header.scalar(batch, 0, 8, 0);
  if (rows < 0 || rows > INT32_MAX) refuse("length");
  const nodes = header.vector(batch, 1, 16);
  const buffers = header.vector(batch, 2, 16);
  // variadicBufferCounts, which apache-arrow decodes: only a view column has variadic buffers, and Studio reads no view
  // type, so any count names buffers no column of the schema has.
  const variadic = header.vector(batch, 4, 8);
  const expected = columns.reduce((sum, column) => sum + BUFFERS[column.layout], 0);
  if (nodes.length !== columns.length || buffers.length !== expected || variadic.length !== 0) refuse("nodes");
  const lengths: number[] = [];
  const nulls: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const length = header.i64(nodes.start + 16 * index);
    const nullCount = header.i64(nodes.start + 16 * index + 8);
    if (length < 0 || length > INT32_MAX || nullCount < 0 || nullCount > length) refuse("length");
    lengths.push(length);
    nulls.push(nullCount);
  }
  const spans: { readonly at: number; readonly length: number }[] = [];
  // Arrow's writers lay the buffers out end to end, in order, so each starts at or after the end of the one before.
  // Holding every batch to that makes the offsets checks below read each body byte at most once, so their work stays
  // linear in the stream's size.
  let end = 0;
  for (let index = 0; index < buffers.length; index += 1) {
    const offset = header.i64(buffers.start + 16 * index);
    const length = header.i64(buffers.start + 16 * index + 8);
    if (offset < 0 || length < 0 || offset + length > bodyLength) refuse("buffers");
    // apache-arrow views a buffer as a typed array, which needs the 8-byte alignment Arrow's format gives each buffer.
    if (offset % 8 !== 0) refuse("alignment");
    if (offset < end) refuse("bufferOrder");
    end = offset + length;
    spans.push({ at: body + offset, length });
  }
  let next = 0;
  columns.forEach((column, index) => {
    const length = lengths[index];
    const parent = column.parent === -1 ? undefined : columns[column.parent];
    if (parent === undefined && length !== rows) refuse("length");
    if (parent?.layout === "struct" && length < lengths[column.parent]) refuse("child");
    if (column.layout === "null") return;
    const validity = spans[next++];
    if (nulls[index] > 0 && validity.length < Math.ceil(length / 8)) refuse("validity");
    if (column.layout === "struct") return;
    if (column.layout === "fixed" || column.layout === "bool") {
      const need = column.layout === "bool" ? Math.ceil(length / 8) : length * column.width;
      if (spans[next++].length < need) refuse("values");
      return;
    }
    const offsets = spans[next++];
    const limit = column.layout === "var" ? spans[next++].length : lengths[column.children[0]];
    checkOffsets(view, offsets, length, limit);
  });
  return rows;
}

/**
 * Checks one Arrow IPC stream before apache-arrow reads it; throws `SparkError("unreadable")` naming what failed.
 * `declaredRows` is the relation path's `row_count`, which the stream's batches must sum to.
 */
export function checkIpcStream(
  bytes: Uint8Array,
  declaredRows?: number,
): { readonly fields: number; readonly depth: number; readonly batches: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let schema: { readonly columns: Column[]; readonly depth: number } | undefined;
  let position = 0;
  let batches = 0;
  let rows = 0;
  for (;;) {
    if (position + 8 > bytes.byteLength) refuse("endMarker");
    if (view.getUint32(position, true) !== CONTINUATION) refuse("framing");
    const length = view.getInt32(position + 4, true);
    if (length === 0) {
      if (position + 8 !== bytes.byteLength) refuse("framing");
      break;
    }
    const start = position + 8;
    if (length < 0 || length > SPARK_IPC_METADATA_MAX_BYTES || start + length > bytes.byteLength) refuse("metadata");
    const header = new Header(view, start, start + length);
    const message = header.root();
    const type = header.scalar(message, 1, 1, 0);
    const bodyLength = header.scalar(message, 3, 8, 0);
    const body = start + length;
    if (bodyLength < 0 || body + bodyLength > bytes.byteLength) refuse("body");
    if (type !== MESSAGE_SCHEMA && type !== MESSAGE_RECORD_BATCH) refuse("messageType");
    if (type === MESSAGE_SCHEMA ? schema !== undefined : schema === undefined) refuse("order");
    header.metadata(message, 4);
    if (type === MESSAGE_SCHEMA) {
      // apache-arrow reads no body after a schema message, so it would read one as the next message.
      if (bodyLength !== 0) refuse("schemaBody");
      schema = readSchema(header, message);
    } else {
      rows += checkBatch(header, view, message, body, bodyLength, schema!.columns);
      batches += 1;
    }
    position = body + bodyLength;
  }
  if (schema === undefined) refuse("order");
  if (declaredRows !== undefined && rows !== declaredRows) refuse("rowCount");
  return { fields: schema.columns.length, depth: schema.depth, batches };
}
