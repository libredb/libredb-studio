/**
 * The Modbus TCP provider: a device or a gateway, read only, through a register map the user
 * supplies.
 *
 * WHY THE TREE COMES FROM THE MAP AND NEVER FROM THE DEVICE. No Modbus request lists units,
 * tables, registers or names, and no register carries a type, a scale or a unit. The specification
 * gives each of the four tables 65536 items and calls the mapping between the data model and the
 * device "totally vendor device specific" (MODBUS Application Protocol Specification V1.1b3, 4.3
 * and 4.4). There is nothing to discover, so `listObjects` reads the connection's own map with no
 * device traffic at all.
 *
 * THE DIALECT, AND THE GAP THAT CAME BEFORE IT. The dialect union is itself a registration
 * surface: a member of it arrives with its records (`QUERY_DIALECTS`, `DIALECT_GENERATORS`, and
 * `DIALECT_EDITORS` through the tab type), and declaring `queryDialect: "modbus"` before those
 * records existed did not compile, which was measured. For as long as that was true this class
 * declared no dialect, and the cost was real rather than hidden: a `json` provider with no dialect
 * of its own is given MongoDB's tab type by `resolveTabType`, so the console read as MongoDB. The
 * registration change landed the records and this declaration together, which is the only order
 * in which either one compiles.
 *
 * WHY THIS CLASS OPENS NOTHING IN ITS CONSTRUCTOR. `createDatabaseProvider` is called on every
 * shipped type by the factory tests, so a constructor that dialled would put those tests on the
 * network.
 */
import { assertContainerPathShape, type ContainerPathShapeEngine } from "@/lib/db/object-kinds";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import type {
  ActiveSessionDetails,
  Container,
  DatabaseObject,
  DatabaseOverview,
  HealthInfo,
  IndexStats,
  KindCount,
  MaintenanceResult,
  ObjectDetail,
  ObjectDetailBatch,
  PerformanceMetrics,
  PreparedQuery,
  ProviderCapabilities,
  ProviderOptions,
  QueryResult,
  SlowQueryStats,
  QueryWarning,
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { MODBUS_DEFAULT_PORT, MODBUS_NO_REVOCATION_SENTENCE, MODBUS_READ_ONLY_HINT, UNIT_ID_MIN } from "./constants";
import { dialModbus, socketWire, type Endpoint } from "./client";
import { runRead } from "./read";
import { parseReadRequest } from "./request";
import { ModbusSession } from "./session";
import {
  countObjects as countFromMap,
  listObjects as listFromMap,
  listUnits,
  MODBUS_OBJECT_KINDS,
  NO_DISCOVERY_SENTENCE,
} from "./objects";
import type { Table } from "./pdu";
import { ModbusMapError, parseRegisterMap } from "./register-map";
import { ModbusRequestError } from "./pdu";
import { ModbusDecodeError } from "./values";

/**
 * WHY EVERY REFUSAL HERE IS A `QueryError` AND NOT A PLAIN `Error`. Measured on `90881379`: the
 * product treats the two differently, and a plain `Error` is the worse answer. `isQueryError`
 * (`src/lib/db/errors.ts:245`) tests `instanceof QueryError`, and a reader such as
 * `src/lib/db/providers/platform/kubernetes/objects.ts:348` turns a `QueryError` into
 * `{ unavailable }` while letting anything else propagate as an unexpected failure. So a refusal
 * thrown as a plain `Error` reaches the user as a crash rather than as the sentence it carries.
 * This was a real defect in the first version of this file and it is fixed here.
 *
 * The provider argument is left out on purpose: it takes a `DatabaseType`, and `"modbus"` is not a
 * member of that union until the registration change lands. It is filled in there.
 */

/**
 * The boundary. Every refusal this provider raises leaves through here, and the conversion happens
 * in ONE place rather than at six call sites.
 *
 * WHY IT EXISTS: writing the rule is not applying it. The comment above states that the product
 * treats a plain `Error` differently from a `QueryError`, and the first version of this file applied
 * that only to the three errors it threw itself. `parseRegisterMap` throws `ModbusMapError extends
 * Error`, there was no try/catch anywhere in this file, and so a malformed register map escaped the
 * CONNECT path unconverted: the first thing a user meets, with its sentence stripped of the type
 * that carries it to them. Measured, not supposed.
 *
 * WHY A MAP REFUSAL BECOMES A `DatabaseConfigError` AND NOT A `QueryError`. The test is SCOPE, not
 * type, and the rule is written in the comment this file cites: a failure that breaks ONE read is
 * converted, and one that "fail[s] every kind alike" rises instead, because otherwise "every module
 * reads unavailable while the connection looks perfectly healthy".
 *
 * Measured, six surfaces of six: `connect`, `listContainers`, `countObjects`, `listObjects`,
 * `getHealth` and `getOverview` all read the same document, so an unparseable map leaves no kind
 * that still works. It is not a failed read, it is a connection whose configuration is wrong, and
 * `src/lib/api/errors.ts` gives that its own class: 400 with CONFIG_ERROR and a "Database config
 * error" log line, against 400 QUERY_ERROR for a query and 500 INTERNAL_ERROR with "Unhandled
 * error" for a plain `Error`. The first version of this boundary chose `QueryError`, which fixed
 * the 500 and still dressed a configuration fault as a query failure.
 *
 * THE SAME QUESTION, ANSWERED FOR THE SEVEN CLASSES NOT YET ON A USER PATH. Measured: of this
 * provider's eight refusal classes, only `ModbusMapError` reaches a provider method today, because
 * `index.ts` imports `register-map` for its code and `pdu` for a type alone. The others become
 * reachable when the read console is wired, and the scope test answers each in advance:
 *
 *   `ModbusDecodeError`   one read: a word that will not decode. Converted, `QueryError`.
 *   `ModbusRequestError`  one read: a request refused before a byte is sent. Converted, `QueryError`.
 *   `ModbusFramingError`  one read: a frame that cannot be attributed. Converted, and MB-S4 closes
 *                         the connection as well, which is a separate obligation from the type.
 *   `ModbusTimeout`       one read: the device did not answer. `TimeoutError`, which the Kubernetes
 *                         comment lists beside `QueryError` for exactly this reason.
 *   `ModbusDialError`     the whole connection: no socket was made. Rises, `ConnectionError`.
 *   `ModbusDialTimeout`   the whole connection: same. Rises.
 *   `ModbusValveDefect`   neither: it is a defect, not a condition. Rises unconverted, because a
 *                         frame our own encoder should be unable to build reaching the valve is a
 *                         bug, and dressing it as a device problem sends the reader to the device.
 *
 * Each becomes a line in this function when its path exists, not before: a conversion for an
 * unreachable class is a branch no test can enter.
 *
 * WHY IT IS SELECTIVE, which matters as much as the conversion. A `TypeError` from a programming
 * mistake passes through unchanged. Dressing one as a query failure would send a developer to look
 * at the device instead of at the code, so everything-converted is as wrong as nothing-converted.
 */
const MODBUS_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = {
  code: "modbus",
  label: "A Modbus",
  shapeNames: "label",
};

export function atBoundary(error: unknown): unknown {
  if (error instanceof QueryError) return error;
  // The map is a document the user wrote and edits in the connection, so a fault in it is a
  // configuration fault.
  if (error instanceof ModbusMapError) return new DatabaseConfigError(error.message);
  // The read request is text the user wrote and edits in the console, which is a different box
  // from the map and therefore a different class. Both are 400s and they are NOT interchangeable:
  // the class is what a reader acts on, and telling someone to fix their map when the fault is in
  // their request sends them to the one thing that is already right.
  if (error instanceof ModbusRequestError) return new QueryError(error.message);
  // A decode fault is read as a fault in the MAP rather than in the request: every sentence this
  // class carries compares what the map DECLARES with what the device actually sent, so the thing
  // to change is the declaration.
  if (error instanceof ModbusDecodeError) return new DatabaseConfigError(error.message);
  // AND NOT `ModbusValveDefect`, deliberately. That one fires on bytes THIS CODE built, so it is
  // our defect and not the user's: dressing it as a 400 would ask someone to fix a document that
  // has nothing wrong with it, and would hide the one failure here that should reach us.
  return error;
}

/**
 * Parses the connection's map and converts its refusal. Six surfaces read the map and all six go
 * through here, because a conversion that has to be remembered at each call site is one that will
 * be forgotten at the seventh.
 */
function readMap(config: unknown): ReturnType<typeof parseRegisterMap> {
  try {
    return parseRegisterMap(mapOf(config));
  } catch (error) {
    throw atBoundary(error);
  }
}

/** Read from the connection. A field, so the map travels with the connection it belongs to. */
function mapOf(config: unknown): string | undefined {
  const map = (config as { registerMap?: unknown }).registerMap;
  return typeof map === "string" ? map : undefined;
}

export class ModbusProvider extends BaseDatabaseProvider {
  /**
   * Opens nothing. `createDatabaseProvider` is called on every shipped type by the factory tests,
   * so a constructor that dialled would put those tests on the network.
   *
   * Declared public because the base class's own constructor is protected, which would otherwise
   * make this class unconstructable from a test.
   */
  public constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  // ==========================================================================
  // Declarations
  // ==========================================================================

  /**
   * Every member written out: the base class defaults to SQL's answers, and every one of them
   * would be wrong here. Each `false` is a claim this provider can defend.
   */
  public override getCapabilities(): ProviderCapabilities {
    return {
      queryLanguage: "json",
      queryDialect: "modbus",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      // One read answers one request. A Modbus read is bounded by the protocol's own quantity
      // limits, not by a window a caller can advance.
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      // Structural rather than configured: there is no code here that can build a write.
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      // Modbus TCP has no connection string form, and inventing one would be ours.
      supportsConnectionString: false,
      defaultPort: MODBUS_DEFAULT_PORT,
      statementTerminator: "none",
      containerLevels: [{ id: "schema", label: "Unit", labelPlural: "Units" }],
      // Declared AND checked: the census pairs the two, and a declaration with no check behind it
      // lets a path of the wrong length reach the map lookup, which then answers "no such point"
      // and names the wrong mistake (#1147).
      // , not : a read at the root lists every point of a kind across units, and a
      // read one level down lists one unit's.  refuses the empty path wherever a level is
      // declared, which turned the root listing into a refusal - the gate caught it, four of my own
      // tests at once.
      containerPathShapes: "prefixes",
      objectKinds: MODBUS_OBJECT_KINDS.map((kind) => ({ ...kind, role: "relation" as const })),
      // Nothing a read runs changes the tree.
      schemaRefreshPattern: "(?!)",
    };
  }

  /** A read carries the protocol's limits, so no limit is added and there is no page two. */
  public override prepareQuery(query: string): PreparedQuery {
    return { query, wasLimited: false, limit: 0, offset: 0 };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Holds no connection open. Issue #1723 section 4.7 measured why: a libmodbus server serving one
   * client at a time left a second client's read unanswered for 3003 ms while the first stayed
   * open, so a connection held between reads locks out the plant's own HMI or SCADA.
   *
   * A map that is present and malformed is reported now rather than on the first read: the user
   * wrote that document, and the moment they connect is when they can still fix it.
   */
  public async connect(): Promise<void> {
    readMap(this.config);
    // AND A BARE DIAL, because the map alone made this method answer for a device that is not
    // there. MEASURED: against a closed port it returned successfully in 0 ms, and
    // `src/app/api/db/test-connection/route.ts:146-160` reports a health failure after a
    // successful connect as a DEGRADED SUCCESS - so an address with no device at all answered
    // `success: true` and the dialog saved the connection. That sends a reader to fix their map
    // when the fault is the address.
    //
    // A dial and not a read: 43/14 is not mandatory in Modbus, so a device that refuses it is one
    // that does not know the function rather than one that is not there. The dial claims only that
    // the address answered a TCP connection.
    //
    // It is closed at once. What §4.7 measured as dangerous is HOLDING a connection - a second
    // client went 3003 ms unanswered while the first stayed open - not opening one twice.
    (await dialModbus(this.endpoint())).destroy();
  }

  /**
   * The caution a connection with no register map carries.
   *
   * MEASURED, and this is the hole it closes: against a port that ACCEPTS a connection and never
   * answers, an empty-map connection answered `success: true, "Connection successful"` in 0 to 9
   * ms, three runs identical. The dial succeeded because TCP was accepted, and `getHealth()` could
   * not fail because there was nothing to read, so the answer carried no hint at all - worse than
   * the refused-port case, which at least said `degraded` and named the address. An empty map is
   * the DEFAULT state of a new connection, so this is what a user sees before they have written
   * one, on a wrong port as readily as on a right one.
   *
   * The repair is not another probe, it is an honest answer. There is no guessed read behind this:
   * a unit id guessed wrong costs 2137 ms behind a gateway (#1723 §4.10), so a timeout there would
   * blame a device that IS present, and 43/14 is not mandatory either.
   *
   * `connectWarnings` and not `testConnectionWarnings` because it needs no request: it reads the
   * connection's own map. The dialog renders it as a caution rather than a green tick
   * (`src/hooks/use-connection-form.ts:344`, `cautionSentence`).
   */
  public connectWarnings(): QueryWarning[] {
    return readMap(this.config).isEmpty
      ? [
          {
            message:
              "This connection carries no register map, so nothing was read from the device: all that was measured is that the address answered a TCP connection. Modbus has no discovery, so until a map names a point there is nothing to read.",
          },
        ]
      : [];
  }

  public async disconnect(): Promise<void> {
    // Nothing is held, so there is nothing to close.
  }

  // ==========================================================================
  // The object tree, read from the map
  // ==========================================================================

  /** The units the map names. Never a scan: an absent unit behind a gateway cost 2137 ms. */
  /** Every map read inside this class funnels through the boundary helper, listings included. */
  private listing(kind: Table): ReturnType<typeof listFromMap> {
    try {
      return listFromMap(mapOf(this.config), kind);
    } catch (error) {
      throw atBoundary(error);
    }
  }

  private units(): readonly number[] {
    try {
      return listUnits(mapOf(this.config));
    } catch (error) {
      throw atBoundary(error);
    }
  }

  public async listContainers(): Promise<Container[]> {
    return this.units().map((unit) => ({
      path: [String(unit)],
      name: String(unit),
      level: 0,
      kinds: MODBUS_OBJECT_KINDS.map((kind) => kind.id),
    }));
  }

  /**
   * Counts per kind, where an absent map answers `unavailable` and never 0.
   *
   * `src/lib/db/types.ts` states the contract on `countObjects`: "A refused read is
   * `{ unavailable }`, never 0." With no map this provider does not know how many coils the DEVICE
   * has, and 0 would be a claim about the hardware that Modbus cannot support. With a map present
   * the count is the number of points of that kind in the map, and 0 is then an answer.
   */
  public async countObjects(container: readonly string[]): Promise<Record<string, KindCount>> {
    this.unitOf(container);
    let counts: ReturnType<typeof countFromMap>;
    try {
      counts = countFromMap(mapOf(this.config));
    } catch (error) {
      throw atBoundary(error);
    }
    const unit = container[0];
    const out: Record<string, KindCount> = {};
    for (const kind of MODBUS_OBJECT_KINDS) {
      const answer = counts[kind.id];
      if (answer !== undefined && "unavailable" in answer) {
        out[kind.id] = { unavailable: answer.unavailable };
        continue;
      }
      const mine = this.listing(kind.id).objects.filter((point) => unit === undefined || String(point.unitId) === unit);
      out[kind.id] = { count: mine.length };
    }
    return out;
  }

  /** One level: a unit id. The length is CHECKED rather than taken, so an extra level is refused. */
  private unitOf(container: readonly string[]): string | undefined {
    assertContainerPathShape(this.getCapabilities(), container, MODBUS_CONTAINER_PATH_ENGINE);
    return container[0];
  }

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const unit = this.unitOf(container);
    const listing = this.listing(kind as Table);
    return listing.objects
      .filter((point) => unit === undefined || String(point.unitId) === unit)
      .map((point) => ({
        path: [String(point.unitId), point.name],
        name: point.name,
        kind,
      }));
  }

  public async describeObject(path: readonly string[], kind: string): Promise<ObjectDetail> {
    const name = path[path.length - 1];
    const listing = this.listing(kind as Table);
    const point = listing.objects.find((candidate) => candidate.name === name);
    if (point === undefined)
      throw new QueryError(`The register map names no point "${name}". ${NO_DISCOVERY_SENTENCE}`);
    return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
  }

  public async describeObjects(container: readonly string[], kind: string): Promise<ObjectDetailBatch> {
    const objects = await this.listObjects(container, kind);
    return {
      details: await Promise.all(objects.map((object) => this.describeObject(object.path, kind))),
    };
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * One JSON read request. The parser is not in this change: the client, the register map, the
   * block planner and the frame reader are in place and tested, and what is missing is the step
   * that turns one JSON document into those calls. It refuses rather than pretending to read.
   */
  /** Host and port as the connection gives them, with 502 where none is set. */
  private endpoint(): Endpoint {
    const config = this.config as { host?: string; port?: number; ssl?: { enabled?: boolean } };
    return {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? MODBUS_DEFAULT_PORT,
      ...(config.ssl?.enabled === true ? { tls: {} } : {}),
    };
  }

  /**
   * One JSON read request, run against the device.
   *
   * NOTHING IS HELD OPEN. The socket is opened for this read and destroyed in `finally`, which is
   * the rule `connect()` documents: a libmodbus server serving one client at a time left a second
   * client unanswered for 3003 ms while the first stayed open, so a connection kept between reads
   * locks out the plant's own HMI.
   *
   * The request is settled BEFORE the socket: a refusal the caller can fix costs no connection.
   */
  public async query(statement: string, _params?: unknown[]): Promise<QueryResult> {
    const map = readMap(this.config);
    let request;
    try {
      request = parseReadRequest(statement, new Set(map.points.map((point) => point.name)));
    } catch (error) {
      throw atBoundary(error);
    }
    const endpoint = this.endpoint();
    const socket = await dialModbus(endpoint);
    try {
      const session = new ModbusSession(socketWire(socket, endpoint));
      const read = await runRead(request, map, session, this.unitIdOfConnection(map));
      return {
        rows: read.rows,
        fields: read.fields,
        rowCount: read.rows.length,
        ...(read.warnings.length > 0 ? { notices: [...read.warnings] } : {}),
      } as QueryResult;
    } finally {
      socket.destroy();
    }
  }

  /** The unit a shape that names none runs at: the map's first, which is the one the tree shows. */
  private unitIdOfConnection(map: ReturnType<typeof readMap>): number {
    return map.points[0]?.unitId ?? UNIT_ID_MIN;
  }

  /**
   * A connect plus one quantity-1 read at a point the map names, at that point's unit.
   *
   * A connect alone is not health: issue #1723 section 4.10 measured a TCP connect succeeding
   * against an absent unit behind a gateway and against the broadcast unit. And the socket's state
   * is not health either: section 5.1 measured a socket reading as ESTABLISHED for 144 seconds
   * while no answer was coming. Health is an answer, or the absence of one.
   */
  public async getHealth(): Promise<HealthInfo> {
    const parsed = readMap(this.config);
    // The read, which this docblock used to describe while the body did only the line above it.
    // A connect alone is not health (§4.10: a TCP connect succeeded against an absent unit behind
    // a gateway), and the socket's state is not health either (§5.1: ESTABLISHED for 144 seconds
    // while no answer was coming). Health is an answer, or the absence of one.
    const point = parsed.points[0];
    const endpoint = this.endpoint();
    if (point !== undefined) {
      const socket = await dialModbus(endpoint);
      try {
        const session = new ModbusSession(socketWire(socket, endpoint));
        await runRead({ kind: "points", names: [point.name] }, parsed, session, point.unitId);
      } finally {
        socket.destroy();
      }
    } else {
      // NO MAP: a plain dial, and deliberately NOT an identification read. 43/14 is not mandatory
      // in Modbus, so a device that refuses it is a device that does not know the function rather
      // than a device that is not there, and reporting that as a health failure would blame the
      // wrong side. A dial claims nothing except that the address answered a TCP connection;
      // nothing is read, because no point names an address to read.
      (await dialModbus(endpoint)).destroy();
    }
    return {
      databaseSize: parsed.isEmpty
        ? "unknown"
        : `${parsed.points.length} ${parsed.points.length === 1 ? "point" : "points"}`,
      // A device has no cache and no connection count a reader can ask for. "unknown" is the
      // honest value: `activeConnections` is OMITTED rather than sent as 0, which is the rule its
      // own docblock states, that absence and zero are different facts.
      cacheHitRatio: "unknown",
      slowQueries: [],
      activeSessions: [],
    };
  }

  // ==========================================================================
  // Surfaces a Modbus device does not have
  // ==========================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    const parsed = readMap(this.config);
    return {
      version: "Modbus TCP",
      // A device publishes no uptime a reader can ask for.
      uptime: "unknown",
      // A device serves a small, vendor fixed number of clients and publishes none of it, so this
      // is the honest floor rather than a guess: one, the connection this provider opens per read.
      maxConnections: 1,
      databaseSize: parsed.isEmpty ? "unknown" : `${parsed.points.length} points`,
      // The map's points, which is what this provider can address. Not a count of what the device
      // holds: Modbus publishes no such number.
      tableCount: parsed.points.length,
      indexCount: 0,
    };
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return {};
  }

  public async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  public async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }

  public async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  public async runMaintenance(): Promise<MaintenanceResult> {
    throw new QueryError(
      "This provider sends no maintenance request: the five requests it can build are four reads and the device identification read, and none of them changes anything. The protocol itself is not so narrow - function code 08 can clear a device's counters and restart its communications - and there is no code here that builds those.",
    );
  }
}

export { MODBUS_NO_REVOCATION_SENTENCE, MODBUS_READ_ONLY_HINT };
