/**
 * The read roots of an OPC UA connection: the node ids an operator declares on a seed connection (`agentReadRoots`),
 * beneath which agent mode and MCP read and nowhere else.
 *
 * A ROOT IS WRITTEN WITH ITS NAMESPACE URI, NEVER ITS INDEX. A namespace index is a position in the server's
 * NamespaceArray, which Part 6 says is supplied per session, and a seed outlives server restarts, so a root written by
 * index could name another namespace after one. The URI is resolved to an index on every read's own session.
 *
 * NAMESPACE 0 IS A ROOT ONLY FROM A FIXED TABLE (`OPCUA_NAMESPACE0_ROOTS`): namespace 0 holds the server's
 * configuration, roles and sessions, so a root there is one of a few standard nodes that describe the server's state
 * and limits, and its members are the table's own standard ids beneath it, never what a server hangs there.
 *
 * The grammar is checked when the seed file loads (`validateSeed` of the engine's connection string row) and again
 * when the provider is constructed, both through `readRootRefusals`, which answers fragments each caller frames.
 */
import { canonicalNodeId, inNamespace0 } from "./agent-withheld";
import type { OpcuaNodeId } from "./client";
import { OPCUA_DIAGNOSTICS_NAMESPACE, OPCUA_FOUNDATION_NAMESPACE } from "./constants";
import { isNodeId } from "./node-id";

/** The most roots one connection declares: what one read sends for the roots stays small. */
export const OPCUA_READ_ROOTS_MAX = 32;

/** The longest one root may be, which bounds what a refusal can echo. */
export const OPCUA_READ_ROOT_MAX_LENGTH = 512;

/** HasComponent and HasProperty, the two reference types that hold a namespace-0 member beneath its parent. */
type Namespace0Reference = "i=47" | "i=46";

/** One standard node beneath a namespace-0 root, with the browse row a browse of its parent answers. */
export interface OpcuaNamespace0Row {
  /** The node it hangs beneath: the root, or another row of the same root. */
  readonly parent: OpcuaNodeId;
  readonly nodeId: OpcuaNodeId;
  readonly browseName: string;
  readonly displayName: string;
  readonly nodeClass: "Variable" | "Object";
  readonly referenceTypeId: Namespace0Reference;
}

/** One namespace-0 node a root may name, with its members as the standard ids beneath it. */
export interface OpcuaNamespace0Root {
  /** Its path from the Server object, as Part 5 names it. */
  readonly path: string;
  readonly nodeId: OpcuaNodeId;
  readonly browseName: string;
  readonly nodeClass: "Variable" | "Object";
  /** Every member beneath it, in the order a browse answers them; a member is browsed by its parent's rows. */
  readonly rows: readonly OpcuaNamespace0Row[];
}

const row = (
  parent: number,
  id: number,
  name: string,
  referenceTypeId: Namespace0Reference = "i=47",
): OpcuaNamespace0Row =>
  Object.freeze({
    parent: `i=${parent}`,
    nodeId: `i=${id}`,
    browseName: name,
    displayName: name,
    nodeClass: "Variable",
    referenceTypeId,
  });

const root = (
  path: string,
  id: number,
  nodeClass: "Variable" | "Object",
  rows: readonly OpcuaNamespace0Row[] = [],
): OpcuaNamespace0Root =>
  Object.freeze({
    path,
    nodeId: `i=${id}`,
    browseName: path.slice(path.lastIndexOf(".") + 1),
    nodeClass,
    rows: Object.freeze([...rows]),
  });

/**
 * The namespace-0 nodes a read root may name, each with the standard members beneath it, as `Opc.Ua.NodeSet2.xml`
 * declares them. Not offered: the Root, Objects and Server folders (each would be everything), ServerCapabilities (it
 * holds RoleSet), and every other namespace-0 node.
 */
export const OPCUA_NAMESPACE0_ROOTS: readonly OpcuaNamespace0Root[] = Object.freeze([
  root("Server.ServerStatus", 2256, "Variable", [
    row(2256, 2257, "StartTime"),
    row(2256, 2258, "CurrentTime"),
    row(2256, 2259, "State"),
    row(2256, 2260, "BuildInfo"),
    row(2260, 2261, "ProductName"),
    row(2260, 2262, "ProductUri"),
    row(2260, 2263, "ManufacturerName"),
    row(2260, 2264, "SoftwareVersion"),
    row(2260, 2265, "BuildNumber"),
    row(2260, 2266, "BuildDate"),
    row(2256, 2992, "SecondsTillShutdown"),
    row(2256, 2993, "ShutdownReason"),
  ]),
  root(
    "Server.ServerCapabilities.OperationLimits",
    11704,
    "Object",
    (
      [
        [11705, "MaxNodesPerRead"],
        [12165, "MaxNodesPerHistoryReadData"],
        [12166, "MaxNodesPerHistoryReadEvents"],
        [11707, "MaxNodesPerWrite"],
        [12167, "MaxNodesPerHistoryUpdateData"],
        [12168, "MaxNodesPerHistoryUpdateEvents"],
        [11709, "MaxNodesPerMethodCall"],
        [11710, "MaxNodesPerBrowse"],
        [11711, "MaxNodesPerRegisterNodes"],
        [11712, "MaxNodesPerTranslateBrowsePathsToNodeIds"],
        [11713, "MaxNodesPerNodeManagement"],
        [11714, "MaxMonitoredItemsPerCall"],
      ] as const
    ).map(([id, name]) => row(11704, id, name, "i=46")),
  ),
  root(
    "Server.ServerDiagnostics.ServerDiagnosticsSummary",
    2275,
    "Variable",
    (
      [
        [2276, "ServerViewCount"],
        [2277, "CurrentSessionCount"],
        [2278, "CumulatedSessionCount"],
        [2279, "SecurityRejectedSessionCount"],
        [3705, "RejectedSessionCount"],
        [2281, "SessionTimeoutCount"],
        [2282, "SessionAbortCount"],
        [2284, "PublishingIntervalCount"],
        [2285, "CurrentSubscriptionCount"],
        [2286, "CumulatedSubscriptionCount"],
        [2287, "SecurityRejectedRequestsCount"],
        [2288, "RejectedRequestsCount"],
      ] as const
    ).map(([id, name]) => row(2275, id, name)),
  ),
  root("Server.NamespaceArray", 2255, "Variable"),
  root("Server.ServerArray", 2254, "Variable"),
  root("Server.ServiceLevel", 2267, "Variable"),
  root("Server.Auditing", 2994, "Variable"),
]);

const NAMESPACE0_ROOT_IDS: ReadonlySet<OpcuaNodeId> = new Set(OPCUA_NAMESPACE0_ROOTS.map((entry) => entry.nodeId));

/** A standard identity property, matched by its qualified BrowseName: the namespace URI and the name. */
export interface OpcuaIdentityProperty {
  readonly namespaceUri: string;
  readonly name: string;
}

/**
 * The standard nodes that name another client or user, which agent mode never answers inside a root: Part 9's
 * `ClientUserId` on every condition, and the DI locking object `Lock` of every device with the `LockingClient` and
 * `LockingUser` it holds, each also matched alone in case a vendor places it under another parent.
 */
export const OPCUA_IDENTITY_PROPERTIES: readonly OpcuaIdentityProperty[] = Object.freeze([
  Object.freeze({ namespaceUri: OPCUA_FOUNDATION_NAMESPACE, name: "ClientUserId" }),
  Object.freeze({ namespaceUri: "http://opcfoundation.org/UA/DI/", name: "Lock" }),
  Object.freeze({ namespaceUri: "http://opcfoundation.org/UA/DI/", name: "LockingClient" }),
  Object.freeze({ namespaceUri: "http://opcfoundation.org/UA/DI/", name: "LockingUser" }),
]);

/** One refusal of a root list: the element it is about, when it is about one, and the reason after the field name. */
export interface OpcuaReadRootRefusal {
  readonly index?: number;
  readonly reason: string;
}

/** A whole value written as a `${ENV}` or `${vault:...}` reference, which read roots never are. */
const isReference = (value: string): boolean => value.startsWith("${") && value.endsWith("}");

/** Whether a root names its namespace by index: `ns=<n>;` with n above 0, or any `ns=` after a URI. */
function namesIndex(value: string): boolean {
  if (value.startsWith("nsu=")) return value.slice(value.indexOf(";") + 1).startsWith("ns=");
  if (!value.startsWith("ns=")) return false;
  return Number(value.slice(3, value.indexOf(";"))) > 0;
}

const namespace0Names = OPCUA_NAMESPACE0_ROOTS.map((entry) => `${entry.path} (${entry.nodeId})`).join(", ");

/** What is wrong with one element, or undefined: the grammar alone, never the server. */
function elementRefusal(value: string): string | undefined {
  if (value.length > OPCUA_READ_ROOT_MAX_LENGTH) return `is longer than ${OPCUA_READ_ROOT_MAX_LENGTH} characters.`;
  if (isReference(value))
    return "is a reference: read roots are written in the seed file as they are, since they are neither a credential nor an address.";
  if (!isNodeId(value))
    return "is not a node id: write nsu=<namespace URI>;s=<name>, or i=, g= or b= for the identifier.";
  if (namesIndex(value))
    return "names its namespace by index, which a server restart can move to another namespace: write it with the namespace URI, nsu=<uri>;..., as the server's NamespaceArray lists it.";
  const key = canonicalNodeId(value);
  if (key === undefined) return "has an identifier that does not decode, so Studio cannot tell which node it names.";
  if (key.startsWith(`nsu=${OPCUA_DIAGNOSTICS_NAMESPACE};`))
    return "is in the OPC Foundation diagnostics namespace, which servers built on the OPC Foundation .NET stack use for their session and subscription diagnostics, and is never a read root.";
  if (inNamespace0(key) && !NAMESPACE0_ROOT_IDS.has(key))
    return `names a namespace-0 node that is not offered as a read root: namespace 0 holds the server's configuration, roles and sessions, so only ${namespace0Names} may be roots.`;
  return undefined;
}

/**
 * Every refusal of a root list, as fragments: the whole list's shape first (not a list of strings, empty, past
 * `OPCUA_READ_ROOTS_MAX`), and otherwise one fragment per refused element, by its index, each element checked so one
 * refusal does not hide the next. Pure: decides the grammar only, since whether a root is on the server is the
 * server's to say.
 */
export function readRootRefusals(roots: unknown): readonly OpcuaReadRootRefusal[] {
  if (!Array.isArray(roots) || roots.some((value) => typeof value !== "string"))
    return [{ reason: 'is a list of node ids, such as ["nsu=urn:plant;s=Line1"].' }];
  if (roots.length === 0)
    return [
      { reason: "is empty: list at least one node id agent mode and MCP may read beneath, or remove agentReadRoots." },
    ];
  if (roots.length > OPCUA_READ_ROOTS_MAX)
    return [
      {
        reason: `holds ${roots.length} roots, and a connection takes at most ${OPCUA_READ_ROOTS_MAX}: declare the folders that hold the process data rather than each node.`,
      },
    ];
  const refusals: OpcuaReadRootRefusal[] = [];
  const seen = new Map<OpcuaNodeId, number>();
  for (const [index, value] of (roots as readonly string[]).entries()) {
    const reason = elementRefusal(value);
    if (reason !== undefined) {
      refusals.push({ index, reason });
      continue;
    }
    const key = canonicalNodeId(value) as OpcuaNodeId;
    const first = seen.get(key);
    if (first !== undefined) refusals.push({ index, reason: `names the same node as agentReadRoots[${first}].` });
    else seen.set(key, index);
  }
  return refusals;
}

/** One fragment as the sentence after "agentReadRoots is refused: ", with the element's index inside it. */
export const readRootSentence = (refusal: OpcuaReadRootRefusal): string =>
  `agentReadRoots${refusal.index === undefined ? "" : `[${refusal.index}]`} ${refusal.reason}`;
