import { QueryError } from "@/lib/db/errors";
/**
 * The closed operation set of the `netconf` provider, phase 1 (issue #1724), requirement NC-S1.
 *
 * Five operations go into an `<rpc>` and nothing else can: `<get>`, `<get-config>`, `<get-data>`,
 * `<get-schema>` and `<close-session>`, plus the hello. Every one is built here from typed
 * arguments, so a caller cannot assemble a sixth: there is no function that takes element text.
 *
 * MEASURED 2026-10-13 with the fixture's read only NACM account, fourteen operations in one
 * session: lock, unlock, edit-config, copy-config, delete-config, commit, validate,
 * discard-changes, kill-session and create-subscription each answered `access-denied`, ten out of
 * ten, while the four reads returned data and `close-session` answered `<ok/>`. So a device can be
 * made to refuse as well, but only where an administrator applied that rule list. This file is the
 * half that does not depend on the device.
 */

import { assertYangIdentifier, type PathNode } from "./keypath";

const BASE_NS = "urn:ietf:params:xml:ns:netconf:base:1.0";
const NMDA_NS = "urn:ietf:params:xml:ns:yang:ietf-netconf-nmda";
const DATASTORE_NS = "urn:ietf:params:xml:ns:yang:ietf-datastores";
const MONITORING_NS = "urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring";

export type ConfigDatastore = "running" | "candidate" | "startup";
export type NmdaDatastore = "running" | "candidate" | "startup" | "operational" | "intended";

/** Escapes text for an element body or an attribute value. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface SubtreeFilter {
  /** The node chain to fetch, as the key path grammar spells it. */
  readonly nodes: readonly PathNode[];
  /**
   * The namespace of each module the chain names, from the YANG library the same session read. The agent's reads pass
   * it, so a read never takes a namespace another connection's library left in the module-scoped map below.
   */
  readonly namespaces?: ReadonlyMap<string, string>;
}

/**
 * Builds a subtree filter that matches one entry exactly.
 *
 * MEASURED 2026-10-13: an exact match subtree filter answered 374 bytes for one interface out of
 * 5000 on Netopeer2 and 211 bytes for one entry out of 5000 on Clixon, against roughly a megabyte
 * for the unfiltered read. This is the shape every grid page uses.
 */
function subtreeFilter(filter: SubtreeFilter): string {
  return `<filter type="subtree">${filterBody(filter)}</filter>`;
}

/**
 * The same node chain for `<get-data>`, which carries it in a different element.
 *
 * MEASURED 2026-10-13 against Netopeer2: `<get-data>` with `<filter type="subtree">` is refused
 * with `operation-failed` and the device's own sentence, `Node "filter" not found as a child of
 * "get-data" node.`, on `operational` and on `running` alike, while the identical filter is
 * answered by `<get-config>`. STANDARD: RFC 8526 section 3.1.1 names the child `subtree-filter`,
 * so the two operations do not share the element and only the body is shared. This cost two reads
 * their whole result, and no test caught it, because every test compared our own text with our own
 * expectation.
 */
function nmdaSubtreeFilter(filter: SubtreeFilter): string {
  return `<subtree-filter>${filterBody(filter)}</subtree-filter>`;
}

/**
 * The node chain itself, without the element that carries it.
 *
 * Every element name written here is held to the YANG identifier grammar again, whoever built the
 * node: the path parsers refuse a bad segment first. Key names come from `PathNode.keyNames` when a
 * caller sets one and default to `name`. Key values are element bodies and are escaped instead.
 */
function filterBody(filter: SubtreeFilter): string {
  const build = (index: number): string => {
    const node = filter.nodes[index];
    if (!node) return "";
    const ns = node.module ? ` xmlns="${escapeXml(namespaceIn(node.module, filter.namespaces))}"` : "";
    const keys = (node.keys ?? []).map((value, position) => {
      const name = assertYangIdentifier(node.keyNames?.[position] ?? "name");
      return `<${name}>${escapeXml(value)}</${name}>`;
    });
    const inner = keys.join("") + build(index + 1);
    const name = assertYangIdentifier(node.name);
    return `<${name}${ns}>${inner}</${name}>`;
  };
  return build(0);
}

/**
 * The namespace of a module, which the provider learns from the YANG library rather than guessing.
 *
 * The map is filled per connection from the library read at connect time. A module the library did
 * not name is a configuration error and not a guess, because a wrong namespace returns an empty
 * `<data/>` on both measured servers rather than an error, which would read as "nothing there".
 */
const NAMESPACES = new Map<string, string>();

export function rememberNamespace(module: string, namespace: string): void {
  NAMESPACES.set(module, namespace);
}

/** The namespace of `module` from `namespaces` when a read carries its own library, else from the map above. */
function namespaceIn(module: string, namespaces: ReadonlyMap<string, string> | undefined): string {
  if (namespaces === undefined) return moduleNamespace(module);
  const known = namespaces.get(module);
  if (!known) throw new QueryError(`the YANG library of this connection does not name module ${module}`);
  return known;
}

export function moduleNamespace(module: string): string {
  const known = NAMESPACES.get(module);
  // A refusal the user reads, so it is a QueryError: see the note in keypath.ts.
  if (!known) throw new QueryError(`the YANG library of this connection does not name module ${module}`);
  return known;
}

export interface GetConfigRequest {
  readonly operation: "get-config";
  readonly source: ConfigDatastore;
  readonly filter?: SubtreeFilter;
}

export interface GetRequest {
  readonly operation: "get";
  readonly filter?: SubtreeFilter;
}

export interface GetDataRequest {
  readonly operation: "get-data";
  readonly datastore: NmdaDatastore;
  readonly filter?: SubtreeFilter;
  /**
   * MEASURED 2026-10-13 on Netopeer2: max-depth 0 is refused with `operation-failed`, 1 answers an
   * empty `<data>` of 153 bytes, and 2 answers every entry of a top level list with its key leaf
   * only, 5000 of 5000. So 1 is never sent and 2 is what a level listing asks for.
   */
  readonly maxDepth?: number;
}

export interface GetSchemaRequest {
  readonly operation: "get-schema";
  readonly identifier: string;
  readonly version?: string;
}

export interface CloseSessionRequest {
  readonly operation: "close-session";
}

export type NetconfRequest = GetConfigRequest | GetRequest | GetDataRequest | GetSchemaRequest | CloseSessionRequest;

/** The five allowed operations, named so a guard test can assert the set has not grown. */
export const ALLOWED_OPERATIONS = Object.freeze([
  "get",
  "get-config",
  "get-data",
  "get-schema",
  "close-session",
] as const);

/** Builds the `<rpc>` for one request. The only way this module produces element text. */
export function buildRpc(request: NetconfRequest, messageId: number): string {
  if (!Number.isInteger(messageId) || messageId < 1) {
    // Not a QueryError: no user can cause this. It is this provider counting wrongly.
    throw new Error("a message-id is a positive integer");
  }
  const body = buildOperation(request);
  return `<rpc message-id="${messageId}" xmlns="${BASE_NS}">${body}</rpc>`;
}

function buildOperation(request: NetconfRequest): string {
  switch (request.operation) {
    case "get":
      return `<get>${request.filter ? subtreeFilter(request.filter) : ""}</get>`;
    case "get-config":
      return `<get-config><source><${request.source}/></source>${
        request.filter ? subtreeFilter(request.filter) : ""
      }</get-config>`;
    case "get-data": {
      const depth = request.maxDepth === undefined ? "" : `<max-depth>${assertDepth(request.maxDepth)}</max-depth>`;
      return (
        `<get-data xmlns="${NMDA_NS}" xmlns:ds="${DATASTORE_NS}">` +
        `<datastore>ds:${request.datastore}</datastore>` +
        `${request.filter ? nmdaSubtreeFilter(request.filter) : ""}${depth}` +
        `</get-data>`
      );
    }
    case "get-schema":
      return (
        `<get-schema xmlns="${MONITORING_NS}">` +
        `<identifier>${escapeXml(request.identifier)}</identifier>` +
        (request.version ? `<version>${escapeXml(request.version)}</version>` : "") +
        // Format yang only. MEASURED 2026-10-13: `yin` is listed in the schemas list and refused
        // with `invalid-value` when asked for, so the advertised set is not the usable set.
        `<format>yang</format>` +
        `</get-schema>`
      );
    case "close-session":
      return "<close-session/>";
  }
}

function assertDepth(depth: number): number {
  if (!Number.isInteger(depth) || depth < 2) {
    // 0 is refused by the server and 1 answers an empty document, so neither is ever sent.
    throw new QueryError("max-depth is an integer of 2 or more");
  }
  return depth;
}
