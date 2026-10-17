import type { KindCount } from "@/lib/db/types";
/**
 * The object groups this provider lists, and the order it lists them in.
 *
 * WHAT IS LISTED AND WHAT IT COSTS. The tree comes from the MIB modules this build carries, with
 * no traffic to the agent at all. That is a choice with a visible cost: the tree shows what the
 * modules define rather than what this agent answers, so a group may be listed that this agent
 * does not serve. The alternative, one GetNext per table to find out before listing it, is a
 * round trip per group at connect time and is not taken here. The cost is stated in the provider's own labels rather than hidden.
 *
 * WHY THE ORDER IS NUMERIC AND NOT TEXTUAL. An OID is a list of numbers, and an agent orders
 * instances by the VALUE of each sub-identifier (RFC 3416 section 4.2.2). Sorting the dotted
 * text instead puts 1.3.6.1.2.1.10 before 1.3.6.1.2.1.9, because "1" sorts before "9". Measured
 * on 13 October 2026 against the real arcs under mib-2: the two orders disagree from the second
 * entry onward, and on a page of five the textual order never shows twelve of the twenty-two.
 * So this module sorts by sub-identifier and the tests prove the two orders differ on the data
 * they use, rather than asserting an order that both would satisfy.
 */

/** The two kinds this provider publishes. There is no third, and no kind is invented per agent. */
import { QueryError } from "@/lib/db/errors";

export const SNMP_KINDS = ["table", "scalars"] as const;
export type SnmpKind = (typeof SNMP_KINDS)[number];

export interface SnmpObject {
  readonly kind: SnmpKind;
  /** The descriptor from the MIB, such as `ifTable`. */
  readonly name: string;
  /** The module that defines it, such as `IF-MIB`. */
  readonly module: string;
  /** Its OID as sub-identifiers, which is what the order below is taken from. */
  readonly oid: readonly number[];
}

/**
 * Compares two OIDs the way an agent does: sub-identifier by sub-identifier, by value, and a
 * prefix sorts before anything that extends it.
 */
export function compareOid(left: readonly number[], right: readonly number[]): number {
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/** The same comparison written the wrong way, kept so the tests can show the two disagree. */
export function compareOidAsText(left: readonly number[], right: readonly number[]): number {
  const a = left.join(".");
  const b = right.join(".");
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Objects in the order an agent would walk them. */
export function sortObjects(objects: readonly SnmpObject[]): SnmpObject[] {
  return [...objects].sort((a, b) => compareOid(a.oid, b.oid));
}

/**
 * Groups the objects by kind, each group still in agent order.
 *
 * Both kinds are always present, even when empty, because a kind that disappears when it holds
 * nothing makes "this agent has no tables" and "this build lists no tables" look the same.
 */
export function groupByKind(objects: readonly SnmpObject[]): Record<SnmpKind, SnmpObject[]> {
  const grouped: Record<SnmpKind, SnmpObject[]> = { table: [], scalars: [] };
  for (const object of sortObjects(objects)) grouped[object.kind].push(object);
  return grouped;
}

/** True when `candidate` is at or below `subtree`, which is what a walk's end test needs. */
export function isWithinSubtree(subtree: readonly number[], candidate: readonly number[]): boolean {
  if (candidate.length < subtree.length) return false;
  for (let i = 0; i < subtree.length; i += 1) if (subtree[i] !== candidate[i]) return false;
  return true;
}

/**
 * The next OID a walk should ask for after `seen`, or undefined when the walk has left its
 * subtree.
 *
 * A walk that does not check this loops: measured on 13 October 2026, the client library's own
 * `walk()` left the subtree it was given and returned 602 varbinds from a one-object group,
 * where its `subtree()` returned one.
 */
export function nextWithinSubtree(subtree: readonly number[], seen: readonly number[]): readonly number[] | undefined {
  return isWithinSubtree(subtree, seen) ? seen : undefined;
}

/**
 * Refuses a step that does not move forward.
 *
 * RFC 3416 section 4.2.2 defines GetNext by the lexicographic successor, so an answer at or
 * before where the walk already is means the agent is not advancing. Measured: the client
 * library accepts a backwards answer unless told not to, and Net-SNMP's own `snmpwalk` checks
 * by default because an out-of-order agent "can cause snmpwalk to loop indefinitely".
 */
export class WalkNotForward extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "WalkNotForward";
    Object.setPrototypeOf(this, WalkNotForward.prototype);
  }
}

export function assertMovesForward(previous: readonly number[], next: readonly number[]): void {
  if (compareOid(next, previous) > 0) return;
  throw new WalkNotForward(
    `the agent answered ${next.join(".")} after ${previous.join(".")}, which is not forward; a walk that accepts this does not end`,
  );
}

/**
 * Why a count could not be taken. Each is a measured case, not a placeholder.
 *
 * These were drafted in a `provider-surface.ts` written against local type aliases, before this
 * directory existed. The directory exists, so they live here against the real shared type and
 * the draft is gone: a second copy of a contract is a copy that stops agreeing with the first.
 */
export const UNAVAILABLE_REASONS = {
  /** This provider does not send a request to count; the tree is built from the MIB. */
  notAsked: "counts are not read from the agent: the object tree comes from the bundled MIB modules",
  /** A read outside the agent's view is indistinguishable from absence, so zero is not claimed. */
  outsideView:
    "the agent answered as though the objects do not exist, which is also what a read outside its view looks like, so no count is claimed",
  /** The walk ended on a budget, so what it saw is a floor and not a count. */
  budgetReached: "the walk ended on a budget before the subtree did, so the number seen is a floor and not a count",
  /** A value no datagram can carry ended the walk. */
  valueTooLarge: "the walk stopped at an object no message can carry, so the remainder was never seen",
} as const;

export type UnavailableReason = keyof typeof UNAVAILABLE_REASONS;

/**
 * A count taken from a walk that actually ran, which is the only case a number is allowed.
 *
 * `complete` is the walk's own answer to whether it reached the end of its subtree. It is not
 * inferred from the absence of an error, because over SNMPv2c a walk that hit a value no
 * datagram can carry ends with no error at all: measured on 13 October 2026, four of five rows
 * and an ordinary end of walk. A caller that reads that as completion reports a short table as
 * a whole one.
 */
export function countFromWalk(seen: number, complete: boolean, stoppedBy?: UnavailableReason): KindCount {
  if (complete) return { count: seen, sampledFrom: "a walk that reached the end of its subtree" };
  return { unavailable: UNAVAILABLE_REASONS[stoppedBy ?? "budgetReached"] };
}
