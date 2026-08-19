import type * as Monaco from "monaco-editor";

/**
 * Monaco language for the Redis command grammar.
 *
 * Redis commands are neither SQL nor MongoDB JSON, so reusing the `json`
 * language mis-highlights them and flags every command as invalid JSON — the
 * visible half of #427, where a Redis tab was typed `mongodb`. This registers a
 * minimal language whose tokens map onto the editor's shared `db-dark` theme:
 * command verbs as keywords, argument keywords (`MATCH`, `COUNT`,
 * `WITHSCORES`) as functions, `#` line comments (matching the cheatsheet the
 * generators emit and the provider's line skipper), quoted strings and numbers.
 * Everything else — keys and key patterns like `user:*` — reads as a plain
 * identifier.
 */
const REDIS_LANGUAGE_ID = "redis";

/**
 * Command verbs. `KEYS` is highlighted but never generated: the provider's
 * SCAN-never-KEYS rule stands, and a user who types it should still see it
 * tokenized.
 */
const REDIS_KEYWORDS = [
  "SCAN",
  "TYPE",
  "GET",
  "SET",
  "SETEX",
  "DEL",
  "EXISTS",
  "TTL",
  "EXPIRE",
  "PERSIST",
  "RENAME",
  "INCR",
  "DECR",
  "MGET",
  "MSET",
  "HGETALL",
  "HGET",
  "HSET",
  "HDEL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "LRANGE",
  "LLEN",
  "LPUSH",
  "RPUSH",
  "LPOP",
  "RPOP",
  "SMEMBERS",
  "SADD",
  "SREM",
  "SCARD",
  "SISMEMBER",
  "ZRANGE",
  "ZREVRANGE",
  "ZADD",
  "ZREM",
  "ZCARD",
  "ZSCORE",
  "ZRANGEBYSCORE",
  "INFO",
  "DBSIZE",
  "PING",
  "MEMORY",
  "CLIENT",
  "SLOWLOG",
  "CONFIG",
  "COMMAND",
  "KEYS",
  "RANDOMKEY",
  "OBJECT",
];

/**
 * Argument keywords, tokenized separately so `MATCH user:* COUNT 50` reads as
 * verb + modifier + data. Words that are also verbs (`GET`, `SET`, `TYPE`) are
 * deliberately absent: a cases map has one entry per word, so a collision would
 * silently pick one class — keeping the lists disjoint is the simpler fix.
 */
const REDIS_MODIFIERS = [
  "MATCH",
  "COUNT",
  "WITHSCORES",
  "LIMIT",
  "EX",
  "PX",
  "NX",
  "XX",
  "ASC",
  "DESC",
  "BYSCORE",
  "REV",
  "STORE",
];

/**
 * Register the Redis language on a Monaco instance. Idempotent — safe to call
 * on every editor mount; it no-ops once the language is already registered.
 */
export function registerRedisLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((lang) => lang.id === REDIS_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: REDIS_LANGUAGE_ID });

  monaco.languages.setMonarchTokensProvider(REDIS_LANGUAGE_ID, {
    ignoreCase: true,
    keywords: REDIS_KEYWORDS,
    modifiers: REDIS_MODIFIERS,
    tokenizer: {
      // Monarch tries these in order and takes the first match at the current
      // position. Every rule here starts on a disjoint character — `#`, `"`, `'`,
      // digit-or-`-`, letter-or-`_`, `*`-or-`:` — so at most one can match and the
      // order is documentation rather than precedence. Keep it that way: a rule
      // whose opening character overlaps another's makes this list order-sensitive
      // in a way nothing on the screen would announce. `tests/unit/editor/
      // redis-language.test.ts` asserts the disjointness.
      root: [
        // A line is a comment only when it STARTS with `#` (after whitespace),
        // matching the provider's line skipper — `#` inside a key or value
        // stays data (#427).
        [/^\s*#.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        // SCAN's cursor `0`, COUNT's `50` and the `0 -1` range of LRANGE/ZRANGE
        // read as numbers rather than falling through to the editor's default
        // token. Not "before the identifier rule": the identifier rule below
        // cannot start on a digit or `-`, so these two never compete.
        [/-?\b\d+(\.\d+)?\b/, "number"],
        // A key or key pattern (`user:*`, `session:abc:data`) is ONE identifier
        // token: letter/underscore start, then word chars and key punctuation.
        [
          /[a-zA-Z_][\w:.*/-]*/,
          { cases: { "@keywords": "keyword", "@modifiers": "function", "@default": "identifier" } },
        ],
        // A pattern that starts with punctuation (`*`, `:*`) still reads as data.
        [/[*:][\w:.*/-]*/, "identifier"],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(REDIS_LANGUAGE_ID, {
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
    ],
  });
}
