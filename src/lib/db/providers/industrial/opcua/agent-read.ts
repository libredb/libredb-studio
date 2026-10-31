/**
 * What an agent's OPC UA read sends and answers: each read of the reader's table (`agent-statement.ts`) run over one
 * session opened for it alone, through a client that holds the read services and counts them, its values rendered as
 * the console renders them with their engineering units beside them, and the wording of a failure by its category.
 *
 * VALUES ARE ANSWERED. A process value is the server's own reading, so the agent reads it, rendered as the console
 * renders it (`valueCell` in `objects.ts`), and every value carries its node's engineering units and EU range, or
 * "no units published" (`agent-units.ts`). The result reaches the model inside the untrusted-content fence like every
 * other result.
 *
 * WHAT IS WITHHELD. Before every read, on the read's own session, the withheld set is read (`withheldNodes` in
 * `agent-withheld.ts`): the standard roots and everything the server answers beneath them. A value read answers a node
 * inside it as a row typed `Withheld`, never sent, with the reason as a warning; a history read or a browse of one is
 * refused; a browse steps over every child inside it, warning its kind, so `Server` and `ServerCapabilities` stay
 * browsable.
 *
 * ONE SESSION PER READ, closed on every path out, so nothing of one read (a continuation point, a cached limit, the
 * withheld set) reaches the next. Budgets refuse rather than cut: a value read naming more nodes than the row budget is
 * refused before the session; a browse or a history read holding more rows than it is refused as soon as the answer
 * passes it, its continuation point released; a history read the server cut short is refused; and a read past the
 * request bound or the time budget is refused, counting the withheld check and the units lookup like any other request,
 * so no value is ever answered without its units. A failure is worded by its category and the server's status name,
 * never by the library's or the server's own text, which can echo a node path or a value.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { OpcuaAgentPlan } from "./agent-statement";
import { readUnits, type OpcuaUnits } from "./agent-units";
import {
  canonicalNodeId,
  OpcuaWithheldWalkError,
  type OpcuaWithheldNode,
  type OpcuaWithheldSet,
  withheldNodes,
  withheldReason,
} from "./agent-withheld";
import type { OpcuaDataValue, OpcuaNodeId, OpcuaReadOnlyClient, OpcuaReference, OpcuaServerLimits } from "./client";
import { OPCUA_TYPE } from "./constants";
import { messageOf, statusSentence } from "./errors";
import { historyEndSentence, readHistory } from "./history";
import { browseChunkSize, chunked, readChunkSize } from "./limits";
import { historyRows, valueRows } from "./results";

/**
 * The most requests one agent read sends to the server, counting the withheld check, the reads themselves and the
 * units lookup. Measured on OPC PLC 2.15.10 (`tests/fixtures/opcua/2.15.10/agent-boundary/boundary.json`): the
 * withheld check took 10 Browse requests for an anonymous session and 15 for an administrator, who sees the session
 * objects, a value read of an AnalogItemType variable and a plain one 1 Read, 1 Browse and 1 Read of the two properties,
 * and a history read 100 values a page; 100 leaves a read of the row budget room, and bounds what one read can ask of
 * a plant server whatever it answers.
 */
export const OPCUA_AGENT_MAX_REQUESTS = 100;

/** The columns a value read and a history read answer: the console's six, and the units beside each value. */
export const OPCUA_AGENT_VALUE_COLUMNS = Object.freeze([
  "nodeId",
  "value",
  "shape",
  "statusCode",
  "sourceTimestamp",
  "serverTimestamp",
  "units",
  "unitId",
  "unitNamespace",
  "euRange",
] as const);

/** The columns a browse answers: one row per reference of the node browsed. */
const OPCUA_AGENT_BROWSE_COLUMNS = Object.freeze([
  "nodeId",
  "browseName",
  "displayName",
  "nodeClass",
  "referenceTypeId",
] as const);

/** The status a row of a withheld node carries in place of a server's status, since nothing was sent for it. */
export const OPCUA_WITHHELD_STATUS = "Withheld";

const NO_SERVER_TEXT = "Studio quotes nothing of the library's or the server's own text.";

export const OPCUA_AGENT_FAILURE_SENTENCES = {
  /** Studio's time budget ran out. */
  time: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read did not finish within ${ms}ms, Studio's time budget for one read, so it was refused rather than answered in part; ask for fewer nodes or a narrower window.`,
  /** The read needed more requests than one read may send. */
  requests: `Read-only execution exceeded the request bound: an agent read on OPC UA sends at most ${OPCUA_AGENT_MAX_REQUESTS} requests to the server, counting the check of its withheld nodes and the lookup of engineering units, and this one needed more, so it was refused rather than answered in part or without its units; ask for fewer nodes or a narrower window.`,
  /** A browse holding more children than the row budget. */
  browseOverRows: (rows: number, allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the node holds at least ${rows} children and the row budget is ${allowed}, so the browse is refused rather than cut; browse a node further down.`,
  /** A history read holding more values than the row budget. */
  historyOverRows: (rows: number, allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the window holds at least ${rows} values and the row budget is ${allowed}, so the history read is refused rather than cut; give it a narrower window or a limit of at most ${allowed}.`,
  /** A history read the server ended before the window or the limit did. */
  historyIncomplete: (why: string): string =>
    `The history read was not finished, so it is refused rather than answered in part: ${why}`,
  /** The server refused a service with a status code. */
  status: (code: string): string => `${statusSentence(code)} ${NO_SERVER_TEXT}`,
  /** The session could not be opened. */
  session: `The read could not open its session with the server, so nothing was read. ${NO_SERVER_TEXT} The connection test in the editor names the cause.`,
  /** The connection failed during the read with no status code. */
  transport: `The connection to the server failed during the read, so it was not answered. ${NO_SERVER_TEXT}`,
} as const;

const F = OPCUA_AGENT_FAILURE_SENTENCES;

/** A refusal or failure worded by Studio. The class tells a caller that nothing in it came from the server's text. */
export class OpcuaAgentError extends QueryError {
  constructor(message: string) {
    super(message, OPCUA_TYPE);
    this.name = "OpcuaAgentError";
    Object.setPrototypeOf(this, OpcuaAgentError.prototype);
  }
}

const fail = (sentence: string): never => {
  throw new OpcuaAgentError(sentence);
};

/** The status code a library or provider message reports, or undefined. Only the name is kept, never the text. */
const statusCodeIn = (message: string): string | undefined => /\b(Bad[A-Za-z]+)\b/.exec(message)?.[1];

/**
 * Any failure of an agent read, as Studio's own sentence: its own refusals as they are, a status code by the error
 * table's sentence for that code, and anything else by whether the session had opened. Never the error's own text.
 */
export function agentFailure(error: unknown, sessionOpened: boolean): OpcuaAgentError {
  if (error instanceof OpcuaAgentError) return error;
  if (error instanceof OpcuaWithheldWalkError) return new OpcuaAgentError(error.message);
  const code = statusCodeIn(messageOf(error));
  if (code !== undefined) return new OpcuaAgentError(F.status(code));
  if (!sessionOpened || error instanceof DatabaseConfigError) return new OpcuaAgentError(F.session);
  return new OpcuaAgentError(F.transport);
}

/** The services an agent read may call: the read services of the seam, and nothing else. */
export type OpcuaAgentClient = Pick<
  OpcuaReadOnlyClient,
  | "limits"
  | "browse"
  | "browseNext"
  | "releaseBrowseContinuationPoints"
  | "read"
  | "historyRead"
  | "historyReadNext"
  | "releaseHistoryContinuationPoint"
>;

/**
 * The agent's client over one session: the eight read members of the seam a read needs, each counted against the
 * request bound and checked against the deadline before it is sent. GetEndpoints and CloseSession are the provider's,
 * not the read's, and are not in it.
 */
export function boundedAgentClient(
  session: OpcuaReadOnlyClient,
  bounds: { readonly deadlineAt: number; readonly timeoutMs: number; readonly now: () => number },
): OpcuaAgentClient & { readonly requests: () => number } {
  let sent = 0;
  const charge = (): void => {
    if (bounds.now() >= bounds.deadlineAt) fail(F.time(bounds.timeoutMs));
    if (sent >= OPCUA_AGENT_MAX_REQUESTS) fail(F.requests);
    sent += 1;
  };
  return Object.freeze({
    requests: () => sent,
    limits: async () => {
      charge();
      return session.limits();
    },
    browse: async (nodeIds: readonly OpcuaNodeId[]) => {
      charge();
      return session.browse(nodeIds);
    },
    browseNext: async (points: readonly Uint8Array[]) => {
      charge();
      return session.browseNext(points);
    },
    releaseBrowseContinuationPoints: async (points: readonly Uint8Array[]) => {
      charge();
      return session.releaseBrowseContinuationPoints(points);
    },
    read: async (nodeIds: readonly OpcuaNodeId[]) => {
      charge();
      return session.read(nodeIds);
    },
    historyRead: async (options: Parameters<OpcuaReadOnlyClient["historyRead"]>[0]) => {
      charge();
      return session.historyRead(options);
    },
    historyReadNext: async (options: Parameters<OpcuaReadOnlyClient["historyReadNext"]>[0]) => {
      charge();
      return session.historyReadNext(options);
    },
    releaseHistoryContinuationPoint: async (
      options: Parameters<OpcuaReadOnlyClient["releaseHistoryContinuationPoint"]>[0],
    ) => {
      charge();
      return session.releaseHistoryContinuationPoint(options);
    },
  });
}

/** What one agent read answers before the row and byte budgets are applied to it. */
export interface OpcuaAgentAnswer {
  readonly fields: readonly string[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

/** The refusal of a value read naming more nodes than the row budget, made before a session is opened, or undefined. */
export function preflight(plan: OpcuaAgentPlan, budget: ReadOnlyStatementBudget): string | undefined {
  return plan.kind === "read" && plan.nodeIds.length > budget.maxResultRows
    ? rowBudgetSentence(plan.nodeIds.length, budget.maxResultRows)
    : undefined;
}

const withheldIn = (set: OpcuaWithheldSet, nodeId: OpcuaNodeId): OpcuaWithheldNode | undefined =>
  set.get(canonicalNodeId(nodeId) ?? nodeId);

/**
 * Whether a node's row carries a value that needs its units: a Variable or a VariableType, and any node whose Read
 * answered a value even though its NodeClass attribute was not answered, so no value is ever answered without them.
 */
const isValueBearing = (value: OpcuaDataValue | undefined): boolean =>
  value?.nodeClass === "Variable" ||
  value?.nodeClass === "VariableType" ||
  (value?.nodeClass === undefined && value?.value !== null && value?.value !== undefined);

const unitColumns = (units: OpcuaUnits | undefined): Record<string, unknown> => ({
  units: units?.units ?? null,
  unitId: units?.unitId ?? null,
  unitNamespace: units?.unitNamespace ?? null,
  euRange: units?.euRange ?? null,
});

/** Each withheld kind's reason, once, in the order met. */
function reasons(kinds: readonly OpcuaWithheldNode[]): string[] {
  return [...new Set(kinds)].map(withheldReason);
}

async function readValues(
  client: OpcuaAgentClient,
  nodeIds: readonly OpcuaNodeId[],
  withheld: OpcuaWithheldSet,
  limits: OpcuaServerLimits,
): Promise<OpcuaAgentAnswer> {
  const met: OpcuaWithheldNode[] = [];
  const sent = [...new Set(nodeIds.filter((nodeId) => withheldIn(withheld, nodeId) === undefined))];
  const values: OpcuaDataValue[] = [];
  for (const batch of chunked(sent, readChunkSize(limits))) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
    values.push(...(await client.read(batch)));
  }
  const byId = new Map(values.map((value) => [value.nodeId, value]));
  const variables = sent.filter((nodeId) => isValueBearing(byId.get(nodeId)));
  const units = await readUnits(client, variables, withheld, {
    browse: browseChunkSize(limits),
    read: readChunkSize(limits),
  });
  const consoleRows = new Map(valueRows(sent, values).rows.map((row) => [row.nodeId as OpcuaNodeId, row]));
  const rows = nodeIds.map((nodeId) => {
    const kind = withheldIn(withheld, nodeId);
    if (kind !== undefined) {
      met.push(kind);
      return {
        nodeId,
        value: null,
        shape: null,
        statusCode: OPCUA_WITHHELD_STATUS,
        sourceTimestamp: null,
        serverTimestamp: null,
        ...unitColumns(undefined),
      };
    }
    return { ...consoleRows.get(nodeId), ...unitColumns(units.get(nodeId)) };
  });
  return { fields: [...OPCUA_AGENT_VALUE_COLUMNS], rows, warnings: reasons(met) };
}

async function readHistoryOf(
  client: OpcuaAgentClient,
  plan: Extract<OpcuaAgentPlan, { kind: "history" }>,
  withheld: OpcuaWithheldSet,
  budget: ReadOnlyStatementBudget,
): Promise<OpcuaAgentAnswer> {
  const kind = withheldIn(withheld, plan.nodeId);
  if (kind !== undefined) fail(withheldReason(kind));
  // A limit the request wrote within the budget is the request's own; otherwise one value past the budget is read, so
  // a window holding exactly the budget is answered and one more value is refused.
  const own = plan.limitStated && plan.limit <= budget.maxResultRows;
  const cap = own ? plan.limit : budget.maxResultRows + 1;
  const history = await readHistory(client, {
    nodeId: plan.nodeId,
    ...(plan.start === undefined ? {} : { start: plan.start }),
    ...(plan.end === undefined ? {} : { end: plan.end }),
    limit: cap,
  });
  if (history.values.length > budget.maxResultRows)
    fail(F.historyOverRows(history.values.length, budget.maxResultRows));
  const sentence = historyEndSentence(history.end, history.values.length, history.statusCode);
  // A cap is answered only when it is the request's own limit. Studio's cap is one value past the budget, and the
  // console's own cap of OPCUA_HISTORY_VALUE_CAP values stops a read first when the budget is that large, so a cap
  // that is not the request's own is a read cut short and is refused.
  const answered =
    history.end === "exhausted" ||
    (history.end === "value-cap" && own) ||
    (history.end === "refused" && history.values.length === 0);
  if (!answered) fail(F.historyIncomplete(sentence));
  const units = (await readUnits(client, [plan.nodeId], withheld)).get(plan.nodeId);
  // oxlint-disable-next-line no-map-spread -- each row is a new object, the console's row with the units beside it.
  const rows = historyRows(plan.nodeId, history.values).rows.map((row) => ({ ...row, ...unitColumns(units) }));
  return { fields: [...OPCUA_AGENT_VALUE_COLUMNS], rows, warnings: [sentence] };
}

async function browseOf(
  client: OpcuaAgentClient,
  nodeId: OpcuaNodeId,
  withheld: OpcuaWithheldSet,
  budget: ReadOnlyStatementBudget,
): Promise<OpcuaAgentAnswer> {
  const kind = withheldIn(withheld, nodeId);
  if (kind !== undefined) fail(withheldReason(kind));
  const [first] = await client.browse([nodeId]);
  if (first === undefined) return fail(F.transport);
  const ok = (status: string): boolean => status.startsWith("Good") || status.startsWith("Uncertain");
  if (!ok(first.statusCode)) fail(F.status(first.statusCode));
  const references: OpcuaReference[] = [...first.references];
  let point = first.continuationPoint;
  while (point !== undefined) {
    if (references.length > budget.maxResultRows) {
      // oxlint-disable-next-line no-await-in-loop -- the release follows the answer that handed back the point, and ends the loop.
      await client.releaseBrowseContinuationPoints([point]);
      fail(F.browseOverRows(references.length, budget.maxResultRows));
    }
    // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it.
    const [next] = await client.browseNext([point as Uint8Array]);
    if (next === undefined) return fail(F.transport);
    if (!ok(next.statusCode)) fail(F.status(next.statusCode));
    references.push(...next.references);
    point = next.continuationPoint;
  }
  const met: OpcuaWithheldNode[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const reference of references) {
    const inside = withheldIn(withheld, reference.nodeId);
    if (inside !== undefined) {
      met.push(inside);
      continue;
    }
    rows.push({
      nodeId: canonicalNodeId(reference.nodeId) ?? reference.nodeId,
      browseName: reference.browseName,
      displayName: reference.displayName,
      nodeClass: reference.nodeClass,
      referenceTypeId: canonicalNodeId(reference.referenceTypeId) ?? reference.referenceTypeId,
    });
  }
  if (rows.length > budget.maxResultRows) fail(F.browseOverRows(rows.length, budget.maxResultRows));
  return { fields: [...OPCUA_AGENT_BROWSE_COLUMNS], rows, warnings: reasons(met) };
}

/** The answer of one admitted read over one session's agent client, the withheld set read first. */
export async function runOpcuaAgentRead(
  client: OpcuaAgentClient,
  plan: OpcuaAgentPlan,
  budget: ReadOnlyStatementBudget,
): Promise<OpcuaAgentAnswer> {
  const limits = await client.limits();
  const withheld = await withheldNodes(client, browseChunkSize(limits));
  switch (plan.kind) {
    case "read":
      return readValues(client, plan.nodeIds, withheld, limits);
    case "history":
      return readHistoryOf(client, plan, withheld, budget);
    case "browse":
      return browseOf(client, plan.nodeId, withheld, budget);
  }
}

/** The answer of one read as a result: refused past the row or byte budget rather than cut. */
export function opcuaAgentResult(
  answer: OpcuaAgentAnswer,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const rows = answer.rows.map((row) => ({ ...row }));
  if (rows.length > budget.maxResultRows) fail(rowBudgetSentence(rows.length, budget.maxResultRows));
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) fail(byteBudgetSentence(bytes, budget.maxResultBytes));
  const warnings: QueryWarning[] = answer.warnings.map((message) => ({ message }));
  return {
    fields: [...answer.fields],
    rows,
    rowCount: rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
