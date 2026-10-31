/**
 * The agent's reader of one SNMP statement: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure. It reads the text with the console's own parser (`parseStatement` in `statement.ts`) and resolves every name
 * with the console's own resolver (`resolveName` in `read.ts`), so a statement is read by one grammar wherever it is
 * written: the four commands `get`, `next`, `walk` and `table`, and `walk`'s `limit`, as the console writes them.
 * Everything else, a `set` included, is refused with the parser's sentence followed by agent mode's list of commands.
 *
 * WHAT IS WITHHELD, AND WHY BY PREFIX. The SNMP framework's security and target modules (1.3.6.1.6.3.12 to .16 and .18), the SSH,
 * TSM and TLS transport security modules, the USM Diffie-Hellman key-change objects and Net-SNMP's own access control
 * extension hold what an agent is reached and authorized with: community strings, SNMPv3 user names and keys, the
 * access control tables, the notification and proxy targets, the certificate-to-name maps. Their instance suffixes
 * encode those names (`vacmSecurityToGroupTable` is indexed by the security name, `nsVacmAccessTable` by the group
 * name), so a value is not the only thing that can carry one. Each is decided by the prefix of the parsed, resolved
 * identifier, never by the name the statement wrote, so `.1.3.6.1.6.3.18`, `1.3.6.1.6.3.18.1` and any spelling of it
 * meet the same rule. The roots are the module identities RFC 3413 (target, notification, proxy), RFC 3414
 * (user-based security), RFC 3415 (view-based access control), RFC 3584 (community), RFC 5592 (SSH), RFC 5591 (TSM),
 * RFC 6353 (TLS) and RFC 2786 (USM Diffie-Hellman) assign, and `netSnmpVacmMIB` in Net-SNMP's NET-SNMP-VACM-MIB; the
 * bundled MIB modules carry none of these eleven, so none of their names resolves here, and only a numeric identifier
 * reaches them.
 *
 * A `get` or a `next` that names an identifier inside one is admitted, and that identifier is never sent: its row is
 * answered withheld (`agent-read.ts`), since even a noSuchInstance would tell whether a guessed community exists. A
 * `walk` or a `table` whose subtree lies inside one, or is one, is refused here, before anything is sent. A `walk` or a
 * `table` whose subtree contains one is admitted and steps over it (`agent-read.ts`): no request starts inside it,
 * nothing of it is answered, and the answer carries its reason, so mib-2 (1.3.6.1.2.1), the enterprise subtree
 * (1.3.6.1.4.1) and even `walk 1.3` stay readable.
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

/** The eleven withheld subtrees, in agent order. */
export const SNMP_WITHHELD_SUBTREES: readonly SnmpWithheldSubtree[] = Object.freeze([
  {
    module: "SNMP-SSH-TM-MIB",
    root: [1, 3, 6, 1, 2, 1, 189],
    holds: "the SSH transport's session counters and the security names its sessions map to",
  },
  {
    module: "SNMP-TSM-MIB",
    root: [1, 3, 6, 1, 2, 1, 190],
    holds: "the transport security model's settings for how a security name is formed",
  },
  {
    module: "SNMP-TLS-TM-MIB",
    root: [1, 3, 6, 1, 2, 1, 198],
    holds: "the certificate fingerprints and the security names they map to, for the TLS and DTLS transports",
  },
  {
    module: "SNMP-USM-DH-OBJECTS-MIB",
    root: [1, 3, 6, 1, 3, 101],
    holds: "the Diffie-Hellman key-change objects of SNMPv3 users and their public values",
  },
  {
    module: "NET-SNMP-VACM-MIB",
    root: [1, 3, 6, 1, 4, 1, 8072, 1, 9],
    holds: "Net-SNMP's access control extension, indexed by the group names that may read or write each view",
  },
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

/**
 * The withheld subtrees an admitted walk of `subtree` steps over: every one it contains, in agent order. A subtree
 * that lies inside one, or is one, is refused before this is asked.
 */
export function withheldWithin(subtree: readonly number[]): readonly SnmpWithheldSubtree[] {
  return SNMP_WITHHELD_SUBTREES.filter((entry) => isWithinSubtree(subtree, entry.root));
}

/**
 * Where a walk resumes past a withheld subtree: the root with its last arc one higher, which every identifier inside
 * the root precedes, stepped again while it lands inside the next root (1.3.6.1.6.3.12 resumes at .17). A GetBulk from
 * there answers what follows it; an instance at exactly that identifier would be skipped, but no module identity's
 * sibling is an instance, so nothing outside the withheld roots is lost.
 */
export function resumeAfter(entry: SnmpWithheldSubtree): readonly number[] {
  const next = [...entry.root.slice(0, -1), (entry.root.at(-1) as number) + 1];
  const again = withheldSubtreeOf(next);
  return again === undefined ? next : resumeAfter(again);
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

/**
 * The withheld modules, each named with its own root before anything counts them, and what stays readable beside
 * them; every agent-facing sentence on SNMP uses these words. The six framework modules are named one by one, never
 * as "the modules under 1.3.6.1.6.3", since a model read that as the whole subtree withheld and refused an admitted
 * walk of it, which steps over the six and answers the engine and MPD objects.
 */
export const SNMP_WITHHELD_MODULES_TEXT =
  "Withheld from agent mode are SNMP-TARGET-MIB (1.3.6.1.6.3.12), SNMP-NOTIFICATION-MIB (1.3.6.1.6.3.13), SNMP-PROXY-MIB (1.3.6.1.6.3.14), SNMP-USER-BASED-SM-MIB (1.3.6.1.6.3.15), SNMP-VIEW-BASED-ACM-MIB (1.3.6.1.6.3.16) and SNMP-COMMUNITY-MIB (1.3.6.1.6.3.18), the transport security modules SNMP-SSH-TM-MIB (1.3.6.1.2.1.189), SNMP-TSM-MIB (1.3.6.1.2.1.190) and SNMP-TLS-TM-MIB (1.3.6.1.2.1.198), SNMP-USM-DH-OBJECTS-MIB (1.3.6.1.3.101) and Net-SNMP's NET-SNMP-VACM-MIB (1.3.6.1.4.1.8072.1.9), since they hold community strings, user names, keys and access rules; every other identifier under 1.3.6.1.6.3, the engine and MPD objects among them, is readable, and a walk that covers a withheld module steps over that module and answers the rest.";

const AGENT_READS = `Agent mode on SNMP reads with the console's four commands, one per read: get OID [OID ...] for the named instances, next OID [OID ...] for the instance after each, walk SUBTREE for every instance under a subtree, and table ENTRY for a conceptual table's rows, named by its entry (ifEntry), each OID written numerically (1.3.6.1.2.1.1.1.0) or by a name the bundled MIB modules define (sysDescr.0, ifTable, ifEntry). ${SNMP_WITHHELD_MODULES_TEXT}`;

export const SNMP_AGENT_SENTENCES = {
  reads: AGENT_READS,
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  /** `message` is the console parser's or resolver's refusal; the agent's commands follow it. */
  request: (message: string): string => `${message}. ${AGENT_READS} ${NOTHING_SENT}`,
  /** A walk or a table inside a withheld subtree; `written` is the subtree the statement named, resolved. */
  walkWithheld: (command: "walk" | "table", written: readonly number[], entry: SnmpWithheldSubtree): string =>
    `A ${command} of ${written.join(".")} would read inside ${entry.module} (${entry.root.join(".")}), which holds ${entry.holds} and is withheld from agent mode, so the ${command} is refused rather than read; walk a subtree outside it, such as mib-2 (1.3.6.1.2.1) or one of its groups. ${AGENT_READS} ${NOTHING_SENT}`,
} as const;

function refuse(code: SnmpAgentRefusalCode, message: string): SnmpAgentReading {
  return { ok: false, code, message };
}

/** The sentence of a refusal without a trailing full stop, so the agent's list follows it as one sentence. */
const bare = (message: string): string => message.replace(/\.$/, "");

/** The console parser's limit the encoder needs too: BER encodes an identifier of two sub-identifiers or more. */
const SHORT_IDENTIFIER = "an object identifier is sent with at least two sub-identifiers, such as 1.3";

/** The plan of one parsed statement, or why it is refused. Every name is resolved here, before anything is sent. */
function planOf(statement: Statement): SnmpAgentReading {
  const resolved =
    statement.command === "walk"
      ? [resolveName(statement.subtree)]
      : statement.command === "table"
        ? [resolveName(statement.table)]
        : statement.names.map(resolveName);
  if (resolved.some((oid) => oid.length < 2)) return refuse("request", SNMP_AGENT_SENTENCES.request(SHORT_IDENTIFIER));
  if (statement.command === "get" || statement.command === "next") {
    return { ok: true, plan: { command: statement.command, oids: resolved } };
  }
  const [subtree] = resolved;
  const inside = withheldSubtreeOf(subtree);
  if (inside !== undefined) {
    return refuse("withheld", SNMP_AGENT_SENTENCES.walkWithheld(statement.command, subtree, inside));
  }
  const maxRepetitions = firstRequest(statement).maxRepetitions as number;
  return statement.command === "walk"
    ? { ok: true, plan: { command: "walk", subtree, maxRepetitions } }
    : { ok: true, plan: { command: "table", table: subtree, maxRepetitions } };
}

/**
 * One agent statement read to the request the provider sends, or to why it sends nothing. Never sends anything.
 *
 * Read under the console's own walk budget whatever the run's row budget is, so the admission, which has no run, and
 * the provider read every statement alike. A walk's `limit N` is the console's: it sets the first GetBulk's
 * max-repetitions alone and caps no rows, so the row budget is the read's (`agent-read.ts`), not the statement's.
 */
export function readSnmpAgentStatement(text: string): SnmpAgentReading {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return refuse("request", SNMP_AGENT_SENTENCES.empty);
  try {
    return planOf(parseStatement(words, DEFAULT_WALK_BUDGET));
  } catch (error) {
    // The parser and the resolver refuse with a QueryError only; anything else is a defect and passes as it is.
    if (!(error instanceof QueryError)) throw error;
    return refuse("request", SNMP_AGENT_SENTENCES.request(bare(error.message)));
  }
}
