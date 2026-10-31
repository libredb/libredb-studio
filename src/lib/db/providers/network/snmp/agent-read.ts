/**
 * What an agent's SNMP read sends and answers: each command of the reader's table (`agent-statement.ts`) run over the
 * agent's client (`agent-client.ts`), its values rendered exactly as the console renders them (`rows.ts`), and the
 * wording of a failure by its category.
 *
 * VALUES ARE ANSWERED. A MIB value is the device's own management reading, so the agent reads it, rendered as the
 * editor renders it: an octet string is text only when it is showable text and hex otherwise, so no control byte
 * reaches an answer, and the result travels to the model inside the untrusted-content fence like every other result.
 *
 * WHAT IS WITHHELD. An identifier inside one of the withheld subtrees (`SNMP_WITHHELD_SUBTREES`) is never sent: a `get`
 * or a `next` naming one answers a row naming the subtree's root, typed `withheld`, with no value, and a warning
 * saying why. A `next` whose answer lands inside one answers the same row, never the identifier the agent sent back,
 * whose instance suffix can encode a community or a user name, and never its value. The reader refuses every walk and
 * table that could reach one, so a walk's answers never lie inside one; a varbind that did would refuse the read as a
 * defect here rather than reach an answer.
 *
 * Budgets refuse rather than cut: a walk or a table past the row budget, the request's time budget or the walk's
 * request and byte bounds is refused, and so is a walk the agent left unfinished (silence, an empty answer, or an
 * answer that did not move forward), since a part of a subtree read as the whole of it is the failure the console's
 * walk names. Nothing of one read is kept for the next.
 */
import { QueryError } from "@/lib/db/errors";
import {
  byteBudgetSentence,
  measureResultBytes,
  ROW_BUDGET_PREFIX,
  rowBudgetSentence,
  TIME_BUDGET_PREFIX,
} from "@/lib/db/providers/sql/read-only-budget";
import type { QueryResult, QueryWarning, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { SnmpAgentClient } from "./agent-client";
import { type SnmpAgentPlan, type SnmpWithheldSubtree, withheldReason, withheldSubtreeOf } from "./agent-statement";
import { failureFromStatus, type SnmpFailure } from "./errors";
import type { Response, ResponseVarbind } from "./message";
import { isWithinSubtree } from "./objects";
import { startWalk, stepWalk, type WalkEnd, type WalkState } from "./read";
import { EXCEPTION_TAGS, syntaxFromTag, tableRows, toWalkVarbind } from "./rows";
import { DEFAULT_WALK_BUDGET, type WalkBudget } from "./statement";
import { renderValue } from "./values";

const SNMP_TYPE = "snmp";

/** One row of a `get`, `next` or `walk` answer. `value` is null for an exception or a withheld row. */
export type SnmpAgentRow = Readonly<Record<"object" | "type", string> & Record<"value", string | null>>;

/** What an agent read answers before the budgets are applied to its rows. */
export interface SnmpAgentAnswer {
  readonly fields: readonly string[];
  readonly rows: ReadonlyArray<Record<string, string | null>>;
  readonly withheld: readonly SnmpWithheldSubtree[];
}

const NO_DEVICE_TEXT = "SNMP carries no error text of its own, and Studio quotes nothing the agent sent back.";

export const SNMP_AGENT_FAILURE_SENTENCES = {
  silence: (ms: number): string =>
    `${TIME_BUDGET_PREFIX}: no answer within ${ms}ms. Over SNMPv2c silence is also how an agent answers a community it does not accept, an object too large for one message, or a request a filter dropped, so the read was not answered.`,
  tooBig: `The agent answered that the reply would not fit one message (tooBig), so it sent none of it: ask for fewer objects in one get or next. ${NO_DEVICE_TEXT}`,
  requestTooLarge: `The request did not fit one datagram, so it was never sent: ask for fewer objects in one get or next. ${NO_DEVICE_TEXT}`,
  refused: (status: number): string => `The agent refused the read with SNMP error-status ${status}. ${NO_DEVICE_TEXT}`,
  credential: `The agent refused this connection's credential for the read. ${NO_DEVICE_TEXT}`,
  unreachable: `The agent could not be reached for the read. ${NO_DEVICE_TEXT}`,
  report: `The agent answered the read with a report rather than a response, so it was not answered. ${NO_DEVICE_TEXT}`,
  walkIncomplete: (command: string, why: string): string =>
    `The ${command} was not answered: ${why}, so the agent's answer is part of the subtree at most, and Studio refuses it rather than answering a part as the whole.`,
  walkBound: (command: string, bound: string): string =>
    `Read-only execution exceeded the ${command}'s ${bound} bound before the subtree ended, so the ${command} was refused rather than answered in part; walk a narrower subtree.`,
  insideWithheld:
    "The agent answered a walk with an object inside a withheld subtree, which a walk the reader admitted cannot reach, so the read was refused and nothing of it is answered.",
  tableOverRows: (rows: number, allowed: number): string =>
    `${ROW_BUDGET_PREFIX}: the table holds at least ${rows} rows and the row budget is ${allowed}, so it is refused rather than cut; read one column with walk, or name instances with get.`,
} as const;

const F = SNMP_AGENT_FAILURE_SENTENCES;

/** A refusal or failure worded by Studio. The class tells a caller that nothing in it came from the agent's bytes. */
export class SnmpAgentError extends QueryError {
  constructor(message: string) {
    super(message, SNMP_TYPE);
    this.name = "SnmpAgentError";
    Object.setPrototypeOf(this, SnmpAgentError.prototype);
  }
}

const fail = (sentence: string): never => {
  throw new SnmpAgentError(sentence);
};

/** A failed exchange, worded by its category alone; never the failure's own reason, which may name an identifier. */
function failureSentence(failure: SnmpFailure, timeoutMs: number): string {
  switch (failure.kind) {
    case "silence":
      return F.silence(timeoutMs);
    case "tooLarge":
      return F.tooBig;
    case "requestTooLarge":
      return F.requestTooLarge;
    case "credential":
      return F.credential;
    case "transport":
      return F.unreachable;
    case "refused":
      return F.report;
  }
}

/** The answer of one exchange, or the read's refusal: a failure by its category, a non-zero error-status by its number. */
function answered(answer: Response | SnmpFailure, timeoutMs: number): Response {
  if (!("varbinds" in answer)) return fail(failureSentence(answer, timeoutMs));
  const status = failureFromStatus(answer.errorStatus);
  if (status === undefined) return answer;
  return fail(status.kind === "tooLarge" ? F.tooBig : F.refused(answer.errorStatus));
}

/** One varbind as the console renders it, or its exception as the type with no value. */
function rendered(varbind: ResponseVarbind): SnmpAgentRow {
  const object = varbind.oid.join(".");
  const exception = EXCEPTION_TAGS[varbind.tag];
  if (exception !== undefined) return { object, value: null, type: exception };
  const value = renderValue(syntaxFromTag(varbind.tag, varbind.value), varbind.value);
  return { object, value: value.display, type: value.as };
}

const withheldRow = (entry: SnmpWithheldSubtree): SnmpAgentRow => ({
  object: entry.root.join("."),
  value: null,
  type: "withheld",
});

/**
 * A `get` or a `next`: every identifier inside a withheld subtree answered withheld and never sent, the rest sent in
 * one request, and every answer that lands inside a withheld subtree answered withheld, in the order the statement
 * wrote them.
 */
async function readNamed(
  client: SnmpAgentClient,
  command: "get" | "next",
  oids: readonly (readonly number[])[],
  timeoutMs: number,
): Promise<SnmpAgentAnswer> {
  const sent = oids.filter((oid) => withheldSubtreeOf(oid) === undefined);
  const answer =
    sent.length === 0
      ? undefined
      : answered(await (command === "get" ? client.get(sent) : client.getNext(sent)), timeoutMs);
  const withheld: SnmpWithheldSubtree[] = [];
  const rows: SnmpAgentRow[] = [];
  let index = 0;
  for (const oid of oids) {
    const asked = withheldSubtreeOf(oid);
    // The answer to the n-th identifier sent is the n-th varbind; an agent that answers fewer leaves the rest unanswered.
    const varbind = asked === undefined ? answer?.varbinds[index++] : undefined;
    const landed = asked ?? (varbind === undefined ? undefined : withheldSubtreeOf(varbind.oid));
    if (landed !== undefined) {
      if (!withheld.includes(landed)) withheld.push(landed);
      rows.push(withheldRow(landed));
    } else if (varbind !== undefined) {
      rows.push(rendered(varbind));
    }
  }
  return { fields: ["object", "value", "type"], rows, withheld };
}

/** Why a walk ended, as a refusal, when it did not end at its subtree's end. */
function walkEndRefusal(command: string, end: WalkEnd, rows: number, budget: ReadOnlyStatementBudget): string {
  if (end.reason === "subtree") return "";
  if (end.reason === "budget") {
    if (end.budget === "rows") return rowBudgetSentence(rows, budget.maxResultRows);
    if (end.budget === "wallMs") return F.silence(budget.statementTimeoutMs);
    return F.walkBound(command, end.budget === "requests" ? "request" : "inbound byte");
  }
  if (end.reason === "notForward") return F.walkIncomplete(command, "the agent's answers did not move forward");
  // A silent step is refused by the exchange before the walk reads it, so only an empty answer arrives here; the two
  // share the sentence, since both leave the subtree unfinished.
  return F.walkIncomplete(command, "the agent answered a step with no objects");
}

/**
 * A `walk` or a `table`: GetBulk steps under the console's walk state machine (`stepWalk`), every answered varbind
 * past the subtree dropped as the console drops it. A walk's row bound is one past the row budget, so a subtree of
 * exactly the budget is answered and one row more is refused; a table's is the console's varbind bound, and its rows
 * are refused past the row budget once the table is built.
 */
async function readSubtree(
  client: SnmpAgentClient,
  command: "walk" | "table",
  subtree: readonly number[],
  maxRepetitions: number,
  budget: ReadOnlyStatementBudget,
  now: () => number,
): Promise<SnmpAgentAnswer> {
  const bounds: WalkBudget = {
    ...DEFAULT_WALK_BUDGET,
    rows: command === "walk" ? budget.maxResultRows + 1 : DEFAULT_WALK_BUDGET.rows,
    wallMs: budget.statementTimeoutMs,
  };
  const scoped: ResponseVarbind[] = [];
  let state: WalkState = startWalk(now());
  let from: readonly number[] = subtree;
  let repetitions = maxRepetitions;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each step asks from where the one before it ended.
    const answer = answered(await client.getBulk(from, repetitions), budget.statementTimeoutMs);
    for (const varbind of answer.varbinds) {
      if (!isWithinSubtree(subtree, varbind.oid)) break;
      if (withheldSubtreeOf(varbind.oid) !== undefined) fail(F.insideWithheld);
      scoped.push(varbind);
    }
    const step = stepWalk(subtree, bounds, state, answer.varbinds.map(toWalkVarbind), now());
    state = step.state;
    if (step.kind === "stop") {
      const refusal = walkEndRefusal(command, step.end, state.rows, budget);
      if (refusal !== "") fail(refusal);
      break;
    }
    from = step.request.oids[0];
    repetitions = step.request.maxRepetitions as number;
  }
  if (command === "table") {
    const rows = tableRows(subtree, scoped);
    if (rows.length > budget.maxResultRows) fail(F.tableOverRows(rows.length, budget.maxResultRows));
    return { fields: rows.length === 0 ? ["index"] : Object.keys(rows[0]), rows, withheld: [] };
  }
  const rows = scoped.filter((varbind) => EXCEPTION_TAGS[varbind.tag] === undefined).map(rendered);
  return { fields: ["object", "value", "type"], rows, withheld: [] };
}

/** The answer of one admitted read, through the agent's client alone. */
export async function runSnmpAgentRead(
  client: SnmpAgentClient,
  plan: SnmpAgentPlan,
  budget: ReadOnlyStatementBudget,
  now: () => number = Date.now,
): Promise<SnmpAgentAnswer> {
  switch (plan.command) {
    case "get":
    case "next":
      return readNamed(client, plan.command, plan.oids, budget.statementTimeoutMs);
    case "walk":
      return readSubtree(client, "walk", plan.subtree, plan.maxRepetitions, budget, now);
    case "table":
      return readSubtree(client, "table", plan.table, plan.maxRepetitions, budget, now);
  }
}

/** The answer of one read as a result: refused past the row or byte budget rather than cut. */
export function snmpAgentResult(
  answer: SnmpAgentAnswer,
  budget: ReadOnlyStatementBudget,
  executionTime: number,
): QueryResult {
  const rows = answer.rows.map((row) => ({ ...row }));
  if (rows.length > budget.maxResultRows) fail(rowBudgetSentence(rows.length, budget.maxResultRows));
  const bytes = measureResultBytes(rows);
  if (bytes > budget.maxResultBytes) fail(byteBudgetSentence(bytes, budget.maxResultBytes));
  const warnings: QueryWarning[] = answer.withheld.map((entry) => ({ message: withheldReason(entry) }));
  return {
    fields: [...answer.fields],
    rows,
    rowCount: rows.length,
    executionTime,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}
