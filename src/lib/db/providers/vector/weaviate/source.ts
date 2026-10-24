/**
 * A collection's Source (#1566 spec 4.4): two JSON parts, a human surface only, as Qdrant's and Milvus's.
 *
 * `Schema` is the class definition in Weaviate's own vocabulary, unedited (spec W9). `State` is what the collection
 * holds: the aliases that point at it, then for a single-tenant collection its shards with their statuses and its
 * exact object count, and for a multi-tenant one its tenant count and the first 1,024 tenants by name with their
 * activity statuses, as Milvus lists partitions. Tenant and alias names are data, serialised with `JSON.stringify`.
 *
 * Pure: it receives the answers and never a client.
 */
import { applySourceBound } from "@/lib/db/object-kinds";
import type { ObjectSourcePart } from "@/lib/db/types";
import { WEAVIATE_BOUNDS } from "./routes";
import type { WeaviateClass } from "./schema";

type JsonObject = Readonly<Record<string, unknown>>;

export interface WeaviateSourceInput {
  readonly definition: WeaviateClass;
  /** The `GET /v1/aliases` answer. */
  readonly aliases: unknown;
  /** The `GET /v1/schema/{collection}/shards` answer, or null for a multi-tenant collection. */
  readonly shards: unknown;
  /** The `GET /v1/schema/{collection}/tenants` answer, or null for a single-tenant collection. */
  readonly tenants: unknown;
  /** The exact count, or null where none was read. */
  readonly count: number | null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PER_TENANT_COUNT =
  'Per-tenant counts are not read here: run POST /v1/aggregate/<collection> {"tenant": "<name>"} for one HOT tenant.';
export const COUNT_NOT_READ = "not read: the aggregate count failed or this server answered none";

/** The alias names that point at `collection`. */
function aliasesOf(aliases: unknown, collection: string): readonly string[] {
  if (!isObject(aliases) || !Array.isArray(aliases.aliases)) return [];
  return aliases.aliases.flatMap((entry: unknown) =>
    isObject(entry) && entry.class === collection && typeof entry.alias === "string" ? [entry.alias] : [],
  );
}

function shardsOf(shards: unknown): readonly JsonObject[] {
  if (!Array.isArray(shards)) return [];
  return shards.flatMap((entry: unknown) =>
    isObject(entry)
      ? [
          {
            name: entry.name,
            status: entry.status,
            ...(entry.vectorQueueSize === undefined ? {} : { vectorQueueSize: entry.vectorQueueSize }),
          },
        ]
      : [],
  );
}

function tenantsOf(tenants: unknown): { readonly total: number; readonly listed: readonly JsonObject[] } {
  if (!Array.isArray(tenants)) return { total: 0, listed: [] };
  const entries = tenants
    .flatMap((entry: unknown) =>
      isObject(entry) && typeof entry.name === "string"
        ? [{ name: entry.name, activityStatus: entry.activityStatus ?? null }]
        : [],
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { total: entries.length, listed: entries.slice(0, WEAVIATE_BOUNDS.sourceTenants) };
}

/** The `State` part's document. */
export function weaviateStateDocument(input: WeaviateSourceInput): JsonObject {
  const { definition } = input;
  const base = {
    multiTenant: definition.multiTenant,
    ...(definition.multiTenant ? { autoTenantActivation: definition.autoTenantActivation } : {}),
    aliases: aliasesOf(input.aliases, definition.name),
  };
  if (definition.multiTenant) {
    const { total, listed } = tenantsOf(input.tenants);
    return {
      ...base,
      tenantCount: total,
      tenants: listed,
      ...(total > listed.length ? { tenantsListed: `the first ${listed.length} of ${total} by name` } : {}),
      objectCount: PER_TENANT_COUNT,
    };
  }
  return {
    ...base,
    shards: shardsOf(input.shards),
    objectCount: input.count ?? COUNT_NOT_READ,
    ...(input.count === null ? {} : { objectCountKind: "exact, aggregate meta.count" }),
  };
}

function jsonPart(id: string, label: string, document: JsonObject, limit: number | undefined): ObjectSourcePart {
  const bounded = applySourceBound(JSON.stringify(document, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

/** The two parts, Schema then State, each cut at the caller's bound through the shared helper. */
export function weaviateSourceParts(
  input: WeaviateSourceInput,
  limit?: number,
): readonly [ObjectSourcePart, ObjectSourcePart] {
  return [
    jsonPart("schema", "Schema", input.definition.definition, limit),
    jsonPart("state", "State", weaviateStateDocument(input), limit),
  ];
}
