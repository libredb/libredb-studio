import { type DestructiveVocabulary, isJsonObject, type OperationReader } from "@/lib/db/destructive-vocabulary";

/**
 * MongoDB operations whose effect is to remove documents or overwrite fields.
 *
 * Exactly the destructive members of the provider's own `SUPPORTED_OPERATIONS`, in
 * the provider's spelling: `find`, `findOne`, `aggregate`, `count`, `distinct`,
 * `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany` are
 * the whole set it dispatches, and anything else is refused with
 * `Unsupported operation` before a collection is touched. So `drop`,
 * `dropDatabase`, `renameCollection` and the index commands are deliberately absent:
 * they cannot be run from this editor, and a row for them would be a prompt about
 * text that is going to error anyway.
 *
 * The inserts are absent for the same reason the SQL half has no `INSERT`: this gate
 * asks about statements that destroy or change what is already there.
 *
 * `$out` and `$merge` are pipeline STAGES rather than operations, and they are here
 * because `aggregate` hands `query.pipeline` to the driver unchanged: `$out`
 * replaces a whole collection and `$merge` can replace matched documents, which
 * makes an `aggregate` the one read-shaped operation that can destroy data. The
 * reader below only looks at TOP-LEVEL stages - neither stage is legal inside a
 * `$lookup` or `$facet` sub-pipeline.
 */
const MONGODB_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
  "deleteOne",
  "deleteMany",
  "updateOne",
  "updateMany",
  "$out",
  "$merge",
]);

/**
 * The top-level stage names of an aggregate pipeline, as far as they can be read.
 *
 * A pipeline that is not an array, or a stage that is not an object, names nothing:
 * the driver rejects both, so there is no operation to ask about.
 */
function pipelineStageNames(pipeline: unknown): string[] {
  if (!Array.isArray(pipeline)) return [];
  return pipeline.filter(isJsonObject).flatMap((stage) => Object.keys(stage));
}

/**
 * What a MongoDB payload would run.
 *
 * The shape is the provider's own: one JSON document with `collection` and
 * `operation`, dispatched on `operation` case-sensitively (so `DELETEMANY` is refused
 * rather than run, and matching it here would only prompt about text that errors).
 * Documented the same way in docs/providers/mongodb.md.
 *
 * Anything that does not parse as JSON, or parses as something other than a document
 * with a string `operation`, is UNREADABLE rather than safe - mongosh syntax
 * (`db.users.deleteMany({})`), a half-typed document, an array. The provider refuses
 * all of it, so the cost of asking is one click on text that was not going to run;
 * the cost of the other answer is the silence this whole file exists to remove. The
 * one exception is text with nothing in it: an empty editor is not a command, and
 * both callers hand this predicate the buffer as it stands, so treating blank text as
 * unreadable would prompt on every execute of an empty tab.
 */
const readMongodbOperations: OperationReader = (query) => {
  const text = query.trim();
  if (text === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;

  const operation = parsed.operation;
  if (typeof operation !== "string") return undefined;

  // Only an aggregate can carry a writing stage; every other operation's effect is
  // its own name.
  return operation === "aggregate" ? [operation, ...pipelineStageNames(parsed.pipeline)] : [operation];
};

/** MongoDB's row of the confirmation gate's vocabulary. */
export const MONGODB_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: MONGODB_DESTRUCTIVE_OPERATIONS,
  read: readMongodbOperations,
  decidesAlone: false,
};
