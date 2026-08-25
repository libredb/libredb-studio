import type { DatabaseType } from "@/lib/types";

/**
 * The confirmation gate's vocabulary for the engines whose query text is NOT SQL.
 *
 * `isDangerousQuery` reads a statement's SQL keywords, and for `mongodb` and `redis`
 * it had nothing to read: it returned false outright, so a `FLUSHALL`, a `DEL` and a
 * `deleteMany` ran with no confirmation at all while a `DELETE FROM` on any SQL
 * engine asked (S8). The vocabulary lives here rather than in the dialog for the
 * reason every other by-database difference in this repo does: one type-to-facts
 * table, read by one function, so the gate carries no type test of its own.
 *
 * Scope rule, and the reason this file is short: it names ONLY what these two
 * providers can really run. Both were read before the tables below were written -
 * `src/lib/db/providers/keyvalue/redis.ts` and
 * `src/lib/db/providers/document/mongodb.ts` - and neither was probed against a live
 * server in this change, so nothing here is claimed as measured behaviour. What each
 * command or operation DOES is taken from the engines' own command references; what
 * can REACH the engine is taken from the provider code.
 */

/** Whether `value` is a JSON object - not an array, not null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * MongoDB operations whose effect is to remove documents or overwrite fields.
 *
 * Exactly the destructive members of the provider's own `SUPPORTED_OPERATIONS`, in
 * the provider's spelling: `find`, `findOne`, `aggregate`, `count`, `distinct`,
 * `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany` are
 * the whole set it dispatches, and anything else is refused with
 * `Unsupported operation` before a collection is touched. So `drop`,
 * `dropDatabase`, `renameCollection` and the index commands are deliberately absent:
 * they cannot be run from this editor, and a row for them would be a prompt about
 * text that is going to error anyway.
 *
 * The inserts are absent for the same reason the SQL half has no `INSERT`: this gate
 * asks about statements that destroy or change what is already there.
 *
 * `$out` and `$merge` are pipeline STAGES rather than operations, and they are here
 * because `aggregate` hands `query.pipeline` to the driver unchanged: `$out`
 * replaces a whole collection and `$merge` can replace matched documents, which
 * makes an `aggregate` the one read-shaped operation that can destroy data. The
 * reader below only looks at TOP-LEVEL stages - neither stage is legal inside a
 * `$lookup` or `$facet` sub-pipeline.
 */
const MONGODB_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
  "deleteOne",
  "deleteMany",
  "updateOne",
  "updateMany",
  "$out",
  "$merge",
]);

/**
 * Redis commands whose effect is to remove a key or member, replace an existing
 * value or part of one, schedule a key's deletion, overwrite a destination key, move
 * a hash slot away from the node that holds its keys, or change who may reach the
 * server.
 *
 * The bar for a name being here is that the NAME decides it: every spelling of the
 * command does the destructive thing, so reading the first token (and, for a
 * container, the second) is enough. `SETBIT` is in for the reason `SETRANGE` is - it
 * overwrites part of a string that is already there - and `XGROUP DELCONSUMER` for
 * the reason `XGROUP DESTROY` is: it drops a consumer together with its pending
 * entries. `CLUSTER SETSLOT` has no reading form at all (`CLUSTER SLOTS` and
 * `CLUSTER SHARDS` are the reads); every form of it reassigns a slot, which is what
 * puts it beside `CLUSTER RESET` and `CLUSTER FORGET`.
 *
 * Every name here can reach the server: `runCommand` calls
 * `client.call(command, ...args)` with no allow-list of any kind, so the vocabulary
 * is bounded by what Redis accepts rather than by what this provider implements.
 * Container commands are spelled with their subcommand (`CONFIG SET`), which the
 * reader below looks up as a second name, because the container itself is not
 * destructive - prompting on `CONFIG GET`, an everyday read, is the false alarm this
 * gate cannot afford.
 *
 * Not covered, said plainly rather than left to be discovered:
 * - `INCR`/`INCRBY`/`DECR`/`APPEND` and their hash and float variants. They change a
 *   value by adding to it rather than replacing or removing it, and they are the
 *   commands a counter dashboard runs constantly.
 * - The `STORE` option of `SORT`, `GEORADIUS`, `GEORADIUSBYMEMBER` and the
 *   `SET`/`INCRBY` sub-operations of `BITFIELD`. Each sits at an argument position
 *   this two-name reading does not reach, and the command without the option is a
 *   plain read.
 * - `GETEX`, for exactly that reason. `GETEX key` is byte-for-byte a `GET`; it
 *   touches the key only when `EX`, `PX`, `EXAT`, `PXAT` or `PERSIST` follows the
 *   key name, and the second token this reader inspects is the key, never the
 *   option. It was in the set on its first writing, which would have prompted on
 *   every plain read spelled that way.
 * - What a Lua script or a function does. `EVAL`, `EVALSHA` and `FCALL` are IN the
 *   set instead, because the body is an argument and nothing here reads it; the
 *   declared read-only spellings (`EVAL_RO`, `EVALSHA_RO`, `FCALL_RO`) are out.
 */
const REDIS_DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  // Keys
  "DEL",
  "UNLINK",
  "FLUSHALL",
  "FLUSHDB",
  "RENAME",
  "RENAMENX",
  "MOVE",
  "COPY",
  "SWAPDB",
  "MIGRATE",
  "RESTORE",
  // Expiry - a key with a TTL is a key that will be gone
  "EXPIRE",
  "PEXPIRE",
  "EXPIREAT",
  "PEXPIREAT",
  // Strings
  "SET",
  "SETEX",
  "PSETEX",
  "MSET",
  "GETSET",
  "GETDEL",
  "SETRANGE",
  "SETBIT",
  "BITOP",
  // Hashes
  "HSET",
  "HMSET",
  "HDEL",
  // Lists
  "LPOP",
  "RPOP",
  "LMPOP",
  "BLPOP",
  "BRPOP",
  "BLMPOP",
  "LSET",
  "LREM",
  "LTRIM",
  "LMOVE",
  "BLMOVE",
  "RPOPLPUSH",
  "BRPOPLPUSH",
  // Sets
  "SPOP",
  "SREM",
  "SMOVE",
  "SINTERSTORE",
  "SUNIONSTORE",
  "SDIFFSTORE",
  // Sorted sets
  "ZREM",
  "ZREMRANGEBYSCORE",
  "ZREMRANGEBYRANK",
  "ZREMRANGEBYLEX",
  "ZPOPMIN",
  "ZPOPMAX",
  "BZPOPMIN",
  "BZPOPMAX",
  "ZMPOP",
  "BZMPOP",
  "ZUNIONSTORE",
  "ZINTERSTORE",
  "ZDIFFSTORE",
  "ZRANGESTORE",
  // Streams
  "XDEL",
  "XTRIM",
  "XGROUP DESTROY",
  "XGROUP DELCONSUMER",
  // Scripts and functions
  "EVAL",
  "EVALSHA",
  "FCALL",
  "SCRIPT FLUSH",
  "FUNCTION FLUSH",
  "FUNCTION DELETE",
  "FUNCTION RESTORE",
  // Server, replication and access
  "SHUTDOWN",
  "CONFIG SET",
  "ACL SETUSER",
  "ACL DELUSER",
  "ACL LOAD",
  "CLIENT KILL",
  "REPLICAOF",
  "SLAVEOF",
  "FAILOVER",
  "CLUSTER RESET",
  "CLUSTER FORGET",
  "CLUSTER SETSLOT",
]);

/**
 * The names a query would run, or `undefined` when the text cannot be read as one.
 *
 * `undefined` is not "nothing to run": it means the reader could not tell WHAT would
 * run, and the gate turns it into a prompt.
 */
type OperationReader = (query: string) => readonly string[] | undefined;

interface DestructiveVocabulary {
  /** The names that ask for a confirmation. */
  readonly operations: ReadonlySet<string>;
  /** How this engine's query text names the operations it would run. */
  readonly read: OperationReader;
}

/**
 * The top-level stage names of an aggregate pipeline, as far as they can be read.
 *
 * A pipeline that is not an array, or a stage that is not an object, names nothing:
 * the driver rejects both, so there is no operation to ask about.
 */
function pipelineStageNames(pipeline: unknown): string[] {
  if (!Array.isArray(pipeline)) return [];
  return pipeline.filter(isJsonObject).flatMap((stage) => Object.keys(stage));
}

/**
 * What a MongoDB payload would run.
 *
 * The shape is the provider's own: one JSON document with `collection` and
 * `operation`, dispatched on `operation` case-sensitively (so `DELETEMANY` is refused
 * rather than run, and matching it here would only prompt about text that errors).
 * Documented the same way in docs/providers/mongodb.md.
 *
 * Anything that does not parse as JSON, or parses as something other than a document
 * with a string `operation`, is UNREADABLE rather than safe - mongosh syntax
 * (`db.users.deleteMany({})`), a half-typed document, an array. The provider refuses
 * all of it, so the cost of asking is one click on text that was not going to run;
 * the cost of the other answer is the silence this whole file exists to remove. The
 * one exception is text with nothing in it: an empty editor is not a command, and
 * both callers hand this predicate the buffer as it stands, so treating blank text as
 * unreadable would prompt on every execute of an empty tab.
 */
const readMongodbOperations: OperationReader = (query) => {
  const text = query.trim();
  if (text === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;

  const operation = parsed.operation;
  if (typeof operation !== "string") return undefined;

  // Only an aggregate can carry a writing stage; every other operation's effect is
  // its own name.
  return operation === "aggregate" ? [operation, ...pipelineStageNames(parsed.pipeline)] : [operation];
};

/**
 * The ONE command a Redis buffer would run, reduced the way `commandBody` reduces it:
 * `#` comment lines dropped, then the first blank-line-delimited block. The
 * schema explorer's "Generate Command" output is a list of alternatives separated by
 * blank lines and only its first block runs, so reading the whole buffer would prompt
 * about commands nobody asked for.
 *
 * The provider also tracks open quotes across lines, so that a line-leading `#`
 * inside a quoted argument stays data. That is deliberately not modelled here,
 * because it cannot change the answer: a quote can only be opened on an earlier line,
 * and the command NAME is on the block's first line, which no quote precedes.
 */
function redisCommandBody(query: string): string {
  const block: string[] = [];
  for (const raw of query.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    if (line === "") {
      // A blank line ends the first block; blank lines before it are padding.
      if (block.length > 0) break;
      continue;
    }
    block.push(raw);
  }
  return block.join("\n").trim();
}

/**
 * One token as the plain tokenizer would produce it: quote characters are structure
 * to that parser, not part of the argument, and both parsers uppercase the command
 * before calling it - so `del`, `DEL` and `"DEL"` are the same command.
 */
function redisToken(raw: string): string {
  return raw.replaceAll('"', "").replaceAll("'", "").toUpperCase();
}

/** The command name plus, when there is a second token, the container spelling. */
function redisNames(command: string, next: string | undefined): string[] {
  const name = redisToken(command);
  return next === undefined ? [name] : [name, `${name} ${redisToken(next)}`];
}

/**
 * What a Redis buffer would run.
 *
 * Both of the provider's two query forms are read here, because both execute: the
 * JSON form `{"command": "DEL", "args": ["k"]}` - which is also what the
 * MongoDB-shaped generator emits - and the plain form `DEL k`. A body that starts
 * with `{` takes the JSON path in the provider too, so a broken JSON body never
 * falls back to the plain reading; it is unreadable, and unreadable asks.
 */
const readRedisOperations: OperationReader = (query) => {
  const body = redisCommandBody(query);
  if (body === "") return [];

  if (body.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!isJsonObject(parsed)) return undefined;
    const command = parsed.command;
    if (typeof command !== "string") return undefined;
    const args = parsed.args;
    const first = Array.isArray(args) ? args[0] : undefined;
    return redisNames(command, typeof first === "string" ? first : undefined);
  }

  const tokens = body.split(/\s+/);
  return redisNames(tokens[0], tokens[1]);
};

/**
 * The single type-to-facts table. A type with no row here is one whose statements the
 * SQL half of the gate reads; a row would be a second, weaker opinion about the same
 * text.
 */
export const NON_SQL_DESTRUCTIVE_VOCABULARY: Readonly<Partial<Record<DatabaseType, DestructiveVocabulary>>> = {
  mongodb: { operations: MONGODB_DESTRUCTIVE_OPERATIONS, read: readMongodbOperations },
  redis: { operations: REDIS_DESTRUCTIVE_COMMANDS, read: readRedisOperations },
};

/**
 * Whether this query, on a type whose text is not SQL, asks for a confirmation.
 *
 * False for every type with no row - including no type at all, which is the reading a
 * caller without a connection gets and the one the SQL half already covers.
 */
export function isDestructiveNonSqlQuery(query: string, databaseType?: DatabaseType): boolean {
  const facts = databaseType === undefined ? undefined : NON_SQL_DESTRUCTIVE_VOCABULARY[databaseType];
  if (facts === undefined) return false;

  const named = facts.read(query);
  if (named === undefined) return true;
  return named.some((name) => facts.operations.has(name));
}
