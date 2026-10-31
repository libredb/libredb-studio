/**
 * Every number and fixed name the OPC UA provider uses, in one pure module (#1677).
 *
 * EACH BOUND HERE IS A MEASUREMENT, NOT A GUESS, and the measurement is named beside it. Four server
 * stacks were read before this file existed: Microsoft OPC PLC 2.15.10, open62541 1.5.9, Python
 * asyncua 2.1.0 and the Eclipse Milo demo 1.1.0-SNAPSHOT. Where they disagreed, the bound is ours
 * rather than theirs, because two of the four publish an operation limit they do not enforce.
 */

/** The provider's database type, spelled once. */
export const OPCUA_TYPE = "opcua" as const;

/**
 * The IANA-registered port for `opc.tcp`, and the one every stack measured listened on.
 *
 * OPC PLC and Milo both ADVERTISE an endpoint URL carrying their own container hostname and their
 * internal port, which resolves nowhere outside the container. The provider never follows an
 * advertised URL, so this is the port a reader types and the only one dialled.
 */
export const OPCUA_DEFAULT_PORT = 4840;

/** The scheme this provider speaks, and the only one. There is no WebSocket or HTTPS transport here. */
export const OPCUA_SCHEME = "opc.tcp:" as const;

/**
 * The root the address space is browsed from: the Objects folder, `i=85` (Part 3 5.5.3).
 *
 * Not the Root folder `i=84`: Root also holds Types and Views, which are the server's own model
 * rather than its data, and a reader opening the Keys panel wants the plant, not the type system.
 */
export const OPCUA_OBJECTS_FOLDER = "i=85" as const;

/**
 * The security policy URI that means no protection at all, which the GetEndpoints dial always uses.
 *
 * AN IDENTIFIER, NOT AN ADDRESS, and the `http` in it is the OPC Foundation's spelling rather than a
 * choice this code makes: Part 7 names each policy by a URI under `http://opcfoundation.org/UA/`,
 * nothing ever dereferences it, and a server compares the bytes. Writing `https` here would simply
 * stop matching any server. It lives here, in one place, because two copies of a protocol constant
 * are two chances to mistype one.
 */
export const OPCUA_POLICY_NONE = "http://opcfoundation.org/UA/SecurityPolicy#None" as const;

/**
 * The OPC Foundation's namespace URI, which is namespace 0 on every server (Part 6 5.2.2.9).
 *
 * An identifier, for the same reason as the policy URI above: a server's namespace table holds these
 * bytes, and it is compared, never dereferenced.
 */
export const OPCUA_FOUNDATION_NAMESPACE = "http://opcfoundation.org/UA/" as const;

/**
 * The reference type a level listing follows, with its subtypes: HierarchicalReferences, `i=33`.
 *
 * Measured on the documented OPC PLC fixture: following this and its subtypes reaches 6,769 nodes
 * under `i=85` over 6,865 references, the deepest at depth 7. `Organizes`, `HasComponent` and
 * `HasProperty` are all subtypes of it, and a
 * level listing that named them one by one would miss whatever a server's own model adds.
 */
export const OPCUA_HIERARCHICAL_REFERENCES = "i=33" as const;

/**
 * `CurrentSessionCount`, which the live check reads before and after a run (O-S6).
 *
 * NOT PORTABLE, and the spec says so: OPC PLC and open62541 answer it, asyncua answers Good with an
 * empty Variant, and Milo answers `BadNotReadable (0x803A0000)` even to an authenticated session.
 * A snapshot that cannot be read is reported as unavailable, never as zero.
 */
export const OPCUA_CURRENT_SESSION_COUNT = "i=2277" as const;

/**
 * `Server/ServerStatus`, the one node that answers what the Overview card asks for.
 *
 * Part 5 defines it as a structure holding `startTime`, `currentTime`, `state` and a `buildInfo`
 * with the product's name and software version, and Part 5 makes it mandatory - measured on OPC PLC
 * 2.15.10, one Read of it answers Good with
 * `softwareVersion: "2.15.10 (OPC UA SDK 1.5.378.176)"`, `productName: "IoT Edge OPC UA PLC"`,
 * `state: "Running"` and both instants. The card used to say "unknown" for all of it.
 */
export const OPCUA_SERVER_STATUS = "i=2256" as const;

/**
 * How many nodes one Read asks for, ours rather than the server's.
 *
 * THE SERVER'S PUBLISHED LIMIT IS NOT A BOUND. Measured: OPC PLC publishes 2,500 and enforces it
 * exactly (2,501 fails whole with BadTooManyOperations); Milo publishes 10,000 for Read and 250 for
 * Browse, a 40-fold difference on one server; asyncua publishes 10,000 and served 10,500; open62541
 * publishes 0 and served 20,000. So two of four would happily serve an unbounded request, and the
 * chunk size has to be ours first and theirs only when theirs is smaller and real.
 */
export const OPCUA_MAX_NODES_PER_READ = 200;

/**
 * Why 200 and not 250: ONE NODE COSTS TEN OPERATIONS.
 *
 * A Read takes (node, attribute) pairs and this provider asks for ten per node
 * (`OPCUA_READ_ATTRIBUTES`), so 250 nodes would be exactly 2,500 operations - OPC PLC's enforced
 * limit to the operation, with 2,501 failing whole. 200 nodes is 2,000, which leaves the margin a
 * bound is for rather than sitting on the edge of a measured refusal.
 */

/**
 * How many nodes one Browse asks for, ours.
 *
 * Lower than the Read bound because a Browse answer carries every child of every node asked about,
 * so its size is unbounded in a way a Read's is not: measured on Milo, one Browse of 100 nodes
 * returned 2,162,655 bytes and exceeded the client's own message limit. OPC PLC is the other end of
 * the range and does not make the bound unnecessary: it publishes MaxNodesPerBrowse 2,500, served a
 * Browse of 1,000 nodes as 8.11 MB, and refused 2,500 with `BadEncodingLimitsExceeded` - a
 * per-request refusal with the session still usable, which is a better failure than Milo's and
 * still a failure a reader should not meet.
 */
export const OPCUA_MAX_NODES_PER_BROWSE = 20;

/**
 * The client's own message ceiling, and what crossing it costs - which is not the same on every
 * server.
 *
 * ON MILO AN OVERSIZED ANSWER KILLS THE CHANNEL. Measured: a Browse of 100 nodes answered
 * `max message size exceeded: 2097152 : total message size 2162655`, and every later request on
 * that session then failed `Invalid Channel BadConnectionClosed`, with no recovering the session.
 *
 * ON OPC PLC IT DOES NOT, AND THE CEILING IS NOT WHAT STOPS IT. Measured: a Browse of 1,000 nodes
 * answered 8.11 MB - four times this number - and succeeded, because the library replaces a
 * `maxChunkCount` of 0 with its own default of 0, which means "no limit"; a Browse of 2,500 nodes
 * was refused `BadEncodingLimitsExceeded` and the session stayed usable.
 *
 * So the batch sizes above are set to stay inside this for the server that enforces it, and the
 * ceiling is declared because a ceiling the client states is better than one it discovers.
 */
export const OPCUA_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * Values one history page ASKS FOR, set explicitly and never left to the server.
 *
 * Part 11 6.5.3: in `ReadRawModifiedDetails`, "The default value 0 indicates that there is no
 * maximum" for `numValuesPerNode`, and `node-opcua-client` sends 0 when the caller sets nothing
 * (`options.numValuesPerNode || 0`, `dist/private/client_session_impl.js:328`), so a read that said
 * nothing got whatever page the server felt like.
 *
 * THE SERVER MAY STILL ANSWER FEWER, and OPC PLC does: asked for 1, 50, 100, 101, 250, 500, 1,000
 * and 5,000, it answered 1, 50, 100, 100, 100, 100, 100 and 100. So this is the ceiling of one
 * request, not the size of a page, and the number matters for a different reason: it is part of the
 * details a server validates a continuation against, so it is fixed for a whole read.
 */
export const OPCUA_HISTORY_VALUES_PER_PAGE = 500;

/**
 * The most values one history read returns across all its pages.
 *
 * A history read has no natural end: OPC PLC back-fills synthetic history from before its own start
 * and appends a value every 10 s, so the same 24-hour window measured 11, then 12, then 13 pages
 * over nineteen minutes. The cap is what makes the read finish, and the page says it was reached.
 */
export const OPCUA_HISTORY_VALUE_CAP = 10_000;

/**
 * How many pages of NO VALUES and a continuation point a read will follow before it stops.
 *
 * THE VALUE CAP DOES NOT BOUND THIS, which is the hole it fills. A page that carries values moves
 * the read towards `OPCUA_HISTORY_VALUE_CAP` and the read therefore ends; a page that carries a
 * continuation point and NO values moves nothing, so following it was an unbounded loop. Measured
 * with a server that answers Good, zero values and a point: 50,000 HistoryReadNext calls and still
 * going, with the HTTP request never answering and the session held the whole time.
 *
 * Part 11 does not forbid such a page - a server may be stepping over a gap in its own archive -
 * so a few are followed rather than refused: ten is above anything measured (OPC PLC, open62541,
 * asyncua and the in-process server never answered one at all) and far below a storm.
 */
export const OPCUA_HISTORY_EMPTY_PAGE_LIMIT = 10;

/**
 * The most REQUESTS one history read will spend, whatever the server answers with.
 *
 * THE OTHER TWO BOUNDS LEAVE A GAP BETWEEN THEM, and a review found the server that fits in it: the
 * value cap ends a read that makes progress, and `OPCUA_HISTORY_EMPTY_PAGE_LIMIT` ends one that
 * makes none, but a server that DRIPS - ten empty pages, then one value, for ever - resets the
 * empty-page counter every eleventh page and so meets neither until the cap. Measured against such
 * a client: 109,990 requests inside one HTTP request, which is bounded in theory and a storm at a
 * plant in practice.
 *
 * 300 is above anything a real read needs and far below that: measured on the documented fixture,
 * this server answers 100 values a page (1,200 values in 12 requests, and the node's whole history
 * 1,497 values in 16), so the 10,000-value cap costs 100 requests and the whole node costs 16. This
 * comment used to say 500 a page and 20 requests, which was a page size the server never answered.
 * A read that stops here says so with its own end reason rather than claiming the window was spent.
 */
export const OPCUA_HISTORY_MAX_REQUESTS = 300;

/**
 * `returnBounds`, set explicitly to false.
 *
 * `node-opcua` defaults it to TRUE, and measured on open62541 that turned a one-hour read of a
 * historized node into two rows whose value is null: the bounding values either side of the window
 * rather than the values in it. Raw history in v1 means the values, so this is false and stated.
 */
export const OPCUA_HISTORY_RETURN_BOUNDS = false;

/** `isReadModified`, false: raw history only in v1 (Part 11 6.5.3). */
export const OPCUA_HISTORY_READ_MODIFIED = false;

/**
 * The attributes one Read asks for, per node, in this order.
 *
 * ONE READ, NOT TEN. A node's row and its Source tab need the value and the nine attributes beside
 * it - ten in all, which is what this array holds and what the guide says; this line said NINE, and
 * the two readers of one array disagreeing about its length is the kind of drift a review counts.
 * `Read` takes a list of (node, attribute) pairs, so they travel in one request rather than in
 * one request each. The order is the order the shaping code reads them back in.
 *
 * `NodeClass` is in the set because a Source tab that named every node a Variable would be wrong
 * for the Object and Method rows the same panel lists. `Historizing` is 20, which is worth stating
 * because it is the one a reader guesses wrong: 24 is `RolePermissions` (Part 4 Table 165 /
 * `node-opcua-basic-types`' own `AttributeIds`).
 */
export const OPCUA_READ_ATTRIBUTES = Object.freeze([
  13, // Value
  2, //  NodeClass
  14, // DataType
  15, // ValueRank
  16, // ArrayDimensions
  17, // AccessLevel
  18, // UserAccessLevel
  20, // Historizing
  5, //  Description
  4, //  DisplayName
] as const);

/**
 * The operational-limit nodes read once per session, each with the variable it is (Part 5 6.3.11).
 *
 * `i=2735` and `i=2737` are the continuation-point counts and sit under ServerCapabilities itself;
 * the other three are under its OperationLimits object. `i=2736` is MaxQueryContinuationPoints and
 * is NOT one of these, which is the mistake a reader makes once: it is the node next door.
 *
 * TWO OF THE FIVE BOUND A REQUEST AND THREE ARE READ FOR WHAT THEY RULE OUT, which a review was
 * right to notice and which is a choice rather than an oversight. `maxNodesPerRead` and
 * `maxNodesPerBrowse` are what `limits.ts` chunks by. The other three are read because one Read of
 * five nodes costs the same round trip as one of two, and what they say is worth knowing:
 *  - `maxNodesPerHistoryReadData` cannot bind us - a history read names ONE node, and no server
 *    publishes a limit below one;
 *  - the two continuation-point counts say how scarce the slots are that this provider releases
 *    rather than holds (OPC PLC publishes 10 browse and 100 history points, the in-process server
 *    publishes 0 for both), which is the measurement behind consuming every point inside the
 *    request that received it instead of paging with it.
 * They are also what the live check reports, so a server that publishes something unexpected is
 * visible rather than silently ignored.
 */
export const OPCUA_LIMIT_NODES = Object.freeze({
  maxNodesPerRead: "i=11705",
  maxNodesPerBrowse: "i=11710",
  maxNodesPerHistoryReadData: "i=12165",
  maxBrowseContinuationPoints: "i=2735",
  maxHistoryContinuationPoints: "i=2737",
} as const);
