/**
 * The tool definitions MongoDB's workflows are offered (issue #1614, moved by #1821): the command tool, the catalog,
 * plan and profile arms, the index card and the answer, each in this engine's own words.
 */
import { z } from "zod";
import type { IndexSchema } from "@/lib/types";
import { resolveProfileTarget } from "../../inventory-address";
import {
  AGENT_ANSWER_CONTRACT,
  AGENT_EVIDENCE_CONTRACT,
  capturedSnapshot,
  catalogSelectorSchema,
  evidenceSchema,
  presentAnswerSchema,
  unavailable,
} from "../../tool-contracts";
import type { AgentToolDefinition, AgentToolName } from "../../tools";
import type { AgentEvidenceReference, AgentRunEvent } from "../../types";
import { fenceUntrustedContent } from "../../untrusted-content";
import type { AgentLanguageServerPack, AgentRecommendationCard } from "../pack";

/**
 * A MongoDB profile names a COLLECTION, as the SQL selector names a table, and is composed the same way from the run's
 * own inventory (`./tools.ts`). Its own selector because its depths are not SQL's: `distribution` would need one
 * `$group` per field or a set materialised in memory (`$addToSet`), so it is not composed and not offered, and a
 * selector that offered it would be one the arm then refused.
 */
export const mongoProfileSelectorSchema = z.strictObject({
  schema: z
    .string()
    .describe(
      "Omit this unless the inventory qualifies the collection as database.collection. It is a database name, never an artifact id or a snapshot fingerprint.",
    )
    .optional(),
  table: z.string().min(1).describe("The collection, spelled as the inventory spells it or by its bare name."),
  depth: z
    .enum(["basic", "pattern"])
    .default("basic")
    .describe("basic counts documents and missing values; pattern adds a shape test for personal data."),
  fromColumn: z
    .number()
    .int()
    .min(0)
    .describe("Where in the collection's field list to start. The server bounds how many follow.")
    .optional(),
});

/**
 * The command the MODEL writes: a JSON object, not escaped text. Writing an envelope as a string inside JSON is the
 * one shape a model reliably gets wrong, so the schema takes the object and the language's `canonicalize` writes it
 * out, in the order the model wrote it, as the text every server layer reads - one parse, one form, no double
 * encoding to fail.
 */
const readMongoCommandSchema = z.strictObject({
  command: z.record(z.string(), z.unknown()),
  /** Why the model wrote this read; accepted and not recorded, as `readStatementSchema`'s rationale. */
  rationale: z.string().optional(),
});

/**
 * The read: the editor's command envelope, with the collection by its bare name. No `database` key is offered: the run
 * reads the database its connection is bound to, and the provider refuses a command that names another one.
 */
const MONGO_RUN_READ_QUERY: AgentToolDefinition = Object.freeze({
  name: "run_read_query",
  description:
    'Run one bounded read-only command envelope as JSON, with the keys its operation takes and no others: find takes "filter" and "options" ("projection", "sort", "skip", "limit"); findOne takes "filter" and "options" ("projection" only); aggregate takes "pipeline" only, so its filter, sort and limit are $match, $sort and $limit stages; count takes "filter"; distinct takes "field" and "filter". For example {"collection": "orders", "operation": "aggregate", "pipeline": [{"$match": {"status": "paid"}}, {"$group": {"_id": "$status", "n": {"$sum": 1}}}]}. Write the collection by its bare name, as in "orders" for an inventory entry app.orders: the run reads the database its connection is bound to. Write a date as {"$date": "2026-03-01T00:00:00Z"} and an ObjectId as {"$oid": "<24 hex digits>"}: a plain string never equals either, and a read shows both as plain strings. Writes and the write stages of a pipeline ($out, $merge) are refused before the database is reached, and you are told why.',
  inputSchema: readMongoCommandSchema,
  operationId: "mongo.query.read",
});

/**
 * The catalog arm: the selector the SQL tool takes, answered by the provider's catalog read for the agent, in the
 * database the connection is bound to. The two bounds are stated apart because they differ: a listing past the row
 * budget is refused, while one collection's fields are inferred from a sample and cut at the provider's own bound, so
 * no complete field list is promised. The bound is the provider's, so no number is named here.
 */
const MONGO_INSPECT_SCHEMA: AgentToolDefinition = Object.freeze({
  name: "inspect_schema",
  description:
    "Read the database's own catalog, optionally narrowed to one collection. Pass kind to choose the inventory: columns (the default: the collections, or one collection's fields, inferred from a sample of its documents) or indexes (the indexes one collection declares). MongoDB declares no foreign keys, so a relations read is refused rather than answered empty. A collection listing past the row budget is refused, not truncated. One collection's fields are listed up to a fixed bound, _id first and the rest in sorted order, so a field missing from a very wide collection's list may still exist.",
  inputSchema: catalogSelectorSchema,
  operationId: "mongo.schema.read",
});

/**
 * The estimating plan: the command wrapped in the explain the engine itself plans with. Exported because the mongo
 * arm (`./tools.ts`) parses with this same object, so what the run is offered and what it is held to are one.
 */
export const mongoPlanCommandSchema = z.strictObject({
  command: z.record(z.string(), z.unknown()),
  rationale: z.string().optional(),
});

const MONGO_INSPECT_PLAN: AgentToolDefinition = Object.freeze({
  name: "inspect_plan",
  description:
    "Ask the engine for the ESTIMATED plan of one read-only command envelope, the same JSON shape run_read_query takes, with dates and ObjectIds written the same way: a range over a date field written with strings plans an index scan over strings, which matches no document. The engine plans the command with the explain command at queryPlanner verbosity and returns no result rows; where several plans are candidates it tries each for a bounded trial, under the same deadline your reads have. No timings are produced.",
  inputSchema: mongoPlanCommandSchema,
  operationId: "mongo.plan.estimate",
});

/** The profile arm: a collection selector, composed into an aggregation instead of SQL, at the depths it composes. */
const MONGO_PROFILE_TABLE: AgentToolDefinition = Object.freeze({
  name: "profile_table",
  description:
    "Profile one collection the run has already inventoried. The server chooses the fields from the captured inventory and composes the aggregation; you supply only the collection and how deep to go. Depth basic counts documents and missing values, and pattern adds a shape test for personal data. Only COUNTS are returned: no value is ever read out of any field.",
  inputSchema: mongoProfileSelectorSchema,
  operationId: "mongo.table.profile",
});

/**
 * The index card, the mongo recommendation: a change the run PROPOSES and the user applies in their own tool. The
 * editor's envelope runs reads and writes on documents, but creates no index, so unlike the SQL card there is no
 * statement here to hand the editor - the collection, the keys and the options are the recommendation, and they are
 * stated as data rather than as a command the editor would refuse. Its own `change`, so every reader of the event
 * tells it from the statement card by that one field.
 */
const mongoIndexRecommendationSchema = z.strictObject({
  change: z.literal("document-index"),
  /** The collection the index belongs to: its bare name, or the inventory's own spelling of it. */
  collection: z.string().min(1),
  /** The index keys, in the MongoDB form: {"field": 1} or {"field": -1} or {"field": "text"}. */
  keys: z.record(z.string(), z.union([z.number(), z.string()])),
  /**
   * Index options, in the engine's own form: {"name": "...", "unique": true} and their kind. Never `key`: the keys
   * are stated above, and a `key` among the options would replace them in the index the user creates.
   */
  options: z
    .record(z.string(), z.unknown())
    .refine((options) => !Object.hasOwn(options, "key"), {
      message: "the index keys go in keys, never in options",
    })
    .optional(),
  rationale: z.string().optional(),
  evidence: z.array(evidenceSchema).min(1),
});

const MONGO_RECOMMEND_CHANGE: AgentToolDefinition = Object.freeze({
  name: "recommend_change",
  description: `Propose one index for the user to create themselves: "change" is "document-index", and you state the collection by its bare name, the keys and any options. Nothing is applied by this run and nothing here changes the database: the recommendation is data the user reads, not a command this editor runs. State what the inspected plan showed about how the collection is reached, and cite it. ${AGENT_EVIDENCE_CONTRACT}`,
  inputSchema: mongoIndexRecommendationSchema,
});

/**
 * The collection a document-index card names, and the database it is in, read off the run's own captured inventory.
 *
 * The inventory spells a collection with its database in front (`app.orders`), and a model may copy that spelling or
 * write the bare name; either resolves, by the address rule every inventory reader shares, to the entry's own address,
 * so the card names the collection the run read and the database it read it in. A spelling the inventory does not
 * resolve is kept whole and never split on a dot (a collection may be named `fs.files`), in the session's own
 * database where the capture knew it, and with no database at all where it did not: the card then names none rather
 * than one nobody established.
 */
function documentIndexTarget(
  events: readonly AgentRunEvent[],
  spelling: string,
): { readonly collection: string; readonly database?: string } {
  const snapshot = capturedSnapshot(events);
  const resolution =
    snapshot === null ? null : resolveProfileTarget(snapshot.objects, undefined, spelling, snapshot.defaultContainer);
  if (resolution?.kind === "resolved") {
    const { schema, table } = resolution.target;
    return schema === undefined ? { collection: table } : { collection: table, database: schema };
  }
  const database = snapshot?.defaultContainer?.[0];
  return database === undefined ? { collection: spelling } : { collection: spelling, database };
}

/**
 * Whether the captured inventory already lists an index on exactly `keys`, in that order, for the collection a
 * document-index card resolved to. The inventory records an index's fields and not their directions, so the order of
 * the fields is what is compared: `{a: 1, b: -1}` and `{a: -1, b: 1}` read as the same index here, which can only make
 * this refuse a recommendation that differs in direction alone, never accept a duplicate.
 */
function indexExists(
  events: readonly AgentRunEvent[],
  collection: string,
  database: string | undefined,
  keys: readonly string[],
): boolean {
  const snapshot = capturedSnapshot(events);
  if (snapshot === null) return false;
  const target = snapshot.objects.find(
    (object) => object.path?.at(-1) === collection && (database === undefined || object.path?.at(-2) === database),
  );
  const indexes: readonly IndexSchema[] = Array.isArray(target?.indexes) ? target.indexes : [];
  return indexes.some(
    (index) =>
      index.columns.length === keys.length && index.columns.every((column: string, at: number) => column === keys[at]),
  );
}

/**
 * The document-index card's record, once the core has verified its evidence.
 *
 * A change stated as data - the collection, the keys, the options - rather than as a statement, because the editor's
 * envelope runs reads and writes on documents and creates no index. The collection's name is untrusted database
 * content, so it is fenced rather than spliced into the sentence the model reads as the server speaking, exactly as the
 * SQL card's statement would be.
 */
export const MONGO_DOCUMENT_INDEX_CARD = Object.freeze<
  AgentRecommendationCard<z.infer<typeof mongoIndexRecommendationSchema>>
>({
  inputSchema: mongoIndexRecommendationSchema,
  record(events, card) {
    const { collection, database } = documentIndexTarget(events, card.collection);
    if (indexExists(events, collection, database, Object.keys(card.keys))) return unavailable("INDEX_ALREADY_EXISTS");
    return {
      kind: "recommended",
      recommendation: {
        change: "document-index",
        collection,
        ...(database === undefined ? {} : { database }),
        keys: card.keys,
        ...(card.options === undefined ? {} : { options: card.options }),
        ...(card.rationale === undefined ? {} : { rationale: card.rationale }),
        // Carried by the schema's `.min(1)`, as on the statement card.
        evidence: card.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
      },
      modelText: `Recommendation recorded: one index, offered to the user and not created. It is theirs to apply, in their own tool. ${fenceUntrustedContent(`collection: ${collection}`, { label: "indexed collection name", operationId: "mongo.plan.estimate", reference: "recommendation" })}`,
    };
  },
});

/**
 * The answer, in this engine's words. A plan here is not a description that runs nothing: with several candidate
 * plans the engine tries each for a bounded trial (`MONGO_INSPECT_PLAN`), so what keeps one from being the answer is
 * that it returns none of the command's documents. The schema is the shared tool's, since what is presented is an
 * artifact id and a presentation in every language; `MONGO_ANSWER_NOT_A_DATA_READ` says the same when a plan is
 * presented anyway.
 */
const MONGO_PRESENT_ANSWER: AgentToolDefinition = Object.freeze({
  name: "present_answer",
  description: `Record that one result you have already read IS the answer, and how it should be shown. Only a result of a run_read_query you drafted can be the answer: a plan returns none of the command's documents and a profile returns counts about a collection, so neither may be presented; both may still be cited as evidence. Pass the artifact id that read reported; the command behind it comes from this run's own ledger, so you do not supply it. The columns a chart names are checked against that result's real columns and refused if they do not match. Your report must then cite this same artifact in at least one claim: the presentation shows the result and the claims say what it means, so a report resting on other evidence entirely leaves the run scored as not having answered. ${AGENT_ANSWER_CONTRACT}`,
  inputSchema: presentAnswerSchema,
});

/**
 * The tool definitions a MongoDB workflow replaces: the statement tool for its command argument, the catalog and
 * plan tools for their mongo arms, the profile for its aggregation, the recommendation for its index card, and the
 * answer for what a plan and a profile are on this engine. `compare_plans` is replaced by NOTHING - the variant does
 * not offer it, for the reason its manifest entry states.
 */
const MONGO_STATEMENT_TOOLS: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>> = Object.freeze({
  run_read_query: MONGO_RUN_READ_QUERY,
  inspect_schema: MONGO_INSPECT_SCHEMA,
  inspect_plan: MONGO_INSPECT_PLAN,
  profile_table: MONGO_PROFILE_TABLE,
  recommend_change: MONGO_RECOMMEND_CHANGE,
  present_answer: MONGO_PRESENT_ANSWER,
});

export const MONGO_TOOL_OVERRIDES: AgentLanguageServerPack["toolOverrides"] = Object.freeze({
  investigation: MONGO_STATEMENT_TOOLS,
  "query-optimization": MONGO_STATEMENT_TOOLS,
  "database-assessment": MONGO_STATEMENT_TOOLS,
  "data-analysis": MONGO_STATEMENT_TOOLS,
});

/**
 * `ANSWER_NOT_A_DATA_READ` in MongoDB's words. It says what its `present_answer` description says
 * (`MONGO_PRESENT_ANSWER`), since the shared sentence, that a plan describes a statement without running it, is not
 * true of a plan whose candidates are each tried for a bounded trial.
 */
export const MONGO_ANSWER_NOT_A_DATA_READ =
  "That result is this run's, and it holds none of the documents a read returns, so it cannot be the answer: a plan returns none of the command's documents, and a profile returns counts the server composed about a collection. Present the result of a run_read_query you drafted, and run the read first if you have not. A plan or a profile can still be cited as evidence in your report.";
