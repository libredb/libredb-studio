/**
 * The only OPC UA services this provider can call (#1677 O-S1).
 *
 * THIS FILE IS THE READ-ONLY GUARANTEE, AND IT IS A GUARANTEE BECAUSE OF WHAT IS NOT IN IT. The
 * interface names eight services, as ten members (see `OpcuaReadOnlyClient` below for why): GetEndpoints, CreateSession, ActivateSession, Browse, BrowseNext,
 * Read, HistoryRead and CloseSession. There is no Write, no Call, no HistoryUpdate, no AddNodes,
 * DeleteNodes, AddReferences or DeleteReferences, and no CreateSubscription or CreateMonitoredItems.
 * A caller that wanted to write would have to add a method here first, which is a reviewable change
 * rather than a forgettable one, and `tests/unit/db/opcua/seam.test.ts` asserts the member list.
 *
 * WHY A SEAM AT ALL, when `node-opcua-client`'s own session already offers these eight: because it
 * also offers `write`, `call`, `historyUpdate`, `addNodes` and `createSubscription2` on the same
 * object. Handing the provider that object would make the guarantee a habit. Handing it this makes
 * the guarantee a type.
 *
 * ON A PLANT FLOOR THE DIFFERENCE IS NOT ACADEMIC. Measured on the issue's own first fixture, an
 * anonymous session wrote a variable with status Good, and 448 of 460 method nodes reported
 * UserExecutable true to it, among them `ResetToServerDefaults`. The server will not stop us; this
 * is what stops us.
 */
/** A node id in its string form (Part 6 5.1.12): `i=`, `s=`, `g=` or `b=`, with `ns=` or `nsu=`. */
export type OpcuaNodeId = string;

/** One reference a Browse answered with: a child of the node browsed, and how it hangs off it. */
export interface OpcuaReference {
  readonly nodeId: OpcuaNodeId;
  /** The BrowseName, namespace index and name, as the server spells it. */
  readonly browseName: string;
  /** The DisplayName's text, which is what a reader recognises. */
  readonly displayName: string;
  /** Object, Variable, Method, View, ObjectType, VariableType, ReferenceType, DataType or Unspecified. */
  readonly nodeClass: string;
  /** The reference type that reaches it, so a level listing can say which edge it followed. */
  readonly referenceTypeId: OpcuaNodeId;
  /**
   * Whether this row is browsed as a folder, DERIVED from the node class rather than published.
   *
   * A server publishes no "has children" flag: Part 4's ReferenceDescription carries the node id,
   * the browse name, the display name, the node class, the reference type and the type definition,
   * and nothing about children. The only way to know is to browse the node, which is the request
   * this flag exists to decide. So it is derived: every class but Method is browsed, because a
   * Variable holds its properties as children too (measured on OPC PLC: `EURange` and
   * `EngineeringUnits` hang off the variables that have them), and a level that comes back empty is
   * a real answer rather than a defect. Method is the exception, and it is the one that matters:
   * descending into methods is what put the issue's own node count 352 above the figure it quotes.
   */
  readonly mayHaveChildren: boolean;
}

/** Which way a Browse follows hierarchical references: to a node's children, or to its parents. */
export type OpcuaBrowseDirection = "forward" | "inverse";

/** What one Browse answered for one node, with the continuation point it did or did not hand back. */
export interface OpcuaBrowseResult {
  readonly nodeId: OpcuaNodeId;
  readonly references: readonly OpcuaReference[];
  /**
   * The continuation point, where the server paged.
   *
   * SCARCE AND SESSION STATE. Measured: OPC PLC allows 10 at once, open62541 32, asyncua publishes
   * none at all, Milo 250. The level contract needs a cursor valid in every process serving the
   * connection, which a continuation point is not, so every one this provider receives is consumed
   * or released inside the same request and never handed upwards.
   */
  readonly continuationPoint?: Uint8Array;
  /** The per-node status, which is Good even where the node has no children. */
  readonly statusCode: string;
}

/** One node's value and the attributes a reader needs beside it. */
export interface OpcuaDataValue {
  readonly nodeId: OpcuaNodeId;
  /** The value as the client decoded it; a caller renders it, never this module. */
  readonly value: unknown;
  /** The DataType's node id, so a renderer knows what it is holding. */
  readonly dataTypeId?: OpcuaNodeId;
  /** -1 scalar, 0 any array, 1 one dimension, and so on (Part 3 5.6.2). */
  readonly valueRank?: number;
  /** Present for an array or a matrix, in the server's own order. */
  readonly arrayDimensions?: readonly number[];
  /** The node class the server answered: Object, Variable, Method, View or a type node. */
  readonly nodeClass?: string;
  /** AccessLevel, as the bits the server answered (Part 3 8.57); a caller decodes them. */
  readonly accessLevel?: number;
  /** UserAccessLevel, which differs from AccessLevel in practice and is shown beside it. */
  readonly userAccessLevel?: number;
  /** The Historizing attribute, which decides whether a history read can answer at all. */
  readonly historizing?: boolean;
  /** The Description's text, where the node has one. */
  readonly description?: string;
  /** The DisplayName's text, which is what a reader recognises. */
  readonly displayName?: string;
  readonly sourceTimestamp?: string;
  readonly serverTimestamp?: string;
  /**
   * The status code, which is part of the answer and not an error.
   *
   * A Read answers Good with a value, Uncertain with a value, or Bad with none, per node. A row
   * whose status is Bad is still a row: dropping it would tell the reader the node does not exist.
   */
  readonly statusCode: string;
}

/** One historical value, which is a DataValue with no node id of its own. */
export interface OpcuaHistoryValue {
  readonly value: unknown;
  readonly sourceTimestamp?: string;
  readonly serverTimestamp?: string;
  readonly statusCode: string;
}

/** One page of raw history for one node. */
export interface OpcuaHistoryPage {
  readonly nodeId: OpcuaNodeId;
  readonly values: readonly OpcuaHistoryValue[];
  readonly continuationPoint?: Uint8Array;
  readonly statusCode: string;
}

/** What the server published about itself, read once per session. */
export interface OpcuaServerLimits {
  /**
   * Each limit, or undefined where the server stated none.
   *
   * A LIMIT COUNTS AS PUBLISHED ONLY WHEN IT IS GOOD, NON-EMPTY AND ABOVE ZERO. Part 5 6.3.11 says
   * "Any operational limits Property that is provided shall have a non zero value", and three of
   * the four stacks measured break it: open62541 publishes eight limits all reading 0, asyncua
   * publishes twelve and reads six of them as Good with an empty Variant, and OPC PLC publishes
   * MaxSessions as 0. So 0, empty and absent all mean the same thing here, and that thing is "the
   * server stated no limit", never "the limit is zero".
   */
  readonly maxNodesPerRead?: number;
  readonly maxNodesPerBrowse?: number;
  readonly maxNodesPerHistoryReadData?: number;
  readonly maxBrowseContinuationPoints?: number;
  readonly maxHistoryContinuationPoints?: number;
}

/** An endpoint the server offers, read before any session exists. */
export interface OpcuaEndpoint {
  /** The URL the SERVER advertises, recorded and never dialled (O-S7). */
  readonly advertisedUrl: string;
  readonly securityMode: "None" | "Sign" | "SignAndEncrypt";
  readonly securityPolicyUri: string;
  /** The server's certificate in DER, present even on a None endpoint, so it can be shown. */
  readonly serverCertificate?: Uint8Array;
  /** Its SHA-256 thumbprint as 64 lowercase hex, the form a pin is written in (O-S2). */
  readonly serverCertificateThumbprint?: string;
  /** Each identity token with its own policy, which may be null meaning the channel's (Part 4 7.41). */
  readonly userIdentityTokens: readonly {
    readonly tokenType: "Anonymous" | "UserName" | "Certificate" | "IssuedToken";
    readonly securityPolicyUri: string | null;
  }[];
}

/**
 * The eight services, as TEN members, and nothing else.
 *
 * The count differs because three of the members call one service each with a field set:
 * `browseNext` and `releaseBrowseContinuationPoints` are both BrowseNext, with and without
 * `releaseContinuationPoints`, and `historyRead`, `historyReadNext` and
 * `releaseHistoryContinuationPoint` are all HistoryRead. Naming them apart is what lets a caller
 * release a point without being able to forget to, and it adds no service to the list.
 *
 * Every method is a READ. The provider holds one of these per connection and has no other way to
 * reach the server: the real implementation closes over `node-opcua-client`'s session and exposes
 * only this, and a test substitutes its own.
 */
export interface OpcuaReadOnlyClient {
  /** GetEndpoints, before any session: what the server offers and what certificate it presents. */
  endpoints(): Promise<readonly OpcuaEndpoint[]>;
  /** What the server published about its own limits, read once and cached for the session. */
  limits(): Promise<OpcuaServerLimits>;
  /**
   * Browse, for up to `OPCUA_MAX_NODES_PER_BROWSE` nodes at a time, following hierarchical references forward to a
   * node's children, or inverse to its parents when `direction` says so. Both are the one Browse service.
   */
  browse(nodeIds: readonly OpcuaNodeId[], direction?: OpcuaBrowseDirection): Promise<readonly OpcuaBrowseResult[]>;
  /** BrowseNext, consuming a continuation point this client handed back. */
  browseNext(continuationPoints: readonly Uint8Array[]): Promise<readonly OpcuaBrowseResult[]>;
  /** BrowseNext with `releaseContinuationPoints` set, which frees the server's slot and returns nothing. */
  releaseBrowseContinuationPoints(continuationPoints: readonly Uint8Array[]): Promise<void>;
  /** Read, the Value attribute and the attributes beside it, chunked by the caller. */
  read(nodeIds: readonly OpcuaNodeId[]): Promise<readonly OpcuaDataValue[]>;
  /** HistoryRead, raw only: `isReadModified` false, `returnBounds` false, a page size always set. */
  historyRead(options: {
    readonly nodeId: OpcuaNodeId;
    readonly startTime?: Date;
    readonly endTime?: Date;
    readonly valuesPerPage: number;
  }): Promise<OpcuaHistoryPage>;
  /**
   * HistoryRead continued, and the matching release, for the same reason Browse has both.
   *
   * BOTH CARRY THE FIRST PAGE'S WINDOW, because a server validates the details of a continued read
   * against the point it handed out. Measured on OPC PLC 2.15.10: a continuation whose details
   * differed from the first read's - the same node, a `new Date()` end a few seconds later -
   * answered `BadContinuationPointInvalid` and dropped the rest of the history on the floor.
   */
  historyReadNext(options: {
    readonly nodeId: OpcuaNodeId;
    readonly continuationPoint: Uint8Array;
    readonly startTime?: Date;
    readonly endTime?: Date;
    readonly valuesPerPage: number;
  }): Promise<OpcuaHistoryPage>;
  releaseHistoryContinuationPoint(options: {
    readonly nodeId: OpcuaNodeId;
    readonly continuationPoint: Uint8Array;
    readonly startTime?: Date;
    readonly endTime?: Date;
    readonly valuesPerPage: number;
  }): Promise<void>;
  /** CloseSession and close the channel. Called on every path out, including every failure. */
  close(): Promise<void>;
}
