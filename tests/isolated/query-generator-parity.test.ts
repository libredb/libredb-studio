/**
 * The query generators' parity proof: every answer the generators and the quoting helpers give over the corpus of
 * `tests/fixtures/query-generators/generator-corpus.ts` is the one they gave before each engine's generator rows
 * moved beside its provider. It runs here, in a process of its own, because it builds every provider through the
 * real `createDatabaseProvider`, which the api layer's tests mock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatorCorpusDigests } from "../fixtures/query-generators/generator-corpus";

const GOLDEN = join(import.meta.dir, "..", "fixtures", "query-generators", "generator-corpus.json");

describe("the query generators' parity corpus", () => {
  test("every declaration answers exactly what the committed digests record", async () => {
    expect(JSON.parse(await generatorCorpusDigests())).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
  });
});
