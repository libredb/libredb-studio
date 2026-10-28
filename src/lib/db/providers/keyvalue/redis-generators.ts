/**
 * The Redis dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the shared generator pieces.
 */
import { commentName, escapeGlob, objectSegment, prefixGroup } from "@/lib/db/query-generators/shared";
import type { DialectGenerators } from "@/lib/db/query-generators/types";
import type { ColumnSchema } from "@/lib/types";

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
 * Redis speaks its own command grammar, and it silently got MongoDB documents its driver answered with HTTP 400 before
 * it had a record (#427). A prefix group is not addressable (`tablesAreDerivedGroupings`), so it always SCANs; a bare
 * key gets the reader its sampled type calls for, or `TYPE` when unknown. A key the key browser names
 * (`scope.namesKey`) is a key whatever its name ends in, so `cache:*` reads the key and scans nothing.
 */
export const REDIS_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path, columns, scope) => {
    const name = objectSegment(path);
    const { isPrefixGroup, base } = prefixGroup(name);
    if (isPrefixGroup && scope?.namesKey !== true) return redisScan(base);
    const keyType = redisKeyType(columns);
    return renderRedisCommand(keyType ? REDIS_COMMANDS[keyType].read(name) : ["TYPE", name]);
  },
  select: (path, columns) => redisCheatsheet(objectSegment(path), columns),
});
