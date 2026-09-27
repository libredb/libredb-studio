import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { containerDepth, relationKindIds } from "@/lib/db/object-kinds";
import type { Container, DatabaseObject, DatabaseProvider } from "@/lib/db/types";
import {
  newMcpCorrelationId,
  recordMcpDecision,
  recordMcpOutcome,
  type McpCallRecord,
  type McpToolAuditReason,
} from "../audit";
import {
  MCP_CONNECTIONS_UNREADABLE,
  MCP_CONNECTIONS_UNREADABLE_TEXT,
  type McpConnectionContext,
  type McpToolCall,
} from "../context";
import {
  cutUtf8,
  engineError,
  MCP_CANCELLED_TEXT,
  MCP_ENGINE_ERROR_PREFIX,
  MCP_NOT_VISIBLE_TEXT,
  MCP_READ_ONLY_ANNOTATIONS,
  MCP_RESULT_CAP_BYTES,
  MCP_TABLE_COMMENT_CAP_BYTES,
  MCP_UNTRUSTED_NOTICE,
  ownWordsError,
  recordOrRefuse,
  resultBytes,
  untrustedResult,
  type ToolResult,
} from "../output";

/**
 * inspect_schema (#246): one connection's tables, their columns and, on request, their indexes,
 * behind the untrusted-content notice, because every name, type, default and comment here is
 * database content someone else may have written.
 *
 * It acquires under agent-operations, which sends no statement and so runs on every engine. The
 * decision event is written before acquisition and the outcome after, and a call whose record
 * cannot be written runs nothing. The page is fitted to the result cap at a table boundary, a
 * table comment is cut to its own bound first, and the column and index caps count what they leave
 * out instead of adding fake entries.
 */

export const InspectSchemaInputSchema = z.object({
  connection_id: z.string().min(1, "connection_id is required"),
  schema: z.string().optional(),
  table: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  include_columns: z.boolean().default(true),
  include_indexes: z.boolean().default(false),
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
  indexes: z.array(z.object({ name: z.string(), columns: z.array(z.string()), is_unique: z.boolean() })).optional(),
  indexes_omitted: z.number().int(),
});

const InspectSchemaOutputSchema = z.object({
  connection_id: z.string(),
  schema: z.string(),
  total_tables: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  tables: z.array(InspectedTableSchema),
});

export type InspectSchemaInput = z.infer<typeof InspectSchemaInputSchema>;
type InspectedTable = z.infer<typeof InspectedTableSchema>;

const INSPECT_SCHEMA_TITLE = "Inspect schema";
export const INSPECT_SCHEMA_DESCRIPTION = `List the tables of one connection with their columns and, on request, their indexes. Works on every engine. Pages with limit and offset; has_more and next_offset say when more tables exist. ${MCP_UNTRUSTED_NOTICE}`;

const MAX_COLUMNS = 50;
const MAX_INDEXES = 25;
const SCHEMA_NOT_FOUND_TEXT =
  "This connection has no schema of that name. Call inspect_schema without schema to read the default one.";
const FIRST_TABLE_OVER_CAP_TEXT =
  "The first table on this page is larger than the 32 KiB result limit on its own. Call inspect_schema again for it with limit 1 and include_columns and include_indexes set to false.";
const FIRST_TABLE_OVER_CAP_BARE_TEXT =
  "The first table on this page does not fit the 32 KiB result limit even without its columns and indexes, so it cannot be listed here.";

type ContainerChoice =
  | { readonly kind: "root" }
  | { readonly kind: "found"; readonly container: Container }
  | { readonly kind: "none" }
  | { readonly kind: "not-found" };

/**
 * The container the page is read from: at each level above the deepest the one the session is in,
 * or the first listed, and at the deepest the named schema, matched case-insensitively, or the
 * same default. An engine that declares no level is read at its root; a level that lists nothing
 * leaves nothing to read.
 */
async function chooseContainer(provider: DatabaseProvider, schema: string | undefined): Promise<ContainerChoice> {
  const depth = containerDepth(provider.getCapabilities());
  const wanted = schema?.toLowerCase();
  if (depth === 0) return wanted === undefined ? { kind: "root" } : { kind: "not-found" };
  let parent: readonly string[] | undefined;
  for (let level = 0; ; level += 1) {
    const containers = await provider.listContainers(parent);
    const deepest = level === depth - 1;
    const named = deepest && wanted !== undefined;
    const chosen = named
      ? containers.find((candidate) => candidate.name.toLowerCase() === wanted)
      : (containers.find((candidate) => candidate.isSessionDefault === true) ?? containers[0]);
    if (chosen === undefined) return named ? { kind: "not-found" } : { kind: "none" };
    if (deepest) return { kind: "found", container: chosen };
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
): Promise<InspectedTable> {
  const detail =
    args.include_columns || args.include_indexes ? await provider.describeObject(object.path, object.kind) : null;
  const rawComment = (detail === null ? undefined : commentOf(detail)) ?? commentOf(object);
  const comment = rawComment === undefined ? undefined : cutUtf8(rawComment, MCP_TABLE_COMMENT_CAP_BYTES);
  const columns = detail?.columns ?? [];
  const indexes = detail?.indexes ?? [];
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
          indexes: indexes
            .slice(0, MAX_INDEXES)
            .map((index) => ({ name: index.name, columns: [...index.columns], is_unique: index.unique })),
        }
      : {}),
    indexes_omitted: args.include_indexes ? Math.max(0, indexes.length - MAX_INDEXES) : 0,
  };
}

function pageResult(
  args: InspectSchemaInput,
  container: Container | null,
  total: number,
  tables: readonly InspectedTable[],
  cutByCap: boolean,
): ToolResult {
  const hasMore = cutByCap || args.offset + tables.length < total;
  return untrustedResult({
    connection_id: args.connection_id,
    schema: container?.name ?? "default",
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
): Promise<{ readonly result: ToolResult; readonly failure?: McpToolAuditReason }> {
  const choice = await chooseContainer(provider, args.schema);
  if (choice.kind === "not-found")
    return { result: ownWordsError(SCHEMA_NOT_FOUND_TEXT), failure: "mcp_schema_not_found" };
  const container = choice.kind === "found" ? choice.container : null;
  const objects = choice.kind === "none" ? [] : await listRelations(provider, container?.path ?? []);
  const wanted = args.table?.toLowerCase();
  const filtered = wanted === undefined ? objects : objects.filter((object) => object.name.toLowerCase() === wanted);
  const tables: InspectedTable[] = [];
  for (const object of filtered.slice(args.offset, args.offset + args.limit)) {
    if (signal.aborted) return { result: ownWordsError(MCP_CANCELLED_TEXT), failure: "mcp_cancelled" };
    const table = await inspectTable(provider, object, args);
    if (resultBytes(pageResult(args, container, filtered.length, [...tables, table], false)) > MCP_RESULT_CAP_BYTES) {
      if (tables.length > 0) return { result: pageResult(args, container, filtered.length, tables, true) };
      const bare = !args.include_columns && !args.include_indexes;
      return {
        result: ownWordsError(bare ? FIRST_TABLE_OVER_CAP_BARE_TEXT : FIRST_TABLE_OVER_CAP_TEXT),
        failure: "mcp_result_too_large",
      };
    }
    tables.push(table);
  }
  return { result: pageResult(args, container, filtered.length, tables, false) };
}

export async function inspectSchema(args: InspectSchemaInput, call: McpToolCall): Promise<ToolResult> {
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
  const unrecorded = recordOrRefuse(() => recordMcpDecision(resolved));
  if (unrecorded !== null) return unrecorded;

  const startedAt = Date.now();
  const finish = (result: ToolResult, failure?: McpToolAuditReason): ToolResult =>
    recordOrRefuse(() => recordMcpOutcome(resolved, Date.now() - startedAt, failure)) ?? result;

  try {
    const provider = await call.context.acquire(connection, "agent-operations");
    if (call.signal.aborted) return finish(ownWordsError(MCP_CANCELLED_TEXT), "mcp_cancelled");
    const { result, failure } = await readPage(provider, args, call.signal);
    return finish(result, failure);
  } catch (error) {
    return finish(engineError(MCP_ENGINE_ERROR_PREFIX, error), "mcp_execution_failed");
  }
}

export function registerInspectSchema(server: McpServer, context: McpConnectionContext): void {
  server.registerTool(
    "inspect_schema",
    {
      title: INSPECT_SCHEMA_TITLE,
      description: INSPECT_SCHEMA_DESCRIPTION,
      inputSchema: InspectSchemaInputSchema,
      outputSchema: InspectSchemaOutputSchema,
      annotations: MCP_READ_ONLY_ANNOTATIONS,
    },
    (args, ctx) => inspectSchema(args, { context, signal: ctx.mcpReq.signal }),
  );
}
