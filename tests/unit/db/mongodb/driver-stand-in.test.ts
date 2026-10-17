/**
 * The driver stand-in (tests/helpers/mongodb-driver.ts) evaluates the expressions the agent's collection profile
 * composes, so a count a test asserts over it is the count a server answers. These cases hold its `$regexMatch` to the
 * server's, measured on 9.0.4 with a `$documents` stage: a null or missing input answers false, and any other input
 * that is not a string is refused with 51104.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mongoDriver, mongoDriverModule, resetMongoDriver } from "../../../helpers/mongodb-driver";

type Doc = Record<string, unknown>;

interface StandInClient {
  db(name: string): { collection(name: string): { aggregate(pipeline: Doc[]): { toArray(): Promise<Doc[]> } } };
}

const { MongoClient } = mongoDriverModule() as { MongoClient: new (uri: string) => StandInClient };

/** How many of `documents` match `/a/` on their field `v`, counted by a whole-collection `$group`. */
async function matchesOf(...documents: Doc[]): Promise<unknown> {
  mongoDriver.documentsByNs = { "app.things": documents };
  const [row] = await new MongoClient("mongodb://127.0.0.1:27017/app")
    .db("app")
    .collection("things")
    .aggregate([
      { $group: { _id: null, n: { $sum: { $cond: [{ $regexMatch: { input: "$v", regex: "a" } }, 1, 0] } } } },
    ])
    .toArray();
  return row?.n;
}

beforeEach(() => {
  resetMongoDriver();
});

describe("the stand-in's $regexMatch answers as the server's does", () => {
  test("a null or a missing input does not match, and a string is matched", async () => {
    expect(await matchesOf({ v: "abc" }, { v: null }, {})).toBe(1);
  });

  test.each([
    ["a number", 5],
    ["a boolean", true],
    ["an array", ["a"]],
  ])("%s is refused with 51104", async (_kind, value) => {
    await expect(matchesOf({ v: value })).rejects.toMatchObject({ code: 51104 });
  });
});
