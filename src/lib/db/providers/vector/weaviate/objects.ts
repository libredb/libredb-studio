/**
 * The Weaviate object surface (#1566 spec 4): one kind, the collection, with no container level (`containerLevels:
 * []`, the Qdrant shape). Tenants and aliases are details of a collection, in its Source and in the console, never
 * tree rows, by the precedent of Milvus's partitions and Qdrant's aliases (spec 4.1).
 *
 * The listing is one `GET /v1/schema`, which also answers every collection's columns, so `describeObjects` keeps the
 * one-round-trip contract. `describeObject` adds one object read with `include=vector` to a single-tenant collection
 * to spell its vectors' dimensions, which the schema does not declare (spec 4.2); a multi-tenant collection is never
 * read past its schema, so no tenant is touched (W6).
 *
 * Every read goes through the `send` the surface is handed: index.ts gives each call its own limiter permit and the
 * surface's deadline, and raises a failure in errors.ts's words, so nothing here retries or words an HTTP failure.
 */
import { QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
} from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import type { WeaviateAnswer, WeaviateOp, WeaviateSend } from "./client";
import { encodeGraphql } from "./graphql";
import type { WeaviatePathState } from "./execute";
import type { WeaviateSearchModel } from "./request";
import {
  readWeaviateClass,
  readWeaviateSchema,
  type WeaviateClass,
  weaviateCollectionFacts,
  weaviateColumns,
  weaviateIndexes,
} from "./schema";
import { weaviateSourceParts } from "./source";
import { initialPath, type WeaviateVersion } from "./versions";

const PROVIDER: DatabaseType = "weaviate";

const WEAVIATE_COLLECTION_KIND = "collection";

export const WEAVIATE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: WEAVIATE_COLLECTION_KIND,
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    hasColumns: true,
    hasSource: true,
    sourceLanguage: "json",
    countIsListing: true,
  },
]);

/** The deadline of a call outside a console request: connect, the tree, the Source, monitoring. */
export const WEAVIATE_SURFACE_TIMEOUT_MS = 10_000;

/** What a listing shows where a credential is configured: RBAC lists the collections the role may read. */
export const VISIBLE_TO_CREDENTIAL = "the collections visible to this credential";

export const NO_COLLECTIONS_VISIBLE =
  "No collections are visible to this credential: the server holds none, or its role may read none of them.";

/** The reads the object surface sends, and nothing else. */
export type WeaviateObjectOp =
  | "schema"
  | "collection"
  | "objects"
  | "aliases"
  | "shards"
  | "tenants"
  | "aggregate"
  | "graphql";

/** What one surface call runs with; index.ts builds one per call. */
export interface WeaviateSurfaceContext<Ops extends WeaviateOp> {
  readonly send: WeaviateSend<Ops>;
  readonly signal: AbortSignal;
  readonly version: WeaviateVersion;
  readonly paths: WeaviatePathState;
  /** A credential is configured, so a listing holds what it may see rather than every collection. */
  readonly scoped: boolean;
}

export type WeaviateObjectContext = WeaviateSurfaceContext<WeaviateObjectOp>;

export function parseAnswer(answer: WeaviateAnswer, what: string): unknown {
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new QueryError(`Weaviate's answer to ${what} is not JSON Studio can read.`, PROVIDER);
  }
}

/**
 * Every class the credential may see, by name. Weaviate lists them in no stable order (measured: the same seeded
 * server answered three orders), so they are sorted, and the tree, the Tables panel and their 200 bound agree.
 */
export async function readWeaviateClasses(
  context: WeaviateSurfaceContext<"schema">,
): Promise<readonly WeaviateClass[]> {
  const answer = await context.send({ op: "schema", params: {}, query: {} }, context.signal);
  return [...readWeaviateSchema(parseAnswer(answer, "the schema"))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function namedRefusal(error: unknown, name: string): unknown {
  if (!(error instanceof QueryError) || Object.getPrototypeOf(error) !== QueryError.prototype) return error;
  if (error.message.includes(name)) return error;
  return new QueryError(`Collection ${JSON.stringify(name)}: ${error.message}`, PROVIDER);
}

export async function readWeaviateCollection(
  context: WeaviateSurfaceContext<"collection">,
  name: string,
): Promise<WeaviateClass> {
  try {
    const answer = await context.send({ op: "collection", params: { collection: name }, query: {} }, context.signal);
    return readWeaviateClass(parseAnswer(answer, `the definition of collection ${JSON.stringify(name)}`), name);
  } catch (error) {
    throw namedRefusal(error, name);
  }
}

function requireKind(kind: string): void {
  if (kind !== WEAVIATE_COLLECTION_KIND) throw new QueryError(`Weaviate declares no object kind "${kind}"`, PROVIDER);
}

function collectionOf(path: readonly string[], kind: string): string {
  requireKind(kind);
  if (path.length !== 1) {
    throw new QueryError(`A Weaviate "${kind}" path is [name], received ${JSON.stringify(path)}`, PROVIDER);
  }
  return path[0];
}

export async function countWeaviateObjects(
  context: WeaviateSurfaceContext<"schema">,
): Promise<Record<string, KindCount>> {
  const classes = await readWeaviateClasses(context);
  const count: KindCount =
    classes.length === 0
      ? { unavailable: NO_COLLECTIONS_VISIBLE }
      : context.scoped
        ? { count: classes.length, sampledFrom: VISIBLE_TO_CREDENTIAL }
        : { count: classes.length };
  return { [WEAVIATE_COLLECTION_KIND]: count };
}

/** The collections, names only: no row count and no status badge read on a listing (spec 4.3). */
export async function listWeaviateObjects(
  context: WeaviateSurfaceContext<"schema">,
  kind: string,
): Promise<DatabaseObject[]> {
  requireKind(kind);
  return (await readWeaviateClasses(context)).map((definition) => ({
    path: [definition.name],
    name: definition.name,
    kind: WEAVIATE_COLLECTION_KIND,
  }));
}

/** One object's vector lengths, by vector name: what spells a dimension the schema does not declare. */
async function sampledDimensions(
  context: WeaviateSurfaceContext<"objects">,
  definition: WeaviateClass,
): Promise<ReadonlyMap<string, number>> {
  if (definition.multiTenant || definition.vectors.length === 0) return new Map();
  const answer = await context.send(
    { op: "objects", params: {}, query: { class: definition.name, limit: "1", include: "vector" } },
    context.signal,
  );
  const parsed = parseAnswer(answer, `an object of ${JSON.stringify(definition.name)}`);
  const objects = typeof parsed === "object" && parsed !== null ? (parsed as { objects?: unknown }).objects : undefined;
  const first = Array.isArray(objects) && objects.length > 0 ? (objects[0] as Record<string, unknown>) : undefined;
  const dimensions = new Map<string, number>();
  if (first === undefined) return dimensions;
  if (Array.isArray(first.vector) && first.vector.length > 0) dimensions.set("", first.vector.length);
  if (typeof first.vectors === "object" && first.vectors !== null) {
    for (const [name, value] of Object.entries(first.vectors as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length > 0) dimensions.set(name, value.length);
    }
  }
  return dimensions;
}

/** A collection's columns and indexes: its definition, and one object read for its vectors' dimensions. */
export async function describeWeaviateObject(
  context: WeaviateSurfaceContext<"collection" | "objects">,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const definition = await readWeaviateCollection(context, collectionOf(path, kind));
  const dimensions = await sampledDimensions(context, definition);
  return {
    path: [definition.name],
    columns: [...weaviateColumns(definition, dimensions)],
    indexes: [...weaviateIndexes(definition)],
    foreignKeys: [],
  };
}

/** Every listed collection's columns from the one schema read: one round trip, the caller's limit applied after. */
export async function describeWeaviateObjects(
  context: WeaviateSurfaceContext<"schema">,
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  requireKind(kind);
  const classes = await readWeaviateClasses(context);
  const cut = limit !== undefined && classes.length > limit;
  const details = (cut ? classes.slice(0, limit) : classes).map(
    (definition): ObjectDetail => ({
      path: [definition.name],
      columns: [...weaviateColumns(definition)],
      indexes: [...weaviateIndexes(definition)],
      foreignKeys: [],
    }),
  );
  return cut ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
}

/** The aggregate model of a plain count, the one both encoders write for the Source and the Tables panel. */
function countModel(collection: string): WeaviateSearchModel {
  return {
    op: "aggregate",
    collection,
    tenant: null,
    where: null,
    limit: null,
    offset: null,
    autoLimit: null,
    consistencyLevel: null,
    returnProperties: null,
    returnMetadata: [],
    query: null,
    queryProperties: null,
    fusionType: null,
    maxVectorDistance: null,
    vector: null,
    id: null,
    targetVector: null,
    distance: null,
    certainty: null,
    groupBy: null,
  };
}

function countOf(parsed: unknown, path: "rest" | "graphql", collection: string): number | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  if (path === "rest") {
    const count = (parsed as { count?: unknown }).count;
    return typeof count === "number" ? count : null;
  }
  const rows = (parsed as { data?: { Aggregate?: Record<string, unknown> } }).data?.Aggregate?.[collection];
  const first = Array.isArray(rows) ? (rows[0] as { meta?: { count?: unknown } } | undefined) : undefined;
  return typeof first?.meta?.count === "number" ? first.meta.count : null;
}

/**
 * A single-tenant collection's exact object count, aggregate `meta.count`, over the path the version decides (spec
 * 4.3). A failure answers null with no second attempt: a count is a detail, never the reason a Source fails.
 */
export async function countWeaviateCollection(
  context: WeaviateSurfaceContext<"aggregate" | "graphql">,
  definition: WeaviateClass,
): Promise<number | null> {
  if (definition.multiTenant) return null;
  const path = context.paths.get("other") ?? initialPath(context.version, "other");
  try {
    const answer =
      path === "rest"
        ? await context.send(
            { op: "aggregate", params: { collection: definition.name }, query: {}, body: "{}" },
            context.signal,
          )
        : await context.send(
            {
              op: "graphql",
              params: {},
              query: {},
              body: encodeGraphql(countModel(definition.name), weaviateCollectionFacts(definition)),
            },
            context.signal,
          );
    return countOf(JSON.parse(answer.text), path, definition.name);
  } catch {
    return null;
  }
}

/**
 * The Source: the definition, the aliases, then for a single-tenant collection its shards and its exact count, and
 * for a multi-tenant one its tenants with their statuses, which reading never changes (spec A.4).
 */
export async function readWeaviateObjectSource(
  context: WeaviateObjectContext,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const name = collectionOf(path, kind);
  const definition = await readWeaviateCollection(context, name);
  const aliases = parseAnswer(
    await context.send({ op: "aliases", params: {}, query: {} }, context.signal),
    "the alias list",
  );
  const params = { collection: definition.name };
  let shards: unknown = null;
  let tenants: unknown = null;
  let count: number | null = null;
  if (definition.multiTenant) {
    tenants = parseAnswer(
      await context.send({ op: "tenants", params, query: {} }, context.signal),
      `the tenants of ${JSON.stringify(definition.name)}`,
    );
  } else {
    shards = parseAnswer(
      await context.send({ op: "shards", params, query: {} }, context.signal),
      `the shards of ${JSON.stringify(definition.name)}`,
    );
    count = await countWeaviateCollection(context, definition);
  }
  return {
    path: [definition.name],
    kind,
    parts: weaviateSourceParts({ definition, aliases, shards, tenants, count }, limit),
  };
}
