/**
 * The Qdrant route table as test data: the 17 v1 operations of tests/fixtures/vector/routes/qdrant-v1.json, which
 * tests/live/vector-routes.ts derives from the OpenAPI document pinned at tag v1.19.1 by its sha256, in the shape
 * `createRestQdrantClient` takes. The provider's own `routes.ts` is held equal to the same file, so a client built
 * from this table builds the paths the provider's does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QdrantOp, QdrantRouteTemplate, QdrantRouteTemplates } from "@/lib/db/providers/vector/qdrant/client";

interface FixtureRoute {
  readonly method: string;
  readonly path: string;
  readonly op: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: readonly string[];
}

interface FixtureTable {
  readonly $generated: { readonly sha256: string; readonly scope: string };
  readonly routes: readonly FixtureRoute[];
}

export const QDRANT_ROUTE_FIXTURE: FixtureTable = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "vector", "routes", "qdrant-v1.json"), "utf8"),
) as FixtureTable;

/** The 17 routes as `QdrantRouteTemplates`, keyed by operation id. */
export const QDRANT_FIXTURE_ROUTES: QdrantRouteTemplates = Object.fromEntries(
  QDRANT_ROUTE_FIXTURE.routes.map((route): [QdrantOp, QdrantRouteTemplate] => [
    route.op as QdrantOp,
    { method: route.method as "GET" | "POST", path: route.path, query: route.query },
  ]),
) as QdrantRouteTemplates;

/** A request line's worth of every operation: the parameters its template declares, and a body where it posts. */
export const QDRANT_SAMPLE_REQUESTS: Readonly<
  Record<QdrantOp, { readonly params: Readonly<Record<string, string>>; readonly body?: string }>
> = Object.fromEntries(
  QDRANT_ROUTE_FIXTURE.routes.map((route) => [
    route.op,
    {
      params: Object.fromEntries(
        Object.entries(route.params).map(([name, kind]) => [name, kind === "point-id" ? "42" : "docs"]),
      ),
      ...(route.method === "POST" ? { body: "{}" } : {}),
    },
  ]),
) as Record<QdrantOp, { readonly params: Readonly<Record<string, string>>; readonly body?: string }>;
