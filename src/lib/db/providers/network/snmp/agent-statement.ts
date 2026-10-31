/**
 * The agent's reader of one SNMP statement: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. It reads the text with the console's own parser (`parseStatement` in `statement.ts`) and resolves every name
 * with the console's own resolver (`resolveName` in `read.ts`), so a statement is read by one grammar wherever it is
 * written: the four commands `get`, `next`, `walk` and `table`, and `walk`'s `limit`, as the console writes them.
 * Everything else, a `set` included, is refused with the parser's sentence followed by agent mode's list of commands.
 *
 * WHAT IS WITHHELD, AND WHY BY PREFIX. The SNMP framework's security and target modules under 1.3.6.1.6.3 hold what
 * an agent is reached and authorized with: community strings, SNMPv3 user names, the access control tables, the
 * notification and proxy targets. Their instance suffixes encode those names (`vacmSecurityToGroupTable` is indexed by
 * the security name), so a value is not the only thing that can carry one. Each is decided by the prefix of the
 * parsed, resolved identifier, never by the name the statement wrote, so `.1.3.6.1.6.3.18`, `1.3.6.1.6.3.18.1` and any
 * spelling of it meet the same rule. The roots are the module identities RFC 3413 (target, notification, proxy), RFC
 * 3414 (user-based security), RFC 3415 (view-based access control) and RFC 3584 (community) assign; the bundled MIB
 * modules carry none of these six, so none of their names resolves here, and only a numeric identifier reaches them.
 *
 * A `get` or a `next` that names an identifier inside one is admitted, and that identifier is never sent: its row is
 * answered withheld (`agent-read.ts`), since even a noSuchInstance would tell whether a guessed community exists. A
 * `walk` or a `table` whose subtree contains one of them, or lies inside one, is refused here, before anything is sent:
 * refusing is simpler than walking around them, and it blocks no read of mib-2 (1.3.6.1.2.1) or of the enterprise
 * subtree (1.3.6.1.4.1).
 *
 * Not the boundary. The boundary is the provider's structural closed table: the agent's reads reach the socket only
 * through `SnmpAgentClient` (`agent-client.ts`), which holds Get, GetNext and GetBulk alone, behind the valve that
 * refuses any other PDU. This is what lets the model read why it was refused, before anything is sent.
 */
import { QueryError } from "@/lib/db/errors";
import { isWithinSubtree } from "./objects";
import { firstRequest, resolveName } from "./read";
import { DEFAULT_WALK_BUDGET, parseStatement, type Statement } from "./statement";

export type SnmpAgentRefusalCode = "request" | "withheld";

/** One subtree agent mode never reads, the module that defines it, and what it holds. */
export interface SnmpWithheldSubtree {
  readonly module: string;
  readonly root: readonly number[];
  readonly holds: string;
}

/** The six withheld subtrees, in agent order. */
export const SNMP_WITHHELD_SUBTREES: readonly SnmpWithheldSubtree[] = Object.freeze([
  {
    module: "SNMP-TARGET-MIB",
    root: [1, 3, 6, 1, 6, 3, 12],
    holds: "the addresses notifications and proxied requests are sent to, and the security names that reach them",
  },
  {
    module: "SNMP-NOTIFICATION-MIB",
    root: [1, 3, 6, 1, 6, 3, 13],
    holds: "the notification filters and the targets they name",
  },
  {
    module: "SNMP-PROXY-MIB",
    root: [1, 3, 6, 1, 6, 3, 14],
    holds: "the proxy forwarding rules and the security names they map",
  },
  {
    module: "SNMP-USER-BASED-SM-MIB",
    root: [1, 3, 6, 1, 6, 3, 15],
    holds: "the SNMPv3 user names and their key-change objects",
  },
  {
    module: "SNMP-VIEW-BASED-ACM-MIB",
    root: [1, 3, 6, 1, 6, 3, 16],
    holds: "the access control tables, indexed by the security names that may read or write each view",
  },
  {
    module: "SNMP-COMMUNITY-MIB",
    root: [1, 3, 6, 1, 6, 3, 18],
    holds: "the community strings and the security names they map to",
  },
]);

/** The withheld subtree an identifier lies inside, or undefined. */
export function withheldSubtreeOf(oid: readonly number[]): SnmpWithheldSubtree | undefined {
  return SNMP_WITHHELD_SUBTREES.find((entry) => isWithinSubtree(entry.root, oid));
}

/** The withheld subtree a walk of `subtree` would reach: one it contains, or one it lies inside. */
function withheldWalkReaches(subtree: readonly number[]): SnmpWithheldSubtree | undefined {
  return SNMP_WITHHELD_SUBTREES.find(
    (entry) => isWithinSubtree(subtree, entry.root) || isWithinSubtree(entry.root, subtree),
  );
}

/** The sentence a withheld row carries: the module, its root, what it holds, and that nothing of it is answered. */
export function withheldReason(entry: SnmpWithheldSubtree): string {
  return `${entry.module} (${entry.root.join(".")}) is withheld from agent mode: it holds ${entry.holds}, so no value or instance of it is read or answered.`;
}

/** One read the agent may send, every name already resolved to its identifier. */
export type SnmpAgentPlan =
  | { readonly command: "get"; readonly oids: readonly (readonly number[])[] }
  | { readonly command: "next"; readonly oids: readonly (readonly number[])[] }
  | { readonly command: "walk"; readonly subtree: readonly number[]; readonly maxRepetitions: number }
  | { readonly command: "table"; readonly table: readonly number[]; readonly maxRepetitions: number };

export type SnmpAgentReading =
  | { readonly ok: true; readonly plan: SnmpAgentPlan }
  | { readonly ok: false; readonly code: SnmpAgentRefusalCode; readonly message: string };

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  "Agent mode on SNMP reads with the console's four commands, one per read: get OID [OID ...] for the named instances, next OID [OID ...] for the instance after each, walk SUBTREE [limit N] for every instance under a subtree, and table ENTRY for a conceptual table's rows, named by its entry (ifEntry), each OID written numerically (1.3.6.1.2.1.1.1.0) or by a name the bundled MIB modules define (sysDescr.0, ifTable, ifEntry); the security and target modules under 1.3.6.1.6.3 (SNMP-TARGET-MIB, SNMP-NOTIFICATION-MIB, SNMP-PROXY-MIB, SNMP-USER-BASED-SM-MIB, SNMP-VIEW-BASED-ACM-MIB and SNMP-COMMUNITY-MIB) are withheld.";

export const SNMP_AGENT_SENTENCES = {
  reads: AGENT_READS,
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  /** `message` is the console parser's or resolver's refusal; the agent's commands follow it. */
  request: (message: string): string => `${message}. ${AGENT_READS} ${NOTHING_SENT}`,
  /** A walk or a table reaching a withheld subtree; `written` is the subtree the statement named, resolved. */
  walkWithheld: (command: "walk" | "table", written: readonly number[], entry: SnmpWithheldSubtree): string =>
    `A ${command} of ${written.join(".")} would read inside ${entry.module} (${entry.root.join(".")}), which holds ${entry.holds} and is withheld from agent mode, so the ${command} is refused rather than read; walk a subtree that does not reach it, such as mib-2 (1.3.6.1.2.1) or one of its groups. ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: SnmpAgentRefusalCode, message: string): SnmpAgentReading {
  return { ok: false, code, message };
}

/** The sentence of a refusal without a trailing full stop, so the agent's list follows it as one sentence. */
const bare = (message: string): string => message.replace(/\.$/, "");

/** The plan of one parsed statement, or why it is refused. Every name is resolved here, before anything is sent. */
function planOf(statement: Statement): SnmpAgentReading {
  switch (statement.command) {
    case "get":
    case "next":
      return { ok: true, plan: { command: statement.command, oids: statement.names.map(resolveName) } };
    case "walk": {
      const subtree = resolveName(statement.subtree);
      const reached = withheldWalkReaches(subtree);
      if (reached !== undefined) return refuse("withheld", SNMP_AGENT_SENTENCES.walkWithheld("walk", subtree, reached));
      const maxRepetitions = firstRequest(statement).maxRepetitions as number;
      return { ok: true, plan: { command: "walk", subtree, maxRepetitions } };
    }
    case "table": {
      const table = resolveName(statement.table);
      const reached = withheldWalkReaches(table);
      if (reached !== undefined) return refuse("withheld", SNMP_AGENT_SENTENCES.walkWithheld("table", table, reached));
      const maxRepetitions = firstRequest(statement).maxRepetitions as number;
      return { ok: true, plan: { command: "table", table, maxRepetitions } };
    }
  }
}

/**
 * One agent statement read to the request the provider sends, or to why it sends nothing. Never sends anything.
 *
 * `maxRows` is the request's row budget: a `walk ... limit N` above it is refused by the console's own rule, as a walk
 * above the console's budget is.
 */
export function readSnmpAgentStatement(text: string, maxRows: number = DEFAULT_WALK_BUDGET.rows): SnmpAgentReading {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return refuse("request", SNMP_AGENT_SENTENCES.empty);
  try {
    return planOf(parseStatement(words, { ...DEFAULT_WALK_BUDGET, rows: maxRows }));
  } catch (error) {
    // The parser and the resolver refuse with a QueryError only; anything else is a defect and passes as it is.
    if (!(error instanceof QueryError)) throw error;
    return refuse("request", SNMP_AGENT_SENTENCES.request(bare(error.message)));
  }
}
