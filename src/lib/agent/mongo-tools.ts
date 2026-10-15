/**
 * The MongoDB arms of the agent tools (issue #1614): what `inspect_schema`, `inspect_plan` and `profile_table` do on
 * the `mongo` statement language, beside the `run_read_query` arm that lives in `tools.ts` because it is the
 * language's statement path.
 *
 * A module of its own beside `tools.ts`'s 5,500 lines, which is the lesson of #1744's D348 applied at birth: the
 * SQL arms are one file's history, and a second language's arms are a second file rather than a second thousand
 * lines in the first.
 *
 * WHAT EACH ARM IS:
 *
 * - `mongoInspectSchemaTool`: a SCOPED catalog read from the provider's own inventory - `listObjects` for a
 *   collection listing, `describeObject` for one collection's fields and indexes - on the profiled connection,
 *   audited as `mongo.schema.read`. The `relations` kind is refused rather than answered empty, because MongoDB
 *   declares no foreign keys and an empty block would read as an absence the engine never stated. The `indexes`
 *   kind is answered from the same `describeObject` the columns kind reads - one collection's indexes travel beside
 *   its fields - while a DATABASE-wide index inventory is the `index-stats` reading of `inspect_operations`, not a
 *   catalog row, and a selector with no collection is refused toward it.
 * - `mongoInspectPlanTool`: the command wrapped in the `explain` command at `queryPlanner` verbosity - the engine
 *   PLANS and does not execute - through the same profiled `queryReadOnly` path every statement takes, audited as
 *   `mongo.plan.estimate`.
 * - `mongoProfileTablePlan` + `runMongoProfile`: the SQL profile's aggregation composed for this engine - one
 *   `$group` stage whose output carries the SAME aliases the SQL composition emits (`row_count`, `present_N`,
 *   `shaped_N`, `digits_N`), so `readTableProfile`, the mapper the SQL arms read their rows with, reads this
 *   engine's rows unchanged. Only COUNTS cross the wire, which is the whole acceptability of pointing a profile at
 *   a collection of personal data. `distribution` depth is REFUSED rather than composed, and the refusal is the
 *   honest cost statement: a distinct count in this engine has no one-statement shape that does not materialise the
 *   set (`$addToSet`) or pay one `$group` per field, and the SQL profile's one-statement-per-table contract is not
 *   something to trade silently.
 */
import { z } from "zod";
import {
  executeAgentOperation,
  runAuditedAgentCall,
  unavailable,
  catalogSelectorSchema,
  type AgentToolContext,
  type AgentToolOutcome,
  type AgentToolUnavailableCode,
} from "./tools";
import { mongoProfileSelectorInput } from "@/lib/db/operations/descriptors";
import { readTableProfile, type AgentTableProfile, type AgentProfileDepth } from "./table-profile";
import type { AgentArtifactReference, AgentInventoryObject } from "./types";
import { fenceUntrustedContent } from "./untrusted-content";

/** One schema's problems on one line, the rendering this layer's refusals carry elsewhere. */
function issueText(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

/** How many fields one `$group` counts: the batch the SQL composition's own bound taught, in this engine's word. */
const PROFILE_FIELD_BATCH = 24;

/** The shape tests as `$regexMatch` patterns: the same shapes the SQL dialects test inside their engines. */
const EMAIL_SHAPE_REGEX = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";
const DIGIT_RUN_REGEX = "[0-9]{9,}";

/**
 * A scoped catalog read, the model-facing tool. See the module docblock for what each kind answers.
 */
export async function mongoInspectSchemaTool(
  context: AgentToolContext,
  input: { readonly kind?: "columns" | "indexes" | "relations"; readonly schema?: string; table?: string },
): Promise<AgentToolOutcome> {
  const parsed = catalogSelectorSchema.safeParse(input);
  if (!parsed.success) return unavailable("INVALID_TOOL_INPUT", issueText(parsed.error));
  if (parsed.data.kind === "relations") {
    return unavailable(
      "KIND_REFUSED",
      "MongoDB declares no foreign keys, so a relations read would answer empty and read as an absence the engine never stated. Read columns for the collections and their fields.",
    );
  }
  if (parsed.data.kind === "indexes" && parsed.data.table === undefined) {
    return unavailable(
      "KIND_REFUSED",
      "A database-wide index inventory is not a catalog read here: it is the index-stats reading of inspect_operations, served with the counts the engine itself reports. Narrow to one collection with table, and its indexes are described beside its fields.",
    );
  }
  const selector = {
    ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
    ...(parsed.data.schema === undefined ? {} : { schema: parsed.data.schema }),
    ...(parsed.data.table === undefined ? {} : { table: parsed.data.table }),
  };
  const scope =
    parsed.data.table === undefined
      ? parsed.data.schema === undefined
        ? "the session's default database"
        : `the database ${parsed.data.schema}`
      : `the collection ${parsed.data.table}`;
  // Not a statement in any language, so it does not go through `executeAgentOperation`: the
  // selector is the identity, as a curated read's key is, and `runAuditedAgentCall` is the one
  // path that takes an identity of its own. Every gate the statement path runs - mode, repair
  // ledger, deadline, policy pipeline - runs here too, because it is the same audited call.
  return runAuditedAgentCall(context, {
    operationId: "mongo.schema.read",
    fingerprintSource: `mongo-objects:${JSON.stringify(selector)}`,
    input: selector,
    label: `catalog read of ${scope}`,
    invoke: () => readScopedInventory(context, selector),
  });
}

/**
 * The scoped inventory read itself: the provider's own object-surface methods, on the profiled connection.
 *
 * With a collection named, `describeObject` answers its fields and, for the indexes kind, its indexes. The KIND the
 * describe takes is resolved from the run's own captured snapshot when the dispatcher could pass it, and from the
 * engine's own catalog rows when it could not: the relation kinds the capabilities declare are listed until the
 * name matches, so the kind is read off the engine rather than guessed, and a view is never described as the
 * collection underneath it. With no collection named, `listObjects` answers the collections of the database the
 * selector named, or the session's own when it named none.
 */
async function readScopedInventory(
  context: AgentToolContext,
  selector: { readonly kind?: string; readonly schema?: string; readonly table?: string },
): Promise<{ rows: Record<string, unknown>[]; fields: string[]; rowCount: number; executionTime: number }> {
  const startedAt = Date.now();
  const provider = await context.acquireProvider(context.connection, "agent-read-only");
  if (selector.table === undefined) {
    const database = selector.schema ?? context.connection.database ?? "admin";
    const objects = await provider.listObjects([database], "collection");
    const rows = objects.map((object) => ({
      object: object.name,
      kind: object.kind ?? "collection",
    }));
    return { rows, fields: ["object", "kind"], rowCount: rows.length, executionTime: Date.now() - startedAt };
  }
  const database = selector.schema ?? context.connection.database ?? "admin";
  const kind = await resolveCollectionKind(provider, database, selector.table);
  if (kind === null) {
    throw Object.assign(new Error(`No collection named ${selector.table} in ${database}`), { name: "QueryError" });
  }
  const detail = await provider.describeObject([database, selector.table], kind);
  const wantsIndexes = selector.kind === "indexes";
  const rows = wantsIndexes
    ? detail.indexes.map((index) => ({ name: index.name, columns: index.columns.join(",") }))
    : detail.columns.map((column) => ({ name: column.name, type: column.type }));
  return {
    rows,
    fields: wantsIndexes ? ["name", "columns"] : ["name", "type"],
    rowCount: rows.length,
    executionTime: Date.now() - startedAt,
  };
}

/**
 * The kind of one named collection, read off the engine: the relation kinds the capabilities declare are listed
 * until the name matches, in declaration order, so a view is a view. Null when no relation kind holds the name.
 *
 * The engine's own catalog row classifies the object - the same fact `describeObject` requires - so this is a
 * lookup the engine answers, not a guess the server makes.
 */
async function resolveCollectionKind(
  provider: {
    readonly getCapabilities: () => {
      readonly objectKinds?: readonly { readonly id: string; readonly role?: string }[];
    };
    readonly listObjects: (container: readonly string[], kind: string) => Promise<{ readonly name: string }[]>;
  },
  database: string,
  table: string,
): Promise<string | null> {
  const kinds = (provider.getCapabilities().objectKinds ?? []).filter((spec) => spec.role === "relation");
  for (const spec of kinds) {
    const objects = await provider.listObjects([database], spec.id);
    if (objects.some((object) => object.name === table)) return spec.id;
  }
  return null;
}

/**
 * The estimating plan: the command, wrapped in the engine's own `explain` at `queryPlanner` verbosity.
 *
 * The input is the command OBJECT the model wrote; the canonical text is produced once here, exactly as
 * `runReadQueryTool` produces it, and the operation's descriptor validates it with the same admission the statement
 * path validates with. The `mode: "estimate-plan"` is what makes the provider wrap the envelope in `explain`
 * instead of running it - the same seam the SQL `EXPLAIN` arms drive.
 */
export async function mongoInspectPlanTool(context: AgentToolContext, input: unknown): Promise<AgentToolOutcome> {
  const parsed = z
    .strictObject({ command: z.record(z.string(), z.unknown()), rationale: z.string().optional() })
    .safeParse(input);
  if (!parsed.success) return unavailable("INVALID_TOOL_INPUT", issueText(parsed.error));
  const canonical = canonicalMongoCommand(parsed.data.command);
  return executeAgentOperation(context, {
    operationId: "mongo.plan.estimate",
    sql: canonical,
    argument: "command",
    mode: "estimate-plan",
    label: "query plan",
  });
}

/**
 * One model command as the canonical sorted-key text: the same serialisation `runReadQueryTool` and the draft entry
 * use, so the plan the run records, the fingerprint that identities it and the statement the provider is asked to
 * plan are one form.
 */
function canonicalMongoCommand(command: unknown): string {
  return JSON.stringify(command, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : value,
  );
}

/**
 * The composed profile of one collection, as the aggregation the engine will run.
 *
 * Composed by the SERVER from the run's own captured inventory, exactly as the SQL profile is composed from the
 * snapshot's columns: the model supplies only the collection and the depth. The `$group` stage's output carries the
 * SAME aliases the SQL composition emits, so `readTableProfile` - the mapper behind both - reads either engine's
 * row unchanged: `row_count`, `present_N` per field, `shaped_N` and `digits_N` at pattern depth.
 */
export interface MongoProfilePlan {
  readonly target: { readonly schema?: string; readonly table: string };
  readonly depth: AgentProfileDepth;
  readonly columns: readonly { readonly name: string; readonly textual: boolean }[];
  readonly from: number;
  readonly remaining: number;
  readonly statement: string;
}

/**
 * Resolves the collection from the run's snapshot and composes its profile.
 *
 * Returns the plan, or the refusal detail when there is nothing to compose: an unresolvable name, or the
 * `distribution` depth this engine has no one-statement shape for.
 */
export function mongoProfileTablePlan(
  objects: readonly AgentInventoryObject[],
  input: { readonly schema?: string; readonly table?: string; readonly depth?: string },
): MongoProfilePlan | { readonly refusal: string } {
  const parsed = mongoProfileSelectorInput.safeParse(input);
  if (!parsed.success) {
    return { refusal: issueText(parsed.error) };
  }
  if (parsed.data.depth === "distribution") {
    return {
      refusal:
        "distribution is not composed for MongoDB: a distinct count here has no one-statement shape that does not materialise the set, and trading the profile's one-statement cost silently is worse than saying so. Ask basic (documents and per-field presence) or pattern (email-shaped and digit-run counts).",
    };
  }
  const entry = objects.find((object) => object.name === parsed.data.table || object.path?.[1] === parsed.data.table);
  if (entry === undefined || entry.columns.length === 0) {
    return {
      refusal: `No collection named ${parsed.data.table} with fields to count is in this run's captured inventory. Ask inspect_schema for it, or profile one the inventory named.`,
    };
  }
  const all = entry.columns.map((column) => ({
    name: column.name,
    textual: column.type === "" || /\b(string|text)\b/i.test(column.type),
  }));
  const batch = all.slice(0, PROFILE_FIELD_BATCH);
  const group: Record<string, unknown> = { _id: null, row_count: { $sum: 1 } };
  batch.forEach((column, index) => {
    group[`present_${index}`] = {
      $sum: { $cond: [{ $in: [{ $type: `$${column.name}` }, ["missing", "null"]] }, 0, 1] },
    };
    if (parsed.data.depth === "pattern" && column.textual) {
      group[`shaped_${index}`] = {
        $sum: { $cond: [{ $regexMatch: { input: { $toString: `$${column.name}` }, regex: EMAIL_SHAPE_REGEX } }, 1, 0] },
      };
      group[`digits_${index}`] = {
        $sum: { $cond: [{ $regexMatch: { input: { $toString: `$${column.name}` }, regex: DIGIT_RUN_REGEX } }, 1, 0] },
      };
    }
  });
  const statement = JSON.stringify({
    collection: parsed.data.table,
    operation: "aggregate",
    pipeline: [{ $group: group }],
  });
  return {
    target: {
      ...(parsed.data.schema === undefined ? {} : { schema: parsed.data.schema }),
      table: parsed.data.table,
    },
    depth: parsed.data.depth,
    columns: batch,
    from: 0,
    remaining: Math.max(0, all.length - batch.length),
    statement,
  };
}

/**
 * The profile's run and its mapping: the composed aggregation through the audited statement path, then the one row
 * it answers into the same `AgentTableProfile` the SQL arms record, through the same `readTableProfile`.
 *
 * Null when the row did not map - the aggregate answered no row, which is the SQL arm's null too, and the caller
 * refuses rather than reporting a profile of nothing.
 */
export async function runMongoProfile(
  context: AgentToolContext,
  plan: MongoProfilePlan,
): Promise<
  | { readonly profile: AgentTableProfile; readonly artifact: AgentArtifactReference }
  | { readonly outcome: AgentToolOutcome }
> {
  const outcome = await executeAgentOperation(context, {
    operationId: "mongo.table.profile",
    sql: plan.statement,
    argument: "command",
    label: `profile of ${plan.target.table}`,
  });
  if (outcome.kind !== "completed") return { outcome };
  const stored = context.artifacts.get(outcome.artifact.correlationId, (context.clock ?? Date.now)());
  if (stored === undefined) return { outcome: unavailable("PROFILE_UNREADABLE") };
  const columns = plan.columns.map((column) => ({
    name: column.name,
    type: column.textual ? "string" : "unknown",
    nullable: true,
    isPrimary: false,
  }));
  const profile = readTableProfile(plan.target.table, plan.depth, columns, stored.value.rows);
  if (profile === null) return { outcome: unavailable("PROFILE_UNREADABLE") };
  return { profile, artifact: outcome.artifact };
}

/** The model-facing text of one profiled collection, mirroring the SQL arm's sentence for sentence. */
export function mongoProfileModelText(
  profile: AgentTableProfile,
  artifact: AgentArtifactReference,
  plan: MongoProfilePlan,
): string {
  return [
    `Profiled a collection: ${profile.rowCount} document(s), fields ${plan.from + 1}-${plan.from + plan.columns.length} at ${plan.depth} depth, ${profile.findings.length} finding(s). ${artifact.correlationId}`,
    plan.remaining === 0
      ? "Every field of that collection is covered."
      : `${plan.remaining} further field(s) are NOT covered by this profile; call profile_table again with fromColumn=${plan.from + plan.columns.length} to reach them.`,
    "Only counts were read; no value was returned from any field.",
    fenceUntrustedContent(`collection: ${plan.target.table}`, {
      label: "profiled collection name",
      operationId: "mongo.table.profile",
      reference: artifact.correlationId,
    }),
  ].join(" ");
}
