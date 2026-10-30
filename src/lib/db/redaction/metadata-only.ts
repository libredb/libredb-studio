/**
 * The metadata-only answer mode's projection helpers, shared by every provider that declares
 * `ProviderCapabilities.metadataOnly`: a store whose answers carry stored values (objects, vectors, payloads, message
 * bodies, document fields) that its machine surfaces must not pass on.
 *
 * It is a value transformer, not a column blacklist. A provider declares, per metadata operation it permits, a
 * projection: the answer's columns in order, each with the kind of fact it holds and where in the server's answer it
 * sits. `projectMetadata` builds rows from those reads alone, so a column's name always comes from the declaration and
 * never from a key the store holds, and nothing the declaration does not name reaches a row. Each cell is checked
 * against its kind, and a cell that does not fit refuses the whole answer, naming the column and never the value,
 * because a value that does not fit its kind is exactly what a stored value smuggled into a metadata field looks like.
 *
 * Name masking is a different mode, `ProviderCapabilities.machineRedaction`; a provider may declare both.
 *
 * Provider-neutral: it names no engine and no statement language, and a new provider adds a kind here only with the
 * check that kind needs. Browser-safe: it imports nothing.
 */

/**
 * What one column may hold. `name`: a name the store keeps for an object of its own (a collection, a property, a
 * shard, a node, a status or a version), printable, 1 to 512 characters. `count`: a non-negative safe integer.
 * `flag`: true or false.
 */
export type MetadataKind = "name" | "count" | "flag";

/** One column as a capability states it: its name in the answer and the kind of fact it holds. */
export interface MetadataColumn {
  readonly column: string;
  readonly kind: MetadataKind;
}

/** One column as a provider reads it: the declaration, and where in one source the fact sits. */
export interface MetadataField<Source> extends MetadataColumn {
  readonly read: (source: Source) => unknown;
  /** The column may be absent from a source, read as undefined or null; it is answered as null. */
  readonly optional?: true;
}

/** A metadata operation's typed output projection: its columns, in the order the answer gives them. */
export type MetadataProjection<Source> = readonly MetadataField<Source>[];

/** What `ProviderCapabilities.metadataOnly` states: per permitted operation, its columns and their kinds. */
export type MetadataOnlyDeclaration = Readonly<Record<string, readonly MetadataColumn[]>>;

/** A projected cell: never anything but a name, a count, a flag or null. */
export type MetadataCell = string | number | boolean | null;

export interface MetadataRows {
  readonly fields: string[];
  readonly rows: Record<string, MetadataCell>[];
}

/** A cell that does not fit its declared kind; the message names the column and the kind, never the value. */
export class MetadataProjectionError extends Error {
  constructor(
    readonly column: string,
    readonly kind: MetadataKind,
  ) {
    super(
      `The answer's ${JSON.stringify(column)} is not ${KIND_WORDS[kind]}, so the answer was withheld: a metadata-only read answers names, counts and flags, never a stored value.`,
    );
    this.name = "MetadataProjectionError";
    Object.setPrototypeOf(this, MetadataProjectionError.prototype);
  }
}

const KIND_WORDS: Readonly<Record<MetadataKind, string>> = Object.freeze({
  name: "a name of 1 to 512 printable characters",
  count: "a whole number from 0",
  flag: "true or false",
});

const MAX_NAME_LENGTH = 512;

/** Whether `text` holds a control character (C0, DEL or C1) or a line or paragraph separator. */
function holdsControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function fits(kind: MetadataKind, value: unknown): value is MetadataCell {
  switch (kind) {
    case "name":
      return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH && !holdsControl(value);
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "flag":
      return typeof value === "boolean";
  }
}

/** The rows of `sources` under `projection`: the declared columns only, each cell checked against its kind. */
export function projectMetadata<Source>(
  projection: MetadataProjection<Source>,
  sources: readonly Source[],
): MetadataRows {
  const fields: string[] = [];
  for (const field of projection) {
    if (fields.includes(field.column)) {
      throw new Error(`A metadata projection declares the column ${JSON.stringify(field.column)} twice.`);
    }
    fields.push(field.column);
  }
  const rows = sources.map((source) => {
    const row: Record<string, MetadataCell> = {};
    for (const field of projection) {
      const value = field.read(source);
      if (field.optional === true && (value === undefined || value === null)) {
        row[field.column] = null;
      } else if (fits(field.kind, value)) {
        row[field.column] = value;
      } else {
        throw new MetadataProjectionError(field.column, field.kind);
      }
    }
    return row;
  });
  return { fields, rows };
}

/** The capability's statement of `projections`: every operation's columns and kinds, without the readers. */
export function declareMetadataOnly(
  projections: Readonly<Record<string, MetadataProjection<never>>>,
): MetadataOnlyDeclaration {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(projections).map(([operation, fields]) => [
        operation,
        Object.freeze(fields.map(({ column, kind }) => Object.freeze({ column, kind }))),
      ]),
    ),
  );
}
