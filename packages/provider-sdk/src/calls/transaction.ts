/**
 * The host's reading of the session state a transaction answers (docs/providers/CONTRACT.md, clauses C-57 and C-58).
 *
 * Every `console.transaction` answer carries `sessionState`, the state of the session after the call, and only a begin
 * may carry `stateReported`, whether the server reported the transaction state; every answer to a statement sent with
 * `transaction` carries `sessionState` too. A provider that cannot tell answers `unknown`. The host decides on this
 * value whether a transaction is still held, so a value it cannot read is refused by name as
 * `transaction-answer-unreadable`, never read as any state.
 *
 * Each reader reads the answer by its own property descriptors: a getter is never called but refused, and no refusal
 * carries a value of the answer.
 */
import { SESSION_STATES } from "../errors";
import { isPlainRecord, pointerTo, readOwn } from "./records";
import type { CallRefusal } from "./refusals";
import type { TransactionRequest } from "./types";

const STATES: readonly unknown[] = SESSION_STATES;

/** The refusal of the session state at `/sessionState` of `answer`, when it is missing, an accessor or no state. */
function sessionStateRefusals(answer: unknown): readonly CallRefusal[] {
  const read = readOwn(answer, "sessionState");
  if (read.kind === "data" && STATES.includes(read.value)) return [];
  return [{ rule: "transaction-answer-unreadable", pointer: "/sessionState" }];
}

/**
 * Every way `answer`, what `console.transaction` answered to `request`, is not a transaction answer, in the answer's
 * own key order with a missing `sessionState` last: a session state that is missing, outside `SESSION_STATES` or an
 * accessor; a `stateReported` on another action than begin, or one that is no boolean or an accessor; any other own
 * key, enumerable or not, named; and an answer that is no plain record, refused once at the empty pointer.
 */
export function checkTransactionAnswer(request: TransactionRequest, answer: unknown): readonly CallRefusal[] {
  if (!isPlainRecord(answer)) return [{ rule: "transaction-answer-unreadable", pointer: "" }];
  const keys = Object.getOwnPropertyNames(answer);
  const refusals: CallRefusal[] = [];
  for (const key of keys) {
    const pointer = pointerTo("", key);
    if (key === "sessionState") {
      refusals.push(...sessionStateRefusals(answer));
    } else if (key === "stateReported") {
      const read = readOwn(answer, key);
      if (request.action !== "begin" || read.kind !== "data" || typeof read.value !== "boolean") {
        refusals.push({ rule: "transaction-answer-unreadable", pointer });
      }
    } else {
      refusals.push({ rule: "transaction-answer-unreadable", pointer, name: key });
    }
  }
  if (!keys.includes("sessionState")) refusals.push(...sessionStateRefusals(answer));
  return refusals;
}

/**
 * The refusal of the session state an execute answer to a statement sent with `transaction` carries: one at
 * `/sessionState` when it is missing, outside `SESSION_STATES` or an accessor, none when it is a state. The answer's
 * other members are not read here; the pump reads its results.
 */
export function checkTransactionStatement(answer: unknown): readonly CallRefusal[] {
  return sessionStateRefusals(answer);
}
