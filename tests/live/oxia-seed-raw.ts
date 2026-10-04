/**
 * The raw Oxia seeder: the one file of this repository that writes to an Oxia server (SB3-5.9).
 *
 *   bun tests/live/oxia-seed-raw.ts --target 127.0.0.1:6648
 *   bun tests/live/oxia-seed-raw.ts --target 127.0.0.1:6658
 *
 * It adds the keys the Oxia CLI cannot write to a compose fixture that `docker/oxia/seed.sh` already seeded: the three
 * keys that hold U+0000, which no command-line argument can carry, and on 6648 the 20,000 bulk keys, which would take
 * about 27 minutes through the CLI. Its writes are plain puts of fixed values, so it may run again.
 *
 * It refuses any other target before a socket opens, and a server that does not hold the marker with the fixture's
 * value. It loads the vendored client.proto itself and calls the unary Write RPC, so the provider's allowlisted stub
 * never gains a write method (O8). Every key is routed by the provider's own routing module, every shard is dialled at
 * the fixed target (a leader string the server sends is never used as an address), and the run ends with a routing
 * cross-check over keys the CLI wrote. No value it writes comes near the server's 64 MiB WAL segment.
 *
 * tests/unit/db/oxia/live-environment.test.ts holds these rules as text.
 */
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync, type MethodDefinition } from "@grpc/proto-loader";
import type { OxiaShard, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { parseLeaderAddress } from "@/lib/db/providers/keyvalue/oxia/connection-options";
import { shardFor, validateAssignments, type WireAssignments } from "@/lib/db/providers/keyvalue/oxia/routing";

const TARGETS = {
  "127.0.0.1:6648": { marker: "full", bulk: true },
  "127.0.0.1:6658": { marker: "small", bulk: false },
} as const;
type SeedTarget = keyof typeof TARGETS;

const OXIA_MARKER_KEY = "/libredb-fixture/seeded";
const NAMESPACE = "default";
const NUL_KEYS = ["/nul/a\u0000b", "/nul/\u0000", "a\u0000"] as const;
const NUL_VALUE = "nul";
const BULK_COUNT = 20_000;
const BULK_VALUE = "v";
const bulkKey = (index: number): string => `/bulk/key-${String(index).padStart(5, "0")}`;
/** The puts of one Write request. */
const BATCH = 1_000;
const DEADLINE_MS = 30_000;

/** Keys seed.sh wrote, read back on the shard routing.ts names: the eleven ordering probes and the four flat keys, then five of the set's own. */
const ORDERING_PROBES = ["/a", "/a/b", "/a/b/c", "/a/bb", "/a/b/", "/a/c", "/ab", "/b", "/b/c", "/a/b/c/d", "/z"];
const FLAT_KEYS = ["config", "feature-flag.dark-mode", "user:42", "zz-last-flat"];
const CROSS_CHECK: Readonly<Record<string, readonly string[]>> = {
  full: [...ORDERING_PROBES, ...FLAT_KEYS, "/trail//", "/trail/x//", "/odd//", "/versions/counter", "/admin"],
  small: [...ORDERING_PROBES, ...FLAT_KEYS, "/trail//", "/trail/x//", "/odd//", "-dash", ".dot"],
};

const flag = process.argv.indexOf("--target");
const target = flag === -1 ? undefined : process.argv[flag + 1];
if (target === undefined || !Object.hasOwn(TARGETS, target)) {
  console.error(
    `oxia-seed-raw: ${target ?? "(no --target)"} is not a compose fixture; this script writes to 127.0.0.1:6648 and 127.0.0.1:6658 only.`,
  );
  process.exit(2);
}
const fixture = TARGETS[target as SeedTarget];
const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];

/** The loader options are OXIA_LOADER_OPTIONS' values, written again: importing the adapter would load its stub here. */
const definition = loadSync(path.join(import.meta.dir, "../../src/lib/db/providers/keyvalue/oxia/proto/client.proto"), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const service = definition["io.oxia.proto.v1.OxiaClient"] as unknown as Record<
  string,
  MethodDefinition<object, object>
>;
// The authority is the fixed target, host:port (C1).
const client = new grpc.Client(target, grpc.credentials.createInsecure(), { "grpc.default_authority": target });
const deadline = (): grpc.CallOptions => ({ deadline: Date.now() + DEADLINE_MS });
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One record as Read answers it. */
interface WireGet {
  readonly status: string;
  readonly value?: Uint8Array | null;
}

console.log(`oxia-seed-raw: reading the shard assignments of ${target}`);
const assignments = await firstAssignments();
const validated = validateAssignments(assignments, NAMESPACE, parseLeaderAddress);
if ("problem" in validated) {
  console.error(`oxia-seed-raw: the shard assignments of ${target} are not valid: ${validated.problem}`);
  process.exit(1);
}
// Every shard is dialled at the fixed target; the server's leader string is never used as an address.
const snapshot: OxiaSnapshot = {
  namespace: NAMESPACE,
  shards: validated.shards.map((shard) => ({
    id: shard.id,
    minHash: shard.minHash,
    maxHash: shard.maxHash,
    leader: { host, port, address: target, bootstrap: true },
  })),
  readAt: Date.now(),
};
console.log(`oxia-seed-raw: ${snapshot.shards.length} shards`);

const marker = await readRecord(snapshot, OXIA_MARKER_KEY);
if (marker?.status !== "OK" || decoder.decode(marker.value ?? new Uint8Array()) !== fixture.marker) {
  console.error(`oxia-seed-raw: ${target} does not hold the marker ${fixture.marker}; run the compose seed first.`);
  process.exit(1);
}
console.log(`oxia-seed-raw: the marker holds ${fixture.marker}`);

let written = await seedKeys(snapshot, NUL_KEYS, NUL_VALUE);
console.log(`oxia-seed-raw: wrote the ${NUL_KEYS.length} U+0000 keys`);
if (fixture.bulk) {
  written += await seedKeys(
    snapshot,
    Array.from({ length: BULK_COUNT }, (_, index) => bulkKey(index)),
    BULK_VALUE,
  );
  console.log(`oxia-seed-raw: wrote the ${BULK_COUNT.toLocaleString("en-US")} bulk keys`);
}

const checked = await crossCheck(snapshot, CROSS_CHECK[fixture.marker] as readonly string[]);
client.close();
console.log(`seeded ${written} keys on ${target}; routing cross-check ${checked} of ${checked}`);

/** The first GetShardAssignments message for the namespace; the stream is cancelled after it. */
function firstAssignments(): Promise<WireAssignments> {
  const method = service.GetShardAssignments as MethodDefinition<object, object>;
  return new Promise((resolve, reject) => {
    let answered = false;
    const stream = client.makeServerStreamRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      { namespace: NAMESPACE },
      new grpc.Metadata(),
      deadline(),
    );
    stream.on("data", (message: WireAssignments) => {
      if (answered) return;
      answered = true;
      resolve(message);
      stream.cancel();
    });
    stream.on("error", (error: Error) => {
      if (!answered) reject(error);
    });
    stream.on("end", () => {
      if (!answered) reject(new Error("oxia-seed-raw: the assignments stream ended with no message"));
    });
  });
}

/** One EQUAL get with its value, on the shard routing.ts names for the key. */
function readRecord(snapshot: OxiaSnapshot, key: string): Promise<WireGet | undefined> {
  const shard = shardFor(snapshot, key);
  const method = service.Read as MethodDefinition<object, object>;
  return new Promise((resolve, reject) => {
    const gets: WireGet[] = [];
    const stream = client.makeServerStreamRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      { shard: shard.id, gets: [{ key, include_value: true, comparison_type: "EQUAL" }] },
      new grpc.Metadata(),
      deadline(),
    );
    stream.on("data", (message: { readonly gets: readonly WireGet[] }) => gets.push(...message.gets));
    stream.on("error", reject);
    stream.on("end", () => resolve(gets[0]));
  });
}

/** Each key read on the shard routing.ts names; exits 1 with the key when one is not there. */
async function crossCheck(snapshot: OxiaSnapshot, keys: readonly string[]): Promise<number> {
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one key at a time, so a failure names its key.
    const record = await readRecord(snapshot, key);
    if (record?.status !== "OK") {
      const shard = shardFor(snapshot, key);
      console.error(
        `oxia-seed-raw: routing cross-check failed: ${JSON.stringify(key)} is not on shard ${shard.id}, the shard routing.ts names`,
      );
      process.exit(1);
    }
  }
  return keys.length;
}

/** The keys grouped by the shard routing.ts names, then sent in requests of at most BATCH puts. */
async function seedKeys(snapshot: OxiaSnapshot, keys: readonly string[], value: string): Promise<number> {
  const byShard = new Map<OxiaShard, string[]>();
  for (const key of keys) {
    const shard = shardFor(snapshot, key);
    byShard.set(shard, [...(byShard.get(shard) ?? []), key]);
  }
  for (const [shard, shardKeys] of byShard) {
    for (let start = 0; start < shardKeys.length; start += BATCH) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps the server's load flat.
      await sendWrite(shard, shardKeys.slice(start, start + BATCH), value);
    }
  }
  return keys.length;
}

/** One unary Write of plain puts to one shard; every put must answer OK. */
function sendWrite(shard: OxiaShard, keys: readonly string[], value: string): Promise<void> {
  const method = service.Write as MethodDefinition<object, object>;
  const request = { shard: shard.id, puts: keys.map((key) => ({ key, value: encoder.encode(value) })) };
  return new Promise((resolve, reject) => {
    client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      new grpc.Metadata(),
      deadline(),
      (error, response) => {
        if (error) return reject(error);
        const statuses = (response as { readonly puts: readonly { readonly status: string }[] }).puts;
        const failed = statuses.findIndex((answer) => answer.status !== "OK");
        if (statuses.length !== keys.length || failed !== -1)
          return reject(new Error(`oxia-seed-raw: a put on shard ${shard.id} answered ${statuses[failed]?.status}`));
        resolve();
      },
    );
  });
}
