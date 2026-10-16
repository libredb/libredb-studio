/**
 * The reader: what a device answers, turned into what the provider's surfaces ask for.
 *
 * It owns no XML parsing and no bytes. Parsing is the reader port, which another hand writes
 * (K-10), and the bytes are the session's. What is here is the composition: which request answers
 * which question, what is read once at connect time and kept, and what is derived rather than
 * believed.
 *
 * One measured fact shapes the whole file. On the fixture, the hello advertises NMDA in ZERO of its
 * 29 capabilities, the YANG library lists `ietf-netconf-nmda`, and `<get-data>` is served and
 * answers without an error. So a provider that decided NMDA from the hello would refuse to use an
 * operation the device serves, on a server that advertises its other capabilities perfectly well.
 * The library is the source, and section 7 of the specification is why the library is read at all.
 */
import { QueryError } from "@/lib/db/errors";
import type { QueryResult } from "@/lib/types";
import { compareUtf8, type LevelEntry, type PathNode } from "./keypath";
import { READER_LIMITS, type XmlElement, type XmlReaderPort } from "./reader-port";
import { moduleNamespace, rememberNamespace, type NetconfRequest, type NmdaDatastore } from "./requests";
import { buildRows } from "./rows";
import { keyNamesOf, scanYangModule, type YangScan } from "./yangkeys";

/** What the reader needs from a session: the five operations and an end. Nothing else. */
export interface SessionPort {
  request(request: NetconfRequest): Promise<string>;
  close(): Promise<void>;
}

/** The hello's facts, as the session read them. */
export interface HelloFacts {
  readonly sessionId: string;
  readonly capabilities: readonly string[];
}

export interface DeviceFacts {
  readonly datastores: readonly string[];
  readonly modules: readonly string[];
  readonly nmda: boolean;
  readonly capabilities: readonly string[];
  readonly sessionId: string;
}

export interface TopLevelNode {
  readonly module: string;
  readonly name: string;
  readonly keys?: readonly string[];
}

const CANDIDATE = "urn:ietf:params:netconf:capability:candidate:1.0";
const STARTUP = "urn:ietf:params:netconf:capability:startup:1.0";
const NMDA_MODULE = "ietf-netconf-nmda";

/** The datastores a read may name, and no others. */
const CONFIG_DATASTORES = new Set(["running", "candidate", "startup"]);
const NMDA_ONLY_DATASTORES = new Set(["operational", "intended"]);

export class DeviceReaderImpl {
  readonly facts: DeviceFacts;
  private readonly session: SessionPort;
  private readonly xml: XmlReaderPort;
  /** Module text is fetched once per module per connection: it does not change under a session. */
  private readonly texts = new Map<string, string>();
  private readonly scans = new Map<string, YangScan>();

  private constructor(session: SessionPort, xml: XmlReaderPort, facts: DeviceFacts) {
    this.session = session;
    this.xml = xml;
    this.facts = facts;
  }

  /**
   * Opens a reader: reads the YANG library once and derives the facts from it.
   *
   * The library read is the only request made before the user asks for anything, and section 7
   * gives its reason: a module's namespace is learned rather than guessed, because a wrong
   * namespace answers an empty `<data/>` on both measured servers instead of an error, which a
   * user would read as "nothing there".
   */
  static async open(session: SessionPort, xml: XmlReaderPort, hello: HelloFacts): Promise<DeviceReaderImpl> {
    // `modules-state` and not `yang-library`, although RFC 8525 replaced the first with the second.
    // MEASURED on the fixture: both are answered, 18,152 characters and 16,482, and `modules-state`
    // carries each module's `conformance-type` as a direct child, where the newer form nests them
    // under module sets. A server that serves only the newer form would need a second read, and
    // that read is not written here: no server we have measured drops `modules-state`, so the
    // branch would be one nothing runs. It is stated in the specification instead, as the thing to
    // measure on the first device that refuses this read.
    const reply = await session.request({ operation: "get", filter: { nodes: [{ name: "modules-state" }] } });
    const library = elementAt(parseReply(xml, reply), ["modules-state"]);
    if (library === undefined) {
      throw new QueryError("this device answered no YANG library, so its modules cannot be listed");
    }
    const modules: string[] = [];
    let nmda = false;
    for (const entry of library.children.filter((child) => child.name === "module")) {
      const name = textOf(entry, "name");
      if (name === undefined) continue;
      if (name === NMDA_MODULE) nmda = true;
      const namespace = textOf(entry, "namespace");
      if (namespace !== undefined) rememberNamespace(name, namespace);
      // A module the device implements holds data. One it only imports contributes types and
      // groupings to others and has no tree of its own, so listing it would draw an empty folder.
      if (textOf(entry, "conformance-type") === "implement") modules.push(name);
    }
    const datastores = ["running"];
    if (hello.capabilities.includes(CANDIDATE)) datastores.push("candidate");
    if (hello.capabilities.includes(STARTUP)) datastores.push("startup");
    if (nmda) datastores.push("operational", "intended");
    return new DeviceReaderImpl(session, xml, {
      datastores,
      /*
       * `compareUtf8` AND NOT `localeCompare`, which is the comparator Sonar's rule suggests. A
       * bare `sort()` is a real finding and an explicit comparator is the fix; WHICH explicit
       * comparator was measured rather than chosen.
       *
       * A YANG module name is an RFC 7950 `identifier`: ASCII letters, digits, `_`, `-` and `.`,
       * never a word in a language. MEASURED on the recorded capture: all 71 names the fixture
       * returns match that pattern and not one carries a byte above ASCII.
       *
       * And collation is not stable across machines for these values. MEASURED over eight locales
       * on those same 71 names, `localeCompare` produces TWO different orders: `lt-LT` puts `yang`
       * where the other seven put `ietf-crypto-types`, because Lithuanian collates `y` elsewhere in
       * its alphabet. Choosing it would tie the module list, and the key paths built from it, to
       * the locale data of whichever machine is running.
       *
       * `compareUtf8` is this provider's own comparator, already required for level pages because
       * the level contract asks for UTF-8 byte order. MEASURED: it gives the identical order to the
       * bare `sort()` for all 71 names, so nothing a reader sees moves and the order
       * `tests/unit/db/netconf/reader.test.ts` pins stays pinned.
       */
      modules: [...modules].sort(compareUtf8),
      nmda,
      capabilities: hello.capabilities,
      sessionId: hello.sessionId,
    });
  }

  /** The module text, through `<get-schema>` on this session and never from a `location`. */
  async moduleText(module: string): Promise<string> {
    const held = this.texts.get(module);
    if (held !== undefined) return held;
    const reply = await this.session.request({ operation: "get-schema", identifier: module });
    const data = elementAt(parseReply(this.xml, reply), []);
    const text = data?.text;
    if (text === undefined || text === "") {
      throw new QueryError(`this device returned no text for the module ${module}`);
    }
    this.texts.set(module, text);
    return text;
  }

  private async scanOf(module: string): Promise<YangScan> {
    const held = this.scans.get(module);
    if (held !== undefined) return held;
    const scan = scanYangModule(await this.moduleText(module));
    this.scans.set(module, scan);
    return scan;
  }

  /**
   * The top level containers and lists of one module in one datastore.
   *
   * The read is bounded by depth rather than by a filter on each node: depth 2 answers every top
   * level node with its key leaf alone, measured at 234,120 bytes for a list of 5,000, where the
   * unfiltered read of the same list is 987,957.
   *
   * THE MODULE IS SELECTED BY NAMESPACE, AND IT HAS TO BE, because the read cannot carry the
   * module in its filter. A subtree filter selects ELEMENTS by name, and this read names no
   * element - it is the whole datastore at depth 2 - so `readOf` drops the nameless node and sends
   * no filter at all. MEASURED on the fixture before this was written: `ietf-interfaces`,
   * `ietf-keystore` and `ietf-netconf-server` each answered the SAME three nodes, the datastore's
   * whole top level, so choosing a module in the tree changed nothing. The namespace the YANG
   * library gave for the module is what tells the three apart, and resolving it is exactly what
   * this provider's XML port adds over the inherited reader (`xml.ts`).
   *
   * KNOWN COST, stated rather than hidden: `maxDepth` is an NMDA parameter, so it binds on
   * `operational` and `intended` and NOT on `running`, `candidate` or `startup`, which are read
   * with `<get-config>`. Opening a module under `running` therefore pulls the whole datastore -
   * 987,956 bytes on this fixture - and discards what belongs to other modules. The bound that
   * applies there is the framing's byte cap, not this one.
   */
  async topLevelNodes(datastore: string, module: string): Promise<readonly TopLevelNode[]> {
    const reply = await this.session.request(this.readOf(datastore, [{ name: "", module }], 2));
    const data = elementAt(parseReply(this.xml, reply), []);
    if (data === undefined) return [];
    const namespace = moduleNamespace(module);
    const scan = await this.scanOf(module);
    const nodes: TopLevelNode[] = [];
    for (const child of data.children) {
      if (child.namespace !== namespace) continue;
      const keys = keyNamesOf(scan, child.name);
      nodes.push(keys.length === 0 ? { module, name: child.name } : { module, name: child.name, keys });
    }
    return nodes;
  }

  /** One level of the Keys panel: the entries below `path`, as the level contract spells them. */
  async children(datastore: string, path: readonly PathNode[]): Promise<readonly LevelEntry[]> {
    if (path.length === 0) throw new QueryError("a key level names a node, so the path cannot be empty");
    const reply = await this.session.request(this.readOf(datastore, path, path.length + 2));
    const parent = elementAt(
      parseReply(this.xml, reply),
      path.map((node) => node.name),
    );
    if (parent === undefined) return [];
    // A folder is a node the panel can descend and a key is a terminal. The tree itself says
    // which: an element holding elements is a container, a list or a list entry, and an element
    // holding only text is a leaf or one value of a leaf-list. The declaration this serves lists
    // exactly those five things (specification section 6, Y-S6).
    return parent.children.map((child) => ({
      name: child.name,
      kind: child.children.length > 0 ? ("folder" as const) : ("key" as const),
    }));
  }

  /** The grid's rows for the list at the end of `path`. */
  async rows(datastore: string, path: readonly PathNode[], limit: number): Promise<QueryResult> {
    const last = path[path.length - 1];
    // Not named `module`: the repository's lint refuses that identifier (Next's
    // no-assign-module-variable), which is a real constraint and not a style note.
    const moduleName = path[0]?.module;
    if (last === undefined || moduleName === undefined) {
      throw new QueryError("a read names a module and then the list to read");
    }
    const started = Date.now();
    const reply = await this.session.request(this.readOf(datastore, path, undefined));
    const names = path.map((node) => node.name);
    const parent = elementAt(parseReply(this.xml, reply), names.slice(0, -1));
    if (parent === undefined) {
      return { rows: [], fields: [], rowCount: 0, executionTime: Date.now() - started };
    }
    const scan = await this.scanOf(moduleName);
    const keyNames = keyNamesOf(scan, last.name);
    const descended = keyNames.length === 0 ? listInside(scan, elementAt(parent, [last.name])) : undefined;
    const built =
      descended === undefined
        ? buildRows(parent, last.name, keyNames)
        : buildRows(descended.holder, descended.list, keyNamesOf(scan, descended.list));
    const rows = built.rows.slice(0, limit);
    return {
      rows: rows as Record<string, unknown>[],
      fields: [...built.columns],
      rowCount: rows.length,
      executionTime: Date.now() - started,
    };
  }

  /**
   * The raw XML the device sent for `path`, for the Source tab.
   *
   * The reply is validated through the port, so a refusal is still the device's own sentence, and
   * the TEXT is sliced from the reply rather than printed from the tree. That is the point: a
   * Source tab shows what the device sent, and anything this provider re-printed from a parsed tree
   * would be a reconstruction wearing the device's name. The house vocabulary has a word for the
   * difference (`ObjectSourceOrigin`: `stored` against `regenerated`), and slicing is what lets
   * this answer `stored` honestly.
   */
  async sourceXml(datastore: string, path: readonly PathNode[]): Promise<string> {
    if (path.length === 0) throw new QueryError("a source read names a node, so the path cannot be empty");
    const reply = await this.session.request(this.readOf(datastore, path, undefined));
    // Validation first, and through the port, so an `rpc-error` becomes the device's sentence
    // instead of being sliced into the editor as though it were data.
    parseReply(this.xml, reply);
    // The element may carry a namespace prefix, and `<data>` and `<nc:data>` are the same element.
    // MEASURED against the pattern this replaced: a prefixed reply answered "this device answered
    // no data for this path", which is a sentence about the device for a fault in the reading.
    const opening = reply.search(/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?data[\s>/]/);
    if (opening === -1) throw new QueryError("this device answered no data for this path");
    const selfClosing = /^<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?data[^>]*\/>/.exec(reply.slice(opening, opening + 400));
    if (selfClosing !== null) return "";
    const from = reply.indexOf(">", opening) + 1;
    const closings = [...reply.matchAll(/<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?data\s*>/g)];
    const last = closings[closings.length - 1];
    const to = last === undefined ? -1 : (last.index ?? -1);
    if (to <= from) throw new QueryError("this device answered no data for this path");
    return reply.slice(from, to);
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  /**
   * The request for one read, chosen by the datastore named.
   *
   * `<get-data>` is the only way to read `operational` and `intended`, and it is used for those
   * alone: the three configuration datastores are read with `<get-config>`, which every server
   * serves, while `<get-data>` is served by one of the two measured servers and refused by the
   * other with `operation-not-supported`. Choosing the older operation wherever it answers the
   * question keeps this provider working on both.
   */
  private readOf(datastore: string, path: readonly PathNode[], maxDepth: number | undefined): NetconfRequest {
    const nodes = path.filter((node) => node.name !== "");
    const filter = nodes.length === 0 ? undefined : { nodes };
    if (CONFIG_DATASTORES.has(datastore)) {
      return {
        operation: "get-config",
        source: datastore as "running" | "candidate" | "startup",
        ...(filter === undefined ? {} : { filter }),
      };
    }
    if (!NMDA_ONLY_DATASTORES.has(datastore)) {
      throw new QueryError(`this engine has no datastore named ${datastore}`);
    }
    if (!this.facts.nmda) {
      throw new QueryError(`this device does not serve the ${datastore} datastore`);
    }
    return {
      operation: "get-data",
      datastore: datastore as NmdaDatastore,
      ...(filter === undefined ? {} : { filter }),
      ...(maxDepth === undefined ? {} : { maxDepth }),
    };
  }
}

/** The `<data>` of a reply, or a refusal carrying the device's own words. */
function parseReply(xml: XmlReaderPort, reply: string): XmlElement {
  const root = xml.parse(reply, READER_LIMITS);
  const error = root.children.find((child) => child.name === "rpc-error");
  if (error !== undefined) {
    const message = textOf(error, "error-message") ?? textOf(error, "error-tag") ?? "the device refused this read";
    throw new QueryError(message);
  }
  const data = root.children.find((child) => child.name === "data");
  if (data === undefined) throw new QueryError("this device answered neither data nor an error");
  return data;
}

/**
 * The list a container holds, where the tree's own click lands on the container rather than on it.
 *
 * MEASURED, and the reason this exists: `listObjects` answers a module's TOP LEVEL nodes, and in
 * `ietf-interfaces` that is the container `interfaces`, not the list `interface` inside it. A click
 * therefore asks for the container, and `buildRows` read it as a list of its own name: ONE row with
 * ONE column, holding the JSON of all 5,000 entries, cut at the cell bound of 64 KB. Addressed
 * directly, `ietf-interfaces:interfaces/interface` answered 3 rows with the columns `name`,
 * `description`, `type` and `enabled`. So the shipped click was the bad one and the typed path was
 * right, which is the wrong way round.
 *
 * The rule is deliberately NARROW and is the one the module's own text supports: the addressed node
 * declares no `key` statement, so it is not a list, AND its children carry exactly one distinct
 * name, AND the module declares THAT name as a list with keys. Anything looser would be a guess
 * about what a reader meant. A container holding several child names keeps the old reading, and so
 * does one whose single child name the module does not call a list, which includes a keyless list
 * (RFC 8040 section 3.5.3) - that case is left alone rather than handled, because no measurement of
 * this fixture reaches it.
 */
function listInside(scan: YangScan, node: XmlElement | undefined): { holder: XmlElement; list: string } | undefined {
  if (node === undefined) return undefined;
  const names = new Set(node.children.map((child) => child.name));
  if (names.size !== 1) return undefined;
  const only = [...names][0];
  if (only === undefined || keyNamesOf(scan, only).length === 0) return undefined;
  return { holder: node, list: only };
}

/** The element at a chain of names below `from`, or undefined where the chain breaks. */
function elementAt(from: XmlElement, names: readonly string[]): XmlElement | undefined {
  let at: XmlElement | undefined = from;
  for (const name of names) {
    at = at?.children.find((child) => child.name === name);
    if (at === undefined) return undefined;
  }
  return at;
}

function textOf(element: XmlElement, name: string): string | undefined {
  return element.children.find((child) => child.name === name)?.text;
}
