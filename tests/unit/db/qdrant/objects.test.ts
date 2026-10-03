/**
 * The Qdrant object surface (vector-family spec 6.3) over a recording `send` that answers from the captures of the
 * seeded server: the one kind, the listing and its count, `describeObject` with its two reads, `describeObjects`
 * with the caller's bound applied first and four descriptions in flight, and the Source's six reads.
 */
import { describe, expect, test } from "bun:test";
import { machineColumns } from "@/lib/db/detailed-object";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  countQdrantObjects,
  describeQdrantObject,
  describeQdrantObjects,
  listQdrantObjects,
  NO_COLLECTIONS_VISIBLE,
  QDRANT_DESCRIBE_CONCURRENCY,
  QDRANT_OBJECT_KINDS,
  type QdrantObjectContext,
  readQdrantObjectSource,
  readResult,
  VISIBLE_TO_CREDENTIAL,
} from "@/lib/db/providers/vector/qdrant/objects";
import { readQdrantPayloadSample } from "@/lib/db/providers/vector/qdrant/sample";
import { readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import { qdrantSourceParts } from "@/lib/db/providers/vector/qdrant/source";
import type { QdrantAnswer, QdrantRequest } from "@/lib/db/providers/vector/qdrant/client";
import { expectCalls } from "../../../helpers/call-log";
import {
  recordedAnswer,
  resultOf,
  SEEDED_COLLECTIONS,
  surfaceCapture,
  vectorCapture,
} from "../../../helpers/qdrant-surface-fixtures";
import { recordingSend } from "../../../helpers/qdrant-surface-client";

function contextOf(
  answer?: (request: QdrantRequest) => QdrantAnswer | Promise<QdrantAnswer>,
  over: Partial<Pick<QdrantObjectContext, "scoped" | "sliceSupported">> = {},
) {
  const recording = recordingSend(answer);
  const context: QdrantObjectContext = {
    send: recording.send,
    signal: new AbortController().signal,
    sliceSupported: true,
    scoped: false,
    ...over,
  };
  return { context, recording };
}

const json = (value: unknown): QdrantAnswer => ({
  status: 200,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify(value),
});

/** A server listing `names`, each described as the seeded `plain` collection is. */
function listing(names: readonly string[]) {
  return (request: QdrantRequest): QdrantAnswer =>
    request.op === "get_collections"
      ? json({ result: { collections: names.map((name) => ({ name })) }, status: "ok", time: 0 })
      : recordedAnswer({ ...request, params: { collection_name: "plain" } });
}

describe("the kind", () => {
  test("one kind, the collection: a relation with columns and a JSON Source, counted by its listing", () => {
    expect(QDRANT_OBJECT_KINDS).toEqual([
      {
        id: "collection",
        role: "relation",
        label: "Collection",
        labelPlural: "Collections",
        hasColumns: true,
        hasSource: true,
        sourceLanguage: "json",
        countIsListing: true,
      },
    ]);
  });
});

describe("countQdrantObjects and listQdrantObjects", () => {
  test("an open server: the exact count from one listing", async () => {
    const { context, recording } = contextOf();
    expect(await countQdrantObjects(context)).toEqual({ collection: { count: 7 } });
    expectCalls(recording, ["get_collections"]);
  });

  test("with a credential the count is what it may see", async () => {
    const { context } = contextOf(undefined, { scoped: true });
    expect(await countQdrantObjects(context)).toEqual({ collection: { count: 7, sampledFrom: VISIBLE_TO_CREDENTIAL } });
  });

  test("an empty listing reads the sentence with the alias hint, under any credential", async () => {
    const counts = await Promise.all(
      [false, true].map((scoped) => countQdrantObjects(contextOf(listing([]), { scoped }).context)),
    );
    expect(counts).toEqual([
      { collection: { unavailable: NO_COLLECTIONS_VISIBLE } },
      { collection: { unavailable: NO_COLLECTIONS_VISIBLE } },
    ]);
    expect(NO_COLLECTIONS_VISIBLE).toContain("visible to this credential");
    expect(NO_COLLECTIONS_VISIBLE).toContain("alias");
  });

  test("the listing is names only, in Qdrant's order, with no row count and no status", async () => {
    const { context, recording } = contextOf();
    const objects = await listQdrantObjects(context, "collection");
    expect(objects.map((object) => object.name)).toEqual([...SEEDED_COLLECTIONS]);
    expect(objects[0]).toEqual({ path: ["docs"], name: "docs", kind: "collection" });
    expectCalls(recording, ["get_collections"]);
  });

  test("a legacy name such as a:b is listed as the server names it", async () => {
    const { context } = contextOf(listing(["a:b"]));
    expect(await listQdrantObjects(context, "collection")).toEqual([
      { path: ["a:b"], name: "a:b", kind: "collection" },
    ]);
  });

  test("an alias is never a tree object: the listing reads no alias route", async () => {
    const { context, recording } = contextOf();
    await listQdrantObjects(context, "collection");
    expect(recording.calls.some((call) => call.method.includes("aliases"))).toBe(false);
  });

  test("a kind Qdrant does not declare is refused with no request", async () => {
    const { context, recording } = contextOf();
    await expect(listQdrantObjects(context, "alias")).rejects.toThrow('Qdrant declares no object kind "alias"');
    expectCalls(recording, []);
  });

  test("a listing whose answer holds no collections array is refused", async () => {
    const { context } = contextOf(() => json({ result: {}, status: "ok" }));
    await expect(listQdrantObjects(context, "collection")).rejects.toThrow("holds no collections array");
  });
});

describe("describeQdrantObject", () => {
  test("docs: the description, then the sample scroll with payloads and no vectors", async () => {
    const { context, recording } = contextOf();
    const detail = await describeQdrantObject(context, ["docs"], "collection");
    expectCalls(recording, [
      { method: "get_collection", args: ["docs", null] },
      { method: "scroll_points", args: ["docs", surfaceCapture("sample-docs").$captured.request.body] },
    ]);
    expect(detail.path).toEqual(["docs"]);
    expect(detail.columns[0]).toMatchObject({ name: "id", isPrimary: true });
    expect(detail.columns.find((column) => column.name === "title")).toMatchObject({ provenance: "sampled" });
    expect(detail.columns.find((column) => column.name === "category")?.provenance).toBeUndefined();
    expect(detail.indexes).toHaveLength(15);
  });

  test("docs: the machine projection keeps the id, the vectors and the payload indexes, and no sampled key", async () => {
    const { context } = contextOf();
    const detail = await describeQdrantObject(context, ["docs"], "collection");
    const names = machineColumns(detail.columns).map((column) => column.name);
    expect(names).toContain("vector.text");
    expect(names).toContain("category");
    expect(names).not.toContain("title");
    expect(names).not.toContain("mixed");
  });

  test("a collection that reports no points is described with one read", async () => {
    const { context, recording } = contextOf();
    const detail = await describeQdrantObject(context, ["empty_novec"], "collection");
    expectCalls(recording, ["get_collection"]);
    expect(detail.columns).toEqual([{ name: "id", type: "uint64 or UUID", nullable: false, isPrimary: true }]);
  });

  test("a server without the slice condition samples the first page", async () => {
    const { context, recording } = contextOf(undefined, { sliceSupported: false });
    await describeQdrantObject(context, ["docs"], "collection");
    expect(recording.calls[1]).toEqual({
      method: "scroll_points",
      args: ["docs", '{"limit":1000,"with_payload":true,"with_vector":false}'],
    });
  });

  test.each([
    [["docs", "x"], "collection", 'A Qdrant "collection" path is [name]'],
    [[], "collection", 'A Qdrant "collection" path is [name]'],
    [["docs"], "alias", 'Qdrant declares no object kind "alias"'],
  ] as const)("the path %j as %s is refused with no request", async (path, kind, sentence) => {
    const { context, recording } = contextOf();
    await expect(describeQdrantObject(context, path, kind)).rejects.toThrow(sentence);
    expectCalls(recording, []);
  });

  test("a refusal that does not name the collection is named, and no sample is read", async () => {
    const { context, recording } = contextOf(() => {
      throw new QueryError("The collection does not exist or is not visible to this credential.", "qdrant");
    });
    const refused = describeQdrantObject(context, ["gone"], "collection");
    await expect(refused).rejects.toThrow(QueryError);
    await expect(describeQdrantObject(context, ["gone"], "collection")).rejects.toThrow(
      'Collection "gone": The collection does not exist or is not visible to this credential.',
    );
    expectCalls(recording, ["get_collection", "get_collection"]);
  });

  test("a refusal that names the collection, and one of another class, are raised as they are", async () => {
    const named = new QueryError('Collection "gone" is refused.', "qdrant");
    const denied = new AuthenticationError("Qdrant refused the API key or JWT.", "qdrant");
    const raised = await Promise.all(
      [named, denied].map((refusal) =>
        describeQdrantObject(
          contextOf(() => {
            throw refusal;
          }).context,
          ["gone"],
          "collection",
        ).catch((error: unknown) => error),
      ),
    );
    expect(raised).toEqual([named, denied]);
    expect(raised[0]).toBe(named);
    expect(raised[1]).toBe(denied);
  });

  test("a non-Error thrown value passes through untouched", async () => {
    const { context } = contextOf(() => {
      throw "not an error";
    });
    await expect(describeQdrantObject(context, ["gone"], "collection")).rejects.toBe("not an error");
  });
});

describe("describeQdrantObjects", () => {
  test("one listing, then one description per collection, the declared columns only and no sample", async () => {
    const { context, recording } = contextOf();
    const batch = await describeQdrantObjects(context, "collection");
    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path)).toEqual(SEEDED_COLLECTIONS.map((name) => [name]));
    expect(recording.calls.map((call) => call.method)).toEqual([
      "get_collections",
      ...SEEDED_COLLECTIONS.map(() => "get_collection"),
    ]);
    for (const detail of batch.details) {
      expect(detail.columns.every((column) => column.provenance === undefined)).toBe(true);
    }
  });

  test("the caller's limit is applied before any description is read, and the cut is reported", async () => {
    const { context, recording } = contextOf();
    const batch = await describeQdrantObjects(context, "collection", 2);
    expect(batch.details.map((detail) => detail.path)).toEqual([["docs"], ["edge_values"]]);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    expect(recording.calls.map((call) => call.method)).toEqual(["get_collections", "get_collection", "get_collection"]);
  });

  test("a limit the listing does not reach cuts nothing", async () => {
    const { context } = contextOf();
    expect((await describeQdrantObjects(context, "collection", 50)).truncated).toBeUndefined();
  });

  test("at most four descriptions are in flight at once", async () => {
    const names = Array.from({ length: 20 }, (_, index) => `c${index}`);
    const answer = listing(names);
    const { context, recording } = contextOf(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return answer(request);
    });
    const batch = await describeQdrantObjects(context, "collection");
    expect(batch.details).toHaveLength(20);
    expect(recording.maxInFlight()).toBe(QDRANT_DESCRIBE_CONCURRENCY);
  });

  test("after the first failure no further description starts, and the failure is raised", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `c${index}`);
    const answer = listing(names);
    const refusal = new QueryError('Collection "c1" is refused.', "qdrant");
    const { context, recording } = contextOf((request) => {
      if (request.params.collection_name === "c1") throw refusal;
      return answer(request);
    });
    await expect(describeQdrantObjects(context, "collection")).rejects.toBe(refusal);
    expect(recording.calls.length).toBeLessThan(13);
  });

  test("a kind Qdrant does not declare is refused with no request", async () => {
    const { context, recording } = contextOf();
    await expect(describeQdrantObjects(context, "alias")).rejects.toThrow('Qdrant declares no object kind "alias"');
    expectCalls(recording, []);
  });
});

describe("readQdrantObjectSource", () => {
  test("docs: exactly six reads, the scroll with no vectors and a limit of 1,000", async () => {
    const { context, recording } = contextOf();
    const document = await readQdrantObjectSource(context, ["docs"], "collection");
    expectCalls(recording, [
      "get_collection",
      "get_collection_aliases",
      "list_snapshots",
      "get_optimizations",
      "collection_cluster_info",
      { method: "scroll_points", args: ["docs", surfaceCapture("sample-docs").$captured.request.body] },
    ]);
    const body = JSON.parse(recording.calls[5].args?.[1] as string);
    expect(body).toMatchObject({ limit: 1000, with_vector: false, with_payload: true });
    expect(document.path).toEqual(["docs"]);
    expect(document.kind).toBe("collection");
    expect(document.parts.map((part) => part.id)).toEqual(["schema", "state"]);
  });

  test("a collection that reports no points: five reads, and the State says it was not sampled", async () => {
    const { context, recording } = contextOf();
    const document = await readQdrantObjectSource(context, ["empty_novec"], "collection");
    expectCalls(recording, [
      "get_collection",
      "get_collection_aliases",
      "list_snapshots",
      "get_optimizations",
      "collection_cluster_info",
    ]);
    const state = JSON.parse((document.parts[1] as { text: string }).text);
    expect(state.payloadSample.method).toBe("not sampled: the collection reports no points");
  });

  test("the parts are source.ts's over the same answers, cut at the caller's bound", async () => {
    const { context } = contextOf();
    const document = await readQdrantObjectSource(context, ["plain"], "collection", 60);
    const expected = qdrantSourceParts(
      {
        collection: readQdrantCollection("plain", resultOf(vectorCapture("describe-plain"))),
        aliases: resultOf(surfaceCapture("aliases-plain")),
        snapshots: resultOf(surfaceCapture("snapshots-plain")),
        optimizations: resultOf(surfaceCapture("optimizations-plain")),
        cluster: resultOf(surfaceCapture("cluster-plain")),
        sample: readQdrantPayloadSample("plain", surfaceCapture("sample-plain").payload.body, {
          method: "slice 0 of 1, the lowest ids",
          uniform: false,
        }),
      },
      60,
    );
    expect(document.parts).toEqual(expected);
  });

  test("a path that names no collection is refused with no request", async () => {
    const { context, recording } = contextOf();
    await expect(readQdrantObjectSource(context, ["a", "b"], "collection")).rejects.toThrow("is [name]");
    expectCalls(recording, []);
  });
});

describe("readResult", () => {
  test("an integer above 2^53 in a result stays its exact digits", () => {
    expect(readResult({ ...json(0), text: '{"result":{"points_count":9007199254740993}}' }, "x")).toEqual({
      points_count: "9007199254740993",
    });
  });

  test("an answer that is not JSON is refused naming what it answered", () => {
    expect(() => readResult({ ...json(0), text: "<html>" }, "the collection list")).toThrow(
      "Qdrant's answer to the collection list is not JSON Studio can read.",
    );
  });

  test("a JSON answer with no result reads as undefined", () => {
    expect(readResult({ ...json(0), text: "null" }, "x")).toBeUndefined();
  });
});
