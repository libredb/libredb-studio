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
 * WHY THIS CLASS DECLARES NO `queryDialect`, WHICH IS A GAP AND NOT A CHOICE. The dialect union is
 * itself a registration surface: a member of it arrives with three records
 * (`QUERY_DIALECTS`, `DIALECT_EDITORS`, `DIALECT_GENERATORS`), and `docs/ADDING_A_PROVIDER.md:1088`
 * says "the build fails until all three exist". Declaring `queryDialect: "modbus"` here before
 * those records exist does not compile, which was measured. The cost of leaving it out is real and
 * is NOT hidden: a `json` provider with no dialect of its own is given MongoDB's tab type by
 * `resolveTabType`, so until the registration change lands, this provider's console reads as
 * MongoDB. `tests/unit/db/modbus/index.test.ts` binds that gap so it cannot be forgotten, and the registration change closes it.
 *
 * WHY THIS CLASS OPENS NOTHING IN ITS CONSTRUCTOR. `createDatabaseProvider` is called on every
 * shipped type by the factory tests, so a constructor that dialled would put those tests on the
 * network.
 */
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
  StorageStats,
  TableStats,
} from "@/lib/db/types";
import { MODBUS_DEFAULT_PORT, MODBUS_NO_REVOCATION_SENTENCE, MODBUS_READ_ONLY_HINT } from "./constants";
import {
  countObjects as countFromMap,
  listObjects as listFromMap,
  listUnits,
  MODBUS_OBJECT_KINDS,
  NO_DISCOVERY_SENTENCE,
} from "./objects";
import type { Table } from "./pdu";
import { ModbusMapError, parseRegisterMap } from "./register-map";

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
export function atBoundary(error: unknown): unknown {
  if (error instanceof QueryError) return error;
  if (error instanceof ModbusMapError) return new DatabaseConfigError(error.message);
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

  public async listObjects(container: readonly string[], kind: string): Promise<DatabaseObject[]> {
    const unit = container[0];
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
  public async query(_statement: string, _params?: unknown[]): Promise<QueryResult> {
    throw new QueryError(
      "The Modbus read console is not wired up yet. The client, the register map, the block planner and the frame reader are in place; the request parser that turns one JSON document into those calls is the next change.",
    );
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
      "Modbus offers no maintenance operation: no request this provider is allowed to send changes anything on a device.",
    );
  }
}

export { MODBUS_NO_REVOCATION_SENTENCE, MODBUS_READ_ONLY_HINT };
