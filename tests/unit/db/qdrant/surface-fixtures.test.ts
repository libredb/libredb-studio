/**
 * The recorded answers the surface tests read (tests/helpers/qdrant-surface-fixtures.ts): every capture is a pass
 * from the pinned server build, every collection of the seed has its five surface reads, and the line-level answer
 * refuses what no capture holds instead of inventing an answer.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  collectionNotFound,
  type QdrantCapture,
  recordedAnswer,
  recordedLineAnswer,
  requirePass,
  SEEDED_COLLECTIONS,
  surfaceCapture,
  vectorCapture,
} from "../../../helpers/qdrant-surface-fixtures";

const DIGEST = "sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";
const DIRECTORY = join(import.meta.dir, "../../../fixtures/qdrant-surface");

describe("the surface captures", () => {
  test("every file is a pass from Qdrant 1.19.1 at the pinned digest, and holds no key header", () => {
    const files = readdirSync(DIRECTORY).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const recorded = surfaceCapture(file.replace(/\.json$/, ""));
      expect(recorded.$captured).toMatchObject({ version: "1.19.1", digest: DIGEST });
      expect(JSON.stringify(recorded.$captured)).not.toContain("api-key");
    }
  });

  test.each([...SEEDED_COLLECTIONS])("%s has its aliases, snapshots, optimizations and cluster reads", (collection) => {
    for (const read of ["aliases", "snapshots", "optimizations", "cluster"]) {
      expect(surfaceCapture(`${read}-${collection}`).$captured.request.path).toBe(`/collections/${collection}/${read}`);
    }
  });

  test("every collection that reports points has its sample, and the empty ones have none", () => {
    const files = new Set(readdirSync(DIRECTORY));
    for (const collection of SEEDED_COLLECTIONS) {
      const described = JSON.parse(vectorCapture(`describe-${collection}`).payload.body).result.points_count;
      expect(files.has(`sample-${collection}.json`)).toBe(described > 0);
    }
  });

  test("a capture whose outcome is not a pass is refused by name", () => {
    const failed = { ...surfaceCapture("collections"), outcome: "fail" } as QdrantCapture;
    expect(() => requirePass(failed, "x.json")).toThrow("x.json records the outcome fail, not pass");
  });
});

describe("recordedLineAnswer", () => {
  test("a collection the seed does not hold is Qdrant's 404", () => {
    expect(recordedLineAnswer("GET /collections/missing", null)).toEqual(collectionNotFound("missing"));
    expect(collectionNotFound("missing").status).toBe(404);
  });

  test("a sample scroll whose body is not the recorded one is refused by name", () => {
    expect(() => recordedLineAnswer("POST /collections/docs/points/scroll", "{}")).toThrow(
      "not the recorded sample body",
    );
  });

  test.each(["GET /telemetry", "GET /collections/docs/points/42", "POST /collections/docs/points/query"])(
    "%s has no capture",
    (line) => {
      expect(() => recordedLineAnswer(line, null)).toThrow(`No capture answers ${line}`);
    },
  );

  test("an operation no capture answers is refused by name", () => {
    expect(() => recordedAnswer({ op: "facet", params: { collection_name: "docs" }, query: {} })).toThrow(
      "No capture answers the operation facet",
    );
  });
});
