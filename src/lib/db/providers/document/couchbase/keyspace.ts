/**
 * Couchbase keyspace mapping (issue #262, decision 4)
 *
 * Pure functions, no I/O. Two jobs:
 *
 * 1. Flatten bucket > scope > collection for the flat schema explorer, using
 *    exactly the rule PostgreSQL uses for schema > table: the default scope is
 *    implicit, everything else is qualified.
 * 2. Build the executable, backtick-quoted keyspace path.
 *
 * Quoting is a security boundary. SQL++ has no bind parameter for identifiers,
 * so keyspace paths are assembled by concatenation; an identifier carrying a
 * backtick must not be able to terminate its own quoting and have the remainder
 * parsed as SQL++. Couchbase escapes an embedded backtick by doubling it.
 */

import type { Keyspace } from "./transport";

/** Scope every bucket has and which the explorer renders implicitly. */
export const COUCHBASE_DEFAULT_SCOPE = "_default";

/** Separator between scope and collection in a display name. */
const DISPLAY_SEPARATOR = ".";

/**
 * Quote an identifier for use in a SQL++ statement.
 *
 * Reserved words (`bucket`, `scope`, ...) only parse when quoted, and doubling
 * embedded backticks keeps hostile identifiers inside their quotes.
 */
export function quoteIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

/** Flatten a scope/collection pair into the name the explorer shows. */
export function keyspaceDisplayName(scope: string, collection: string): string {
  return scope === COUCHBASE_DEFAULT_SCOPE ? collection : `${scope}${DISPLAY_SEPARATOR}${collection}`;
}

/**
 * Inverse of {@link keyspaceDisplayName}.
 *
 * Scope names cannot contain a dot, so the first separator is the boundary and
 * anything after it belongs to the collection.
 */
export function keyspaceFromDisplayName(bucket: string, displayName: string): Keyspace {
  const separatorIndex = displayName.indexOf(DISPLAY_SEPARATOR);
  if (separatorIndex === -1) {
    return { bucket, scope: COUCHBASE_DEFAULT_SCOPE, collection: displayName };
  }
  return {
    bucket,
    scope: displayName.slice(0, separatorIndex),
    collection: displayName.slice(separatorIndex + DISPLAY_SEPARATOR.length),
  };
}

/** Build the executable keyspace path, every segment quoted. */
export function keyspacePath(keyspace: Keyspace): string {
  return [keyspace.bucket, keyspace.scope, keyspace.collection].map(quoteIdentifier).join(DISPLAY_SEPARATOR);
}
