import { z } from "zod";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_STATEMENT_LANGUAGE,
  type AgentStatementArgument,
  type AgentStatementLanguageId,
} from "@/lib/agent/agent-manifest";
import { namedList } from "@/lib/agent/engine-support";
import { languageServer } from "@/lib/agent/languages/server";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
import type { McpToolAction } from "../audit";
import { checkReadOnlyStatement } from "../guards/execution-fence";
import { MCP_UNTRUSTED_NOTICE } from "../output";
import { DATABASE_ARGUMENT_DESCRIPTION } from "./database-choice";
import {
  fenceRefusalText,
  moreRowsThanPageableHint,
  ROW_OVER_CAP_TEXT,
  type ReadOnlyRefusalKind,
} from "./read-query-limits";
import { mcpStatementEngines } from "./served-engines";

/**
 * The MCP statement tools, one arm per statement language (all-providers design 6).
 *
 * The record is total over `AgentStatementLanguageId`, as `SERVER_PACKS` in `src/lib/agent/languages/server.ts` is, so
 * a language that joins agent mode does not compile until it decides its MCP arm: a tool, or null while none exists.
 * It is keyed by language only and names no engine; an arm's engines come from the one served-engine resolver
 * (`served-engines.ts`), so registration, the handler's gate, the description and `list_connections`' `read_tool` all
 * read one list.
 *
 * The SQL arm keeps the name `run_read_query`, the `sql` argument, `checkReadOnlyStatement` as its fence and offset
 * paging, so a SQL client sees no change. Every other arm reads its argument with the agent's own `canonicalize` and
 * fences it with the agent's own `admit`, both from `languageServer(language)`, so an MCP client is refused the
 * commands an agent run is refused with the same sentence; it takes no offset, and its row refusals carry the
 * language's own `rowCapAdvice`. The fence is defence in depth in every arm: the boundary is the agent read-only
 * acquisition and the provider's `queryReadOnly` (`run-statement.ts`).
 */

/** The statement tools' names: each is an audit action of its own. */
export type McpStatementTool = Extract<McpToolAction, "run_read_query" | "run_kubectl_read" | "run_mongo_command">;

/** The texts a refusal past one of the provider's budgets answers with, by refusal. */
export type TooLargeTexts = Partial<Record<Exclude<ReadOnlyRefusalKind, "time">, string>>;

export interface McpStatementArm {
  readonly language: AgentStatementLanguageId;
  readonly tool: McpStatementTool;
  readonly title: string;
  /** The input key the statement arrives in: the agent's own argument for the language. */
  readonly argument: AgentStatementArgument;
  readonly inputSchema: z.ZodObject;
  /** Offset paging through the provider's `prepareQuery`, or none: the statement is sent as written. */
  readonly paging: "offset" | "none";
  /** The engines this tool serves, from the served-engine resolver, and their names as the texts say them. */
  readonly types: readonly DatabaseType[];
  readonly engines: string;
  readonly description: string;
  /** The argument as the one statement text every later step reads, or null when it carries no statement. */
  canonicalize(raw: unknown): string | null;
  /** The defence-in-depth fence's refusal of `statement` on `type`, in this server's words, or null when admitted. */
  fence(statement: string, type: DatabaseType): string | null;
  /** The budget refusals in this language's words; a refusal left out answers with the shared SQL text. */
  tooLarge(statement: string): TooLargeTexts;
  /** The answer when even the first row does not fit the result cap. */
  readonly rowOverCap: string;
  /** The hint when more rows exist than the result holds and no next offset can be named. */
  moreRows(statement: string, type: DatabaseType, cut: MoreRowsCut): string;
}

/** Where a result that holds fewer rows than exist was cut: the rows asked for, the rows returned, and which cap cut. */
export interface MoreRowsCut {
  readonly maxRows: number;
  readonly shown: number;
  readonly cut: "max_rows" | "result_bytes";
}

const CONNECTION_ID = z.string().min(1, "connection_id is required");
const DATABASE = z.string().min(1).optional().describe(DATABASE_ARGUMENT_DESCRIPTION);
const MAX_ROWS = z.number().int().min(1).max(500).default(100);
const TIMEOUT_MS = z.number().int().min(500).max(30000).default(10000);
const SHARED_LIMITS =
  "Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut";

const engineNames = (types: readonly DatabaseType[]) => namedList(types.map((type) => getDBConfig(type).label));

export const RunReadQueryInputSchema = z.object({
  connection_id: CONNECTION_ID,
  database: DATABASE,
  sql: z.string().min(1, "SQL cannot be empty"),
  max_rows: MAX_ROWS,
  offset: z.number().int().min(0).default(0),
  timeout_ms: TIMEOUT_MS,
});

const SQL_TYPES = mcpStatementEngines("sql");
const SQL_ENGINES = engineNames(SQL_TYPES);

export const RUN_READ_QUERY_ARM: McpStatementArm = Object.freeze({
  language: "sql",
  tool: "run_read_query",
  title: "Run a read-only query",
  argument: AGENT_LANGUAGE_COPY.sql.argument,
  inputSchema: RunReadQueryInputSchema,
  paging: "offset",
  types: SQL_TYPES,
  engines: SQL_ENGINES,
  /** Names no statement form beyond SELECT, because the others differ by engine; the refusal names the engine's own. */
  description: `Run one read-only SQL statement on a connection. A SELECT (a WITH is fine) runs on every engine it serves; a refused statement's answer names what else that engine takes. Runs on ${SQL_ENGINES}; other engines refuse it, and list_connections' read_tool names the tool that reads each connection. ${SHARED_LIMITS}, and pagination.nextOffset is the offset of the next page when the query can be paged. ${MCP_UNTRUSTED_NOTICE}`,
  canonicalize: (raw: unknown) => (typeof raw === "string" ? raw : null),
  fence(statement: string, type: DatabaseType) {
    const violation = checkReadOnlyStatement(statement);
    return violation === null ? null : fenceRefusalText(violation, type);
  },
  tooLarge: () => ({}),
  rowOverCap: ROW_OVER_CAP_TEXT,
  moreRows: (_statement: string, type: DatabaseType) => moreRowsThanPageableHint(type),
});

/** What a non-SQL arm says in its own words: how to fit more rows, how to read past them, and the oversized row. */
interface NonSqlArmWords {
  readonly tool: McpStatementTool;
  readonly title: string;
  readonly inputSchema: z.ZodObject;
  readonly describe: (engines: string) => string;
  /** How a byte-cut result fits more rows, as the opening of a clause: "Project fewer fields". */
  readonly fewerFields: string;
  /** How to read past the rows a cut result returned, as the end of a sentence that starts "To ". */
  readonly readPast: (shown: number) => string;
  /** The answer when even the first row does not fit the result cap. */
  readonly rowOverCap: string;
}

/** The parts every arm whose statement is not SQL shares: its reader, its fence and its budget texts are the agent's. */
function nonSqlArm(language: Exclude<AgentStatementLanguageId, "sql">, own: NonSqlArmWords): McpStatementArm {
  const types = mcpStatementEngines(language);
  const engines = engineNames(types);
  const server = languageServer(language);
  return Object.freeze({
    language,
    tool: own.tool,
    title: own.title,
    argument: AGENT_LANGUAGE_COPY[language].argument,
    inputSchema: own.inputSchema,
    paging: "none",
    types,
    engines,
    description: own.describe(engines),
    canonicalize: server.canonicalize,
    fence(statement: string) {
      const refusal = server.admit?.(statement) ?? null;
      return refusal === null
        ? null
        : `The ${AGENT_LANGUAGE_COPY[language].noun} was refused before it reached the database (${refusal.code}). ${refusal.message}`;
    },
    tooLarge: (statement: string) => ({
      rows: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice(statement, "1000")}`,
      bytes:
        "The result is larger than 1 MiB, the most this server reads for one call. Narrow the read to fewer or smaller rows, and run it again.",
    }),
    rowOverCap: own.rowOverCap,
    // A byte cut is not answered with the row-cap advice: a statement already limited to max_rows would be told to set
    // that limit again and be cut again, so it names the rows that fitted and how to read past them.
    moreRows(statement: string, _type: DatabaseType, { maxRows, shown, cut }: MoreRowsCut) {
      return cut === "result_bytes"
        ? `More rows exist than the 32 KiB result limit holds, and ${shown} of them fitted; this tool does not page with offset. ${own.fewerFields} to fit more rows, and to ${own.readPast(shown)}`
        : `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(statement, String(maxRows))} To ${own.readPast(shown)}`;
    },
  });
}

/**
 * No `database` key: a Kubernetes connection names its namespace in the statement (`-n`, `-A`) and declares no
 * `catalogSessions`, so `providerInDatabase` would refuse every call that named one, as the agent's own kubectl tool
 * leaves it out. The statement's length is the admission's to refuse, in the sentence an agent run reads.
 */
export const RunKubectlReadInputSchema = z.strictObject({
  connection_id: CONNECTION_ID,
  statement: z.string().min(1, "statement cannot be empty"),
  max_rows: MAX_ROWS,
  timeout_ms: TIMEOUT_MS,
});

/**
 * The kubectl arm (B105): the agent's own reader, admission and `queryReadOnly`, so every answer is the machine
 * projection `machine-redaction.ts` masks, Secret names included, and never the editor's.
 */
export const RUN_KUBECTL_READ_ARM = nonSqlArm("kubectl", {
  tool: "run_kubectl_read",
  title: "Run a read-only kubectl read",
  inputSchema: RunKubectlReadInputSchema,
  describe: (engines) =>
    `Run one read-only kubectl read on a connection: one line, with or without the kubectl word, such as "get pods -n shop", "describe deployment/web -n shop", "logs pod/web -n shop --tail=50", "top pod -n shop", "events -n shop --types=Warning", "api-resources", "explain deployment.spec", "auth can-i list pods -n shop", "auth whoami" or "version". Writes, exec, port-forward, proxy, a watch (-w) and Studio's paging line are refused before the cluster is reached. The answer is masked as an agent read is: a Secret's name wherever it appears, Secret and ConfigMap values, env and header values, a container's command and args, and annotation values read <redacted>. Runs on ${engines}; other engines refuse it. ${SHARED_LIMITS}; this tool takes no offset, so narrow the read with -n, -l or --field-selector. ${MCP_UNTRUSTED_NOTICE}`,
  fewerFields: "Read fewer fields, without -o wide, -o yaml or -o json,",
  readPast: (shown) =>
    `read past the ${shown} rows returned, split the read into narrower ones, since a kubectl read is never paged.`,
  rowOverCap:
    "One row of this result is larger than the 32 KiB result limit. Read it in a shorter form, without -o yaml or -o json, and run it again.",
});

/**
 * No `database` key: a MongoDB connection reads the database it is bound to and declares no `catalogSessions`, so
 * `providerInDatabase` would refuse every call that named one, as the agent's own MongoDB tool leaves it out.
 */
export const RunMongoCommandInputSchema = z.strictObject({
  connection_id: CONNECTION_ID,
  command: z.record(z.string(), z.unknown()),
  max_rows: MAX_ROWS,
  timeout_ms: TIMEOUT_MS,
});

export const RUN_MONGO_COMMAND_ARM = nonSqlArm("mongo", {
  tool: "run_mongo_command",
  title: "Run a read-only MongoDB command",
  inputSchema: RunMongoCommandInputSchema,
  fewerFields: "Project fewer fields",
  readPast: (shown) => `read past the ${shown} rows returned, skip them with a find's "skip" or a $skip stage.`,
  rowOverCap:
    "One row of this result is larger than the 32 KiB result limit. Narrow the read to fewer or smaller fields, and run it again.",
  describe: (engines) =>
    `Run one read-only MongoDB command on a connection: a JSON command envelope with the keys its operation takes and no others. find takes "filter" and "options" ("projection", "sort", "skip", "limit"); findOne takes "filter" and "options" ("projection" only); aggregate takes "pipeline" only; count takes "filter"; distinct takes "field" and "filter". For example {"collection": "orders", "operation": "find", "filter": {"status": "paid"}}. Write the collection by its bare name, a date as {"$date": "2026-03-01T00:00:00Z"} and an ObjectId as {"$oid": "<24 hex digits>"}. Writes and the write stages of a pipeline ($out, $merge) are refused before the database is reached. Runs on ${engines}; other engines refuse it. ${SHARED_LIMITS}; this tool takes no offset, so page inside the command with a find's "skip" or a $skip stage. ${MCP_UNTRUSTED_NOTICE}`,
});

/** Each statement language's MCP arm. */
export const MCP_STATEMENT_ARMS: Readonly<Record<AgentStatementLanguageId, McpStatementArm | null>> = Object.freeze({
  sql: RUN_READ_QUERY_ARM,
  kubectl: RUN_KUBECTL_READ_ARM,
  mongo: RUN_MONGO_COMMAND_ARM,
} satisfies Record<AgentStatementLanguageId, McpStatementArm | null>);

/**
 * The arms that serve at least one engine, in record order: the statement tools this build registers. An arm whose
 * served set is empty, as one is while its engines' `MCP_STATEMENT_READ` rows are false, is never listed. `arms` is
 * the record, and a test passes one of its own.
 */
export function servingStatementArms(
  arms: Readonly<Record<AgentStatementLanguageId, McpStatementArm | null>> = MCP_STATEMENT_ARMS,
): readonly McpStatementArm[] {
  return Object.values(arms).filter((arm): arm is McpStatementArm => arm !== null && arm.types.length > 0);
}

/** The tool that runs a statement on `type`, or null where no statement tool serves it and inspect_schema is the read. */
export function mcpStatementToolFor(type: DatabaseType): McpStatementTool | null {
  const language = AGENT_STATEMENT_LANGUAGE[type];
  const arm = language === null ? null : MCP_STATEMENT_ARMS[language];
  return arm !== null && arm.types.includes(type) ? arm.tool : null;
}
