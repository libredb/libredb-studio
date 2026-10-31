/**
 * What agent mode never reads on an OPC UA server, decided by node id from the server's own address space.
 *
 * THE WITHHELD ROOTS ARE STANDARD NODES OF NAMESPACE 0, named by their numeric ids from the specification (Part 5 and
 * Part 12, and Part 14 for the PubSub key management objects), never by a browse name or a display name a server could
 * spell another way:
 *
 *  - `Server.ServerConfiguration` (i=12637): the certificate groups and their trust lists, the user management object
 *    whose `Users` names every account, the configuration file, and the methods that change them;
 *  - `Server.ServerCapabilities.RoleSet` (i=15606): every role with its identity mappings (user names, certificate
 *    thumbprints, group ids) and the applications and endpoints it admits;
 *  - `Server.ServerDiagnostics.SessionsDiagnosticsSummary` (i=3706) and its two arrays (i=3707, i=3708): one object per
 *    open session, measured on OPC PLC 2.15.10 carrying the client's application URI and name, the session's user
 *    identity and its history, and the endpoint it reached;
 *  - `Server.PublishSubscribe.SecurityGroups` (i=15443) and `KeyPushTargets` (i=25440): the PubSub key management
 *    objects, which name the groups keys are issued for and the servers keys are pushed to.
 *
 * A PER-SESSION NODE HAS NO STANDARD ID, which is why a table of ids is not enough on its own. Measured on the fixture,
 * an administrator's browse of i=3706 answered its own session as `ns=7;i=1324504778`, a number the server chose. So
 * before every agent read, on that read's own session, the subtree under every withheld root is walked through the same
 * Browse service the read uses (`withheldNodes`), and a node is withheld when it is one of the roots or any node the
 * server answers beneath one; nothing of the walk is kept for the next read. A root the server does not have
 * (`BadNodeIdUnknown`) has nothing beneath it; any other refusal, or a subtree larger than the walk reads, refuses the
 * agent read, because a node that could not be checked is not answered unchecked. The one exception is a browse the
 * server refuses to this identity with `BadUserAccessDenied`, measured on OPC PLC 2.15.10 for the session diagnostics
 * arrays (i=3707, i=3708) to an anonymous and a non-privileged session, which refused their Read too: the node stays
 * withheld and nothing beneath it is listed to this identity. A node beneath it that the server would still answer a
 * Read of, to the same identity that may not browse to it, is not in the set; that is a residual of the server's own
 * access rules, recorded in the provider document.
 *
 * Node ids are compared in one spelling (`canonicalNodeId`): namespace 0 written with or without `ns=0;`, and the
 * OPC Foundation's namespace URI written as `nsu=`, are one node. Any other `nsu=` is refused on the agent path, since
 * telling which namespace index it names would take a read of the server's namespace table.
 */
import type { OpcuaNodeId, OpcuaReadOnlyClient, OpcuaReference } from "./client";
import { browseChunkSize, chunked } from "./limits";

/** One standard node agent mode never reads, nor anything the server answers beneath it. */
export interface OpcuaWithheldNode {
  /** The node's browse path from the Server object, as the specification names it. */
  readonly kind: string;
  /** Its numeric id in namespace 0, in the canonical spelling. */
  readonly nodeId: OpcuaNodeId;
  /** What it holds, so the reason says why it is withheld. */
  readonly holds: string;
}

export const OPCUA_WITHHELD_NODES: readonly OpcuaWithheldNode[] = Object.freeze([
  {
    kind: "Server.ServerConfiguration",
    nodeId: "i=12637",
    holds:
      "the server's certificate groups and trust lists, its user management with every account name, its configuration file and the methods that change them",
  },
  {
    kind: "Server.ServerCapabilities.RoleSet",
    nodeId: "i=15606",
    holds:
      "every role's identity mappings (user names, certificate thumbprints, group ids) and the applications and endpoints each role admits",
  },
  {
    kind: "Server.ServerDiagnostics.SessionsDiagnosticsSummary",
    nodeId: "i=3706",
    holds: "one object per open session, with its client's application and name, its user identity and its endpoint",
  },
  {
    kind: "SessionsDiagnosticsSummary.SessionDiagnosticsArray",
    nodeId: "i=3707",
    holds: "every open session's client application and name and the endpoint it reached",
  },
  {
    kind: "SessionsDiagnosticsSummary.SessionSecurityDiagnosticsArray",
    nodeId: "i=3708",
    holds: "every open session's user identity, its identity history and how it authenticated",
  },
  {
    kind: "Server.PublishSubscribe.SecurityGroups",
    nodeId: "i=15443",
    holds: "the PubSub security groups that keys are issued for",
  },
  {
    kind: "Server.PublishSubscribe.KeyPushTargets",
    nodeId: "i=25440",
    holds: "the servers PubSub keys are pushed to, with their endpoints and identities",
  },
]);

/** Why one withheld node is not read, in the words every answer, refusal and grounding repeats. */
export function withheldReason(entry: OpcuaWithheldNode): string {
  return `${entry.kind} (${entry.nodeId}) is withheld from agent mode with everything beneath it: it holds ${entry.holds}. Nothing of it is read or answered.`;
}

/** The withheld kinds in one sentence, for the tool description, the grounding and the posture. */
export const OPCUA_WITHHELD_SENTENCE = `Withheld from agent mode, by node id with everything beneath it: ${OPCUA_WITHHELD_NODES.map(
  (entry) => `${entry.kind} (${entry.nodeId})`,
).join(
  ", ",
)}; they hold certificates and trust lists, account names, role identity mappings, every open session's client, user identity and endpoint, and the PubSub key management objects.`;

/** The OPC Foundation's namespace URI, which is namespace 0 on every server (Part 6 5.2.2.9). */
const OPC_FOUNDATION_NAMESPACE = "http://opcfoundation.org/UA/";

/**
 * One node id in the one spelling the agent path compares, or undefined for an `nsu=` form other than namespace 0's.
 *
 * `ns=0;i=85`, `i=85` and `nsu=http://opcfoundation.org/UA/;i=85` are one node; a GUID is compared in lower case,
 * since Part 6 5.1.12 writes it in hexadecimal and a server reads either case. A server answers ids as
 * `ns=0;i=2254` (measured on OPC PLC 2.15.10), so both sides go through this.
 */
export function canonicalNodeId(nodeId: OpcuaNodeId): OpcuaNodeId | undefined {
  let rest = nodeId;
  if (rest.startsWith("nsu=")) {
    const prefix = `nsu=${OPC_FOUNDATION_NAMESPACE};`;
    if (!rest.startsWith(prefix)) return undefined;
    rest = rest.slice(prefix.length);
    // `nsu=...;ns=N;` names a namespace twice; only the identifier may follow namespace 0's URI.
    if (rest.startsWith("ns=")) return undefined;
  } else if (rest.startsWith("ns=0;")) {
    rest = rest.slice("ns=0;".length);
  }
  // The namespace prefix ends at its own `;`: a String identifier may hold `;` itself, so the split is never the last.
  const namespace = /^ns=\d+;/.exec(rest)?.[0] ?? "";
  const identifier = rest.slice(namespace.length);
  return identifier.startsWith("g=") ? `${namespace}${identifier.toLowerCase()}` : rest;
}

/** The withheld root a node id names, or undefined. Pure: decides only the standard ids. */
export function withheldRootOf(nodeId: OpcuaNodeId): OpcuaWithheldNode | undefined {
  const canonical = canonicalNodeId(nodeId);
  return OPCUA_WITHHELD_NODES.find((entry) => entry.nodeId === canonical);
}

/** The most nodes the walk under the withheld roots reads, and the deepest level it reads to. */
export const OPCUA_WITHHELD_WALK_MAX_NODES = 2_000;
export const OPCUA_WITHHELD_WALK_MAX_DEPTH = 8;

/**
 * The one refusal of a browse the walk reads as "nothing beneath it is shown to this identity" rather than as a walk it
 * could not finish. Any other refusal refuses the agent read.
 */
const OPCUA_NOT_SHOWN = "BadUserAccessDenied";

/** Why the withheld walk could not be finished, which refuses the agent read. */
export class OpcuaWithheldWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpcuaWithheldWalkError";
  }
}

/** Every withheld node of this server, the roots and what the server answers beneath them, each with its root. */
export type OpcuaWithheldSet = ReadonlyMap<OpcuaNodeId, OpcuaWithheldNode>;

const refusedWalk = (status: string): string =>
  `Studio could not read what lies beneath the withheld parts of this server's address space (the server answered ${status} to a browse of them), so it cannot tell whether the read names one of them and refuses it rather than answer it unchecked.`;

/**
 * The withheld set of one session, read through its own Browse service before an agent read.
 *
 * Level by level, the roots first, in chunks the server will take, following and consuming every continuation point
 * inside this call. Methods are listed as members and never browsed, as everywhere in this provider. A node reached
 * under two roots keeps the first.
 */
export async function withheldNodes(
  client: Pick<OpcuaReadOnlyClient, "browse" | "browseNext">,
  chunk: number = browseChunkSize({}),
): Promise<OpcuaWithheldSet> {
  const set = new Map<OpcuaNodeId, OpcuaWithheldNode>();
  for (const entry of OPCUA_WITHHELD_NODES) set.set(entry.nodeId, entry);
  let frontier: { readonly nodeId: OpcuaNodeId; readonly root: OpcuaWithheldNode }[] = OPCUA_WITHHELD_NODES.map(
    (root) => ({ nodeId: root.nodeId, root }),
  );
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= OPCUA_WITHHELD_WALK_MAX_DEPTH)
      throw new OpcuaWithheldWalkError(
        `The withheld parts of this server's address space are deeper than the ${OPCUA_WITHHELD_WALK_MAX_DEPTH} levels Studio reads to check a read against them, so the read is refused rather than answered unchecked.`,
      );
    const next: { readonly nodeId: OpcuaNodeId; readonly root: OpcuaWithheldNode }[] = [];
    for (const batch of chunked(frontier, chunk)) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk of a level at a time, so the load on the server is fixed.
      const answers = await client.browse(batch.map((item) => item.nodeId));
      for (const [at, item] of batch.entries()) {
        const answer = answers[at];
        if (answer === undefined) throw new OpcuaWithheldWalkError(refusedWalk("nothing"));
        const unknownRoot = depth === 0 && answer.statusCode === "BadNodeIdUnknown";
        // The server shows this identity nothing beneath the node: measured on OPC PLC 2.15.10, an anonymous or a
        // non-privileged session's browse of the two session diagnostics arrays answers BadUserAccessDenied, and so
        // does its Read of them. The node stays withheld; what lies beneath it is not listed to this identity.
        if (unknownRoot || answer.statusCode === OPCUA_NOT_SHOWN) continue;
        if (!answer.statusCode.startsWith("Good") && !answer.statusCode.startsWith("Uncertain"))
          throw new OpcuaWithheldWalkError(refusedWalk(answer.statusCode));
        const references: OpcuaReference[] = [...answer.references];
        let point = answer.continuationPoint;
        while (point !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it.
          const [continued] = await client.browseNext([point]);
          if (continued === undefined) throw new OpcuaWithheldWalkError(refusedWalk("nothing"));
          if (!continued.statusCode.startsWith("Good") && !continued.statusCode.startsWith("Uncertain"))
            throw new OpcuaWithheldWalkError(refusedWalk(continued.statusCode));
          references.push(...continued.references);
          point = continued.continuationPoint;
        }
        for (const reference of references) {
          const id = canonicalNodeId(reference.nodeId) ?? reference.nodeId;
          if (set.has(id)) continue;
          set.set(id, item.root);
          if (set.size > OPCUA_WITHHELD_WALK_MAX_NODES + OPCUA_WITHHELD_NODES.length)
            throw new OpcuaWithheldWalkError(
              `The withheld parts of this server's address space hold more than the ${OPCUA_WITHHELD_WALK_MAX_NODES.toLocaleString("en-US")} nodes Studio reads to check a read against them, so the read is refused rather than answered unchecked.`,
            );
          if (reference.nodeClass !== "Method") next.push({ nodeId: reference.nodeId, root: item.root });
        }
      }
    }
    frontier = next;
  }
  return set;
}
