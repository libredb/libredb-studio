import { cypherForSegment } from "@/lib/db/graph/cypher/generators";
import { quoteCypherName } from "@/lib/db/graph/cypher/quote";
import { declaredLevels } from "@/lib/db/object-kinds";
import { type QueryDialect, registeredDialect } from "@/lib/db/query-dialects";
import { encodeKey } from "@/lib/db/providers/keyvalue/etcd/keys";
import { oxiaSelectQuery, oxiaTableQuery } from "@/lib/db/providers/keyvalue/oxia/generators";
import { s3SelectQuery, s3TableQuery } from "@/lib/db/providers/objectstore/s3/console/generators";
import { quoteGoString, quoteTxnWord, quoteWord } from "@/lib/db/providers/keyvalue/etcd/lexer";
import { influxqlSelectQuery, influxqlTableQuery } from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { influxqlSource, quoteInfluxqlIdentifier } from "@/lib/db/providers/timeseries/influxdb/influxql-quote";
import { metricSelector } from "@/lib/db/providers/timeseries/prometheus/promql";
import { milvusSelectQuery, milvusTableQuery } from "@/lib/db/providers/vector/milvus/generators";
import { qdrantSelectQuery, qdrantTableQuery } from "@/lib/db/providers/vector/qdrant/generators";
import {
  type ObjectReadRange,
  offersCountQuery,
  type PreviewTimeWindow,
  type ProviderCapabilities,
} from "@/lib/db/types";
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
 * may DECLARE (`ProviderCapabilities.identifierQuoting`), or always, in the other two.
 *
 * One object rather than two functions, and looked up rather than branched on: bun's
 * lcov attributes a freshly added function's declaration line to nothing, so two new
 * `function` declarations here read as uncovered while their bodies run - the phantom
 * this repo's coverage notes describe. A table has one executable line per entry and
 * no declaration line to lose.
 */
const DECLARED_QUOTING: Record<
  NonNullable<ProviderCapabilities["identifierQuoting"]>,
  (name: string, always: boolean) => string
> = {
  backtick: (name, always) => (!always && /^[A-Za-z_][\w$]*$/.test(name) ? name : couchbaseQuote(name)),
  double: (name, always) => (!always && /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`),
  "double-always": (name) => `"${name.replaceAll('"', '""')}"`,
  "backtick-always": (name) => couchbaseQuote(name),
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
 *
 * `always` quotes a name that would round-trip bare as well. The bare test is about case and
 * characters only, so a lowercase reserved word passes it: `when`, `order`, `user` and `group`
 * come back bare and the engine reads them as keywords (#1396). Quoting such a name never
 * changes which object it means, because a name passes the bare test only in the case the
 * engine folds a bare name to. A statement that names columns it is about to create, as an
 * import into a new table does, asks for this.
 */
export function quoteIdentifier(
  name: string,
  capabilities: ProviderCapabilities,
  { always = false }: { always?: boolean } = {},
): string {
  // The JSON-language engines don't use SQL identifier quoting: MongoDB, and Redis, LibreDB, Kafka
  // and etcd, which declare a JSON dialect of their own (#1088, #1089).
  if (capabilities.queryLanguage === "json") return name;
  // Cypher writes every name in backticks, a backtick doubled, as its generators do (Neo4j spec 6.5).
  if (capabilities.queryLanguage === "cypher") return quoteCypherName(name);
  // InfluxQL always double-quotes a name, with the scanner's escapes (InfluxDB spec 6.7, C6).
  if (capabilities.queryLanguage === "influxql") return quoteInfluxqlIdentifier(name);

  // An explicit declaration wins over the port heuristic below, because the port
  // stopped being a faithful proxy for the dialect: Elasticsearch and OpenSearch
  // both ship on 9200 and disagree about the quote character. Measured on
  // OpenSearch 3.8.0, a double-quoted identifier is a STRING LITERAL - the
  // generated query answers 200 with zero rows instead of failing - so the
  // fall-through default would produce silently wrong results here, not an error.
  // See `ProviderCapabilities.identifierQuoting`.
  const declared = capabilities.identifierQuoting;
  if (declared !== undefined) return DECLARED_QUOTING[declared](name, always);

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
    return !always && /^[A-Z_][A-Z0-9_$#]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
  }
  if (capabilities.defaultPort === 1433) {
    // SQL Server
    return !always && /^[A-Za-z_]\w*$/.test(name) ? name : `[${name.replaceAll("]", "]]")}]`;
  }
  if (capabilities.defaultPort === 3306) {
    // MySQL
    return !always && /^[A-Za-z_][\w$]*$/.test(name) ? name : `\`${name.replaceAll("`", "``")}\``;
  }
  // PostgreSQL / SQLite / default
  return !always && /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/**
 * Quote an object ADDRESS: one segment per container level, then the object's own
 * segment, each quoted independently and joined with `.`.
 *
 * Segments in and never a string to split, which is the whole of the rule. A name is
 * what LABELS an object and a path is what ADDRESSES it (#789), and the string form
 * below could only guess where one segment ends: a ClickHouse table really named
 * `.inner_id.fake` in `demo` generated `SELECT * FROM "".inner_id.fake`, which the
 * server answers with a syntax error at position 15, because the dots in its NAME were
 * read as qualifiers. Reproduced in the browser on ClickHouse 25.8 before this changed.
 *
 * Quoting stays per segment and stays conditional, so `["employees", "department"]` is
 * still `employees.department` and `["public", "Order"]` is still `public."Order"`.
 *
 * Full qualification is emitted unconditionally, including inside the session default
 * container. `demo.orders`, `[libredb_objects].[app].[customers]` and `APP.APP_CUSTOMERS`
 * are all valid wherever the bare name is, so nothing here has to know which container a
 * connection defaults to - and no capability declares that, which is why the flat spelling
 * could not be qualified at the call site.
 *
 * `options.always` is `quoteIdentifier`'s, applied to every segment.
 */
export function quoteObjectPath(
  path: readonly string[],
  capabilities: ProviderCapabilities,
  options: { always?: boolean } = {},
): string {
  if (capabilities.queryLanguage === "json") return path.join(".");
  // An InfluxQL measurement is `[database, measurement]`, written `"db".."m"`: the database's default retention
  // policy (InfluxDB spec 6.7). No object is the empty string, as on every other dialect: a modal mounted before an
  // object is chosen renders with the empty path.
  if (capabilities.queryLanguage === "influxql") {
    if (path.length === 0) return "";
    if (path.length !== 2) {
      throw new RangeError(`An InfluxQL source path is [database, measurement]; received ${path.length} segment(s)`);
    }
    return influxqlSource(path[0], path[1]);
  }
  return path.map((segment) => quoteIdentifier(segment, capabilities, options)).join(".");
}

/**
 * The object's own segment, which is the LAST one and is never read by index 0 (standing
 * ruling 5g): at container depth 2 the object is `path[2]`, and a positional read there
 * addresses a container instead.
 *
 * An empty path is refused rather than rendered. It is a caller that lost the address, and
 * every dialect below would otherwise spell it silently: `FROM ` on SQL, `get ` on LibreDB,
 * `"collection": undefined` on MongoDB. Both generators resolve it before they branch, so
 * one refusal covers every dialect.
 *
 * Exported for `useTabManager`, which names the tab it opens after the object and has the
 * same two reasons to read the last segment and to refuse an empty address.
 */
export function objectSegment(path: readonly string[]): string {
  const segment = path[path.length - 1];
  if (segment === undefined) throw new Error("Cannot generate a query: the object address has no segments.");
  return segment;
}

/**
 * The address a JSON command carries: the collection's own segment, and the database that
 * holds it as a key of its own (#843). `db.collection("sample_shop.users")` would name a
 * collection literally called that, so the database cannot ride inside `collection`.
 *
 * The database is the segment the declaration assigns to its `schema` level, never
 * `path[0]` (standing ruling 5g), and it is emitted unconditionally, including for the
 * connected database, for the reason `quoteObjectPath` qualifies unconditionally. A path
 * whose length does not match the declared levels is refused: a collection that lost its
 * database would otherwise read the connected database's same-named collection, which is
 * the wrong answer #843 was.
 *
 * The one reader for every statement the product writes for MongoDB: the three generators
 * below, the profiler route and the test data generator.
 */
export function jsonCommandAddress(
  path: readonly string[],
  capabilities: ProviderCapabilities,
): { database?: string; collection: string } {
  const levels = declaredLevels(capabilities);
  if (path.length !== levels.length + 1) {
    const shape = [...levels.map((level) => level.id), "name"].join(", ");
    throw new Error(`Cannot generate a query: the object path is [${shape}], received ${JSON.stringify(path)}.`);
  }
  const collection = objectSegment(path);
  if (levels.length === 0) return { collection };
  const index = levels.findIndex((level) => level.id === "schema");
  if (index < 0) {
    throw new Error(
      `Cannot generate a query: a JSON command needs a "schema" container level for its database; ` +
        `the declaration is [${levels.map((level) => level.id).join(", ")}].`,
    );
  }
  return { database: path[index], collection };
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
 * through this (#427), a PromQL metric's name included (#1085).
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
 * `keyGrouping` grouping, so a future change to what a prefix node looks like
 * must not be able to make the two dialects disagree (#427).
 */
function prefixGroup(name: string): { isPrefixGroup: boolean; base: string } {
  if (name.endsWith(":*")) return { isPrefixGroup: true, base: name.slice(0, -1) };
  return { isPrefixGroup: false, base: name };
}

/**
 * An etcd key-prefix group's prefix (#1089, section 6.4): the row name without its final `*` where the
 * name ends in `/*`, the only name keys.ts `groupLabel` writes (`/app/config/*` reads `/app/config/`).
 * Any other segment is the prefix as it stands, so a hand-built path still reads a bounded prefix, and
 * never a key with a `*` in it.
 */
function etcdGroupPrefix(name: string): string {
  return name.endsWith("/*") ? name.slice(0, -1) : name;
}

/** The rows a generated etcd read asks for: the preview page the other arms read (#1089 6.4). */
const ETCD_READ_LIMIT_FLAG = "--limit=50";

/** The sample key's last segment and the sample value of Generate Command's write forms (#1089 6.4). */
const ETCD_SAMPLE_NAME = "example";
const ETCD_SAMPLE_VALUE = "value";

/**
 * Whether a word holds a character Studio's editor does not keep as the etcd command line spells it: a
 * carriage return, which has no spelling there, since the editor ends a line at it and the lexer's
 * `quoteWord` throws for one, or a line or paragraph separator, U+2028 or U+2029, which Monaco offers to
 * remove from the text the moment it lands, as an unusual line terminator, so a form that kept it raw
 * between single quotes would name other bytes once the offer is taken. A form that names one is written
 * as a txn request instead, whose Go quoting escapes each of them (#1089 6.4).
 */
const holdsUnkeptCharacter = (word: string): boolean => /[\r\u2028\u2029]/.test(word);

/**
 * A group's name as an etcd note names it: `commentName`'s JSON quoting, with a line or paragraph separator,
 * which JSON leaves raw and the editor does not keep (`holdsUnkeptCharacter`), written as its `\u` escape, which
 * JSON reads back as the same character (#1089 6.4).
 */
const etcdCommentName = (name: string): string =>
  commentName(name).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`);

/**
 * One etcd request: the command, then its arguments through `quote`, the word rule of the place the
 * request lands, then the flags; or, where an argument begins with `-`, the flags, `--` and the arguments,
 * because etcdctl reads a word that begins with `-` as a flag (#1089 6.4, R11 ETCD-6).
 */
function etcdRequest(
  command: string,
  args: readonly string[],
  flags: readonly string[],
  quote: (word: string) => string,
): string {
  const words = args.map(quote);
  const dashed = args.some((arg) => arg.startsWith("-"));
  return [command, ...(dashed ? [...flags, "--", ...words] : [...words, ...flags])].join(" ");
}

/** A word of a txn request: bare when it is safe text, else Go-quoted (lexer.ts `quoteTxnWord`). */
const etcdTxnWord = (word: string): string => quoteTxnWord(encodeKey(word));

/** A piece of a group's range as a get names it: its keys, and `--prefix` for a prefix (#1089 4.7). */
function etcdPieceGet(piece: ObjectReadRange): { readonly keys: readonly string[]; readonly flags: readonly string[] } {
  if ("key" in piece) return { keys: [piece.key], flags: [] };
  if ("prefix" in piece) return { keys: [piece.prefix], flags: ["--prefix"] };
  return { keys: [piece.start, piece.end], flags: [] };
}

/**
 * The read of one piece (#1089 6.4): a get on the command line with the preview's `--limit`, or, where a
 * key holds a character the editor does not keep as the command line spells it (`holdsUnkeptCharacter`),
 * a txn whose success list holds the Go-quoted get with no `--limit`, since the provider sends a txn's
 * ranged get with its own page size (#1089 5.1.4). The txn closes its success and failure lists with a
 * blank line each, so no line below it is read as one of its requests.
 */
function etcdRead(piece: ObjectReadRange): string {
  const { keys, flags } = etcdPieceGet(piece);
  if (keys.some(holdsUnkeptCharacter)) {
    return ["txn", "", etcdRequest("get", keys, flags, etcdTxnWord), "", ""].join("\n");
  }
  return etcdRequest("get", keys, [...flags, ETCD_READ_LIMIT_FLAG], quoteWord);
}

/**
 * A form written as comment lines (#1089 6.4): every physical line behind `# `, and a blank one as `#`, so a
 * form that spans lines, a quoted key holding a newline or a txn, is commented on each of them and never
 * leaves a runnable remainder.
 */
function etcdCommented(form: string): string {
  return form
    .split("\n")
    .map((line) => (line === "" ? "#" : `# ${line}`))
    .join("\n");
}

/**
 * Blocks a blank line apart; a block that ends in a line break, the closed txn of `etcdRead`, already ends
 * on a blank line, so it takes one line break more.
 */
function etcdBlocks(blocks: readonly string[]): string {
  return blocks.reduce((text, block) => `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${block}`);
}

/**
 * What a tree click on an etcd group runs (#1089 6.4, 4.7): the read of the first piece this connection may
 * read, the whole prefix where the listing named none, and each further piece as a commented read below it.
 * A group whose every readable piece starts or ends at a key that is not UTF-8 text lists no piece
 * (keyvalue/etcd/objects.ts `groupReadRanges`), and gets a note and no read.
 */
function etcdReadText(tableName: string, scope: GeneratorScope | undefined): string {
  const [first, ...rest] = scope?.readRanges ?? [{ prefix: etcdGroupPrefix(tableName) }];
  if (first === undefined) {
    return `# No read is written for ${etcdCommentName(tableName)}: each part of it this connection may read starts or ends at a key that is not UTF-8 text.`;
  }
  return etcdBlocks([etcdRead(first), ...rest.map((piece) => etcdCommented(etcdRead(piece)))]);
}

/**
 * The txn template of Generate Command (#1089 6.4): create the key where it does not exist, else read it.
 * The compare's key is Go-quoted, as etcdctl's compare reads it, and each request word takes the txn rule.
 */
function etcdTxnTemplate(key: string): string {
  return [
    "txn",
    `create(${quoteGoString(encodeKey(key))}) = "0"`,
    "",
    etcdRequest("put", [key, ETCD_SAMPLE_VALUE], [], etcdTxnWord),
    "",
    etcdRequest("get", [key], [], etcdTxnWord),
  ].join("\n");
}

/**
 * Generate Command's other forms (#1089 6.4), each on a sample key under the group's prefix: a put, a
 * del, a watch of the prefix and the txn template. A prefix holding a character the editor does not keep
 * as the command line spells it has no command-line form, so the txn template, which spells it, is its
 * one form. A prefix that begins with `-` gets no watch: on `watch`, a `--` introduces the command etcdctl
 * runs for each event, so no watch of such a prefix parses.
 */
function etcdOtherForms(prefix: string): readonly string[] {
  const key = `${prefix}${ETCD_SAMPLE_NAME}`;
  const template = etcdTxnTemplate(key);
  if (holdsUnkeptCharacter(prefix)) return [template];
  return [
    etcdRequest("put", [key, ETCD_SAMPLE_VALUE], [], quoteWord),
    etcdRequest("del", [key], [], quoteWord),
    ...(prefix.startsWith("-") ? [] : [etcdRequest("watch", [prefix], ["--prefix"], quoteWord)]),
    template,
  ];
}

/**
 * Generate Command on an etcd group (#1089 6.4): the click's read, then the other forms as comments, so
 * running the whole buffer runs the read and a write needs an edit first. On a read-only connection it is
 * the read alone, with its pieces, and no form that writes (E6).
 */
function etcdCommandText(tableName: string, scope: GeneratorScope | undefined): string {
  const read = etcdReadText(tableName, scope);
  if (scope?.readOnly === true) return read;
  return etcdBlocks([read, ...etcdOtherForms(etcdGroupPrefix(tableName)).map(etcdCommented)]);
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
function libredbExampleValue(columns: readonly ColumnSchema[]): string {
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
 * also replies `none`, which falls into the unknown bucket and emits
 * `TYPE <key>` rather than guessing a reader (#427). `stream` and the
 * `ReJSON-RL` reply a RedisJSON key gives have their own readers (#1454).
 */
type RedisKeyType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "rejson-rl";

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
  stream: {
    readComment: "# Read the first entries of the stream",
    read: (key) => ["XRANGE", key, "-", "+", "COUNT", "100"],
    writeComment: "# Append an entry to the stream",
    write: (key) => ["XADD", key, "*", "field", "example"],
  },
  "rejson-rl": {
    readComment: "# Read the JSON document",
    read: (key) => ["JSON.GET", key],
    writeComment: "# Create or update the JSON document",
    write: (key) => ["JSON.SET", key, "$", '{"example":true}'],
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
export function escapeGlob(value: string): string {
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
function redisKeyType(columns?: readonly ColumnSchema[]): RedisKeyType | null {
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
 * writes on the user's behalf.
 *
 * `generateTableQuery`'s returns all ask this now. They did not always: Oracle and SQL
 * Server had branches of their own to spell their row bound, and #816 removed the bound,
 * which left the two branches doing nothing the shared return did not. `generateSelectQuery`
 * still keeps a literal `;` in its SQL Server and Couchbase branches, because both accept
 * one and neither branch has been touched.
 *
 * Oracle is the measurement that moved: `SELECT * FROM app_customers FETCH FIRST 50
 * ROWS ONLY;` answers ORA-00933, so clicking a table on Oracle had never once worked.
 * See `ProviderCapabilities.statementTerminator` for both measurements.
 */
function terminator(capabilities: ProviderCapabilities): string {
  return capabilities.statementTerminator === "none" ? "" : ";";
}

/**
 * The one refusal both LibreDB generators give for a name they cannot address:
 * a `#` note and no command line. A schema-tree node name is a real key name,
 * LibreDB keys are arbitrary byte strings, and every LibreDB command is
 * line-oriented — `get`/`put`/`delete`/`prefix` interpolate the name raw, so a
 * key named `x\ndelete billing:2024` renders its own second half as a runnable
 * `delete billing:2024` line. LibreDB has no lossless JSON command form to fall
 * back to the way Redis does, so emit no command line at all and say why. Both
 * callers go through here so the two branches cannot drift (#427, U11).
 */
function libredbNewlineNote(base: string): string | null {
  if (!/[\r\n]/.test(base)) return null;
  // No "write it by hand" advice: `firstCommandLine` splits the buffer on LF before tokenizing
  // (providers/embedded/libredb.ts), so a key whose name contains a LINE FEED cannot be reached
  // from this editor at all, quoted or not. A carriage return survives inside quotes and could be
  // typed by hand - but one note covers both characters, and promising an action that fails for
  // half of them is worse than promising none.
  return "# This key's name contains a line break. LibreDB commands are line-oriented, so no generated line can address it.";
}

/**
 * What only the etcd arms of the two generators read (#1089, sections 3.3, 4.7 and 6.4), handed over by
 * `useTabManager` from the schema entry and the active connection. Every other arm ignores it, so no other
 * engine's text moves with it.
 */
export interface GeneratorScope {
  /** The pieces of a group's range this connection may read, `DatabaseObject.readRanges`, where they do not cover it. */
  readonly readRanges?: readonly ObjectReadRange[];
  /** The active connection's public `readOnly`: Generate Command then writes the read alone (#1089 E6). */
  readonly readOnly?: boolean;
}

/**
 * What one query dialect writes for a tree click (`table`, run on the user's behalf) and for "Generate Query"
 * (`select`, written into a tab and not run), each from the object's path.
 */
export interface DialectGenerators {
  readonly table: (
    path: readonly string[],
    columns: readonly ColumnSchema[] | undefined,
    scope: GeneratorScope | undefined,
  ) => string;
  readonly select: (
    path: readonly string[],
    columns: readonly ColumnSchema[],
    scope: GeneratorScope | undefined,
  ) => string;
}

/**
 * Every query dialect's generators, read by `generateTableQuery` and `generateSelectQuery` BEFORE their JSON arm:
 * each dialect declares `queryLanguage: "json"` too, and without its record a tree click auto-executes a MongoDB
 * `find` its provider refuses (#427, #1088, #1089). A `Record` over `QueryDialect`, so a dialect added to the
 * union does not compile until it has its generators. Module-internal: the two generators are its only readers,
 * and this module's export list is pinned (`tests/unit/lib/query-generators.test.ts`).
 */
const DIALECT_GENERATORS: Readonly<Record<QueryDialect, DialectGenerators>> = Object.freeze({
  // LibreDB speaks its own command grammar (get/put/delete/prefix/range), not SQL and not MongoDB JSON. "Scan"
  // lists everything under the group's prefix, and "Scan Keys" AUTO-EXECUTES, so a newline in the name, which
  // used to leave a second, plausible command one "Run Selected" away, gets the shared refusal (U11). "Generate
  // Command" writes an explanatory cheatsheet, a use-case comment above each command and every command line a
  // concrete, directly runnable example; the provider skips `#` comment and blank lines, so running the whole
  // buffer runs its first real command.
  libredb: {
    table: (path) => {
      const { isPrefixGroup, base } = prefixGroup(objectSegment(path));
      const note = libredbNewlineNote(base);
      if (note !== null) return note;
      return isPrefixGroup ? `prefix ${base}` : `get ${base}`;
    },
    select: (path, columns) => libredbCheatsheet(objectSegment(path), columns),
  },
  // Redis speaks its own command grammar, and it silently got MongoDB documents its driver answered with HTTP 400
  // before it had a record (#427). A prefix group is not addressable (`tablesAreDerivedGroupings`), so it always
  // SCANs; a bare key gets the reader its sampled type calls for, or `TYPE` when unknown.
  redis: {
    table: (path, columns) => {
      const { isPrefixGroup, base } = prefixGroup(objectSegment(path));
      if (isPrefixGroup) return redisScan(base);
      const keyType = redisKeyType(columns);
      return renderRedisCommand(keyType ? REDIS_COMMANDS[keyType].read(base) : ["TYPE", base]);
    },
    select: (path, columns) => redisCheatsheet(objectSegment(path), columns),
  },
  // Kafka reads a topic through a JSON read request (#1088 3.3), and the name goes through JSON.stringify with the
  // rest, so no topic name leaves its string. "Generate Query" writes ONE read request, because the tab's whole
  // buffer is sent as one request (`handleGenerateSelect` in use-tab-manager.ts) and JSON has no comments to hold
  // the other forms: it names a partition and reads it from its earliest offset, which exists on any retention,
  // and the result's `offset` column shows the offsets the `{"offset": n}` form takes. The offset and timestamp
  // forms are documented in docs/providers/kafka.md. The columns are the fields each message comes back with, not
  // keys of the request, so none is written.
  kafka: {
    table: (path) => JSON.stringify({ topic: objectSegment(path), from: "latest", limit: 50 }, null, 2),
    select: (path) =>
      JSON.stringify({ topic: objectSegment(path), partition: 0, from: "earliest", limit: 50 }, null, 2),
  },
  // etcd reads a group through an etcdctl command (#1089, section 6.4). A row is one group, so the click reads its
  // prefix, or the first piece of it this connection may read, bounded by the command's own `--limit`; "Generate
  // Command" writes that read on the first line and the other forms as comments below it. A group's columns are
  // the fixed shape of a get row, so none reaches the text.
  etcd: {
    table: (path, _columns, scope) => etcdReadText(objectSegment(path), scope),
    select: (path, _columns, scope) => etcdCommandText(objectSegment(path), scope),
  },
  // Milvus reads a collection through its own console request (vector-family spec 5.7), written by the provider's
  // browser-safe generators.ts: the tree click is an entities/query naming the clicked database and collection, and
  // "Generate Command" a runnable search over the first dense vector field. Neither reads the scope.
  milvus: {
    table: (path) => milvusTableQuery(path),
    select: (path, columns) => milvusSelectQuery(path, columns),
  },
  // Qdrant reads a collection through its own console request (vector-family spec 6.7), written by the provider's
  // browser-safe generators.ts: the tree click is a 100-point scroll of the clicked collection, without vectors, and
  // "Generate Command" a runnable query over the first dense vector. Neither reads the scope.
  qdrant: {
    table: (path) => qdrantTableQuery(path),
    select: (path, columns) => qdrantSelectQuery(path, columns),
  },
  // Oxia reads a key through an oxia client command (SB2-4.5), written by the provider's browser-safe generators.ts:
  // the click is `get <key>`, and "Generate Command" that get with the `list --prefix` and `range-scan --prefix` forms
  // as comments. No shipped click reaches them in v1 (a key row opens its Source tab, SB2-12 D2). Neither reads the
  // columns or the scope.
  oxia: {
    table: (path) => oxiaTableQuery(path),
    select: (path) => oxiaSelectQuery(path),
  },
  // S3: a bucket click lists its top level and an object click previews it; Generate Command
  // adds reads as comments. Every text is a command the console's parser accepts, or a note.
  s3: {
    table: (path) => s3TableQuery(path),
    select: (path) => s3SelectQuery(path),
  },
});

/**
 * The statement behind "Select Top 50", the one a CLICK on a tree row runs (#789).
 *
 * It takes the object's PATH, because that is what addresses an object; `name` is what
 * labels it (standing ruling 2). Every dialect below that addresses by qualification gets
 * the whole path, and each that addresses a single key, collection, topic or metric gets
 * the object's own segment.
 *
 * NO SQL RETURN HERE CARRIES A ROW BOUND (#816). It used to: `LIMIT 50`, `FETCH FIRST 50
 * ROWS ONLY`, `SELECT TOP 50`. Nothing downstream could then tell that preview cap from a
 * bound the user typed, because both are text in the same string — and the limiter
 * returns a self-bounded statement UNTOUCHED, discarding the offset with it, so the page
 * after the first was the first again. The cap travels as the `limit` EXECUTION OPTION
 * instead (`PREVIEW_PAGE_SIZE` in `use-tab-manager.ts`), which leaves a user-written
 * `LIMIT n` with exactly one meaning: a hard bound we do not page past.
 *
 * The four JSON-language branches keep their own bound, and that is not an exception to
 * the rule. None of MongoDB, Redis, Kafka and etcd can be asked for page two at all
 * (`supportsResultPagination: false`, measured), so their bound is the only one there is
 * and no control is offered that a preview cap in the text could disengage. Kafka's is
 * the read request's own `limit` (#1088), and etcd's the command's own `--limit` (#1089).
 *
 * The PromQL branch writes the metric's selector and no bound at all (#1085): PromQL has no row
 * bound to write, and the provider caps the series it returns (#1085, section 5.4).
 *
 * `scope` is read by the etcd arm alone (#1089): a group's `readRanges`, so a user who is not root
 * reads the first piece of the group they may read, and not the whole group etcd would refuse.
 */
export function generateTableQuery(
  path: readonly string[],
  capabilities: ProviderCapabilities,
  columns?: readonly ColumnSchema[],
  scope?: GeneratorScope,
): string {
  const tableName = objectSegment(path);
  // A query dialect's own command, from its `DIALECT_GENERATORS` record, BEFORE the JSON arm below.
  const dialect = registeredDialect(capabilities);
  if (dialect !== undefined) return DIALECT_GENERATORS[dialect].table(path, columns, scope);
  if (capabilities.queryLanguage === "json") {
    return JSON.stringify(
      { ...jsonCommandAddress(path, capabilities), operation: "find", filter: {}, options: { limit: 50 } },
      null,
      2,
    );
  }
  // PromQL (#1085). A metric is addressed by a SELECTOR, never by a quoted path: the bare name
  // where the lexer reads it as one and a `__name__` matcher for every other name, both written
  // by `metricSelector`, the one PromQL builder (#1085 S4). An instant selector evaluates at now
  // and answers one row per series; the provider caps the series (#1085, section 5.4), so no
  // bound is written here, and PromQL has no statement terminator to append.
  if (capabilities.queryLanguage === "promql") {
    return metricSelector(tableName);
  }
  // Cypher (Neo4j spec 6.5, SR5). A label or a relationship type is addressed by its kind-qualified
  // segment, so the two of one name never read each other's rows: a label reads a bounded sample of its
  // nodes and a relationship type its relationships with their ends, each name backticked. Without this
  // arm a tree click would auto-execute `SELECT * FROM ...`. An index or a constraint has no generator
  // in v1 and no click action (role `config`), so its segment writes no statement.
  if (capabilities.queryLanguage === "cypher") {
    return cypherForSegment(tableName) ?? "";
  }
  // InfluxQL (InfluxDB spec 6.6, I20): the newest points of the last hour, `LIMIT 50` per series written in the
  // text, because the type declares no external limiting. The path must be `[database, measurement]`.
  if (capabilities.queryLanguage === "influxql") return influxqlTableQuery(path);
  const table = quoteObjectPath(path, capabilities);
  // Couchbase (SQL++). The one SQL branch left, and it is about the PROJECTION: the
  // document key is not a column, so the grid has nothing to show without the alias.
  if (capabilities.defaultPort === COUCHBASE_PORT) {
    return `SELECT ${COUCHBASE_KEY_PROJECTION}, ${COUCHBASE_ALIAS}.* FROM ${table} AS ${COUCHBASE_ALIAS}${terminator(capabilities)}`;
  }
  // An engine whose driver misreads some column types declares how its preview reads each one
  // (#786), so the preview names its columns rather than asking for `*`.
  const projection = capabilities.previewProjection;
  if (projection !== undefined) {
    return projectedPreview(table, projection, columns ?? [], capabilities);
  }
  // An engine whose preview reads a recent window, newest first (InfluxDB spec 6.6, I20).
  const window = capabilities.previewTimeWindow;
  if (window !== undefined) return windowedPreview(table, window, capabilities);
  // Every other SQL dialect, Oracle and SQL Server included. They had branches of their
  // own only to spell their row bound — `FETCH FIRST 50 ROWS ONLY` and `SELECT TOP 50` —
  // and with no bound to spell, one statement serves all of them. Issue #264's rule, that
  // a ClickHouse bound must sit after any `FORMAT` or `SETTINGS` clause, is moot for the
  // same reason: there is no generated bound to misplace.
  return `SELECT * FROM ${table}${terminator(capabilities)}`;
}

/**
 * The preview of an engine that declares `previewTimeWindow` (InfluxDB spec 6.6, I20): the newest rows of the
 * window under the declaration's note, with no `LIMIT` in the text, so the limiter appends the preview cap after
 * `ORDER BY ... DESC` and Load More pages (finding F5).
 */
function windowedPreview(table: string, window: PreviewTimeWindow, capabilities: ProviderCapabilities): string {
  const column = quoteIdentifier(window.column, capabilities);
  return `-- ${window.note}\nSELECT * FROM ${table} WHERE ${column} >= ${window.since} ORDER BY ${column} DESC${terminator(capabilities)}`;
}

/**
 * The declaration's example lines as comments, `{table}` and `{column}` filled: the first `float` or `integer`
 * column, else `"value"`, each quoted. Filled through a function, so a `$&` in a name is the name; a line break in a
 * name becomes a space, so no name can end a comment line and turn its rest into a statement.
 */
function windowExamples(
  table: string,
  window: PreviewTimeWindow,
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
): string[] {
  const numeric = columns.find((c) => c.type === "float" || c.type === "integer");
  const column = quoteIdentifier(numeric?.name ?? "value", capabilities);
  return window.examples.map(
    (example) =>
      `-- ${example
        .replaceAll("{table}", () => table)
        .replaceAll("{column}", () => column)
        .replace(/[\r\n]/g, " ")}`,
  );
}

/**
 * A preview that names its columns and reads each through the declared projection (#786).
 *
 * The first rule whose `type` matches a column's declared type decides how it is read: through
 * its expression, aliased back to the column's own name so the grid's header does not change, or
 * not at all, in which case the column is named in a comment above the statement. Names in the
 * comment are JSON-quoted, as `commentName` quotes them, so no name can end the comment.
 *
 * With no column list loaded, the preview reads `*` under the declaration's own note: there is
 * no list to project, and saying so beats a statement that pretends to have one. With a list
 * whose every column is left out, the comment naming them is the whole preview: `*` would read
 * exactly the columns the declaration says cannot be read.
 */
function projectedPreview(
  table: string,
  projection: NonNullable<ProviderCapabilities["previewProjection"]>,
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
): string {
  const rules = projection.rules.map((rule) => ({ pattern: new RegExp(rule.type), expression: rule.expression }));
  const read: string[] = [];
  const omitted: string[] = [];
  for (const column of columns) {
    const rule = rules.find((candidate) => candidate.pattern.test(column.type));
    const quoted = quoteIdentifier(column.name, capabilities);
    if (rule === undefined) {
      read.push(quoted);
    } else if (rule.expression === null) {
      omitted.push(`${commentName(column.name)} ${column.type.replace(/[\r\n]/g, " ")}`);
    } else {
      read.push(`${rule.expression.replaceAll("{column}", quoted)} AS ${quoted}`);
    }
  }
  if (columns.length === 0) {
    return `-- ${projection.unprojectedNote}\nSELECT * FROM ${table}${terminator(capabilities)}`;
  }
  const comment = `-- Not read by this preview: ${omitted.join(", ")}. ${projection.omittedNote}`;
  if (read.length === 0) return comment;
  const statement = `SELECT ${read.join(", ")} FROM ${table}${terminator(capabilities)}`;
  if (omitted.length === 0) return statement;
  return `${comment}\n${statement}`;
}

/**
 * The LibreDB cheatsheet: a use-case comment over each command, where every
 * command line is a concrete, directly-runnable example (so "Run Selected" on
 * any line works as-is). The provider skips `#` comment and blank lines, so
 * running the whole buffer runs its first real command.
 */
function libredbCheatsheet(tableName: string, columns: readonly ColumnSchema[]): string {
  const { isPrefixGroup, base } = prefixGroup(tableName);
  const value = libredbExampleValue(columns);
  const header = `# LibreDB commands for ${commentName(tableName)} — select a line and Run Selected.`;
  // The header is JSON-quoted so a newline in a name cannot end it; the command
  // lines have no such protection, so a name carrying one gets the shared refusal.
  const note = libredbNewlineNote(base);
  if (note !== null) {
    return [header, "", note].join("\n");
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
function redisCheatsheet(tableName: string, columns: readonly ColumnSchema[]): string {
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
      "# 0 is the start cursor; the reply's cursor column holds the next one. Re-run",
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

/**
 * The field paths a MongoDB projection may name together: every path whose ancestor is also
 * listed is dropped, since projecting the subdocument already returns it.
 *
 * Inferred columns name a subdocument and its dotted children side by side (`address`,
 * `address.city`, `address.geo.lat`; docs/providers/mongodb.md section 3.3), and MongoDB
 * refuses a projection or `$project` that names a path beside one of its sub-paths:
 * `Path collision at address.city remaining portion city` (measured on mongo:8.2.12). An
 * ancestor is a whole segment, so `addressBook` survives `address`. Order is kept and
 * duplicates collapse.
 */
export function outermostFieldPaths(names: readonly string[]): string[] {
  const listed = new Set(names);
  return [...listed].filter((name) => {
    const segments = name.split(".");
    return !segments.some((_, i) => i > 0 && listed.has(segments.slice(0, i).join(".")));
  });
}

/**
 * The statement behind "Generate Query", which is written into a tab and NOT run.
 *
 * Takes the object's PATH for the same reason `generateTableQuery` does, and the two stay
 * in step: a user who clicks a row and a user who asks for the statement must be handed
 * the same address.
 *
 * IT KEEPS ITS `LIMIT 100`, and #816 left it there deliberately. The bound left
 * `generateTableQuery` because that statement is RUN on the user's behalf, so its cap was
 * the product's own and had to be distinguishable from one the user typed. This one is
 * written into the editor and run only if the user presses Run, at which point it is a
 * statement they chose to execute and its bound is theirs: a hard bound, honoured, and not
 * paged past. Removing it would instead hand them an unbounded scan they never asked for.
 *
 * The Kafka branch keeps a bound for the same reason, in the read request's own `limit`: 50, the
 * click's and the request's default (#1088).
 *
 * The PromQL branch is the exception, for the tree click's reason: PromQL has no bound to write,
 * so the text is the metric's selector, with the two range forms that widen it written as
 * comments above it (#1085).
 *
 * The etcd branch keeps the click's bound, the command's own `--limit`, and writes its other forms as
 * comments below the read (#1089). `scope` is read by that branch alone: a group's `readRanges`, as
 * for the click, and the connection's `readOnly`, under which it writes the read alone.
 */
export function generateSelectQuery(
  path: readonly string[],
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
  scope?: GeneratorScope,
): string {
  const tableName = objectSegment(path);
  // A query dialect's own text, from its `DIALECT_GENERATORS` record, BEFORE the JSON arm below.
  const dialect = registeredDialect(capabilities);
  if (dialect !== undefined) return DIALECT_GENERATORS[dialect].select(path, columns, scope);
  if (capabilities.queryLanguage === "json") {
    const projection: Record<string, number> = {};
    outermostFieldPaths(columns.map((c) => c.name)).forEach((name) => {
      projection[name] = 1;
    });
    return JSON.stringify(
      {
        ...jsonCommandAddress(path, capabilities),
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
  // PromQL (#1085): exactly ONE runnable expression, the metric's selector on the last line,
  // and the two range forms #1085 section 5.1 teaches as `#` comments above it. PromQL reads
  // `#` as a comment to the end of the line, so the whole buffer, run as it stands, is that one
  // expression. The name reaches its comment through `commentName`, which escapes CR and LF;
  // the selector reaches its comments already escaped, because `metricSelector` writes any name
  // that is not a bare identifier as a JSON-quoted `__name__` matcher. So neither can end a
  // comment line early and turn its remainder into a second expression. The label columns are
  // not read: a label name is server text too, and nothing here needs one. The rate form is
  // written whatever the metric's type, because nothing this function receives says it, so its
  // comment says it is the form for a counter.
  if (capabilities.queryLanguage === "promql") {
    const selector = metricSelector(tableName);
    return [
      `# PromQL for the metric ${commentName(tableName)}. Only the last line runs: a line starting with # is a comment.`,
      "# To try a form below, select it after its # and use Run Selected.",
      "#",
      "# Every raw sample from the last five minutes, one column per series:",
      `#   ${selector}[5m]`,
      "# For a counter: its per-second rate over the last hour, one row a minute:",
      `#   rate(${selector}[5m])[1h:1m]`,
      "#",
      "# Every series of the metric as of now, one row per series:",
      selector,
    ].join("\n");
  }
  // Cypher (Neo4j spec 6.5): the click's read, which keeps its own `LIMIT 100` for the reason the SQL
  // one does below. The columns are not spelled: a node is returned whole, its properties in one cell.
  if (capabilities.queryLanguage === "cypher") {
    return cypherForSegment(tableName) ?? "";
  }
  // InfluxQL (InfluxDB spec 6.6): the click's preview with its example lines as `--` comments, naming a field and
  // a tag from the described columns.
  if (capabilities.queryLanguage === "influxql") return influxqlSelectQuery(path, columns);
  const table = quoteObjectPath(path, capabilities);
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
  // The windowed preview with its example lines below it (InfluxDB spec 6.6, I20).
  const window = capabilities.previewTimeWindow;
  if (window !== undefined) {
    return [windowedPreview(table, window, capabilities), ...windowExamples(table, window, columns, capabilities)].join(
      "\n",
    );
  }
  const cols = columns.map((c) => `  ${quoteIdentifier(c.name, capabilities)}`).join(",\n") || "  *";
  // Oracle
  if (capabilities.defaultPort === 1521) {
    return `SELECT\n${cols}\nFROM ${table}\nWHERE 1=1\nFETCH FIRST 100 ROWS ONLY${terminator(capabilities)}`;
  }
  // MSSQL
  if (capabilities.defaultPort === 1433) {
    return `SELECT TOP 100\n${cols}\nFROM ${table}\nWHERE 1=1;`;
  }
  // A grammar with no constant predicate (CQL, #1410) gets no WHERE clause rather than one it refuses.
  const where = capabilities.supportsConstantPredicate === false ? "" : "\nWHERE 1=1";
  return `SELECT\n${cols}\nFROM ${table}${where}\nLIMIT 100${terminator(capabilities)}`;
}

/** Prepare an editable count statement, without a row limit or any execution (#702). */
export function generateCountQuery(path: readonly string[], capabilities: ProviderCapabilities): string | null {
  if (!offersCountQuery(capabilities)) return null;
  // Refuses an empty address before any dialect spells it, the JSON arm's own check included.
  objectSegment(path);
  if (capabilities.queryLanguage === "json") {
    return JSON.stringify({ ...jsonCommandAddress(path, capabilities), operation: "count", filter: {} }, null, 2);
  }
  // COUNT returns an int on SQL Server; COUNT_BIG preserves billion-row counts.
  const count = capabilities.defaultPort === 1433 ? "COUNT_BIG(*)" : "COUNT(*)";
  return `SELECT ${count} AS row_count\nFROM ${quoteObjectPath(path, capabilities)}${terminator(capabilities)}`;
}

export function shouldRefreshSchema(query: string, schemaRefreshPattern: string): boolean {
  return new RegExp(schemaRefreshPattern, "i").test(query);
}
