/**
 * What this provider hands db2-node as parameters, checked before the driver sees them (#786).
 *
 * Every parameter list the provider sends passes through `normaliseParams` first, the catalog
 * reads included.
 */

import { QueryError } from "../../../errors";

/** The `typeof` answers db2-node binds as the value they are. */
const SCALAR_TYPES = new Set(["string", "number", "bigint", "boolean", "undefined"]);

/**
 * The parameters as the driver may take them, or a refusal (M3).
 *
 * db2-node 1.0.24 binds a `bigint` losslessly and a `Date` as its UTC timestamp, measured on
 * Db2 LUW 12.1.0.0 and 11.5.9.0: on 1.0.22 the first aborted the process (K10) and the second
 * was bound as the text `{}`, which is what this function used to stand between.
 *
 * What it still refuses is an array or any other object. The driver reads an array of integers
 * from 0 to 255 as BINARY bytes, so `[1, 2]` meant as a list would be written as two bytes, and
 * it refuses any other object with an error of its own; the refusal here names the parameter
 * either way. A byte buffer goes on: binary data is what it is.
 *
 * `undefined` stays `undefined`, so a statement with no parameters is sent with none rather
 * than with an empty list.
 */
export function normaliseParams(params?: unknown[]): unknown[] | undefined {
  if (params === undefined) return undefined;
  return params.map((value, index) => {
    if (value === null || value instanceof Uint8Array || value instanceof Date || SCALAR_TYPES.has(typeof value)) {
      return value;
    }
    const kind = Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`;
    throw new QueryError(
      `Parameter ${index + 1} is ${kind}; Db2 parameters here are strings, numbers, bigints, booleans, dates, null ` +
        "and byte buffers, and db2-node reads an array of small integers as binary bytes. Pass each value as its " +
        "own parameter.",
      "db2",
    );
  });
}
