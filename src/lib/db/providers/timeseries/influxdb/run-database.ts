/**
 * The database a run reads (SPEC 5.8).
 *
 * `influxdb` chooses one per run (I21 as R17 words it): the database the statement names, else the
 * connection's Database field, else the only ordinary database in the cached listing; a statement that
 * needs none (`SHOW DATABASES`) is sent with no `db`. `influxdb3` chooses one per session in `connect()`
 * (R1): the field, else the only ordinary database the token lists. On a generation whose `_internal`
 * holds the token table (3.x and unknown, I11), `_internal` is refused from every input: a source the
 * statement names, the field, and never offered by the only-visible step on any generation (R17).
 *
 * Pure: the statement's names come in already read (`evaluateInfluxql`'s `namedDatabases`), so this
 * module imports nothing but types.
 */

export type RunDatabase =
  | { readonly database: string; readonly source: "statement" | "connection" | "only-visible" }
  | { readonly database: undefined; readonly source: "not-needed" }
  | { readonly database: undefined; readonly source: "server-decides" }
  | { readonly refused: string };

export type SessionDatabase =
  | { readonly database: string; readonly source: "connection" | "only-visible" }
  | { readonly refused: string };

/** InfluxDB's own databases, which never count as "the only visible database" (R17), on every generation. */
export const INFLUX_SYSTEM_DATABASES: ReadonlySet<string> = new Set(["_internal", "_monitoring", "_tasks"]);

const INTERNAL_DATABASE = "_internal";

/** How many names the many-databases sentence spells out before "and N more". */
const SESSION_NAMES_SHOWN = 10;

export const RUN_DATABASE_SENTENCES = {
  chooseDatabase:
    'Choose a database: open the statement from a database in the tree, set Database on the connection, or name it in the statement as "db".."measurement".',
  // One sentence for every generation that hides `_internal`, 2.x and unknown included, with no branch (R44).
  internalHidden:
    "Studio does not read the _internal database on this server; on InfluxDB 3 it holds the server's token table.",
  sessionMany: (names: readonly string[]): string => {
    const shown = names.slice(0, SESSION_NAMES_SHOWN).join(", ");
    const more = names.length > SESSION_NAMES_SHOWN ? ` and ${names.length - SESSION_NAMES_SHOWN} more` : "";
    return `This InfluxDB 3 server has more than one database (${shown}${more}), and a connection reads one: set Database on the connection.`;
  },
  sessionNone:
    "This InfluxDB 3 token can list no database; create one on the server or set Database on the connection.",
  // Worded after SPEC 5.9's connect-table 403 row, so this module stays free of imports.
  listingRefused:
    "This token cannot list the server's databases, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.",
} as const;

/** The listing without InfluxDB's own databases. */
function ordinaryDatabases(visible: readonly string[]): readonly string[] {
  return visible.filter((name) => !INFLUX_SYSTEM_DATABASES.has(name));
}

/** True when `name` is `_internal` on a generation that hides it. */
function isHiddenInternal(name: string, internalDatabase: "browse" | "hide"): boolean {
  return internalDatabase === "hide" && name === INTERNAL_DATABASE;
}

/** The `influxdb` run database, in the order of SPEC 5.8 (steps 0 to 4). */
export function resolveRunDatabase(input: {
  readonly namedDatabases: readonly string[];
  readonly needsDatabase: boolean;
  readonly connection: string | undefined;
  readonly visible: readonly string[] | undefined;
  readonly internalDatabase: "browse" | "hide";
}): RunDatabase {
  const named = [...new Set(input.namedDatabases)];
  // Step 0: whatever else the statement names.
  if (named.some((name) => isHiddenInternal(name, input.internalDatabase))) {
    return { refused: RUN_DATABASE_SENTENCES.internalHidden };
  }
  // Step 1: one name is sent as `db`; several send none, and the server reads or refuses them.
  if (named.length === 1) return { database: named[0], source: "statement" };
  if (named.length > 1) return { database: undefined, source: "server-decides" };
  if (!input.needsDatabase) return { database: undefined, source: "not-needed" };
  // Step 2.
  if (input.connection) {
    if (isHiddenInternal(input.connection, input.internalDatabase)) {
      return { refused: RUN_DATABASE_SENTENCES.internalHidden };
    }
    return { database: input.connection, source: "connection" };
  }
  // Step 3: a 1.x admin who sees `_internal` and `home` runs against `home`.
  const ordinary = input.visible === undefined ? [] : ordinaryDatabases(input.visible);
  if (ordinary.length === 1) return { database: ordinary[0], source: "only-visible" };
  // Step 4.
  return { refused: RUN_DATABASE_SENTENCES.chooseDatabase };
}

/**
 * The `influxdb3` session database, once in `connect()` (R1). `visible` is undefined when the listing
 * was refused (403): with Database set the field stands and the provider checks it with a bounded read;
 * with Database empty the connection is refused.
 */
export function resolveSessionDatabase(input: {
  readonly connection: string | undefined;
  readonly visible: readonly string[] | undefined;
  readonly internalDatabase: "browse" | "hide";
}): SessionDatabase {
  if (input.connection) {
    if (isHiddenInternal(input.connection, input.internalDatabase)) {
      return { refused: RUN_DATABASE_SENTENCES.internalHidden };
    }
    return { database: input.connection, source: "connection" };
  }
  if (input.visible === undefined) return { refused: RUN_DATABASE_SENTENCES.listingRefused };
  const ordinary = ordinaryDatabases(input.visible);
  if (ordinary.length === 1) return { database: ordinary[0], source: "only-visible" };
  if (ordinary.length === 0) return { refused: RUN_DATABASE_SENTENCES.sessionNone };
  return { refused: RUN_DATABASE_SENTENCES.sessionMany(ordinary) };
}
