import { type DestructiveVocabulary, isJsonObject, type OperationReader } from "@/lib/db/destructive-vocabulary";
import { readRedisCommandText, redisRefusal } from "@/lib/db/providers/keyvalue/redis-command-text";

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
 * Every name here is a command the provider runs: `query()` refuses some commands
 * before they reach the server (`sharedConnectionRefusal` in
 * `src/lib/db/providers/keyvalue/redis.ts`, documented in section 5.2b of
 * `docs/providers/redis.md`), and a confirmation followed by that refusal would be
 * the double take this gate exists to avoid. The blocking list and sorted-set pops
 * (`BLPOP`, `BZPOPMIN` and the rest of the `B` forms) are refused that way, so only their
 * non-blocking forms (`LPOP`, `RPOP`, `LMPOP`, `LMOVE`, `RPOPLPUSH`, `ZPOPMIN`,
 * `ZPOPMAX`, `ZMPOP`) are here. `runCommand` itself calls
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
  "LSET",
  "LREM",
  "LTRIM",
  "LMOVE",
  "RPOPLPUSH",
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
  "ZMPOP",
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
 *
 * The text is read by the provider's own `readRedisCommandText()`, so the command
 * this names is the one that runs: each line is a command, `#` lines are dropped,
 * and the first blank line ends the read, which keeps the schema explorer's
 * cheatsheet of blank-line-separated alternatives from prompting about commands
 * nobody asked for. A text holding a second command names nothing, the way etcd's
 * refused text does: the row's `refuse` stops it in the editor before anything is
 * sent, and the provider refuses it too, so a prompt would ask about a command that
 * cannot run.
 */
const readRedisOperations: OperationReader = (query) => {
  const read = readRedisCommandText(query);
  if (read.kind === "empty" || read.kind === "refused") return [];

  if (read.kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body);
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

  return redisNames(read.words[0], read.words[1]);
};

/**
 * Redis's row of the confirmation gate's vocabulary.
 *
 * Each line of the text is one command (docs/providers/redis.md 3.4a), and a second command is refused in the editor
 * with the provider's own reading, before anything is sent, rather than run as one merged command.
 */
export const REDIS_DESTRUCTIVE_VOCABULARY: DestructiveVocabulary = {
  operations: REDIS_DESTRUCTIVE_COMMANDS,
  read: readRedisOperations,
  decidesAlone: false,
  refuse: redisRefusal,
};
