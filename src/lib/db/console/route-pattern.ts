/**
 * A console's refused routes as data, and the sentence a refused request line reads.
 *
 * A pattern is the path after the console's prefix, split on `/`: a fixed segment matches itself, `*` stands for any
 * one segment, and a trailing `**` for one segment or more. The first row that matches names the route, so a table
 * writes its narrower rows first, and a row with methods matches those methods only.
 */

/** One kind of route a console does not run: what it is, its patterns, and the methods it covers, every one if none. */
export interface RefusedRouteClass {
  readonly what: string;
  readonly patterns: readonly string[];
  readonly methods?: readonly string[];
}

/** What a refusal sentence reads from a console: its prefix, the methods it sends, its rows and what it runs. */
interface RefusedRouteTable {
  readonly pathPrefix: string;
  readonly methods: readonly string[];
  readonly rows: readonly RefusedRouteClass[];
  /** The sentence that closes every refusal, naming what the console runs. */
  readonly runs: string;
}

/** Whether a pattern matches a path's segments. */
export function routePatternMatches(pattern: string, segments: readonly string[]): boolean {
  const parts = pattern.split("/");
  const open = parts[parts.length - 1] === "**";
  const fixed = open ? parts.slice(0, -1) : parts;
  if (open ? segments.length <= fixed.length : segments.length !== fixed.length) return false;
  return fixed.every((part, index) => part === "*" || part === segments[index]);
}

/**
 * The sentence for a request line the console does not run: what the route is, where a row names it, and what the
 * console runs. `relative` is the path after the prefix, without its query string.
 */
export function refusedRouteSentenceFor(table: RefusedRouteTable, method: string, relative: string): string {
  const segments = relative.split("/");
  const found = table.rows.find(
    (row) =>
      (row.methods === undefined || row.methods.includes(method)) &&
      row.patterns.some((pattern) => routePatternMatches(pattern, segments)),
  );
  const line = `${method} ${table.pathPrefix}${relative}`;
  if (found !== undefined) return `${line} is ${found.what}, which this console does not run. ${table.runs}`;
  if (!table.methods.includes(method)) {
    return `${line} is not a request this console runs: it sends ${table.methods.join(" and ")} only. ${table.runs}`;
  }
  return `${line} is not a route this console runs. ${table.runs}`;
}
