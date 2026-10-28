/**
 * The pieces the query generators and every engine's generator row share: the object's own segment, a name written
 * into a comment line, a key-value prefix group, and a glob escape. Pure and browser-safe, and it imports nothing, so a
 * row beside its provider reads it without reaching the dispatcher in `src/lib/query-generators.ts`.
 */

/**
 * The object's own segment, which is the LAST one and is never read by index 0 (standing
 * ruling 5g): at container depth 2 the object is `path[2]`, and a positional read there
 * addresses a container instead.
 *
 * An empty path is refused rather than rendered. It is a caller that lost the address, and
 * every dialect below would otherwise spell it silently: `FROM ` on SQL, `get ` on LibreDB,
 * `"collection": undefined` on MongoDB. Both generators resolve it before they branch, so
 * one refusal covers every dialect.
 *
 * Exported for `useTabManager`, which names the tab it opens after the object and has the
 * same two reasons to read the last segment and to refuse an empty address.
 */
export function objectSegment(path: readonly string[]): string {
  const segment = path[path.length - 1];
  if (segment === undefined) throw new Error("Cannot generate a query: the object address has no segments.");
  return segment;
}

/**
 * Render a schema-tree node name for a `#` comment line. A node name is a real
 * key/collection name taken from the server, and a Redis key is an arbitrary
 * byte string — so a name containing a newline used to END the header comment
 * and turn its own remainder into the first RUNNABLE line of the cheatsheet,
 * which the provider then executed (`a\nDEL user:1 x` ran `DEL user:1`). The
 * per-argument defence never engaged, because the injection travelled through
 * the comment rather than through a command.
 *
 * JSON quoting is the fix: it escapes CR, LF and the quote character in one
 * lossless step, and for an ordinary name it renders exactly the `"name"` the
 * headers already wrote by hand. Any name entering a comment line must go
 * through this (#427), a PromQL metric's name included (#1085).
 */
export function commentName(name: string): string {
  return JSON.stringify(name);
}

/**
 * Resolve a key-value schema-tree node name to its command shape. A node is
 * either a `:`-prefix group (e.g. `users:*`, whose rows live under the `users:`
 * prefix) or a bare single key with no colon. The `*` is stripped so the base is
 * the literal prefix used in commands (`users:*` -> `users:`).
 *
 * Shared by the LibreDB and Redis rows: both build their tree from the same
 * `keyGrouping` grouping, so a future change to what a prefix node looks like
 * must not be able to make the two dialects disagree (#427).
 */
export function prefixGroup(name: string): { isPrefixGroup: boolean; base: string } {
  if (name.endsWith(":*")) return { isPrefixGroup: true, base: name.slice(0, -1) };
  return { isPrefixGroup: false, base: name };
}

/**
 * Escape Redis glob metacharacters. Applied ONLY to the prefix half of a MATCH
 * pattern, never to a key argument: a real key `a[b:1` groups to `a[b:*`, and an
 * unescaped `[` opens a glob class that matches the wrong set. Escaping a key
 * argument would instead corrupt a literal key that genuinely contains `*` (#427).
 */
export function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]^]/g, String.raw`\$&`);
}
