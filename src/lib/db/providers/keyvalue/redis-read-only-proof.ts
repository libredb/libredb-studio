/**
 * The Redis agent read-only proof, from the answers in tests/fixtures/redis/<version>/agent-boundary/: when the agent
 * read-only profile opens, and again before every agent command on that command's own connection, the server is asked
 * what it is and is sent write probes that change nothing even when admitted, and its answers decide. Nothing is kept
 * between two proofs, so a write granted since the last command is caught at the next one (`midrun.json`).
 *
 * - **An ACL user of the agent's own.** A connection that names no user signs in as `default`, which a stock server
 *   leaves `on nopass ~* &* +@all` (`default-nopass.json`, every probe admitted), and `default` is refused by name
 *   whatever its rules, since every client that names no user is it. Both are refused before anything is sent.
 * - **A server Studio has measured.** `HELLO 2`, which a `+@read` user may send (`reader.json`), must answer exactly
 *   the fields both measured servers answer, in their order, name `redis` or `valkey`, and the `standalone` mode. A
 *   Valkey with `extended-redis-compatibility` on names itself `redis` (`identity-compatibility.json`), and is the
 *   server measured either way. A cluster, and a relative that names itself anything else or adds a field of its own
 *   (Dragonfly answers `redis` and `standalone` but adds `dfly_version`), are refused until measured. A relative whose
 *   `HELLO` copies the measured one exactly is not told apart here: it is held to the probes below, word for word.
 * - **Every probe refused as a command the user does not hold.** `REDIS_PROOF_PROBES` are one no-op write per write
 *   family the measured users reach, and one each from the admin, dangerous, scripting and pubsub categories, against a
 *   key, channel, parameter, library and script that do not exist: admitted, each changes nothing (`full.json`, the
 *   state before and after), and the pubsub probe is `SPUBLISH`, which only a subscriber of that one shard channel
 *   would hear. Each must be refused with the server's command refusal naming this user and the probe's own command,
 *   word for word as both servers send it (`reader.json`). The ACL checks the command before the key, so that refusal
 *   says the user does not hold the command at all, whatever key it names. A user that holds the command and is
 *   refused only because the probe's key or channel is outside its patterns is refused the profile: `~app:* +@write`
 *   deletes `app:` keys (`scoped-writer.json`, `scoped-writer-in-pattern.json`), and `%R~*` and `resetchannels`
 *   users meet the same refusal (`read-keys.json`, `channel-scoped.json`). `+@read +del` and `+@read +set` are
 *   admitted their one probe (`read-del.json`, `read-set.json`). Any other answer refuses the profile: a reply says
 *   the user may write, and any other error, whether the error of an admitted probe, a renamed command, a replica's
 *   `READONLY` or another server's wording, proves nothing.
 *
 * The probes cannot name every write: a user granted one the list leaves out passes. The closed command table
 * (`redis-agent-statement.ts`) stays the boundary on top of the proof, never instead of it, so no write is sent either
 * way.
 */
import { randomUUID } from "node:crypto";
import { ExecutionProfileError } from "@/lib/db/errors";

/** One command's answer in a round trip: the reply, or the server's error line. */
export type RedisReply =
  | { readonly ok: true; readonly reply: unknown }
  | { readonly ok: false; readonly error: string };

/** Sends `commands` in one round trip on one connection and answers each, in order. */
export type RedisRoundTrip = (commands: readonly (readonly string[])[]) => Promise<readonly RedisReply[]>;

/** One probe: the words a refusal names it by, the argv it sends, and the name the server's ACL refusal gives it. */
export interface RedisProofProbe {
  readonly label: string;
  readonly argv: readonly string[];
  readonly aclCommand: string;
}

/** The probes, built around names that exist nowhere: `nonce` is fresh for every proof. */
export function redisProofProbes(nonce: string): readonly RedisProofProbe[] {
  const key = `libredb-agent-probe:${nonce}`;
  const sha = nonce
    .replace(/[^0-9a-f]/g, "")
    .padEnd(40, "0")
    .slice(0, 40);
  return [
    { label: "DEL", argv: ["DEL", key], aclCommand: "del" },
    { label: "UNLINK", argv: ["UNLINK", key], aclCommand: "unlink" },
    { label: "SET", argv: ["SET", key, "x", "XX"], aclCommand: "set" },
    { label: "EXPIRE", argv: ["EXPIRE", key, "1"], aclCommand: "expire" },
    { label: "HDEL", argv: ["HDEL", key, "f"], aclCommand: "hdel" },
    { label: "LREM", argv: ["LREM", key, "0", "x"], aclCommand: "lrem" },
    { label: "SREM", argv: ["SREM", key, "x"], aclCommand: "srem" },
    { label: "ZREM", argv: ["ZREM", key, "x"], aclCommand: "zrem" },
    { label: "XDEL", argv: ["XDEL", key, "0-1"], aclCommand: "xdel" },
    { label: "MOVE", argv: ["MOVE", key, "1"], aclCommand: "move" },
    { label: "RESTORE", argv: ["RESTORE", key, "0", "not-a-dump-payload"], aclCommand: "restore" },
    { label: "CONFIG SET", argv: ["CONFIG", "SET", `libredb-agent-probe-${nonce}`, "x"], aclCommand: "config|set" },
    { label: "EVALSHA", argv: ["EVALSHA", sha, "0"], aclCommand: "evalsha" },
    {
      label: "FUNCTION DELETE",
      argv: ["FUNCTION", "DELETE", `libredb_agent_probe_${nonce.replace(/-/g, "_")}`],
      aclCommand: "function|delete",
    },
    { label: "SPUBLISH", argv: ["SPUBLISH", key, "x"], aclCommand: "spublish" },
  ];
}

const HELLO: readonly string[] = ["HELLO", "2"];

/** The servers whose ACL answers are on record. */
const MEASURED_SERVERS: ReadonlySet<string> = new Set(["redis", "valkey"]);

/**
 * The fields of `HELLO 2`, in order, as Redis 8.10.2 and Valkey 9.1.2 answer it (`identity.json`, and Valkey's
 * `identity-compatibility.json`). A relative that adds a field of its own, as Dragonfly's `dfly_version`, is not one
 * of them.
 */
const MEASURED_HELLO_FIELDS = "server version proto id mode role modules";

/** The two refusals a write command the user holds meets on a key or channel its patterns leave out. */
const PATTERN_REFUSALS: ReadonlySet<string> = new Set([
  "NOPERM No permissions to access a key",
  "NOPERM No permissions to access a channel",
]);

const NOTHING_SENT = "No agent command was sent.";
const GIVE_A_READER =
  "Give the agent an ACL user of its own whose rules grant reads only, for example on, a password, ~* and +@read.";

export const REDIS_PROOF_SENTENCES = {
  noUser: `The agent read-only profile needs Redis to prove the agent's ACL user reads only, and this connection names no user, so it would sign in as default, which a stock server lets do anything. ${GIVE_A_READER} ${NOTHING_SENT}`,
  defaultUser: `The agent read-only profile refuses Redis's default user, which every client that names no user signs in as. ${GIVE_A_READER} ${NOTHING_SENT}`,
  notMeasured: `This server's HELLO names it neither Redis nor Valkey in standalone mode, the servers whose ACL answers Studio has measured, so the agent's user is not proved read-only and is refused. ${NOTHING_SENT}`,
  /** `label` is one of the proof's own probes, never user text. */
  admitted: (label: string): string =>
    `This Redis user may run ${label}, which the read-only proof sends against a key that does not exist and the user must be refused NOPERM, so the user may change the server. ${GIVE_A_READER} ${NOTHING_SENT}`,
  /** `label` is one of the proof's own probes, never user text. */
  patternScoped: (label: string): string =>
    `This Redis user may run ${label} and was refused it only by its key or channel permissions, so it may change what its own patterns allow. ${GIVE_A_READER} ${NOTHING_SENT}`,
  /** `label` is HELLO or one of the proof's own probes, never user text. */
  unread: (label: string): string =>
    `Redis answered ${label} with something other than the NOPERM refusal the read-only proof needs, so the user may run it or the proof cannot tell, and the agent's user is not proved read-only and is refused. ${NOTHING_SENT}`,
} as const;

/** The ACL user the agent signs in as, or the refusal of one that cannot be proved: raised before anything is sent. */
export function redisAgentUser(user: string | undefined): string {
  if (user === undefined || user === "") {
    throw new ExecutionProfileError(REDIS_PROOF_SENTENCES.noUser, "PROFILE_SERVER_UNENFORCED");
  }
  if (user === "default")
    throw new ExecutionProfileError(REDIS_PROOF_SENTENCES.defaultUser, "PROFILE_PRIVILEGES_TOO_BROAD");
  return user;
}

function unread(label: string): ExecutionProfileError {
  return new ExecutionProfileError(REDIS_PROOF_SENTENCES.unread(label), "PROFILE_UNSUPPORTED_TARGET");
}

/** `HELLO 2`'s flat answer read as its fields in order, or undefined when it is not a flat list of named fields. */
function helloFields(reply: unknown): ReadonlyMap<string, unknown> | undefined {
  if (!Array.isArray(reply) || reply.length % 2 !== 0) return undefined;
  const fields = new Map<string, unknown>();
  for (let index = 0; index < reply.length; index += 2) {
    const name: unknown = reply[index];
    if (typeof name !== "string") return undefined;
    fields.set(name, reply[index + 1]);
  }
  return fields;
}

/** Whether `fields` is the measured `HELLO 2` of a standalone Redis or Valkey. */
function isMeasuredServer(fields: ReadonlyMap<string, unknown>): boolean {
  const server = fields.get("server");
  return (
    [...fields.keys()].join(" ") === MEASURED_HELLO_FIELDS &&
    typeof server === "string" &&
    MEASURED_SERVERS.has(server) &&
    fields.get("mode") === "standalone"
  );
}

/** The refusal of a user that does not hold `probe`'s command, word for word as both measured servers send it. */
function commandRefusal(user: string, probe: RedisProofProbe): string {
  return `NOPERM User ${user} has no permissions to run the '${probe.aclCommand}' command`;
}

/**
 * Proves `user`, the connection's ACL user, reads only, in one round trip: `HELLO 2` and every probe. Throws the
 * refusal at the first answer that does not prove it; a failed round trip is raised as the client's own error, never
 * read as a verdict. `nonce` is fresh per proof unless a test pins it.
 */
export async function proveRedisReadOnly(
  roundTrip: RedisRoundTrip,
  user: string,
  nonce: string = randomUUID(),
): Promise<void> {
  const probes = redisProofProbes(nonce);
  const [hello, ...answers] = await roundTrip([HELLO, ...probes.map((probe) => probe.argv)]);
  if (hello === undefined || !hello.ok) throw unread("HELLO 2");
  const fields = helloFields(hello.reply);
  if (fields === undefined) throw unread("HELLO 2");
  if (!isMeasuredServer(fields)) {
    throw new ExecutionProfileError(REDIS_PROOF_SENTENCES.notMeasured, "PROFILE_UNSUPPORTED_TARGET");
  }
  probes.forEach((probe, index) => {
    const answer = answers[index];
    if (answer === undefined) throw unread(probe.label);
    if (answer.ok) {
      throw new ExecutionProfileError(REDIS_PROOF_SENTENCES.admitted(probe.label), "PROFILE_PRIVILEGES_TOO_BROAD");
    }
    if (PATTERN_REFUSALS.has(answer.error)) {
      throw new ExecutionProfileError(REDIS_PROOF_SENTENCES.patternScoped(probe.label), "PROFILE_PRIVILEGES_TOO_BROAD");
    }
    if (answer.error !== commandRefusal(user, probe)) throw unread(probe.label);
  });
}
