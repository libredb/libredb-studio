/**
 * The MongoDB arms of the agent tools (issue #1614): what `inspect_schema`, `inspect_plan` and `profile_table` do on
 * the `mongo` statement language, beside the `run_read_query` arm that lives in `tools.ts` because it is the
 * language's statement path. The run loop reaches them through the language's pack (`languages/mongo/index.ts`), never
 * by testing the language itself.
 *
 * A module of its own beside `tools.ts`'s 5,500 lines, which is the lesson of #1744's D348 applied at birth: the
 * SQL arms are one file's history, and a second language's arms are a second file rather than a second thousand
 * lines in the first.
 *
 * WHAT EACH ARM IS:
 *
 * - `mongoInspectSchemaTool`: a SCOPED catalog read through the provider's catalog read for the agent
 *   (`readCatalogReadOnly`) - a collection listing, or one collection's fields and indexes - on the profiled
 *   connection, under the run's own budget, audited as `mongo.schema.read`. A collection the run's captured inventory
 *   holds is read where the inventory read it; any other name is passed whole. The `relations` kind is refused rather
 *   than answered empty, because MongoDB declares no foreign keys and an empty block would read as an absence the
 *   engine never stated. The `indexes` kind is answered from the same description the columns kind reads - one
 *   collection's indexes travel beside its fields - so a selector with no collection is refused and told to name one.
 * - `mongoInspectPlanTool`: the command wrapped in the `explain` command at `queryPlanner` verbosity - the engine
 *   answers with its plan and none of the command's documents - through the same profiled `queryReadOnly` path every
 *   statement takes, audited as `mongo.plan.estimate`.
 * - `planMongoProfile` + `runMongoProfile`: the SQL profile's aggregation composed for this engine - one `$group`
 *   stage whose output carries the SAME aliases the SQL composition emits (`row_count`, `present_N`, `shaped_N`,
 *   `digits_N`), so `readTableProfile`, the mapper the SQL arms read their rows with, reads this engine's rows
 *   unchanged. Only COUNTS cross the wire, which is the whole acceptability of pointing a profile at a collection of
 *   personal data. `distribution` depth is not offered: a distinct count in this engine has no one-statement shape
 *   that does not materialise the set (`$addToSet`) or pay one `$group` per field, and the SQL profile's
 *   one-statement-per-table contract is not something to trade silently.
 */
import type { z } from "zod";
import type { ReadOnlyCatalogReading, ReadOnlyCatalogSelector } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import { AGENT_EXECUTION_PROFILE } from "../../execution-policy";
import { resolveProfileTarget } from "../../inventory-address";
import { addressableObjects } from "../../inventory-objects";
import { MONGO_ADAPTER } from "./adapter";
import { mongoPlanCommandSchema, mongoProfileSelectorSchema } from "./definitions";
import { DIGIT_RUN_LENGTH, MAX_PROFILE_COLUMNS, type AgentTableProfile, readTableProfile } from "../../table-profile";
import {
  type AgentTableProfileOutcome,
  type AgentToolContext,
  type AgentToolOutcome,
  executeAgentOperation,
  readOnlyBudgetFor,
  runAuditedAgentCall,
} from "../../tools";
import {
  capturedSnapshot,
  catalogSelectorSchema,
  describeFindings,
  handoverText,
  unavailable,
} from "../../tool-contracts";
import type { AgentArtifactReference, AgentContextSnapshot, AgentInventoryObject, AgentRunRecord } from "../../types";
import { fenceUntrustedContent } from "../../untrusted-content";

/** One schema's problems on one line, the rendering this layer's refusals carry elsewhere. */
function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/**
 * The shape tests as `$regexMatch` patterns: the same shapes the SQL dialects test inside their engines. The email
 * shape is `LIKE '%_@_%._%'` unanchored - a character, an `@`, a character, anything, a dot, a character - so the
 * counts mean the same on every engine; `s` lets `.` match a newline, as `_` matches any character.
 */
const EMAIL_SHAPE_REGEX = ".@.+\\..";
const DIGIT_RUN_REGEX = `[0-9]{${DIGIT_RUN_LENGTH},}`;

/**
 * A scoped catalog read, the model-facing tool. See the module docblock for what each kind answers.
 *
 * `snapshot` is the inventory this run captured, which is what a spelling resolves against: it names each collection
 * with its database in front (`app.orders`), and a model may copy that or write the bare name.
 */
export async function mongoInspectSchemaTool(
  context: AgentToolContext,
  input: unknown,
  snapshot: AgentContextSnapshot | null,
): Promise<AgentToolOutcome> {
  const parsed = catalogSelectorSchema.safeParse(input);
  if (!parsed.success) return unavailable("INVALID_TOOL_INPUT", issueText(parsed.error));
  const { kind, schema, table } = parsed.data;
  if (kind === "relations") {
    return unavailable(
      "KIND_REFUSED",
      "MongoDB declares no foreign keys, so a relations read would answer empty and read as an absence the engine never stated. Read columns for the collections and their fields.",
    );
  }
  if (kind === "indexes" && table === undefined) {
    return unavailable(
      "KIND_REFUSED",
      "A database-wide index inventory is not a catalog read here. Narrow to one collection with table, and its indexes are described beside its fields.",
    );
  }
  const selector = {
    ...(kind === undefined ? {} : { kind }),
    ...(schema === undefined ? {} : { schema }),
    ...(table === undefined ? {} : { table }),
  };
  const scope =
    table === undefined
      ? schema === undefined
        ? "the database this connection is bound to"
        : `the database ${schema}`
      : `the collection ${table}`;
  // The provider's answer, kept beside the rows the pipeline stores: whether the object exists, and whether its
  // sample held anything, is read off it below, the way `inspectSchemaTool` reads a composed read's row count.
  let reading: ReadOnlyCatalogReading | undefined;
  // Not a statement in any language, so it does not go through `executeAgentOperation`: the selector is the
  // identity, as a curated read's key is, and `runAuditedAgentCall` is the one path that takes an identity of its
  // own. Every gate the statement path runs - mode, repair ledger, deadline, policy pipeline - runs here too.
  const outcome = await runAuditedAgentCall(context, {
    operationId: "mongo.schema.read",
    fingerprintSource: `mongo-objects:${JSON.stringify(selector)}`,
    input: selector,
    label: `catalog read of ${scope}`,
    invoke: async (_validatedInput, budget, phase) => {
      const provider = await context.acquireProvider(context.connection, AGENT_EXECUTION_PROFILE);
      if (typeof provider.readCatalogReadOnly !== "function") {
        // A server fault, never a model-visible outcome and never a fallback to the editor's object surface, which
        // carries no deadline of the agent's: the acquisition refuses a provider without the read-only path, so
        // reaching here means the acquirer is not the profile seam.
        throw new Error(
          "agent tool layer: the acquired provider has no readCatalogReadOnly, the catalog read this arm takes",
        );
      }
      const startedAtMs = context.clock?.() ?? Date.now();
      // Set before the read leaves, as the statement path sets it: a failure from here on is the read's, which the
      // pipeline settles as a refusal the model can act on (a database the principal cannot read, a collection
      // name the engine refuses) rather than an error that ends the run.
      phase.statementSent = true;
      reading = await provider.readCatalogReadOnly(
        catalogTarget(snapshot, schema, table),
        readOnlyBudgetFor(context, budget),
      );
      return { ...catalogRows(reading, kind), executionTime: (context.clock?.() ?? Date.now()) - startedAtMs };
    },
  });
  if (outcome.kind !== "completed" || reading === undefined) return outcome;
  // The three empty answers, each in its own words and none a citable empty artifact: a catalog read that inspected
  // nothing establishes nothing (`inspectSchemaTool` makes the same refusal for the SQL engines).
  if (reading.kind === "not-found") return unavailable("CATALOG_MATCHED_NOTHING");
  if (reading.kind === "listed") return reading.objects.length === 0 ? unavailable("CATALOG_MATCHED_NOTHING") : outcome;
  if (kind === "indexes")
    return reading.indexes.length === 0 ? unavailable("CATALOG_INVENTORY_EMPTY", "indexes") : outcome;
  return reading.columns.length === 0 ? unavailable("CATALOG_OBJECT_EMPTY") : outcome;
}

/**
 * What the catalog read asks the provider for: the collection the run's inventory holds under the spelling, read in
 * the database the inventory read it in, or else the spelling itself, whole.
 *
 * Never a guessed database: an absent container is the provider's to resolve to the one it is bound to, and a name
 * the inventory does not resolve is never split on its dot, because a collection may be named `fs.files`.
 */
function catalogTarget(
  snapshot: AgentContextSnapshot | null,
  schema: string | undefined,
  table: string | undefined,
): ReadOnlyCatalogSelector {
  if (table === undefined) return schema === undefined ? {} : { container: schema };
  const resolution =
    snapshot === null ? null : resolveProfileTarget(snapshot.objects, schema, table, snapshot.defaultContainer);
  if (resolution?.kind === "resolved") {
    const { schema: container, table: object } = resolution.target;
    return container === undefined ? { object } : { container, object };
  }
  return schema === undefined ? { object: table } : { container: schema, object: table };
}

/** The rows the pipeline stores for one catalog reading: what it can cite, in the shape the SQL arm's rows take. */
function catalogRows(
  reading: ReadOnlyCatalogReading,
  kind: "columns" | "indexes" | undefined,
): { rows: Record<string, unknown>[]; fields: string[]; rowCount: number } {
  if (reading.kind === "not-found") return { rows: [], fields: [], rowCount: 0 };
  if (reading.kind === "listed") {
    const rows = reading.objects.map((object) => ({ object: object.name, kind: object.kind }));
    return { rows, fields: ["object", "kind"], rowCount: rows.length };
  }
  if (kind === "indexes") {
    const rows = reading.indexes.map((index) => ({ name: index.name, columns: index.columns.join(",") }));
    return { rows, fields: ["name", "columns"], rowCount: rows.length };
  }
  const rows = reading.columns.map((column) => ({ name: column.name, type: column.type }));
  return { rows, fields: ["name", "type"], rowCount: rows.length };
}

/**
 * The estimating plan: the command, wrapped in the engine's own `explain` at `queryPlanner` verbosity.
 *
 * The input is the command OBJECT the model wrote, read by the mongo language's own `canonicalize`, the one
 * `runReadQueryTool` reads a mongo run's command with, so the command planned is the command a read of it would run,
 * in the order it was written, and the operation's descriptor validates it with the same admission the statement path
 * validates with. The `mode: "estimate-plan"` is what makes the provider wrap the envelope in `explain` instead of
 * running it - the same seam the SQL `EXPLAIN` arms drive.
 */
export async function mongoInspectPlanTool(
  context: AgentToolContext,
  input: unknown,
  snapshot: AgentContextSnapshot | null = null,
): Promise<AgentToolOutcome> {
  const parsed = mongoPlanCommandSchema.safeParse(input);
  if (!parsed.success) return unavailable("INVALID_TOOL_INPUT", issueText(parsed.error));
  const server = MONGO_ADAPTER;
  const statement = server.canonicalize(parsed.data.command);
  if (statement === null) return unavailable("INVALID_TOOL_INPUT", "The command is empty, and nothing was planned.");
  // The read path's inventory check, on a command the reader admits; one it does not admit goes on to the pipeline,
  // which refuses it as before. A plan of a date range written with strings is an index scan over strings, which a
  // live run on 2026-10-17 reported as the index "efficiently locating matching documents" for a query matching none.
  if ((server.admit?.(statement) ?? null) === null) {
    const problem = server.inventoryProblem?.(statement, snapshot) ?? null;
    if (problem !== null)
      return unavailable("STATEMENT_NOT_ADMITTED", problem.replace("Nothing was sent.", "Nothing was planned."));
  }
  return executeAgentOperation(context, {
    operationId: "mongo.plan.estimate",
    sql: statement,
    argument: "command",
    mode: "estimate-plan",
    label: "query plan",
  });
}

/**
 * The composed profile of one collection, as the aggregation the engine will run.
 *
 * Composed by the SERVER from the run's own captured inventory, exactly as the SQL profile is composed from the
 * snapshot's columns: the model supplies only the collection, the depth and where in its fields to start. `target` is
 * what the spelling RESOLVED to, `{schema: database, table: collection}`, which is what the step is identified by and
 * what the statement is composed from, so the ledger names the collection that was read.
 */
export interface MongoProfilePlan {
  readonly target: { readonly schema?: string; readonly table: string };
  readonly depth: "basic" | "pattern";
  readonly columns: readonly { readonly name: string; readonly textual: boolean }[];
  /** Where in the collection's fields this batch starts. */
  readonly from: number;
  /** Fields beyond this batch, so nothing silently claims to have covered them. */
  readonly remaining: number;
  /** Every count the `$group` answers, by alias: what an empty collection's answer is read as. */
  readonly aliases: readonly string[];
  readonly statement: string;
}

export type MongoProfilePlanOutcome =
  | { readonly kind: "planned"; readonly plan: MongoProfilePlan }
  | (AgentToolOutcome & { readonly kind: "unavailable" });

/**
 * One count of a shape, over string values only: `$and` stops at the type test, so the pattern never meets a value
 * that is not a string. Nothing is converted to text first: converting an object to a string fails the whole
 * aggregation on 7.0 and tests the object's JSON on 8.3 and 9.0 (measured during review).
 */
function shapeCount(path: string, regex: string): unknown {
  return {
    $sum: {
      $cond: [
        { $and: [{ $eq: [{ $type: path }, "string"] }, { $regexMatch: { input: path, regex, options: "s" } }] },
        1,
        0,
      ],
    },
  };
}

/**
 * Resolves the collection from the run's inventory and composes its profile, or answers why there is nothing to
 * compose: input the selector refuses, a spelling the inventory holds twice or not at all, or a batch past the last
 * field. Reaches nothing.
 *
 * Resolved by `resolveProfileTarget`, the rule the SQL arm resolves a table with, so a qualified spelling, a bare one
 * and a schema-plus-table pair reach the same entry, and the statement names the entry's own database and collection.
 * Its fields are sliced from `fromColumn` by the SQL profile's own bound (`MAX_PROFILE_COLUMNS`); an inventoried
 * collection with no field is still counted, its `$group` answering the document count alone.
 */
export function mongoProfileTablePlan(
  objects: readonly AgentInventoryObject[],
  defaultContainer: readonly string[] | undefined,
  input: unknown,
): MongoProfilePlanOutcome {
  const parsed = mongoProfileSelectorSchema.safeParse(input);
  if (!parsed.success) return unavailable("INVALID_TOOL_INPUT", issueText(parsed.error));
  const { schema, table, depth, fromColumn } = parsed.data;
  const resolution = resolveProfileTarget(objects, schema, table, defaultContainer);
  // The candidates are this inventory's own addresses, so a model can copy one back verbatim.
  if (resolution.kind === "ambiguous") {
    return unavailable("TABLE_SPELLING_AMBIGUOUS", resolution.candidates.map((entry) => entry.name).join(", "));
  }
  if (resolution.kind === "absent") {
    const offer = objects.slice(0, 6).map((entry) => entry.name);
    return unavailable("TABLE_NOT_INVENTORIED", offer.length === 0 ? undefined : `it lists ${offer.join(", ")}`);
  }
  const { entry, segments } = resolution.target;
  const fields = entry.columns.map((column) => ({
    name: column.name,
    textual: column.type === "" || /\b(string|text)\b/i.test(column.type),
  }));
  const from = fromColumn ?? 0;
  // Past the last field there is nothing to count; at the first field of a collection with none, the document count
  // is still an answer.
  if (from > 0 && from >= fields.length) return unavailable("NO_COLUMNS_AT_OFFSET");
  const batch = fields.slice(from, from + MAX_PROFILE_COLUMNS);
  // The aliases are the batch's own, as the SQL composition's are: `readTableProfile` reads them by index.
  const group: Record<string, unknown> = { _id: null, row_count: { $sum: 1 } };
  batch.forEach((column, index) => {
    const path = `$${column.name}`;
    group[`present_${index}`] = { $sum: { $cond: [{ $in: [{ $type: path }, ["missing", "null"]] }, 0, 1] } };
    if (depth === "pattern" && column.textual) {
      group[`shaped_${index}`] = shapeCount(path, EMAIL_SHAPE_REGEX);
      group[`digits_${index}`] = shapeCount(path, DIGIT_RUN_REGEX);
    }
  });
  const collection = segments[segments.length - 1];
  const database = segments.length > 1 ? segments[0] : undefined;
  return {
    kind: "planned",
    plan: {
      target: database === undefined ? { table: collection } : { schema: database, table: collection },
      depth,
      columns: batch,
      from,
      remaining: Math.max(0, fields.length - (from + batch.length)),
      aliases: Object.keys(group).filter((alias) => alias !== "_id"),
      statement: JSON.stringify({
        collection,
        ...(database === undefined ? {} : { database }),
        operation: "aggregate",
        pipeline: [{ $group: group }],
      }),
    },
  };
}

/**
 * The profile arm's planning step, as the run loop asks it: the collection resolved from the run's own captured
 * inventory, among the objects a profile may target (`addressableObjects`), with the session's database as the
 * tie-breaker.
 */
export function planMongoProfile(
  context: AgentToolContext,
  run: Pick<AgentRunRecord, "runId" | "events">,
  input: unknown,
): MongoProfilePlanOutcome {
  if (context.mode !== "agent") return unavailable("MODE_HAS_NO_TOOLS");
  if (run.runId !== context.runId) {
    throw new Error("agent tool layer: the profile's run record does not belong to this run");
  }
  const snapshot = capturedSnapshot(run.events);
  return mongoProfileTablePlan(
    snapshot === null ? [] : addressableObjects(snapshot),
    snapshot?.defaultContainer,
    input,
  );
}

/**
 * The profile's run and its mapping: the composed aggregation through the audited statement path, then the one row it
 * answers into the same `AgentTableProfile` the SQL arms record, through the same `readTableProfile`.
 *
 * A `$group` over no document answers no row at all, which is the engine's answer for an empty collection, so it is
 * read as every count being zero: a profile of zero documents, never a profile that could not be read. A row that does
 * not map is `PROFILE_UNREADABLE`, refused rather than reported as a profile of nothing.
 */
export async function runMongoProfile(
  context: AgentToolContext,
  plan: MongoProfilePlan,
): Promise<AgentTableProfileOutcome> {
  const outcome = await executeAgentOperation(context, {
    operationId: "mongo.table.profile",
    sql: plan.statement,
    argument: "command",
    label: `profile of ${plan.target.table}`,
  });
  if (outcome.kind !== "completed") return outcome;
  const stored = context.artifacts.get(outcome.artifact.correlationId, (context.clock ?? Date.now)());
  if (stored === undefined) return unavailable("PROFILE_UNREADABLE");
  const columns: ColumnSchema[] = plan.columns.map((column) => ({
    name: column.name,
    type: column.textual ? "string" : "unknown",
    nullable: true,
    isPrimary: false,
  }));
  const rows =
    stored.value.rows.length === 0 ? [Object.fromEntries(plan.aliases.map((alias) => [alias, 0]))] : stored.value.rows;
  const profile = readTableProfile(plan.target.table, plan.depth, columns, rows);
  if (profile === null) return unavailable("PROFILE_UNREADABLE");
  return {
    kind: "profiled",
    artifact: outcome.artifact,
    profile,
    modelText: mongoProfileModelText(profile, outcome.artifact, plan),
  };
}

/**
 * What one batch covered of the fields the run's inventory lists for the collection. That list was inferred from a
 * sample of its documents and is bounded, so full coverage is stated of the list, never of the collection. A
 * collection whose inventory lists no field is still profiled, as its document count (`mongoProfileTablePlan`), and is
 * told so rather than told every field is covered.
 */
function fieldCoverage(plan: MongoProfilePlan): string {
  if (plan.columns.length === 0) return "Its inventory lists no field, so only its documents were counted.";
  if (plan.remaining === 0) return "Every field the inventory lists for that collection is covered.";
  return `${plan.remaining} further field(s) are NOT covered by this profile; call profile_table again with fromColumn=${plan.from + plan.columns.length} to reach them.`;
}

/** The model-facing text of one profiled collection, mirroring the SQL arm's sentence for sentence. */
function mongoProfileModelText(
  profile: AgentTableProfile,
  artifact: AgentArtifactReference,
  plan: MongoProfilePlan,
): string {
  const fields = plan.columns.length === 0 ? "no field" : `fields ${plan.from + 1}-${plan.from + plan.columns.length}`;
  return [
    `Profiled a collection: ${profile.rowCount} document(s), ${fields} at ${plan.depth} depth, ${profile.findings.length} finding(s). ${handoverText(artifact.correlationId)}`,
    fieldCoverage(plan),
    "Only counts were read; no value was returned from any field.",
    fenceUntrustedContent(`collection: ${plan.target.table}`, {
      label: "profiled collection name",
      operationId: "mongo.table.profile",
      reference: artifact.correlationId,
    }),
    describeFindings(profile.findings, "mongo.table.profile"),
  ].join(" ");
}
