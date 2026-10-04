/**
 * The payload sample and its typing (vector-family spec 6.3). The requests are held equal to the ones
 * tests/live/qdrant-surface-evidence.ts recorded for the seeded collections, and the typing runs over those
 * recorded answers: `payload_spread` holds a `variant` key whose type changes with the id, integral floats written
 * from JavaScript, and keys that few points carry.
 */
import { describe, expect, test } from "bun:test";
import { machineColumns } from "@/lib/db/detailed-object";
import { QueryError } from "@/lib/db/errors";
import {
  QDRANT_SAMPLE_POINTS,
  qdrantSampleCoverage,
  qdrantSampledColumns,
  qdrantSampleNotices,
  qdrantSampleRead,
  readQdrantPayloadSample,
} from "@/lib/db/providers/vector/qdrant/sample";
import { qdrantCount, qdrantPayloadIndexes, readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import { resultOf, surfaceCapture, vectorCapture } from "../../../helpers/qdrant-surface-fixtures";

const UNIFORM = { method: "slice 0 of 2, uniform by id", uniform: true };
const LOWEST = { method: "first page, the lowest ids", uniform: false };

/** A scroll answer over hand-written payloads, for the typing rules no seeded collection isolates. */
function scrollAnswer(payloads: readonly unknown[], nextPageOffset: unknown = null): string {
  return JSON.stringify({
    result: { points: payloads.map((payload, id) => ({ id, payload })), next_page_offset: nextPageOffset },
    status: "ok",
    time: 0,
  });
}

function typesOf(payloads: readonly unknown[]) {
  const sample = readQdrantPayloadSample("probe", scrollAnswer(payloads), LOWEST);
  return Object.fromEntries(sample.keys.map((entry) => [entry.key, [entry.type, entry.nullable]]));
}

describe("qdrantSampleRead", () => {
  test.each(["docs", "edge_values", "payload_spread", "plain", "small_dtypes"])(
    "%s: the request is the one the evidence run recorded",
    (collection) => {
      const points = qdrantCount(
        (resultOf(vectorCapture(`describe-${collection}`)) as { points_count: unknown }).points_count,
      );
      const read = qdrantSampleRead(collection, points, true);
      const recorded = surfaceCapture(`sample-${collection}`).$captured.request;
      expect(read?.request).toEqual({
        op: "scroll_points",
        params: { collection_name: collection },
        query: {},
        body: recorded.body as string,
      });
      expect(recorded.path).toBe(`/collections/${collection}/points/scroll`);
    },
  );

  test("docs: 1,000 points with payloads and no vectors, through slice 0 of 2", () => {
    const read = qdrantSampleRead("docs", 2000, true);
    expect(read?.request.body).toBe(
      '{"filter":{"must":[{"slice":{"index":0,"total":2}}]},"limit":1000,"with_payload":true,"with_vector":false}',
    );
    expect(read).toMatchObject({ method: "slice 0 of 2, uniform by id", uniform: true });
    expect(QDRANT_SAMPLE_POINTS).toBe(1000);
  });

  test.each([
    [1, 1],
    [1000, 1],
    [1001, 2],
    [20000, 20],
    [20001, 21],
  ])("%d points make slice 0 of %d", (points, total) => {
    expect(qdrantSampleRead("c", points, true)?.request.body).toContain(`"slice":{"index":0,"total":${total}}`);
  });

  test("one slice of one is the lowest ids, not a uniform sample", () => {
    expect(qdrantSampleRead("plain", 300, true)).toMatchObject({
      method: "slice 0 of 1, the lowest ids",
      uniform: false,
    });
  });

  test("a server without the slice condition gets the first page, and the method says so", () => {
    const read = qdrantSampleRead("docs", 2000, false);
    expect(read?.request.body).toBe('{"limit":1000,"with_payload":true,"with_vector":false}');
    expect(read).toMatchObject({ method: "first page, the lowest ids", uniform: false });
  });

  test("a server that reports no count gets the first page", () => {
    expect(qdrantSampleRead("docs", null, true)?.request.body).toBe(
      '{"limit":1000,"with_payload":true,"with_vector":false}',
    );
  });

  test("a collection that reports no points is not sampled", () => {
    expect(qdrantSampleRead("empty_novec", 0, true)).toBeNull();
    expect(qdrantSampleRead("empty_novec", 0, false)).toBeNull();
  });
});

describe("readQdrantPayloadSample: typing", () => {
  test("integer and float are one numeric family", () => {
    expect(typesOf([{ price: 12 }, { price: 12.5 }, { price: 7 }])).toEqual({ price: ["number", false] });
    // An integer past 2^53 is read plainly: rounded, still a number, and never shown.
    const answer = '{"result":{"points":[{"id":1,"payload":{"big":9007199254740993}}],"next_page_offset":null}}';
    expect(readQdrantPayloadSample("probe", answer, LOWEST).keys[0]).toMatchObject({ key: "big", type: "number" });
  });

  test("null marks a key nullable and is no type; a key seen only as null has no type", () => {
    expect(
      typesOf([
        { note: "a", gone: null },
        { note: null, gone: null },
      ]),
    ).toEqual({
      note: ["string", true],
      gone: ["unknown", true],
    });
  });

  test("a key a sampled point does not carry is nullable", () => {
    expect(typesOf([{ a: 1, b: true }, { a: 2 }])).toEqual({ a: ["number", false], b: ["boolean", true] });
  });

  test("two or more families make a key mixed, named in a fixed order", () => {
    expect(typesOf([{ v: [1] }, { v: { x: 1 } }, { v: true }, { v: 1 }, { v: "s" }])).toEqual({
      v: ["mixed (string, number, boolean, object, array)", false],
    });
  });

  test("an object and a list are each one cell: only top-level keys are read", () => {
    expect(typesOf([{ meta: { owner: { team: "core" } }, tags: ["a", "b"] }])).toEqual({
      meta: ["object", false],
      tags: ["array", false],
    });
  });

  test("keys named like object internals are keys like any other, each under its own column", () => {
    const answer =
      '{"result":{"points":[{"id":1,"payload":{"__proto__":1,"constructor":"c","toString":true,"id":7,"vector.text":"x","$search":1,"":2}}],"next_page_offset":null}}';
    const sample = readQdrantPayloadSample("probe", answer, LOWEST);
    expect(sample.keys.map((entry) => [entry.key, entry.column, entry.type])).toEqual([
      ["__proto__", "payload.__proto__", "number"],
      ["constructor", "constructor", "string"],
      ["toString", "toString", "boolean"],
      ["id", "payload.id", "number"],
      ["vector.text", "payload.vector.text", "string"],
      ["$search", "payload.$search", "number"],
      ["", "payload.", "number"],
    ]);
  });

  test("a point with no payload, a null payload or a payload that is not an object adds no key", () => {
    const answer =
      '{"result":{"points":[{"id":1},{"id":2,"payload":null},{"id":3,"payload":[1]},{"id":4,"payload":{"a":1}}],"next_page_offset":null}}';
    const sample = readQdrantPayloadSample("probe", answer, LOWEST);
    expect(sample.points).toBe(4);
    expect(sample.keys).toEqual([{ key: "a", column: "a", families: ["number"], nullable: true, type: "number" }]);
  });

  test.each([
    ["text that is not JSON", "<html>"],
    ["a body with no result", '{"status":"ok"}'],
    ["a result with no points", '{"result":{"next_page_offset":null}}'],
    ["a result that is a list", '{"result":[]}'],
  ])("%s is refused naming the collection", (_case, text) => {
    expect(() => readQdrantPayloadSample("docs", text, LOWEST)).toThrow(QueryError);
    expect(() => readQdrantPayloadSample("docs", text, LOWEST)).toThrow('payload sample of collection "docs"');
  });
});

describe("readQdrantPayloadSample: the recorded samples", () => {
  const sampleOf = (collection: string, read = UNIFORM) =>
    readQdrantPayloadSample(collection, surfaceCapture(`sample-${collection}`).payload.body, read);

  test("payload_spread: a uniform slice sees both types of the key whose type changes with the id", () => {
    const sample = sampleOf("payload_spread", { method: "slice 0 of 20, uniform by id", uniform: true });
    const variant = sample.keys.find((entry) => entry.key === "variant");
    expect(variant).toMatchObject({ families: ["string", "number"], type: "mixed (string, number)" });
    expect(qdrantSampleNotices(sample)).toContain(
      'Payload key "variant" holds string and number values in the sample, so its type is mixed.',
    );
  });

  test("payload_spread: integral floats do not make price mixed", () => {
    const sample = sampleOf("payload_spread", { method: "slice 0 of 20, uniform by id", uniform: true });
    expect(sample.keys.find((entry) => entry.key === "price")).toMatchObject({ type: "number" });
  });

  test("docs: slice 0 of 2 holds the points and the keys the capture records", () => {
    const sample = sampleOf("docs");
    const body = JSON.parse(surfaceCapture("sample-docs").payload.body) as {
      result: { points: { payload: Record<string, unknown> }[] };
    };
    const keys = new Set(body.result.points.flatMap((point) => Object.keys(point.payload)));
    expect(sample.points).toBe(body.result.points.length);
    expect(sample.keys.map((entry) => entry.key).sort()).toEqual([...keys].sort());
    expect(sample.keys.find((entry) => entry.key === "big_int")).toMatchObject({ type: "number" });
    expect(sample.keys.find((entry) => entry.key === "meta")).toMatchObject({ type: "object" });
  });

  test("docs: a sampled key is a column only where no payload index declares it, and each is marked sampled", () => {
    const collection = readQdrantCollection("docs", resultOf(vectorCapture("describe-docs")));
    const indexed = new Set(qdrantPayloadIndexes(collection).map((index) => index.key));
    const columns = qdrantSampledColumns(sampleOf("docs"), indexed);
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.provenance).toBe("sampled");
      expect(column.isPrimary).toBe(false);
      expect(indexed.has(column.name)).toBe(false);
    }
    expect(columns.map((column) => column.name)).toContain("title");
    expect(columns.map((column) => column.name)).not.toContain("category");
    // The machine-facing projection drops every one of them.
    expect(machineColumns(columns)).toEqual([]);
  });
});

describe("qdrantSampleCoverage", () => {
  test("a uniform sample of 1,000 points states its detection power", () => {
    const sample = readQdrantPayloadSample(
      "c",
      scrollAnswer(
        Array.from({ length: 1000 }, () => ({ a: 1 })),
        7,
      ),
      UNIFORM,
    );
    expect(qdrantSampleCoverage(sample)).toBe(
      "A key present on 1 percent of points is in a uniform sample of 1,000 points with probability 0.9999, and one present on 0.1 percent with probability 0.6323.",
    );
  });

  test("the lowest ids with a page after them say what they cannot have seen", () => {
    const sample = readQdrantPayloadSample("c", scrollAnswer([{ a: 1 }, { a: 2 }], 3), LOWEST);
    expect(sample.complete).toBe(false);
    expect(qdrantSampleCoverage(sample)).toBe(
      "The sample is the 2 lowest ids, so a key that only later points carry is not in it.",
    );
  });

  test("the lowest ids with no page after them are every point", () => {
    const sample = readQdrantPayloadSample("c", scrollAnswer([{ a: 1 }, { a: 2 }, { a: 3 }]), LOWEST);
    expect(sample.complete).toBe(true);
    expect(qdrantSampleCoverage(sample)).toBe("The sample is every point of the collection (3).");
  });

  test("a slice of several is never every point, even when no page follows it", () => {
    const sample = readQdrantPayloadSample("c", scrollAnswer([{ a: 1 }]), UNIFORM);
    expect(sample.complete).toBe(false);
  });
});
