/**
 * The host's reading of what a console execute answered (docs/providers/CONTRACT.md, clauses C-48 and C-112).
 *
 * The host passes an execute answer's result list, its first result's columns and row count, its execution time and
 * its warnings on to the caller, so it reads each of them once, here, before it pumps a row: a member that is missing
 * where the SDK requires it, behind an accessor, or not of the SDK's type there is refused by name as
 * `execute-answer-unreadable`, never read as any value. The answer's other members are not read here: the pump reads
 * the first result's rows, a statement sent inside a transaction has its session state read by
 * `checkTransactionStatement`, and every other result is closed unread.
 *
 * Each reader reads the answer by its own property descriptors: a getter is never called but refused, an inherited
 * property is never read, and no refusal carries a value of the answer.
 */
import { isPlainRecord, pointerTo, readOwn } from "./records";
import type { CallRefusal } from "./refusals";

/** The members a warning can have: its message, and its optional code and severity. */
const WARNING_MEMBERS: readonly string[] = Object.freeze(["message", "code", "severity"]);

/** The refusal of the member at `pointer`. */
function unreadable(pointer: string, name?: string): CallRefusal {
  return name === undefined
    ? { rule: "execute-answer-unreadable", pointer }
    : { rule: "execute-answer-unreadable", pointer, name };
}

/** Whether `value` is a count: a non-negative safe integer. */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Every way the warning at `pointer` is not the SDK's `Warning`: no plain record, refused once at its pointer; any own
 * key but its message, code and severity, named; a message that is missing, an accessor or not text; a code that is an
 * accessor or neither text nor a number; a severity that is an accessor or not text.
 */
function warningRefusals(warning: unknown, pointer: string): readonly CallRefusal[] {
  if (!isPlainRecord(warning)) return [unreadable(pointer)];
  const refusals: CallRefusal[] = [];
  for (const key of Object.getOwnPropertyNames(warning)) {
    if (!WARNING_MEMBERS.includes(key)) refusals.push(unreadable(pointerTo(pointer, key), key));
  }
  const message = readOwn(warning, "message");
  if (message.kind !== "data" || typeof message.value !== "string") {
    refusals.push(unreadable(pointerTo(pointer, "message")));
  }
  const code = readOwn(warning, "code");
  if (
    code.kind === "accessor" ||
    (code.kind === "data" && typeof code.value !== "string" && typeof code.value !== "number")
  ) {
    refusals.push(unreadable(pointerTo(pointer, "code")));
  }
  const severity = readOwn(warning, "severity");
  if (severity.kind === "accessor" || (severity.kind === "data" && typeof severity.value !== "string")) {
    refusals.push(unreadable(pointerTo(pointer, "severity")));
  }
  return refusals;
}

/**
 * Every way the first result's columns at `pointer` cannot key a row: no own data array, refused once at its pointer;
 * a column that is no object, or whose name is missing, an accessor, not text or empty, refused at the name's pointer;
 * and a name an earlier column of the result already has, refused at the later column's name.
 */
function columnRefusals(columns: unknown, pointer: string): readonly CallRefusal[] {
  if (!Array.isArray(columns)) return [unreadable(pointer)];
  const refusals: CallRefusal[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < columns.length; index++) {
    const name = readOwn(readOwnData(columns, String(index)), "name");
    const at = pointerTo(pointerTo(pointer, index), "name");
    if (name.kind !== "data" || typeof name.value !== "string" || name.value === "" || seen.has(name.value)) {
      refusals.push(unreadable(at));
      continue;
    }
    seen.add(name.value);
  }
  return refusals;
}

/**
 * Every way the first result of `results`, an own data array, cannot be read: its columns (`columnRefusals`), and an
 * own row count that is an accessor or not a count. A row count it does not have is not refused: a provider gives one
 * only where its engine answered it. A first result that is no object has no columns.
 */
function firstResultRefusals(results: readonly unknown[]): readonly CallRefusal[] {
  if (results.length === 0) return [];
  const source = readOwnData(results, "0");
  const refusals: CallRefusal[] = [...columnRefusals(readOwnData(source, "columns"), "/results/0/columns")];
  const rowCount = readOwn(source, "rowCount");
  if (rowCount.kind === "accessor" || (rowCount.kind === "data" && !isCount(rowCount.value))) {
    refusals.push(unreadable("/results/0/rowCount"));
  }
  return refusals;
}

/** The own data property `key` of `target`, or undefined when it is absent or an accessor. */
function readOwnData(target: unknown, key: string): unknown {
  const read = readOwn(target, key);
  return read.kind === "data" ? read.value : undefined;
}

/**
 * Every way `answer`, what a console execute answered, is not readable where the host reads it, in this order: the
 * result list at `/results`, an own data array; its first result's columns and row count (`firstResultRefusals`), no
 * later result read; the execution time at `/executionTimeMs`, a finite non-negative number; the warning list at
 * `/warnings`, an own data array, and each warning in it (`warningRefusals`). A member that is missing, an accessor or
 * not of its type is refused at its pointer, a key a warning cannot have is named, and no refusal carries a value.
 * Never throws: an answer that is no object has none of its members.
 */
export function checkExecuteAnswer(answer: unknown): readonly CallRefusal[] {
  const refusals: CallRefusal[] = [];
  const results = readOwn(answer, "results");
  if (results.kind === "data" && Array.isArray(results.value)) {
    refusals.push(...firstResultRefusals(results.value));
  } else {
    refusals.push(unreadable("/results"));
  }
  const executionTimeMs = readOwn(answer, "executionTimeMs");
  if (
    executionTimeMs.kind !== "data" ||
    typeof executionTimeMs.value !== "number" ||
    !Number.isFinite(executionTimeMs.value) ||
    executionTimeMs.value < 0
  ) {
    refusals.push(unreadable("/executionTimeMs"));
  }
  const warnings = readOwn(answer, "warnings");
  if (warnings.kind !== "data" || !Array.isArray(warnings.value)) {
    refusals.push(unreadable("/warnings"));
    return refusals;
  }
  const list: readonly unknown[] = warnings.value;
  for (let index = 0; index < list.length; index++) {
    refusals.push(...warningRefusals(readOwnData(list, String(index)), pointerTo("/warnings", index)));
  }
  return refusals;
}
