/**
 * The `netconf` provider class (issue #1724, phase 1).
 *
 * It extends the repository's base class and answers the seventeen members that class declares
 * abstract. Its type-id is now in the shared unions - `DatabaseType`, `QueryDialect`, and the
 * factory's switch - because this file landed together with the registration.
 *
 * WHAT THE DIALECT IS FOR, MEASURED RATHER THAN ARGUED. `resolveTabType` gives every provider
 * whose `queryLanguage` is `"json"` and which declares no dialect of its own MongoDB's tab type.
 * Run without a dialect, this engine's console read as MongoDB's and `offersCountQuery`,
 * `offersCodeGeneration` and `offersColumnProfiling` all answered TRUE, because those readers
 * consult a dialect spec only when one is declared: a read-only device with no columns was
 * offering column profiling and a count query. The declaration below is what turns those off.
 *
 * Three kinds of answer appear below and the difference is deliberate:
 *   a read this engine performs            the device layer is asked and rows come back
 *   a question this engine has none of     an empty answer, which is the truthful one
 *   a question it cannot answer, or an     a stated refusal, never an empty answer, because an
 *   action it will not perform             empty answer draws "none" where the truth is
 *                                          "not applicable to this engine"
 */

import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { QueryError, RefusedBeforeSendError, TimeoutError } from "@/lib/db/errors";
import { assertReadOnlyBudget } from "@/lib/db/providers/sql/read-only-budget";
import type {
  KeyScanOptions,
  KeyScanPage,
  ObjectSourceDocument,
  ObjectSourcePart,
  ActiveSessionDetails,
  Container,
  DatabaseConnection,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  PerformanceMetrics,
  ProviderCapabilities,
  ProviderExecutionContext,
  ProviderLabels,
  ProviderOptions,
  QueryResult,
  ReadOnlyStatementBudget,
  ReadOnlyStatementMode,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { NETCONF_PORT } from "./dial";
import { buildKeyPath, encodeSegment, levelPage, parseKeyPath, type LevelEntry, type PathNode } from "./keypath";
import { NETCONF_KEY_SCAN, NETCONF_KEY_SEPARATOR, NETCONF_OBJECT_KINDS, assertDeclarationIsSound } from "./objectkinds";
import { NETCONF_LABELS } from "./labels";
import { parseReadRequest } from "./read-request";
import type { NetconfAgentClient } from "./agent-client";
import { netconfAgentResult, runNetconfAgentReadWithin } from "./agent-read";
import { readNetconfAgentStatement } from "./agent-statement";
import { NETCONF_AGENT_WITHHELD } from "./agent-surface";
import { NETCONF_METADATA_ONLY } from "./agent-withheld";

export { parseReadRequest } from "./read-request";
import type { TopLevelNode } from "./reader";

/** What the provider learns from the device when the session opens. */
export interface DeviceFacts {
  readonly datastores: readonly string[];
  readonly modules: readonly string[];
  /** True when `<get-data>` is served. MEASURED: Clixon answers `operation-not-supported`. */
  readonly nmda: boolean;
  readonly capabilities: readonly string[];
  readonly sessionId: string;
}

/**
 * A node of a module, as the device layer answers it.
 *
 * IMPORTED rather than redeclared, and the difference was a defect rather than a style point.
 * This file used to declare its own `{module, name, isList}`, and `reader.ts` answers
 * `{module, name, keys?}`. The two never met, because nothing assigned the implementation to this
 * interface until the provider was wired to its real device layer; the compiler then refused the
 * assignment at once. `isList` was read by NOTHING in this provider: the only values of it in the
 * tree were the ones a test double made up, so the field asked the device layer for an answer it
 * never computes and no caller ever wanted. `keys` is the honest shape: it names the key leaves
 * the module declares, and a list with no key statement is still a list, which is why its absence
 * is not "this is not a list" (RFC 8040 section 3.5.3).
 */

/** What this class needs from the layer that talks to the device. */
export interface DeviceReader {
  readonly facts: DeviceFacts;
  topLevelNodes(datastore: string, module: string): Promise<readonly TopLevelNode[]>;
  children(datastore: string, path: readonly PathNode[]): Promise<readonly LevelEntry[]>;
  rows(datastore: string, path: readonly PathNode[], limit: number): Promise<QueryResult>;
  moduleText(module: string): Promise<string>;
  sourceXml(datastore: string, path: readonly PathNode[]): Promise<string>;
  close(): Promise<void>;
}

const SENTENCES = Object.freeze({
  notOpen: "This connection is not open.",
  twoLevels: "A NETCONF connection names a datastore and then a module, so a container is one or two names.",
  noMetrics:
    "A NETCONF device publishes no query statistics, so this panel has nothing to read. The device's own counters are in its YANG data and are read as rows.",
  noSessions:
    "Studio does not list a device's NETCONF sessions: reading /netconf-state/sessions would show other operators' addresses, and this provider reads nothing it does not need.",
  noTables: "A NETCONF device has no tables and no indexes. Its data is a YANG tree, which the object browser walks.",
  noStorage: "A NETCONF device reports no storage figures through NETCONF.",
  noMaintenance:
    "This provider performs no maintenance on a device. It sends four read operations and a close, and nothing else, so there is no operation here to run.",
  keysPanel:
    "Keys are listed by the Keys panel, one level at a time, and not by this listing. Open the node and use Browse Keys.",
  readsOnly:
    "This provider reads a device and does not write to it: it sends get, get-config, get-data, get-schema and close-session, and nothing else. A read request names a datastore and a path.",
  /*
   * THE SEPARATOR AT THE END IS THE WHOLE POINT and the old sentence left it out. It read
   * "datastore/module:node and then one name per level", which is the spelling that cannot work:
   * the route holds a level page to keys sitting DIRECTLY under the pattern, so a pattern with no
   * trailing separator names the datastore's own top level, which this provider cannot read. The
   * panel's placeholder has always taught the other spelling (`Prefix, e.g. app/config/`), so a
   * reader following the provider's words and a reader following the panel were told two things.
   */
  keyPrefix:
    "A key level is named by a prefix that ends with the separator: running/ietf-interfaces:interfaces/ lists that node's children, and one more name per level below it. A prefix holding only a datastore and a node names no level, because this provider sends no unfiltered read of a datastore.",
  sourceNodePath: "A node's source is addressed by its datastore, its module and the node, so the path is three names.",
  sourceKeyPath:
    "A key's source is addressed by its key path, which begins with the datastore, so the path is one name.",
});

/** The words a write looks like, so a user who types one is told what this provider is. */
const WRITE_WORDS =
  /\b(edit-config|copy-config|delete-config|commit|lock|unlock|discard-changes|kill-session|set|write|create|update|delete)\b/i;

/**
 * The default device layer: the real ports, reached by a dynamic import.
 *
 * The import is dynamic and not static for one mechanical reason: `open.ts` pulls in
 * `node-ports.ts`, which holds `ssh2` and `node:net`, and this module is reachable from code that
 * is bundled for the browser. The factory imports this file the same way and for the same reason.
 *
 * `openNetconfReader` already defaults the SSH and socket ports, so the only port named here is
 * the XML reader, which is the one decision this provider makes about its own parsing (K-10).
 */
async function openWithNodePorts(config: DatabaseConnection): Promise<DeviceReader> {
  const [{ openNetconfReader }, { netconfXmlPort }] = await Promise.all([import("./open"), import("./xml")]);
  return openNetconfReader(config, { xml: netconfXmlPort });
}

/** The agent's door, over the same ports and dynamic imports: one session, nothing read on it yet. */
async function openAgentWithNodePorts(config: DatabaseConnection): Promise<NetconfAgentClient> {
  const [{ openNetconfSession }, { netconfXmlPort }, { createNetconfAgentClient }] = await Promise.all([
    import("./open"),
    import("./xml"),
    import("./agent-client"),
  ]);
  return createNetconfAgentClient(await openNetconfSession(config, { xml: netconfXmlPort }), netconfXmlPort);
}

/** Studio's own refusals on the agent's statement path, made before anything is sent. */
export const NETCONF_PROVIDER_SENTENCES = Object.freeze({
  profileRequired: "Read-only execution requires a provider opened under the agent read-only profile",
  noEstimate: "NETCONF composes no estimating plan for the agent",
});

export class NetconfProvider extends BaseDatabaseProvider {
  private reader: DeviceReader | null = null;
  private readonly openReader: (config: DatabaseConnection) => Promise<DeviceReader>;
  private readonly openAgent: (config: DatabaseConnection) => Promise<NetconfAgentClient>;

  /**
   * The base class constructor is protected, so every provider declares its own.
   *
   * The device layer is injected rather than built here, which is what lets every rule in this
   * class be tested without a network. The execution context comes third, as on every provider that
   * reads it, so the injected device layer is fourth, and the agent's door, a session per read, fifth.
   */
  public constructor(
    config: DatabaseConnection,
    options: ProviderOptions = {},
    private readonly execution: ProviderExecutionContext = {},
    openReader?: (config: DatabaseConnection) => Promise<DeviceReader>,
    openAgent?: (config: DatabaseConnection) => Promise<NetconfAgentClient>,
  ) {
    super(config, options);
    assertDeclarationIsSound();
    this.openReader = openReader ?? openWithNodePorts;
    this.openAgent = openAgent ?? openAgentWithNodePorts;
  }

  /**
   * Whether this handle was opened for the agent read-only profile by an acquisition that sends statements
   * (`sendsStatements`). Only then does `queryReadOnly` answer; the operations profile's acquisitions send no statement.
   */
  private get readOnlyProfile(): boolean {
    return this.execution.readOnly === true && this.execution.sendsStatements === true;
  }

  /**
   * Whether this handle was opened for any agent-mode profile: every execution profile opens `readOnly` and no editor
   * handle does. On such a handle the console, a key's raw XML and the overview's filled-in figures are refused with
   * their reason, since none of them passes through the withheld-node check.
   */
  private get agentProfile(): boolean {
    return this.execution.readOnly === true;
  }

  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      // Its own dialect, so the tab type and the three `offers*` flags are this engine's and not
      // MongoDB's (see the note at the top of this file for what was measured without it).
      queryDialect: "netconf",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Structural: this provider has no code that can write to a device.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: NETCONF_PORT,
      statementTerminator: "none",
      containerLevels: [
        { id: "catalog", label: "Datastore", labelPlural: "Datastores" },
        { id: "schema", label: "Module", labelPlural: "Modules" },
      ],
      objectKinds: NETCONF_OBJECT_KINDS,
      keyScan: NETCONF_KEY_SCAN,
      // Agent reads answer values, and a withheld node answers only its path, its kind and a count.
      metadataOnly: NETCONF_METADATA_ONLY,
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  public override getLabels(): ProviderLabels {
    return { ...NETCONF_LABELS };
  }

  public async connect(): Promise<void> {
    this.reader = await this.openReader(this.config);
  }

  public async disconnect(): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    if (reader) await reader.close();
  }

  /**
   * One read request.
   *
   * It PARSES first and refuses second, so a user who types a write gets told what this provider
   * is rather than what its parser could not read.
   */
  public async query(statement: string): Promise<QueryResult> {
    const reader = this.open();
    if (this.agentProfile) throw new RefusedBeforeSendError(NETCONF_AGENT_WITHHELD.query, "netconf", statement);
    if (WRITE_WORDS.test(statement) && !looksLikeReadRequest(statement)) {
      throw new QueryError(SENTENCES.readsOnly);
    }
    const request = parseReadRequest(statement);
    return reader.rows(request.datastore, request.path, request.limit);
  }

  /**
   * One agent statement. Only on a handle opened under the agent read-only profile; the statement is read by
   * `readNetconfAgentStatement` and refused before anything is sent when it is not one of agent mode's reads. The read
   * runs over a session opened for it alone (`runNetconfAgentReadWithin`), which first reads the device's YANG modules
   * and decides what is withheld, and is closed when it ends, so nothing of one call reaches the next. Its answer is
   * refused past the row, byte or time budget rather than cut, and a failure is worded by its category.
   */
  public async queryReadOnly(
    statement: string,
    budget: ReadOnlyStatementBudget,
    mode: ReadOnlyStatementMode = "execute",
  ): Promise<QueryResult> {
    if (!this.readOnlyProfile) {
      throw new RefusedBeforeSendError(NETCONF_PROVIDER_SENTENCES.profileRequired, "netconf", statement);
    }
    this.open();
    assertReadOnlyBudget(budget, "netconf");
    if (mode !== "execute")
      throw new RefusedBeforeSendError(NETCONF_PROVIDER_SENTENCES.noEstimate, "netconf", statement);
    const reading = readNetconfAgentStatement(statement);
    if (!reading.ok) throw new RefusedBeforeSendError(reading.message, "netconf", statement);
    const started = Date.now();
    const answer = await runNetconfAgentReadWithin(() => this.openAgent(this.config), reading.plan, budget);
    return netconfAgentResult(answer, budget, Date.now() - started);
  }

  public async listContainers(parent?: readonly string[]): Promise<Container[]> {
    const reader = this.open();
    if (!parent || parent.length === 0) {
      return reader.facts.datastores.map((name) => ({ path: [name], name, level: 0 }));
    }
    if (parent.length === 1) {
      return reader.facts.modules.map((name) => ({ path: [...parent, name], name, level: 1, kinds: ["node"] }));
    }
    throw new QueryError(SENTENCES.twoLevels);
  }

  /**
   * The count of top-level nodes of one module in one datastore.
   *
   * The `key` kind is not counted here: the Keys panel enumerates it, so counting it would put
   * every key in the tree and in plan mode's prompt.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    const reader = this.open();
    const [datastore, moduleName] = this.requireModule(container);
    try {
      const nodes = await reader.topLevelNodes(datastore, moduleName);
      return { node: { count: nodes.length } };
    } catch (error) {
      // A refused read is `{ unavailable }`, never 0: the type says so, and a zero would draw an
      // empty module where the truth is that the read was refused.
      //
      // Which errors answer here and which rise is the house rule at
      // `providers/platform/kubernetes/objects.ts:348`, and its reason is scope: an error that
      // spoils this one read answers for this kind alone, while one that spoils the whole
      // connection has to rise, or every module would read "unavailable" while the connection
      // itself still looked healthy. An earlier version caught everything and turned it into a
      // sentence, which also dressed this provider's own defects as facts about the device: a
      // TypeError here would have been drawn in the tree as the module's count.
      if (error instanceof QueryError || error instanceof TimeoutError) {
        return { node: { unavailable: error.message } };
      }
      throw error;
    }
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const reader = this.open();
    const [datastore, moduleName] = this.requireModule(container);
    if (kind === "key") throw new QueryError(SENTENCES.keysPanel);
    if (kind !== "node") throw new QueryError(`This engine has no object kind named ${kind}.`);
    const nodes = await reader.topLevelNodes(datastore, moduleName);
    return nodes.map((node) => ({ path: [datastore, moduleName, node.name], name: node.name, kind: "node" }));
  }

  /**
   * A node's shape, with no value in it.
   *
   * The columns are the list's key leaves, which is what addresses a row. No leaf VALUE appears
   * here: the read-only account that cannot write still reads password hashes and keystore
   * entries, so a description is built from names and never from what the device returned.
   */
  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    this.open();
    if (kind !== "node" && kind !== "key") throw new QueryError(`This engine has no object kind named ${kind}.`);
    // No columns, and not because a guard withheld them: a description is built from names and
    // never from what the device returned, so there is nothing here to withhold. This read used to
    // call the secret guard and branch on its answer with `withheld ? [] : []`, both arms identical
    // and the call's result discarded. It did nothing while looking like a check, which is worse
    // than no check: a reader auditing this file saw the guard's name and stopped there.
    return {
      path: [...path],
      columns: [],
      indexes: [],
      foreignKeys: [],
    };
  }

  public async describeObjects(container: readonly string[], kind: string, limit?: number): Promise<ObjectDetailBatch> {
    const objects = await this.listObjects(container, kind);
    const taken = limit === undefined ? objects : objects.slice(0, limit);
    const details = await Promise.all(taken.map((object) => this.describeObject(object.path, kind)));
    return taken.length === objects.length
      ? { details }
      : {
          details,
          truncated: { limit: taken.length, reason: "This listing was cut to the limit the caller asked for." },
        };
  }

  /**
   * One level of the Keys panel, against the shared contract.
   *
   * The contract is what settled a question this provider had left open. A key scan arrives as ONE
   * options object carrying a `pattern`, which under `pattern: "prefix"` is the literal prefix every
   * walked key begins with, plus a `cursor` and a `count`; its `database` field is a NUMBER, for an
   * engine that names a numbered database, and a datastore is a name. So there is nowhere else for
   * the datastore to travel: it has to be the first segment of the key path itself, and it is.
   *
   * A key reads `running/ietf-interfaces:interfaces/interface=ge-0%2F0%2F1`: the datastore, then
   * the module-qualified node, then one segment per level, with a list entry addressed by its keys
   * after `=`. That makes a key self-addressing, which is what the Source tab needs too.
   *
   * WHAT THE WALK ACTUALLY LISTS, AND WHAT IT DOES NOT. This paragraph used to describe a key as
   * `running/ietf-interfaces:interfaces/ge-0%2F0%2F1`, with the key value as a segment of its own.
   * MEASURED 2026-10-15 against the Netopeer2 fixture, that is not what the walk produces and not
   * a form this provider can read:
   *
   *   - The level below `interfaces` holds ONE entry, named `interface`. `levelPage` folds entries
   *     by `kind:name` and 5,000 list entries share one element name, so they arrive as one.
   *   - The level below THAT is the FIRST entry's leaf names, `description`, `enabled`, `name`,
   *     `type`, because the read resolves to the first matching element.
   *   - So no level enumerates the entries, and the keyed form above is reachable only by TYPING
   *     it. It does work when typed: it answers that one entry, 281 characters, where the unkeyed
   *     `.../interface` the walk does offer answers the whole list, 1,047,857 characters.
   *   - The old spelling is refused rather than merely absent: a bare key value becomes an XML
   *     element name, the read is built as `<ge-0%2F0%2F1>`, and the user is shown the XML
   *     parser's own sentence.
   *
   * Key-aware level paging is its own change, in `koordinasyon/SONRAKI-PRLAR.md`: deciding how
   * 5,000 entries page is a design question. `tests/live/netconf-live-check.ts` asserts the folded
   * level and the refusal as they are, so the day the walk enumerates entries that check turns red
   * and names this docblock.
   *
   * `cursor` is a string in both directions and `"0"` is its own value at each end: it means start
   * here on the way in and no more pages on the way out. The level walk's own cursor is the last
   * entry returned, so a level whose order changes between calls neither skips nor repeats.
   */
  public async scanKeysPage(options: KeyScanOptions): Promise<KeyScanPage> {
    const reader = this.open();
    const pattern = options.pattern ?? "";
    /*
     * THE PATTERN IS SPLIT AT ITS LAST SEPARATOR, which is the rule the OPC UA port reached first
     * and for the same measured reason (`industrial/opcua/key-scan.ts:241`). Everything up to and
     * including that separator is the level to browse, and the WHOLE pattern is what an entry of
     * that level must begin with.
     *
     * Two patterns arrive and only one of them ends with the separator: the panel sends a folder's
     * own prefix when a reader opens it, and it sends the FILTER BOX verbatim when a reader types
     * in it. MEASURED on this provider before this was handled, both spellings showed nothing:
     *
     *   `running/ietf-interfaces:interfaces`   the level below was listed, so every key held a
     *                                          separator after the pattern and the route answered
     *                                          500 blaming this provider for leaving its level
     *   `running/ietf-interfaces:interfaces/`  `parseKeyPath` kept the trailing empty piece as a
     *                                          node named "", `children` was asked for the
     *                                          children of a node with no name, and the panel drew
     *                                          an empty folder for a folder that is not
     */
    const cut = pattern.lastIndexOf(NETCONF_KEY_SEPARATOR);
    if (cut === -1) throw new QueryError(SENTENCES.keyPrefix);
    const head = pattern.slice(0, cut + 1);
    const [datastore, ...rest] = pattern.slice(0, cut).split(NETCONF_KEY_SEPARATOR);
    if (datastore === undefined || datastore === "") throw new QueryError(SENTENCES.keyPrefix);
    const nodes = parseKeyPath(rest.join(NETCONF_KEY_SEPARATOR));
    // A datastore's own top level is not a level this engine can browse: `children` names a node
    // (`reader.ts:178`), because an unfiltered read of a datastore is the one read this provider
    // does not send. So `running/ietf-interfaces:interfaces` is refused BY NAME rather than
    // answered with nothing, and the sentence names the separator the panel's own placeholder
    // teaches.
    if (nodes.length === 0) throw new QueryError(SENTENCES.keyPrefix);
    const page = levelPage(
      await reader.children(datastore, nodes),
      options.cursor === "0" ? null : options.cursor,
      options.count,
    );
    /*
     * The name is ESCAPED into the key, which is what the path grammar requires of every segment:
     * a list entry named `ge-0/0/1` is `ge-0%2F0%2F1`, and writing it raw put a second separator
     * inside one segment, so the route refused the key for leaving a level it had not left.
     *
     * A folder goes to `prefixes` and a leaf to `keys`, which `LevelEntry.kind` already says. Both
     * were answered as keys before, so the panel offered no folder to open on an engine whose key
     * space is a tree, and the one page it drew was the wrong shape.
     */
    const entries = page.entries.map((entry) => ({ kind: entry.kind, key: `${head}${encodeSegment(entry.name)}` }));
    const inLevel = entries.filter((entry) => entry.key.startsWith(pattern));
    return {
      keys: inLevel.filter((entry) => entry.kind === "key").map((entry) => entry.key),
      prefixes: inLevel
        .filter((entry) => entry.kind === "folder")
        .map((entry) => `${entry.key}${NETCONF_KEY_SEPARATOR}`),
      // `"0"` and not an empty string: the contract gives that value one meaning at each end, and a
      // walk that answered `""` would read as a cursor nobody can use rather than as the end.
      cursor: page.cursor ?? "0",
      // Empty, and the contract says what that means: a key absent from this map is one whose type
      // could not be read, and the honest thing to draw is nothing. A level walk reads names and
      // nothing else, and a YANG node's type lives in the module text, which this page has not
      // fetched. Filling it with the entry's folder-or-leaf shape would answer a different question
      // in the field a reader believes is the value's type.
      types: {},
      // Zero, because this engine declares `totalScope: "none"`, and the contract says the field is
      // not read under it. A device publishes no count of the nodes below a path and NETCONF has no
      // request that asks for one, so any other number here would be invented.
      total: 0,
    };
  }

  /**
   * The Source tab's text (#789), which the declaration promises.
   *
   * `readObjectSource` is optional on the provider interface, so omitting it compiles; what it does
   * NOT do is stay invisible. MEASURED in `src/lib/api/object-route.ts:549`: the route answers 400,
   * `netconf declares no readable source for kind "node"`, for a provider that declares the kind
   * and omits the method, and its docblock names that exact case.
   *
   * The two kinds answer two different texts. A node answers the module's YANG, which the editor
   * does not highlight, so the declaration says `plaintext` rather than inventing a language id.
   * A key answers the entry's own XML as the device sent it.
   *
   * The paths differ because the two kinds are addressed differently, and that is the shared key
   * contract's doing rather than a choice here: a node is `[datastore, module, node]`, the shape
   * `describeObject` already receives, and a key is ONE segment, the key path, which begins with
   * the datastore because the key scan's prefix has nowhere else to carry it.
   */
  public async readObjectSource(path: readonly string[], kind: string, limit?: number): Promise<ObjectSourceDocument> {
    const reader = this.open();
    if (this.agentProfile) throw new QueryError(NETCONF_AGENT_WITHHELD.source);
    const bound = limit !== undefined && limit > 0 ? limit : undefined;
    if (kind === "node") {
      const [datastore, moduleName, node] = path;
      if (datastore === undefined || moduleName === undefined || node === undefined || path.length !== 3) {
        throw new QueryError(SENTENCES.sourceNodePath);
      }
      const text = await reader.moduleText(moduleName);
      return {
        path: [...path],
        kind,
        parts: [part(`${moduleName}.yang`, moduleName, cut(text, bound), "plaintext")],
      };
    }
    if (kind !== "key") throw new QueryError(`This engine publishes no source text for the kind ${kind}.`);
    const [keyPath] = path;
    if (keyPath === undefined || path.length !== 1) throw new QueryError(SENTENCES.sourceKeyPath);
    const [datastore, ...rest] = keyPath.split("/");
    if (datastore === undefined || datastore === "" || rest.length === 0) {
      throw new QueryError(SENTENCES.sourceKeyPath);
    }
    const text = await reader.sourceXml(datastore, parseKeyPath(rest.join("/")));
    return { path: [...path], kind, parts: [part(keyPath, keyPath, cut(text, bound), "xml")] };
  }

  public async getHealth(): Promise<HealthInfo> {
    const facts = this.open().facts;
    return {
      databaseSize: `${facts.modules.length} modules in the YANG library`,
      // A device publishes no cache figure a NETCONF client can read, and "unknown" is the honest
      // value rather than a fabricated 0.
      cacheHitRatio: "unknown",
      slowQueries: [],
      activeSessions: [],
    };
  }

  public async getOverview(): Promise<DatabaseOverview> {
    const facts = this.open().facts;
    // On an agent-mode handle the zeros below would read as the device's own figures; the reason is answered instead.
    if (this.agentProfile) throw new QueryError(NETCONF_AGENT_WITHHELD.overview);
    return {
      // Only the capabilities that change how a read is built. The module list stays out of every
      // panel: RFC 8525 section 6 calls it sensitive.
      version: facts.nmda ? "NETCONF with NMDA (get-data)" : "NETCONF without NMDA",
      uptime: "unknown",
      maxConnections: 0,
      databaseSize: `${facts.datastores.length} datastores, ${facts.modules.length} modules`,
      // A device has no tables and no indexes. Its data is a YANG tree, which the object browser
      // walks.
      tableCount: 0,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    throw new QueryError(SENTENCES.noMetrics);
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    throw new QueryError(SENTENCES.noMetrics);
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    throw new QueryError(SENTENCES.noSessions);
  }

  public async getTableStats(): Promise<TableStats[]> {
    throw new QueryError(SENTENCES.noTables);
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    throw new QueryError(SENTENCES.noTables);
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    throw new QueryError(SENTENCES.noStorage);
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(SENTENCES.noMaintenance);
  }

  private open(): DeviceReader {
    if (!this.reader) throw new QueryError(SENTENCES.notOpen);
    return this.reader;
  }

  private requireModule(container: readonly string[]): readonly [string, string] {
    const datastore = container[0];
    const moduleName = container[1];
    if (!datastore || !moduleName) throw new QueryError(SENTENCES.twoLevels);
    return [datastore, moduleName];
  }
}

function looksLikeReadRequest(statement: string): boolean {
  const text = statement.trim();
  return text.startsWith("{") && text.includes('"datastore"') && text.includes('"path"');
}

/** The text under the caller's bound, with the cut declared rather than silent. */
function cut(text: string, limit: number | undefined): { text: string; truncated?: { limit: number; reason: string } } {
  if (limit === undefined || text.length <= limit) return { text };
  return {
    text: text.slice(0, limit),
    truncated: { limit, reason: `this text is longer than the ${limit} characters this read asked for` },
  };
}

/**
 * One part of a source document.
 *
 * `origin` is `stored` and that is a claim this provider can defend: the YANG text is the module's
 * own text as `<get-schema>` served it, and the XML is the bytes the device sent, sliced rather
 * than re-printed from a parsed tree. Neither is a reconstruction, which is what `regenerated`
 * would have to say.
 */
function part(
  id: string,
  label: string,
  body: { text: string; truncated?: { limit: number; reason: string } },
  language: "plaintext" | "xml",
): ObjectSourcePart {
  return {
    id,
    label,
    text: body.text,
    language,
    form: body.truncated === undefined ? "complete" : "partial",
    origin: "stored",
    ...(body.truncated === undefined ? {} : { truncated: body.truncated }),
  };
}
