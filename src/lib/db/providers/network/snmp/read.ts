/**
 * The read path as a state machine: what to ask next, and when to stop.
 *
 * This module holds no socket. It is given a statement and then, one at a time, what came back,
 * and it answers with the next request or with a reason the read ended. That shape is deliberate:
 * every rule SN-S6 states is about WHEN to stop, and a rule about stopping is only testable if
 * stopping can be driven without an agent.
 *
 * THE THREE WAYS A WALK ENDS, AND WHY NONE OF THEM IS "NO ERROR ARRIVED". Measured against
 * Net-SNMP snmpd 5.9.4 on 13 October 2026:
 *   1. It reaches the end of its subtree, which is the only clean end.
 *   2. It hits a budget, which is ours and is reported with the budget that ended it.
 *   3. It stops because the agent stopped answering, and over SNMPv2c that arrives as nothing
 *      at all. A column holding a value no datagram can carry ended a walk with four of five
 *      rows and an ordinary end of walk: no error, no warning, no sign. A reader that treats
 *      "no error" as "complete" reports a short table as a whole one.
 * So completion is something this module asserts only in case 1, and the other two are named.
 */
import { QueryError } from "@/lib/db/errors";
import { explainUnknown } from "./mib";
import { MIB_NAMES } from "./mib-names";
import { assertMovesForward, isWithinSubtree } from "./objects";
import { checkBulkRequest, MAX_REPETITIONS_CAP, type Statement, type WalkBudget } from "./statement";

/** A name that reached the read path without being resolved against the MIB first. */
export class UnresolvedName extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvedName";
    Object.setPrototypeOf(this, UnresolvedName.prototype);
  }
}

export type PduType = "get" | "getNext" | "getBulk";

export interface PlannedRequest {
  readonly pdu: PduType;
  readonly oids: readonly (readonly number[])[];
  /** Only for getBulk. Already checked against the cap and the varbind bound. */
  readonly maxRepetitions?: number;
}

export interface Varbind {
  readonly oid: readonly number[];
  /** `endOfMibView`, `noSuchObject` and `noSuchInstance` are statuses, not errors. */
  readonly status?: "endOfMibView" | "noSuchObject" | "noSuchInstance";
  readonly bytes: number;
}

export type WalkEnd =
  | { readonly reason: "subtree"; readonly complete: true }
  | { readonly reason: "budget"; readonly complete: false; readonly budget: keyof WalkBudget }
  | { readonly reason: "silence"; readonly complete: false; readonly lastSeen: readonly number[] | undefined }
  | { readonly reason: "notForward"; readonly complete: false; readonly detail: string }
  // An answer that carried NO varbinds. Its own reason, because it used to be read as the end
  // of the subtree: the walk returned "0 rows, the walk reached the end of its subtree" while a
  // sixteen-object tree sat there, and the screen showed no error at all. MEASURED against a
  // real agent on 14 October 2026: a GetBulk whose max-repetitions is zero is answered with an
  // empty varbind list, which is exactly what this provider was sending.
  | { readonly reason: "empty"; readonly complete: false; readonly lastSeen: readonly number[] | undefined };

export interface WalkState {
  readonly rows: number;
  readonly inboundBytes: number;
  readonly requests: number;
  readonly startedAt: number;
  readonly last: readonly number[] | undefined;
  /** Dropped to GetNext after a GetBulk failed, which the measurements make a one-way step. */
  readonly usingGetNext: boolean;
}

export function startWalk(now: number): WalkState {
  return { rows: 0, inboundBytes: 0, requests: 0, startedAt: now, last: undefined, usingGetNext: false };
}

/** The first request a statement makes. */
export function firstRequest(statement: Statement): PlannedRequest {
  switch (statement.command) {
    case "get":
      return { pdu: "get", oids: statement.names.map(resolveName) };
    case "next":
      return { pdu: "getNext", oids: statement.names.map(resolveName) };
    case "walk": {
      const start = resolveName(statement.subtree);
      const maxRepetitions = Math.min(MAX_REPETITIONS_CAP, statement.limit ?? MAX_REPETITIONS_CAP);
      checkBulkRequest(0, maxRepetitions, 1);
      return { pdu: "getBulk", oids: [start], maxRepetitions };
    }
    case "table":
      // A table is walked through its own subtree, one column at a time, by the caller.
      return { pdu: "getBulk", oids: [resolveName(statement.table)], maxRepetitions: MAX_REPETITIONS_CAP };
  }
}

/**
 * The one place a written object name becomes an identifier, exported because the caller needs
 * the SAME answer for the walk's SUBTREE. When it was private, `subtreeOf` had its own rule - a
 * descriptor had no subtree, so it used the empty array, which `isWithinSubtree` says every OID is
 * inside. That was harmless while names never resolved; the moment they did, `walk system` left
 * the system group and read 4135 objects off the whole agent instead of 38. One name, one answer.
 */
export function resolveName(name: { form: string } & Record<string, unknown>): readonly number[] {
  if (name.form === "numeric") return name.oid as readonly number[];

  // A NAME IS RESOLVED HERE, against the index generated from the bundled modules (`./mib-names`).
  // This used to throw for every descriptor, with a sentence written for a defect that could not
  // happen - "reached the read path unresolved" - because nothing resolved names at all. The
  // document teaches `get sysName.0`, and that spelling answered with an internal message until
  // 14 October 2026, when a live agent showed it.
  const descriptor = typeof name.descriptor === "string" ? name.descriptor : "";
  const base = MIB_NAMES.get(descriptor);
  if (base === undefined) {
    // The unknown name gets the house sentence, which already separates "no such name" from "a
    // name in a module this build chose not to carry".
    const written = typeof name.module === "string" ? `${name.module}::${descriptor}` : descriptor;
    throw new UnresolvedName(explainUnknown(written));
  }
  const instance = Array.isArray(name.instance) ? (name.instance as readonly number[]) : [];
  return [...base, ...instance];
}

/**
 * Whether a budget has been spent, checked BEFORE the next request rather than after it.
 *
 * Checking after is how a walk sends one more request than its budget allows, which matters
 * because each request costs the agent memory as well as this process time.
 */
export function budgetSpent(state: WalkState, budget: WalkBudget, now: number): keyof WalkBudget | undefined {
  if (state.rows >= budget.rows) return "rows";
  if (state.inboundBytes >= budget.inboundBytes) return "inboundBytes";
  if (state.requests >= budget.requests) return "requests";
  if (now - state.startedAt >= budget.wallMs) return "wallMs";
  return undefined;
}

export type WalkStep =
  | { readonly kind: "ask"; readonly request: PlannedRequest; readonly state: WalkState }
  | { readonly kind: "stop"; readonly end: WalkEnd; readonly state: WalkState };

/**
 * One turn of the walk: takes what came back and answers with the next move.
 *
 * `answer` is undefined when nothing came back. That is not an error path bolted on; over UDP it
 * is a normal outcome and the walk has to be able to end on it with a reason the user can read.
 */
export function stepWalk(
  subtree: readonly number[],
  budget: WalkBudget,
  state: WalkState,
  answer: readonly Varbind[] | undefined,
  now: number,
): WalkStep {
  if (answer === undefined) {
    // The agent stopped answering. Never reported as a finished walk, and the last OID that did
    // arrive is named, because it is the only thing that locates where the gap starts.
    return { kind: "stop", end: { reason: "silence", complete: false, lastSeen: state.last }, state };
  }

  if (answer.length === 0) {
    // An answer is not an ending. "The agent replied with nothing" and "the subtree is over" are
    // different facts, and reading the first as the second hides a whole tree behind a clean
    // sentence. The walk stops either way, but it stops INCOMPLETE and says so.
    return { kind: "stop", end: { reason: "empty", complete: false, lastSeen: state.last }, state };
  }

  let next = state;
  for (const varbind of answer) {
    if (varbind.status === "endOfMibView") {
      return { kind: "stop", end: { reason: "subtree", complete: true }, state: next };
    }
    if (!isWithinSubtree(subtree, varbind.oid)) {
      // Past the end of the subtree is a clean finish, and the varbind that took us past it is
      // not counted: it belongs to whatever comes next, not to this walk.
      return { kind: "stop", end: { reason: "subtree", complete: true }, state: next };
    }
    if (next.last !== undefined) {
      try {
        assertMovesForward(next.last, varbind.oid);
      } catch (error) {
        return {
          kind: "stop",
          end: { reason: "notForward", complete: false, detail: (error as Error).message },
          state: next,
        };
      }
    }
    next = {
      ...next,
      rows: next.rows + 1,
      inboundBytes: next.inboundBytes + varbind.bytes,
      last: varbind.oid,
    };
  }

  next = { ...next, requests: next.requests + 1 };
  const spent = budgetSpent(next, budget, now);
  if (spent !== undefined) {
    return { kind: "stop", end: { reason: "budget", complete: false, budget: spent }, state: next };
  }
  /*
   * WHERE THE NEXT REQUEST STARTS, written as a fallback rather than as a branch.
   *
   * It used to be a guard - `if (next.last === undefined) return ...` - and that guard was a line
   * no test could ever reach. MEASURED on 15 October 2026: a `throw` planted in it fired in none
   * of the 469 tests of this provider, in none of the twelve live items against a real agent, and
   * a direct probe of every answer shape returned before reaching it. Each varbind either ends
   * the walk (endOfMibView, past the subtree, backwards) or is counted, which sets `last`, and an
   * answer with no varbinds is already held above.
   *
   * A line that cannot run is a line the coverage gate can never see green, and writing a case
   * for it is impossible rather than merely undone. So the unreachable branch is gone and the
   * type is satisfied by a value: if `last` is ever missing the walk asks from the subtree root,
   * which is where it would have started, instead of reporting an ending that never happens.
   */
  const from = next.last ?? subtree;
  const maxRepetitions = next.usingGetNext ? undefined : MAX_REPETITIONS_CAP;
  return {
    kind: "ask",
    request: next.usingGetNext ? { pdu: "getNext", oids: [from] } : { pdu: "getBulk", oids: [from], maxRepetitions },
    state: next,
  };
}

/**
 * Drops a walk from GetBulk to GetNext after a GetBulk failed.
 *
 * One way only. Measured: a GetBulk failed at the first response that would have carried a large
 * value, while a GetNext carried that same value alone. Going back to GetBulk afterwards would
 * walk into the same wall, so the step is not reversed within one walk.
 */
export function fallBackToGetNext(state: WalkState): WalkState {
  return { ...state, usingGetNext: true };
}

/**
 * What a finished walk should say about itself.
 *
 * The sentence is built from the end rather than from the row count, because a row count reads
 * as success whatever produced it.
 */
export function describeEnd(end: WalkEnd, rows: number): string {
  switch (end.reason) {
    case "subtree":
      return `${rows} rows: the walk reached the end of its subtree.`;
    case "budget":
      return `${rows} rows, and the walk stopped on its ${end.budget} budget rather than at the end of the subtree, so there is more.`;
    case "silence":
      return (
        `${rows} rows, and then the agent stopped answering. Over SNMPv2c that is also what an object too large ` +
        `for any message looks like, so this is not the end of the table` +
        (end.lastSeen === undefined ? "." : `; the last object that did arrive was ${end.lastSeen.join(".")}.`)
      );
    case "notForward":
      return `${rows} rows, and the walk stopped because the agent did not move forward. ${end.detail}`;
    case "empty":
      return (
        `${rows} rows, and the agent answered with no objects at all. That is not the end of the subtree: ` +
        `an empty answer means the request asked for nothing or the agent had nothing to give` +
        (end.lastSeen === undefined ? "." : `; the last object that did arrive was ${end.lastSeen.join(".")}.`)
      );
  }
}
