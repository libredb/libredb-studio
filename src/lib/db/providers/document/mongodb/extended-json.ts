/**
 * The query is read as MongoDB Extended JSON, the format mongosh, Compass and
 * `mongoexport` print, and not as plain JSON. Plain JSON has no ObjectId and no Date, so
 * a document the grid shows could not be found, updated or deleted by its `_id`:
 * measured on MongoDB 8.2.12, `{"_id": {"$oid": ...}}` reached the server as an operator
 * and failed `unknown operator: $oid`, a date range matched nothing, and `{"$date": ...}`
 * in an insert was stored as a subdocument with a `$date` key.
 *
 * WHY NOT `EJSON.parse` OVER THE WHOLE TEXT. The bson parser replaces an object with a
 * value as soon as ANY of its keys is one it knows, and drops the others in silence:
 * `{"$regex": "^a", "$nin": ["admin"]}` becomes the bare regular expression, so a
 * `deleteMany` with that filter deletes `admin` too. So the statement is read with plain
 * `JSON.parse` and then walked, and an object is handed to the bson parser only when its
 * keys are EXACTLY one wrapper's (`EJSON_WRAPPERS`). An object that mixes a wrapper key
 * with anything else is refused, and an object with no wrapper key is left as written,
 * which keeps every query operator, the legacy `{"$regex", "$options"}` form included,
 * exactly what the server receives. The wrapper list and the mixed-object rule are the
 * command reader's (`envelope.ts`), so the reader and this reviver hold one rule.
 *
 * A plain number is never touched, so the driver writes it exactly as it did under
 * `JSON.parse`: int32 when it fits, a double otherwise, and `options.limit` stays the
 * number the cursor wants.
 */

import type { Document } from "mongodb";
// The Extended JSON parser, reached through a namespace import for the reason `index.ts` gives:
// bun does not see `BSON` as a named export of the driver's CommonJS entry.
import * as mongodbDriver from "mongodb";
import { RefusedBeforeSendError } from "../../../errors";
import { EJSON_WRAPPERS, type MongoJsonObject, type MongoReadEnvelope, wrapperShapeProblem } from "./envelope";

/**
 * One admitted read with its Extended JSON values revived into the BSON values they name: the command reader's
 * envelope (`MongoReadEnvelope`), each object slot now a driver document.
 */
export type RevivedMongoReadEnvelope = { readonly collection: string; readonly database?: string } & (
  | {
      readonly operation: "find";
      readonly filter?: Document;
      readonly options?: {
        readonly projection?: Document;
        readonly sort?: Document;
        readonly skip?: number;
        readonly limit?: number;
      };
    }
  | { readonly operation: "findOne"; readonly filter?: Document; readonly options?: { readonly projection?: Document } }
  | { readonly operation: "aggregate"; readonly pipeline: readonly Document[] }
  | { readonly operation: "count"; readonly filter?: Document }
  | { readonly operation: "distinct"; readonly field: string; readonly filter?: Document }
);

/**
 * The reader's envelope with every Extended JSON value of its filter, projection, sort and pipeline revived by the
 * rules `parseExtendedJson` reads a whole command with, each error naming its path from the command's root. A
 * wrapper the reader admitted by its shape and that cannot be read, such as `{"$oid": "zz"}`, is refused here, so
 * nothing is sent.
 */
export function reviveEnvelope(envelope: MongoReadEnvelope): RevivedMongoReadEnvelope {
  const target =
    envelope.database === undefined
      ? { collection: envelope.collection }
      : { collection: envelope.collection, database: envelope.database };
  switch (envelope.operation) {
    case "find": {
      const options = envelope.options;
      return {
        ...target,
        operation: "find",
        ...revivedSlot(envelope.filter, "filter"),
        ...(options === undefined
          ? {}
          : {
              options: {
                ...(options.projection === undefined
                  ? {}
                  : { projection: revivedObject(options.projection, "options.projection") }),
                ...(options.sort === undefined ? {} : { sort: revivedObject(options.sort, "options.sort") }),
                ...(options.skip === undefined ? {} : { skip: options.skip }),
                ...(options.limit === undefined ? {} : { limit: options.limit }),
              },
            }),
      };
    }
    case "findOne":
      return {
        ...target,
        operation: "findOne",
        ...revivedSlot(envelope.filter, "filter"),
        ...(envelope.options === undefined
          ? {}
          : {
              options:
                envelope.options.projection === undefined
                  ? {}
                  : { projection: revivedObject(envelope.options.projection, "options.projection") },
            }),
      };
    case "aggregate":
      return {
        ...target,
        operation: "aggregate",
        pipeline: envelope.pipeline.map((stage, index) => revivedObject(stage, `pipeline.${index}`)),
      };
    case "count":
      return { ...target, operation: "count", ...revivedSlot(envelope.filter, "filter") };
    case "distinct":
      return { ...target, operation: "distinct", field: envelope.field, ...revivedSlot(envelope.filter, "filter") };
  }
}

/** `{filter}` revived, or nothing when the envelope carries none. */
function revivedSlot(filter: MongoJsonObject | undefined, path: string): { readonly filter?: Document } {
  return filter === undefined ? {} : { filter: revivedObject(filter, path) };
}

/**
 * One object slot revived. It stays an object: the reader refuses a wrapper standing where a field, an operator or a
 * stage name belongs (`readSlot` and `readStages` in `envelope.ts`), so no slot revives into a single BSON value.
 */
function revivedObject(object: MongoJsonObject, path: string): Document {
  return reviveExtendedJson(object, path) as Document;
}

/**
 * Relaxed for every wrapper but one: relaxed accepts a `$date` as a plain number of
 * milliseconds, which canonical refuses below 2^31. `useBigInt64` because relaxed reads
 * `$numberLong` into a JS number, rounding `9007199254740993` to `...992`; a bigint holds
 * it, and the driver writes a bigint as a 64-bit integer. `$numberDouble` alone is read
 * canonically, because relaxed answers a JS number and `{"$numberDouble": "5"}` would be
 * written as int32 rather than the double it names.
 */
const EJSON_RELAXED = { relaxed: true, useBigInt64: true } as const;
const EJSON_CANONICAL = { relaxed: false, useBigInt64: true } as const;

/** The 64-bit range a `$numberLong` must fit. The parser wraps a larger one to a negative in silence. */
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

export function parseExtendedJson(text: string): Document {
  return reviveExtendedJson(JSON.parse(text), "") as Document;
}

/** A value the reviver cannot read: refused before anything is sent, in this server's words. */
function extendedJsonError(path: string, reason: string): RefusedBeforeSendError {
  return new RefusedBeforeSendError(`Invalid Extended JSON in the query at "${path}": ${reason}`, "mongodb");
}

function reviveExtendedJson(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => reviveExtendedJson(item, joinPath(path, String(index))));
  if (typeof value !== "object" || value === null) return value;
  const problem = wrapperShapeProblem(value);
  if (problem !== null) throw extendedJsonError(path, problem);
  const entries = Object.entries(value);
  const wrapper = entries.find(([key]) => EJSON_WRAPPERS.has(key))?.[0];
  if (wrapper === undefined) {
    return Object.fromEntries(entries.map(([key, child]) => [key, reviveExtendedJson(child, joinPath(path, key))]));
  }
  let parsed: unknown;
  try {
    parsed = mongodbDriver.BSON.EJSON.parse(
      JSON.stringify(value),
      wrapper === "$numberDouble" ? EJSON_CANONICAL : EJSON_RELAXED,
    );
  } catch (error) {
    // A wrapper that cannot be read, such as a `$oid` that is not 24 hex digits. The JSON
    // itself was fine, so the format example `parseQuery` answers with would point at the
    // wrong thing; the parser's own sentence says what is wrong.
    throw extendedJsonError(path, (error as Error).message);
  }
  // The parser answers `Date.parse("next tuesday")`, which is NaN, with an invalid Date
  // rather than an error, and the driver serialises an invalid Date as 0: 1970-01-01.
  if (parsed instanceof Date && Number.isNaN(parsed.getTime())) {
    throw extendedJsonError(
      path,
      'the $date is not a date. Use an ISO-8601 string such as "2025-01-01T00:00:00Z" or milliseconds since the epoch',
    );
  }
  if (wrapper === "$numberLong" && (value as { $numberLong: string }).$numberLong !== String(parsed)) {
    // Reached only for a value the parser accepted, so it is a decimal string: a
    // round trip that differs is one `BigInt.asIntN(64, ...)` wrapped.
    const exact = BigInt((value as { $numberLong: string }).$numberLong);
    if (exact < INT64_MIN || exact > INT64_MAX) {
      throw extendedJsonError(path, `$numberLong ${exact} is outside the 64-bit integer range`);
    }
  }
  return parsed;
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
