import { z } from "zod";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_STATEMENT_LANGUAGE,
  type AgentStatementArgument,
  type AgentStatementLanguageId,
} from "@/lib/agent/agent-manifest";
import { namedList } from "@/lib/agent/engine-support";
import {
  AGENT_LANGUAGE_MCP_FACETS,
  type AgentLanguageMcpDeclaredFacet,
  type AgentLanguageMcpFacet,
  type AgentLanguageMcpTool,
  type AgentLanguageMcpWords,
} from "@/lib/agent/languages/mcp";
import { languageServer } from "@/lib/agent/languages/server";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";
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
 * The MCP statement tools, one arm per statement language, built from the languages' MCP facets.
 *
 * The record is total over `AgentStatementLanguageId` because the facet registry (`AGENT_LANGUAGE_MCP_FACETS` in
 * `src/lib/agent/languages/mcp.ts`) is, so a language that joins agent mode does not compile until it decides its MCP
 * arm: a tool, or null while none exists. This module names no language: the tool, its words and its input field come
 * from the language's own facet, and an arm's engines come from the one served-engine resolver (`served-engines.ts`),
 * so registration, the handler's gate, the description and `list_connections`' `read_tool` all read one list.
 *
 * An arm whose facet pages with offset keeps `checkReadOnlyStatement` as its fence and the shared refusal texts, so a
 * SQL client sees no change. Every other arm reads its argument with the agent's own `canonicalize` and fences it with
 * the agent's own `admit`, both from `languageServer(language)`, so an MCP client is refused the commands an agent run
 * is refused with the same sentence; it takes no offset, and its row refusals carry the language's own `rowCapAdvice`.
 * The fence is defence in depth in every arm: the boundary is the agent read-only acquisition and the provider's
 * `queryReadOnly` (`run-statement.ts`).
 */

/** The statement tools' names, from the facets: each is an audit action of its own. */
export type McpStatementTool = AgentLanguageMcpTool;

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
  /**
   * True where this language's engines hold no object inspect_schema lists, so inspect_schema refuses them by name and
   * points to this tool rather than answering an empty page. The language's facet declares it; `statement-arms.test.ts`
   * holds it to every served engine's own relation kinds.
   */
  readonly holdsNoTables: boolean;
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
const OFFSET = z.number().int().min(0).default(0);
const TIMEOUT_MS = z.number().int().min(500).max(30000).default(10000);
const SHARED_LIMITS =
  "Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut";

const engineNames = (types: readonly DatabaseType[]) => namedList(types.map((type) => getDBConfig(type).label));

/**
 * An arm's input: the connection, a `database` where the facet takes one, the statement under the language's own
 * argument, the row cap, an `offset` where the arm pages, and the timeout, in the order tools/list shows them.
 */
function statementInputSchema(facet: AgentLanguageMcpFacet, argument: AgentStatementArgument): z.ZodObject {
  const shape = {
    connection_id: CONNECTION_ID,
    ...(facet.takesDatabase ? { database: DATABASE } : {}),
    [argument]: facet.statementInput,
    max_rows: MAX_ROWS,
    ...(facet.paging === "offset" ? { offset: OFFSET } : {}),
    timeout_ms: TIMEOUT_MS,
  };
  return facet.strictInput ? z.strictObject(shape) : z.object(shape);
}

/** How an arm under MCP's own read-only statement fence reads, fences and answers: the shared texts. */
const READ_ONLY_STATEMENT_READER = {
  canonicalize: (raw: unknown) => (typeof raw === "string" ? raw : null),
  fence(statement: string, type: DatabaseType) {
    const violation = checkReadOnlyStatement(statement);
    return violation === null ? null : fenceRefusalText(violation, type);
  },
  tooLarge: () => ({}),
  rowOverCap: ROW_OVER_CAP_TEXT,
  moreRows: (_statement: string, type: DatabaseType) => moreRowsThanPageableHint(type),
} satisfies Pick<McpStatementArm, "canonicalize" | "fence" | "tooLarge" | "rowOverCap" | "moreRows">;

/** How an arm fenced by its language's own admission reads, fences and answers: the agent's reader, in its words. */
function languageAdmissionReader(
  language: AgentStatementLanguageId,
  own: AgentLanguageMcpWords,
): Pick<McpStatementArm, "canonicalize" | "fence" | "tooLarge" | "rowOverCap" | "moreRows"> {
  const server = languageServer(language);
  return {
    canonicalize: server.canonicalize,
    fence(statement: string) {
      const refusal = server.admit?.(statement) ?? null;
      return refusal === null
        ? null
        : `The ${AGENT_LANGUAGE_COPY[language].noun} was refused before it reached ${own.reached} (${refusal.code}). ${refusal.message}`;
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
  };
}

/** The arm `facet` declares for `language`: its engines from the resolver, its description closed by the notice. */
function statementArm(language: AgentStatementLanguageId, facet: AgentLanguageMcpDeclaredFacet): McpStatementArm {
  const types = mcpStatementEngines(language);
  const engines = engineNames(types);
  const argument = AGENT_LANGUAGE_COPY[language].argument;
  return Object.freeze({
    language,
    tool: facet.tool,
    title: facet.title,
    argument,
    inputSchema: statementInputSchema(facet, argument),
    paging: facet.paging,
    types,
    engines,
    holdsNoTables: facet.holdsNoTables,
    description: `${facet.describe({ engines, limits: SHARED_LIMITS })} ${MCP_UNTRUSTED_NOTICE}`,
    ...(facet.fence === "read-only-statement"
      ? READ_ONLY_STATEMENT_READER
      : languageAdmissionReader(language, facet.words)),
  });
}

/** Each statement language's MCP arm, in the facet registry's order, which is the order tools/list answers in. */
export const MCP_STATEMENT_ARMS: Readonly<Record<AgentStatementLanguageId, McpStatementArm | null>> = Object.freeze(
  Object.fromEntries(
    (
      Object.entries(AGENT_LANGUAGE_MCP_FACETS) as [AgentStatementLanguageId, AgentLanguageMcpDeclaredFacet | null][]
    ).map(([language, facet]) => [language, facet === null ? null : statementArm(language, facet)]),
  ) as Record<AgentStatementLanguageId, McpStatementArm | null>,
);

/** Every arm the record declares, serving or not, in record order. */
const DECLARED_ARMS: readonly McpStatementArm[] = Object.values(MCP_STATEMENT_ARMS).filter(
  (arm): arm is McpStatementArm => arm !== null,
);

/** Every statement tool's name, in record order: the values `list_connections`' `read_tool` may take. */
export const MCP_STATEMENT_TOOLS: readonly McpStatementTool[] = Object.freeze(DECLARED_ARMS.map((arm) => arm.tool));

/** Each statement tool's input schema by name, the entries the route's schema map spreads after the other tools. */
export const MCP_STATEMENT_INPUT_SCHEMAS: Readonly<Record<McpStatementTool, z.ZodObject>> = Object.freeze(
  Object.fromEntries(DECLARED_ARMS.map((arm) => [arm.tool, arm.inputSchema])) as Record<McpStatementTool, z.ZodObject>,
);

/** The arm whose tool is `tool`, or a named error when no language declares that tool. */
export function mcpStatementArm(tool: McpStatementTool): McpStatementArm {
  const arm = DECLARED_ARMS.find((declared) => declared.tool === tool);
  if (arm === undefined) throw new Error(`no MCP statement arm for ${tool}`);
  return arm;
}

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

/** The arm that serves `type`, or null where no statement tool serves it. */
function servingArmFor(type: DatabaseType): McpStatementArm | null {
  const language = AGENT_STATEMENT_LANGUAGE[type];
  const arm = language === null ? null : MCP_STATEMENT_ARMS[language];
  return arm !== null && arm.types.includes(type) ? arm : null;
}

/** The tool that runs a statement on `type`, or null where no statement tool serves it and inspect_schema is the read. */
export function mcpStatementToolFor(type: DatabaseType): McpStatementTool | null {
  return servingArmFor(type)?.tool ?? null;
}

/**
 * The statement tool inspect_schema sends `type` to, when the arm that serves it holds no table, or null where
 * inspect_schema reads it.
 */
export function mcpTablelessReadTool(type: DatabaseType): McpStatementTool | null {
  const arm = servingArmFor(type);
  return arm?.holdsNoTables === true ? arm.tool : null;
}
