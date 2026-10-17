/**
 * One MongoDB read command, as text, to a typed read envelope or to a refusal whose sentence names what to change.
 *
 * The grammar is the editor's JSON command envelope narrowed to its five reads, each taking only the keys its read
 * honours: `find` (`filter`; `options` `projection`, `sort`, `skip`, `limit`), `findOne` (`filter`; `options`
 * `projection`), `aggregate` (`pipeline`), `count` (`filter`) and `distinct` (`field`, `filter`), each naming its
 * `collection` and, optionally, its `database`. A key the read would ignore is refused rather than dropped, so a
 * command does not run as less than it says (a key written twice is the exception, below), and a `limit` or a `skip`
 * must be a whole number a cursor cannot misread. A pipeline holds only `READ_PIPELINE_STAGES`, at every depth the
 * server runs one: the command's own, each `$facet` arm, and the pipelines of `$lookup` and `$unionWith`. The
 * server-side JavaScript operators and every internal (`$_`) operator are refused wherever they sit.
 *
 * This is the agent's grammar, not the boundary. The boundary is the connection's user and the server that enforces
 * its privileges: a command this reader admits can still be refused there, and that refusal, not this one, is what
 * keeps a write from happening. What this adds is the sentence a model can act on, before anything is sent, and the
 * only refusal of what that server runs for a user holding just read: the JavaScript and internal operators, and the
 * diagnostic stages the read role grants (measured on 9.0.4 as such a user: `$where`, `$function`, `$accumulator`,
 * `$_internalJsEmit` and `$_internalJsReduce` ran, and `$collStats` and `$planCacheStats` answered). The statements
 * Studio composes for a run are read here too, so they meet the grammar a model's do.
 *
 * Driver-free and pure: nothing here imports the driver, so a registry that admits a command loads none of it. Values
 * stay the plain JSON they were written as. An Extended JSON wrapper such as `{"$oid": "..."}` is held here to its one
 * shape rule (`wrapperShapeProblem`), and its value is revived, and refused when it is malformed, by the provider
 * (`extended-json.ts`): `{"$oid": "zz"}` passes this reader and is refused there, before anything is sent.
 *
 * Key order is the order written, which a sort and an embedded document's equality depend on, with one residual:
 * JavaScript puts integer-like keys such as "0" and "42" first, in ascending order, wherever the text wrote them. A
 * key written twice in one object is read as its last value: `JSON.parse` drops the first in silence, so the text can
 * show a condition the command does not send. And a plain JSON number past 2^53 is read as the nearest double, so
 * `9007199254740993` is sent as `9007199254740992`; `{"$numberLong": "9007199254740993"}` sends it exactly.
 */

/** One JSON value, as `JSON.parse` answers it. */
export type MongoJsonValue = null | boolean | number | string | readonly MongoJsonValue[] | MongoJsonObject;

/** One JSON object: a filter, a projection, a sort or a pipeline stage, its keys in the order written. */
export interface MongoJsonObject {
  readonly [key: string]: MongoJsonValue;
}

interface MongoReadTarget {
  readonly collection: string;
  /** Absent means the connection's own database; whether another may be named is the provider's to decide. */
  readonly database?: string;
}

/** One admitted read, typed by its operation: each arm carries exactly the keys that operation honours. */
export type MongoReadEnvelope = MongoReadTarget &
  (
    | {
        readonly operation: "find";
        readonly filter?: MongoJsonObject;
        readonly options?: {
          readonly projection?: MongoJsonObject;
          readonly sort?: MongoJsonObject;
          readonly skip?: number;
          readonly limit?: number;
        };
      }
    | {
        readonly operation: "findOne";
        readonly filter?: MongoJsonObject;
        readonly options?: { readonly projection?: MongoJsonObject };
      }
    | { readonly operation: "aggregate"; readonly pipeline: readonly MongoJsonObject[] }
    | { readonly operation: "count"; readonly filter?: MongoJsonObject }
    | { readonly operation: "distinct"; readonly field: string; readonly filter?: MongoJsonObject }
  );

type MongoReadOperation = MongoReadEnvelope["operation"];

export type MongoCommandRefusalCode =
  | "not-json"
  | "not-one-command"
  | "unknown-key"
  | "missing-collection"
  | "missing-operation"
  | "non-read-operation"
  | "write-payload"
  | "bad-pipeline"
  | "pipeline-writes"
  | "pipeline-stage"
  | "server-side-javascript"
  | "internal-operator"
  | "bad-filter"
  | "bad-extended-json"
  | "missing-field"
  | "bad-options"
  | "bad-database";

interface MongoCommandRefusal {
  readonly ok: false;
  readonly code: MongoCommandRefusalCode;
  readonly message: string;
}

/**
 * The Extended JSON wrapper keys: an object holding one of these is one BSON value (an ObjectId, a date, a 32- or
 * 64-bit integer, a double, a decimal, binary data, a UUID, a regular expression, a timestamp, the minimum or the
 * maximum key). The provider revives exactly these; an object holding none of them, the legacy `{"$regex": ...,
 * "$options": ...}` form included, is a query operator and stays as written.
 */
export const EJSON_WRAPPERS: ReadonlySet<string> = new Set([
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
]);

/**
 * The aggregation stages a pipeline may hold, at any depth: the stages that read and reshape the documents of the
 * collections the command names. Every other stage is refused, naming it: the write stages (`$out`, `$merge`) with
 * their own sentence, and by omission the diagnostic and session stages (`$collStats`, `$indexStats`,
 * `$planCacheStats`, `$currentOp`, `$listSessions`, `$queryStats` and their kind), which report on the server and on
 * its other users' work rather than on the data, even where the read role grants them; `$changeStream`; and any stage
 * this list does not name yet. `$search`, `$vectorSearch` and `$documents` are left out on purpose: the first two are
 * answered by a separate search process whose behaviour under this profile is not measured, and `$documents` reads no
 * collection at all.
 */
export const READ_PIPELINE_STAGES: ReadonlySet<string> = new Set([
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
]);

/** The aggregation stages that write the pipeline's result into a collection. */
const PIPELINE_WRITE_STAGES: ReadonlySet<string> = new Set(["$out", "$merge"]);

/**
 * The operators that run JavaScript on the server: `$where` in a filter, `$function` in an expression, and
 * `$accumulator`, an accumulator of `$group`, `$bucket`, `$bucketAuto` and `$setWindowFields`. The key is the refusal,
 * not its value: a body arrives as code the model wrote. A key that starts with `$` in a filter, a projection or a
 * pipeline is an operator by the engine's own grammar, except where the engine reads the object holding it as data, as
 * it does (measured on 9.0.4) in a `$literal`'s value and, in a filter, in the operand of `$eq`, `$ne`, `$gt`, `$gte`,
 * `$lt`, `$lte` or `$all`, in an embedded document compared for equality and in a `$jsonSchema` `enum`. The walk
 * refuses these keys, and every `$_` key, there too, on purpose: telling data from operator would make it a second
 * parser of the engine's grammar, so a read is refused even where the engine would have taken the name as data. The
 * operators that only match and compute (`$regex`, `$regexMatch`, `$expr`, `$cond`) are not here.
 */
const SERVER_SIDE_JAVASCRIPT_OPERATORS: ReadonlySet<string> = new Set(["$where", "$function", "$accumulator"]);

/**
 * The prefix of the engine's internal operators. No documented operator carries it, and some run code: measured on
 * 9.0.4, 8.3.11 and 7.0.43, `$_internalJsEmit` in a projection and `$_internalJsReduce` in a `$group` run JavaScript
 * the command wrote, and on 8.3.11 and 7.0.43 `maxTimeMS` does not end a loop inside the first.
 */
const INTERNAL_OPERATOR_PREFIX = "$_";

const READ_OPERATIONS: ReadonlySet<string> = new Set<MongoReadOperation>([
  "find",
  "findOne",
  "aggregate",
  "count",
  "distinct",
]);

/** The keys every operation takes. */
const TARGET_KEYS: ReadonlySet<string> = new Set(["collection", "database", "operation"]);

/** The keys each operation honours beside its target's. */
const OPERATION_KEYS: Readonly<Record<MongoReadOperation, ReadonlySet<string>>> = {
  find: new Set(["filter", "options"]),
  findOne: new Set(["filter", "options"]),
  aggregate: new Set(["pipeline"]),
  count: new Set(["filter"]),
  distinct: new Set(["field", "filter"]),
};

/** The options each operation that takes `options` honours, in the order its sentences name them. */
const OPERATION_OPTIONS: Readonly<Record<"find" | "findOne", readonly string[]>> = {
  find: ["projection", "sort", "skip", "limit"],
  findOne: ["projection"],
};

/** A write's payload keys: refused by what they carry, whatever the operation claims. */
const WRITE_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["documents", "update"]);

const EXAMPLE =
  '{"collection": "orders", "operation": "find", "filter": {"status": "shipped"}, "options": {"limit": 50}}';

/**
 * The read `text` names, typed, or the first refusal it meets. Every refusal names what to change and ends "Nothing
 * was sent.", because a refusal a model cannot act on is a loop.
 *
 * The checks run in this order, so a command meets the sentence about its first fault: JSON; one object; the
 * collection; the operation, so a write meets the write's sentence before any key's; a write's payload key anywhere
 * among the command's keys; the keys the operation takes; the database; then the operation's own shape (a distinct's
 * field; a find's or a findOne's option keys, then its filter, projection and sort, then skip and limit; a count's
 * filter; an aggregate's stages); then the forbidden operators anywhere; and last the wrappers' shape anywhere.
 */
export function readMongoCommand(
  text: string,
):
  | { readonly ok: true; readonly envelope: MongoReadEnvelope }
  | { readonly ok: false; readonly code: MongoCommandRefusalCode; readonly message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return refuse(
      "not-json",
      `The statement is not the JSON command envelope this database takes. The envelope is ${EXAMPLE}. Nothing was sent.`,
    );
  }
  // An array, or any value that is not an object, names no one command: two reads in one statement is the shape this
  // refuses, the single-command rule the SQL fence's one-statement check holds too.
  if (!isJsonObject(parsed)) {
    return refuse(
      "not-one-command",
      `The statement must be one JSON command object, not a list or a bare value. Send one read per statement, for example ${EXAMPLE}. Nothing was sent.`,
    );
  }
  const collection = own(parsed, "collection");
  if (typeof collection !== "string" || collection.length === 0) {
    return refuse(
      "missing-collection",
      'The command names no collection. Add "collection": "<name>" to the envelope. Nothing was sent.',
    );
  }
  const operation = own(parsed, "operation");
  if (typeof operation !== "string" || operation.length === 0) {
    return refuse(
      "missing-operation",
      'The command names no operation. Add "operation": "find" | "findOne" | "aggregate" | "count" | "distinct". Nothing was sent.',
    );
  }
  if (!isReadOperation(operation)) {
    return refuse(
      "non-read-operation",
      `${JSON.stringify(operation)} is not one of the five reads an agent may run (find, findOne, aggregate, count, distinct). The envelope the editor accepts also carries writes; this run may not send one. Nothing was sent.`,
    );
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => WRITE_PAYLOAD_KEYS.has(key))) {
    return refuse(
      "write-payload",
      "The command carries a write's payload (documents or update) under a read's name. An agent read carries a filter, a pipeline or nothing. Nothing was sent.",
    );
  }
  for (const key of keys) {
    const sentence = untakenKeySentence(operation, key);
    if (sentence !== null) return refuse("unknown-key", sentence);
  }
  const database = own(parsed, "database");
  if (database !== undefined && (typeof database !== "string" || database.length === 0)) {
    return refuse(
      "bad-database",
      '"database" must be a non-empty string naming the database the command runs in. Nothing was sent.',
    );
  }
  const target: MongoReadTarget = database === undefined ? { collection } : { collection, database };
  const shaped = shapeEnvelope(parsed, operation, target);
  if (!shaped.ok) return shaped;
  return firstForbiddenOperator(parsed) ?? firstMixedWrapper(parsed) ?? shaped;
}

/**
 * The one shape rule of an Extended JSON wrapper: its key is the only key of its object. Null when `value` keeps it,
 * as every value that is not an object does, and every object holding no wrapper or one wrapper alone; otherwise the
 * reason, naming the wrapper, the keys beside it, and how to nest it instead.
 *
 * The bson parser reads an object that holds a wrapper key as that one value and drops the object's other keys in
 * silence, so a mixed object would run as less than it says. The provider's reviver holds an object to the same rule.
 */
export function wrapperShapeProblem(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  const keys = Object.keys(value);
  const wrapper = keys.find((key) => EJSON_WRAPPERS.has(key));
  if (wrapper === undefined || keys.length === 1) return null;
  const others = keys.filter((key) => key !== wrapper).join(", ");
  return `${wrapper} must be the only key of its object, and this one also has ${others}. To compare against it, nest it: {"$lt": {"${wrapper}": ...}}`;
}

function refuse(code: MongoCommandRefusalCode, message: string): MongoCommandRefusal {
  return { ok: false, code, message };
}

function admit(envelope: MongoReadEnvelope): { readonly ok: true; readonly envelope: MongoReadEnvelope } {
  return { ok: true, envelope };
}

function isJsonObject(value: unknown): value is MongoJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is readonly MongoJsonValue[] {
  return Array.isArray(value);
}

function isReadOperation(operation: string): operation is MongoReadOperation {
  return READ_OPERATIONS.has(operation);
}

/** `object`'s own value at `key`, or undefined when it holds none: never a value its prototype answers. */
function own(object: MongoJsonObject, key: string): MongoJsonValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A whole number a cursor reads as written: a plain JSON number, a safe integer, at least `least`. */
function isWholeNumber(value: MongoJsonValue, least: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least;
}

/** The first wrapper key at the top level of `object`, which is where a field, an operator or a stage name stands. */
function rootWrapper(object: MongoJsonObject): string | undefined {
  return Object.keys(object).find((key) => EJSON_WRAPPERS.has(key));
}

/** The sentence refusing `key` on `operation`, or null when the operation takes it. */
function untakenKeySentence(operation: MongoReadOperation, key: string): string | null {
  if (TARGET_KEYS.has(key) || OPERATION_KEYS[operation].has(key)) return null;
  switch (key) {
    // Only an aggregate takes no filter, and only an aggregate, a count and a distinct take no options.
    case "filter":
      return 'An aggregate takes no "filter": put the condition in a leading {"$match": {...}} stage of its "pipeline". Nothing was sent.';
    case "pipeline":
      return `A ${operation} takes no "pipeline": send "operation": "aggregate" to run stages. Nothing was sent.`;
    case "field":
      return 'Only a distinct takes "field": send "operation": "distinct" to read one field\'s distinct values, or project the field in a find with "options": {"projection": {"<field>": 1}}. Nothing was sent.';
    case "options":
      if (operation === "aggregate") {
        return 'An aggregate takes no "options": write a sort, a skip, a limit or a projection as $sort, $skip, $limit and $project stages of its "pipeline", and drop any other option. Nothing was sent.';
      }
      return operation === "count"
        ? 'A count takes no "options": it counts every document "filter" matches, so remove "options". Nothing was sent.'
        : 'A distinct takes no "options": it answers the distinct values of "field" across every document "filter" matches, so remove "options". Nothing was sent.';
    default:
      return `${JSON.stringify(key)} is not a key the command envelope takes (collection, database, operation, filter, pipeline, field, options): remove it. Nothing was sent.`;
  }
}

/** The refusal of the first key of `options` that `operation` does not take, or null. */
function untakenOptionRefusal(operation: "find" | "findOne", options: MongoJsonObject): MongoCommandRefusal | null {
  const taken = OPERATION_OPTIONS[operation];
  const key = Object.keys(options).find((option) => !taken.includes(option));
  if (key === undefined) return null;
  if (operation === "findOne" && key === "sort") {
    return refuse(
      "unknown-key",
      'A findOne takes only "projection" in "options", so "sort" would be ignored: to read the first document in an order, send a find with "options": {"sort": {...}, "limit": 1}. Nothing was sent.',
    );
  }
  if (operation === "findOne" && key === "skip") {
    return refuse(
      "unknown-key",
      'A findOne takes only "projection" in "options", so "skip" would be ignored: to read past the first documents, send a find with "options": {"skip": <n>, "limit": 1}. Nothing was sent.',
    );
  }
  if (operation === "findOne" && key === "limit") {
    return refuse(
      "unknown-key",
      'A findOne takes only "projection" in "options", and it reads one document already: remove "limit". Nothing was sent.',
    );
  }
  return refuse(
    "unknown-key",
    `${JSON.stringify(key)} is not an option a ${operation} takes (${taken.join(", ")}): remove it. Nothing was sent.`,
  );
}

type Slot = "filter" | "projection" | "sort";

/** What each slot must be, completing "must be a JSON object ...". */
const SLOT_CONTENT: Readonly<Record<Slot, string>> = {
  filter: 'of match conditions, for example {"status": "shipped"}',
  projection: 'naming the fields to return, for example {"customer": 1, "total": 1}',
  sort: 'naming the fields to sort by, for example {"total": -1}',
};

/**
 * The slot's object as written, nothing when the slot is absent, or the refusal of a slot that is not one JSON
 * object, or whose top level holds an Extended JSON wrapper: there a field name (and in a filter, a query operator)
 * stands, so `{"$oid": "..."}` as a whole filter is a value with no field to match.
 */
function readSlot(
  holder: MongoJsonObject,
  slot: Slot,
): { readonly ok: true; readonly value?: MongoJsonObject } | MongoCommandRefusal {
  const value = own(holder, slot);
  if (value === undefined) return { ok: true };
  const code = slot === "filter" ? "bad-filter" : "bad-options";
  if (!isJsonObject(value)) {
    return refuse(code, `${JSON.stringify(slot)} must be a JSON object ${SLOT_CONTENT[slot]}. Nothing was sent.`);
  }
  const wrapper = rootWrapper(value);
  if (wrapper === undefined) return { ok: true, value };
  const instead =
    slot === "filter"
      ? `only a field or a query operator may stand: match a field against it instead, for example {"_id": {"${wrapper}": ...}}`
      : `only a field name may stand: write it ${SLOT_CONTENT[slot]}`;
  return refuse(
    code,
    `${JSON.stringify(slot)} holds the Extended JSON value ${wrapper} at its top level, where ${instead}. Nothing was sent.`,
  );
}

/**
 * The envelope of an operation whose keys are already the ones it takes, or the refusal of its first malformed slot.
 */
function shapeEnvelope(
  command: MongoJsonObject,
  operation: MongoReadOperation,
  target: MongoReadTarget,
): { readonly ok: true; readonly envelope: MongoReadEnvelope } | MongoCommandRefusal {
  if (operation === "aggregate") {
    const pipeline = own(command, "pipeline");
    if (!isJsonArray(pipeline)) {
      return refuse(
        "bad-pipeline",
        'An aggregate names its stages in "pipeline": a JSON array, for example [{"$match": {...}}, {"$group": {...}}]. Nothing was sent.',
      );
    }
    const read = readStages(pipeline);
    return read.ok ? admit({ ...target, operation, pipeline: read.stages }) : read;
  }
  if (operation === "count") {
    const filter = readSlot(command, "filter");
    if (!filter.ok) return filter;
    return admit({ ...target, operation, ...(filter.value === undefined ? {} : { filter: filter.value }) });
  }
  if (operation === "distinct") {
    const field = own(command, "field");
    if (typeof field !== "string" || field.length === 0) {
      return refuse(
        "missing-field",
        'A distinct names its field: add "field": "<name>" to the envelope. Nothing was sent.',
      );
    }
    const filter = readSlot(command, "filter");
    if (!filter.ok) return filter;
    return admit({ ...target, operation, field, ...(filter.value === undefined ? {} : { filter: filter.value }) });
  }
  if (operation === "findOne") {
    const options = own(command, "options");
    if (options !== undefined && !isJsonObject(options)) {
      return refuse("bad-options", optionsShapeSentence(operation));
    }
    const untaken = untakenOptionRefusal(operation, options ?? {});
    if (untaken !== null) return untaken;
    const filter = readSlot(command, "filter");
    if (!filter.ok) return filter;
    const projection = readSlot(options ?? {}, "projection");
    if (!projection.ok) return projection;
    return admit({
      ...target,
      operation,
      ...(filter.value === undefined ? {} : { filter: filter.value }),
      ...(options === undefined
        ? {}
        : { options: projection.value === undefined ? {} : { projection: projection.value } }),
    });
  }
  // A find, the one operation left.
  const options = own(command, "options");
  if (options !== undefined && !isJsonObject(options)) {
    return refuse("bad-options", optionsShapeSentence(operation));
  }
  const held = options ?? {};
  const untaken = untakenOptionRefusal(operation, held);
  if (untaken !== null) return untaken;
  const filter = readSlot(command, "filter");
  if (!filter.ok) return filter;
  const projection = readSlot(held, "projection");
  if (!projection.ok) return projection;
  const sort = readSlot(held, "sort");
  if (!sort.ok) return sort;
  const skip = own(held, "skip");
  if (skip !== undefined && !isWholeNumber(skip, 0)) {
    return refuse(
      "bad-options",
      '"skip" must be a whole number of at least 0, written as a plain JSON number such as 20. Nothing was sent.',
    );
  }
  const limit = own(held, "limit");
  if (limit !== undefined && !isWholeNumber(limit, 1)) {
    return refuse(
      "bad-options",
      '"limit" must be a whole number of at least 1, written as a plain JSON number such as 50. Nothing was sent.',
    );
  }
  return admit({
    ...target,
    operation,
    ...(filter.value === undefined ? {} : { filter: filter.value }),
    ...(options === undefined
      ? {}
      : {
          options: {
            ...(projection.value === undefined ? {} : { projection: projection.value }),
            ...(sort.value === undefined ? {} : { sort: sort.value }),
            ...(skip === undefined ? {} : { skip }),
            ...(limit === undefined ? {} : { limit }),
          },
        }),
  });
}

function optionsShapeSentence(operation: "find" | "findOne"): string {
  return `"options" must be a JSON object (${OPERATION_OPTIONS[operation].join(", ")}). Nothing was sent.`;
}

/** One stage the walk has yet to judge, and whether it is a stage of the command's own pipeline. */
interface PendingStage {
  readonly stage: MongoJsonValue;
  readonly topLevel: boolean;
}

/**
 * The command's own stages, once every stage the server would run is one object naming one admitted stage, or the
 * first refusal in written order: a stage is judged before the stages nested in it, and those before its next
 * sibling. Nested pipelines are walked from a work list rather than by recursion, so no nesting the text can hold
 * runs past the call stack.
 */
function readStages(
  pipeline: readonly MongoJsonValue[],
): { readonly ok: true; readonly stages: readonly MongoJsonObject[] } | MongoCommandRefusal {
  const stages: MongoJsonObject[] = [];
  const pending: PendingStage[] = [];
  pushStages(pending, pipeline, true);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { stage, topLevel } = next;
    if (!isJsonObject(stage)) {
      return refuse(
        "bad-pipeline",
        'Every pipeline stage must be a JSON object naming one stage, for example {"$match": {...}}. Nothing was sent.',
      );
    }
    const names = Object.keys(stage);
    // Keys none of which is a stage name, one or several, are a stage's fields written without the stage around them,
    // the mistake a model makes with a $group, so that sentence shows the wrapper rather than asking for a split or
    // listing the admitted stages.
    if (names.length > 0 && !names.some((key) => key.startsWith("$"))) {
      const named =
        names.length === 1
          ? `${names[0]}, which is not a stage name`
          : `${names.join(", ")}, none of which is a stage name`;
      return refuse(
        "bad-pipeline",
        `A pipeline stage names exactly one stage, and this one names ${named}: write the stage's name, which starts with $, around its fields, for example {"$match": {"<field>": <value>}} or {"$group": {"_id": "$<field>", "<name>": {"$sum": 1}}}. Nothing was sent.`,
      );
    }
    if (names.length !== 1) {
      return refuse(
        "bad-pipeline",
        `A pipeline stage names exactly one stage, and this one names ${names.length === 0 ? "none" : names.join(", ")}: write one object per stage, in the order they run. Nothing was sent.`,
      );
    }
    const name = names[0];
    if (EJSON_WRAPPERS.has(name)) {
      return refuse(
        "bad-pipeline",
        `A pipeline stage holds the Extended JSON value ${name} where its stage name belongs: name one stage, for example {"$match": {"_id": {"${name}": ...}}}. Nothing was sent.`,
      );
    }
    if (PIPELINE_WRITE_STAGES.has(name)) {
      return refuse(
        "pipeline-writes",
        `${JSON.stringify(name)} writes the pipeline's result into a collection, so it is not a read even inside an aggregate. An agent aggregation reads; what it establishes goes into the report. Nothing was sent.`,
      );
    }
    if (!READ_PIPELINE_STAGES.has(name)) {
      return refuse(
        "pipeline-stage",
        `${JSON.stringify(name)} is not a stage this run admits. The read stages it admits are ${[...READ_PIPELINE_STAGES].join(", ")}: rewrite the pipeline with those. Nothing was sent.`,
      );
    }
    const nested = nestedPipelines(name, stage[name]);
    if (typeof nested === "string") return refuse("bad-pipeline", nested);
    if (topLevel) stages.push(stage);
    for (let index = nested.length - 1; index >= 0; index -= 1) pushStages(pending, nested[index], false);
  }
  return { ok: true, stages };
}

/** Queues `pipeline`'s stages so the first is judged next. */
function pushStages(pending: PendingStage[], pipeline: readonly MongoJsonValue[], topLevel: boolean): void {
  for (let index = pipeline.length - 1; index >= 0; index -= 1) pending.push({ stage: pipeline[index], topLevel });
}

/**
 * The pipelines an admitted stage runs (each `$facet` arm, the `pipeline` of `$lookup` and of `$unionWith`), or the
 * sentence refusing one that is not a JSON array of stages: a sub-pipeline that cannot be read would go unread.
 */
function nestedPipelines(name: string, argument: MongoJsonValue): readonly (readonly MongoJsonValue[])[] | string {
  if (name === "$facet") {
    const arms = isJsonObject(argument) ? Object.values(argument) : null;
    return arms !== null && arms.every(isJsonArray)
      ? arms
      : '"$facet" takes a JSON object of named arms, each a JSON array of stages, for example {"$facet": {"byStatus": [{"$sortByCount": "$status"}]}}. Nothing was sent.';
  }
  if ((name !== "$lookup" && name !== "$unionWith") || !isJsonObject(argument)) return [];
  const pipeline = own(argument, "pipeline");
  if (pipeline === undefined) return [];
  return isJsonArray(pipeline)
    ? [pipeline]
    : `The "pipeline" of ${JSON.stringify(name)} must be a JSON array of stages, for example [{"$match": {...}}]. Nothing was sent.`;
}

/** The refusal of the first key, in written order, that names a JavaScript or an internal operator, or null. */
function firstForbiddenOperator(command: MongoJsonObject): MongoCommandRefusal | null {
  for (const { key } of nodesInWrittenOrder(command)) {
    if (key === undefined) continue;
    if (SERVER_SIDE_JAVASCRIPT_OPERATORS.has(key)) {
      return refuse(
        "server-side-javascript",
        `${JSON.stringify(key)} runs JavaScript this run wrote on the server, and this run's contract runs none: the boundary is the connection user's privileges and the statement's deadline, not a code sandbox. Express the condition as a plain filter or an aggregation expression ($regex, $cond, $switch) and send that. Nothing was sent.`,
      );
    }
    if (key.startsWith(INTERNAL_OPERATOR_PREFIX)) {
      return refuse(
        "internal-operator",
        `${JSON.stringify(key)} is one of the engine's internal operators, as every name that starts "${INTERNAL_OPERATOR_PREFIX}" is: they are not part of the query language a read is written in, and this run sends none. Write the read with the documented operators and stages. Nothing was sent.`,
      );
    }
  }
  return null;
}

/** The refusal of the first object, in written order, that mixes a wrapper key with other keys, or null. */
function firstMixedWrapper(command: MongoJsonObject): MongoCommandRefusal | null {
  for (const { value, path } of nodesInWrittenOrder(command)) {
    const problem = wrapperShapeProblem(value);
    if (problem !== null) {
      return refuse(
        "bad-extended-json",
        `Invalid Extended JSON at ${JSON.stringify(path)}: ${problem}. Nothing was sent.`,
      );
    }
  }
  return null;
}

interface JsonNode {
  /** The key the value sits under in its object; absent for the root and for an array's element. */
  readonly key?: string;
  readonly value: MongoJsonValue;
  /** Dotted from the command's root, as the provider's reviver writes it: `filter.$and.0.createdAt`. */
  readonly path: string;
}

/**
 * Every value of a parsed command with the key it sits under, a key before the values beneath it, siblings in written
 * order. A work list rather than recursion: `JSON.parse` reads a nesting far deeper than a recursive walk's stack
 * (measured on bun 1.4.2: it read 1,000,000 levels, where a recursive walk overflowed at about 16,000 as a generator
 * and at 21,000 to 29,000 as a plain function), and the reader is total over any text it is given.
 */
function* nodesInWrittenOrder(root: MongoJsonValue): Generator<JsonNode> {
  const pending: JsonNode[] = [{ value: root, path: "" }];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    yield node;
    const { value, path } = node;
    if (isJsonArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], path: joinPath(path, String(index)) });
      }
    } else if (isJsonObject(value)) {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index];
        pending.push({ key, value: child, path: joinPath(path, key) });
      }
    }
  }
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
