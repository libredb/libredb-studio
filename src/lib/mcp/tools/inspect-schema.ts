import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { machineColumns } from "@/lib/db/detailed-object";
import { ExecutionProfileError } from "@/lib/db/errors";
import { containerDepth, isIndexesUnavailable, relationKindIds } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, DatabaseProvider, ObjectDetail } from "@/lib/db/types";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import {
  newMcpCorrelationId,
  recordMcpDecision,
  recordMcpOutcome,
  type McpCallRecord,
  type McpToolAuditReason,
} from "../audit";
import { mcpConnectionUnavailable } from "../availability";
import { metadataReadAnnotations } from "./annotations";
import { DATABASE_ARGUMENT_DESCRIPTION, McpDatabaseChoiceError, providerInDatabase } from "./database-choice";
import { MCP_TIMEOUT_BOUNDS_MS, raceDeadline } from "./read-query-limits";
import { type McpStatementTool, mcpTablelessReadTool } from "./statement-arms";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpConnectionContext,
  type McpReach,
  type McpToolCall,
} from "../context";
import {
  cutUtf8,
  engineError,
  MCP_CANCELLED_TEXT,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_RESULT_CAP_BYTES,
  MCP_TABLE_COMMENT_CAP_BYTES,
  MCP_UNTRUSTED_NOTICE,
  ownWordsError,
  recordOrRefuse,
  resultBytes,
  untrustedResult,
  utf8Length,
  type ToolResult,
} from "../output";

/**
 * inspect_schema (#246): one connection's tables, their columns and, on request, their indexes,
 * behind the untrusted-content notice, because every name, type, default and comment here is
 * database content someone else may have written.
 *
 * It lists the kinds an engine declares as relations and nothing else, and a kind whose names are withheld from
 * machine surfaces is never one (`relationKindIds`), so no such name reaches it. An engine that holds no relation at
 * all, as a Kubernetes cluster, whose kinds are all `config`, does not, is refused by name as soon as the connection
 * resolves, before anything is acquired, and the refusal names the statement tool that reads it, which its arm
 * declares (`holdsNoTables`), rather than answering an empty page.
 *
 * It acquires under agent-operations, which sends no statement and so runs on every engine. The
 * decision event is written before acquisition and the outcome after, and a call whose record
 * cannot be written runs nothing. The page is fitted to the result cap at a table boundary, a
 * table comment is cut to its own bound first, and the column and index caps count what they leave
 * out instead of adding fake entries.
 *
 * One deadline, the call's start plus timeout_ms, covers every provider call: the acquisition, the database choice,
 * each container listing, the relation listing and each table's description each run through `raceDeadline`, so none
 * starts after it, while one already started runs on.
 * Foreign keys come from the description the call makes for columns or indexes anyway, so asking for them alone adds
 * a description only where the engine may declare keys.
 * The schema names are what the last container listing `chooseContainer` made answered, so asking for them sends
 * nothing more.
 */

export const InspectSchemaInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  database: z.string().min(1).optional().describe(DATABASE_ARGUMENT_DESCRIPTION),
  schema: z.string().optional(),
  table: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  include_columns: z.boolean().default(true),
  include_indexes: z.boolean().default(false),
  include_foreign_keys: z
    .boolean()
    .default(false)
    .describe(
      "Also return each table's foreign keys, at most 25, each as column, referenced_table and referenced_column, with foreign_keys_omitted counting the rest, or unavailable on an engine Studio reads no foreign keys on. A composite key comes back as one row per column pair, since no constraint name is returned, and an empty list may also mean the connection's login cannot see the keys.",
    ),
  include_schema_names: z
    .boolean()
    .default(false)
    .describe(
      "Also return schema_names, the names schema can take here, in the engine's order: at most 100 names and 4 KiB of JSON, with schema_names_omitted counting the rest, and no name cut. Where the engine has a level above schemas, they are the ones under the container the session is in, or else the first listed; a connection with no schema level answers unavailable.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(MCP_TIMEOUT_BOUNDS_MS.min)
    .max(MCP_TIMEOUT_BOUNDS_MS.max)
    .default(MCP_TIMEOUT_BOUNDS_MS.max),
});

const InspectedTableSchema = z.object({
  name: z.string(),
  kind: z.string(),
  comment: z.string().optional(),
  comment_truncated: z.literal(true).optional(),
  columns: z
    .array(
      z.object({
        name: z.string(),
        data_type: z.string(),
        is_nullable: z.boolean(),
        default_value: z.string().nullable(),
        is_primary_key: z.boolean(),
      }),
    )
    .optional(),
  columns_omitted: z.number().int(),
  indexes: z
    .union([
      z.array(z.object({ name: z.string(), columns: z.array(z.string()), is_unique: z.boolean() })),
      z.object({ unavailable: z.string() }),
    ])
    .optional(),
  indexes_omitted: z.number().int(),
  foreign_keys: z
    .union([
      z.array(z.object({ column: z.string(), referenced_table: z.string(), referenced_column: z.string() })),
      z.object({ unavailable: z.string() }),
    ])
    .optional(),
  foreign_keys_omitted: z.number().int().optional(),
});

const InspectSchemaOutputSchema = z.object({
  connection_id: z.string(),
  database: z.string().optional(),
  schema: z.string(),
  schema_names: z.union([z.array(z.string()), z.object({ unavailable: z.string() })]).optional(),
  schema_names_omitted: z.number().int().optional(),
  total_tables: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  tables: z.array(InspectedTableSchema),
});

export type InspectSchemaInput = z.infer<typeof InspectSchemaInputSchema>;
type InspectedTable = z.infer<typeof InspectedTableSchema>;
type PageResult = z.infer<typeof InspectSchemaOutputSchema>;

const INSPECT_SCHEMA_TITLE = "Inspect schema";
export const INSPECT_SCHEMA_DESCRIPTION = `List the tables of one connection with their columns and, on request, their indexes. Works on every engine that holds tables. An engine whose objects are not tables refuses it, and the refusal names the tool that reads it, as list_connections' read_tool does. Columns an engine only inferred from sampled data are left out, so a table may hold fields this list does not show. Pages with limit and offset; has_more and next_offset say when more tables exist. It opens the connection under Studio's operations profile, which sends no statement, so on some engines it does not prove the login read-only and may list a connection whose statement tool refuses that login. ${MCP_UNTRUSTED_NOTICE}`;

const MAX_COLUMNS = 50;
const MAX_INDEXES = 25;
const MAX_FOREIGN_KEYS = 25;
const FOREIGN_KEYS_UNAVAILABLE_TEXT = "Studio reads no foreign keys on this engine.";
const MAX_SCHEMA_NAMES = 100;
const MAX_SCHEMA_NAMES_BYTES = 4_096;
const NO_SCHEMA_LEVEL_TEXT =
  "This connection has no schema level: its tables are read at its root, and inspect_schema takes no schema.";
const SCHEMA_NOT_FOUND_TEXT =
  "This connection has no schema of that name. Call inspect_schema without schema to read the default one, or with include_schema_names set to true to list the schemas it can read.";
const FIRST_TABLE_OVER_CAP_TEXT =
  "The first table on this page is larger than the 32 KiB result limit on its own. Call inspect_schema again for it with limit 1 and include_columns, include_indexes, include_foreign_keys and include_schema_names set to false.";
const FIRST_TABLE_OVER_CAP_BARE_TEXT =
  "The first table on this page does not fit the 32 KiB result limit even without its columns and indexes, so it cannot be listed here.";

/** The timeout answer in this tool's words, since `timeoutText` speaks of a statement; more time is offered below the most. */
function inspectSchemaTimeoutText(timeoutMs: number): string {
  const more = timeoutMs < MCP_TIMEOUT_BOUNDS_MS.max ? `, or raise timeout_ms up to ${MCP_TIMEOUT_BOUNDS_MS.max}` : "";
  return `inspect_schema did not finish within timeout_ms (${timeoutMs} ms), and a read it already sent, or the connection it was opening, may still be running. Call it again with table naming one table or with a smaller limit${more}.`;
}

/** A call the deadline or the signal stopped between or during its provider calls. */
class InspectStopped extends Error {
  constructor(readonly reason: "mcp_timeout" | "mcp_cancelled") {
    super(reason);
  }
}

/** One provider call of the call, raced against its signal and deadline: its value, its own error, or the stop. */
type Step = <T>(work: () => Promise<T>) => Promise<T>;

function deadlineStep(signal: AbortSignal, deadline: number): Step {
  return async (work) => {
    const raced = await raceDeadline(work, signal, deadline);
    if (raced.kind === "settled") return raced.value;
    if (raced.kind === "failed") throw raced.error;
    throw new InspectStopped(raced.kind === "timeout" ? "mcp_timeout" : "mcp_cancelled");
  };
}

/** The refusal of an engine that holds no table, naming the statement tool that reads it. */
function tablelessText(type: DatabaseType, tool: McpStatementTool): string {
  return `${getDBConfig(type).label} holds no table for inspect_schema to list. Read this connection with ${tool}.`;
}

/** Where a level was listed, `listed` is what its last listing answered: the deepest one, or the empty one above it. */
type ContainerChoice =
  | { readonly kind: "root" }
  | { readonly kind: "found"; readonly container: Container; readonly listed: readonly Container[] }
  | { readonly kind: "none"; readonly listed: readonly Container[] }
  | { readonly kind: "not-found" };

/**
 * The container the page is read from: at each level above the deepest the one the session is in,
 * or the first listed, and at the deepest the named schema, preferring an exact match and falling
 * back to case-insensitive, or the same default. An engine that declares no level is read at its root;
 * a level that lists nothing leaves nothing to read.
 */
async function chooseContainer(
  provider: DatabaseProvider,
  schema: string | undefined,
  step: Step,
): Promise<ContainerChoice> {
  const depth = containerDepth(provider.getCapabilities());
  const wanted = schema?.toLowerCase();
  if (depth === 0) return wanted === undefined ? { kind: "root" } : { kind: "not-found" };
  let parent: readonly string[] | undefined;
  for (let level = 0; ; level += 1) {
    const containers = await step(() => provider.listContainers(parent));
    const deepest = level === depth - 1;
    const named = deepest && wanted !== undefined;
    const chosen = named
      ? (containers.find((candidate) => candidate.name === schema) ??
        containers.find((candidate) => candidate.name.toLowerCase() === wanted))
      : (containers.find((candidate) => candidate.isSessionDefault === true) ?? containers[0]);
    if (chosen === undefined) return named ? { kind: "not-found" } : { kind: "none", listed: containers };
    if (deepest) return { kind: "found", container: chosen, listed: containers };
    parent = chosen.path;
  }
}

/** A comment an engine reports on an object; no provider fills one today (src/lib/db/types.ts). */
function commentOf(source: unknown): string | undefined {
  const comment = (source as { comment?: unknown }).comment;
  return typeof comment === "string" ? comment : undefined;
}

async function inspectTable(
  provider: DatabaseProvider,
  object: DatabaseObject,
  args: InspectSchemaInput,
  step: Step,
): Promise<InspectedTable> {
  const readsForeignKeys = args.include_foreign_keys && provider.getCapabilities().declaresForeignKeys !== false;
  const detail =
    args.include_columns || args.include_indexes || readsForeignKeys
      ? await step(() => provider.describeObject(object.path, object.kind))
      : null;
  const rawComment = (detail === null ? undefined : commentOf(detail)) ?? commentOf(object);
  const comment = rawComment === undefined ? undefined : cutUtf8(rawComment, MCP_TABLE_COMMENT_CAP_BYTES);
  // Before the cap and the count: a column the engine only inferred from sampled data is named by the data, so it
  // never reaches a client, and `columns_omitted` keeps meaning "beyond the 50-column cap".
  const columns = machineColumns(detail?.columns ?? []);
  const indexesUnavailable = isIndexesUnavailable(detail?.indexes);
  const indexes = Array.isArray(detail?.indexes) ? detail.indexes : [];
  return {
    name: object.name,
    kind: object.kind,
    ...(comment === undefined ? {} : { comment: comment.text }),
    ...(comment?.cut === true ? { comment_truncated: true as const } : {}),
    ...(args.include_columns
      ? {
          columns: columns.slice(0, MAX_COLUMNS).map((column) => ({
            name: column.name,
            data_type: column.type,
            is_nullable: column.nullable,
            default_value: column.defaultValue ?? null,
            is_primary_key: column.isPrimary,
          })),
        }
      : {}),
    columns_omitted: args.include_columns ? Math.max(0, columns.length - MAX_COLUMNS) : 0,
    ...(args.include_indexes
      ? {
          indexes: indexesUnavailable
            ? { unavailable: detail.indexes.unavailable }
            : indexes
                .slice(0, MAX_INDEXES)
                .map((index) => ({ name: index.name, columns: [...index.columns], is_unique: index.unique })),
        }
      : {}),
    indexes_omitted: args.include_indexes && !indexesUnavailable ? Math.max(0, indexes.length - MAX_INDEXES) : 0,
    ...(args.include_foreign_keys ? foreignKeysOf(readsForeignKeys ? detail : null) : {}),
  };
}

/** The described table's first 25 keys with the rest counted, or unavailable where no description read them (null). */
function foreignKeysOf(detail: ObjectDetail | null): Pick<InspectedTable, "foreign_keys" | "foreign_keys_omitted"> {
  if (detail === null) return { foreign_keys: { unavailable: FOREIGN_KEYS_UNAVAILABLE_TEXT } };
  const keys = detail.foreignKeys;
  return {
    foreign_keys: keys.slice(0, MAX_FOREIGN_KEYS).map((key) => ({
      column: key.columnName,
      referenced_table: key.referencedTable,
      referenced_column: key.referencedColumn,
    })),
    foreign_keys_omitted: Math.max(0, keys.length - MAX_FOREIGN_KEYS),
  };
}

/** The listed names in the provider's order while 100 and 4 KiB of JSON hold, the rest counted; no name is cut. */
function schemaNamesOf(listed: readonly Container[]): Pick<PageResult, "schema_names" | "schema_names_omitted"> {
  const names: string[] = [];
  let bytes = utf8Length("[]");
  for (const container of listed) {
    const cost = utf8Length(JSON.stringify(container.name)) + (names.length === 0 ? 0 : 1);
    if (names.length === MAX_SCHEMA_NAMES || bytes + cost > MAX_SCHEMA_NAMES_BYTES) break;
    names.push(container.name);
    bytes += cost;
  }
  return { schema_names: names, schema_names_omitted: listed.length - names.length };
}

function pageResult(
  args: InspectSchemaInput,
  container: Container | null,
  names: Pick<PageResult, "schema_names" | "schema_names_omitted">,
  total: number,
  tables: readonly InspectedTable[],
  cutByCap: boolean,
): ToolResult {
  const hasMore = cutByCap || args.offset + tables.length < total;
  return untrustedResult({
    connection_id: args.connection_id,
    ...(args.database === undefined ? {} : { database: args.database }),
    schema: container?.name ?? "default",
    ...names,
    total_tables: total,
    offset: args.offset,
    limit: args.limit,
    has_more: hasMore,
    next_offset: hasMore ? args.offset + tables.length : null,
    tables: [...tables],
  });
}

/**
 * The objects the page is read from: every kind the engine declares with the relation role, in
 * declared order, because not every engine has a "table" kind. MongoDB lists collections and
 * views, Redis keyspaces, the search engines indexes, and a LibreDB store holds collections and
 * keyspaces beside its tables. Each object is later described under its own kind.
 */
async function listRelations(provider: DatabaseProvider, container: readonly string[]): Promise<DatabaseObject[]> {
  const kinds = relationKindIds(provider.getCapabilities());
  return (await Promise.all(kinds.map((kind) => provider.listObjects(container, kind)))).flat();
}

async function readPage(
  provider: DatabaseProvider,
  args: InspectSchemaInput,
  signal: AbortSignal,
  step: Step,
): Promise<{ readonly result: ToolResult; readonly failure?: McpToolAuditReason }> {
  const choice = await chooseContainer(provider, args.schema, step);
  if (choice.kind === "not-found")
    return { result: ownWordsError(SCHEMA_NOT_FOUND_TEXT), failure: "mcp_schema_not_found" };
  const names = !args.include_schema_names
    ? {}
    : choice.kind === "root"
      ? { schema_names: { unavailable: NO_SCHEMA_LEVEL_TEXT } }
      : schemaNamesOf(choice.listed);
  const container = choice.kind === "found" ? choice.container : null;
  const objects = choice.kind === "none" ? [] : await step(() => listRelations(provider, container?.path ?? []));
  const wanted = args.table?.toLowerCase();
  const filtered = wanted === undefined ? objects : objects.filter((object) => object.name.toLowerCase() === wanted);
  const tables: InspectedTable[] = [];
  for (const object of filtered.slice(args.offset, args.offset + args.limit)) {
    if (signal.aborted) return { result: ownWordsError(MCP_CANCELLED_TEXT), failure: "mcp_cancelled" };
    const table = await inspectTable(provider, object, args, step);
    if (
      resultBytes(pageResult(args, container, names, filtered.length, [...tables, table], false)) > MCP_RESULT_CAP_BYTES
    ) {
      if (tables.length > 0) return { result: pageResult(args, container, names, filtered.length, tables, true) };
      const bare =
        !args.include_columns && !args.include_indexes && !args.include_foreign_keys && !args.include_schema_names;
      return {
        result: ownWordsError(bare ? FIRST_TABLE_OVER_CAP_BARE_TEXT : FIRST_TABLE_OVER_CAP_TEXT),
        failure: "mcp_result_too_large",
      };
    }
    tables.push(table);
  }
  return { result: pageResult(args, container, names, filtered.length, tables, false) };
}

export async function inspectSchema(args: InspectSchemaInput, call: McpToolCall): Promise<ToolResult> {
  const step = deadlineStep(call.signal, Date.now() + args.timeout_ms);
  const record: McpCallRecord = {
    action: "inspect_schema",
    user: call.context.caller.username,
    correlationId: newMcpCorrelationId(),
  };
  const refuse = (reason: McpToolAuditReason, text: string) =>
    recordOrRefuse(() => recordMcpDecision(record, reason)) ?? ownWordsError(text);

  if (call.signal.aborted) return refuse("mcp_cancelled", MCP_CANCELLED_TEXT);
  const connection = await call.context.resolve(args.connection_id);
  if (connection === MCP_CONNECTIONS_UNREADABLE)
    return refuse("mcp_connections_unreadable", MCP_CONNECTIONS_UNREADABLE_TEXT);
  if (connection === null) return refuse("mcp_connection_not_visible", MCP_NOT_VISIBLE_TEXT);

  const resolved: McpCallRecord = { ...record, connectionName: connection.seedId };
  // Ahead of any acquisition, so no provider is built or dialled for an engine with no table to list.
  const tableless = mcpTablelessReadTool(connection.type);
  if (tableless !== null)
    return (
      recordOrRefuse(() => recordMcpDecision(resolved, "mcp_execution_failed")) ??
      ownWordsError(tablelessText(connection.type, tableless))
    );
  // Ahead of any acquisition too: a connection no MCP open can serve for this caller is refused with the sentence
  // list_connections lists it with, so no provider is built for an open that would be refused.
  const unavailable = mcpConnectionUnavailable(call.context.caller, connection);
  if (unavailable !== null)
    return recordOrRefuse(() => recordMcpDecision(resolved, "mcp_execution_failed")) ?? ownWordsError(unavailable);
  const unrecorded = recordOrRefuse(() => recordMcpDecision(resolved));
  if (unrecorded !== null) return unrecorded;

  const startedAt = Date.now();
  const finish = (result: ToolResult, failure?: McpToolAuditReason): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(resolved, Date.now() - startedAt, failure)) ?? result;

  try {
    // In the database the call names, on a connection that reaches a whole server (#1530).
    const acquired = await step(() => call.context.acquire(connection, "agent-operations"));
    const provider = await step(() => providerInDatabase(acquired, args.database));
    if (call.signal.aborted) return finish(ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled");
    const { result, failure } = await readPage(provider, args, call.signal, step);
    return finish(result, failure);
  } catch (error) {
    if (error instanceof InspectStopped) {
      const text = error.reason === "mcp_timeout" ? inspectSchemaTimeoutText(args.timeout_ms) : MCP_CANCELLED_TEXT;
      return finish(ownWordsError(text), error.reason);
    }
    // #1462: the agent-operations profile runs the same role check as agent-read-only
    // (factory.ts), so a superuser seed refuses here too. That refusal is Studio's own
    // decision, not the engine's, so it reads in Studio's words - no untrusted-data
    // notice, no "The database refused or failed the call:" prefix - exactly as
    // run_read_query already answers an ExecutionProfileError.
    if (error instanceof ExecutionProfileError || error instanceof McpDatabaseChoiceError) {
      return finish(ownWordsError(error.message), "mcp_execution_failed");
    }
    return finish(engineError(MCP_ENGINE_ERROR_PREFIX, error), "mcp_execution_failed");
  }
}

/** Its hints are the reached engines' (`metadataReadAnnotations`); without a reach, the read-only hints. */
export function registerInspectSchema(server: McpServer, context: McpConnectionContext, reach?: McpReach): void {
  server.registerTool(
    "inspect_schema",
    {
      title: INSPECT_SCHEMA_TITLE,
      description: INSPECT_SCHEMA_DESCRIPTION,
      inputSchema: InspectSchemaInputSchema,
      outputSchema: InspectSchemaOutputSchema,
      annotations: metadataReadAnnotations(reach),
    },
    (args, ctx) => inspectSchema(args, { context, signal: ctx.mcpReq.signal }),
  );
}
