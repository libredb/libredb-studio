import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type RouteModule = Record<string, ((req: never) => Promise<Response>) | undefined>;

/**
 * Recursively finds every route.ts under `rootDir`, returning [routeKey, loader] pairs sorted
 * for stable test output. `routeKey` is the path from `rootDir` down to the route's own
 * directory, joined with "/" (e.g. "db/schema/list" for `<rootDir>/db/schema/list/route.ts`,
 * or "explain" for `<rootDir>/explain/route.ts` when `rootDir` is already `src/app/api/ai`).
 *
 * The import specifier returned by each loader is a filesystem path computed at test-run time,
 * never the "@/" alias used elsewhere: bun resolves "@/" only when the specifier is a literal
 * string it can see at parse time, and a path built from a directory listing is not one. A
 * plain path has no such restriction - bun's dynamic import() resolves it like any other
 * runtime module specifier, and the "@/" imports *inside* each route.ts still resolve normally
 * there, since that resolution happens in that file's own context, independent of how the
 * importer named it.
 *
 * Shared by every route-enumeration test under tests/security/ - the AI-only enumeration in
 * rate-limit-routes.test.ts and the whole-tree enumeration in route-auth.test.ts both call this
 * one function, so they cannot independently drift into two different ideas of "every route".
 * A directory that legitimately has both a route.ts AND subdirectories that are themselves
 * routes (e.g. src/app/api/db/schema/route.ts alongside db/schema/list and db/schema/relations)
 * is handled correctly: each level is checked for its own route.ts before recursing further.
 */
export function discoverRoutes(rootDir: string): Array<[string, () => Promise<RouteModule>]> {
  const results: Array<[string, () => Promise<RouteModule>]> = [];

  function walk(dir: string, keySegments: string[]): void {
    const routeFile = join(dir, "route.ts");
    if (existsSync(routeFile)) {
      results.push([keySegments.join("/"), () => import(routeFile) as Promise<RouteModule>]);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), [...keySegments, entry.name]);
      }
    }
  }

  walk(rootDir, []);
  return results.sort(([a], [b]) => a.localeCompare(b));
}
