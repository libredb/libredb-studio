import { QueryError } from "@/lib/db/errors";
/**
 * One read statement, parsed into the request it will become.
 *
 * Four commands and no fifth: `get`, `next`, `walk` and `table`. There is no `bulkwalk` even
 * though Net-SNMP's tools have one, because that pair exists only to choose between GetNext and
 * GetBulk, and with SNMPv1 out of scope every walk here can use GetBulk and fall back to GetNext
 * for the one step GetBulk cannot take.
 *
 * WHAT THIS MODULE REFUSES, AND WHY IT IS THIS MODULE'S JOB. The bounds below are the SMI's, and
 * the measured reason for enforcing them here is that nothing downstream does. On 13 October
 * 2026 the client library's own MIB parser accepted all three of the violations RFC 2578 names:
 * 130 sub-identifiers where the limit is 128, a 66-character descriptor where the limit is 64,
 * and a sub-identifier above 2^32-1. A name that reaches the wire unbounded is a name nobody
 * checked.
 *
 * It also refuses a request it knows is too large to send. Measured against Net-SNMP snmpd
 * 5.9.4: a Get carrying 600 small OIDs raised EMSGSIZE on our own socket and never reached the
 * agent, while 500 carried. A local error number is not a reading of an agent, so the statement
 * is stopped here, where the user can be told what to ask instead.
 */

/** RFC 2578 section 3.5: at most 128 sub-identifiers, each at most 2^32-1. */
const MAX_SUB_IDENTIFIERS = 128;
const MAX_SUB_IDENTIFIER = 4294967295;
/** RFC 2578 section 3.1: a descriptor is at most 64 characters. */
const MAX_DESCRIPTOR = 64;
/**
 * RFC 3416 section 2.3: "under conditions of network stress, only small values should be used
 * for max-repetitions". The agent's own limit is invisible, and the fixture's unbounded setting
 * ended in an out-of-memory kill, so this is ours and it is low.
 */
export const MAX_REPETITIONS_CAP = 50;
/**
 * The point past which a request is not sent.
 *
 * The two numbers beside it are the measurement it came from, and they are exported because a
 * test that only says `MAX_VARBINDS_PER_REQUEST + 1` follows this constant wherever it goes:
 * the mechanism is held, the number is free, and dropping it to 1 would cripple every batched
 * read without turning a single test red. Keeping the measurement here lets a test say what
 * the cap has to sit between, rather than restating it.
 */
export const MAX_VARBINDS_PER_REQUEST = 400;
/** Measured against the fixture agent: this many small OIDs went out in one datagram. */
export const MEASURED_VARBINDS_CARRIED = 500;
/** Measured against the fixture agent: this many raised EMSGSIZE before anything was sent. */
export const MEASURED_VARBINDS_REFUSED = 600;

export class StatementError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "StatementError";
    Object.setPrototypeOf(this, StatementError.prototype);
  }
}

/** A name the user wrote, in one of the three forms this provider reads. */
export type ObjectName =
  | { readonly form: "numeric"; readonly oid: readonly number[] }
  | { readonly form: "descriptor"; readonly descriptor: string; readonly instance?: readonly number[] }
  /** `MODULE::descriptor`. Whether `module.descriptor` is also accepted is still open. */
  | {
      readonly form: "qualified";
      readonly module: string;
      readonly descriptor: string;
      readonly instance?: readonly number[];
    };

export interface WalkBudget {
  readonly rows: number;
  readonly inboundBytes: number;
  readonly requests: number;
  readonly wallMs: number;
}

/**
 * Defaults anchored to a measurement rather than to a round number: walking the fixture's
 * default view took 3,860 requests for 3,858 objects and between 0.4 and 0.9 MB inbound, and
 * walking mib-2 alone took 2,176 requests for 2,176 objects. A budget below those stops a walk
 * of the whole tree, which is the intent.
 */
export const DEFAULT_WALK_BUDGET: WalkBudget = {
  rows: 5000,
  inboundBytes: 4 * 1024 * 1024,
  requests: 5000,
  wallMs: 30_000,
};

export type Statement =
  | { readonly command: "get"; readonly names: readonly ObjectName[] }
  | { readonly command: "next"; readonly names: readonly ObjectName[] }
  | { readonly command: "walk"; readonly subtree: ObjectName; readonly limit?: number; readonly budget: WalkBudget }
  | { readonly command: "table"; readonly table: ObjectName };

/** Checks one dotted OID against the SMI's bounds and returns its sub-identifiers. */
export function parseNumericOid(text: string): readonly number[] {
  const body = text.startsWith(".") ? text.slice(1) : text;
  if (body === "") throw new StatementError("an object identifier needs at least one sub-identifier");
  const parts = body.split(".");
  if (parts.length > MAX_SUB_IDENTIFIERS) {
    throw new StatementError(
      `an object identifier holds at most ${MAX_SUB_IDENTIFIERS} sub-identifiers (RFC 2578 section 3.5), this one holds ${parts.length}`,
    );
  }
  return parts.map((part) => {
    if (!/^\d+$/.test(part)) throw new StatementError(`\`${part}\` is not a sub-identifier`);
    const value = Number(part);
    if (value > MAX_SUB_IDENTIFIER) {
      throw new StatementError(
        `a sub-identifier is at most ${MAX_SUB_IDENTIFIER} (RFC 2578 section 3.5), this one is ${part}`,
      );
    }
    return value;
  });
}

function checkDescriptor(descriptor: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(descriptor)) {
    throw new StatementError(
      `\`${descriptor}\` is not a descriptor: a descriptor starts with a letter and holds letters, digits and hyphens`,
    );
  }
  if (descriptor.length > MAX_DESCRIPTOR) {
    throw new StatementError(
      `a descriptor is at most ${MAX_DESCRIPTOR} characters (RFC 2578 section 3.1), this one is ${descriptor.length}`,
    );
  }
  return descriptor;
}

/** Reads one object name in any of the three forms. */
export function parseObjectName(text: string): ObjectName {
  if (text === "") throw new StatementError("an object name cannot be empty");
  if (/^\.?\d/.test(text)) return { form: "numeric", oid: parseNumericOid(text) };

  const [qualifier, rest] = text.includes("::") ? text.split("::", 2) : [undefined, text];
  if (qualifier !== undefined) checkDescriptor(qualifier);
  const dot = rest.indexOf(".");
  const descriptor = checkDescriptor(dot === -1 ? rest : rest.slice(0, dot));
  const instance = dot === -1 ? undefined : parseNumericOid(rest.slice(dot + 1));
  return qualifier === undefined
    ? { form: "descriptor", descriptor, instance }
    : { form: "qualified", module: qualifier, descriptor, instance };
}

/**
 * Reads a lexed statement. The words arrive already split by the shared lexer, so quoting is
 * settled before this module sees anything and there is no second set of quoting rules here.
 */
export function parseStatement(words: readonly string[], budget: WalkBudget = DEFAULT_WALK_BUDGET): Statement {
  if (words.length === 0) throw new StatementError("an empty statement reads nothing");
  const [command, ...rest] = words;

  if (command === "get" || command === "next") {
    if (rest.length === 0) throw new StatementError(`\`${command}\` needs at least one object`);
    if (rest.length > MAX_VARBINDS_PER_REQUEST) {
      throw new StatementError(
        `\`${command}\` carries at most ${MAX_VARBINDS_PER_REQUEST} objects in one request: beyond that the request does not fit a datagram and is never sent, which is not an answer from the agent`,
      );
    }
    return { command, names: rest.map(parseObjectName) };
  }

  if (command === "walk") {
    if (rest.length === 0) throw new StatementError("`walk` needs a subtree");
    const subtree = parseObjectName(rest[0]);
    if (rest.length === 1) return { command: "walk", subtree, budget };
    if (rest.length !== 3 || rest[1] !== "limit") {
      throw new StatementError("`walk` takes one subtree and an optional `limit <n>`");
    }
    const limit = Number(rest[2]);
    if (!Number.isInteger(limit) || limit < 1)
      throw new StatementError("`limit` takes a whole number of rows, one or more");
    if (limit > budget.rows) throw new StatementError(`\`limit\` is above this walk's row budget of ${budget.rows}`);
    return { command: "walk", subtree, limit, budget };
  }

  if (command === "table") {
    if (rest.length !== 1) throw new StatementError("`table` takes one table");
    return { command: "table", table: parseObjectName(rest[0]) };
  }

  if (command === "set" || command === "trap" || command === "inform") {
    throw new StatementError(`\`${command}\` is not a command this provider has: it reads and never writes`);
  }
  if (command === "bulkwalk") {
    throw new StatementError("`bulkwalk` is not a separate command here: `walk` uses GetBulk already");
  }
  throw new StatementError(`\`${command}\` is not a command: this provider reads with get, next, walk and table`);
}

/**
 * The varbind count a GetBulk will draw, computed before it is sent.
 *
 * RFC 3416 section 4.2.3 gives it as N + (M * R): the non-repeaters, plus max-repetitions times
 * the number of repeating names. The agent's own ceiling is invisible, so this is checked here
 * rather than discovered from a response that may be silence.
 */
export function bulkVarbindCount(nonRepeaters: number, maxRepetitions: number, repeaters: number): number {
  return nonRepeaters + maxRepetitions * repeaters;
}

export function checkBulkRequest(nonRepeaters: number, maxRepetitions: number, repeaters: number): void {
  if (maxRepetitions > MAX_REPETITIONS_CAP) {
    throw new StatementError(
      `max-repetitions is capped at ${MAX_REPETITIONS_CAP} here, because an agent's own limit is not visible from this side`,
    );
  }
  if (maxRepetitions < 1) throw new StatementError("max-repetitions is one or more");
  const total = bulkVarbindCount(nonRepeaters, maxRepetitions, repeaters);
  if (total > MAX_VARBINDS_PER_REQUEST) {
    throw new StatementError(
      `this GetBulk would draw ${total} varbinds, above the ${MAX_VARBINDS_PER_REQUEST} one answer carries here`,
    );
  }
}
