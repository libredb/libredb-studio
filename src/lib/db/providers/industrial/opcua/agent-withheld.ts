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
 * NAMESPACE 0 IS READ FROM A LIST, NOT AROUND ONE. Every standard node beneath a withheld root has a fixed id in
 * namespace 0 (the TrustList of the default application group is i=12642, the Anonymous role i=15644 and its
 * Identities i=16192), and a server may refuse this identity a Browse of the root while answering a Read of such a
 * child. So no walk decides namespace 0: agent mode reads only the namespace-0 nodes `OPCUA_AGENT_NAMESPACE0` lists,
 * the Root and Objects folders, the Server object and the parts of it that describe the server's state and limits, and
 * refuses every other namespace-0 node with its reason, whatever a walk saw. The list holds no node beneath a
 * withheld root, so their standard descendants are refused by id even where no walk can see them. It is a list of the
 * whole namespace rather than of the Server object's part of it, because which standard nodes a server hangs under
 * its Server object is not decidable by id: `ServerConfiguration`, `PublishSubscribe` and the well-known roles are
 * standalone ids in namespace 0 that a server references from there.
 *
 * A PER-SESSION NODE HAS NO STANDARD ID, which is why the list is not enough on its own. Measured on the fixture, an
 * administrator's browse of i=3706 answered its own session as `ns=7;i=1324504778`, a number the server chose. So
 * before every agent read, on that read's own session, the subtree under every withheld root is walked through the
 * same Browse service the read uses (`withheldNodes`), and a node is withheld when it is one of the roots or any node
 * the server answers beneath one; nothing of the walk is kept for the next read. A root the server does not have
 * (`BadNodeIdUnknown`) has nothing beneath it; a node whose browse the server refuses to this identity
 * (`BadUserAccessDenied`, measured on OPC PLC 2.15.10 for the two session diagnostics arrays to an anonymous and a
 * non-privileged session) is a walk that could not be finished, so every node outside namespace 0 the read answers is
 * then decided from the other side (`deniedAncestry`): its parents are read upward through an inverse Browse to
 * namespace 0, and it is withheld when any of them is, refused when they cannot all be read. Any other refusal, or a
 * subtree larger than the walk reads, refuses the agent read, because a node that could not be checked is not
 * answered unchecked.
 *
 * NODE IDS ARE COMPARED AS ONE KEY (`canonicalNodeId`): namespace 0 written with or without `ns=0;`, a GUID in lower
 * case, an opaque ByteString re-encoded as padded base64 (a decoder takes it unpadded and with stray trailing bits, so
 * `b=AQ`, `b=AR==` and `b=AQ==` are one node), and an `nsu=` namespace URI turned into its index through the server's
 * own NamespaceArray (i=2255), read on the read's session when an id needs it. An id that cannot be put in that form
 * (a URI the table does not hold, an identifier that does not decode) refuses the read.
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

/**
 * The namespace-0 nodes agent mode reads, each by its numeric id and its browse path in Part 5, and no other.
 *
 * The folders a browse starts from; the Server object; and under it what describes the server's state and limits:
 * ServerArray, NamespaceArray, ServerStatus with every child, ServiceLevel, Auditing, ServerCapabilities with every
 * standard child but RoleSet, and ServerDiagnostics with its EnabledFlag and the ServerDiagnosticsSummary counters.
 * Not the session or subscription diagnostics, not VendorServerInfo, ServerRedundancy or Namespaces, and no method.
 */
export const OPCUA_AGENT_NAMESPACE0: readonly { readonly nodeId: OpcuaNodeId; readonly path: string }[] = Object.freeze(
  (
    [
      [84, "Root"],
      [85, "Objects"],
      [2253, "Server"],
      [2254, "Server.ServerArray"],
      [2255, "Server.NamespaceArray"],
      [2256, "Server.ServerStatus"],
      [2257, "Server.ServerStatus.StartTime"],
      [2258, "Server.ServerStatus.CurrentTime"],
      [2259, "Server.ServerStatus.State"],
      [2260, "Server.ServerStatus.BuildInfo"],
      [2261, "Server.ServerStatus.BuildInfo.ProductName"],
      [2262, "Server.ServerStatus.BuildInfo.ProductUri"],
      [2263, "Server.ServerStatus.BuildInfo.ManufacturerName"],
      [2264, "Server.ServerStatus.BuildInfo.SoftwareVersion"],
      [2265, "Server.ServerStatus.BuildInfo.BuildNumber"],
      [2266, "Server.ServerStatus.BuildInfo.BuildDate"],
      [2992, "Server.ServerStatus.SecondsTillShutdown"],
      [2993, "Server.ServerStatus.ShutdownReason"],
      [2267, "Server.ServiceLevel"],
      [2994, "Server.Auditing"],
      [2268, "Server.ServerCapabilities"],
      [2269, "Server.ServerCapabilities.ServerProfileArray"],
      [2271, "Server.ServerCapabilities.LocaleIdArray"],
      [2272, "Server.ServerCapabilities.MinSupportedSampleRate"],
      [2735, "Server.ServerCapabilities.MaxBrowseContinuationPoints"],
      [2736, "Server.ServerCapabilities.MaxQueryContinuationPoints"],
      [2737, "Server.ServerCapabilities.MaxHistoryContinuationPoints"],
      [3704, "Server.ServerCapabilities.SoftwareCertificates"],
      [11702, "Server.ServerCapabilities.MaxArrayLength"],
      [11703, "Server.ServerCapabilities.MaxStringLength"],
      [12911, "Server.ServerCapabilities.MaxByteStringLength"],
      [19812, "Server.ServerCapabilities.MaxLogObjectContinuationPoints"],
      [24095, "Server.ServerCapabilities.MaxSessions"],
      [24096, "Server.ServerCapabilities.MaxSubscriptions"],
      [24097, "Server.ServerCapabilities.MaxMonitoredItems"],
      [24098, "Server.ServerCapabilities.MaxSubscriptionsPerSession"],
      [24099, "Server.ServerCapabilities.MaxSelectClauseParameters"],
      [24100, "Server.ServerCapabilities.MaxWhereClauseParameters"],
      [24101, "Server.ServerCapabilities.ConformanceUnits"],
      [24104, "Server.ServerCapabilities.MaxMonitoredItemsPerSubscription"],
      [31916, "Server.ServerCapabilities.MaxMonitoredItemsQueueSize"],
      [2996, "Server.ServerCapabilities.ModellingRules"],
      [2997, "Server.ServerCapabilities.AggregateFunctions"],
      [11704, "Server.ServerCapabilities.OperationLimits"],
      [11705, "Server.ServerCapabilities.OperationLimits.MaxNodesPerRead"],
      [11707, "Server.ServerCapabilities.OperationLimits.MaxNodesPerWrite"],
      [11709, "Server.ServerCapabilities.OperationLimits.MaxNodesPerMethodCall"],
      [11710, "Server.ServerCapabilities.OperationLimits.MaxNodesPerBrowse"],
      [11711, "Server.ServerCapabilities.OperationLimits.MaxNodesPerRegisterNodes"],
      [11712, "Server.ServerCapabilities.OperationLimits.MaxNodesPerTranslateBrowsePathsToNodeIds"],
      [11713, "Server.ServerCapabilities.OperationLimits.MaxNodesPerNodeManagement"],
      [11714, "Server.ServerCapabilities.OperationLimits.MaxMonitoredItemsPerCall"],
      [12165, "Server.ServerCapabilities.OperationLimits.MaxNodesPerHistoryReadData"],
      [12166, "Server.ServerCapabilities.OperationLimits.MaxNodesPerHistoryReadEvents"],
      [12167, "Server.ServerCapabilities.OperationLimits.MaxNodesPerHistoryUpdateData"],
      [12168, "Server.ServerCapabilities.OperationLimits.MaxNodesPerHistoryUpdateEvents"],
      [2274, "Server.ServerDiagnostics"],
      [2294, "Server.ServerDiagnostics.EnabledFlag"],
      [2275, "Server.ServerDiagnostics.ServerDiagnosticsSummary"],
      [2276, "Server.ServerDiagnostics.ServerDiagnosticsSummary.ServerViewCount"],
      [2277, "Server.ServerDiagnostics.ServerDiagnosticsSummary.CurrentSessionCount"],
      [2278, "Server.ServerDiagnostics.ServerDiagnosticsSummary.CumulatedSessionCount"],
      [2279, "Server.ServerDiagnostics.ServerDiagnosticsSummary.SecurityRejectedSessionCount"],
      [3705, "Server.ServerDiagnostics.ServerDiagnosticsSummary.RejectedSessionCount"],
      [2281, "Server.ServerDiagnostics.ServerDiagnosticsSummary.SessionTimeoutCount"],
      [2282, "Server.ServerDiagnostics.ServerDiagnosticsSummary.SessionAbortCount"],
      [2284, "Server.ServerDiagnostics.ServerDiagnosticsSummary.PublishingIntervalCount"],
      [2285, "Server.ServerDiagnostics.ServerDiagnosticsSummary.CurrentSubscriptionCount"],
      [2286, "Server.ServerDiagnostics.ServerDiagnosticsSummary.CumulatedSubscriptionCount"],
      [2287, "Server.ServerDiagnostics.ServerDiagnosticsSummary.SecurityRejectedRequestsCount"],
      [2288, "Server.ServerDiagnostics.ServerDiagnosticsSummary.RejectedRequestsCount"],
    ] as const
  ).map(([id, path]) => Object.freeze({ nodeId: `i=${id}`, path })),
);

const NAMESPACE0_READ: ReadonlySet<OpcuaNodeId> = new Set(OPCUA_AGENT_NAMESPACE0.map((entry) => entry.nodeId));

/** What every namespace-0 node outside the list is refused as: not a withheld root, and not on the list. */
export const OPCUA_NAMESPACE0_OUTSIDE: OpcuaWithheldNode = Object.freeze({
  kind: "Namespace 0 outside agent mode's list",
  nodeId: "ns=0",
  holds:
    "standard nodes agent mode does not read: beside the type definitions, the server's configuration, roles, sessions, subscriptions, redundancy and namespace metadata live in namespace 0, and only the Root and Objects folders, the Server object, ServerArray, NamespaceArray, ServerStatus, ServiceLevel, Auditing, ServerCapabilities without its RoleSet, and ServerDiagnostics with its EnabledFlag and ServerDiagnosticsSummary counters are read",
});

/** Why one withheld node is not read, in the words every answer, refusal and grounding repeats. */
export function withheldReason(entry: OpcuaWithheldNode): string {
  if (entry === OPCUA_NAMESPACE0_OUTSIDE)
    return `A namespace-0 node outside agent mode's list is not read: namespace 0 holds ${entry.holds}. Nothing of it is read or answered.`;
  return `${entry.kind} (${entry.nodeId}) is withheld from agent mode with everything beneath it: it holds ${entry.holds}. Nothing of it is read or answered.`;
}

/** The withheld kinds in one sentence, for the tool description, the grounding and the posture. */
export const OPCUA_WITHHELD_SENTENCE = `Withheld from agent mode, by node id with everything beneath it: ${OPCUA_WITHHELD_NODES.map(
  (entry) => `${entry.kind} (${entry.nodeId})`,
).join(
  ", ",
)}; they hold certificates and trust lists, account names, role identity mappings, every open session's client, user identity and endpoint, and the PubSub key management objects. In namespace 0 agent mode reads only the Root and Objects folders, the Server object, ServerArray, NamespaceArray, ServerStatus, ServiceLevel, Auditing, ServerCapabilities without its RoleSet, and ServerDiagnostics with its EnabledFlag and ServerDiagnosticsSummary counters; every other namespace-0 node is refused with its reason.`;

/** The OPC Foundation's namespace URI, which is namespace 0 on every server (Part 6 5.2.2.9). */
const OPC_FOUNDATION_NAMESPACE = "http://opcfoundation.org/UA/";

const MAX_UINT16 = 65_535;
const MAX_UINT32 = 4_294_967_295;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One identifier in its one spelling, or undefined when it is not one of Part 6 5.1.12's four forms. */
function canonicalIdentifier(identifier: string): string | undefined {
  if (identifier.startsWith("i=")) {
    const digits = identifier.slice(2);
    if (!/^\d{1,10}$/.test(digits) || Number(digits) > MAX_UINT32) return undefined;
    return `i=${Number(digits)}`;
  }
  if (identifier.startsWith("s=")) return identifier.length > 2 ? identifier : undefined;
  if (identifier.startsWith("g=")) {
    const guid = identifier.slice(2).toLowerCase();
    return GUID.test(guid) ? `g=${guid}` : undefined;
  }
  if (identifier.startsWith("b=")) {
    // Decoded and encoded again: a decoder takes base64 unpadded and ignores trailing bits, so one ByteString has
    // several spellings, and only the bytes name the node.
    try {
      return `b=${btoa(atob(identifier.slice(2)))}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * One node id as the one key the agent path compares and sends, or undefined for an id that has none.
 *
 * Namespace 0 is written with no prefix and every other namespace as `ns=<index>;`. An `nsu=` URI is namespace 0 when
 * it is the OPC Foundation's, its index in `namespaces` (the server's NamespaceArray) when that is given, and left
 * as `nsu=<uri>;<identifier>` for the session to decide when it is not; a URI the table does not hold has no key.
 * A server answers ids as `ns=0;i=2254` (measured on OPC PLC 2.15.10), so its answers go through this as well.
 */
export function canonicalNodeId(nodeId: OpcuaNodeId, namespaces?: readonly string[]): OpcuaNodeId | undefined {
  let index: number | undefined;
  let uri: string | undefined;
  let rest = nodeId;
  const indexed = /^ns=(\d{1,5});/.exec(rest);
  const named = /^nsu=([^;]+);/.exec(rest);
  if (indexed !== null) {
    index = Number(indexed[1]);
    if (index > MAX_UINT16) return undefined;
    rest = rest.slice(indexed[0].length);
  } else if (named !== null) {
    uri = named[1];
    rest = rest.slice(named[0].length);
  } else {
    index = 0;
  }
  const identifier = canonicalIdentifier(rest);
  if (identifier === undefined) return undefined;
  if (uri !== undefined) {
    if (uri === OPC_FOUNDATION_NAMESPACE) index = 0;
    else if (namespaces === undefined) return `nsu=${uri};${identifier}`;
    else {
      const found = namespaces.indexOf(uri);
      if (found < 0) return undefined;
      index = found;
    }
  }
  return index === 0 ? identifier : `ns=${index};${identifier}`;
}

/** Whether a key still names its namespace by URI, so the server's NamespaceArray decides it. */
export const namesNamespaceUri = (key: OpcuaNodeId): boolean => key.startsWith("nsu=");

/** Whether a key is in namespace 0. Keys only: `canonicalNodeId` writes namespace 0 with no prefix. */
const inNamespace0 = (key: OpcuaNodeId): boolean => !key.startsWith("ns=") && !namesNamespaceUri(key);

/** The withheld root a node id names, or undefined. Pure: decides only the standard ids. */
export function withheldRootOf(nodeId: OpcuaNodeId): OpcuaWithheldNode | undefined {
  const canonical = canonicalNodeId(nodeId);
  return OPCUA_WITHHELD_NODES.find((entry) => entry.nodeId === canonical);
}

/**
 * Why a key is refused whatever the server answers, or undefined: a withheld root, or a namespace-0 node outside
 * agent mode's list. Pure, so the reader decides it before anything is sent.
 */
export function standingRefusal(key: OpcuaNodeId): OpcuaWithheldNode | undefined {
  const root = OPCUA_WITHHELD_NODES.find((entry) => entry.nodeId === key);
  if (root !== undefined) return root;
  return inNamespace0(key) && !NAMESPACE0_READ.has(key) ? OPCUA_NAMESPACE0_OUTSIDE : undefined;
}

/** The most nodes the walk under the withheld roots reads, and the deepest level it reads to. */
export const OPCUA_WITHHELD_WALK_MAX_NODES = 2_000;
export const OPCUA_WITHHELD_WALK_MAX_DEPTH = 8;

/** The refusal of a browse that leaves the walk unfinished for this identity, decided from below instead. */
const OPCUA_NOT_SHOWN = "BadUserAccessDenied";

/** Why the withheld walk could not be finished, which refuses the agent read. */
export class OpcuaWithheldWalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpcuaWithheldWalkError";
  }
}

/** One node id from the server or the request, as its key; it throws when the id has none. */
export type OpcuaKeyOf = (nodeId: OpcuaNodeId) => Promise<OpcuaNodeId>;

/** Every withheld node of this server: the roots and what the server answers beneath them, each with its root. */
export interface OpcuaWithheldSet {
  readonly nodes: ReadonlyMap<OpcuaNodeId, OpcuaWithheldNode>;
  /** The nodes whose browse the server refused to this identity: the walk is unfinished beneath each. */
  readonly denied: readonly OpcuaNodeId[];
}

/** Why a key is refused on this read, or undefined: the walk's set first, then the standing refusals. */
export function refusalOf(set: OpcuaWithheldSet, key: OpcuaNodeId): OpcuaWithheldNode | undefined {
  return set.nodes.get(key) ?? standingRefusal(key);
}

const refusedWalk = (status: string): string =>
  `Studio could not read what lies beneath the withheld parts of this server's address space (the server answered ${status} to a browse of them), so it cannot tell whether the read names one of them and refuses it rather than answer it unchecked.`;

const isGood = (status: string): boolean => status.startsWith("Good") || status.startsWith("Uncertain");

/** Every reference one browse answered, continuation points followed and consumed inside this call. */
async function referencesOf(
  client: Pick<OpcuaReadOnlyClient, "browseNext">,
  answer: { readonly references: readonly OpcuaReference[]; readonly continuationPoint?: Uint8Array },
  refused: (status: string) => string,
): Promise<OpcuaReference[]> {
  const references: OpcuaReference[] = [...answer.references];
  let point = answer.continuationPoint;
  while (point !== undefined) {
    // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it.
    const [continued] = await client.browseNext([point]);
    if (continued === undefined) throw new OpcuaWithheldWalkError(refused("nothing"));
    if (!isGood(continued.statusCode)) throw new OpcuaWithheldWalkError(refused(continued.statusCode));
    references.push(...continued.references);
    point = continued.continuationPoint;
  }
  return references;
}

/**
 * The withheld set of one session, read through its own Browse service before an agent read.
 *
 * Level by level, the roots first, in chunks the server will take, following and consuming every continuation point
 * inside this call. Methods are listed as members and never browsed, as everywhere in this provider. A node reached
 * under two roots keeps the first. A node whose browse the server refuses to this identity is recorded in `denied`,
 * so the read decides the nodes it answers from below (`deniedAncestry`).
 */
export async function withheldNodes(
  client: Pick<OpcuaReadOnlyClient, "browse" | "browseNext">,
  keyOf: OpcuaKeyOf,
  chunk: number = browseChunkSize({}),
): Promise<OpcuaWithheldSet> {
  const set = new Map<OpcuaNodeId, OpcuaWithheldNode>();
  const denied: OpcuaNodeId[] = [];
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
        if (depth === 0 && answer.statusCode === "BadNodeIdUnknown") continue;
        if (answer.statusCode === OPCUA_NOT_SHOWN) {
          denied.push(item.nodeId);
          continue;
        }
        if (!isGood(answer.statusCode)) throw new OpcuaWithheldWalkError(refusedWalk(answer.statusCode));
        // oxlint-disable-next-line no-await-in-loop -- the continuation points of one answer, consumed in order.
        for (const reference of await referencesOf(client, answer, refusedWalk)) {
          // oxlint-disable-next-line no-await-in-loop -- a URI is resolved by one table read, held for this read only.
          const id = await keyOf(reference.nodeId);
          if (set.has(id)) continue;
          set.set(id, item.root);
          if (set.size > OPCUA_WITHHELD_WALK_MAX_NODES + OPCUA_WITHHELD_NODES.length)
            throw new OpcuaWithheldWalkError(
              `The withheld parts of this server's address space hold more than the ${OPCUA_WITHHELD_WALK_MAX_NODES.toLocaleString("en-US")} nodes Studio reads to check a read against them, so the read is refused rather than answered unchecked.`,
            );
          if (reference.nodeClass !== "Method") next.push({ nodeId: id, root: item.root });
        }
      }
    }
    frontier = next;
  }
  return { nodes: set, denied };
}

const unconfirmed = (why: string): string =>
  `The server would not let this identity browse every withheld part of its address space, and ${why}, so Studio cannot confirm that the read names nothing beneath them and refuses it rather than answer it unchecked.`;

/**
 * Which of `keys` lie beneath a withheld node, decided from below, for a read whose walk the server left unfinished.
 *
 * Each key outside namespace 0 has its parents read through an inverse Browse of hierarchical references, level by
 * level, up to namespace 0 or a node `clean` names (one this read has already confirmed). A key is withheld when any
 * parent on the way is in the set, with that parent's root; a namespace-0 parent that is not in the set ends that
 * line clean. A node whose parents the server will not answer, a node outside namespace 0 with no parent, an id with
 * no key, or a line deeper than the walk reads refuses the read, because a node that could not be checked is not
 * answered unchecked. Nothing is sent when the walk was finished.
 */
export async function deniedAncestry(
  client: Pick<OpcuaReadOnlyClient, "browse" | "browseNext">,
  keys: readonly OpcuaNodeId[],
  set: OpcuaWithheldSet,
  keyOf: OpcuaKeyOf,
  chunk: number = browseChunkSize({}),
  clean: ReadonlySet<OpcuaNodeId> = new Set(),
): Promise<ReadonlyMap<OpcuaNodeId, OpcuaWithheldNode>> {
  const found = new Map<OpcuaNodeId, OpcuaWithheldNode>();
  if (set.denied.length === 0) return found;
  const pending = [...new Set(keys)].filter((key) => !inNamespace0(key) && refusalOf(set, key) === undefined);
  // Each line climbs from one key; a parent reached on two lines is read once per level and decides both.
  let frontier = new Map<OpcuaNodeId, Set<OpcuaNodeId>>(pending.map((key) => [key, new Set([key])]));
  for (let depth = 0; frontier.size > 0; depth += 1) {
    if (depth >= OPCUA_WITHHELD_WALK_MAX_DEPTH)
      throw new OpcuaWithheldWalkError(
        unconfirmed(`a node's parents run deeper than the ${OPCUA_WITHHELD_WALK_MAX_DEPTH} levels Studio reads`),
      );
    const next = new Map<OpcuaNodeId, Set<OpcuaNodeId>>();
    for (const batch of chunked([...frontier.keys()], chunk)) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk of a level at a time, so the load on the server is fixed.
      const answers = await client.browse(batch, "inverse");
      for (const [at, nodeId] of batch.entries()) {
        const answer = answers[at];
        const origins = frontier.get(nodeId) as Set<OpcuaNodeId>;
        if (answer === undefined)
          throw new OpcuaWithheldWalkError(unconfirmed("it answered nothing for a node's parents"));
        if (!isGood(answer.statusCode))
          throw new OpcuaWithheldWalkError(unconfirmed(`it answered ${answer.statusCode} for a node's parents`));
        // oxlint-disable-next-line no-await-in-loop -- the continuation points of one answer, consumed in order.
        const parents = await referencesOf(client, answer, (status) =>
          unconfirmed(`it answered ${status} for a node's parents`),
        );
        if (parents.length === 0) throw new OpcuaWithheldWalkError(unconfirmed("a node answered no parent"));
        for (const parent of parents) {
          // oxlint-disable-next-line no-await-in-loop -- a URI is resolved by one table read, held for this read only.
          const id = await keyOf(parent.nodeId);
          const withheld = set.nodes.get(id);
          if (withheld !== undefined) {
            for (const origin of origins) if (!found.has(origin)) found.set(origin, withheld);
            continue;
          }
          if (inNamespace0(id) || clean.has(id)) continue;
          const line = next.get(id) ?? new Set<OpcuaNodeId>();
          for (const origin of origins) line.add(origin);
          next.set(id, line);
        }
      }
    }
    frontier = next;
  }
  return found;
}
