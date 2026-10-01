/**
 * Opt-in live check for the etcd provider (#1089): does a real `EtcdProvider`, run over every
 * surface it has, write only where it was told to, refuse what spec E6 and E8 refuse, and answer?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The seam guard is syntactic and the
 * integration test answers from captures; only the servers can say what changed. So this script
 * snapshots each fixture's key space outside its own scratch prefix (keys, values, revisions and
 * leases, and on the auth servers the users and roles) before and after every suite and fails on
 * any line that differs (spec E15), drives every refusal of E6 and E8 against the live servers, and
 * measures what spec 11 leaves to measurement.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`).
 *
 * Run it from a worktree of this repository, with the compose fixtures of `docker/etcd/README.md`
 * up (compose project `etcd-lane-e`) and their certificates copied out:
 *
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service etcd
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service etcd-cluster [--ke14] [--ke15]
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service etcd-auth
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service etcd-auth-password [--ke12]
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --idempotence
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service rf        # Review Focus 1, on libredb-etcd-rf
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --service measure   # KE1 to KE5 and Review Focus 4
 *   ETCD_LIVE_CERTS=<dir> bun tests/live/etcd-live-check.ts --ke16              # five minutes under Bun
 *
 * KE8, through a real SSH tunnel, is `tests/live/etcd-tunnel-check.ts`: it builds the provider through the
 * factory, whose every-engine import graph this file keeps out of the Node bundle Step 11 runs.
 *   bun tests/live/etcd-live-check.ts --drive-cluster-container <bundle dir>    # KE13 and Review Focus 3
 *
 * No credential is written here: the passwords and keys come from `ETCD_LIVE_CERTS`, and the SSH
 * bastion's password from `LIVE_SSH_PASSWORD`.
 *
 * It exits non-zero when any check fails, prints each check with its verbatim error, and prints
 * each measurement as one `MEASURE {json}` line.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd";
import { parseEtcdCommand } from "@/lib/db/providers/keyvalue/etcd/commands";
import { ETCD_RECEIVE_CAP_BYTES } from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { ETCD_READ_BOUNDS } from "@/lib/db/providers/keyvalue/etcd/execute";
import { etcdTypedConfirmation } from "@/lib/db/providers/keyvalue/etcd/guard";
import { decodeScanCursor, ETCD_KEY_SCAN } from "@/lib/db/providers/keyvalue/etcd/key-scan";
import { commandRange, decodeUtf8, encodeKey, groupLabel, prefixGroups } from "@/lib/db/providers/keyvalue/etcd/keys";
import { quoteWord } from "@/lib/db/providers/keyvalue/etcd/lexer";
import { ETCD_TABLE_STATS_CONCURRENCY } from "@/lib/db/providers/keyvalue/etcd/monitoring-reads";
import { ETCD_GROUP_CAP, ETCD_WALK_KEY_CAP, ETCD_WALK_SEGMENT_BUDGET } from "@/lib/db/providers/keyvalue/etcd/objects";
import { rangeCovered, readableScope } from "@/lib/db/providers/keyvalue/etcd/permissions";
import type {
  DatabaseProvider,
  ObjectEditOutcome,
  ObjectPartEdit,
  ObjectSourceDocument,
  ProviderExecutionContext,
} from "@/lib/db/types";
import { generateSelectQuery, generateTableQuery } from "@/lib/query-generators";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  b64,
  compareBytes,
  type EtcdctlTarget,
  establishedPeers,
  etcdctl,
  fromB64,
  type Gateway,
  gatewayCall,
  gatewayDeletePrefix,
  gatewayGet,
  gatewayPut,
  gatewayPutMany,
  gatewayRemove,
  gatewayRoleWith,
  gatewaySignIn,
  gatewayUserWith,
  type LivePermission,
  parseEtcdctlJson,
  prefixRange,
  rangeHolds,
  readAllKeys,
  readCertificateDirectory,
  rootEnvFile,
  SCRATCH_PREFIX,
  sameBytes,
  snapshot,
  snapshotDiff,
  startForwarder,
} from "./etcd-live-support";

// ============================================================================
// Arguments and fixtures
// ============================================================================

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const LANE_E = "/home/cevheri/projects/libredb/libredb-studio/.claude/worktrees/etcd-lane-e";
const QUERY_TIMEOUT_MS = 60_000;
const SECRET_MARKER = "libredb-fixture-secret";
const ENVELOPE_B64 = b64(new Uint8Array([0x6b, 0x38, 0x73, 0x00]));

type ServiceName = "etcd" | "etcd-cluster" | "etcd-auth" | "etcd-auth-password" | "rf" | "measure";
interface Fixture {
  readonly host: string;
  readonly port: number;
  readonly container: string;
  readonly tls: boolean;
  readonly clientCertAuth: boolean;
  readonly auth: boolean;
  /** Whether the seeded key space of docker/etcd/README.md is on it. */
  readonly seeded: boolean;
}
const FIXTURES: Readonly<Record<ServiceName, Fixture>> = {
  etcd: {
    host: "127.0.0.1",
    port: 2379,
    container: "libredb-etcd",
    tls: false,
    clientCertAuth: false,
    auth: false,
    seeded: true,
  },
  "etcd-cluster": {
    host: "127.0.0.2",
    port: 2379,
    container: "libredb-etcd-cluster-1",
    tls: false,
    clientCertAuth: false,
    auth: false,
    seeded: true,
  },
  "etcd-auth": {
    host: "127.0.0.1",
    port: 12379,
    container: "libredb-etcd-auth",
    tls: true,
    clientCertAuth: true,
    auth: true,
    seeded: true,
  },
  "etcd-auth-password": {
    host: "127.0.0.1",
    port: 12479,
    container: "libredb-etcd-auth-password",
    tls: true,
    clientCertAuth: false,
    auth: true,
    seeded: true,
  },
  rf: {
    host: "127.0.0.1",
    port: 2399,
    container: "libredb-etcd-rf",
    tls: false,
    clientCertAuth: false,
    auth: false,
    seeded: false,
  },
  measure: {
    host: "127.0.0.1",
    port: 2389,
    container: "libredb-etcd-measure",
    tls: true,
    clientCertAuth: false,
    auth: false,
    seeded: false,
  },
};

const CERTS_DIR = process.env.ETCD_LIVE_CERTS;
const certs = CERTS_DIR === undefined ? undefined : readCertificateDirectory(CERTS_DIR);
function cert(name: string): string {
  if (certs === undefined)
    throw new Error("Set ETCD_LIVE_CERTS to the directory Step 1 copied out of libredb-etcd-auth.");
  const value = certs[name];
  if (value === undefined) throw new Error(`${name} is not in ETCD_LIVE_CERTS`);
  return value;
}

function etcdctlTarget(fixture: Fixture): EtcdctlTarget {
  if (!fixture.tls)
    return { container: fixture.container, flags: ["--endpoints=http://127.0.0.1:2379", "--command-timeout=30s"] };
  const flags = ["--endpoints=https://127.0.0.1:2379", "--cacert=/certs/ca.pem", "--command-timeout=30s"];
  if (fixture.clientCertAuth)
    return { container: fixture.container, flags: [...flags, "--cert=/certs/root.crt", "--key=/certs/root.key"] };
  if (!fixture.auth) return { container: fixture.container, flags };
  return { container: fixture.container, flags, envFile: rootEnvFile(CERTS_DIR as string, cert("root.password")) };
}

function gatewayFor(fixture: Fixture): Gateway {
  const origin = `${fixture.tls ? "https" : "http"}://${fixture.host}:${fixture.port}`;
  if (!fixture.tls) return { origin };
  if (fixture.clientCertAuth)
    return { origin, tls: { ca: cert("ca.pem"), cert: cert("gateway-client.crt"), key: cert("gateway-client.key") } };
  return { origin, tls: { ca: cert("ca.pem") } };
}

async function rootGateway(fixture: Fixture): Promise<Gateway> {
  const gateway = gatewayFor(fixture);
  if (fixture.auth) await gatewaySignIn(gateway, "root", cert("root.password"));
  return gateway;
}

let serial = 0;
function connectionFor(fixture: Fixture, extra: Partial<DatabaseConnection> = {}): DatabaseConnection {
  serial += 1;
  const base: DatabaseConnection = {
    id: `etcd-live-${serial}`,
    name: `etcd live ${serial}`,
    type: "etcd",
    host: fixture.host,
    port: fixture.port,
    createdAt: new Date(),
  };
  if (!fixture.tls) return { ...base, ...extra };
  return { ...base, ssl: { mode: "verify-full", caCert: cert("ca.pem") }, ...extra };
}

async function open(
  connection: DatabaseConnection,
  execution?: ProviderExecutionContext,
  queryTimeout = QUERY_TIMEOUT_MS,
): Promise<EtcdProvider> {
  const provider = new EtcdProvider(connection, { queryTimeout }, execution);
  await provider.connect();
  return provider;
}

// ============================================================================
// Outcomes
// ============================================================================

const outcomes: { readonly check: string; readonly ok: boolean; readonly detail: string }[] = [];
const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const measure = (name: string, value: unknown) => console.log(`MEASURE ${JSON.stringify({ name, value })}`);

async function check(name: string, body: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await body();
    outcomes.push({ check: name, ok: true, detail });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    outcomes.push({ check: name, ok: false, detail: describeError(error) });
    console.log(`FAIL ${name}: ${describeError(error)}`);
  }
}

function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The surface must refuse, with an Error whose name is one of `classes` and whose message holds every fragment. */
async function refusal(
  name: string,
  classes: readonly string[],
  fragments: readonly string[],
  body: () => Promise<unknown>,
): Promise<void> {
  await check(name, async () => {
    try {
      await body();
    } catch (error) {
      const said = describeError(error);
      must(
        error instanceof Error && classes.includes(error.name),
        `expected one of ${classes.join(", ")}, got ${said}`,
      );
      for (const fragment of fragments) must(error.message.includes(fragment), `expected "${fragment}" in ${said}`);
      must(!error.message.includes(SECRET_MARKER), `the refusal echoes a stored value: ${said}`);
      return said;
    }
    throw new Error("the surface answered instead of refusing");
  });
}

/** Every serialised answer is grepped for the fixture's secret and the envelope (spec E9). */
function assertNothingWithheldLeaks(label: string, answer: unknown): void {
  const text = JSON.stringify(answer);
  must(!text.includes(SECRET_MARKER), `${label}: the Secret marker reached the answer`);
  must(!text.includes(b64(SECRET_MARKER)), `${label}: the Secret marker reached the answer in base64`);
  must(!text.includes(ENVELOPE_B64), `${label}: a protobuf envelope reached the answer in base64`);
}

const rowsOf = (result: QueryResult): Record<string, unknown>[] => result.rows;

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
/**
 * A call that runs while a check does other work (a watch), settled at once: a check that fails before
 * awaiting it then leaves no rejection unhandled, which would end the whole run before its summary.
 */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
async function unwrap<T>(settled: Promise<Settled<T>>): Promise<T> {
  const answer = await settled;
  if (!answer.ok) throw answer.error;
  return answer.value;
}

/** The edit offer of a document's first part, or undefined where the part carries none. */
function editOf(document: ObjectSourceDocument): ObjectPartEdit | undefined {
  const first = document.parts[0];
  return "edit" in first ? first.edit : undefined;
}

// ============================================================================
// Suites
// ============================================================================

/** Every surface of spec 4 and 7 and every read command of 5.1.3, with E9's grep over each answer. */
async function surfaces(provider: DatabaseProvider, label: string, asRoot: boolean): Promise<void> {
  await check(`${label}: countObjects`, async () => {
    const counts = await provider.countObjects([]);
    assertNothingWithheldLeaks("counts", counts);
    must(counts.key === undefined, "the key kind is counted, which spec 4.3 forbids");
    return JSON.stringify(counts);
  });
  for (const kind of ["prefix", "member", "lease", "user", "role"]) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await check(`${label}: listObjects ${kind}`, async () => {
      try {
        const listed = await provider.listObjects([], kind);
        assertNothingWithheldLeaks(kind, listed);
        return `${listed.length} objects`;
      } catch (error) {
        // A user who is not root is refused the lease, user and role listings (spec 4.7), in etcd's words.
        must(!asRoot && ["lease", "user", "role"].includes(kind), `refused as root: ${describeError(error)}`);
        must(
          describeError(error).includes("permission denied"),
          `a refusal not in etcd's words: ${describeError(error)}`,
        );
        return `refused as spec 4.7 says: ${describeError(error)}`;
      }
    });
  }
  await refusal(
    `${label}: listObjects key is refused by name`,
    ["QueryError", "DatabaseConfigError"],
    ["Keys panel"],
    () => provider.listObjects([], "key"),
  );
  await check(`${label}: describeObjects prefix answers in one batch, not truncated`, async () => {
    const batch = await provider.describeObjects([], "prefix");
    must(!("truncated" in batch) || batch.truncated === undefined, "a prefix batch is marked truncated");
    return "one batch";
  });
  // The fixture's current revision, which no compaction removes: a fixed older one is gone once a
  // compaction ran, and this check's own `compact` as root on etcd-auth compacts to the current revision.
  const revision = currentRevision(etcdctlTarget(currentFixture()));
  const reads = [
    "get /config/a",
    "get /app/ --prefix --keys-only",
    "get /app/ --prefix --count-only",
    `get /history/counter --rev=${revision}`,
    "get /config/a --consistency=s",
    "lease list",
    "lease timetolive 694d8147df1dc4c8 --keys",
    "member list",
    "member list --consistency=s",
    "endpoint status",
    "endpoint health",
    "alarm list",
    "auth status",
    "user list",
    "role list",
    "watch /app/ --prefix --command-timeout=1s",
  ];
  for (const text of reads) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await check(`${label}: ${text}`, async () => {
      try {
        const result = await provider.query(text);
        assertNothingWithheldLeaks(text, result);
        return `${result.rowCount} rows`;
      } catch (error) {
        must(!asRoot, `refused as root: ${describeError(error)}`);
        must(
          describeError(error).includes("may read"),
          `a refusal that does not name what the user may read: ${describeError(error)}`,
        );
        return `refused, naming the scope: ${describeError(error)}`;
      }
    });
  }
  await check(`${label}: the withheld classes never leave on any surface (E9)`, async () => {
    const answers: unknown[] = [];
    for (const key of [
      "/registry/secrets/default/db-creds",
      "registry/secrets/default/legacy",
      "/registry/pods/default/nginx",
      "/registry/configmaps/default/encrypted",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      answers.push(await provider.query(`get ${quoteWord(key)}`).catch((error: unknown) => describeError(error)));
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      answers.push(await provider.readObjectSource?.([key], "key").catch((error: unknown) => describeError(error)));
    }
    answers.push(await provider.query("get /registry/ --prefix").catch((error: unknown) => describeError(error)));
    answers.push(
      await provider
        .scanKeysPage?.({ cursor: "0", pattern: "/registry/", count: ETCD_KEY_SCAN.defaultCount })
        .catch((error: unknown) => describeError(error)),
    );
    assertNothingWithheldLeaks("the withheld classes", answers);
    return `${answers.length} answers grepped`;
  });
  for (const [name, read] of [
    ["getHealth", () => provider.getHealth()],
    ["getOverview", () => provider.getOverview()],
    ["getStorageStats", () => provider.getStorageStats()],
    ["getTableStats", () => provider.getTableStats()],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await check(`${label}: ${name}`, async () => {
      const answer = await read();
      assertNothingWithheldLeaks(name, answer);
      return JSON.stringify(answer).slice(0, 200);
    });
  }
}

/** A write cycle inside the scratch prefix: every write command of 5.1.3 that is not refused. */
async function scratchWrites(provider: DatabaseProvider, gateway: Gateway, label: string): Promise<void> {
  const k = `${SCRATCH_PREFIX}${label}/k`;
  await check(`${label}: put, get, txn, del inside the scratch prefix`, async () => {
    await provider.query(`put ${k} v1`);
    must(new TextDecoder().decode(await gatewayGet(gateway, k)) === "v1", "the put did not land");
    await provider.query(`txn\nmod(${JSON.stringify(k)}) > "0"\n\nput ${k} v2\n\nput ${k} v3\n`);
    must(new TextDecoder().decode(await gatewayGet(gateway, k)) === "v2", "the txn's success branch did not run");
    await provider.query(`del ${k}`);
    must((await gatewayGet(gateway, k)) === undefined, "the del did not land");
    return "every write stayed under the scratch prefix";
  });
  await check(`${label}: a lease granted, attached, kept alive once and revoked`, async () => {
    const granted = rowsOf(await provider.query("lease grant 60"))[0];
    const lease = String(granted.lease);
    await provider.query(`put --lease=${lease} ${k}-leased v`);
    const alive = rowsOf(await provider.query(`lease keep-alive ${lease} --once`))[0];
    must(Number(alive.ttl) > 0, "keep-alive answered no TTL");
    await provider.query(`lease revoke ${lease}`);
    must((await gatewayGet(gateway, `${k}-leased`)) === undefined, "revoking the lease left its key");
    return lease;
  });
  await check(`${label}: a watch sees an event written during its window`, async () => {
    const watch = settle(provider.query(`watch ${SCRATCH_PREFIX}${label}/w/ --prefix --command-timeout=3s`));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await gatewayPut(gateway, `${SCRATCH_PREFIX}${label}/w/x`, "event");
    const events = rowsOf(await unwrap(watch));
    must(
      events.some((row) => row.type === "PUT"),
      `no PUT event in ${JSON.stringify(events)}`,
    );
    return `${events.length} events`;
  });
  await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
}

/** Every refusal of spec E8, and the content rule under the custom prefix, driven live. */
async function kubernetesRefusals(provider: DatabaseProvider, label: string): Promise<void> {
  const classes = ["QueryError", "DatabaseConfigError"];
  const prefixRows: ReadonlyArray<readonly [string, string]> = [
    ["put /registry/pods/default/x v", "/registry/"],
    ["del /registry/pods/default/nginx", "/registry/"],
    ["del /registry/ --prefix", "/registry/"],
    ["del /reg --prefix", "/registry/"],
    // A range that meets several protected prefixes names one of them; which one is the order of
    // PROTECTED_PREFIXES, so these rows hold only the sentence every prefix refusal carries.
    ["del / --prefix", "Kubernetes"],
    ["del '' --prefix", "Kubernetes"],
    ["del '' --from-key", "Kubernetes"],
    ["del /a /s", "Kubernetes"],
    ["put --lease=694d8147df1dc4c8 /registry/pods/default/y v", "/registry/"],
    ['txn\nmod("/app/cfg") > "0"\n\nput /app/cfg v\n\nput "\\x2fregistry/x" v\n', "/registry/"],
    ["put registry/secrets/default/x v", "registry/"],
    ["del /kubernetes.io/ --prefix", "/kubernetes.io/"],
    ["put /openshift.io/x v", "/openshift.io/"],
    ["put /bootstrap/x v", "/bootstrap/"],
    ["put k3s/x v", "k3s/"],
    ["lease revoke 694d8147df1dc4c9", "/registry/"],
  ];
  for (const [text, fragment] of prefixRows) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await refusal(`${label}: E8 refuses ${JSON.stringify(text)}`, classes, [fragment], () => provider.query(text));
  }
  for (const text of [
    "put compact_rev_key 1",
    "del compact_rev_key",
    "del c d",
    "del compact --prefix",
    'txn\nmod("/app/cfg") > "0"\n\nput /app/cfg v\n\ndel compact_rev_key\n',
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await refusal(
      `${label}: E8 refuses ${JSON.stringify(text)} for kube-apiserver's key`,
      classes,
      ["compact_rev_key"],
      () => provider.query(text),
    );
  }
  for (const text of [
    "put /tenant-a/configmaps/default/cm v",
    "put --ignore-value /tenant-a/configmaps/default/cm",
    "del /tenant-a/configmaps/default/cm-encrypted",
    'txn\nmod("/app/cfg") > "0"\n\nput /app/cfg v\n\nput /tenant-a/configmaps/default/cm v\n',
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await refusal(
      `${label}: the content rule refuses ${JSON.stringify(text)}`,
      classes,
      ["/tenant-a/configmaps/default/cm", "Kubernetes"],
      () => provider.query(text),
    );
  }
  await check(`${label}: a range del under the unprotected prefix is sent, the documented limit`, async () => {
    const gateway = await rootGateway(currentFixture());
    await gatewayPut(gateway, `${SCRATCH_PREFIX}tenant/configmaps/cm`, new Uint8Array([0x6b, 0x38, 0x73, 0x00, 1, 2]));
    await provider.query(`del ${SCRATCH_PREFIX}tenant/ --prefix`);
    must(
      (await gatewayGet(gateway, `${SCRATCH_PREFIX}tenant/configmaps/cm`)) === undefined,
      "the range del was not sent",
    );
    return "sent unchanged, as docs/providers/etcd.md section 13 says";
  });
}

/** Spec E6 in its three arms: every write, an edit and every maintenance operation, refused. */
async function readOnlyRefusals(
  fixture: Fixture,
  label: string,
  credentials: Partial<DatabaseConnection>,
): Promise<void> {
  const arms: ReadonlyArray<readonly [string, DatabaseConnection, ProviderExecutionContext | undefined, string]> = [
    [
      "a seed",
      connectionFor(fixture, { ...credentials, readOnly: true, seedId: "live-read-only" }),
      undefined,
      "This connection is read-only (set in the operator's seed file)",
    ],
    [
      "a connection of the user's own",
      connectionFor(fixture, { ...credentials, readOnly: true }),
      undefined,
      "This connection is read-only: turn off Read-only in its settings to write",
    ],
    [
      "an execution profile",
      connectionFor(fixture, credentials),
      { readOnly: true },
      "This run opens the connection read-only (agent execution profile)",
    ],
  ];
  const writable = await open(connectionFor(fixture, credentials));
  const source = (await writable.readObjectSource?.(["/app/cfg"], "key")) as ObjectSourceDocument;
  const part = source.parts[0];
  must("text" in part, "the fixture key /app/cfg has no text part");
  const built = await writable.buildObjectEdit?.({
    path: ["/app/cfg"],
    kind: "key",
    partId: part.id,
    text: `${part.text} `,
  });
  await writable.disconnect();
  for (const [arm, connection, execution, sentence] of arms) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    const provider = await open(connection, execution);
    for (const text of [
      `put ${SCRATCH_PREFIX}ro v`,
      `del ${SCRATCH_PREFIX}ro`,
      `txn\n\nput ${SCRATCH_PREFIX}ro v\n\n`,
      "lease grant 60",
      "lease revoke 694d8147df1dc4c8",
      "lease keep-alive 694d8147df1dc4c8 --once",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await refusal(
        `${label}: E6 (${arm}) refuses ${JSON.stringify(text)}`,
        ["QueryError", "DatabaseConfigError"],
        [sentence],
        () => provider.query(text),
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await check(`${label}: E6 (${arm}) offers no edit and refuses a plan built read-write`, async () => {
      const doc = (await provider.readObjectSource?.(["/app/cfg"], "key")) as ObjectSourceDocument;
      must(editOf(doc)?.offered === false, "the Source part offers an edit");
      must(built?.built === true, "the read-write build did not build");
      const outcome = await provider.applyObjectEdit?.(built.plan);
      must(outcome?.outcome === "refused", `the apply answered ${JSON.stringify(outcome)}`);
      return sentence;
    });
    for (const type of ["compact", "defragment", "disarm"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await refusal(`${label}: E6 (${arm}) refuses ${type}`, ["QueryError", "DatabaseConfigError"], [sentence], () =>
        provider.runMaintenance(type),
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await provider.disconnect();
  }
}

/** E3 through a forwarder, and E16 after disconnect: no socket of this process to the endpoint. */
async function transportChecks(
  fixture: Fixture,
  label: string,
  credentials: Partial<DatabaseConnection>,
): Promise<void> {
  const forwarder = await startForwarder(fixture.host, fixture.port);
  try {
    await check(`${label}: E3, every call arrives through the forwarder`, async () => {
      // Only sockets this provider opened count: the peers this process held before it are set aside.
      const earlier = new Set(establishedPeers());
      const provider = await open(
        connectionFor(fixture, {
          ...credentials,
          host: "127.0.0.1",
          port: forwarder.port,
          ssl: fixture.tls ? { mode: "verify-full", caCert: cert("ca.pem"), ...(credentials.ssl ?? {}) } : undefined,
        }),
      );
      const members = rowsOf(await provider.query("member list").catch(() => ({ rows: [] }) as unknown as QueryResult));
      // A refusal (the reader of etcd-auth) still went through the forwarder, which is what E3 asks.
      for (const text of ["get /config/a", "endpoint status", "endpoint health"]) {
        // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
        await provider.query(text).catch(() => undefined);
      }
      const peers = establishedPeers().filter((peer) => !earlier.has(peer));
      // The control: the provider's own socket to the forwarder is seen, so an empty answer below is not
      // `ss` failing to see this process's sockets.
      must(
        peers.some((peer) => peer.endsWith(`:${forwarder.port}`)),
        `the probe sees no socket of this process to the forwarder: ${peers.join(", ")}`,
      );
      const direct = peers.filter(
        (peer) =>
          peer.endsWith(`:${fixture.port}`) ||
          members.some((member) => String(member.client_urls ?? "").includes(peer)),
      );
      must(direct.length === 0, `this process dialled ${direct.join(", ")} directly`);
      must((await forwarder.accepted()) >= 1, "the forwarder accepted nothing");
      await provider.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const left = establishedPeers().filter(
        (peer) => !earlier.has(peer) && (peer.endsWith(`:${forwarder.port}`) || peer.endsWith(`:${fixture.port}`)),
      );
      must(left.length === 0, `E16: sockets left open after disconnect: ${left.join(", ")}`);
      return `${members.length} members listed, none dialled; nothing left open after disconnect`;
    });
  } finally {
    forwarder.close();
  }
}

/** D-ORCH-1: each leased key attached to its lease, and RBAC on after each auth init. */
async function fixtureFacts(fixture: Fixture, label: string): Promise<void> {
  const target = etcdctlTarget(fixture);
  await check(`${label}: each seeded lease holds its keys`, () => {
    const one = etcdctl(target, ["lease", "timetolive", "694d8147df1dc4c8", "--keys"]);
    const two = etcdctl(target, ["lease", "timetolive", "694d8147df1dc4c9", "--keys"]);
    must(one.includes("/leases/session-1"), one);
    must(two.includes("/leases/session-2") && two.includes("/registry/events/default/nginx.1"), two);
    return "694d8147df1dc4c8 and 694d8147df1dc4c9 attached";
  });
  if (fixture.auth) {
    await check(`${label}: RBAC is on`, () => {
      const status = etcdctl(target, ["auth", "status"]);
      must(/Authentication Status: true/.test(status), status);
      return status.trim().replace(/\n/g, "; ");
    });
  }
}

/** Spec 4.7 and Review Focus 5: users of unusual grants, created by the check as root and removed after it. */
async function unusualGrants(fixture: Fixture): Promise<void> {
  const gateway = await rootGateway(fixture);
  const all = readAllKeys(etcdctlTarget(fixture)).map((kv) => fromB64(kv.key));
  const enc = (text: string) => new TextEncoder().encode(text);
  const users: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, readonly LivePermission[]]>]> = [
    [
      "libredb-live-rf5a",
      [
        [
          "libredb-live-rf5a",
          [
            { type: "READ", ...prefixRange("/app/") },
            { type: "READWRITE", ...prefixRange("/app/a/") },
          ],
        ],
      ],
    ],
    [
      "libredb-live-rf5b",
      [
        [
          "libredb-live-rf5b",
          [
            { type: "READ", key: enc("/tenant-a/"), rangeEnd: new Uint8Array([0]) },
            { type: "READ", key: enc("/config/b") },
          ],
        ],
      ],
    ],
    [
      "libredb-live-rf5c",
      [
        ["libredb-live-rf5c1", [{ type: "READ", ...prefixRange("/apisix/") }]],
        [
          "libredb-live-rf5c2",
          [
            { type: "READ", key: enc("/apisix/r"), rangeEnd: enc("/apisix/s") },
            { type: "READ", key: new Uint8Array([...enc("/values/key-"), 0xff, 0xfe]) },
          ],
        ],
      ],
    ],
    [
      "libredb-live-rf5d",
      [["libredb-live-rf5d", [{ type: "READ", key: new Uint8Array([0]), rangeEnd: new Uint8Array([0]) }]]],
    ],
  ];
  const password = createHash("sha256").update(cert("root.password")).update("rf5").digest("hex").slice(0, 24);
  try {
    for (const [user, roles] of users) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      for (const [role, permissions] of roles) await gatewayRoleWith(gateway, role, permissions);
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await gatewayUserWith(
        gateway,
        user,
        password,
        roles.map(([role]) => role),
      );
    }
    for (const [user, roles] of users) {
      const permissions = roles.flatMap(([, list]) =>
        list.map((p) => ({
          type: p.type.toLowerCase() as "read" | "write" | "readwrite",
          key: p.key,
          rangeEnd: p.rangeEnd,
        })),
      );
      const readable = permissions.filter((p) => p.type !== "write");
      const expected = all.filter((key) => readable.some((p) => rangeHolds(p, key))).sort(compareBytes);
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      const provider = await open(connectionFor(fixture, { user, password }));
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await check(
        `Review Focus 5 (${user}): the Keys panel walks every readable key once, and nothing else`,
        async () => {
          const seen: string[] = [];
          let skipped = 0;
          let cursor = "0";
          let total = -1;
          do {
            // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
            const page = await (provider.scanKeysPage as NonNullable<DatabaseProvider["scanKeysPage"]>)({
              cursor,
              count: 10,
            });
            seen.push(...page.keys);
            skipped += page.skipped?.count ?? 0;
            if (total < 0) total = page.total;
            cursor = page.cursor;
          } while (cursor !== "0");
          const texts = expected.map((key) => decodeUtf8(key)).filter((text): text is string => text !== undefined);
          must(new Set(seen).size === seen.length, `a key listed twice: ${seen.join(", ")}`);
          must(
            JSON.stringify([...seen].sort()) === JSON.stringify([...texts].sort()),
            `walked ${seen.join(", ")}; expected ${texts.join(", ")}`,
          );
          must(
            skipped === expected.length - texts.length,
            `skipped ${skipped}, expected ${expected.length - texts.length}`,
          );
          must(total === expected.length, `total ${total}, expected ${expected.length}`);
          return `${seen.length} keys, ${skipped} skipped, total ${total}`;
        },
      );
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await check(
        `Review Focus 5 (${user}): every group listed once, its generated read inside the grant`,
        async () => {
          const groups = await provider.listObjects([], "prefix");
          const names = groups.map((group) => group.name);
          must(new Set(names).size === names.length, `a group listed twice: ${names.join(", ")}`);
          const oracle = prefixGroups(expected).groups.map(groupLabel).sort();
          must(
            JSON.stringify([...names].sort()) === JSON.stringify(oracle),
            `listed ${names.join(", ")}; the rule over the readable keys gives ${oracle.join(", ")}`,
          );
          const scope = readableScope(permissions.map((p) => ({ type: p.type, key: p.key, rangeEnd: p.rangeEnd })));
          const notes: string[] = [];
          for (const group of groups) {
            const text = generateTableQuery(group.path, provider.getCapabilities(), undefined, {
              readRanges: group.readRanges,
            });
            // A group whose every readable piece starts or ends at a key that is not UTF-8 lists no piece
            // (objects.ts groupReadRanges), and Generate Command writes a note in place of a read: for these
            // grants, exactly the groups whose every key the user may read is not UTF-8.
            const readableHere = expected.filter((key) => rangeHolds(prefixRange(group.name.slice(0, -1)), key));
            const noteExpected = readableHere.length > 0 && readableHere.every((key) => decodeUtf8(key) === undefined);
            if (text.startsWith("# No read is written for ")) {
              must(
                noteExpected && group.readRanges?.length === 0,
                `${group.name} got no read, though it holds a readable UTF-8 key: ${text}`,
              );
              notes.push(group.name);
              continue;
            }
            must(!noteExpected, `${group.name} got a read, though every key it may read is not UTF-8: ${text}`);
            const parsed = parseEtcdCommand(text, {
              maxLimit: 500,
              txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
              maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
              maxWatchWindowMs: Number.POSITIVE_INFINITY,
            });
            must(parsed.ok, `the generated read of ${group.name} does not parse: ${text}`);
            const command = parsed.parsed.command;
            must(command.kind === "get", `the generated read of ${group.name} is ${command.kind}`);
            must(
              rangeCovered(commandRange(command), scope),
              `the generated read of ${group.name} addresses bytes outside the grant: ${text}`,
            );
            // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
            const answer = await provider.query(text);
            assertNothingWithheldLeaks(group.name, answer);
          }
          return `${groups.length} groups, ${notes.length > 0 ? `the note in place of a read for ${notes.join(", ")}, ` : ""}each read inside the grant`;
        },
      );
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await check(
        `Review Focus 5 (${user}): edit.offered follows the writable union, a refusal names the scope`,
        async () => {
          if (user === "libredb-live-rf5a") {
            const inside = editOf((await provider.readObjectSource?.(["/app/a/b"], "key")) as ObjectSourceDocument);
            const outside = editOf((await provider.readObjectSource?.(["/app/cfg"], "key")) as ObjectSourceDocument);
            must(inside?.offered === true, "a READWRITE key is not offered for edit");
            must(
              outside?.offered === false && outside.reason.includes("may read this key but not write it"),
              "a READ-only key is offered for edit",
            );
          }
          try {
            await provider.query("get /feature-flag");
          } catch (error) {
            must(
              describeError(error).includes(`etcd user ${user} may read:`),
              `the refusal does not name the scope: ${describeError(error)}`,
            );
            return describeError(error);
          }
          must(user === "libredb-live-rf5d", "a key outside the grant was answered");
          return "READ on the whole key space answers every read";
        },
      );
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await provider.disconnect();
    }
  } finally {
    await gatewayRemove(
      gateway,
      users.map(([user]) => user),
      users.flatMap(([, roles]) => roles.map(([role]) => role)),
    );
  }
}

/**
 * Review Focus 3 on a password fixture: the token expiring between two pages and during a watch. A user of
 * the check's own, READWRITE on the scratch prefix only, so every write of this suite stays inside it.
 */
async function tokenEvents(fixture: Fixture): Promise<void> {
  const gateway = await rootGateway(fixture);
  const user = "libredb-live-rf3";
  const password = createHash("sha256").update(cert("root.password")).update("rf3").digest("hex").slice(0, 24);
  await gatewayRoleWith(gateway, user, [{ type: "READWRITE", ...prefixRange(SCRATCH_PREFIX) }]);
  await gatewayUserWith(gateway, user, password, [user]);
  await gatewayPutMany(gateway, [
    [`${SCRATCH_PREFIX}rf3/a`, "1"],
    [`${SCRATCH_PREFIX}rf3/b`, "2"],
    [`${SCRATCH_PREFIX}rf3/c`, "3"],
  ]);
  const provider = await open(connectionFor(fixture, { user, password }));
  try {
    await check("Review Focus 3: a Keys panel walk renews once between pages and keeps its revision", async () => {
      const scan = (provider.scanKeysPage as NonNullable<DatabaseProvider["scanKeysPage"]>).bind(provider);
      const first = await scan({ cursor: "0", pattern: `${SCRATCH_PREFIX}rf3/`, count: 1 });
      const pinned = decodeScanCursor(first.cursor);
      must(typeof pinned === "object", `the first page ended the walk: ${first.cursor}`);
      await new Promise((resolve) => setTimeout(resolve, 11_000)); // past --auth-token-ttl=10
      const second = await scan({ cursor: first.cursor, pattern: `${SCRATCH_PREFIX}rf3/`, count: 1 });
      const after = decodeScanCursor(second.cursor);
      must(
        after === "start" || (typeof after === "object" && after.revision === pinned.revision),
        `the walk moved from revision ${pinned.revision}`,
      );
      must(
        second.keys[0] === `${SCRATCH_PREFIX}rf3/b`,
        `the second page is ${JSON.stringify(second.keys)}, not the cursor's next key`,
      );
      return `revision ${pinned.revision} kept across an expired token`;
    });
    await check(
      "Review Focus 3: a watch across an expired token delivers the event or ends with an error, never a quiet window",
      async () => {
        const watching = settle(provider.query(`watch ${SCRATCH_PREFIX}rf3/w/ --prefix --command-timeout=15s`));
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        await gatewayPut(gateway, `${SCRATCH_PREFIX}rf3/w/x`, "event");
        try {
          const events = rowsOf(await unwrap(watching));
          must(events.length >= 1, "a quiet window where an event was written: the renewal was silent");
          return `${events.length} events`;
        } catch (error) {
          must(!describeError(error).includes("no event"), `a quiet window: ${describeError(error)}`);
          return `ended with ${describeError(error)}`;
        }
      },
    );
  } finally {
    await provider.disconnect();
    await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
    await gatewayRemove(gateway, [user], [user]);
  }
}

// ============================================================================
// Measurements
// ============================================================================

/** KE12: for each renewal answer of E4, whether a write that met it was applied, read back as root. */
async function ke12(fixture: Fixture): Promise<void> {
  const gateway = await rootGateway(fixture);
  const password = createHash("sha256").update(cert("root.password")).update("ke12").digest("hex").slice(0, 24);
  const writer = "libredb-live-ke12";
  await gatewayRoleWith(gateway, writer, [{ type: "READWRITE", ...prefixRange(SCRATCH_PREFIX) }]);
  await gatewayUserWith(gateway, writer, password, [writer]);
  try {
    // invalid auth token: a signed-in provider left idle past --auth-token-ttl=10.
    const idle = await open(connectionFor(fixture, { user: writer, password }));
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const invalid = await idle.query(`put ${SCRATCH_PREFIX}ke12/invalid v`).then(
      () => "answered",
      (error: unknown) => describeError(error),
    );
    measure("KE12 invalid auth token", {
      answer: invalid,
      applied: (await gatewayGet(gateway, `${SCRATCH_PREFIX}ke12/invalid`)) !== undefined,
    });
    await idle.disconnect();
    // revision of auth store is old: a token issued before an auth change.
    const stale = await open(connectionFor(fixture, { user: writer, password }));
    await gatewayCall(gateway, "/v3/auth/role/grant", {
      name: writer,
      perm: { permType: "READ", key: b64(`${SCRATCH_PREFIX}ke12/extra`) },
    });
    const old = await stale.query(`put ${SCRATCH_PREFIX}ke12/old v`).then(
      () => "answered",
      (error: unknown) => describeError(error),
    );
    measure("KE12 revision of auth store is old", {
      answer: old,
      applied: (await gatewayGet(gateway, `${SCRATCH_PREFIX}ke12/old`)) !== undefined,
    });
    await stale.disconnect();
    // user name is empty: a put with no token at all, which only the gateway can send.
    const anonymous: Gateway = { origin: gateway.origin, tls: gateway.tls };
    const empty = await gatewayPut(anonymous, `${SCRATCH_PREFIX}ke12/empty`, "v").then(
      () => "answered",
      (error: unknown) => describeError(error),
    );
    measure("KE12 user name is empty", {
      answer: empty,
      applied: (await gatewayGet(gateway, `${SCRATCH_PREFIX}ke12/empty`)) !== undefined,
    });
    // The first two answers met by a write itself. A top-level put reads its key first (spec E8), so above
    // that read met the answer and renewed, and the put went out on the new token; the value edit sends its
    // guarded Txn with no read before it, so here the Txn is the call that meets each answer.
    const editMeeting = async (label: string, key: string, provoke: () => Promise<unknown>) => {
      await gatewayPut(gateway, key, "v0");
      const editor = await open(connectionFor(fixture, { user: writer, password }));
      const source = (await editor.readObjectSource?.([key], "key")) as ObjectSourceDocument;
      const part = source.parts[0];
      must("text" in part, `${key} has no text part`);
      const built = await editor.buildObjectEdit?.({ path: [key], kind: "key", partId: part.id, text: "v1" });
      must(built?.built === true, `no plan: ${JSON.stringify(built)}`);
      await provoke();
      const outcome = await editor.applyObjectEdit?.(built.plan);
      await editor.disconnect();
      const stored = await gatewayGet(gateway, key);
      measure(`KE12 ${label}, met by a value edit`, {
        outcome,
        stored: stored === undefined ? null : new TextDecoder().decode(stored),
      });
    };
    await editMeeting(
      "invalid auth token",
      `${SCRATCH_PREFIX}ke12/edit-invalid`,
      () => new Promise((resolve) => setTimeout(resolve, 11_000)),
    );
    await editMeeting("revision of auth store is old", `${SCRATCH_PREFIX}ke12/edit-old`, () =>
      gatewayCall(gateway, "/v3/auth/role/grant", {
        name: writer,
        perm: { permType: "READ", key: b64(`${SCRATCH_PREFIX}ke12/extra-edit`) },
      }),
    );
  } finally {
    await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
    await gatewayRemove(gateway, [writer], [writer]);
  }
}

function dockerStart(container: string): void {
  execFileSync("docker", ["start", container]);
  for (let attempt = 0; attempt < 120; attempt++) {
    const health = execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", container], {
      encoding: "utf8",
    }).trim();
    if (health === "healthy") return;
    execFileSync("sleep", ["1"]);
  }
  throw new Error(`${container} did not turn healthy`);
}

/** KE14: with two members stopped, the exempt calls answer and a linearizable read fails at once. */
async function ke14(fixture: Fixture): Promise<void> {
  const provider = await open(connectionFor(fixture));
  execFileSync("docker", ["stop", "libredb-etcd-cluster-2", "libredb-etcd-cluster-3"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    for (const text of [
      "endpoint status",
      "get /config/a --consistency=s",
      "member list --consistency=s",
      "lease list",
      "txn\n\nget /config/a --consistency=s\n\n",
      "get /config/a",
      "member list",
    ]) {
      const started = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      const answer = await provider.query(text).then(
        (r) => `${r.rowCount} rows`,
        (error: unknown) => describeError(error),
      );
      measure("KE14", { command: text, ms: Date.now() - started, answer });
    }
    const started = Date.now();
    const defrag = await provider.runMaintenance("defragment").then(
      (r) => r.message,
      (error: unknown) => describeError(error),
    );
    measure("KE14", { command: "defragment", ms: Date.now() - started, answer: defrag });
    await check("KE14: getHealth raises the lost quorum before any alarm read", async () => {
      try {
        await provider.getHealth();
      } catch (error) {
        must(describeError(error).includes("lost quorum"), describeError(error));
        return describeError(error);
      }
      throw new Error("getHealth answered during a lost quorum");
    });
  } finally {
    dockerStart("libredb-etcd-cluster-2");
    dockerStart("libredb-etcd-cluster-3");
    await provider.disconnect();
  }
}

/** Waits until Docker reports every container healthy again, as a member is once a paused one's next probe ran. */
function awaitHealthy(containers: readonly string[]): void {
  for (let attempt = 0; attempt < 150; attempt++) {
    const health = containers.map((container) =>
      execFileSync("docker", ["inspect", "-f", "{{.State.Health.Status}}", container], { encoding: "utf8" }).trim(),
    );
    if (health.every((status) => status === "healthy")) return;
    execFileSync("sleep", ["1"]);
  }
  throw new Error(`${containers.join(", ")} did not turn healthy`);
}

/**
 * KE15: a write whose deadline passed while two followers were paused, read back after they return.
 * A top-level `put` first reads the key it writes (spec E8), and that linearizable read cannot complete
 * while the leader cannot reach a quorum, so the put is never sent (measured on 3.7.2, three runs of
 * three); the value edit sends its guarded Txn, which holds the put, with no read before it, so it is the
 * write that meets its deadline while the cluster cannot commit.
 */
async function ke15(fixture: Fixture): Promise<void> {
  const target = etcdctlTarget(fixture);
  const gateway = gatewayFor(fixture);
  // The three members by their names on the compose network and no other endpoint: etcdctl appends a
  // second --endpoints to the first, so the target's own 127.0.0.1 would be a fourth row naming no member.
  const members: EtcdctlTarget = {
    container: fixture.container,
    flags: [
      "--endpoints=http://etcd-cluster-1:2379,http://etcd-cluster-2:2379,http://etcd-cluster-3:2379",
      "--command-timeout=30s",
    ],
  };
  const roles = () => {
    const status = parseEtcdctlStatus(etcdctl(members, ["endpoint", "status", "-w", "json"]));
    const leader = status.find((member) => member.leader === member.memberId);
    must(leader !== undefined, "no leader in endpoint status");
    // Member n of the cluster is the container libredb-etcd-cluster-n, published on 127.0.0.<n+1>.
    const memberOf = (endpoint: string) => Number(/etcd-cluster-(\d)/.exec(endpoint)?.[1]);
    const followers = status
      .filter((member) => member !== leader)
      .map((member) => `libredb-etcd-cluster-${memberOf(member.endpoint)}`);
    return { host: `127.0.0.${memberOf(leader.endpoint) + 1}`, followers };
  };
  /** Runs `write` with both followers paused, and unpauses them whatever it does. */
  const whilePaused = async <T>(followers: readonly string[], write: () => Promise<T>): Promise<T> => {
    execFileSync("docker", ["pause", ...followers]);
    try {
      return await write();
    } finally {
      execFileSync("docker", ["unpause", ...followers]);
    }
  };
  try {
    for (let run = 1; run <= 3; run++) {
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await check(`KE15 put run ${run}: a put met by two paused followers says whether it was sent`, async () => {
        const { host, followers } = roles();
        const provider = await open(connectionFor({ ...fixture, host }));
        const key = `${SCRATCH_PREFIX}ke15/put-${run}`;
        const answer = await whilePaused(followers, () =>
          provider.query(`put --command-timeout=500ms ${key} v`).then(
            () => "answered",
            (error: unknown) => describeError(error),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await provider.disconnect();
        const applied = etcdctl(target, ["get", key, "--print-value-only"]).trim() === "v";
        measure("KE15", { path: "put", run, answer, applied, followers });
        // Sent, its outcome is unknown; stopped at the read before it, it was never sent and must not be there.
        must(
          answer === "answered" ||
            answer.includes("may have been applied") ||
            (answer.includes("The read before the put") && !applied),
          `a timed-out put not reported as it ended: ${answer}, applied ${applied}`,
        );
        return `${applied ? "applied" : "not applied"}; ${answer}`;
      });
    }
    for (let run = 1; run <= 3; run++) {
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await check(
        `KE15 edit run ${run}: a value edit whose Txn met its deadline while two followers were paused is interrupted, its outcome unknown`,
        async () => {
          const { host, followers } = roles();
          const key = `${SCRATCH_PREFIX}ke15/edit-${run}`;
          await gatewayPut(gateway, key, "v0");
          // A query timeout of 1 s is the deadline of the edit's Txn; the reads that build the plan answer first.
          const provider = await open(connectionFor({ ...fixture, host }), undefined, 1000);
          const source = (await provider.readObjectSource?.([key], "key")) as ObjectSourceDocument;
          const part = source.parts[0];
          must("text" in part, `${key} has no text part`);
          const built = await provider.buildObjectEdit?.({ path: [key], kind: "key", partId: part.id, text: "v1" });
          must(built?.built === true, `no plan: ${JSON.stringify(built)}`);
          const outcome = await whilePaused(
            followers,
            async () => (await provider.applyObjectEdit?.(built.plan)) as ObjectEditOutcome,
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
          await provider.disconnect();
          const applied = etcdctl(target, ["get", key, "--print-value-only"]).trim() === "v1";
          measure("KE15", { path: "value edit", run, outcome, applied, followers });
          must(
            outcome.outcome === "interrupted" &&
              outcome.committed === "unknown" &&
              outcome.sentence.includes("may have been applied"),
            `the edit answered ${JSON.stringify(outcome)}`,
          );
          return `${applied ? "applied" : "not applied"}; ${outcome.sentence}`;
        },
      );
    }
  } finally {
    etcdctl(target, ["del", SCRATCH_PREFIX, "--prefix"]);
    awaitHealthy(["libredb-etcd-cluster-1", "libredb-etcd-cluster-2", "libredb-etcd-cluster-3"]);
  }
}

/** The revision a fixture answers at now, read through etcdctl (the oracle side, never the provider). */
function currentRevision(target: EtcdctlTarget): string {
  const status = parseEtcdctlJson<Array<{ Status: { header: { revision: string | number } } }>>(
    etcdctl(target, ["endpoint", "status", "-w", "json"]),
  );
  return String(status[0].Status.header.revision);
}

interface StatusRow {
  readonly endpoint: string;
  readonly memberId: string;
  readonly leader: string;
}
function parseEtcdctlStatus(text: string): StatusRow[] {
  const rows =
    parseEtcdctlJson<
      Array<{ Endpoint: string; Status: { header: { member_id: string | number }; leader: string | number } }>
    >(text);
  return rows.map((row) => ({
    endpoint: row.Endpoint,
    memberId: String(row.Status.header.member_id),
    leader: String(row.Status.leader),
  }));
}

/** KE16: a five-minute watch and repeated paged reads under Bun, for the stall oven-sh/bun#39796 reports. */
async function ke16(fixture: Fixture): Promise<void> {
  const provider = await open(connectionFor(fixture), undefined, 330_000);
  const gateway = await rootGateway(fixture);
  try {
    const watching = settle(provider.query(`watch ${SCRATCH_PREFIX}ke16/ --prefix --command-timeout=300s`));
    const slowest: number[] = [];
    const started = Date.now();
    let written = 0;
    while (Date.now() - started < 300_000) {
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await gatewayPut(gateway, `${SCRATCH_PREFIX}ke16/${written}`, "x");
      written++;
      const readStart = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await provider.query("get /values/ --prefix");
      slowest.push(Date.now() - readStart);
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const events = rowsOf(await unwrap(watching)).length;
    measure("KE16", { written, events, slowestReadMs: Math.max(...slowest), runtime: `bun ${Bun.version}` });
    await check("KE16: no stall", () => {
      must(events >= written - 2, `the watch saw ${events} of ${written} writes`);
      must(Math.max(...slowest) < 5000, `a read took ${Math.max(...slowest)} ms`);
      return `${events} events of ${written} writes, slowest read ${Math.max(...slowest)} ms`;
    });
  } finally {
    await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
    await provider.disconnect();
  }
}

/** KE1 to KE5 and Review Focus 4, on libredb-etcd-measure (TLS, no auth). */
async function measureSuite(fixture: Fixture): Promise<void> {
  const provider = await open(connectionFor(fixture));
  const timed = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    const answer = await body();
    measure(name, { ms: Date.now() - started });
    return answer;
  };
  const counts = await timed("KE1 countObjects", () => provider.countObjects([]));
  const groups = await timed("KE1 listObjects prefix", () => provider.listObjects([], "prefix"));
  measure("KE1 result", {
    prefix: counts.prefix,
    listed: groups.length,
    G: ETCD_GROUP_CAP,
    S: ETCD_WALK_KEY_CAP,
    P: ETCD_WALK_SEGMENT_BUDGET,
  });
  await check("Review Focus 4: the tree answers within the query timeout with a floor naming the bound", () => {
    const prefix = counts.prefix;
    const flat = groups.find((group) => group.name === "/a-flat/*");
    must(flat !== undefined, "the flat directory is not listed as /a-flat/*");
    must(
      groups.some((group) => group.name.startsWith("/big/g")),
      "no group after the flat directory was listed",
    );
    // The floor is the count's when G or S stopped the walk, and the row's own when only the per-segment
    // budget P did (spec 4.3, R13 D9): either names the bound, and one of them must be there.
    const countFloor =
      prefix !== undefined && "sampledFrom" in prefix && /capped at|stopped after/.test(prefix.sampledFrom);
    const rowFloor = JSON.stringify(flat).includes("this prefix was not read to the end");
    must(countFloor || rowFloor, `no floor names a bound: ${JSON.stringify(prefix)} and ${JSON.stringify(flat)}`);
    return countFloor && prefix !== undefined && "sampledFrom" in prefix
      ? prefix.sampledFrom
      : "the /a-flat/* row's floor";
  });
  await check("Review Focus 4: the Keys panel pages the flat directory without reading it whole", async () => {
    const started = Date.now();
    const page = await (provider.scanKeysPage as NonNullable<DatabaseProvider["scanKeysPage"]>)({
      cursor: "0",
      pattern: "/a-flat/",
      count: ETCD_KEY_SCAN.defaultCount,
    });
    const ms = Date.now() - started;
    measure("KE3b first page", {
      ms,
      keys: page.keys.length,
      bytes: page.keys.reduce((sum, key) => sum + key.length, 0),
    });
    must(page.keys.length <= ETCD_KEY_SCAN.defaultCount && page.cursor !== "0", "the page read the directory whole");
    must(page.total === 200_000, `total ${page.total}`);
    return `${page.keys.length} keys in ${ms} ms, total ${page.total}`;
  });
  const maxPage = await timed("KE3b max page", () =>
    (provider.scanKeysPage as NonNullable<DatabaseProvider["scanKeysPage"]>)({
      cursor: "0",
      pattern: "/a-flat/",
      count: ETCD_KEY_SCAN.maxCount,
    }),
  );
  measure("KE3b max page size", { keys: maxPage.keys.length });
  const stats = await timed("KE2 getTableStats", () => provider.getTableStats());
  measure("KE2 result", { groups: stats.length, concurrency: ETCD_TABLE_STATS_CONCURRENCY });
  await check(
    "Review Focus 4: describeObjects answers every listed group, not truncated, so plan mode reads the floor note",
    async () => {
      const batch = await provider.describeObjects([], "prefix");
      must(!("truncated" in batch) || batch.truncated === undefined, "the prefix batch is truncated");
      return "the walk's sampledFrom reaches the inventory note (tests/unit/db/etcd/objects.test.ts pins the note itself)";
    },
  );
  for (const text of ["get /ke4/v1m/ --prefix", "get /ke4/v64k/ --prefix"]) {
    const before = memoryMiB(fixture.container);
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
    const answer = await provider.query(text).then(
      (r) => ({ rows: r.rowCount, warnings: r.warnings?.map((w) => w.message) }),
      (error: unknown) => ({ error: describeError(error) }),
    );
    measure("KE4", {
      command: text,
      ms: Date.now() - started,
      answer,
      memberMiBBefore: before,
      memberMiBAfter: memoryMiB(fixture.container),
      B: ETCD_READ_BOUNDS.byteBudget,
      C: ETCD_READ_BOUNDS.cellLimit,
      M: ETCD_RECEIVE_CAP_BYTES,
    });
    must(!("error" in answer), `a bounded read failed: ${JSON.stringify(answer)}`);
  }
  await provider.disconnect();
  for (const queryTimeout of [5000, 2000, ETCD_READ_BOUNDS.watchMarginMs]) {
    // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
    const short = await open(connectionFor(fixture), undefined, queryTimeout);
    // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
    const revision = String(rowsOf(await short.query("endpoint status"))[0].raft_index ?? "");
    for (let run = 0; run < 10; run++) {
      const started = Date.now();
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      const answer = await short.query("watch /ke5/ --prefix --rev=2").then(
        (r) => `${r.rowCount} events`,
        (error: unknown) => describeError(error),
      );
      measure("KE5", { queryTimeout, run, ms: Date.now() - started, answer, revision });
    }
    // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
    await short.disconnect();
  }
}

function memoryMiB(container: string): number {
  const usage = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", container], {
    encoding: "utf8",
  }).trim();
  const [amount, unit] = /^([\d.]+)\s*([KMG]i?B)/.exec(usage)?.slice(1) ?? ["0", "MiB"];
  return Number(amount) * (unit.startsWith("G") ? 1024 : unit.startsWith("K") ? 1 / 1024 : 1);
}

/** Seeds libredb-etcd-measure through its gateway: KE1's fixture, KE4's values and KE5's history. */
async function seedMeasure(fixture: Fixture): Promise<void> {
  const gateway = gatewayFor(fixture);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const pairs: Array<readonly [string, string]> = [];
  for (let n = 0; n < 200_000; n++) pairs.push([`/a-flat/k${pad(n, 6)}`, "v"]);
  for (let g = 0; g < 1000; g++) for (let k = 0; k < 200; k++) pairs.push([`/big/g${pad(g, 4)}/k${pad(k, 3)}`, "v"]);
  for (let n = 0; n < 10; n++) pairs.push([`/mixed/x${n}`, "v"], [`/mixed/d${n}/y`, "v"]);
  await gatewayPutMany(gateway, pairs);
  // oxlint-disable-next-line no-await-in-loop -- the seed writes one batch at a time, in order.
  for (let n = 0; n < 20; n++) await gatewayPut(gateway, `/ke4/v1m/k${pad(n, 2)}`, "m".repeat(1024 * 1024));
  const big = "k".repeat(64 * 1024);
  await gatewayPutMany(
    gateway,
    Array.from({ length: 1000 }, (_, n) => [`/ke4/v64k/k${pad(n, 4)}`, big] as const),
    16,
  );
  await gatewayPutMany(
    gateway,
    Array.from({ length: 400 }, (_, n) => [`/ke5/k${pad(n, 3)}`, "h".repeat(16 * 1024)] as const),
    64,
  );
}

/** Review Focus 1 on libredb-etcd-rf: keys whose bytes or shape strain the path model, on every surface. */
async function strainedKeys(fixture: Fixture): Promise<void> {
  const gateway = gatewayFor(fixture);
  const enc = (text: string) => new TextEncoder().encode(text);
  const keys: Uint8Array[] = [
    enc("/a//b"),
    enc("/a//c"),
    enc("/app/"),
    enc("/app/x"),
    enc("/g/"),
    enc("/g/x"),
    enc("/"),
    new Uint8Array([...enc("/nu/"), 0xff, ...enc("/x")]),
    new Uint8Array([0xff, ...enc("/k")]),
    new Uint8Array([...enc("/nu2/a"), 0xfe]),
    enc("/q/a b"),
    enc("/q/it's\"x"),
    enc("/q/new\nline"),
    enc("/q/#hash"),
    enc("/q/$HOME"),
    enc("-lead/k"),
    enc("/q/-dash"),
  ];
  const values = ["a b", 'it\'s "x"', "two\nlines", "#not a comment", "$HOME", "-v", "plain"];
  await gatewayPutMany(
    gateway,
    keys.map((key, index) => [key, values[index % values.length]] as const),
  );
  const provider = await open(connectionFor(fixture));
  const texts = keys.map((key) => decodeUtf8(key)).filter((text): text is string => text !== undefined);
  const limits = {
    maxLimit: 500,
    txnRangeLimit: ETCD_READ_BOUNDS.firstPageSize,
    maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
    maxWatchWindowMs: Number.POSITIVE_INFINITY,
  };
  await check(
    "Review Focus 1: the tree names no group after a key, with no replacement character or empty label",
    async () => {
      const groups = await provider.listObjects([], "prefix");
      const oracle = prefixGroups(keys).groups.map(groupLabel).sort();
      const names = groups.map((group) => group.name).sort();
      must(
        JSON.stringify(names) === JSON.stringify(oracle),
        `listed ${names.join(" | ")}; the rule gives ${oracle.join(" | ")}`,
      );
      must(
        names.every((name) => name.length > 0 && !name.includes("\uFFFD")),
        names.join(" | "),
      );
      return names.join(" | ");
    },
  );
  await check(
    "Review Focus 1: the Keys panel lists every UTF-8 key exactly and counts the rest as skipped",
    async () => {
      const seen: string[] = [];
      let skipped = 0;
      let cursor = "0";
      do {
        // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
        const page = await (provider.scanKeysPage as NonNullable<DatabaseProvider["scanKeysPage"]>)({
          cursor,
          count: 4,
        });
        seen.push(...page.keys);
        skipped += page.skipped?.count ?? 0;
        cursor = page.cursor;
      } while (cursor !== "0");
      must(JSON.stringify([...seen].sort()) === JSON.stringify([...texts].sort()), `listed ${JSON.stringify(seen)}`);
      must(skipped === keys.length - texts.length, `skipped ${skipped}`);
      must(
        seen.every((key) => !key.includes("\uFFFD")),
        "a replacement character reached the panel",
      );
      return `${seen.length} keys, ${skipped} skipped`;
    },
  );
  for (const text of texts) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
    await check(`Review Focus 1: ${JSON.stringify(text)} addresses its own bytes on every surface`, async () => {
      const typed = `get ${text.startsWith("-") ? "-- " : ""}${quoteWord(text)}`;
      const parsed = parseEtcdCommand(typed, limits);
      must(
        parsed.ok && parsed.parsed.command.kind === "get" && sameBytes(parsed.parsed.command.key, encodeKey(text)),
        `${typed} does not parse back to the key`,
      );
      const row = rowsOf(await provider.query(typed))[0];
      must(row?.key === text, `the grid shows ${JSON.stringify(row?.key)}`);
      const source = (await provider.readObjectSource?.([text], "key")) as ObjectSourceDocument;
      const metadata = source.parts[1];
      must(
        metadata !== undefined && "text" in metadata && JSON.parse(metadata.text).key === text,
        "the Source tab's metadata names another key",
      );
      // Every value here is text on a read-write connection without RBAC, so each key is offered for edit.
      const first = source.parts[0];
      must("text" in first && first.edit?.offered === true, `the Source part offers no edit: ${JSON.stringify(first)}`);
      const edited = `${first.text} edited`;
      const built = await provider.buildObjectEdit?.({ path: [text], kind: "key", partId: first.id, text: edited });
      must(built?.built === true, `no plan: ${JSON.stringify(built)}`);
      const outcome = await provider.applyObjectEdit?.(built.plan);
      must(outcome?.outcome === "applied", `the apply answered ${JSON.stringify(outcome)}`);
      must(new TextDecoder().decode(await gatewayGet(gateway, text)) === edited, "the apply wrote other bytes");
      // Flags before `--`: after it every word is an argument, `--prefix` included (spec 5.1.3).
      const dashes = text.startsWith("-") ? "-- " : "";
      const confirmation = etcdTypedConfirmation(`del --prefix ${dashes}${quoteWord(text)}`);
      must(confirmation?.type === "text", `the typed confirmation is ${JSON.stringify(confirmation)}`);
      if (/[\u0000-\u001f]/.test(text)) {
        // A key holding a control character is typed in Go %q quoting under either rule (spec 5.5).
        must(JSON.parse(confirmation.text) === text, `the typed text ${confirmation.text} is not the key's %q form`);
      } else {
        const retyped = parseEtcdCommand(`del --prefix ${dashes}${confirmation.text}`, limits);
        must(
          retyped.ok && retyped.parsed.command.kind === "del" && sameBytes(retyped.parsed.command.key, encodeKey(text)),
          `the typed text ${confirmation.text} reads back as another key`,
        );
      }
      return "grid, Source tab, edit and typed confirmation agree";
    });
  }
  await check("Review Focus 1: a key no path can carry appears in base64 only", async () => {
    const result = await provider.query("get /nu/ --prefix");
    const row = rowsOf(result)[0];
    must(row?.key_encoding === "base64" && sameBytes(fromB64(String(row.key)), keys[7]), JSON.stringify(row));
    return JSON.stringify(row);
  });
  await check(
    "Review Focus 1: every generated read and every commented form parses back to the group's bytes",
    async () => {
      const groups = await provider.listObjects([], "prefix");
      for (const group of groups) {
        const expected = prefixRange(group.name.slice(0, -1));
        for (const text of [
          generateTableQuery(group.path, provider.getCapabilities(), undefined, { readRanges: group.readRanges }),
          generateSelectQuery(group.path, [], provider.getCapabilities(), { readRanges: group.readRanges }),
        ]) {
          const first = parseEtcdCommand(text, limits);
          must(
            first.ok && first.parsed.command.kind === "get",
            `the runnable line of ${group.name} does not parse: ${text}`,
          );
          const range = commandRange(first.parsed.command);
          must(
            sameBytes(range.key, expected.key) &&
              sameBytes(range.rangeEnd ?? new Uint8Array(), expected.rangeEnd ?? new Uint8Array()),
            `the read of ${group.name} addresses other bytes`,
          );
          for (const form of commentedForms(text)) {
            const uncommented = parseEtcdCommand(form, limits);
            must(uncommented.ok, `the form ${JSON.stringify(form)} of ${group.name} does not parse once uncommented`);
          }
        }
      }
      return `${groups.length} groups`;
    },
  );
  await provider.disconnect();
}

/**
 * The commented forms of a Generate Command text (spec 6.4, section 10), in the layout
 * `tests/unit/lib/query-generators.test.ts` pins: the runnable read first, then each other form as a block
 * of comment lines, the blocks apart by an empty line, a form that spans lines (a txn, a quoted newline)
 * commented on every physical line, and a blank line inside a form written as a bare `#`. Each block is
 * uncommented as a whole; the note a group with no readable piece gets is not a form.
 */
function commentedForms(text: string): string[] {
  const blocks: string[][] = [[]];
  for (const line of text.split("\n")) {
    if (line === "") blocks.push([]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks
    .filter(
      (block) =>
        block.length > 0 &&
        block.every((line) => line.startsWith("#")) &&
        !block[0].startsWith("# No read is written for "),
    )
    .map((block) => block.map((line) => (line === "#" ? "" : line.slice(2))).join("\n"));
}

/** D-ORCH-1: a second run of every one-shot changes nothing, each with a control that shows the probe sees a change. */
async function idempotence(): Promise<void> {
  const compose = (args: readonly string[]) =>
    execFileSync("docker", ["compose", "-p", "etcd-lane-e", "-f", "database-compose.yml", ...args], {
      cwd: LANE_E,
      encoding: "utf8",
    });
  const wait = (containers: readonly string[]) =>
    execFileSync("docker", ["wait", ...containers], { encoding: "utf8" })
      .trim()
      .split("\n");
  const state = (fixture: Fixture) => {
    const target = etcdctlTarget(fixture);
    const status = parseEtcdctlJson<Array<{ Status: { header: { revision: string | number } } }>>(
      etcdctl(target, ["endpoint", "status", "-w", "json"]),
    );
    // etcdctl 3.7.2 takes --count-only with -w fields only ("--count-only is only for `--write-out=fields`").
    const count = /^"Count" : (\d+)$/m.exec(
      etcdctl(target, ["get", "", "--prefix", "--count-only", "-w", "fields"]),
    )?.[1];
    must(count !== undefined, `etcdctl printed no Count for ${fixture.container}`);
    // etcdctl 3.7.2 prints "Authentication Status: true" and "AuthRevision: <n>".
    const authRevision = fixture.auth ? /^AuthRevision: (\d+)$/m.exec(etcdctl(target, ["auth", "status"]))?.[1] : "off";
    must(authRevision !== undefined, `etcdctl printed no AuthRevision for ${fixture.container}`);
    const auth = authRevision;
    return { revision: String(status[0].Status.header.revision), count: String(count), auth };
  };
  const caHash = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "etcd-live-ca-"));
    execFileSync("docker", ["cp", "libredb-etcd-auth:/certs/ca.pem", path.join(directory, "ca.pem")]);
    const digest = createHash("sha256")
      .update(readFileSync(path.join(directory, "ca.pem")))
      .digest("hex");
    rmSync(directory, { recursive: true, force: true });
    return digest;
  };
  const services: ReadonlyArray<readonly [ServiceName, readonly string[], readonly string[], readonly string[]]> = [
    ["etcd", [], ["etcd-seed"], ["libredb-etcd-seed"]],
    ["etcd-cluster", ["--profile", "etcd-cluster"], ["etcd-cluster-seed"], ["libredb-etcd-cluster-seed"]],
    [
      "etcd-auth",
      ["--profile", "etcd-auth"],
      ["etcd-auth-certs", "etcd-auth-init"],
      ["libredb-etcd-auth-certs", "libredb-etcd-auth-init"],
    ],
    [
      "etcd-auth-password",
      ["--profile", "etcd-auth"],
      ["etcd-auth-password-init"],
      ["libredb-etcd-auth-password-init"],
    ],
  ];
  for (const [name, profile, oneShots, containers] of services) {
    const fixture = FIXTURES[name];
    // oxlint-disable-next-line no-await-in-loop -- each one-shot runs again against its own fixture, one after another, so each probe sees one step.
    const gateway = await rootGateway(fixture);
    // oxlint-disable-next-line no-await-in-loop -- each one-shot runs again against its own fixture, one after another, so each probe sees one step.
    await check(`D-ORCH-1 ${name}: the control, a scratch write, moves the revision the probe reads`, async () => {
      const before = state(fixture);
      await gatewayPut(gateway, `${SCRATCH_PREFIX}idempotence`, "control");
      const after = state(fixture);
      await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
      must(after.revision !== before.revision, "the probe did not see a write");
      return `${before.revision} to ${after.revision}`;
    });
    if (fixture.auth) {
      // oxlint-disable-next-line no-await-in-loop -- each one-shot runs again against its own fixture, one after another, so each probe sees one step.
      await check(`D-ORCH-1 ${name}: the control, a grant, moves the AuthRevision the probe reads`, async () => {
        const before = state(fixture).auth;
        await gatewayRoleWith(gateway, "libredb-live-idem", [
          { type: "READ", key: new TextEncoder().encode(`${SCRATCH_PREFIX}idem`) },
        ]);
        await gatewayRemove(gateway, [], ["libredb-live-idem"]);
        const after = state(fixture).auth;
        must(after !== before, "the probe did not see an auth change");
        return `${before} to ${after}`;
      });
    }
    const baseline = state(fixture);
    const ca = name === "etcd-auth" ? caHash() : "";
    // oxlint-disable-next-line no-await-in-loop -- each one-shot runs again against its own fixture, one after another, so each probe sees one step.
    await check(`D-ORCH-1 ${name}: a second run of ${oneShots.join(" and ")} changes nothing`, () => {
      compose([...profile, "up", "-d", ...oneShots]);
      const codes = wait(containers);
      must(
        codes.every((code) => code === "0"),
        `exit codes ${codes.join(" ")}`,
      );
      const again = state(fixture);
      must(
        JSON.stringify(again) === JSON.stringify(baseline),
        `before ${JSON.stringify(baseline)}, after ${JSON.stringify(again)}`,
      );
      if (name === "etcd-auth") must(caHash() === ca, "the CA changed");
      return JSON.stringify(again);
    });
  }
  await check(
    "D-ORCH-1: the control for the CA, a fresh volume, generates a different CA while a second run keeps it",
    () => {
      const images = parseYaml(readFileSync(path.join(LANE_E, "database-compose.yml"), "utf8")).services as Record<
        string,
        { image: string }
      >;
      const image = images["etcd-auth-certs"].image;
      const run = () =>
        execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            "libredb-etcd-live-certs-control",
            "--cpus",
            "0.5",
            "--memory",
            "64m",
            "-v",
            "libredb-etcd-live-certs-control:/certs",
            "-v",
            `${LANE_E}/docker/etcd:/etcd:ro`,
            "--entrypoint",
            "sh",
            image,
            "-c",
            "sh /etcd/certs.sh /certs >/dev/null && sha256sum /certs/ca.pem",
          ],
          { encoding: "utf8" },
        ).trim();
      const first = run();
      const second = run();
      execFileSync("docker", ["volume", "rm", "libredb-etcd-live-certs-control"]);
      const fresh = run();
      execFileSync("docker", ["volume", "rm", "libredb-etcd-live-certs-control"]);
      must(first === second, "a second run regenerated the CA");
      must(fresh !== first, "a fresh volume generated the same CA, so the probe cannot see a change");
      return "kept on a rerun, different on a fresh volume";
    },
  );
}

/** KE13 and Review Focus 3 on the cluster, run in a container on the compose network by --drive-cluster-container. */
async function clusterByName(): Promise<void> {
  const stdinLines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffered = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else stdinLines.push(line);
    }
  });
  const request = (line: string) => {
    console.log(`REQUEST ${line}`);
    return new Promise<string>((resolve) =>
      stdinLines.length > 0 ? resolve(stdinLines.shift() as string) : waiters.push(resolve),
    );
  };
  // The stdin listener above keeps the event loop alive, and the host never ends this process's stdin,
  // so it is released once the run is done; otherwise the container would never exit.
  try {
    const fixture: Fixture = { ...FIXTURES["etcd-cluster"], host: "etcd-cluster", port: 2379 };
    const provider = await open(connectionFor(fixture));
    const answering = async () => {
      const status = rowsOf(await provider.query("endpoint status"))[0];
      const members = rowsOf(await provider.query("member list --consistency=s"));
      return String(members.find((member) => member.id === status.id)?.name ?? "?");
    };
    const first = await answering();
    // Each write's answer and when it came: the longest pause between two answers is the failover the
    // writer saw, which happens inside the host's `docker stop`, not after it.
    const writes: Array<{ key: string; answer: string; at: number }> = [];
    // Aborted once the reads after the stop have answered, which ends the writer's loop.
    const writing = new AbortController();
    const writer = (async () => {
      for (let n = 0; !writing.signal.aborted; n++) {
        const key = `${SCRATCH_PREFIX}rf3/${n}`;
        // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
        const answer = await provider.query(`put ${key} v`).then(
          () => "applied",
          (error: unknown) => describeError(error),
        );
        writes.push({ key, answer, at: Date.now() });
        // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const watching = provider.query(`watch ${SCRATCH_PREFIX}rf3/ --prefix --command-timeout=20s`).then(
      (r) => `${r.rowCount} events`,
      (error: unknown) => `error: ${describeError(error)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stoppedAt = Date.now();
    await request(`stop ${first}`);
    const stopReturnedAt = Date.now();
    let recoveredMs = -1;
    let lostReads = 0;
    for (let attempt = 0; attempt < 100 && recoveredMs < 0; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      const ok = await provider.query("get /config/a").then(
        () => true,
        () => false,
      );
      if (ok) recoveredMs = Date.now() - stopReturnedAt;
      else lostReads++;
      // oxlint-disable-next-line no-await-in-loop -- a measurement: each run is timed alone, one after another.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    writing.abort();
    await writer;
    const second = await answering();
    const gaps = writes.slice(1).map((write, index) => write.at - writes[index].at);
    const maxWriteGapMs = Math.max(...gaps);
    const failedWrites = writes.filter((write) => write.answer !== "applied").length;
    measure("KE13", {
      stopped: first,
      answeringAfter: second,
      stopMs: stopReturnedAt - stoppedAt,
      firstReadAfterStopMs: recoveredMs,
      lostReads,
      writes: writes.length,
      failedWrites,
      maxWriteGapMs,
      runtime: process.version,
    });
    await check(
      "KE13 and Review Focus 3: the next command reaches another member through pick_first, with no reconnect",
      () => {
        must(recoveredMs >= 0, "no read answered after the member stopped");
        must(second !== first && second !== "?", `still answered by ${second}`);
        return `${first} stopped (docker stop took ${stopReturnedAt - stoppedAt} ms); ${second} answered the first read after it in ${recoveredMs} ms, ${lostReads} reads lost; the longest pause between two write answers was ${maxWriteGapMs} ms, ${failedWrites} of ${writes.length} writes failed`;
      },
    );
    await check(
      "Review Focus 3: a write that met the stop reports that it may have been applied, or was not sent",
      async () => {
        const failed = writes.filter((write) => write.answer !== "applied");
        for (const write of failed) {
          must(
            write.answer.includes("may have been applied") || write.answer.includes("ConnectionError"),
            `a failed write with neither sentence: ${write.answer}`,
          );
        }
        return `${writes.length} writes, ${failed.length} met the stop`;
      },
    );
    await check("Review Focus 3: the watch ends with an error naming the cause, not a quiet window", async () => {
      const outcome = await watching;
      must(outcome.startsWith("error"), `the watch outlived the member it streamed from without saying so: ${outcome}`);
      return outcome;
    });
    await request(`start ${first}`);
    await provider.query(`del ${SCRATCH_PREFIX}rf3/ --prefix`);
    await provider.disconnect();
  } finally {
    process.stdin.destroy();
  }
}

/** Host side of KE13: runs the bundled check in a container on the compose network and answers its requests. */
async function driveClusterContainer(bundleDirectory: string): Promise<void> {
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--name",
      "libredb-etcd-live-ke13",
      "--network",
      "etcd-lane-e_default",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "-v",
      `${bundleDirectory}:/ke13:ro`,
      "node:26.10.0-trixie-slim",
      "node",
      "/ke13/etcd-live-check.mjs",
      "--in-network",
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      console.log(line);
      const request = /^REQUEST (stop|start) (libredb-etcd-cluster-[123])$/.exec(line);
      if (request?.[1] === "stop") {
        execFileSync("docker", ["stop", request[2]]);
        child.stdin.write("ok\n");
      } else if (request?.[1] === "start") {
        dockerStart(request[2]);
        child.stdin.write("ok\n");
      }
    }
  });
  const code = await new Promise<number>((resolve) => child.on("close", (exit) => resolve(exit ?? 1)));
  if (code !== 0) process.exitCode = 1;
}

// ============================================================================
// Main
// ============================================================================

let current: Fixture = FIXTURES.etcd;
const currentFixture = () => current;

async function main(): Promise<void> {
  if (flag("--drive-cluster-container")) return driveClusterContainer(option("--drive-cluster-container") as string);
  if (flag("--in-network")) return clusterByName();
  if (flag("--idempotence")) return idempotence();
  if (flag("--ke16")) return ke16(FIXTURES.etcd);
  const name = (option("--service") ?? "etcd") as ServiceName;
  const fixture = FIXTURES[name];
  if (fixture === undefined) throw new Error(`Unknown service ${name}: one of ${Object.keys(FIXTURES).join(", ")}`);
  current = fixture;
  if (name === "rf") return strainedKeys(fixture);
  if (name === "measure") {
    if (flag("--seed")) return seedMeasure(fixture);
    return measureSuite(fixture);
  }
  const target = etcdctlTarget(fixture);
  const before = snapshot(target, fixture.auth);
  await check(`${name}: the snapshot holds the protected subtree and compact_rev_key (the control)`, () => {
    must(
      before.some((line) => line.startsWith(`kv ${b64("/registry/pods/default/nginx")} `)),
      "no /registry/ key in the snapshot",
    );
    must(
      before.some((line) => line.startsWith(`kv ${b64("compact_rev_key")} `)),
      "no compact_rev_key in the snapshot",
    );
    return `${before.length} lines`;
  });
  const gateway = await rootGateway(fixture);
  await fixtureFacts(fixture, name);
  if (name === "etcd-cluster" && flag("--ke14")) await ke14(fixture);
  if (name === "etcd-cluster" && flag("--ke15")) await ke15(fixture);
  if (name === "etcd-auth-password" && flag("--ke12")) await ke12(fixture);
  if (name === "etcd" || name === "etcd-cluster") {
    const provider = await open(connectionFor(fixture));
    await surfaces(provider, name, true);
    await scratchWrites(provider, gateway, name);
    await kubernetesRefusals(provider, name);
    await provider.disconnect();
    await readOnlyRefusals(fixture, name, {});
    await transportChecks(fixture, name, {});
  }
  if (name === "etcd-auth") {
    const root = await open(
      connectionFor(fixture, {
        ssl: { mode: "verify-full", caCert: cert("ca.pem"), clientCert: cert("root.crt"), clientKey: cert("root.key") },
      }),
    );
    await surfaces(root, "etcd-auth as root", true);
    await kubernetesRefusals(root, "etcd-auth as root");
    for (const type of ["compact", "defragment", "disarm"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await check(`etcd-auth: ${type} as root answers`, async () => (await root.runMaintenance(type)).message);
    }
    await root.disconnect();
    const reader = await open(
      connectionFor(fixture, {
        ssl: {
          mode: "verify-full",
          caCert: cert("ca.pem"),
          clientCert: cert("reader.crt"),
          clientKey: cert("reader.key"),
        },
      }),
    );
    await surfaces(reader, "etcd-auth as reader", false);
    await refusal(
      "etcd-auth: the reader's lease revoke of an unreadable lease is refused",
      ["QueryError", "DatabaseConfigError"],
      [],
      () => reader.query("lease revoke 694d8147df1dc4c8"),
    );
    for (const type of ["compact", "defragment"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time against a live server, in order, so each snapshot and socket census sees one step.
      await refusal(
        `etcd-auth: ${type} as the reader names the root role`,
        ["QueryError"],
        ["need the etcd root role"],
        () => reader.runMaintenance(type),
      );
    }
    // A disarm reads the alarms and deactivates each, as etcdctl's does, and the reader may read them
    // (measured on 3.7.2), so with none raised nothing that needs root is sent. The refusal of a DEACTIVATE
    // is driven on this run's own server (Task 22 Step 15), where raising an alarm touches no fixture.
    await check(
      "etcd-auth: disarm as the reader, with no alarm raised, answers that nothing was disarmed",
      async () => {
        must(etcdctl(etcdctlTarget(fixture), ["alarm", "list"]).trim() === "", "an alarm is raised on etcd-auth");
        const result = await reader.runMaintenance("disarm");
        must(result.message === "No alarm was raised, so nothing was disarmed.", result.message);
        return result.message;
      },
    );
    await check("etcd-auth: endpoint health as the reader counts PermissionDenied as healthy", async () => {
      const row = rowsOf(await reader.query("endpoint health"))[0];
      must(row.health === true || row.health === "true", JSON.stringify(row));
      return JSON.stringify(row);
    });
    await reader.disconnect();
    await transportChecks(fixture, name, {
      ssl: {
        mode: "verify-full",
        caCert: cert("ca.pem"),
        clientCert: cert("reader.crt"),
        clientKey: cert("reader.key"),
      },
    });
  }
  if (name === "etcd-auth-password") {
    const reader = await open(connectionFor(fixture, { user: "reader", password: cert("reader.password") }));
    await surfaces(reader, "etcd-auth-password as reader", false);
    await reader.disconnect();
    await readOnlyRefusals(fixture, name, { user: "root", password: cert("root.password") });
    await tokenEvents(fixture);
    await unusualGrants(fixture);
    await transportChecks(fixture, name, { user: "reader", password: cert("reader.password") });
  }
  await gatewayDeletePrefix(gateway, SCRATCH_PREFIX);
  const after = snapshot(target, fixture.auth);
  await check(`${name}: E15, the key space outside the scratch prefix is unchanged`, () => {
    const diff = snapshotDiff(before, after);
    must(diff === "", diff);
    return `${after.length} lines, identical`;
  });
  if (fixture.auth) {
    // The snapshot sets the check's own users and roles aside, so this says none of them is left over.
    await check(`${name}: no user or role of the check's own is left`, () => {
      const names = [
        ...etcdctl(target, ["user", "list"]).split("\n"),
        ...etcdctl(target, ["role", "list"]).split("\n"),
      ].map((line) => line.trim());
      const left = names.filter((entry) => entry.startsWith("libredb-live-"));
      must(left.length === 0, `left behind: ${left.join(", ")}`);
      return `${names.filter(Boolean).length} users and roles, none the check's`;
    });
  }
}

main()
  .catch((error: unknown) => {
    outcomes.push({ check: "run", ok: false, detail: describeError(error) });
    console.log(`FAIL run: ${describeError(error)}`);
  })
  .finally(() => {
    const failed = outcomes.filter((outcome) => !outcome.ok);
    console.log(`${outcomes.length - failed.length} of ${outcomes.length} checks passed`);
    if (failed.length > 0) process.exitCode = 1;
  });
