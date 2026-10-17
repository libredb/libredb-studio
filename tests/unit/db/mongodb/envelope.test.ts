/**
 * The reader of one MongoDB read command (issue #1614): the text a model writes, or a statement Studio composes, to a
 * typed read envelope, or to a refusal whose sentence names what to change.
 *
 * Every refusal is held to its code and to a sentence that ends "Nothing was sent.", and an admitted text to the exact
 * envelope the provider reads wherever its shape is under test, and to admission elsewhere. A key the reader would let
 * through and the provider would drop, a stage it would let through, or a number the cursor would misread is a red
 * test here, not a confident wrong answer at run time.
 */
import { describe, expect, test } from "bun:test";
import {
  EJSON_WRAPPERS,
  type MongoJsonObject,
  type MongoReadEnvelope,
  READ_PIPELINE_STAGES,
  readMongoCommand,
  wrapperShapeProblem,
} from "@/lib/db/providers/document/mongodb/envelope";

const command = (operation: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ collection: "orders", operation, ...extra });

const aggregate = (pipeline: unknown) => command("aggregate", { pipeline });

/** The envelope `text` reads as; a refusal fails the test with its own sentence. */
function admitted(text: string): MongoReadEnvelope {
  const reading = readMongoCommand(text);
  if (!reading.ok) throw new Error(`refused with ${reading.code}: ${reading.message}`);
  return reading.envelope;
}

/** The sentence `text` is refused with, once the refusal is held to `code` and to the closing sentence. */
function refused(text: string, code: string): string {
  const reading = readMongoCommand(text);
  if (reading.ok) throw new Error(`admitted, expected ${code}: ${text.slice(0, 200)}`);
  expect({ code: reading.code, message: reading.message.slice(0, 400) }).toMatchObject({ code });
  expect(reading.message).toEndWith("Nothing was sent.");
  return reading.message;
}

const EXAMPLE =
  '{"collection": "orders", "operation": "find", "filter": {"status": "shipped"}, "options": {"limit": 50}}';

/** The read stages an agent pipeline may hold, written out here rather than read from the module under test. */
const ADMITTED_STAGES = [
  "$match",
  "$project",
  "$addFields",
  "$set",
  "$unset",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$count",
  "$unwind",
  "$lookup",
  "$graphLookup",
  "$unionWith",
  "$facet",
  "$bucket",
  "$bucketAuto",
  "$sortByCount",
  "$replaceRoot",
  "$replaceWith",
  "$sample",
  "$densify",
  "$fill",
  "$setWindowFields",
  "$redact",
  "$geoNear",
];

/** The Extended JSON v2 wrappers the provider revives into BSON values. */
const WRAPPERS = [
  "$oid",
  "$date",
  "$numberInt",
  "$numberLong",
  "$numberDouble",
  "$numberDecimal",
  "$binary",
  "$uuid",
  "$regularExpression",
  "$timestamp",
  "$minKey",
  "$maxKey",
];

describe("an admitted command reads as its typed envelope", () => {
  test("find, with every key it honours", () => {
    expect(
      admitted(
        command("find", {
          filter: { status: "shipped" },
          options: { projection: { customer: 1, total: 1 }, sort: { total: -1 }, skip: 10, limit: 50 },
        }),
      ),
    ).toStrictEqual({
      operation: "find",
      collection: "orders",
      filter: { status: "shipped" },
      options: { projection: { customer: 1, total: 1 }, sort: { total: -1 }, skip: 10, limit: 50 },
    });
    expect(admitted(command("find"))).toStrictEqual({ operation: "find", collection: "orders" });
  });

  test("findOne, count and distinct, each with only its own keys", () => {
    expect(
      admitted(command("findOne", { filter: { _id: 7 }, options: { projection: { customer: 1 } } })),
    ).toStrictEqual({
      operation: "findOne",
      collection: "orders",
      filter: { _id: 7 },
      options: { projection: { customer: 1 } },
    });
    expect(admitted(command("count", { filter: { status: "shipped" } }))).toStrictEqual({
      operation: "count",
      collection: "orders",
      filter: { status: "shipped" },
    });
    expect(admitted(command("count"))).toStrictEqual({ operation: "count", collection: "orders" });
    expect(admitted(command("distinct", { field: "customer", filter: { status: "shipped" } }))).toStrictEqual({
      operation: "distinct",
      collection: "orders",
      field: "customer",
      filter: { status: "shipped" },
    });
  });

  test("aggregate, its pipeline as written", () => {
    const pipeline: MongoJsonObject[] = [
      { $match: { status: "shipped" } },
      { $group: { _id: "$customer", n: { $sum: 1 } } },
    ];
    expect(admitted(aggregate(pipeline))).toStrictEqual({ operation: "aggregate", collection: "orders", pipeline });
    expect(admitted(aggregate([]))).toStrictEqual({ operation: "aggregate", collection: "orders", pipeline: [] });
  });

  test("the editor's own generated statement, which names its database first", () => {
    const generated = JSON.stringify(
      { database: "app", collection: "orders", operation: "find", filter: {}, options: { limit: 50 } },
      null,
      2,
    );
    expect(admitted(generated)).toStrictEqual({
      operation: "find",
      collection: "orders",
      database: "app",
      filter: {},
      options: { limit: 50 },
    });
  });

  test("the composed profile: one $group of $type guards and $regexMatch counts", () => {
    const group: MongoJsonObject = {
      _id: null,
      row_count: { $sum: 1 },
      present_0: { $sum: { $cond: [{ $in: [{ $type: "$email" }, ["missing", "null"]] }, 0, 1] } },
      shaped_0: {
        $sum: {
          $cond: [
            {
              $and: [
                { $eq: [{ $type: "$email" }, "string"] },
                { $regexMatch: { input: "$email", regex: ".@.+\\..", options: "s" } },
              ],
            },
            1,
            0,
          ],
        },
      },
    };
    const text = JSON.stringify({
      collection: "orders",
      database: "app",
      operation: "aggregate",
      pipeline: [{ $group: group }],
    });
    expect(admitted(text)).toStrictEqual({
      operation: "aggregate",
      collection: "orders",
      database: "app",
      pipeline: [{ $group: group }],
    });
  });

  test("a $lookup, a $unionWith and a $facet read, with their own pipelines", () => {
    const pipeline: MongoJsonObject[] = [
      { $lookup: { from: "customers", localField: "customer", foreignField: "_id", as: "buyer" } },
      {
        $lookup: {
          from: "items",
          let: { order: "$_id" },
          pipeline: [{ $match: { $expr: { $eq: ["$order", "$$order"] } } }, { $project: { sku: 1 } }],
          as: "items",
        },
      },
      { $unionWith: { coll: "archive", pipeline: [{ $match: { status: "shipped" } }] } },
      { $unionWith: "returns" },
      { $facet: { byStatus: [{ $sortByCount: "$status" }], total: [{ $count: "n" }] } },
      // "$_id" is a field path written as a VALUE, not an operator key.
      { $group: { _id: "$_id" } },
    ];
    expect(admitted(aggregate(pipeline))).toStrictEqual({ operation: "aggregate", collection: "orders", pipeline });
  });

  test("every read stage is admitted, and the admitted set is exactly those", () => {
    for (const stage of ADMITTED_STAGES) {
      expect(admitted(aggregate([{ [stage]: {} }]))).toStrictEqual({
        operation: "aggregate",
        collection: "orders",
        pipeline: [{ [stage]: {} }],
      });
    }
    expect(new Set(READ_PIPELINE_STAGES)).toEqual(new Set(ADMITTED_STAGES));
  });

  test("nested key order is the order written", () => {
    const find = admitted('{"collection": "orders", "operation": "find", "options": {"sort": {"b": 1, "a": 1}}}');
    if (find.operation !== "find") throw new Error(`read as ${find.operation}`);
    expect(Object.keys(find.options?.sort ?? {})).toEqual(["b", "a"]);
    const embedded = admitted(
      '{"collection": "orders", "operation": "count", "filter": {"address": {"zip": "1", "city": "x"}}}',
    );
    if (embedded.operation !== "count") throw new Error(`read as ${embedded.operation}`);
    expect(Object.keys((embedded.filter?.address ?? {}) as object)).toEqual(["zip", "city"]);
    const staged = admitted(aggregate([{ $sort: { b: 1, a: -1 } }]));
    if (staged.operation !== "aggregate") throw new Error(`read as ${staged.operation}`);
    expect(Object.keys(staged.pipeline[0]?.$sort ?? {})).toEqual(["b", "a"]);
  });

  test("the one residual of written order: JavaScript puts integer-like keys first", () => {
    const find = admitted('{"collection": "orders", "operation": "find", "options": {"sort": {"b": 1, "10": 1}}}');
    if (find.operation !== "find") throw new Error(`read as ${find.operation}`);
    expect(Object.keys(find.options?.sort ?? {})).toEqual(["10", "b"]);
  });

  test("the text is trimmed as the editor trims it, so a byte-order mark or a no-break space around it is no fault", () => {
    for (const space of ["\uFEFF", "\u00A0", "\n\t "]) {
      expect(admitted(`${space}${command("count")}${space}`)).toStrictEqual({
        operation: "count",
        collection: "orders",
      });
    }
  });

  test("an Extended JSON wrapper stays the plain JSON it was written as, malformed value included", () => {
    // Revival, and the refusal of a value such as "zz" that is no ObjectId, is the provider's.
    expect(admitted(command("find", { filter: { _id: { $oid: "zz" } } }))).toStrictEqual({
      operation: "find",
      collection: "orders",
      filter: { _id: { $oid: "zz" } },
    });
    for (const wrapper of WRAPPERS) {
      const filter = { at: { $gte: { [wrapper]: "x" } } };
      expect(admitted(command("find", { filter }))).toStrictEqual({ operation: "find", collection: "orders", filter });
    }
  });
});

describe("the envelope's own shape refusals name what to send", () => {
  test("not-json and not-one-command show the envelope", () => {
    expect(refused("db.orders.find({})", "not-json")).toBe(
      `The statement is not the JSON command envelope this database takes. The envelope is ${EXAMPLE}. Nothing was sent.`,
    );
    expect(refused("", "not-json")).toContain(EXAMPLE);
    for (const text of ["[]", '[{"collection": "a"}, {"collection": "b"}]', '"find"', "42", "null"]) {
      expect(refused(text, "not-one-command")).toBe(
        `The statement must be one JSON command object, not a list or a bare value. Send one read per statement, for example ${EXAMPLE}. Nothing was sent.`,
      );
    }
  });

  test("a missing collection, a missing operation, a distinct with no field", () => {
    for (const text of ['{"operation": "find"}', '{"collection": "", "operation": "find"}', '{"collection": 5}']) {
      expect(refused(text, "missing-collection")).toBe(
        'The command names no collection. Add "collection": "<name>" to the envelope. Nothing was sent.',
      );
    }
    for (const text of ['{"collection": "orders"}', '{"collection": "orders", "operation": ""}']) {
      expect(refused(text, "missing-operation")).toBe(
        'The command names no operation. Add "operation": "find" | "findOne" | "aggregate" | "count" | "distinct". Nothing was sent.',
      );
    }
    for (const field of [undefined, "", 5, null]) {
      expect(refused(command("distinct", field === undefined ? {} : { field }), "missing-field")).toBe(
        'A distinct names its field: add "field": "<name>" to the envelope. Nothing was sent.',
      );
    }
  });

  test("a write is refused with the write's sentence, judged before any unknown key", () => {
    expect(refused(command("insertOne", { documents: [{ a: 1 }], flter: {} }), "non-read-operation")).toBe(
      '"insertOne" is not one of the five reads an agent may run (find, findOne, aggregate, count, distinct). The envelope the editor accepts also carries writes; this run may not send one. Nothing was sent.',
    );
    for (const operation of ["insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "Find"]) {
      refused(command(operation), "non-read-operation");
    }
  });

  test("a write's payload under a read's name, judged before the key table wherever it is written", () => {
    const sentence =
      "The command carries a write's payload (documents or update) under a read's name. An agent read carries a filter, a pipeline or nothing. Nothing was sent.";
    expect(refused(command("find", { documents: [{ a: 1 }] }), "write-payload")).toBe(sentence);
    expect(refused(command("count", { flter: {}, update: { $set: { a: 1 } } }), "write-payload")).toBe(sentence);
  });

  test("a key the envelope does not define, and a database that names none", () => {
    expect(refused(command("find", { flter: {} }), "unknown-key")).toBe(
      '"flter" is not a key the command envelope takes (collection, database, operation, filter, pipeline, field, options): remove it. Nothing was sent.',
    );
    for (const database of ["", 5, null, { name: "app" }]) {
      expect(refused(command("find", { database }), "bad-database")).toBe(
        '"database" must be a non-empty string naming the database the command runs in. Nothing was sent.',
      );
    }
  });
});

describe("numbers a cursor would misread are refused", () => {
  test("a limit that is not a whole number of at least 1", () => {
    for (const limit of ["0", "-0", "0.5", "1e-9", "-1", '{"$numberLong": "5"}', '"5"', "1e300", "true"]) {
      const message = refused(
        `{"collection": "orders", "operation": "find", "options": {"limit": ${limit}}}`,
        "bad-options",
      );
      expect(message).toContain('"limit" must be a whole number of at least 1');
    }
  });

  test("a skip that is not a whole number of at least 0", () => {
    for (const skip of ["1.5", "-1", "1e300", '{"$numberInt": "2"}', '"2"']) {
      const message = refused(
        `{"collection": "orders", "operation": "find", "options": {"skip": ${skip}}}`,
        "bad-options",
      );
      expect(message).toContain('"skip" must be a whole number of at least 0');
    }
  });

  test("the bounds themselves are admitted", () => {
    expect(admitted('{"collection": "orders", "operation": "find", "options": {"limit": 1, "skip": 0}}')).toStrictEqual(
      {
        operation: "find",
        collection: "orders",
        options: { limit: 1, skip: 0 },
      },
    );
    expect(admitted(command("find", { options: { limit: Number.MAX_SAFE_INTEGER } }))).toStrictEqual({
      operation: "find",
      collection: "orders",
      options: { limit: Number.MAX_SAFE_INTEGER },
    });
  });
});

describe("a key no reader of that operation honours is refused, naming what to send instead", () => {
  test("a filter on an aggregate points at a leading $match", () => {
    const message = refused(command("aggregate", { filter: { status: "shipped" }, pipeline: [] }), "unknown-key");
    expect(message).toContain('An aggregate takes no "filter"');
    expect(message).toContain('leading {"$match": {...}} stage');
  });

  test("options on an aggregate point at the stages that express them, and drop the rest", () => {
    const message = refused(command("aggregate", { pipeline: [], options: { limit: 5 } }), "unknown-key");
    expect(message).toContain('An aggregate takes no "options"');
    expect(message).toContain("$limit");
    // An option no stage expresses, such as allowDiskUse, hint or collation, gets the same sentence.
    expect(refused(command("aggregate", { pipeline: [], options: { allowDiskUse: true } }), "unknown-key")).toBe(
      'An aggregate takes no "options": write a sort, a skip, a limit or a projection as $sort, $skip, $limit and $project stages of its "pipeline", and drop any other option. Nothing was sent.',
    );
  });

  test("a pipeline outside an aggregate points at the aggregate", () => {
    for (const operation of ["find", "findOne", "count", "distinct"]) {
      const field = operation === "distinct" ? { field: "customer" } : {};
      const message = refused(command(operation, { ...field, pipeline: [{ $match: {} }] }), "unknown-key");
      expect(message).toContain(`A ${operation} takes no "pipeline"`);
      expect(message).toContain('"operation": "aggregate"');
    }
  });

  test("a field outside a distinct points at the distinct and at a projection", () => {
    for (const operation of ["find", "findOne", "count"]) {
      const message = refused(command(operation, { field: "customer" }), "unknown-key");
      expect(message).toContain('Only a distinct takes "field"');
      expect(message).toContain('"operation": "distinct"');
      expect(message).toContain('"projection"');
    }
  });

  test("options on a count or a distinct, which take none", () => {
    expect(refused(command("count", { options: { limit: 5 } }), "unknown-key")).toContain('A count takes no "options"');
    expect(refused(command("distinct", { field: "customer", options: { limit: 2 } }), "unknown-key")).toContain(
      'A distinct takes no "options"',
    );
  });

  test("a findOne's sort and skip point at a find with a limit of 1", () => {
    const sorted = refused(command("findOne", { options: { sort: { total: -1 } } }), "unknown-key");
    expect(sorted).toContain('A findOne takes only "projection" in "options"');
    expect(sorted).toContain('send a find with "options": {"sort": {...}, "limit": 1}');
    const skipped = refused(command("findOne", { options: { skip: 5 } }), "unknown-key");
    expect(skipped).toContain('send a find with "options": {"skip": <n>, "limit": 1}');
    expect(refused(command("findOne", { options: { limit: 5 } }), "unknown-key")).toContain('remove "limit"');
  });

  test("an option no reader honours, naming the option and the ones the operation takes", () => {
    for (const option of ["noCursorTimeout", "tailable", "maxTimeMS", "hint", "comment", "raw", "allowDiskUse"]) {
      expect(refused(command("find", { options: { limit: 2, [option]: true } }), "unknown-key")).toBe(
        `"${option}" is not an option a find takes (projection, sort, skip, limit): remove it. Nothing was sent.`,
      );
      expect(refused(command("findOne", { options: { [option]: true } }), "unknown-key")).toBe(
        `"${option}" is not an option a findOne takes (projection): remove it. Nothing was sent.`,
      );
    }
  });

  test("the shapes of the slots themselves", () => {
    for (const filter of [["status"], "shipped", 5, null]) {
      expect(refused(command("find", { filter }), "bad-filter")).toContain('"filter" must be a JSON object');
    }
    for (const options of ["none", [], null]) {
      expect(refused(command("find", { options }), "bad-options")).toBe(
        '"options" must be a JSON object (projection, sort, skip, limit). Nothing was sent.',
      );
      expect(refused(command("findOne", { options }), "bad-options")).toBe(
        '"options" must be a JSON object (projection). Nothing was sent.',
      );
    }
    expect(refused(command("find", { options: { sort: "descending" } }), "bad-options")).toContain(
      '"sort" must be a JSON object',
    );
    expect(refused(command("find", { options: { projection: ["customer"] } }), "bad-options")).toContain(
      '"projection" must be a JSON object',
    );
    for (const pipeline of [undefined, "not-an-array", {}, null]) {
      expect(refused(command("aggregate", pipeline === undefined ? {} : { pipeline }), "bad-pipeline")).toBe(
        'An aggregate names its stages in "pipeline": a JSON array, for example [{"$match": {...}}, {"$group": {...}}]. Nothing was sent.',
      );
    }
  });
});

describe("a pipeline admits only read stages, at every depth the server runs one", () => {
  test("$out and $merge, at the top level and inside $facet, $lookup and $unionWith", () => {
    const writes = [
      [{ $match: {} }, { $out: "elsewhere" }],
      [{ $merge: { into: "elsewhere" } }],
      [{ $facet: { ok: [{ $match: {} }], copy: [{ $out: "elsewhere" }] } }],
      [{ $lookup: { from: "customers", as: "c", pipeline: [{ $merge: "elsewhere" }] } }],
      [{ $unionWith: { coll: "archive", pipeline: [{ $match: {} }, { $out: "elsewhere" }] } }],
    ];
    for (const pipeline of writes) {
      expect(refused(aggregate(pipeline), "pipeline-writes")).toContain(
        "writes the pipeline's result into a collection",
      );
    }
  });

  test("diagnostic, session, change-stream, search and unknown stages, naming the stage and the admitted ones", () => {
    const stages = [
      "$planCacheStats",
      "$collStats",
      "$indexStats",
      "$currentOp",
      "$listSessions",
      "$listLocalSessions",
      "$queryStats",
      "$listSampledQueries",
      "$changeStream",
      "$changeStreamSplitLargeEvent",
      "$documents",
      "$search",
      "$vectorSearch",
      "$noSuchStage",
      "$_internalInhibitOptimization",
    ];
    for (const stage of stages) {
      const message = refused(aggregate([{ $match: {} }, { [stage]: {} }]), "pipeline-stage");
      expect(message).toContain(`"${stage}" is not a stage this run admits`);
      for (const admittedStage of ADMITTED_STAGES) expect(message).toContain(admittedStage);
    }
  });

  test("a refused stage nested in a sub-pipeline", () => {
    const nested = [
      [{ $unionWith: { coll: "archive", pipeline: [{ $planCacheStats: {} }] } }],
      [{ $lookup: { from: "customers", as: "c", pipeline: [{ $collStats: { latencyStats: {} } }] } }],
      [{ $facet: { ok: [{ $count: "n" }], plans: [{ $planCacheStats: {} }] } }],
      [
        {
          $lookup: {
            from: "a",
            as: "a",
            pipeline: [{ $lookup: { from: "b", as: "b", pipeline: [{ $documents: [] }] } }],
          },
        },
      ],
    ];
    for (const pipeline of nested) refused(aggregate(pipeline), "pipeline-stage");
  });

  test("stages are judged in written order: a stage, then the stages nested in it, then its next sibling", () => {
    // Nested before the next sibling: the $facet arm's $collStats is met before the $out after the $facet.
    expect(
      refused(aggregate([{ $facet: { a: [{ $collStats: {} }] } }, { $out: "elsewhere" }]), "pipeline-stage"),
    ).toContain('"$collStats" is not a stage this run admits');
    // Arms and nested pipelines in the order written: arm a's $merge before arm b's $collStats.
    expect(
      refused(aggregate([{ $facet: { a: [{ $merge: { into: "x" } }], b: [{ $collStats: {} }] } }]), "pipeline-writes"),
    ).toContain('"$merge" writes');
    // A stage before the stages nested in it: the $facet's own malformed arm before its other arm's $out.
    expect(refused(aggregate([{ $facet: { a: [{ $out: "x" }], b: "stages" } }]), "bad-pipeline")).toContain(
      '"$facet" takes a JSON object of named arms',
    );
  });

  test("a stage that is not one object naming one stage", () => {
    expect(refused(aggregate(["$match"]), "bad-pipeline")).toContain(
      "Every pipeline stage must be a JSON object naming one stage",
    );
    expect(refused(aggregate([{}]), "bad-pipeline")).toContain("names exactly one stage, and this one names none");
    const two = refused(aggregate([{ $match: {}, $limit: 5 }]), "bad-pipeline");
    expect(two).toContain("names exactly one stage, and this one names $match, $limit");
    refused(aggregate([{ $facet: { a: [{ $match: {}, $limit: 1 }] } }]), "bad-pipeline");
    refused(aggregate([{ $unionWith: { coll: "archive", pipeline: [[]] } }]), "bad-pipeline");
  });

  test("a stage whose keys are all fields is told to name its stage around them", () => {
    // A $group's fields written without the $group around them, as a real model wrote three times in one run.
    const body = refused(aggregate([{ _id: "$customer", orders: { $sum: 1 } }]), "bad-pipeline");
    expect(body).toContain("this one names _id, orders, none of which is a stage name");
    expect(body).toContain('{"$group": {"_id": "$<field>", "<name>": {"$sum": 1}}}');
    expect(body).not.toContain("write one object per stage");
    // One such key alone is the same slip, and a real model sent {"_id": "$customer"} six times while it was told only
    // which stages are admitted.
    const one = refused(aggregate([{ _id: "$customer" }]), "bad-pipeline");
    expect(one).toContain("this one names _id, which is not a stage name");
    expect(one).toContain('{"$group": {"_id": "$<field>", "<name>": {"$sum": 1}}}');
    // One stage name among them keeps the sentence that splits two stages.
    expect(refused(aggregate([{ $match: {}, limit: 5 }]), "bad-pipeline")).toContain("write one object per stage");
  });

  test("a sub-pipeline that is not an array of stages, so it cannot go unread", () => {
    for (const facet of [[], "arms", null, { a: {} }, { a: "stages" }]) {
      expect(refused(aggregate([{ $facet: facet }]), "bad-pipeline")).toContain(
        '"$facet" takes a JSON object of named arms',
      );
    }
    expect(refused(aggregate([{ $lookup: { from: "c", as: "c", pipeline: {} } }]), "bad-pipeline")).toContain(
      'The "pipeline" of "$lookup" must be a JSON array of stages',
    );
    expect(refused(aggregate([{ $unionWith: { coll: "c", pipeline: "stages" } }]), "bad-pipeline")).toContain(
      'The "pipeline" of "$unionWith" must be a JSON array of stages',
    );
  });
});

describe("operators that run code, or that the engine keeps to itself, are refused wherever they sit", () => {
  test("$where, $function and $accumulator", () => {
    const placed = [
      command("find", { filter: { $where: "this.total > 5" } }),
      command("find", { filter: { $and: [{ status: "shipped" }, { $where: "this.total > 5" }] } }),
      command("find", { filter: { $expr: { $function: { body: "function() { return 1; }", args: [], lang: "js" } } } }),
      command("find", {
        options: { projection: { x: { $function: { body: "function() {}", args: [], lang: "js" } } } },
      }),
      command("count", { filter: { $where: "true" } }),
      command("distinct", { field: "customer", filter: { $where: "true" } }),
      command("findOne", { filter: { $where: "true" } }),
      aggregate([{ $match: { $where: "this.total > 5" } }]),
      aggregate([{ $group: { _id: null, m: { $accumulator: { init: "function() {}", lang: "js" } } } }]),
      aggregate([{ $project: { x: { $function: { body: "function(x) { return x; }", args: [], lang: "js" } } } }]),
      aggregate([{ $facet: { a: [{ $match: { $where: "true" } }] } }]),
      aggregate([{ $lookup: { from: "c", as: "c", pipeline: [{ $match: { $where: "true" } }] } }]),
      aggregate([{ $unionWith: { coll: "c", pipeline: [{ $match: { $where: "true" } }] } }]),
    ];
    for (const text of placed) {
      expect(refused(text, "server-side-javascript")).toMatch(
        /^"\$(where|function|accumulator)" runs JavaScript this run wrote on the server, and this run's contract runs none/,
      );
    }
  });

  test('every "$_" key: $_internalJsEmit in a projection or a $project, $_internalJsReduce in a $group', () => {
    const emit = { $_internalJsEmit: { eval: "function() { emit(1, 1); }", this: {} } };
    const placed: [string, string][] = [
      [command("find", { options: { projection: { x: emit } } }), "$_internalJsEmit"],
      [command("findOne", { options: { projection: { x: emit } } }), "$_internalJsEmit"],
      [aggregate([{ $project: { x: emit } }]), "$_internalJsEmit"],
      [
        aggregate([
          {
            $group: {
              _id: null,
              x: { $_internalJsReduce: { data: { k: 1, v: 1 }, eval: "function(k, v) { return 42; }" } },
            },
          },
        ]),
        "$_internalJsReduce",
      ],
      [command("find", { filter: { a: { $_internalSchemaType: "string" } } }), "$_internalSchemaType"],
      [command("find", { options: { sort: { $_internal: 1 } } }), "$_internal"],
    ];
    for (const [text, key] of placed) {
      const message = refused(text, "internal-operator");
      expect(message).toContain(`"${key}" is one of the engine's internal operators`);
    }
  });

  test("a key the engine would read as data is refused there too, on purpose", () => {
    // Measured on 9.0.4: the engine takes these keys as data inside a $literal, in the value an $eq compares against,
    // in an embedded document a filter compares for equality, and in a $jsonSchema enum. The reader does not tell
    // data from operator; SERVER_SIDE_JAVASCRIPT_OPERATORS says why.
    const placed: [string, string, string][] = [
      [aggregate([{ $project: { x: { $literal: { $where: "data" } } } }]), "server-side-javascript", "$where"],
      [
        command("find", { options: { projection: { x: { $literal: { $function: 1 } } } } }),
        "server-side-javascript",
        "$function",
      ],
      [command("find", { filter: { a: { $eq: { $where: "data" } } } }), "server-side-javascript", "$where"],
      [
        aggregate([{ $project: { x: { $literal: { $_internalJsEmit: 1 } } } }]),
        "internal-operator",
        "$_internalJsEmit",
      ],
      [command("find", { filter: { a: { b: { $function: 1 } } } }), "server-side-javascript", "$function"],
      [aggregate([{ $match: { a: { b: { $where: "data" } } } }]), "server-side-javascript", "$where"],
      [command("find", { filter: { a: { b: { $_internalJsEmit: 1 } } } }), "internal-operator", "$_internalJsEmit"],
      [
        command("count", { filter: { $jsonSchema: { properties: { a: { enum: [{ $where: "data" }] } } } } }),
        "server-side-javascript",
        "$where",
      ],
    ];
    for (const [text, code, key] of placed) expect(refused(text, code)).toStartWith(`"${key}"`);
  });

  test("the operators that merely match and compute are admitted", () => {
    // Each read is written as the envelope it must come back as.
    const reads: MongoReadEnvelope[] = [
      { operation: "find", collection: "orders", filter: { status: { $regex: "^sh", $options: "i" } } },
      {
        operation: "find",
        collection: "orders",
        filter: { $expr: { $cond: [{ $eq: ["$status", "shipped"] }, 1, 0] } },
      },
      {
        operation: "find",
        collection: "orders",
        filter: { tags: { $in: ["a", "b"] } },
        options: { sort: { score: { $meta: "textScore" } } },
      },
      {
        operation: "aggregate",
        collection: "orders",
        pipeline: [{ $project: { ok: { $regexMatch: { input: "$status", regex: "^sh" } } } }],
      },
      { operation: "aggregate", collection: "orders", pipeline: [{ $group: { _id: "$customer", n: { $sum: 1 } } }] },
    ];
    for (const read of reads) expect(admitted(JSON.stringify(read))).toStrictEqual(read);
  });
});

describe("an Extended JSON wrapper keeps its one shape rule", () => {
  test("a wrapper mixed with other keys is refused with the provider's sentence and its path", () => {
    expect(
      refused(
        command("find", {
          filter: { createdAt: { $date: "2025-01-01T00:00:00Z", $lt: { $date: "2025-02-01T00:00:00Z" } } },
        }),
        "bad-extended-json",
      ),
    ).toBe(
      'Invalid Extended JSON at "filter.createdAt": $date must be the only key of its object, and this one also has $lt. To compare against it, nest it: {"$lt": {"$date": ...}}. Nothing was sent.',
    );
    expect(refused(aggregate([{ $match: { _id: { $oid: "a", $exists: true } } }]), "bad-extended-json")).toContain(
      'at "pipeline.0.$match._id": $oid must be the only key of its object, and this one also has $exists.',
    );
    for (const wrapper of WRAPPERS) {
      refused(command("count", { filter: { at: { [wrapper]: "x", also: 1 } } }), "bad-extended-json");
    }
  });

  test("a wrapper standing as a whole filter, projection, sort or stage names the slot", () => {
    expect(refused(command("find", { filter: { $oid: "65a000000000000000000000" } }), "bad-filter")).toContain(
      '"filter" holds the Extended JSON value $oid at its top level',
    );
    expect(
      refused(command("count", { filter: { $date: "2025-01-01T00:00:00Z", status: "x" } }), "bad-filter"),
    ).toContain('{"_id": {"$date": ...}}');
    // Wherever the wrapper sits among the filter's top-level keys.
    expect(
      refused(command("count", { filter: { status: "x", $oid: "65a000000000000000000000" } }), "bad-filter"),
    ).toContain('"filter" holds the Extended JSON value $oid at its top level');
    expect(refused(command("find", { options: { projection: { $oid: "x" } } }), "bad-options")).toContain(
      '"projection" holds the Extended JSON value $oid at its top level',
    );
    expect(refused(command("find", { options: { sort: { $numberInt: "1" } } }), "bad-options")).toContain(
      '"sort" holds the Extended JSON value $numberInt at its top level',
    );
    expect(refused(aggregate([{ $date: "2025-01-01T00:00:00Z" }]), "bad-pipeline")).toContain(
      "A pipeline stage holds the Extended JSON value $date where its stage name belongs",
    );
    refused(aggregate([{ $facet: { a: [{ $oid: "x" }] } }]), "bad-pipeline");
  });

  test("wrapperShapeProblem holds one object to the rule, and no other value", () => {
    for (const value of ["$oid", 5, null, [], [{ $oid: "a", b: 1 }], {}, { a: 1 }, { $oid: "a" }, { $lt: 5, $gt: 1 }]) {
      expect(wrapperShapeProblem(value)).toBeNull();
    }
    expect(wrapperShapeProblem({ $date: "2025-01-01", $lt: 5 })).toBe(
      '$date must be the only key of its object, and this one also has $lt. To compare against it, nest it: {"$lt": {"$date": ...}}',
    );
    expect(wrapperShapeProblem({ a: 1, $numberLong: "5", b: 2 })).toBe(
      '$numberLong must be the only key of its object, and this one also has a, b. To compare against it, nest it: {"$lt": {"$numberLong": ...}}',
    );
  });

  test("the wrapper set is the twelve Extended JSON v2 wrappers", () => {
    expect(new Set(EJSON_WRAPPERS)).toEqual(new Set(WRAPPERS));
  });
});

describe("the order of the checks decides which sentence a command meets", () => {
  test("a malformed slot before the stages, the stages before the operators, the operators before the wrappers", () => {
    refused(command("find", { filter: [], options: { limit: 0 } }), "bad-filter");
    refused(aggregate([{ $collStats: {} }, { $match: { $where: "true" } }]), "pipeline-stage");
    refused(command("find", { filter: { $where: "true", at: { $oid: "a", b: 1 } } }), "server-side-javascript");
    // In written order: the first forbidden key decides between the two operator codes.
    refused(
      command("find", { filter: { a: { $_internalSchemaType: "string" }, $where: "true" } }),
      "internal-operator",
    );
    refused(
      command("find", { filter: { $where: "true", a: { $_internalSchemaType: "string" } } }),
      "server-side-javascript",
    );
  });

  test("an option's key before its value", () => {
    refused(command("findOne", { options: { sort: "descending" } }), "unknown-key");
    refused(command("find", { options: { hint: 1, limit: 0 } }), "unknown-key");
  });
});

describe("the reader is total", () => {
  test("a tree deeper than the call stack is read without throwing, and what it refuses is still found", () => {
    // 40,000 levels: past the 16,000 to 29,000 at which a recursive walk overflowed bun's stack (measured), and well
    // inside what JSON.parse reads.
    const depth = 40_000;
    const deep = (leaf: string) =>
      `{"collection": "orders", "operation": "find", "filter": ${'{"a": '.repeat(depth)}${leaf}${"}".repeat(depth)}}`;
    expect(readMongoCommand(deep("1")).ok).toBe(true);
    refused(deep('{"$where": "true"}'), "server-side-javascript");
    refused(deep('{"$date": "2025-01-01T00:00:00Z", "$lt": 1}'), "bad-extended-json");
    // 40,000 nested pipelines: past the 14,000 to 20,000 at which a recursive stage walk overflowed (measured).
    const nesting = 40_000;
    const stages = `${'[{"$lookup": {"from": "orders", "as": "a", "pipeline": '.repeat(nesting)}[{"$out": "x"}]${"}}]".repeat(nesting)}`;
    refused(`{"collection": "orders", "operation": "aggregate", "pipeline": ${stages}}`, "pipeline-writes");
  });
});
