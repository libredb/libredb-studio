/**
 * The agent's reader of one Redis command: what the agent read-only profile sends, read before anything is sent.
 *
 * Pure, and safe in a browser bundle. It reads one line into the exact argv the provider sends, against a closed
 * table of metadata reads, and refuses everything else with a sentence that quotes nothing the request wrote. The
 * table's rule, which `tests/unit/db/redis/agent-command-table.test.ts` holds against the `COMMAND INFO` answers in
 * tests/fixtures/redis/<version>/agent-boundary/command-info.json: every entry is flagged `readonly`, none is flagged
 * `write`, `admin`, `pubsub`, `may_replicate` or `script_runner`, none is in the `@write`, `@admin`, `@dangerous`,
 * `@scripting` or `@pubsub` category, and every key it names has a read-only (RO) key spec.
 *
 * Metadata only. Key names count as stored values, since applications put ids, emails and tokens in them, so nothing
 * here lists keys (no `SCAN`, `KEYS` or `RANDOMKEY`) or reads a value, a hash field, a set or sorted-set member or a
 * stream entry. What an agent may read is the connection's database's key count and, for one key its own request
 * names, that key's type, existence, time to live, length, encoding and memory use. `INFO` is not in the table: its
 * `COMMAND INFO` carries no `readonly` flag and puts it in `@dangerous`.
 *
 * The grammar is a strict subset of redis-cli's: one line, no control character anywhere, words separated by spaces,
 * and a word either bare (no quote and no backslash) or wrapped in double quotes with `\"` and `\\` as its only
 * escapes. So a second command, an inline `MULTI`, a CRLF and a comment are refused, never read.
 *
 * Not the boundary. The boundary is this table, which the provider sends nothing outside of, and the ACL user the
 * server must refuse the proof's write probes on the command's own connection before every command (`redis-read-only-proof.ts`); this is
 * what lets the model read why it was refused, before anything is sent.
 */

export type RedisAgentRefusalCode = "request" | "metadata-only" | "arguments";

/** The metadata operations, each one row of the table and one projection of the answer. */
export type RedisAgentOperation =
  | "DBSIZE"
  | "TYPE"
  | "EXISTS"
  | "TTL"
  | "PTTL"
  | "STRLEN"
  | "LLEN"
  | "HLEN"
  | "SCARD"
  | "ZCARD"
  | "XLEN"
  | "OBJECT ENCODING"
  | "MEMORY USAGE";

/** One read the agent may send: its operation and the exact argv, command word first. */
export interface RedisAgentPlan {
  readonly op: RedisAgentOperation;
  readonly argv: readonly string[];
}

export type RedisAgentReading =
  | { readonly ok: true; readonly plan: RedisAgentPlan }
  | { readonly ok: false; readonly code: RedisAgentRefusalCode; readonly message: string };

/** What one table entry takes after its command words: no argument, or the one key the request names. */
interface RedisAgentCommand {
  /** The name `COMMAND INFO` knows the command by, `parent|sub` for a subcommand. */
  readonly info: string;
  readonly takesKey: boolean;
}

/**
 * The closed table. Each key is the operation, written as the command words a request starts with, uppercase.
 * Exported for the walk test, which reads every entry against the server's own `COMMAND INFO`.
 */
export const REDIS_AGENT_COMMANDS: Readonly<Record<RedisAgentOperation, RedisAgentCommand>> = Object.freeze({
  DBSIZE: { info: "dbsize", takesKey: false },
  TYPE: { info: "type", takesKey: true },
  EXISTS: { info: "exists", takesKey: true },
  TTL: { info: "ttl", takesKey: true },
  PTTL: { info: "pttl", takesKey: true },
  STRLEN: { info: "strlen", takesKey: true },
  LLEN: { info: "llen", takesKey: true },
  HLEN: { info: "hlen", takesKey: true },
  SCARD: { info: "scard", takesKey: true },
  ZCARD: { info: "zcard", takesKey: true },
  XLEN: { info: "xlen", takesKey: true },
  "OBJECT ENCODING": { info: "object|encoding", takesKey: true },
  "MEMORY USAGE": { info: "memory|usage", takesKey: true },
});

/** The commands that take a subcommand word, and the one subcommand of each the table holds. */
const PARENTS: Readonly<Record<string, string>> = Object.freeze({ OBJECT: "ENCODING", MEMORY: "USAGE" });

/** The longest key a request may name, in characters. */
export const REDIS_AGENT_MAX_KEY_CHARS = 1024;

/** The most nested values `MEMORY USAGE` may sample; 0, which samples every one, is refused. */
export const REDIS_AGENT_MAX_SAMPLES = 5;

const NOTHING_SENT = "Nothing was sent.";

const AGENT_READS =
  "Agent mode on Redis reads metadata only: DBSIZE, and for one key the request names TYPE, EXISTS, TTL, PTTL, STRLEN, LLEN, HLEN, SCARD, ZCARD, XLEN, OBJECT ENCODING and MEMORY USAGE (with SAMPLES 1 to 5).";

export const REDIS_AGENT_SENTENCES = {
  empty: `The request holds no command. ${AGENT_READS} ${NOTHING_SENT}`,
  control: `An agent command is one line with no control character: no line break, carriage return or tab, so one request is one command. ${NOTHING_SENT}`,
  quoting: `An agent command's words are separated by spaces, and a word is bare, with no quote or backslash, or wrapped in double quotes with \\" and \\\\ as its only escapes. ${NOTHING_SENT}`,
  metadataOnly: `That is not one of agent mode's reads: key names and stored values are withheld, so nothing that lists keys or reads a value, field or member is sent. ${AGENT_READS} ${NOTHING_SENT}`,
  /** `op` is a table entry, never request text. */
  arguments: (op: RedisAgentOperation): string =>
    REDIS_AGENT_COMMANDS[op].takesKey
      ? `${op} takes exactly one key${op === "MEMORY USAGE" ? `, optionally followed by SAMPLES and a count from 1 to ${REDIS_AGENT_MAX_SAMPLES}` : ""}, a non-empty name of at most ${REDIS_AGENT_MAX_KEY_CHARS} characters. ${NOTHING_SENT}`
      : `${op} takes no argument. ${NOTHING_SENT}`,
} as const;

function refuse(code: RedisAgentRefusalCode, message: string): RedisAgentReading {
  return { ok: false, code, message };
}

/** Whether `text` holds a control character (C0, DEL or C1) or a line or paragraph separator. */
function holdsControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** The words of one line, or null when a word breaks the grammar. */
function words(line: string): string[] | null {
  const out: string[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") {
      index += 1;
      continue;
    }
    if (line[index] === '"') {
      let word = "";
      index += 1;
      for (;;) {
        if (index >= line.length) return null;
        const ch = line[index];
        if (ch === '"') break;
        if (ch === "\\") {
          const next = line[index + 1];
          if (next !== '"' && next !== "\\") return null;
          word += next;
          index += 2;
          continue;
        }
        word += ch;
        index += 1;
      }
      index += 1;
      if (index < line.length && line[index] !== " ") return null;
      out.push(word);
      continue;
    }
    let word = "";
    while (index < line.length && line[index] !== " ") {
      const ch = line[index];
      if (ch === '"' || ch === "'" || ch === "\\") return null;
      word += ch;
      index += 1;
    }
    out.push(word);
  }
  return out;
}

function isKey(word: string | undefined): word is string {
  return word !== undefined && word.length > 0 && word.length <= REDIS_AGENT_MAX_KEY_CHARS;
}

/** The operation a request's first words name, or undefined when the table holds none. */
function operationOf(argv: readonly string[]): RedisAgentOperation | undefined {
  const first = argv[0].toUpperCase();
  if (Object.hasOwn(PARENTS, first)) {
    const sub = PARENTS[first];
    return argv[1]?.toUpperCase() === sub ? (`${first} ${sub}` as RedisAgentOperation) : undefined;
  }
  return Object.hasOwn(REDIS_AGENT_COMMANDS, first) && !first.includes(" ")
    ? (first as RedisAgentOperation)
    : undefined;
}

/** One agent command read to the argv the provider sends, or to why it sends nothing. Never sends anything. */
export function readRedisAgentStatement(text: string): RedisAgentReading {
  const line = text.trim();
  if (line === "") return refuse("request", REDIS_AGENT_SENTENCES.empty);
  if (holdsControl(line)) return refuse("request", REDIS_AGENT_SENTENCES.control);
  const argv = words(line);
  if (argv === null) return refuse("request", REDIS_AGENT_SENTENCES.quoting);
  const op = operationOf(argv);
  if (op === undefined) return refuse("metadata-only", REDIS_AGENT_SENTENCES.metadataOnly);
  const head = op.split(" ");
  const rest = argv.slice(head.length);
  if (!REDIS_AGENT_COMMANDS[op].takesKey) {
    return rest.length === 0
      ? { ok: true, plan: { op, argv: head } }
      : refuse("arguments", REDIS_AGENT_SENTENCES.arguments(op));
  }
  const [key, ...options] = rest;
  if (!isKey(key)) return refuse("arguments", REDIS_AGENT_SENTENCES.arguments(op));
  if (options.length === 0) return { ok: true, plan: { op, argv: [...head, key] } };
  if (
    op === "MEMORY USAGE" &&
    options.length === 2 &&
    options[0].toUpperCase() === "SAMPLES" &&
    /^[1-9]$/.test(options[1]) &&
    Number(options[1]) <= REDIS_AGENT_MAX_SAMPLES
  ) {
    return { ok: true, plan: { op, argv: [...head, key, "SAMPLES", options[1]] } };
  }
  return refuse("arguments", REDIS_AGENT_SENTENCES.arguments(op));
}
