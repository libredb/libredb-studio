/**
 * Seeds the two servers a 0.18.0/agent-boundary/run.sh started, sends what the agent's closed table would send and
 * every call it refuses, and writes what each server answered into that run.sh's directory.
 *
 *   bun tests/live/oxia-agent-boundary.ts keygen <directory>
 *   bun tests/live/oxia-agent-boundary.ts
 *
 * `keygen` writes the RS256 key pair the authenticated server checks tokens with into a scratch directory run.sh
 * removes. The probe run reads its environment: OXIA_OPEN_TARGET (host:port of a standalone server with no
 * authentication), OXIA_AUTH_TARGET (host:port of a data server with the OIDC provider on), OXIA_KEY_DIR (the keygen
 * directory), OXIA_ISSUER (the issuer the server trusts), OXIA_IMAGE (the image with its digest) and OXIA_OUT (the
 * directory to write). Every token is minted here for the run and stays in this process; the script refuses to write a
 * capture that holds any form of one. It drives grpc-js directly over the vendored descriptor and sends every request
 * raw: no Studio check stands in front of it, which is the point, since what is measured is what the server does on
 * its own.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import { OXIA_DESCRIPTOR } from "@/lib/db/providers/keyvalue/oxia/proto/descriptor";
import { oxiaHash } from "@/lib/db/providers/keyvalue/oxia/routing";

if (process.argv[2] === "keygen") {
  const directory = process.argv[3];
  if (directory === undefined) throw new Error("keygen takes a directory");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(path.join(directory, "jwt.pub"), pair.publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(path.join(directory, "jwt.key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  process.exit(0);
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const OPEN_TARGET = env("OXIA_OPEN_TARGET");
const AUTH_TARGET = env("OXIA_AUTH_TARGET");
const KEY_DIR = env("OXIA_KEY_DIR");
const ISSUER = env("OXIA_ISSUER");
const IMAGE = env("OXIA_IMAGE");
const OUT = env("OXIA_OUT");
const DATE = new Date().toISOString().slice(0, 10);

/** Every token the run minted; none may appear in a written capture. */
const SECRETS = new Set<string>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A token for `subject`, signed with the run's key, for the audience the server allows. */
function mint(subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: ISSUER, aud: "oxia", sub: subject, iat: now, exp: now + 600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const token = `${header}.${payload}.${b64url(signer.sign(readFileSync(path.join(KEY_DIR, "jwt.key"))))}`;
  SECRETS.add(token);
  for (const part of token.split(".")) SECRETS.add(part);
  return token;
}

const definition = fromJSON(OXIA_DESCRIPTOR as Parameters<typeof fromJSON>[0], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
const OxiaClient = (grpc.loadPackageDefinition(definition).io as any).oxia.proto.v1.OxiaClient;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
type AnyClient = any;

const clients = new Map<string, AnyClient>();

function client(target: string): AnyClient {
  let found = clients.get(target);
  if (found === undefined) {
    found = new OxiaClient(target, grpc.credentials.createInsecure());
    clients.set(target, found);
  }
  return found;
}

/** One answer as a capture records it: its outcome, and the messages or the gRPC status. */
type Answer =
  | { readonly outcome: "ok"; readonly messages: readonly unknown[]; readonly open?: true }
  | { readonly outcome: "error"; readonly code: number; readonly details: string };

/** Bytes as a capture shows them: the text where it is printable, else base64. */
function show(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    const text = bytes.toString("utf8");
    return /^[\x20-\x7e]*$/.test(text) && Buffer.from(text, "utf8").equals(bytes)
      ? { $text: text }
      : { $bytes: bytes.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(show);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, show(inner)]));
  }
  return value;
}

function metadataFor(token: string | undefined): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (token !== undefined) metadata.set("authorization", `Bearer ${token}`);
  return metadata;
}

/**
 * One server-stream call: every message until the stream ends, or until `quiet` ms pass with the stream still open
 * (a notification or sequence stream never ends on its own), then a cancel.
 */
function stream(target: string, method: string, request: unknown, token?: string, quiet = 2_000): Promise<Answer> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    const call = client(target)[method](request, metadataFor(token), { deadline: new Date(Date.now() + 10_000) });
    let done = false;
    const finish = (answer: Answer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      call.cancel();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ outcome: "ok", messages, open: true }), quiet);
    call.on("data", (message: unknown) => {
      messages.push(show(message));
      // The shard map is one message, and the stream stays open for the next map.
      if (method === "GetShardAssignments") finish({ outcome: "ok", messages, open: true });
    });
    call.on("end", () => finish({ outcome: "ok", messages }));
    call.on("error", (error: grpc.ServiceError) => {
      if (error.code !== grpc.status.CANCELLED) finish({ outcome: "error", code: error.code, details: error.details });
    });
  });
}

/** One unary call. */
function unary(target: string, method: string, request: unknown, token?: string): Promise<Answer> {
  return new Promise((resolve) => {
    client(target)[method](
      request,
      metadataFor(token),
      { deadline: new Date(Date.now() + 10_000) },
      (error: grpc.ServiceError | null, answer: unknown) => {
        if (error) resolve({ outcome: "error", code: error.code, details: error.details });
        else resolve({ outcome: "ok", messages: [show(answer)] });
      },
    );
  });
}

interface Shard {
  readonly id: string;
  readonly min: number;
  readonly max: number;
}

async function shardsOf(target: string, token?: string): Promise<Shard[]> {
  const answer = await stream(target, "GetShardAssignments", { namespace: "default" }, token);
  if (answer.outcome !== "ok") throw new Error(`GetShardAssignments failed: ${answer.details}`);
  const map = answer.messages[0] as {
    namespaces: Record<
      string,
      {
        assignments: Array<{
          shard: string;
          int32_hash_range: { min_hash_inclusive: number; max_hash_inclusive: number };
        }>;
      }
    >;
  };
  return map.namespaces.default.assignments.map((assignment) => ({
    id: assignment.shard,
    min: assignment.int32_hash_range.min_hash_inclusive,
    max: assignment.int32_hash_range.max_hash_inclusive,
  }));
}

function shardOf(shards: readonly Shard[], routing: string): Shard {
  const hash = oxiaHash(routing);
  const found = shards.find((shard) => shard.min <= hash && hash <= shard.max);
  if (found === undefined) throw new Error("no shard holds the hash");
  return found;
}

/** The keys a capture's server holds, read with List on every shard, internal keys excluded. */
async function state(target: string, shards: readonly Shard[], token?: string): Promise<Record<string, unknown>> {
  const keys: Record<string, unknown> = {};
  for (const shard of shards) {
    const answer = await stream(target, "List", { shard: shard.id, start_inclusive: "", end_exclusive: "" }, token);
    keys[shard.id] =
      answer.outcome === "ok"
        ? answer.messages.flatMap((message) => (message as { keys: unknown[] }).keys)
        : { error: answer.code };
  }
  return { keys };
}

/** Writes one capture, refusing one that holds any form of a token of the run. */
function write(name: string, captured: Record<string, unknown>, body: Record<string, unknown>): void {
  const text = `${JSON.stringify(
    { $captured: { image: IMAGE, version: "0.18.0", date: DATE, runtime: `bun ${Bun.version}`, ...captured }, ...body },
    null,
    2,
  )}\n`;
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`The capture ${name} holds a token of the run; not written`);
  }
  writeFileSync(path.join(OUT, `${name}.json`), text);
}

/** Fixture keys only: a Pulsar-shaped tenant and topic path, a flat key, and one written under a partition key. */
const KEYS = {
  tenant: "/admin/policies/acme-tenant",
  topic: "/managed-ledgers/acme-tenant/default/persistent/orders",
  flat: "fixture-flat",
  partitioned: "/pk/fixture/1",
  missing: "/admin/policies/no-such-tenant",
  scratch: "/scratch/put",
  ephemeral: "/scratch/ephemeral",
  sequence: "/scratch/sequence",
} as const;

const PARTITION_KEY = "fixture-partition";

function put(shards: readonly Shard[], key: string, value: string, extra: Record<string, unknown> = {}): unknown {
  const routing = typeof extra.partition_key === "string" ? extra.partition_key : key;
  return { shard: shardOf(shards, routing).id, puts: [{ key, value: Buffer.from(value), ...extra }] };
}

async function must(answer: Promise<Answer>, what: string): Promise<Answer> {
  const settled = await answer;
  if (settled.outcome !== "ok") throw new Error(`${what} failed: ${settled.details}`);
  return settled;
}

/** The standalone server, no authentication: the admitted reads, then every refused call with the state around it. */
async function open(): Promise<void> {
  const target = OPEN_TARGET;
  const assignments = await stream(target, "GetShardAssignments", { namespace: "default" });
  const shards = await shardsOf(target);
  await must(unary(target, "Write", put(shards, KEYS.tenant, '{"fixture":"tenant"}')), "seed tenant");
  await must(unary(target, "Write", put(shards, KEYS.topic, "fixture-topic-bytes")), "seed topic");
  await must(unary(target, "Write", put(shards, KEYS.flat, "fixture-flat-value")), "seed flat");
  await must(
    unary(target, "Write", put(shards, KEYS.partitioned, "fixture-pk", { partition_key: PARTITION_KEY })),
    "seed partitioned",
  );
  const home = (key: string): string => shardOf(shards, key).id;
  const get = (key: string, extra: Record<string, unknown> = {}, shard = home(key)): unknown => ({
    shard,
    gets: [{ key, include_value: true, comparison_type: "EQUAL", ...extra }],
  });
  const before = await state(target, shards);

  const admitted: Record<string, Answer> = {
    shardAssignments: assignments,
    shardAssignmentsOtherNamespace: await stream(target, "GetShardAssignments", { namespace: "no-such-namespace" }),
    getTenant: await stream(target, "Read", get(KEYS.tenant)),
    getMissing: await stream(target, "Read", get(KEYS.missing)),
    getPartitionedOnOwnHash: await stream(target, "Read", get(KEYS.partitioned)),
    getPartitionedOnPartitionShard: await stream(
      target,
      "Read",
      get(KEYS.partitioned, {}, shardOf(shards, PARTITION_KEY).id),
    ),
  };
  for (const shard of shards) {
    admitted[`listEveryKey:${shard.id}`] = await stream(target, "List", {
      shard: shard.id,
      start_inclusive: "",
      end_exclusive: "",
    });
    admitted[`listPrefixAdminBand:${shard.id}`] = await stream(target, "List", {
      shard: shard.id,
      start_inclusive: "/admin/policies/",
      end_exclusive: "/admin/policies//",
    });
  }

  // What the table never sends, each against the same server: the positive control that the server would honour it.
  const refused: Record<string, Answer> = {
    getFloor: await stream(target, "Read", get(KEYS.missing, { comparison_type: "FLOOR", include_value: false })),
    getSecondaryIndex: await stream(target, "Read", get(KEYS.tenant, { secondary_index_name: "fixture-index" })),
    listInternalKeys: await stream(target, "List", {
      shard: home(KEYS.tenant),
      start_inclusive: "",
      end_exclusive: "",
      include_internal_keys: true,
    }),
    rangeScanEveryKey: await stream(target, "RangeScan", {
      shard: home(KEYS.tenant),
      start_inclusive: "",
      end_exclusive: "",
    }),
    put: await unary(target, "Write", put(shards, KEYS.scratch, "fixture-written")),
    delete: await unary(target, "Write", { shard: home(KEYS.scratch), deletes: [{ key: KEYS.scratch }] }),
    sequencePut: await unary(
      target,
      "Write",
      put(shards, KEYS.sequence, "fixture-sequence", { partition_key: PARTITION_KEY, sequence_key_delta: ["1"] }),
    ),
    getSequenceUpdates: await stream(target, "GetSequenceUpdates", {
      shard: shardOf(shards, PARTITION_KEY).id,
      key: KEYS.sequence,
    }),
    getNotifications: await stream(target, "GetNotifications", { shard: home(KEYS.tenant) }),
  };
  const session = await unary(target, "CreateSession", {
    shard: home(KEYS.ephemeral),
    session_timeout_ms: 5_000,
    client_identity: "fixture-identity",
  });
  refused.createSession = session;
  const sessionId =
    session.outcome === "ok" ? (session.messages[0] as { session_id?: string } | undefined)?.session_id : undefined;
  if (sessionId !== undefined) {
    refused.ephemeralPut = await unary(
      target,
      "Write",
      put(shards, KEYS.ephemeral, "fixture-ephemeral", { session_id: sessionId, client_identity: "fixture-identity" }),
    );
    refused.ephemeralGet = await stream(target, "Read", get(KEYS.ephemeral, { include_value: false }));
    refused.closeSession = await unary(target, "CloseSession", { shard: home(KEYS.ephemeral), session_id: sessionId });
    refused.ephemeralGetAfterClose = await stream(target, "Read", get(KEYS.ephemeral, { include_value: false }));
  }
  const middle = await state(target, shards);
  refused.deleteRangeEveryKey = await unary(target, "Write", {
    shard: home(KEYS.flat),
    delete_ranges: [{ start_inclusive: "", end_exclusive: "" }],
  });
  const after = await state(target, shards);
  write(
    "open",
    {
      server: "standalone, two shards, no authentication",
      note: "Each call sent raw over gRPC with no token. `refused` lists calls the agent's table never sends, against the same server, so each shows what the server would do with it: the server honours every one, which is why Studio refuses them before the network.",
    },
    { keys: KEYS, partitionKey: PARTITION_KEY, before, admitted, refused, stateBeforeDeleteRange: middle, after },
  );
}

/** The data server with the OIDC provider: no token, then two subjects that write and delete each other's keys. */
async function authenticated(): Promise<void> {
  const target = AUTH_TARGET;
  const alice = mint("fixture-subject-a");
  const bob = mint("fixture-subject-b");
  const noToken = await stream(target, "GetShardAssignments", { namespace: "default" });
  // The coordinator assigns the shards some seconds after the data server starts; wait for the map, at most a minute.
  for (let waited = 0; waited < 60; waited++) {
    const map = await stream(target, "GetShardAssignments", { namespace: "default" }, alice);
    if (map.outcome === "ok") break;
    await Bun.sleep(1_000);
  }
  const shards = await shardsOf(target, alice);
  const key = "/fixture/owned-by-subject-a";
  const probes: Record<string, Answer> = {
    shardAssignmentsNoToken: noToken,
    listNoToken: await stream(target, "List", { shard: shards[0]?.id ?? "0", start_inclusive: "", end_exclusive: "" }),
    putSubjectA: await unary(target, "Write", put(shards, key, "fixture-a"), alice),
    getSubjectB: await stream(
      target,
      "Read",
      { shard: shardOf(shards, key).id, gets: [{ key, include_value: true, comparison_type: "EQUAL" }] },
      bob,
    ),
    overwriteSubjectB: await unary(target, "Write", put(shards, key, "fixture-b"), bob),
    deleteSubjectB: await unary(target, "Write", { shard: shardOf(shards, key).id, deletes: [{ key }] }, bob),
    deleteRangeSubjectB: await unary(
      target,
      "Write",
      { shard: shardOf(shards, key).id, delete_ranges: [{ start_inclusive: "", end_exclusive: "" }] },
      bob,
    ),
  };
  const after = await state(target, shards, alice);
  write(
    "authenticated",
    {
      server: "data server and coordinator, the OIDC provider with a static key, plaintext",
      note: "Two subjects of one issuer and audience; no token is recorded. Authentication is checked, and nothing else: the second subject reads, overwrites and deletes the first subject's key and deletes every key of a shard, so the server holds no per-namespace or per-key permission a token could carry.",
    },
    { subjects: ["fixture-subject-a", "fixture-subject-b"], probes, after },
  );
}

await open();
await authenticated();
for (const found of clients.values()) found.close();
