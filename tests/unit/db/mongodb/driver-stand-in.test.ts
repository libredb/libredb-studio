/**
 * The driver stand-in (tests/helpers/mongodb-driver.ts) evaluates the expressions the agent's collection profile
 * composes, so a count a test asserts over it is the count a server answers. These cases hold its `$regexMatch` to the
 * server's, measured on 9.0.4 with a `$documents` stage: a null or missing input answers false, and any other input
 * that is not a string is refused with 51104.
 *
 * It also serves a document as BSON bytes a test built by hand (`bsonDocumentBytes`, `bsonUndefinedFor`), for a value
 * the real serializer never writes, such as BSON's deprecated undefined inside an array.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as realMongoDriver from "mongodb";
import {
  bsonDocumentBytes,
  bsonUndefinedFor,
  mongoDriver,
  mongoDriverModule,
  resetMongoDriver,
} from "../../../helpers/mongodb-driver";

type Doc = Record<string, unknown>;

interface StandInClient {
  db(name: string): {
    collection(name: string): {
      aggregate(pipeline: Doc[]): { toArray(): Promise<Doc[]> };
      find(filter: Doc, options?: Doc): { next(): Promise<unknown> };
    };
  };
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

describe("a document given as BSON bytes", () => {
  const things = () => new MongoClient("mongodb://127.0.0.1:27017/app").db("app").collection("things");

  test("a document given as BSON bytes is served as those bytes by a raw cursor and decoded by the real parser otherwise", async () => {
    const bytes = bsonUndefinedFor({ n: 1, list: [1, null, 3] });
    mongoDriver.documentsByNs = { "app.things": [bsonDocumentBytes(bytes)] };

    const raw = await things().find({}, { raw: true }).next();
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect(Buffer.compare(raw as Buffer, Buffer.from(bytes))).toBe(0);

    const decoded = (await things().find({}).next()) as Doc;
    expect(Object.keys(decoded)).toEqual(["n", "list"]);
    expect(decoded.n).toBe(1);
    const list = decoded.list as unknown[];
    expect(list.length).toBe(3);
    expect(1 in list && list[1] === undefined).toBe(true);
  });

  test("bsonUndefinedFor turns each null element into BSON undefined and refuses a type it does not size", () => {
    const document = { d: 1.5, s: "text", sub: { n: null, i: 7 }, list: [1, null], last: null };
    const plain = realMongoDriver.BSON.serialize(document);
    const marked = bsonUndefinedFor(document);
    // Only the type byte of each null element changes, from 0x0A (null) to 0x06 (undefined).
    const changed = [...marked].flatMap((byte, at) => (byte === plain[at] ? [] : [[plain[at], byte]]));
    expect(changed).toEqual([
      [0x0a, 0x06],
      [0x0a, 0x06],
      [0x0a, 0x06],
    ]);
    const decoded = realMongoDriver.BSON.deserialize(marked);
    expect(decoded.d).toBe(1.5);
    expect(decoded.s).toBe("text");
    expect(Object.hasOwn(decoded.sub, "n") && decoded.sub.n === undefined).toBe(true);
    expect(decoded.sub.i).toBe(7);
    expect(decoded.list.length).toBe(2);
    expect(Object.hasOwn(decoded, "last") && decoded.last === undefined).toBe(true);

    expect(() => bsonUndefinedFor({ flag: true })).toThrow(
      'bsonUndefinedFor does not size the BSON element type 0x08 of "flag"',
    );
  });
});
