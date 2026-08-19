import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";

/** Couchbase management port, the capability signal for the SQL++ dialect. */
const COUCHBASE_PORT = 8091;

/** Apache Druid Router port, the capability signal for the Druid SQL dialect. */
const DRUID_PORT = 8888;

/**
 * Alias every generated Couchbase statement binds its keyspace to. SQL++ needs a
 * name to hang `META()` and field references off, and the generator has only the
 * collection name to work from, so the alias is fixed rather than derived: `d`
 * for document. It never collides with a field, because fields are only ever
 * referenced through it.
 */
const COUCHBASE_ALIAS = "d";

/**
 * Column carrying the document key. Kept in step with
 * `COUCHBASE_DOCUMENT_KEY_COLUMN` in the provider's introspection: the schema tree
 * and the generated projection must name the key identically, or the grid shows a
 * column the query never produces.
 */
const COUCHBASE_DOCUMENT_KEY_COLUMN = "__id";

/** Backtick-quote a SQL++ identifier, doubling any backtick it contains. */
function couchbaseQuote(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * Quote only when the name would not round-trip bare, in the two styles a provider
 * may DECLARE (`ProviderCapabilities.identifierQuoting`).
 *
 * One object rather than two functions, and looked up rather than branched on: bun's
 * lcov attributes a freshly added function's declaration line to nothing, so two new
 * `function` declarations here read as uncovered while their bodies run - the phantom
 * this repo's coverage notes describe. A table has one executable line per entry and
 * no declaration line to lose.
 */
const DECLARED_QUOTING: Record<"backtick" | "double", (name: string) => string> = {
  backtick: (name) => (/^[A-Za-z_][\w$]*$/.test(name) ? name : couchbaseQuote(name)),
  double: (name) => (/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`),
};

/**
 * The document key projection. `SELECT *` nests whole documents under the
 * keyspace name and never yields the key at all (issue #262, decision 5), so
 * every generated statement projects it explicitly through the alias.
 */
const COUCHBASE_KEY_PROJECTION = `META(${COUCHBASE_ALIAS}).id AS ${COUCHBASE_DOCUMENT_KEY_COLUMN}`;

/**
 * Quote a SQL identifier (table/column) for the target dialect, but ONLY when
 * needed. Plain identifiers that round-trip unquoted are left as-is so generated
 * SQL stays readable and existing behavior is preserved; mixed-case / special /
 * fold-sensitive names get the dialect's quoting.
 *
 * Dialect is derived from the provider capabilities (same signals the generators
 * already branch on), so no provider code needs to change:
 *  - Oracle (1521): unquoted folds to UPPERCASE  → quote unless plain UPPER
 *  - SQL Server (1433): case-insensitive          → bracket-quote only specials
 *  - MySQL (3306): case-preserving                → backtick-quote only specials
 *  - Couchbase (8091): SQL++                      → always backtick-quote
 *  - Druid (8888): Calcite SQL                    → always double-quote
 *  - PostgreSQL (5432) / SQLite / ClickHouse (8123) / default: unquoted folds to
 *    lowercase (pg)                                → quote unless plain lower
 *
 * ClickHouse deliberately has no branch of its own: it never folds case and its
 * quote character is the double quote, so the default branch is already exactly
 * right — both `SELECT "id" FROM "probe"` and the bare form parse (issue #264).
 * Adding a branch would only duplicate it.
 */
export function quoteIdentifier(name: string, capabilities: ProviderCapabilities): string {
  // Document stores (MongoDB) don't use SQL identifier quoting.
  if (capabilities.queryLanguage === "json") return name;

  // An explicit declaration wins over the port heuristic below, because the port
  // stopped being a faithful proxy for the dialect: Elasticsearch and OpenSearch
  // both ship on 9200 and disagree about the quote character. Measured on
  // OpenSearch 3.8.0, a double-quoted identifier is a STRING LITERAL - the
  // generated query answers 200 with zero rows instead of failing - so the
  // fall-through default would produce silently wrong results here, not an error.
  // See `ProviderCapabilities.identifierQuoting`.
  const declared = capabilities.identifierQuoting;
  if (declared !== undefined) return DECLARED_QUOTING[declared](name);

  if (capabilities.defaultPort === COUCHBASE_PORT) {
    // Couchbase (SQL++): quote unconditionally. Reserved words (`bucket`, `scope`,
    // ...) are a syntax error unquoted, and a schemaless document may name a field
    // anything at all, so there is no safe unquoted subset worth detecting.
    return couchbaseQuote(name);
  }
  if (capabilities.defaultPort === DRUID_PORT) {
    // Druid (Calcite SQL): quote unconditionally, same reasoning as Couchbase above.
    // A bare reserved word is a SYNTAX error, not a column-not-found: `SELECT count
    // FROM libredb_demo` fails with "Received an unexpected token [count FROM]",
    // while `SELECT "count" FROM libredb_demo` parses (issue #265). `count` is
    // Druid's conventional rollup metric name, so the standard rollup ingestion
    // produces a datasource that has one. Calcite's reserved list is large and
    // version-dependent, so no safe unquoted subset is worth detecting.
    return `"${name.replaceAll('"', '""')}"`;
  }
  if (capabilities.defaultPort === 1521) {
    // Oracle
    return /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
  }
  if (capabilities.defaultPort === 1433) {
    // SQL Server
    return /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll("]", "]]")}]`;
  }
  if (capabilities.defaultPort === 3306) {
    // MySQL
    return /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
  }
  // PostgreSQL / SQLite / default
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quote a possibly schema-qualified name (e.g. `employees.department`) by quoting
 * each dotted segment independently. Quoting the whole string as one identifier
 * (`"employees.department"`) would make the database look for a single relation
 * literally named with a dot, which fails. Each segment is still quoted only when
 * needed, so `employees.department` stays unquoted and `public.Order` becomes
 * `public."Order"`.
 */
export function quoteQualifiedName(name: string, capabilities: ProviderCapabilities): string {
  if (capabilities.queryLanguage === "json") return name;
  return name
    .split(".")
    .map((part) => quoteIdentifier(part, capabilities))
    .join(".");
}

/**
 * Render a schema-tree node name for a `#` comment line. A node name is a real
 * key/collection name taken from the server, and a Redis key is an arbitrary
 * byte string — so a name containing a newline used to END the header comment
 * and turn its own remainder into the first RUNNABLE line of the cheatsheet,
 * which the provider then executed (`a\nDEL user:1 x` ran `DEL user:1`). The
 * per-argument defence never engaged, because the injection travelled through
 * the comment rather than through a command.
 *
 * JSON quoting is the fix: it escapes CR, LF and the quote character in one
 * lossless step, and for an ordinary name it renders exactly the `"name"` the
 * headers already wrote by hand. Any name entering a comment line must go
 * through this (#427).
 */
function commentName(name: string): string {
  return JSON.stringify(name);
}

/**
 * Resolve a key-value schema-tree node name to its command shape. A node is
 * either a `:`-prefix group (e.g. `users:*`, whose rows live under the `users:`
 * prefix) or a bare single key with no colon. The `*` is stripped so the base is
 * the literal prefix used in commands (`users:*` -> `users:`).
 *
 * Shared by the LibreDB and Redis branches: both build their tree from the same
 * `getKeyPrefix` grouping, so a future change to what a prefix node looks like
 * must not be able to make the two dialects disagree (#427).
 */
function prefixGroup(name: string): { isPrefixGroup: boolean; base: string } {
  if (name.endsWith(":*")) return { isPrefixGroup: true, base: name.slice(0, -1) };
  return { isPrefixGroup: false, base: name };
}

/** A concrete example JSON scalar for a catalog column type (LibreDB column
 * types are `string` | `number` | `boolean` | `object`; unknowns read as text). */
function libredbExampleForType(type: string): unknown {
  switch (type.toLowerCase()) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "object":
      return {};
    default:
      return "example";
  }
}

/**
 * A concrete, runnable example VALUE for a `put` against a group, shaped by the
 * group's columns so the generated command works as-is when selected and run:
 *  - raw kv (`key`/`value` columns) → a plain string value
 *  - document collection (`id`/`document`) → a small JSON object
 *  - relational table → a JSON object built from the declared columns
 */
function libredbExampleValue(columns: ColumnSchema[]): string {
  if (columns.length === 2 && columns[0]?.name === "key" && columns[1]?.name === "value") {
    return "example";
  }
  if (columns.length === 2 && columns[1]?.name === "document") {
    return `'{"name":"example"}'`;
  }
  const obj: Record<string, unknown> = {};
  for (const c of columns) obj[c.name] = libredbExampleForType(c.type);
  return `'${JSON.stringify(obj)}'`;
}

/**
 * Redis key types this generator can produce a read/write command for. `TYPE`
 * also replies `stream` and `none`; both fall into the unknown bucket, which
 * emits `TYPE <key>` rather than guessing a reader (#427).
 */
type RedisKeyType = "string" | "hash" | "list" | "set" | "zset";

/**
 * The read and write command each key type gets, with the use-case comment that
 * introduces it in the generated cheatsheet. A lookup table rather than a
 * `switch` so every arm is one attributable line.
 */
const REDIS_COMMANDS: Record<
  RedisKeyType,
  { readComment: string; read: (key: string) => string[]; writeComment: string; write: (key: string) => string[] }
> = {
  string: {
    readComment: "# Read the value",
    read: (key) => ["GET", key],
    writeComment: "# Create or update it — this overwrites an existing value",
    write: (key) => ["SET", key, "example"],
  },
  hash: {
    readComment: "# Read every field of the hash",
    read: (key) => ["HGETALL", key],
    writeComment: "# Create or update one field — this overwrites an existing field",
    write: (key) => ["HSET", key, "field", "example"],
  },
  list: {
    readComment: "# Read the whole list",
    read: (key) => ["LRANGE", key, "0", "-1"],
    writeComment: "# Append an element to the list",
    write: (key) => ["RPUSH", key, "example"],
  },
  set: {
    readComment: "# Read every member",
    read: (key) => ["SMEMBERS", key],
    writeComment: "# Add a member to the set",
    write: (key) => ["SADD", key, "example"],
  },
  zset: {
    readComment: "# Read every member with its score",
    read: (key) => ["ZRANGE", key, "0", "-1", "WITHSCORES"],
    writeComment: "# Add a member with a score",
    write: (key) => ["ZADD", key, "1", "example"],
  },
};

/**
 * Whether an argument survives a round-trip through the provider's plain-command
 * tokenizer. That tokenizer splits on unquoted whitespace and has NO escape
 * handling: it toggles quote mode on every `"` or `'` and drops the character.
 * So `DEL "say"hi""` reaches the driver as the key `sayhi` — a DIFFERENT key —
 * and a quote inside a MATCH pattern swallows the rest of the line. A backslash
 * or a newline is treated the same way for safety (#427).
 */
function redisPlainSafe(value: string): boolean {
  return !/["'\\\n]/.test(value);
}

/**
 * Render one Redis command in the form the provider can actually run it in.
 *
 * Plain form (`SET key value`, quoting an argument that contains whitespace) is
 * the readable default. When any argument cannot round-trip through the plain
 * tokenizer, this line — and only this line — is emitted in the lossless JSON
 * form the provider also accepts, `{"command":"DEL","args":["say\"hi\""]}`.
 * The two forms mix freely inside one cheatsheet: the provider decides per run,
 * and every line is run on its own via "Run Selected" (#427).
 */
function renderRedisCommand(parts: string[]): string {
  if (parts.every(redisPlainSafe)) {
    return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
  }
  return JSON.stringify({ command: parts[0], args: parts.slice(1) });
}

/**
 * Escape Redis glob metacharacters. Applied ONLY to the prefix half of a MATCH
 * pattern, never to a key argument: a real key `a[b:1` groups to `a[b:*`, and an
 * unescaped `[` opens a glob class that matches the wrong set. Escaping a key
 * argument would instead corrupt a literal key that genuinely contains `*` (#427).
 */
function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]^]/g, String.raw`\$&`);
}

/**
 * The single Redis key type a schema node's sample resolves to, or `null` for the
 * unknown bucket. The source is the `type` column's own `type` field, which
 * `redis.ts` `getSchema()` builds as `types.join(", ")` over the DISTINCT `TYPE`
 * replies it sampled — it issues `TYPE` for every key of a prefix until it has
 * seen 3 distinct types (or the 1000-key scan cap ends the walk), so a uniform
 * prefix costs one blocking round-trip per key and still yields one type — so `"string"` resolves, and `""` (every TYPE call threw) or
 * `"string, hash"` (a mixed prefix) deliberately do not. The `value` column
 * carries the same sample joined with `/` and exists for display only (#427).
 */
function redisKeyType(columns?: ColumnSchema[]): RedisKeyType | null {
  const sample = columns?.find((c) => c.name === "type")?.type;
  const parts = (sample || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
  // Redis TYPE replies are lowercase already; normalising keeps a hand-authored
  // schema from reading as a silent unknown.
  if (parts.length !== 1) return null;
  return parts[0] in REDIS_COMMANDS ? (parts[0] as RedisKeyType) : null;
}

/** The SCAN command listing a prefix group's keys — the only place a glob is interpreted. */
function redisScan(base: string): string {
  return renderRedisCommand(["SCAN", "0", "MATCH", `${escapeGlob(base)}*`, "COUNT", "50"]);
}

/**
 * The terminator a generated statement ends with: `;` everywhere, and nothing on a
 * product whose grammar has none.
 *
 * Only the two shapes a user reaches by CLICKING are bounded here - the schema tree's
 * "Select Top N" and "Generate Query" - because those are the statements this file
 * writes on the user's behalf. The dialect-specific returns above keep their own
 * literal `;`: each of those engines accepts one, and this is the fallthrough every
 * other SQL engine shares, which is where the two search products land. See
 * `ProviderCapabilities.statementTerminator` for the measurement.
 */
function terminator(capabilities: ProviderCapabilities): string {
  return capabilities.statementTerminator === "none" ? "" : ";";
}

export function generateTableQuery(
  tableName: string,
  capabilities: ProviderCapabilities,
  columns?: ColumnSchema[],
): string {
  // LibreDB speaks its own command grammar (get/put/delete/prefix/range), not SQL
  // and not MongoDB JSON. "Scan" lists everything under the group's prefix.
  if (capabilities.queryDialect === "libredb") {
    const { isPrefixGroup, base } = prefixGroup(tableName);
    return isPrefixGroup ? `prefix ${base}` : `get ${base}`;
  }
  // Redis speaks its own command grammar. It must be checked BEFORE the JSON
  // branch below: it declares `queryLanguage: "json"` too, so it silently got
  // MongoDB documents its driver answered with HTTP 400 (#427). A prefix group
  // is not addressable (`tablesAreDerivedGroupings`), so it always SCANs; a bare
  // key gets the reader its sampled type calls for, or `TYPE` when unknown.
  if (capabilities.queryDialect === "redis") {
    const { isPrefixGroup, base } = prefixGroup(tableName);
    if (isPrefixGroup) return redisScan(base);
    const keyType = redisKeyType(columns);
    return renderRedisCommand(keyType ? REDIS_COMMANDS[keyType].read(base) : ["TYPE", base]);
  }
  if (capabilities.queryLanguage === "json") {
    return JSON.stringify({ collection: tableName, operation: "find", filter: {}, options: { limit: 50 } }, null, 2);
  }
  const table = quoteQualifiedName(tableName, capabilities);
  // Couchbase (SQL++)
  if (capabilities.defaultPort === COUCHBASE_PORT) {
    return `SELECT ${COUCHBASE_KEY_PROJECTION}, ${COUCHBASE_ALIAS}.* FROM ${table} AS ${COUCHBASE_ALIAS} LIMIT 50;`;
  }
  // Oracle
  if (capabilities.defaultPort === 1521) {
    return `SELECT * FROM ${table} FETCH FIRST 50 ROWS ONLY;`;
  }
  // MSSQL
  if (capabilities.defaultPort === 1433) {
    return `SELECT TOP 50 * FROM ${table};`;
  }
  // PostgreSQL / MySQL / SQLite / ClickHouse / Elasticsearch / OpenSearch. The
  // trailing LIMIT matters for ClickHouse specifically: it also accepts `FORMAT x`
  // and `SETTINGS ...` as trailing clauses, and a LIMIT placed after either is a
  // syntax error, so the limit must stay last (issue #264).
  return `SELECT * FROM ${table} LIMIT 50${terminator(capabilities)}`;
}

/**
 * The LibreDB cheatsheet: a use-case comment over each command, where every
 * command line is a concrete, directly-runnable example (so "Run Selected" on
 * any line works as-is). The provider skips `#` comment and blank lines, so
 * running the whole buffer runs its first real command.
 */
function libredbCheatsheet(tableName: string, columns: ColumnSchema[]): string {
  const { isPrefixGroup, base } = prefixGroup(tableName);
  const value = libredbExampleValue(columns);
  const header = `# LibreDB commands for ${commentName(tableName)} — select a line and Run Selected.`;
  // A schema-tree node name is a real key name, and LibreDB keys are arbitrary
  // byte strings. The header is JSON-quoted so a newline in one cannot end it,
  // but `get`/`put`/`delete` interpolate the name raw, and every LibreDB command
  // is line-oriented: a key named `x\ndelete billing:2024` would render its own
  // second half as a runnable `delete billing:2024` line. LibreDB has no lossless
  // JSON command form to fall back to the way Redis does, so emit no command
  // line at all and say why (#427).
  if (/[\r\n]/.test(base)) {
    return [
      header,
      "",
      "# This key's name contains a newline. LibreDB commands are line-oriented, so no generated line can address it — write the command by hand.",
    ].join("\n");
  }
  if (isPrefixGroup) {
    const key = `${base}1`; // a concrete example key (e.g. users:1)
    return [
      header,
      "",
      "# List every key under this prefix",
      `prefix ${base}`,
      "",
      "# Read one entry by key",
      `get ${key}`,
      "",
      "# Create or update an entry",
      `put ${key} ${value}`,
      "",
      "# Delete an entry",
      `delete ${key}`,
    ].join("\n");
  }
  return [
    header,
    "",
    "# Read the value",
    `get ${base}`,
    "",
    "# Create or update it",
    `put ${base} ${value}`,
    "",
    "# Delete it",
    `delete ${base}`,
  ].join("\n");
}

/**
 * Redis: the same cheatsheet shape as LibreDB above — a use-case comment over
 * each command, every command line runnable on its own via "Run Selected". The
 * provider skips `#` and blank lines, so running the whole buffer runs its
 * first real command. A group name never appears as a key argument: Redis key
 * arguments are literal byte strings, so `DEL user:*` would delete nothing (or
 * the wrong thing) rather than the group (#427).
 */
function redisCheatsheet(tableName: string, columns: ColumnSchema[]): string {
  const { isPrefixGroup, base } = prefixGroup(tableName);
  const key = isPrefixGroup ? `${base}1` : base;
  const keyType = redisKeyType(columns);
  const lines = [`# Redis commands for ${commentName(tableName)} — select a line and Run Selected.`, ""];
  if (isPrefixGroup) {
    // SCAN is a cursor step, not a listing: one call returns one page and the
    // next cursor, and on a large keyspace the first page can be EMPTY with a
    // non-zero cursor. A one-line command cannot loop, so say how to continue
    // rather than pretend the first reply is the whole answer (#427).
    lines.push(
      "# List keys under this prefix — ONE scan iteration, not the whole set.",
      "# 0 is the start cursor; the reply's first row is the next cursor. Re-run",
      "# with that value in place of 0 until it comes back 0 (a page may be empty).",
      redisScan(base),
      "",
    );
  }
  lines.push("# Check the key's type", renderRedisCommand(["TYPE", key]), "");
  if (keyType) {
    const commands = REDIS_COMMANDS[keyType];
    lines.push(
      commands.readComment,
      renderRedisCommand(commands.read(key)),
      "",
      commands.writeComment,
      renderRedisCommand(commands.write(key)),
      "",
    );
  }
  lines.push(
    "# Time to live in seconds (-1 no expiry, -2 no such key)",
    renderRedisCommand(["TTL", key]),
    "",
    "# Delete the key (DEL takes a literal key name, never a pattern)",
    renderRedisCommand(["DEL", key]),
  );
  return lines.join("\n");
}

export function generateSelectQuery(
  tableName: string,
  columns: ColumnSchema[],
  capabilities: ProviderCapabilities,
): string {
  // LibreDB: emit an explanatory cheatsheet — a use-case comment above each
  // command — where every command line is a concrete, directly-runnable example
  // (so "Run Selected" on any line works as-is). The provider skips `#` comment
  // and blank lines, so running the whole buffer runs its first real command.
  if (capabilities.queryDialect === "libredb") {
    return libredbCheatsheet(tableName, columns);
  }
  if (capabilities.queryDialect === "redis") {
    return redisCheatsheet(tableName, columns);
  }
  if (capabilities.queryLanguage === "json") {
    const projection: Record<string, number> = {};
    columns.forEach((c) => {
      projection[c.name] = 1;
    });
    return JSON.stringify(
      {
        collection: tableName,
        operation: "find",
        filter: {},
        options: {
          projection: Object.keys(projection).length > 0 ? projection : undefined,
          limit: 100,
        },
      },
      null,
      2,
    );
  }
  const table = quoteQualifiedName(tableName, capabilities);
  // Couchbase (SQL++): every field is reached through the keyspace alias, and the
  // document key comes from META() rather than from the document body.
  if (capabilities.defaultPort === COUCHBASE_PORT) {
    const fields = columns.filter((c) => c.name !== COUCHBASE_DOCUMENT_KEY_COLUMN);
    const projected =
      fields.length > 0
        ? fields.map((c) => `  ${COUCHBASE_ALIAS}.${quoteIdentifier(c.name, capabilities)}`)
        : [`  ${COUCHBASE_ALIAS}.*`];
    const projection = [`  ${COUCHBASE_KEY_PROJECTION}`, ...projected].join(",\n");
    return `SELECT\n${projection}\nFROM ${table} AS ${COUCHBASE_ALIAS}\nWHERE 1=1\nLIMIT 100;`;
  }
  const cols = columns.map((c) => `  ${quoteIdentifier(c.name, capabilities)}`).join(",\n") || "  *";
  // Oracle
  if (capabilities.defaultPort === 1521) {
    return `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY;`;
  }
  // MSSQL
  if (capabilities.defaultPort === 1433) {
    return `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`;
  }
  return `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nLIMIT 100${terminator(capabilities)}`;
}

export function shouldRefreshSchema(query: string, schemaRefreshPattern: string): boolean {
  return new RegExp(schemaRefreshPattern, "i").test(query);
}
