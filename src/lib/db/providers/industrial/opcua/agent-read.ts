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
 * ONLY BENEATH THE READ ROOTS. Before anything the request names is sent, on the read's own session, the server's
 * NamespaceArray is read and the set of nodes beneath the connection's read roots is proved by walking down from them
 * (`proveReadSet` in `agent-roots.ts`). Every node id is put in its key through that table, and an id outside the set
 * answers exactly as an id the server does not hold, decided by a set lookup with nothing sent for it: a value read
 * answers its row `BadNodeIdUnknown` with no value and no units, and a history read or a browse of one is refused with
 * the server's own sentence for that status. A browse of a member answers the references the walk kept, with no Browse
 * sent, and counts the ones that lead outside in one note; a browse of the Objects folder answers the roots. The walk's
 * requests depend only on the roots, the identity and the server, so an outside id and a missing one cost the same.
 *
 * ONE SESSION PER READ, closed on every path out, so nothing of one read (a continuation point, a cached limit, the
 * proved set) reaches the next. Budgets refuse rather than cut: a value read naming more nodes than the row budget is
 * refused before the session; a browse or a history read holding more rows than it is refused as soon as the answer
 * passes it; a history read the server cut short is refused; and a read past the request bound or the time budget is
 * refused, the units lookup counted like any other request, so no value is ever answered without its units. The walk
 * is counted apart, against its own bound. A failure is worded by its category and the server's status name, never by
 * the library's or the server's own text, which can echo a node path or a value.
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
import {
  answerTimeOutside,
  keyIn,
  namespace0Rows,
  OPCUA_LEAF_NOTE,
  OPCUA_OBJECTS_FOLDER_KEY,
  OPCUA_ROOTS_WARNING,
  OpcuaReadRootsError,
  type OpcuaReadSet,
  type OpcuaWalkClient,
  outwardNote,
  proveReadSet,
} from "./agent-roots";
import type { OpcuaAgentPlan } from "./agent-statement";
import { readUnits, type OpcuaUnits } from "./agent-units";
import type { OpcuaDataValue, OpcuaNodeId, OpcuaReadList, OpcuaReadOnlyClient, OpcuaServerLimits } from "./client";
import { OPCUA_TYPE } from "./constants";
import { messageOf, statusSentence } from "./errors";
import { historyEndSentence, readHistory } from "./history";
import { browseChunkSize, chunked, readChunkSize } from "./limits";
import { historyRows, valueRows } from "./results";

/**
 * The most requests one agent read sends to the server for its answer, counting the namespace table, the reads
 * themselves and the units lookup; the read roots walk is counted apart, against `OPCUA_READ_SET_MAX_REQUESTS`. A value
 * read of an AnalogItemType variable and a plain one is one Read and one Read of the two properties, and a history read
 * 100 values a page; 100 leaves a read of the row budget room, and bounds what one read can ask of a plant server
 * whatever it answers.
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

/** The status every id outside the read roots answers with, the one a server answers for an id it does not hold. */
const OPCUA_OUTSIDE_STATUS = "BadNodeIdUnknown";

const NO_SERVER_TEXT = "Studio quotes nothing of the library's or the server's own text.";

export const OPCUA_AGENT_FAILURE_SENTENCES = {
  /** Studio's time budget ran out. */
  time: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: the read did not finish within ${ms}ms, Studio's time budget for one read, so it was refused rather than answered in part; ask for fewer nodes or a narrower window.`,
  /** The read needed more requests than one read may send. */
  requests: `Read-only execution exceeded the request bound: an agent read on OPC UA sends at most ${OPCUA_AGENT_MAX_REQUESTS} requests to the server for its answer, counting the lookup of engineering units, and this one needed more, so it was refused rather than answered in part or without its units; ask for fewer nodes or a narrower window.`,
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
  /** The server's NamespaceArray, which keys every node id and every read root, could not be read. */
  namespaceTable: (status: string): string =>
    `The server's namespace table (NamespaceArray, i=2255) could not be read (the server answered ${status}), so Studio cannot tell which nodes lie beneath this connection's read roots and refuses the read rather than guess.`,
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
  if (error instanceof OpcuaReadRootsError) return new OpcuaAgentError(error.message);
  const code = statusCodeIn(messageOf(error));
  if (code !== undefined) return new OpcuaAgentError(F.status(code));
  if (!sessionOpened || error instanceof DatabaseConfigError) return new OpcuaAgentError(F.session);
  return new OpcuaAgentError(F.transport);
}

/** The server's NamespaceArray, read once per read on its own session. */
const OPCUA_NAMESPACE_ARRAY = "i=2255";

/** The server's namespace table, read on the read's own session. */
async function namespaceTable(client: Pick<OpcuaReadOnlyClient, "read">): Promise<readonly string[]> {
  const [answer] = await client.read([OPCUA_NAMESPACE_ARRAY]);
  const value = answer?.value;
  if (
    answer?.statusCode !== "Good" ||
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  )
    return fail(F.namespaceTable(answer?.statusCode ?? "nothing"));
  return value;
}

/**
 * The services an agent read's answer may call: the limits, Read and HistoryRead. It browses nothing: a browse is
 * answered from the read roots walk, whose own client holds forward Browse, BrowseNext and the facts Read.
 */
export type OpcuaAgentClient = Pick<
  OpcuaReadOnlyClient,
  "limits" | "read" | "historyRead" | "historyReadNext" | "releaseHistoryContinuationPoint"
>;

/**
 * The agent's client over one session: the read members of the seam an answer needs, the limits, Read and HistoryRead,
 * each counted against the request bound and checked against the deadline before it is sent, and beside them the
 * walk's client, forward Browse, BrowseNext, the facts Read and the release of a browse point, checked against the
 * same deadline and counted apart by the walk itself.
 * GetEndpoints and CloseSession are the provider's, not the read's, and are not in it.
 */
export function boundedAgentClient(
  session: OpcuaReadOnlyClient,
  bounds: { readonly deadlineAt: number; readonly timeoutMs: number; readonly now: () => number },
): OpcuaAgentClient & { readonly requests: () => number; readonly walk: OpcuaWalkClient } {
  let sent = 0;
  const due = (): void => {
    if (bounds.now() >= bounds.deadlineAt) fail(F.time(bounds.timeoutMs));
  };
  const charge = (): void => {
    due();
    if (sent >= OPCUA_AGENT_MAX_REQUESTS) fail(F.requests);
    sent += 1;
  };
  const walk: OpcuaWalkClient = Object.freeze({
    browse: async (nodeIds: readonly OpcuaNodeId[]) => {
      due();
      return session.browse(nodeIds);
    },
    browseNext: async (points: readonly Uint8Array[]) => {
      // A point the deadline stops is handed back before the refusal, so the server's slot is not held.
      if (bounds.now() >= bounds.deadlineAt) await session.releaseBrowseContinuationPoints(points);
      due();
      return session.browseNext(points);
    },
    read: async (nodeIds: readonly OpcuaNodeId[]) => {
      due();
      return session.read(nodeIds, "facts");
    },
    releaseBrowseContinuationPoints: async (points: readonly Uint8Array[]) =>
      session.releaseBrowseContinuationPoints(points),
  });
  return Object.freeze({
    requests: () => sent,
    walk,
    limits: async () => {
      charge();
      return session.limits();
    },
    read: async (nodeIds: readonly OpcuaNodeId[], list?: OpcuaReadList) => {
      charge();
      return list === undefined ? session.read(nodeIds) : session.read(nodeIds, list);
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

/** What one read knows about its server: its namespace table, the proved set, and the size of a Read. */
interface OpcuaAgentScope {
  readonly table: readonly string[];
  readonly set: OpcuaReadSet;
  readonly readChunk: number;
}

/**
 * Whether a node's row carries a value that needs its units: a Variable or a VariableType. Only called after the
 * answer-time check, which answers any other class carrying a value as an id outside the roots.
 */
const isValueBearing = (value: OpcuaDataValue | undefined): boolean =>
  value?.nodeClass === "Variable" || value?.nodeClass === "VariableType";

const unitColumns = (units: OpcuaUnits | undefined): Record<string, unknown> => ({
  units: units?.units ?? null,
  unitId: units?.unitId ?? null,
  unitNamespace: units?.unitNamespace ?? null,
  euRange: units?.euRange ?? null,
});

/** The key of one id the request names when it is a member of the proved set, or undefined for any other id. */
function memberKey(nodeId: OpcuaNodeId, scope: OpcuaAgentScope): OpcuaNodeId | undefined {
  const key = keyIn(nodeId, scope.table)?.key;
  return key !== undefined && scope.set.members.has(key) ? key : undefined;
}

/** The row an id outside the roots answers, the console's own row for an id the server does not hold. */
const outsideRow = (nodeId: OpcuaNodeId): Record<string, unknown> => ({
  ...valueRows([nodeId], [{ nodeId, value: null, statusCode: OPCUA_OUTSIDE_STATUS }]).rows[0],
  ...unitColumns(undefined),
});

/** The refusal of a history read or a browse of an id outside the roots, the server's own sentence for a missing id. */
const outsideRefusal = (): never => fail(F.status(OPCUA_OUTSIDE_STATUS));

async function readValues(
  client: OpcuaAgentClient,
  nodeIds: readonly OpcuaNodeId[],
  scope: OpcuaAgentScope,
): Promise<OpcuaAgentAnswer> {
  const keys = new Map(nodeIds.map((nodeId) => [nodeId, memberKey(nodeId, scope)]));
  const sent = [...new Set([...keys.values()].filter((key): key is OpcuaNodeId => key !== undefined))];
  const values: OpcuaDataValue[] = [];
  for (const batch of chunked(sent, scope.readChunk)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
    values.push(...(await client.read(batch)));
  }
  const byId = new Map(values.map((value) => [value.nodeId, value]));
  const answered = sent.filter((key) => {
    const value = byId.get(key);
    return value !== undefined && !answerTimeOutside(scope.set.members.get(key) ?? {}, value);
  });
  const variables = answered.filter((key) => isValueBearing(byId.get(key)));
  const units = await readUnits(client, variables, scope.set, scope.readChunk);
  const consoleRows = new Map(valueRows(answered, values).rows.map((row) => [row.nodeId as OpcuaNodeId, row]));
  const rows = nodeIds.map((nodeId) => {
    const key = keys.get(nodeId);
    const row = key === undefined ? undefined : consoleRows.get(key);
    return row === undefined ? outsideRow(nodeId) : { ...row, ...unitColumns(units.get(key as OpcuaNodeId)) };
  });
  return { fields: [...OPCUA_AGENT_VALUE_COLUMNS], rows, warnings: [] };
}

async function readHistoryOf(
  client: OpcuaAgentClient,
  plan: Extract<OpcuaAgentPlan, { kind: "history" }>,
  scope: OpcuaAgentScope,
  budget: ReadOnlyStatementBudget,
): Promise<OpcuaAgentAnswer> {
  const key = memberKey(plan.nodeId, scope) ?? outsideRefusal();
  // Raw history is defined only for a Variable, and the walk checked the data type of a Variable alone, so a member it
  // classed as anything else is answered as an id outside the roots, with nothing sent for it.
  if (scope.set.members.get(key)?.nodeClass !== "Variable") outsideRefusal();
  // A limit the request wrote within the budget is the request's own; otherwise one value past the budget is read, so
  // a window holding exactly the budget is answered and one more value is refused.
  const own = plan.limitStated && plan.limit <= budget.maxResultRows;
  const cap = own ? plan.limit : budget.maxResultRows + 1;
  const history = await readHistory(client, {
    nodeId: key,
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
  const units = (await readUnits(client, [key], scope.set, scope.readChunk)).get(key);
  // oxlint-disable-next-line no-map-spread -- each row is a new object, the console's row with the units beside it.
  const rows = historyRows(key, history.values).rows.map((row) => ({ ...row, ...unitColumns(units) }));
  return { fields: [...OPCUA_AGENT_VALUE_COLUMNS], rows, warnings: [sentence] };
}

/**
 * A browse answered from the proved set, with no Browse sent: the Objects folder answers the read roots, a
 * namespace-0 root or member its fixed rows, and any other member the references the walk kept, with the count of
 * those that lead outside in one note. Any other id is refused as missing.
 */
function browseOf(nodeId: OpcuaNodeId, scope: OpcuaAgentScope, budget: ReadOnlyStatementBudget): OpcuaAgentAnswer {
  const fields = [...OPCUA_AGENT_BROWSE_COLUMNS];
  const rowsOf = (rows: readonly object[], warnings: readonly string[]): OpcuaAgentAnswer => {
    if (rows.length > budget.maxResultRows) fail(F.browseOverRows(rows.length, budget.maxResultRows));
    return { fields, rows: rows.map((row): Record<string, unknown> => ({ ...row })), warnings };
  };
  if (keyIn(nodeId, scope.table)?.key === OPCUA_OBJECTS_FOLDER_KEY)
    return rowsOf(scope.set.roots, [OPCUA_ROOTS_WARNING]);
  const key = memberKey(nodeId, scope) ?? outsideRefusal();
  const fixed = namespace0Rows(key);
  if (fixed !== undefined) return rowsOf(fixed, []);
  if (scope.set.leaves.has(key)) return rowsOf([], [OPCUA_LEAF_NOTE]);
  const outward = scope.set.outward.get(key) ?? 0;
  return rowsOf(scope.set.kept.get(key) ?? [], outward === 0 ? [] : [outwardNote(outward)]);
}

/** The answer of one admitted read over one session's agent client, the read set proved first. */
export async function runOpcuaAgentRead(
  client: OpcuaAgentClient & { readonly walk: OpcuaWalkClient },
  plan: OpcuaAgentPlan,
  budget: ReadOnlyStatementBudget,
  roots: readonly string[],
): Promise<OpcuaAgentAnswer> {
  const limits: OpcuaServerLimits = await client.limits();
  const table = await namespaceTable(client);
  const readChunk = readChunkSize(limits);
  const set = await proveReadSet(client.walk, roots, table, { browse: browseChunkSize(limits), read: readChunk });
  const scope: OpcuaAgentScope = { table, set, readChunk };
  switch (plan.kind) {
    case "read":
      return readValues(client, plan.nodeIds, scope);
    case "history":
      return readHistoryOf(client, plan, scope, budget);
    case "browse":
      return browseOf(plan.nodeId, scope, budget);
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
