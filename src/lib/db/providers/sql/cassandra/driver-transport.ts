/**
 * The one file in this provider that knows `cassandra-driver` exists
 * (issue #424, Phase 4).
 *
 * `cassandra-driver` 4.9.0 is pure JavaScript - no `binding.gyp`, no `.node`, no
 * postinstall - so unlike `oracledb` or `better-sqlite3` it adds no native module
 * to any distribution channel. It was exercised under bun 1.3.14 before this
 * provider was written: three sessions, 2500 concurrent prepared inserts, a
 * 400-statement batch, `eachRow` auto-paging 500 rows and `stream()` over 2000.
 * The historical bun segfault reports do not reproduce on this version.
 *
 * It DOES `require('kerberos')` inside a try/catch as an optional dependency, so
 * the package is listed in `serverExternalPackages` (next.config.ts) and in tsup's
 * `external` - without that the build tries to resolve a module nobody installed.
 *
 * Everything below was measured on Apache Cassandra 5.0.9 on 2026-08-20. Four
 * findings shape it, and each produces a wrong answer if forgotten:
 *
 * - THE ERROR CLASS IS ALMOST ALWAYS THE SAME ONE. Authentication, a refused
 *   socket, an unresolvable name, a wrong data centre and every unavailable-replica
 *   failure arrive as `NoHostAvailableError` with `code === undefined`; the fault
 *   that can be acted on is in `innerErrors[host]`. Classifying on `err.code` puts
 *   all of them in "unknown".
 * - `duration` AND `vector<float, 3>` BOTH ARRIVE AS type code 0, with a Java class
 *   name in `type.info`. The driver's own `getDataTypeNameByCode` answers "custom"
 *   for both, so the class name is the only thing that tells them apart.
 * - A BLOB IS A BUFFER, and `JSON.stringify` renders one as
 *   `{"type":"Buffer","data":[76,105,…]}`. A `vector` renders as
 *   `{"0":1.5,"1":2.5,"2":3.5}`. Neither is readable and neither can be pasted back
 *   into CQL.
 * - `bigint`, `decimal` and `varint` arrive as `Long`, `BigDecimal` and `Integer`,
 *   whose `toString()` is exact and whose `Number()` is not: the bigint maximum
 *   becomes 9223372036854776000 and a 20-digit decimal loses its last four digits.
 */

import { Client, types, type ClientOptions, type QueryOptions } from "cassandra-driver";
import type { DatabaseConnection } from "@/lib/db/types";
import {
  type CassandraExecuteOptions,
  type CassandraQueryResult,
  type CassandraRow,
  CassandraTransportError,
  type CassandraTransport,
} from "./transport";

// ============================================================================
// Constants
// ============================================================================

/** The native protocol's port, and the only one this provider speaks. */
export const CASSANDRA_DEFAULT_PORT = 9042;

/**
 * The custom types whose Java marshaller this provider can name in CQL.
 *
 * Measured on 5.0.9: both of these arrive with type code 0 and the class name in
 * `type.info`, which is the only thing distinguishing them.
 */
const CUSTOM_TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "org.apache.cassandra.db.marshal.DurationType": "duration",
});

/**
 * `VectorType(<element class> , <dimension>)`, exactly as 5.0.9 spells it - the
 * space before the comma is the server's, not a typo.
 */
const VECTOR_TYPE = /^org\.apache\.cassandra\.db\.marshal\.VectorType\((.+?)\s*,\s*(\d+)\s*\)$/;

/**
 * Element marshallers named in CQL words.
 *
 * One entry, because one is what was measured. An element class absent from here
 * is reported as the server spelled it rather than guessed into a CQL keyword.
 */
const MARSHAL_ELEMENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "org.apache.cassandra.db.marshal.FloatType": "float",
});

/** The driver's word for a custom type it cannot name, which is also the truthful one. */
const CUSTOM_TYPE_FALLBACK = "custom";

/**
 * The driver's own type-name composer, reached through a cast because the package
 * ships no declaration for it (`types.getDataTypeNameByCode` exists at runtime and
 * is absent from `lib/types/index.d.ts`).
 *
 * Worth the cast rather than re-deriving the names here: it composes the nested
 * forms - `list<int>`, `map<varchar, int>`, `set<varchar>`,
 * `tuple<int, varchar, boolean>` - and answers a UDT with its declared name, all of
 * which a hand-written table over `types.dataTypes` would have to reproduce.
 */
const nameDataType = (types as unknown as { getDataTypeNameByCode: (type: CassandraColumnType) => string })
  .getDataTypeNameByCode;

/**
 * The value classes whose `toString()` is the engine's own spelling of the value.
 *
 * `Long`, `Integer` and `BigDecimal` are here for FIDELITY - their string form is
 * exact and their numeric form is not - and the rest because the string is the
 * only readable form: a `time` carries nanoseconds no `Date` can hold, and an
 * `inet`, a `uuid` and a `date` all stringify to the literal CQL accepts back.
 * `TimeUuid` is absent because it extends `Uuid`.
 */
const STRINGIFIED_VALUE_CLASSES: readonly (new (...args: never[]) => unknown)[] = [
  types.Long,
  types.Integer,
  types.BigDecimal,
  types.Duration,
  types.LocalDate,
  types.LocalTime,
  types.InetAddress,
  types.Uuid,
];

/**
 * The protocol error codes this provider branches on, as `types.responseErrorCodes`
 * numbers them.
 *
 * Read from the driver's own frozen map rather than transcribed, so a literal here
 * cannot drift from the protocol. Every one of them was observed live except
 * `badCredentials`, which the server never sends to this driver - a refused
 * password arrives as an `AuthenticationError` inside `innerErrors` instead - and
 * is mapped anyway because the protocol defines it.
 */
const FAULT_CATEGORY_BY_CODE: ReadonlyMap<number, CassandraTransportError["category"]> = new Map([
  [types.responseErrorCodes.syntaxError, "syntax" as const],
  [types.responseErrorCodes.invalid, "invalid" as const],
  [types.responseErrorCodes.unauthorized, "permission" as const],
  [types.responseErrorCodes.readTimeout, "server-timeout" as const],
  [types.responseErrorCodes.writeTimeout, "server-timeout" as const],
  [types.responseErrorCodes.unavailableException, "unavailable" as const],
  [types.responseErrorCodes.badCredentials, "auth" as const],
]);

// ============================================================================
// Wire shapes
// ============================================================================

/** A column declaration as the protocol describes it. */
export interface CassandraColumnType {
  code: number;
  info?: unknown;
}

/** The parts of the driver's ResultSet this adapter reads, and nothing else. */
export interface CassandraResultSetLike {
  columns?: readonly { name: string; type: CassandraColumnType }[] | null;
  rows?: readonly Record<string, unknown>[] | null;
  pageState?: string | null;
}

/**
 * The session this adapter drives: the driver's own `Client`, or a stand-in.
 *
 * Narrower than `Client` on purpose - three methods out of twelve - so the
 * integration suite can replay a real cluster's answers through the REAL adapter
 * and the REAL provider, with only the socket faked.
 */
export interface CassandraSession {
  connect(): Promise<void>;
  execute(cql: string, params?: unknown[], options?: QueryOptions): Promise<CassandraResultSetLike>;
  shutdown(): Promise<void>;
}

/** What a driver error looks like to a reader that does not import its classes. */
interface CassandraFaultLike {
  name?: string;
  code?: unknown;
  message?: string;
  innerErrors?: Record<string, unknown>;
}

// ============================================================================
// Type naming
// ============================================================================

/**
 * The CQL name of a declared column type.
 *
 * Only custom types are handled here; everything else is the driver's own
 * `getDataTypeNameByCode`, which composes the collection forms correctly
 * (`list<int>`, `map<varchar, int>`, `set<varchar>`, `tuple<int, varchar, boolean>`)
 * and answers a UDT with its declared name.
 *
 * A `text` column reads back as `varchar` and a column declared `varchar` reads
 * back as `text` - the two are one type on the wire - so this reports whichever the
 * protocol declared rather than trying to recover the DDL word. The schema tree does
 * not use this at all: it reads `system_schema.columns.type`, which IS the declared
 * spelling.
 */
export function describeColumnType(type: CassandraColumnType): string {
  if (type.code !== types.dataTypes.custom) return nameDataType(type);

  const className = typeof type.info === "string" ? type.info : "";
  const known = CUSTOM_TYPE_NAMES[className];
  if (known !== undefined) return known;

  const vector = VECTOR_TYPE.exec(className);
  if (vector !== null) {
    const element = MARSHAL_ELEMENT_NAMES[vector[1]] ?? vector[1];
    return `vector<${element}, ${vector[2]}>`;
  }

  return className === "" ? CUSTOM_TYPE_FALLBACK : className;
}

// ============================================================================
// Value normalization
// ============================================================================

/**
 * One value, as something the grid, a CSV export and `JSON.stringify` can all
 * carry.
 *
 * Three rules, and each is a measured trap rather than a preference:
 *
 * - A `Buffer` is handed on AS ITSELF. It used to become the CQL literal `0x…`,
 *   because `{"type":"Buffer","data":[…]}` - the JSON form - was a document nobody
 *   could read; `src/lib/export/binary.ts` now reads exactly that shape (#469), so
 *   that reason has expired, and stringifying here was what kept a blob out of the
 *   binary renderer, the row detail sheet, the CSV and the per-dialect binary literal
 *   the SQL export writes. The grid spelled it `0x4c69…` while Postgres spelled the
 *   same bytes `\x4c69…`, and the export wrote that text into a `blob` column
 *   instead of the bytes. The CQL literal is still `0x…`, but the export builds
 *   it from the bytes now (`BINARY_LITERAL` has cassandra as `zero-x`), which is what
 *   keeps one spelling on the screen and the right one in the file.
 * - Anything whose exact value is longer than a double keeps its digits AS A
 *   STRING. `Long`, `Integer` and `BigDecimal` all stringify losslessly and all
 *   lose precision through `Number()`, and a `COUNT(*)` is a `Long` too.
 * - A container is WALKED, because the trap is one level down as often as at the
 *   top: a `set` arrives as an Array, a `map` and a UDT as plain objects, and a
 *   `map<text, bigint>` therefore hides `Long` values inside an ordinary-looking
 *   object.
 *
 * A `Date` is returned as itself: `timestamp` is the one CQL type the grid already
 * formats, and stringifying it here would take that away.
 */
export function normalizeCassandraValue(value: unknown): unknown {
  // `undefined` reads as null rather than being dropped: a column absent from a
  // row is absent, and a missing key would make the grid render no cell at all.
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Date) return value;
  if (value instanceof types.Vector) return [...value].map(normalizeCassandraValue);
  if (value instanceof types.Tuple) return value.elements.map(normalizeCassandraValue);
  if (Array.isArray(value)) return value.map(normalizeCassandraValue);
  if (STRINGIFIED_VALUE_CLASSES.some((candidate) => value instanceof candidate)) return String(value);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, member]) => [key, normalizeCassandraValue(member)]),
    );
  }

  return value;
}

/**
 * The driver's ResultSet as the neutral result.
 *
 * The DECLARATION drives the row shape, not the row's own keys: it is the only
 * source for the order the statement projected, and an all-null first row cannot
 * be trusted to carry every key.
 *
 * `columns === null` is the answer for a statement that changed something -
 * measured on `INSERT`, `DELETE`, `ALTER TABLE` and `USE`, all of which answer a
 * ResultSet with no declaration and no rows - and it is carried through as `null`
 * rather than flattened to an empty list, so the provider can tell "no columns"
 * from "no rows".
 */
export function toCassandraResult(result: CassandraResultSetLike): CassandraQueryResult {
  const pageState = result.pageState ?? null;
  const columns = result.columns ?? null;
  if (columns === null) return { rows: [], fieldNames: null, columnTypes: null, pageState };

  const rows: CassandraRow[] = (result.rows ?? []).map((row) =>
    Object.fromEntries(columns.map((column) => [column.name, normalizeCassandraValue(row[column.name])])),
  );

  return {
    rows,
    fieldNames: columns.map((column) => column.name),
    columnTypes: Object.fromEntries(columns.map((column) => [column.name, describeColumnType(column.type)])),
    pageState,
  };
}

// ============================================================================
// Error classification
// ============================================================================

/**
 * A driver failure as one classified transport error.
 *
 * `NoHostAvailableError` is unwrapped first, because it is the envelope almost
 * everything actionable arrives in and it carries no code of its own. What is
 * inside it decides the category; if it is empty - which is what an unresolvable
 * host name produces, message "No host could be resolved" - the envelope itself is
 * the answer.
 */
export function classifyCassandraError(error: unknown): CassandraTransportError {
  if (error instanceof CassandraTransportError) return error;

  const fault = typeof error === "object" && error !== null ? (error as CassandraFaultLike) : null;
  if (fault === null) return new CassandraTransportError(String(error), "engine", null);

  if (fault.name === "NoHostAvailableError") {
    const inner = Object.values(fault.innerErrors ?? {}).find(
      (candidate) => typeof candidate === "object" && candidate !== null,
    );
    if (inner === undefined) return classifiedFault(fault, "unreachable");

    // A per-host fault that is not one of the named classes means the host did not
    // answer: a refused socket (`ECONNREFUSED`), a silent host (`DriverError`,
    // "Connection timeout"), a pool with nothing free.
    return classifiedFault(inner as CassandraFaultLike, "unreachable");
  }

  return classifiedFault(fault, "engine");
}

/** One fault, categorised by its class and - for a server response - by its code. */
function classifiedFault(
  fault: CassandraFaultLike,
  fallback: CassandraTransportError["category"],
): CassandraTransportError {
  const message = fault.message ?? "";
  // The protocol's code, or nothing. A socket errno is a STRING (`ECONNREFUSED`),
  // so it is not one, and 0 is a real code (`serverError`) rather than a blank.
  const code = typeof fault.code === "number" ? fault.code : null;

  if (fault.name === "AuthenticationError") return new CassandraTransportError(message, "auth", code);
  // The driver refuses a missing or unknown `localDataCenter` itself, before and
  // after the wire: this is the one engine here whose client requires a topology
  // answer the connection has to supply.
  if (fault.name === "ArgumentError") return new CassandraTransportError(message, "config", code);
  if (fault.name === "OperationTimedOutError") return new CassandraTransportError(message, "client-timeout", code);
  if (fault.name === "ResponseError") {
    return new CassandraTransportError(message, (code !== null && FAULT_CATEGORY_BY_CODE.get(code)) || "engine", code);
  }

  return new CassandraTransportError(message, fallback, code);
}

// ============================================================================
// Client construction
// ============================================================================

/**
 * The driver options one connection produces.
 *
 * A pure function so the whole mapping is testable without a cluster, and because
 * it is the one place a connection's fields turn into topology:
 *
 * - `contactPoints` is the single configured host. The driver discovers the rest of
 *   the ring itself, which is why one address is enough and why a wrong `port`
 *   fails with `ECONNREFUSED` from that address alone.
 * - `localDataCenter` is REQUIRED by the driver - measured, it refuses to construct
 *   a load-balancing policy without one - and no other engine in this repo needs
 *   such a field. It is a real connection field, not a default applied here.
 * - `keyspace` is the connection's `database`. It is what makes an unqualified
 *   table name resolve (measured: without it, `SELECT … FROM customers` answers
 *   "No keyspace has been specified"), and a keyspace that does not exist fails the
 *   CONNECT rather than the first statement.
 * - `readTimeout` is the only per-statement deadline available: `USING TIMEOUT` is
 *   not in 5.0's grammar (measured, syntax error), so the client's own is it.
 */
export function cassandraClientOptions(config: DatabaseConnection, readTimeoutMs: number): ClientOptions {
  const port = config.port ?? CASSANDRA_DEFAULT_PORT;
  const tlsMode = config.ssl?.mode ?? "disable";

  return {
    contactPoints: [`${config.host}:${port}`],
    localDataCenter: config.localDataCenter ?? "",
    ...(config.database ? { keyspace: config.database } : {}),
    ...(config.user ? { credentials: { username: config.user, password: config.password ?? "" } } : {}),
    socketOptions: { readTimeout: readTimeoutMs },
    ...(tlsMode === "disable"
      ? {}
      : {
          sslOptions: {
            // `verify-ca` and `verify-full` both mean "check the chain"; `require`
            // means encrypt without checking. NOT exercised against a TLS cluster -
            // the probe instances speak plaintext - so this is the documented shape
            // of the driver's own option and no claim about a verified path.
            rejectUnauthorized: tlsMode !== "require",
            ...(config.ssl?.caCert ? { ca: [config.ssl.caCert] } : {}),
            // The driver passes `sslOptions` through to `tls.connect`, so the shared
            // form's client certificate and key are carried under Node's own names -
            // the same mapping the PostgreSQL, MySQL and Couchbase adapters use. Each
            // half travels on its own and in every non-disabled mode: a cluster can
            // demand mutual TLS while presenting a self-signed certificate itself.
            ...(config.ssl?.clientCert ? { cert: config.ssl.clientCert } : {}),
            ...(config.ssl?.clientKey ? { key: config.ssl.clientKey } : {}),
          },
        }),
  };
}

// ============================================================================
// The transport
// ============================================================================

/**
 * The seam over `cassandra-driver`.
 *
 * The session is injectable for one reason: this adapter's own mapping - the hex
 * blob, the stringified `Long`, the class-named `duration`, the unwrapped
 * `NoHostAvailableError` - is the part most likely to be wrong, so the integration
 * suite replays a real cluster's ResultSets through it rather than stubbing it out.
 */
export class CassandraDriverTransport implements CassandraTransport {
  public readonly kind = "native" as const;

  private session: CassandraSession | null;

  constructor(
    private readonly config: DatabaseConnection,
    private readonly readTimeoutMs: number,
    session?: CassandraSession,
  ) {
    this.session = session ?? null;
  }

  public async connect(): Promise<void> {
    // The Client is constructed here rather than in the constructor because
    // constructing it is already where a missing `localDataCenter` throws, and a
    // failure in a constructor leaves no object to close.
    this.session ??= new Client(cassandraClientOptions(this.config, this.readTimeoutMs));

    try {
      await this.session.connect();
    } catch (error) {
      throw classifyCassandraError(error);
    }
  }

  public async execute(cql: string, options: CassandraExecuteOptions = {}): Promise<CassandraQueryResult> {
    const session = this.requireSession();

    try {
      // `prepare: false` deliberately: every statement here is either the user's
      // own text or a fixed catalog read, and preparing a one-shot statement adds a
      // round trip and an entry to the server's prepared-statement cache
      // (`system_views.cql_metrics` counts them) for nothing.
      return toCassandraResult(await session.execute(cql, undefined, { prepare: false, ...options }));
    } catch (error) {
      throw classifyCassandraError(error);
    }
  }

  public async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) await session.shutdown();
  }

  private requireSession(): CassandraSession {
    if (this.session === null) {
      throw new CassandraTransportError("The Cassandra session is closed", "unreachable", null);
    }

    return this.session;
  }
}
