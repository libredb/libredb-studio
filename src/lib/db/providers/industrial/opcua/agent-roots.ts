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
import {
  canonicalNodeId,
  inNamespace0,
  namesCredential,
  OPCUA_PRUNED_DATA_TYPES,
  OPCUA_PRUNED_TYPE_DEFINITIONS,
} from "./agent-withheld";
import type { OpcuaBrowseResult, OpcuaDataValue, OpcuaNodeId, OpcuaReadOnlyClient, OpcuaReference } from "./client";
import { OPCUA_DIAGNOSTICS_NAMESPACE, OPCUA_FOUNDATION_NAMESPACE } from "./constants";
import { chunked } from "./limits";
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

/** The most members the walk proves in all roots together; past it the read is refused whole. */
export const OPCUA_READ_SET_MAX_NODES = 2_000;

/** The deepest level below a root whose members are browsed; their targets are not added. A stop, never a refusal. */
export const OPCUA_READ_SET_MAX_DEPTH = 8;

/** The most requests the walk sends, counted apart from the answer's own; past it the read is refused whole. */
export const OPCUA_READ_SET_MAX_REQUESTS = 150;

/** Organizes, HasComponent, HasOrderedComponent and HasProperty: the only references the walk follows down. */
const KEPT_REFERENCES: ReadonlySet<OpcuaNodeId> = new Set(["i=35", "i=47", "i=49", "i=46"]);

/** HasProperty, which holds a Variable's EngineeringUnits and EURange. */
const HAS_PROPERTY = "i=46";

/** The node classes that bear no value, admitted without a DataType check. */
const VALUELESS_CLASSES: ReadonlySet<string> = new Set([
  "Object",
  "Method",
  "ObjectType",
  "ReferenceType",
  "DataType",
  "View",
]);

/** The properties that hold a Variable's units and range (Part 8 5.6.2). */
const UNIT_PROPERTIES = { units: "EngineeringUnits", range: "EURange" } as const;

/** Which units property a reference names, by its HasProperty BrowseName, or undefined. */
function unitProperty(reference: OpcuaReference): "units" | "range" | undefined {
  if (canonicalNodeId(reference.referenceTypeId) !== HAS_PROPERTY) return undefined;
  if (reference.browseName === UNIT_PROPERTIES.units) return "units";
  if (reference.browseName === UNIT_PROPERTIES.range) return "range";
  return undefined;
}

/** A refusal of the whole read decided by the read roots, worded by Studio and naming only what the operator wrote. */
export class OpcuaReadRootsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpcuaReadRootsError";
  }
}

const refuse = (message: string): never => {
  throw new OpcuaReadRootsError(message);
};

const NOTHING = "Nothing was answered.";

/** The read roots walk's whole-read refusals, each in Studio's words. */
export const OPCUA_READ_ROOTS_SENTENCES = {
  notOnServer: (root: string): string =>
    `Read root ${root} is not on this server: its namespace URI is not in the server's namespace table. ${NOTHING}`,
  ambiguous: (root: string): string =>
    `Read root ${root} is ambiguous on this server: its namespace URI appears more than once in the server's namespace table. ${NOTHING}`,
  intoNamespace0: (root: string): string =>
    `Read root ${root} resolves into namespace 0 on this server, which is never read beneath a root outside the fixed table. ${NOTHING}`,
  diagnostics: (root: string): string =>
    `Read root ${root} resolves into the OPC Foundation diagnostics namespace on this server, which is never a read root. ${NOTHING}`,
  unreadable: (root: string, status: string): string =>
    `Read root ${root} could not be read on this server: it answered ${status}. ${NOTHING}`,
  pruned: (root: string): string =>
    `Read root ${root} is of a kind agent mode never reads (its class, type, data type or name), so nothing beneath it is read: an operator declares another root.`,
  stopped: (status: string): string =>
    `The server stopped listing the read roots part way (${status}), so the set cannot be proved. ${NOTHING}`,
  nodes: `The read roots of this connection hold more than ${OPCUA_READ_SET_MAX_NODES.toLocaleString("en-US")} nodes, past what one read proves: an operator declares narrower read roots. ${NOTHING}`,
  requests: `The read roots of this connection need more than ${OPCUA_READ_SET_MAX_REQUESTS} requests to prove, past what one read proves: an operator declares narrower read roots. ${NOTHING}`,
} as const;

const R = OPCUA_READ_ROOTS_SENTENCES;

/** The note counting a member's references that lead outside the roots, naming no target, class or reason. */
export const outwardNote = (count: number): string =>
  `${count} ${count === 1 ? "reference" : "references"} of this node ${count === 1 ? "leads" : "lead"} outside this connection's read roots and ${count === 1 ? "is" : "are"} not listed.`;

/** Where a key's namespace sits: namespace 0, the diagnostics namespace, or any other. */
type NamespaceKind = "0" | "diagnostics" | "other";

/** One node id put in its key through the session's namespace table, or undefined when it has none here. */
export interface OpcuaTableKey {
  readonly key: OpcuaNodeId;
  readonly namespace: NamespaceKind;
}

const namespaceKind = (uri: string | undefined): NamespaceKind =>
  uri === OPCUA_FOUNDATION_NAMESPACE ? "0" : uri === OPCUA_DIAGNOSTICS_NAMESPACE ? "diagnostics" : "other";

const indexOf = (key: OpcuaNodeId): number => (key.startsWith("ns=") ? Number(key.slice(3, key.indexOf(";"))) : 0);

/**
 * The key of a node id through one session's namespace table (the server's NamespaceArray), or undefined: an id
 * whose identifier does not decode, whose URI the table does not hold or holds twice, or whose index is at or past the
 * table's end. The namespace is decided by the table entry, never by one cached index, so the foundation URI and the
 * diagnostics URI are namespace 0 and the diagnostics namespace wherever the table lists them.
 */
export function keyIn(nodeId: OpcuaNodeId, table: readonly string[]): OpcuaTableKey | undefined {
  const bare = canonicalNodeId(nodeId);
  if (bare === undefined) return undefined;
  if (bare.startsWith("nsu=")) {
    const uri = bare.slice(4, bare.indexOf(";"));
    if (table.indexOf(uri) !== table.lastIndexOf(uri)) return undefined;
    const key = canonicalNodeId(bare, table);
    return key === undefined ? undefined : { key, namespace: namespaceKind(uri) };
  }
  const index = indexOf(bare);
  if (index >= table.length) return undefined;
  const uri = table[index] as string;
  if (index !== 0 && table.indexOf(uri) !== table.lastIndexOf(uri)) return undefined;
  return { key: bare, namespace: index === 0 ? "0" : namespaceKind(uri) };
}

/** What the walk knows of one member: the facts its own attributes answered. */
export interface OpcuaMemberFacts {
  readonly nodeClass?: string;
  readonly dataTypeId?: OpcuaNodeId;
  readonly browseName?: string;
  readonly displayName?: string;
}

/** One reference the walk kept beneath a member: its target is a member too. */
export interface OpcuaKeptReference {
  readonly nodeId: OpcuaNodeId;
  readonly browseName: string;
  readonly displayName: string;
  readonly nodeClass: string;
  readonly referenceTypeId: OpcuaNodeId;
}

/** A units property a member's browse listed whose node is not a member: never read, answered as not read. */
export const OPCUA_OUTSIDE_PROPERTY = "outside";

/** Where a Variable's units live, as the walk saw them: the member properties, and whether one lies outside. */
export interface OpcuaUnitPlaces {
  /** The EngineeringUnits property: a member's key, or "outside" when the browse listed one the walk did not keep. */
  readonly units?: OpcuaNodeId | typeof OPCUA_OUTSIDE_PROPERTY;
  /** The EURange property, the same way. */
  readonly range?: OpcuaNodeId | typeof OPCUA_OUTSIDE_PROPERTY;
}

/** One row a browse of the Objects folder answers: a read root with its own names. */
export interface OpcuaRootRow {
  readonly nodeId: OpcuaNodeId;
  readonly browseName: string | null;
  readonly displayName: string | null;
  readonly nodeClass: string | null;
  readonly referenceTypeId: null;
}

/** The set one read proved, held for that read only and dropped with its session. */
export interface OpcuaReadSet {
  /** Every member by key, with its facts. */
  readonly members: ReadonlyMap<OpcuaNodeId, OpcuaMemberFacts>;
  /** The references kept beneath each browsed member, in the order the server listed them. */
  readonly kept: ReadonlyMap<OpcuaNodeId, readonly OpcuaKeptReference[]>;
  /** How many of each browsed member's references lead outside the roots. */
  readonly outward: ReadonlyMap<OpcuaNodeId, number>;
  /** The members whose own Browse the server refused, answered with no rows and the leaf note. */
  readonly leaves: ReadonlySet<OpcuaNodeId>;
  /** The units places of each member that has a units or range property. */
  readonly units: ReadonlyMap<OpcuaNodeId, OpcuaUnitPlaces>;
  /** The read roots, in the order the operator wrote them, as a browse of the Objects folder answers them. */
  readonly roots: readonly OpcuaRootRow[];
  /** How many requests the walk sent. */
  readonly requests: number;
}

/** The services the walk calls: forward Browse, BrowseNext and the facts Read. */
export type OpcuaWalkClient = Pick<OpcuaReadOnlyClient, "browse" | "browseNext" | "read">;

const isGood = (status: string): boolean => status.startsWith("Good");
const isListed = (status: string): boolean => status.startsWith("Good") || status.startsWith("Uncertain");

/** The statuses that mean the server would not hand back or honour a continuation point. */
const REFUSED_POINTS: ReadonlySet<string> = new Set(["BadNoContinuationPoints", "BadContinuationPointInvalid"]);

/**
 * Whether a node's own facts prune it, with its subtree: rule 1, a NodeClass not answered Good, a class other than
 * the valueless ones unless a Variable or VariableType whose DataType was answered Good and is not a withheld data
 * type, or a valueless class whose DataType was answered Good all the same, since none of those classes has one and
 * the answer says the node is not what it claims; rule 3, a standard identity property by its qualified BrowseName,
 * or a BrowseName the server did not answer, since only the name tells an identity property apart; rule 4, a name
 * that names a credential.
 */
function prunedByFacts(facts: OpcuaDataValue, table: readonly string[]): boolean {
  if (!isGood(facts.statusCode)) return true;
  const nodeClass = facts.nodeClass;
  if (nodeClass === undefined) return true;
  const typed = facts.dataTypeStatusCode !== undefined && isGood(facts.dataTypeStatusCode);
  if (VALUELESS_CLASSES.has(nodeClass)) {
    if (typed && facts.dataTypeId !== undefined) return true;
  } else {
    if (nodeClass !== "Variable" && nodeClass !== "VariableType") return true;
    if (!typed) return true;
    const dataType = facts.dataTypeId === undefined ? undefined : canonicalNodeId(facts.dataTypeId);
    if (dataType === undefined || OPCUA_PRUNED_DATA_TYPES.has(dataType)) return true;
  }
  const qualified = facts.browseName;
  if (qualified === undefined) return true;
  if (
    OPCUA_IDENTITY_PROPERTIES.some(
      (property) => property.name === qualified.name && table[qualified.namespaceIndex] === property.namespaceUri,
    )
  )
    return true;
  return [qualified.name, facts.displayName].some((name) => name !== undefined && namesCredential(name));
}

/** Whether a browse reference prunes its target: rule 2, a withheld type definition; rule 4, a credential name. */
function prunedByReference(reference: OpcuaReference): boolean {
  const type = reference.typeDefinition === undefined ? undefined : canonicalNodeId(reference.typeDefinition);
  if (type !== undefined && OPCUA_PRUNED_TYPE_DEFINITIONS.has(type)) return true;
  return namesCredential(reference.browseName) || namesCredential(reference.displayName);
}

const factsOf = (facts: OpcuaDataValue): OpcuaMemberFacts => ({
  ...(facts.nodeClass === undefined ? {} : { nodeClass: facts.nodeClass }),
  ...(facts.dataTypeId === undefined ? {} : { dataTypeId: canonicalNodeId(facts.dataTypeId) ?? facts.dataTypeId }),
  ...(facts.browseName === undefined ? {} : { browseName: facts.browseName.name }),
  ...(facts.displayName === undefined ? {} : { displayName: facts.displayName }),
});

/** The walk's client, each request counted against `OPCUA_READ_SET_MAX_REQUESTS` before it is sent. */
function countedWalk(client: OpcuaWalkClient): OpcuaWalkClient & { readonly requests: () => number } {
  let sent = 0;
  const charge = (): void => {
    if (sent >= OPCUA_READ_SET_MAX_REQUESTS) refuse(R.requests);
    sent += 1;
  };
  return {
    requests: () => sent,
    browse: async (nodeIds) => {
      charge();
      return client.browse(nodeIds);
    },
    browseNext: async (points) => {
      charge();
      return client.browseNext(points);
    },
    read: async (nodeIds) => {
      charge();
      return client.read(nodeIds, "facts");
    },
  };
}

/** The facts of `keys`, chunked; an answer missing a row refuses the whole read, since the set would be partial. */
async function readFacts(
  client: OpcuaWalkClient,
  keys: readonly OpcuaNodeId[],
  chunk: number,
): Promise<ReadonlyMap<OpcuaNodeId, OpcuaDataValue>> {
  const found = new Map<OpcuaNodeId, OpcuaDataValue>();
  for (const batch of chunked(keys, chunk)) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps a read inside the server's operation limit.
    const answers = await client.read(batch);
    for (const [at, key] of batch.entries()) {
      const answer = answers[at];
      if (answer === undefined) refuse(R.stopped("nothing"));
      found.set(key, answer as OpcuaDataValue);
    }
  }
  return found;
}

/** Every reference one Browse answered, continuation points followed to their end inside this call. */
async function referencesOf(client: OpcuaWalkClient, answer: OpcuaBrowseResult): Promise<OpcuaReference[]> {
  const references: OpcuaReference[] = [...answer.references];
  let point = answer.continuationPoint;
  while (point !== undefined) {
    // oxlint-disable-next-line no-await-in-loop -- a continuation point is consumed by the request that received it.
    const [continued] = await client.browseNext([point]);
    if (continued === undefined) return refuse(R.stopped("nothing"));
    if (!isListed(continued.statusCode)) refuse(R.stopped(continued.statusCode));
    references.push(...continued.references);
    point = continued.continuationPoint;
  }
  return references;
}

/** The key of one root through the session's table, or the whole read's refusal, naming only the root. */
function rootKey(root: string, table: readonly string[]): OpcuaNodeId {
  const bare = canonicalNodeId(root) as OpcuaNodeId;
  if (inNamespace0(bare)) return bare;
  const uri = bare.slice(4, bare.indexOf(";"));
  const first = table.indexOf(uri);
  if (first < 0) refuse(R.notOnServer(root));
  if (first !== table.lastIndexOf(uri)) refuse(R.ambiguous(root));
  if (first === 0) refuse(R.intoNamespace0(root));
  if (uri === OPCUA_DIAGNOSTICS_NAMESPACE) refuse(R.diagnostics(root));
  return canonicalNodeId(bare, table) as OpcuaNodeId;
}

/**
 * The set of nodes one read may answer, proved on the read's own session before anything the request names is sent.
 *
 * The roots are keyed through the session's NamespaceArray and their facts read; a root the server does not answer
 * Good for, or one the prune catches, refuses the read whole. A namespace-0 root's members are its fixed table rows,
 * never browsed. Every other root is walked breadth first through forward Browse, in chunks the server takes, every
 * continuation point followed to its end, and a reference is kept only when it is Organizes, HasComponent,
 * HasOrderedComponent or HasProperty, its target has a key outside namespace 0 and the diagnostics namespace, and
 * neither the reference (type definition, name) nor the target's own facts (class, data type, qualified name, name)
 * prune it. A kept target joins once, at its shallowest depth; a member at `OPCUA_READ_SET_MAX_DEPTH` is browsed
 * but its new targets are counted outward and not added. A member whose own Browse is refused becomes a leaf; a
 * BrowseNext refused, or past the node or request bound, refuses the whole read. Every request depends only on the
 * roots, the identity and the server, never on what the request names.
 *
 * A remote target (a server index other than 0) is keyed as a local id until the seam keys extended node ids, so it
 * is outside unless the local id it names is a member.
 */
export async function proveReadSet(
  client: OpcuaWalkClient,
  roots: readonly string[],
  table: readonly string[],
  chunks: { readonly browse: number; readonly read: number },
): Promise<OpcuaReadSet> {
  const walk = countedWalk(client);
  const rootKeys = roots.map((root) => rootKey(root, table));
  const members = new Map<OpcuaNodeId, OpcuaMemberFacts>();
  const kept = new Map<OpcuaNodeId, OpcuaKeptReference[]>();
  const outward = new Map<OpcuaNodeId, number>();
  const leaves = new Set<OpcuaNodeId>();
  const units = new Map<OpcuaNodeId, OpcuaUnitPlaces>();
  const pruned = new Set<OpcuaNodeId>();
  // Which units properties each browse listed, kept or not, so one left outside is told apart from none.
  const unitsListed = new Map<OpcuaNodeId, Set<"units" | "range">>();
  const join = (key: OpcuaNodeId, facts: OpcuaMemberFacts): void => {
    members.set(key, facts);
    if (members.size > OPCUA_READ_SET_MAX_NODES) refuse(R.nodes);
  };

  const namespace0 = new Map(OPCUA_NAMESPACE0_ROOTS.map((entry) => [entry.nodeId, entry]));
  const fixed = rootKeys.flatMap((key) => namespace0.get(key)?.rows.map((row) => row.nodeId) ?? []);
  const rootFacts = await readFacts(walk, [...new Set([...rootKeys, ...fixed])], chunks.read);
  for (const [at, key] of rootKeys.entries()) {
    const facts = rootFacts.get(key) as OpcuaDataValue;
    if (!isGood(facts.statusCode)) refuse(R.unreadable(roots[at] as string, facts.statusCode));
    if (prunedByFacts(facts, table)) refuse(R.pruned(roots[at] as string));
    join(key, factsOf(facts));
  }
  for (const key of rootKeys) {
    const entry = namespace0.get(key);
    if (entry === undefined) continue;
    for (const row of entry.rows) {
      const facts = rootFacts.get(row.nodeId) as OpcuaDataValue;
      if (prunedByFacts(facts, table)) pruned.add(row.nodeId);
      else join(row.nodeId, factsOf(facts));
    }
  }

  let frontier = rootKeys.filter((key) => !namespace0.has(key));
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const candidates: {
      readonly parent: OpcuaNodeId;
      readonly key: OpcuaNodeId;
      readonly reference: OpcuaReference;
    }[] = [];
    for (const batch of chunked(frontier, chunks.browse)) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk of a level at a time, so the load on the server is fixed.
      const answers = await walk.browse(batch);
      for (const [at, parent] of batch.entries()) {
        const answer = answers[at];
        if (answer === undefined) refuse(R.stopped("nothing"));
        const { statusCode } = answer as OpcuaBrowseResult;
        if (REFUSED_POINTS.has(statusCode)) refuse(R.stopped(statusCode));
        kept.set(parent, []);
        outward.set(parent, 0);
        if (!isListed(statusCode)) {
          leaves.add(parent);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- the continuation points of one answer, consumed in order.
        for (const reference of await referencesOf(walk, answer as OpcuaBrowseResult)) {
          const target = keyIn(reference.nodeId, table);
          const type = canonicalNodeId(reference.referenceTypeId);
          const property = unitProperty(reference);
          if (property !== undefined) unitsListed.set(parent, (unitsListed.get(parent) ?? new Set()).add(property));
          const followed =
            type !== undefined &&
            KEPT_REFERENCES.has(type) &&
            target !== undefined &&
            target.namespace === "other" &&
            !pruned.has(target.key) &&
            !prunedByReference(reference) &&
            (members.has(target.key) || depth < OPCUA_READ_SET_MAX_DEPTH);
          if (!followed) {
            outward.set(parent, (outward.get(parent) ?? 0) + 1);
            continue;
          }
          candidates.push({ parent, key: (target as OpcuaTableKey).key, reference });
        }
      }
    }
    const fresh = [...new Set(candidates.map((c) => c.key).filter((key) => !members.has(key)))];
    // oxlint-disable-next-line no-await-in-loop -- a level's new targets are classed before the next level is browsed.
    const facts = await readFacts(walk, fresh, chunks.read);
    const next: OpcuaNodeId[] = [];
    for (const key of fresh) {
      const answer = facts.get(key) as OpcuaDataValue;
      if (prunedByFacts(answer, table)) pruned.add(key);
      else {
        join(key, factsOf(answer));
        next.push(key);
      }
    }
    for (const { parent, key, reference } of candidates) {
      if (!members.has(key)) {
        outward.set(parent, (outward.get(parent) ?? 0) + 1);
        continue;
      }
      const memberFacts = members.get(key) as OpcuaMemberFacts;
      (kept.get(parent) as OpcuaKeptReference[]).push({
        nodeId: key,
        browseName: reference.browseName,
        displayName: reference.displayName,
        nodeClass: memberFacts.nodeClass as string,
        referenceTypeId: canonicalNodeId(reference.referenceTypeId) as OpcuaNodeId,
      });
      const property = unitProperty(reference);
      if (
        property !== undefined &&
        (units.get(parent)?.[property] ?? OPCUA_OUTSIDE_PROPERTY) === OPCUA_OUTSIDE_PROPERTY
      )
        units.set(parent, { ...units.get(parent), [property]: key });
    }
    frontier = next;
  }
  for (const [parent, listed] of unitsListed) {
    const place = units.get(parent) ?? {};
    for (const property of listed)
      if (place[property] === undefined)
        units.set(parent, { ...units.get(parent), [property]: OPCUA_OUTSIDE_PROPERTY });
  }

  const rootRows = rootKeys.map((key) => {
    const facts = members.get(key) as OpcuaMemberFacts;
    return {
      nodeId: key,
      browseName: facts.browseName ?? null,
      displayName: facts.displayName ?? null,
      nodeClass: facts.nodeClass ?? null,
      referenceTypeId: null,
    };
  });
  return { members, kept, outward, leaves, units, roots: rootRows, requests: walk.requests() };
}

/**
 * Whether a member's row from the answer's own Read is answered as an id outside the roots instead, sending nothing:
 * a value on a member the walk classed as a class that bears none, a NodeClass other than the walk's (or none), or,
 * on a Variable or VariableType, a DataType among the withheld data types or none at all, since the walk admitted it
 * only on a DataType answered Good. It reads only the row already fetched, so it turns an in-set row into the
 * outside answer and never touches an outside id.
 */
export function answerTimeOutside(member: OpcuaMemberFacts, row: OpcuaDataValue): boolean {
  if (row.nodeClass === undefined || row.nodeClass !== member.nodeClass) return true;
  if (VALUELESS_CLASSES.has(row.nodeClass)) return row.value !== null && row.value !== undefined;
  const dataType = row.dataTypeId === undefined ? undefined : canonicalNodeId(row.dataTypeId);
  return dataType === undefined || OPCUA_PRUNED_DATA_TYPES.has(dataType);
}

/** The note a browse of a member whose own Browse the server refused answers, with no rows. */
export const OPCUA_LEAF_NOTE = "The server did not list this node's references to this connection's identity.";

/** The warning a browse of the Objects folder answers beside the read roots. */
export const OPCUA_ROOTS_WARNING =
  "These are this connection's read roots, declared by its operator: agent mode reads only these nodes and the nodes beneath them.";

/** The Objects folder, whose browse answers the read roots. */
export const OPCUA_OBJECTS_FOLDER_KEY = "i=85";

/** The refusal of a statement-sending agent profile on a connection that declares no read roots, before any socket. */
export const OPCUA_READ_ROOTS_REQUIRED_SENTENCE =
  "This OPC UA connection declares no read roots: agent mode reads OPC UA only beneath read roots an operator declares on its seed entry (agentReadRoots). Nothing was sent.";

/** What agent mode reads, in the words the reader, the tool description, the grounding and the posture repeat. */
export const OPCUA_READ_ROOTS_SENTENCE = `Agent mode reads only beneath this connection's read roots, the node ids its operator declared on its seed entry: {"browse": "${OPCUA_OBJECTS_FOLDER_KEY}"} lists the roots, and every node beneath them may be read. Every other node id, namespace 0 and the server's configuration, roles and sessions among them, answers exactly as a node the server does not hold (statusCode BadNodeIdUnknown, no value), and nothing is sent for it. A browse of a node beneath a root lists its references inside the roots and says how many lead outside them without naming any; a value whose units property lies outside the roots answers that its units were not read.`;

/** The browse rows of a namespace-0 root or member: the fixed table's rows beneath it, or undefined for any other key. */
export function namespace0Rows(key: OpcuaNodeId): readonly OpcuaKeptReference[] | undefined {
  for (const entry of OPCUA_NAMESPACE0_ROOTS) {
    if (entry.nodeId !== key && !entry.rows.some((row) => row.nodeId === key)) continue;
    return entry.rows
      .filter((row) => row.parent === key)
      .map((row) => ({
        nodeId: row.nodeId,
        browseName: row.browseName,
        displayName: row.displayName,
        nodeClass: row.nodeClass,
        referenceTypeId: row.referenceTypeId,
      }));
  }
  return undefined;
}
