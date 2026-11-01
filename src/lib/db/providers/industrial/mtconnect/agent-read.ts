/**
 * What an agent's MTConnect read sends and answers: one admitted request line (`agent-statement.ts`), read against the
 * agent's device model as it stands before the read, sent as one GET of a route from the closed table, and answered as
 * the console answers it, with the agent's adapter connections withheld (`agent-withheld.ts`).
 *
 * WHAT IS SENT. Two GETs per read, one at a time on the provider's permit: `/probe`, so the device a request names, the
 * rows' join and the withheld items are decided from the model the agent serves now and never from a model held since
 * an earlier read; then the request itself, built by the console's own `buildTarget` from the route the guard matched.
 * No function here builds a method, a body or a route: `readOnce` and `readObservations` in `client.ts` send GET and
 * nothing else.
 *
 * VALUES ARE ANSWERED. An observation's value, timestamp and sequence are the machine's own readings, rendered as the
 * console renders them, one row per observation. A device model read answers one row per data item, and an asset read
 * one row per asset with the asset's document beside its attributes: the asset element rendered back to XML text from
 * the parsed tree, every attribute value and text escaped, so a CDATA section, an entity or a closing marker inside
 * it is text in a cell and never markup. Every result travels to the model inside the untrusted-content fence.
 *
 * BUDGETS REFUSE, NEVER CUT. A `count` past the row budget is refused before anything is sent. An answer whose rows
 * pass the row budget is refused: an observation walk stops at the first row past it and the read is refused, so no
 * part of it is answered; a model or an asset answer is counted whole and refused. A result past the byte budget, an
 * answer past the route's byte cap and a read past its time budget are refused in Studio's words. The `count`, `from`,
 * `to` and `at` parameters select observations the buffer already serves to any client and nothing withheld depends
 * on them, so they are no oracle. Nor is `path`: agent mode sends only equality tests whose every value is one a data
 * item it answers holds (`agent-statement.ts`), so no path can test a withheld id, name or address for a text.
 *
 * FAILURES BY CATEGORY. The agent's own error document is answered by its error code when the code is one the
 * standard names, never by its text; a transport failure, an answer that is not MTConnect, an unreadable answer and
 * an answer Studio's reader refuses by its own rule are each worded by their category, never in the agent's words.
 */
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  byteBudgetSentence,
  measureResultBytes,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  MTCONNECT_AGENT_PATH_ATTRIBUTES,
  readMtconnectAgentStatement,
  type MtconnectAgentPathTest,
} from "./agent-statement";
import { itemWithheld, observationWithheld, withheldWarning } from "./agent-withheld";
import { MtcClientError, type MtcAnswer } from "./client";
import { guardRequestLine, type MtcRequest } from "./guard";
import { indexMtconnectModel, type MtcModel } from "./model";
import { buildRow, rowsFromAssets, rowsFromModel, sortRows, type MtcRow } from "./rows";
import type { MtcElement, MtcObservation } from "./xml";

const MTCONNECT_TYPE = "mtconnect";
const STUDIO = "This is Studio's refusal, not the agent's answer.";
const NOT_QUOTED = "The agent's own text is not quoted.";

/**
 * The error codes the standard names for an `MTConnectError`, in both spellings an agent writes: the `errorCode`
 * attribute of the legacy `<Error>` and the element name of the typed errors of schema 2.6 and later. A code outside
 * this set is not quoted, since it would be the agent's own text.
 */
const STANDARD_ERROR_CODES: ReadonlySet<string> = new Set([
  "ASSET_NOT_FOUND",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "INVALID_URI",
  "INVALID_XPATH",
  "NO_DEVICE",
  "OUT_OF_RANGE",
  "QUERY_ERROR",
  "TOO_MANY",
  "UNAUTHORIZED",
  "UNSUPPORTED",
  "INVALID_PARAMETER_VALUE",
  "AssetNotFound",
  "InternalError",
  "InvalidRequest",
  "InvalidURI",
  "InvalidXPath",
  "NoDevice",
  "OutOfRange",
  "QueryError",
  "TooMany",
  "Unauthorized",
  "Unsupported",
  "InvalidParameterValue",
]);

export const MTCONNECT_AGENT_FAILURE_SENTENCES = {
  /** An observation walk, a model or an asset answer holding more rows than the row budget. */
  overRows: (rows: number, allowed: number): string =>
    `${rowBudgetSentence(rows, allowed)}: the agent answered more rows than the row budget, one per observation, data item or asset, so the read was refused rather than cut; narrow it with a device, a path or a smaller count. ${STUDIO}`,
  /** An observation walk stopped at the first row past the row budget, so only that many rows are known. */
  overWalk: (allowed: number): string =>
    `${rowBudgetSentence(allowed + 1, allowed)}: the agent's answer held at least ${allowed + 1} observations, one row each, and the walk stopped at the first one past the row budget, so the read was refused rather than cut; narrow it with a device, a path or a smaller count. ${STUDIO}`,
  /** The read was still running, or waiting for its turn on this agent, when its time budget ran out. */
  deadline: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: no answer within ${ms}ms, Studio's time budget for one read, which covers the device model read, the wait for this handle's one permit and the read itself, so Studio stopped the read and refused it. ${STUDIO}`,
  /** An answer past the byte cap Studio reads one answer of its route under. */
  tooLarge: `The agent's answer passed the most Studio reads of one answer of this route, so Studio stopped reading it and refused the read rather than answer part of it; narrow it with a device, a path or a smaller count. ${STUDIO}`,
  /** The agent's own error document. */
  agentError: (code: string | undefined): string =>
    code === undefined
      ? `The agent refused the read with an error document whose code is not one the MTConnect standard names (category agent-error). ${NOT_QUOTED}`
      : `The agent refused the read with error code ${code} (category agent-error). ${NOT_QUOTED}`,
  /** The agent could not be reached, or the connection failed. */
  transport: (kind: string, ms: number): string =>
    `The agent could not be read (category ${kind}) within the read's time budget of ${ms}ms. The transport's own text is not quoted.`,
  notMtconnect: `The address answered a document that is not an MTConnect answer (category not-mtconnect): a reverse proxy in front of an agent answers its own pages this way, for a sign-in, a refusal or a gateway error. ${NOT_QUOTED}`,
  unreadable: `The agent's answer is not readable XML (category unreadable), so it could not be read as an MTConnect document. ${NOT_QUOTED}`,
  refusedByRule: `Studio refused the agent's answer by one of its own reader rules (category refused-by-rule): a DOCTYPE, an entity declaration, an entity, a comment or a processing instruction, or one of the reader's size bounds. The document may be perfectly good MTConnect; this is Studio's rule, not a fault in the agent.`,
  notAModel: `The agent answered a device model read with a document that is not an MTConnect device model (category not-a-model). ${NOT_QUOTED}`,
} as const;

/** A refusal or failure of the agent's read, worded by its category. */
export class MtconnectAgentError extends QueryError {
  constructor(message: string) {
    super(message, MTCONNECT_TYPE);
    this.name = "MtconnectAgentError";
    Object.setPrototypeOf(this, MtconnectAgentError.prototype);
  }
}

/** One read's two GETs, supplied by the provider over its own transport, permit and time budget. */
export interface MtconnectAgentReader {
  /** One GET of a route from the table, read as a tree. */
  readonly read: (request: MtcRequest) => Promise<MtcAnswer>;
  /** One GET of an observation route, walked; `onObservation` returning false stops the walk. */
  readonly stream: (
    request: MtcRequest,
    onObservation: (observation: MtcObservation) => boolean | void,
  ) => Promise<{ readonly agentError?: MtcElement }>;
}

/** What one agent read answers before the byte budget is applied. */
export interface MtconnectAgentAnswer {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly fields: readonly string[];
  readonly warnings: readonly QueryWarning[];
}

/** The columns of an observation answer with no row, the console's own. */
const OBSERVATION_FIELDS = Object.freeze([
  "device",
  "component",
  "dataItemId",
  "name",
  "category",
  "type",
  "value",
  "units",
  "timestamp",
  "sequence",
]);

/** The model read every agent read starts with: the console's own `/probe`, read by the console's guard. */
const PROBE: MtcRequest = guardRequestLine("/probe", { rowCap: 1 });

/** The code of an agent's error document, when it is one the standard names. */
function agentErrorCode(root: MtcElement): string | undefined {
  const errors = root.children.find((child) => child.name === "Errors");
  const first = errors?.children[0];
  if (first === undefined) return undefined;
  const code = first.attributes.errorCode ?? first.name;
  return STANDARD_ERROR_CODES.has(code) ? code : undefined;
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
});

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

/**
 * One element rendered back to XML text from the parsed tree: attributes in the order the agent wrote them, values and
 * text escaped, an element's own text before its children. Never the agent's bytes: a CDATA section is text here and
 * an entity is the character it stood for, so nothing the agent wrote is handed on as markup.
 */
export function renderXmlElement(element: MtcElement): string {
  const attributes = Object.entries(element.attributes)
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");
  const inner = escapeXml(element.text) + element.children.map(renderXmlElement).join("");
  return inner === "" ? `<${element.name}${attributes}/>` : `<${element.name}${attributes}>${inner}</${element.name}>`;
}

function refuseRows(rows: number, budget: ReadOnlyStatementBudget): never {
  throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.overRows(rows, budget.maxResultRows));
}

function warningsOf(withheld: number, noun: "observation" | "data item"): QueryWarning[] {
  return withheld === 0 ? [] : [{ message: withheldWarning(withheld, noun) }];
}

/** The device model the read is decided under, read fresh: nothing of an earlier read is kept. */
async function freshModel(reader: MtconnectAgentReader): Promise<MtcModel> {
  const answer = await reader.read(PROBE);
  if (answer.isError)
    throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.agentError(agentErrorCode(answer.root)));
  const model = indexMtconnectModel(answer.root);
  if (model === undefined) throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.notAModel);
  return model;
}

/** An observation route, walked and stopped at the first row past the row budget. */
async function observations(
  reader: MtconnectAgentReader,
  request: MtcRequest,
  model: MtcModel,
  budget: ReadOnlyStatementBudget,
): Promise<MtconnectAgentAnswer> {
  const rows: MtcRow[] = [];
  let withheld = 0;
  let over = false;
  const walk = await reader.stream(request, (observation) => {
    const item = model.items.get(observation.attributes.dataItemId ?? "");
    if (observationWithheld(observation, item)) {
      withheld += 1;
      return true;
    }
    const row = buildRow(observation, model);
    if (row === undefined) return true;
    rows.push(row);
    if (rows.length > budget.maxResultRows) {
      over = true;
      return false;
    }
    return true;
  });
  if (walk.agentError !== undefined) {
    throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.agentError(agentErrorCode(walk.agentError)));
  }
  // The walk stopped at the first row past the budget, so how many more the agent held is not known: the read is
  // refused as holding more than the budget, never answered in part.
  if (over) throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.overWalk(budget.maxResultRows));
  const sorted = sortRows(rows);
  return {
    rows: sorted.map((row) => ({ ...row })),
    fields: sorted.length === 0 ? OBSERVATION_FIELDS : Object.keys(sorted[0]),
    warnings: warningsOf(withheld, "observation"),
  };
}

/** A device model route: the answer's own model, one row per data item. */
function modelRows(answer: MtcAnswer, request: MtcRequest, budget: ReadOnlyStatementBudget): MtconnectAgentAnswer {
  const model = indexMtconnectModel(answer.root);
  if (model === undefined) throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.notAModel);
  let withheld = 0;
  const rows: Record<string, unknown>[] = [];
  for (const row of rowsFromModel(model, request.params.device)) {
    const item = model.items.get(row.dataItemId);
    if (item !== undefined && itemWithheld(item)) {
      withheld += 1;
      continue;
    }
    rows.push({ ...row });
  }
  if (rows.length > budget.maxResultRows) refuseRows(rows.length, budget);
  return { rows, fields: rows.length === 0 ? [] : Object.keys(rows[0]), warnings: warningsOf(withheld, "data item") };
}

/** An asset route: one row per asset, its document beside its attributes. */
function assetRows(answer: MtcAnswer, budget: ReadOnlyStatementBudget): MtconnectAgentAnswer {
  const assets = rowsFromAssets(answer.root);
  if (assets.length > budget.maxResultRows) refuseRows(assets.length, budget);
  const rows = assets.map((row) => ({
    assetId: row.assetId,
    type: row.type,
    deviceUuid: row.deviceUuid,
    timestamp: row.timestamp,
    removed: row.removed,
    hash: row.hash,
    ...row.attributes,
    document: renderXmlElement(row.document),
  }));
  return { rows, fields: rows.length === 0 ? [] : Object.keys(rows[0]), warnings: [] };
}

/**
 * The values a path may test, by attribute: those of the data items agent mode reads, never of a withheld one. A path
 * admitted against these selects a withheld item only by a value an item agent mode answers holds too, so no path can
 * ask the agent whether a withheld id or name holds a text.
 */
function readablePathValues(model: MtcModel): (test: MtconnectAgentPathTest) => boolean {
  const values = new Map(MTCONNECT_AGENT_PATH_ATTRIBUTES.map((attribute) => [attribute, new Set<string>()]));
  for (const item of model.items.values()) {
    if (itemWithheld(item)) continue;
    const fields = {
      id: item.dataItemId,
      name: item.name,
      type: item.type,
      subType: item.subType,
      category: item.category,
    };
    for (const attribute of MTCONNECT_AGENT_PATH_ATTRIBUTES) {
      const value = fields[attribute];
      if (value !== undefined) values.get(attribute)?.add(value);
    }
  }
  return (test) => values.get(test.attribute)?.has(test.value) === true;
}

/**
 * One agent read: the model read fresh, the statement read again against it, and the request sent. The statement is
 * read by `readMtconnectAgentStatement` before this is called, so a refusal here is one the model decides: a device
 * it does not hold, or a path value no data item agent mode reads holds.
 */
export async function runMtconnectAgentRead(
  reader: MtconnectAgentReader,
  statement: string,
  budget: ReadOnlyStatementBudget,
): Promise<MtconnectAgentAnswer> {
  const model = await freshModel(reader);
  const reading = readMtconnectAgentStatement(statement, {
    rowCap: budget.maxResultRows,
    knownDevices: new Set(model.devices.flatMap((device) => [device.name, device.uuid])),
    readable: readablePathValues(model),
    afterModelRead: true,
  });
  if (!reading.ok) throw new MtconnectAgentError(reading.message);
  const request = reading.request;
  if (request.op === "current" || request.op === "sample") return observations(reader, request, model, budget);
  const answer = await reader.read(request);
  if (answer.isError)
    throw new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.agentError(agentErrorCode(answer.root)));
  return request.op === "probe" ? modelRows(answer, request, budget) : assetRows(answer, budget);
}

/** The answer as a result, refused past the byte budget rather than cut. */
export function mtconnectAgentResult(
  answer: MtconnectAgentAnswer,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const rows = answer.rows.map((row) => ({ ...row }));
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) {
    throw new MtconnectAgentError(`${byteBudgetSentence(bytes, budget.maxResultBytes)}. ${STUDIO}`);
  }
  return {
    rows,
    fields: [...answer.fields],
    rowCount: rows.length,
    executionTime,
    ...(answer.warnings.length === 0 ? {} : { warnings: [...answer.warnings] }),
  };
}

/**
 * A failure of the read worded by its category, never in the agent's or the transport's text. `timedOut` is whether
 * the read's own time budget ended it, which decides a failure the deadline caused whatever shape it took.
 */
export function agentFailure(error: unknown, timedOut: boolean, ms: number): unknown {
  if (error instanceof MtconnectAgentError) return error;
  if (timedOut) return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.deadline(ms));
  if (error instanceof TransportError) {
    if (error.kind === "too-large") return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.tooLarge);
    if (error.kind === "timeout") return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.deadline(ms));
    return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.transport(error.kind, ms));
  }
  if (error instanceof MtcClientError) {
    // The request ceiling is Studio's own sentence about the request it would send, and quotes nothing of the agent.
    if (error.failure === "request-too-long") return new MtconnectAgentError(error.message);
    if (error.failure === "not-mtconnect")
      return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.notMtconnect);
    if (error.failure === "unreadable") return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.unreadable);
    return new MtconnectAgentError(MTCONNECT_AGENT_FAILURE_SENTENCES.refusedByRule);
  }
  return error;
}
