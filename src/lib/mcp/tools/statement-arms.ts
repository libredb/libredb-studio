import { z } from "zod";
import {
  AGENT_LANGUAGE_COPY,
  type AgentStatementArgument,
  type AgentStatementLanguageId,
} from "@/lib/agent/agent-manifest";
import { namedList } from "@/lib/agent/engine-support";
import { grantedAgentLanguage } from "@/lib/agent/granted-language";
import {
  AGENT_LANGUAGE_MCP_FACETS,
  type AgentLanguageMcpDeclaredFacet,
  type AgentLanguageMcpFacet,
  type AgentLanguageMcpTool,
  type AgentLanguageMcpWords,
} from "@/lib/agent/languages/mcp";
import { languageServer } from "@/lib/agent/languages/server";
import {
  type EngineId,
  type EngineRecord,
  servedEngines,
  serverCatalogBooting,
  serverCatalogBootUnfinished,
} from "@/lib/db/server-catalog";
import type { DatabaseType } from "@/lib/types";
import type { McpReach } from "../context";
import { checkReadOnlyStatement } from "../guards/execution-fence";
import { MCP_UNTRUSTED_NOTICE } from "../output";
import { DATABASE_ARGUMENT_DESCRIPTION } from "./database-choice";
import {
  fenceRefusalText,
  MCP_TIMEOUT_BOUNDS_MS,
  moreRowsThanPageableHint,
  ROW_OVER_CAP_TEXT,
  tooLargeTextsOf,
  type ReadOnlyRefusalKind,
} from "./read-query-limits";
import { mcpStatementEngines } from "./served-engines";

/**
 * The MCP statement tools, one arm per statement language, built from the languages' MCP facets.
 *
 * The record holds every statement language because the facet registry (`AGENT_LANGUAGE_MCP_FACETS` in
 * `src/lib/agent/languages/mcp.ts`) does, so a module language that joins agent mode does not compile until it decides
 * its MCP arm: a tool, or null while none exists; a language declared as data has the arm of the facet composed from
 * its data, or the null arm where its data states no MCP statement tool. This module names no language: the tool, its
 * words and its input field come from the language's own facet, and an arm's engines come from the one served-engine
 * resolver (`served-engines.ts`), so registration, the handler's gate, the description and `list_connections`'
 * `read_tool` all read one list.
 *
 * The arms are read through one accessor, `mcpStatementSurface`, after boot: it composes them, with the statement tools'
 * names and input schemas, from the served records (`servedEngines`), once per installed catalog, keyed by its Map, so a
 * process with no installed catalog composes the bundled set and a set composed before the catalog's install is never
 * served after it. Nothing is composed when this module loads. The composition holds zod schemas and closures, not
 * plain data, so it is not shared through a global the way the catalog's frozen data is: each module instance of the
 * process composes its own from the one installed catalog. A read while boot has begun and not yet installed the
 * catalog (`serverCatalogBooting`) is refused as `McpCompositionOrderError`, a defect of Studio's own composition order,
 * since the server serves no request before the install; a read after a boot that ended by an error before its install
 * (`serverCatalogBootUnfinished`) is refused as `McpCatalogBootUnfinishedError`, which names that boot, so no statement
 * tool is served from the bundled set. The arms' languages are still the bundled facets'.
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
  /**
   * Offset paging, one row past max_rows from the offset, applied by the read-only statement session through the
   * provider's own paging (clause C-85), or none: every row, the statement sent as written.
   */
  readonly paging: "offset" | "none";
  /**
   * The engines this tool serves, from the served-engine resolver, and their names as the texts say them, each its
   * record's display name.
   */
  readonly types: readonly EngineId[];
  readonly engines: string;
  /**
   * True where this language's engines hold no object inspect_schema lists, so inspect_schema refuses them by name and
   * points to this tool rather than answering an empty page. The language's facet declares it; `statement-arms.test.ts`
   * holds it to every served engine's own relation kinds.
   */
  readonly holdsNoTables: boolean;
  /**
   * True where the provider's warnings on this arm's answers are Studio's own sentences an answer must carry, so they
   * reach the client as `notes`; the language's facet declares it, and every other arm's answers carry no warning.
   */
  readonly answersWarnings: boolean;
  /**
   * True where a connection's database setting is a stored value on this language's engines, so list_connections leaves
   * it out; the language's facet declares it.
   */
  readonly withholdsDatabase: boolean;
  readonly description: string;
  /** The argument as the one statement text every later step reads, or null when it carries no statement. */
  canonicalize(raw: unknown): string | null;
  /** The defence-in-depth fence's refusal of `statement` on `type`, in this server's words, or null when admitted. */
  fence(statement: string, type: DatabaseType): string | null;
  /** The budget refusals in this language's and `type`'s words; a refusal left out answers with the shared SQL text. */
  tooLarge(statement: string, type: DatabaseType): TooLargeTexts;
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
const TIMEOUT_MS = z.number().int().min(MCP_TIMEOUT_BOUNDS_MS.min).max(MCP_TIMEOUT_BOUNDS_MS.max).default(10000);

/** The timeout of a tool whose reads need more than the shared least: refused below it, in the facet's words. */
function leastTimeoutMs(tool: string, least: { readonly ms: number; readonly why: string }) {
  return z
    .number()
    .int()
    .min(least.ms, `timeout_ms must be at least ${least.ms} for ${tool}: ${least.why}`)
    .max(MCP_TIMEOUT_BOUNDS_MS.max)
    .default(10000);
}
const SHARED_LIMITS =
  "Returns at most max_rows rows (default 100, at most 500) and at most 32 KiB; truncated and pagination.hasMore say when rows were cut";

const engineNames = (engines: readonly EngineRecord[]) => namedList(engines.map((engine) => engine.displayName));

/**
 * An arm's input: the connection, a `database` where the facet takes one, the statement under the language's own
 * argument, the row cap, an `offset` where the arm pages, and the timeout, from the facet's least where it declares
 * one, in the order tools/list shows them.
 */
function statementInputSchema(facet: AgentLanguageMcpFacet, argument: AgentStatementArgument): z.ZodObject {
  const shape = {
    connection_id: CONNECTION_ID,
    ...(facet.takesDatabase ? { database: DATABASE } : {}),
    [argument]: facet.statementInput,
    max_rows: MAX_ROWS,
    ...(facet.paging === "offset" ? { offset: OFFSET } : {}),
    timeout_ms: facet.leastTimeout === undefined ? TIMEOUT_MS : leastTimeoutMs(facet.tool, facet.leastTimeout),
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
  tooLarge: (_statement: string, type: DatabaseType) => tooLargeTextsOf(type),
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
        ? `More rows exist than the 32 KiB result limit holds, and ${shown} of them fitted; this tool does not page with offset. ${own.fewerFields} to fit more rows, and to ${own.readPast(shown, cut, statement)}`
        : `More rows exist than this result holds, and this tool does not page with offset. ${server.rowCapAdvice(statement, String(maxRows))} To ${own.readPast(shown, cut, statement)}`;
    },
  };
}

/**
 * The arm `facet` declares for `language` over `served`: its engines from the resolver, its description closed by the
 * notice.
 */
function statementArm(
  language: AgentStatementLanguageId,
  facet: AgentLanguageMcpDeclaredFacet,
  served: ReadonlyMap<string, EngineRecord>,
): McpStatementArm {
  const types = mcpStatementEngines(language, served);
  const engines = engineNames(types.map((id) => served.get(id) as EngineRecord));
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
    answersWarnings: "answersWarnings" in facet && facet.answersWarnings === true,
    withholdsDatabase: "withholdsDatabase" in facet && facet.withholdsDatabase === true,
    description: `${facet.describe({ engines, limits: SHARED_LIMITS })} ${MCP_UNTRUSTED_NOTICE}`,
    ...(facet.fence === "read-only-statement"
      ? READ_ONLY_STATEMENT_READER
      : languageAdmissionReader(language, facet.words)),
  });
}

/** The statement arms, keyed by statement language. */
type McpStatementArms = Readonly<Record<AgentStatementLanguageId, McpStatementArm | null>>;

/** The MCP statement tools composed from one set of served records. */
export interface McpStatementSurface {
  /** Each statement language's MCP arm, in the facet registry's order, which is the order tools/list answers in. */
  readonly arms: McpStatementArms;
  /** Every arm the record declares, serving or not, in record order. */
  readonly declared: readonly McpStatementArm[];
  /** Every statement tool's name, in record order: the values `list_connections`' `read_tool` may take. */
  readonly tools: readonly McpStatementTool[];
  /** Each statement tool's input schema by name, the entries the route's schema map spreads after the other tools. */
  readonly inputSchemas: Readonly<Record<McpStatementTool, z.ZodObject>>;
}

/**
 * A read of MCP's statement tools while boot has begun and not yet installed the server's engine catalog: a defect of
 * Studio's own composition order, never an answer composed from the bundled set.
 */
export class McpCompositionOrderError extends Error {
  constructor() {
    super(
      "MCP's statement tools were read while the server's engine catalog was still being composed at boot. Boot installs the catalog before the server serves any request, so this read is a defect of Studio's own composition order.",
    );
    this.name = "McpCompositionOrderError";
  }
}

/**
 * A read of MCP's statement tools after the server's engine catalog's boot ended by an error before it installed the
 * catalog: the boot's failure, never an answer composed from the bundled set.
 */
export class McpCatalogBootUnfinishedError extends Error {
  constructor() {
    super(
      "MCP's statement tools were read after the server's engine catalog's boot began and did not finish: the boot ended by an error before it installed the catalog, so no statement tool is served.",
    );
    this.name = "McpCatalogBootUnfinishedError";
  }
}

/** The statement tools composed from `served`. */
function composeStatementSurface(served: ReadonlyMap<string, EngineRecord>): McpStatementSurface {
  const arms = Object.freeze(
    Object.fromEntries(
      (
        Object.entries(AGENT_LANGUAGE_MCP_FACETS) as [AgentStatementLanguageId, AgentLanguageMcpDeclaredFacet | null][]
      ).map(([language, facet]) => [language, facet === null ? null : statementArm(language, facet, served)]),
    ) as Record<AgentStatementLanguageId, McpStatementArm | null>,
  );
  const declared = Object.freeze(Object.values(arms).filter((arm): arm is McpStatementArm => arm !== null));
  return Object.freeze({
    arms,
    declared,
    tools: Object.freeze(declared.map((arm) => arm.tool)),
    inputSchemas: Object.freeze(
      Object.fromEntries(declared.map((arm) => [arm.tool, arm.inputSchema])) as Record<McpStatementTool, z.ZodObject>,
    ),
  });
}

/** Each composition of this module instance, by the Map of served records it was composed from. */
const COMPOSED = new WeakMap<ReadonlyMap<string, EngineRecord>, McpStatementSurface>();

/**
 * MCP's statement tools as the served records compose them: the installed catalog's, or the bundled set with nothing
 * installed, composed once per catalog.
 *
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function mcpStatementSurface(): McpStatementSurface {
  if (serverCatalogBootUnfinished()) throw new McpCatalogBootUnfinishedError();
  if (serverCatalogBooting()) throw new McpCompositionOrderError();
  const served = servedEngines();
  let surface = COMPOSED.get(served);
  if (surface === undefined) {
    surface = composeStatementSurface(served);
    COMPOSED.set(served, surface);
  }
  return surface;
}

/**
 * The arm whose tool is `tool`, or a named error when no language declares that tool.
 *
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function mcpStatementArm(tool: McpStatementTool): McpStatementArm {
  const arm = mcpStatementSurface().declared.find((declared) => declared.tool === tool);
  if (arm === undefined) throw new Error(`no MCP statement arm for ${tool}`);
  return arm;
}

/**
 * The arms that serve at least one engine, in record order: the statement tools this build registers. An arm whose
 * served set is empty, as one is while its engines' grants of `mcp.statementRead` are false, is never listed. `arms` is
 * the record, and a test passes one of its own.
 *
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function servingStatementArms(arms: McpStatementArms = mcpStatementSurface().arms): readonly McpStatementArm[] {
  return Object.values(arms).filter((arm): arm is McpStatementArm => arm !== null && arm.types.length > 0);
}

/**
 * The serving arms that serve an engine in `reached`, in record order: the statement tools one token's tools/list
 * holds. A registry read only, since each arm's `types` already come from the served-engine resolver.
 *
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function listedStatementArms(
  reached: McpReach,
  arms: McpStatementArms = mcpStatementSurface().arms,
): readonly McpStatementArm[] {
  return servingStatementArms(arms).filter((arm) => [...reached].some((type) => arm.types.some((id) => id === type)));
}

/**
 * The arm that serves `type`, or null where no statement tool serves it: the arm of the statement language `type`'s
 * engine record grants, where that arm's served set holds `type`.
 *
 * @throws {UnknownProviderError} When `type` names no engine the server knows (FND-1).
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
function servingArmFor(type: DatabaseType): McpStatementArm | null {
  const { arms } = mcpStatementSurface();
  const language = grantedAgentLanguage(type);
  const arm = language === null ? null : arms[language];
  return arm !== null && arm.types.some((id) => id === type) ? arm : null;
}

/**
 * The tool that runs a statement on `type`, or null where no statement tool serves it and inspect_schema is the read.
 *
 * @throws {UnknownProviderError} When `type` names no engine the server knows (FND-1).
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function mcpStatementToolFor(type: DatabaseType): McpStatementTool | null {
  return servingArmFor(type)?.tool ?? null;
}

/**
 * Whether list_connections leaves `type`'s database setting out of a connection's row: true where the arm of the
 * statement language its engine record grants, serving or not, says that setting is a stored value.
 *
 * @throws {UnknownProviderError} When `type` names no engine the server knows (FND-1).
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function mcpWithholdsDatabase(type: DatabaseType): boolean {
  const { arms } = mcpStatementSurface();
  const language = grantedAgentLanguage(type);
  return language !== null && arms[language]?.withholdsDatabase === true;
}

/**
 * The statement tool inspect_schema sends `type` to, when the arm that serves it holds no table, or null where
 * inspect_schema reads it.
 *
 * @throws {UnknownProviderError} When `type` names no engine the server knows (FND-1).
 * @throws {ProviderUnavailableError} When every package naming the engine was refused at boot.
 * @throws {McpCompositionOrderError} While boot has begun and not yet installed the server's engine catalog.
 * @throws {McpCatalogBootUnfinishedError} After a boot that ended by an error before it installed the server's engine
 *   catalog.
 */
export function mcpTablelessReadTool(type: DatabaseType): McpStatementTool | null {
  const arm = servingArmFor(type);
  return arm?.holdsNoTables === true ? arm.tool : null;
}
