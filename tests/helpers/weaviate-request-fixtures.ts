/**
 * What the Weaviate request and encoder unit tests share: phase 0 of one console text, the refusal it throws, a
 * collection's facts read from a recorded `GET /v1/schema/{collection}` answer, and facts written by hand for the
 * shapes the seeded servers do not hold (no vector, several vectors, a vectorizer).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { toJsonText } from "@/lib/db/console/tagged-json";
import {
  parseWeaviateRequest,
  type WeaviatePlan,
  type WeaviateSearchModel,
  weaviatePhase0,
} from "@/lib/db/providers/vector/weaviate/request";
import {
  readWeaviateSchema,
  type WeaviateCollectionFacts,
  type WeaviateVector,
  weaviateCollectionFacts,
} from "@/lib/db/providers/vector/weaviate/schema";

export const plan = (text: string): WeaviatePlan => weaviatePhase0(parseWeaviateRequest(text));

/** The body phase 0 hands on, as JSON text. */
export const bodyText = (text: string): string | null => {
  const body = plan(text).body;
  return body === null ? null : toJsonText(body);
};

export const searchOf = (text: string): WeaviateSearchModel => plan(text).search as WeaviateSearchModel;

/** The refusal a call throws; anything else, or no throw, fails the test. */
export function refusalOf(run: () => unknown): RequestRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error("accepted");
}

/** Phase 0's refusal of a text, as the three facts a test compares. */
export function refused(text: string): { phase: number; key: string | null; message: string } {
  const error = refusalOf(() => plan(text));
  return { phase: error.phase, key: error.key, message: error.message };
}

interface RecordedExchange {
  readonly method: string;
  readonly path: string;
  readonly body: string | null;
  readonly answer: { readonly status: number; readonly text: string } | null;
}

const FIXTURES = join(import.meta.dir, "..", "fixtures", "weaviate");

export function recordedExchanges(service: string, file: string): readonly RecordedExchange[] {
  return (
    JSON.parse(readFileSync(join(FIXTURES, service, `${file}.json`), "utf8")) as { exchanges: RecordedExchange[] }
  ).exchanges;
}

/** A collection's facts as the seeded server's `GET /v1/schema` described it: Article, Product, TenantNotes, ... */
export function recordedFacts(collection: string): WeaviateCollectionFacts {
  const exchange = recordedExchanges("weaviate", "surface").find(
    (entry) => entry.method === "GET" && entry.path === "/v1/schema" && entry.answer?.status === 200,
  );
  const found = readWeaviateSchema(JSON.parse(exchange?.answer?.text ?? "{}")).find(
    (definition) => definition.name === collection,
  );
  if (found === undefined) throw new Error(`no recorded definition of ${collection}`);
  return weaviateCollectionFacts(found);
}

/** Every distinct GraphQL body the 1.37.4 server answered, in the order first sent, across its records. */
export function recordedGraphqlBodies(): readonly string[] {
  const bodies = ["searches", "surface", "reads"].flatMap((file) =>
    recordedExchanges("weaviate-1-37", file)
      .filter((entry) => entry.path === "/v1/graphql" && entry.body !== null)
      .map((entry) => entry.body as string),
  );
  return [...new Set(bodies)];
}

const vector = (name: string, vectorizer = "none"): WeaviateVector => ({
  name,
  vectorizer,
  indexType: "hnsw",
  distance: "cosine",
  quantization: null,
});

/** Facts written by hand: plain text properties, the vectors named, and optionally a reference and tenancy. */
export function handFacts(options: {
  readonly name?: string;
  readonly vectors?: readonly (string | readonly [string, string])[];
  readonly properties?: readonly string[];
  readonly references?: readonly string[];
  readonly multiTenant?: boolean;
}): WeaviateCollectionFacts {
  const properties = options.properties ?? ["title"];
  return {
    name: options.name ?? "Doc",
    multiTenant: options.multiTenant ?? false,
    autoTenantActivation: false,
    vectors: (options.vectors ?? [""]).map((entry) =>
      typeof entry === "string" ? vector(entry) : vector(entry[0], entry[1]),
    ),
    selections: new Map(properties.map((name) => [name, { name }])),
    plainProperties: properties,
    intProperties: new Set(),
    referenceProperties: new Set(options.references ?? []),
  };
}
