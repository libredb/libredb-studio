/**
 * What the Oxia evidence harness (`tests/live/oxia-evidence.ts`), the integration test over its captures
 * (`tests/integration/db/oxia-provider.test.ts`) and the live check read: the compose fixtures, the named read-only
 * runs and how one run is played over a transport (SB3-5.4, SB3-5.5, contract section 20.5).
 *
 * A run is played through the real provider and the real adapter (decision D19): over a recording transport around
 * the real one it makes a capture, and over the recorded wire it must answer what it answered live. Its summary is the
 * value or the failure with nothing that changes between two plays, and never the token.
 *
 * Nothing here reaches a server but through the transport it is handed; it imports no gRPC package, and the only
 * file of tests/live that writes to an Oxia server is tests/live/oxia-seed-raw.ts. It loads under Node, because the
 * live check's Node run imports it: the object-surface assertion, which imports `bun:test`, is handed in by the Bun
 * players as `OxiaRunSteps` (ruling R30).
 */
import type { OxiaCallOptions, OxiaClient, OxiaSnapshot } from "@/lib/db/providers/keyvalue/oxia/client";
import { buildOxiaConnectionOptions } from "@/lib/db/providers/keyvalue/oxia/connection-options";
import { createGrpcOxiaClient, type OxiaWireTransport } from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { OXIA_KEY_SCAN } from "@/lib/db/providers/keyvalue/oxia/key-scan";
import type { KeyScanPage } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import type { ObjectSurfaceExpectation } from "../helpers/object-surface-conformance";
import { oxiaConnection } from "../helpers/oxia-connection";

export const OXIA_MARKER_KEY = "/libredb-fixture/seeded";

export type OxiaCaptureSet = "0.16.10" | "0.17.1" | "0.16.10-natural" | "0.16.10-natural-blind" | "0.16.10-auth";

export interface OxiaFixture {
  readonly set: OxiaCaptureSet;
  /** "127.0.0.1:6648": the address the fixture publishes on the host. */
  readonly target: string;
  /** "libredb-oxia": the compose container. */
  readonly container: string;
  /** The marker's value on a seeded server; undefined for the auth fixture, which no one-shot seeds. */
  readonly marker?: "full" | "small" | "blind";
  readonly order: "hierarchical" | "natural";
  readonly shards: number;
}

export const OXIA_FIXTURES: readonly OxiaFixture[] = [
  {
    set: "0.16.10",
    target: "127.0.0.1:6648",
    container: "libredb-oxia",
    marker: "full",
    order: "hierarchical",
    shards: 3,
  },
  {
    set: "0.17.1",
    target: "127.0.0.1:6668",
    container: "libredb-oxia-017",
    marker: "full",
    order: "hierarchical",
    shards: 3,
  },
  {
    set: "0.16.10-natural",
    target: "127.0.0.1:6658",
    container: "libredb-oxia-natural",
    marker: "small",
    order: "natural",
    shards: 2,
  },
  {
    set: "0.16.10-natural-blind",
    target: "127.0.0.1:6659",
    container: "libredb-oxia-natural-blind",
    marker: "blind",
    order: "natural",
    shards: 2,
  },
  {
    set: "0.16.10-auth",
    target: "127.0.0.1:6678",
    container: "libredb-oxia-auth",
    order: "hierarchical",
    shards: 3,
  },
];

/** The token files of the auth fixture's volume (docker/oxia/README.md), by the name a run asks for. */
export const OXIA_TOKEN_FILES = [
  "token.jwt",
  "token-expired.jwt",
  "token-bad-signature.jwt",
  "token-bad-audience.jwt",
  "token-bad-issuer.jwt",
] as const;
export type OxiaTokenFile = (typeof OXIA_TOKEN_FILES)[number];

/** What a run needs besides the fixture: the auth fixture's material, read by the caller from a copy of the volume. */
export interface OxiaRunMaterial {
  readonly ca?: string;
  readonly otherCa?: string;
  readonly tokens?: Readonly<Record<string, string>>;
}

/** A run through the provider: the connection it is built from and what it does. */
export interface OxiaProviderRun {
  readonly kind: "provider";
  /** The capture's file name without ".json". */
  readonly name: string;
  readonly sets: readonly OxiaCaptureSet[];
  connection(fixture: OxiaFixture, material: OxiaRunMaterial): DatabaseConnection;
  run(provider: OxiaProvider, steps: OxiaRunSteps): Promise<unknown>;
}

/** A run on the adapter alone: the auth, TLS and health families. */
export interface OxiaAdapterRun {
  readonly kind: "adapter";
  readonly name: string;
  readonly sets: readonly OxiaCaptureSet[];
  connection(fixture: OxiaFixture, material: OxiaRunMaterial): DatabaseConnection;
  run(client: OxiaClient, call: () => OxiaCallOptions): Promise<unknown>;
}

export type OxiaRun = OxiaProviderRun | OxiaAdapterRun;

/** What a run takes from its player rather than from this module, so that this module loads under Node (ruling R30). */
export interface OxiaRunSteps {
  /** The `conformance` run's step: `assertObjectSurface` over `OXIA_CONFORMANCE`, from a Bun player. */
  readonly assertSurface?: (provider: OxiaProvider) => Promise<void>;
}

/** SB2-7.6's expectation, the one the harness records and the integration test replays. */
export const OXIA_CONFORMANCE: ObjectSurfaceExpectation = {
  containers: [],
  kinds: { shard: 3 },
  sampleObject: { path: ["0"], kind: "shard" },
  absentSource: { path: ["/no/such/key"], kind: "key" },
  keyBrowserSample: { path: ["/admin/policies/public"], kind: "key" },
  // `shard`, the only listed kind, declares no hasColumns and its bulk read answers `{ details: [] }` (SB2-7.6, R26).
  noColumnKinds: true,
};

const H = "0.16.10";
const S = "0.17.1";
const N = "0.16.10-natural";
const B = "0.16.10-natural-blind";
const A = "0.16.10-auth";
/** Every call of a run and every play: the deadline is long enough for the whole namespace walk of a fixture. */
const PLAY_TIMEOUT_MS = 30_000;
/** A walk to the end stops here: no fixture's walk takes this many pages. */
const MAX_PAGES = 1_000;
/** The length from which bytes of one repeated value are summarised as { $filled }, as tests/helpers/oxia-wire.ts writes them. */
const FILLED_FROM = 65_536;

function endpoint(target: string): { readonly host: string; readonly port: number } {
  const colon = target.lastIndexOf(":");
  return { host: target.slice(0, colon), port: Number(target.slice(colon + 1)) };
}

/** A plaintext connection to the fixture's own address. */
function plain(fixture: OxiaFixture): DatabaseConnection {
  return oxiaConnection(endpoint(fixture.target));
}

function token(material: OxiaRunMaterial, file: OxiaTokenFile): string {
  const value = material.tokens?.[file];
  if (value === undefined) throw new Error(`oxia-live-support: the material holds no ${file}`);
  return value;
}

function certificate(material: OxiaRunMaterial, which: "ca" | "otherCa"): string {
  const value = material[which];
  if (value === undefined) throw new Error(`oxia-live-support: the material holds no ${which}`);
  return value;
}

/**
 * The auth fixture over TLS: `host` (localhost unless named), `verify-full` against `ca`, the token if any, and
 * `dataServers` when the run dials another name than the one the fixture advertises (R27).
 */
function secured(
  fixture: OxiaFixture,
  material: OxiaRunMaterial,
  options: {
    readonly host?: string;
    readonly ca?: "ca" | "otherCa";
    readonly token?: OxiaTokenFile;
    readonly dataServers?: string;
  },
): DatabaseConnection {
  return oxiaConnection({
    host: options.host ?? "localhost",
    port: endpoint(fixture.target).port,
    ssl: { mode: "verify-full", caCert: certificate(material, options.ca ?? "ca") },
    ...(options.token === undefined ? {} : { password: token(material, options.token) }),
    ...(options.dataServers === undefined ? {} : { dataServers: options.dataServers }),
  });
}

/** The default connection of a set: plaintext, or for the auth fixture TLS with the good token. */
function fixtureConnection(fixture: OxiaFixture, material: OxiaRunMaterial): DatabaseConnection {
  return fixture.set === A ? secured(fixture, material, { token: "token.jwt" }) : plain(fixture);
}

/** The snapshot without its read time, which differs between two plays. */
function snapshotFacts(snapshot: OxiaSnapshot): unknown {
  return {
    namespace: snapshot.namespace,
    shards: snapshot.shards.map((shard) => ({
      id: shard.id,
      minHash: shard.minHash,
      maxHash: shard.maxHash,
      leader: shard.leader.address,
      bootstrap: shard.leader.bootstrap,
    })),
  };
}

/** Pages of the Keys panel from the start until the walk ends, or `limit` pages. */
async function keyPages(
  provider: OxiaProvider,
  options: { readonly count: number; readonly pattern?: string; readonly limit?: number },
): Promise<KeyScanPage[]> {
  const pages: KeyScanPage[] = [];
  let cursor = "0";
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page resumes from the previous page's cursor.
    const page = await provider.scanKeysPage({
      cursor,
      count: options.count,
      ...(options.pattern === undefined ? {} : { pattern: options.pattern }),
    });
    pages.push(page);
    cursor = page.cursor;
    if (pages.length >= MAX_PAGES) throw new Error("oxia-live-support: a walk did not end within its page bound");
  } while (cursor !== "0" && (options.limit === undefined || pages.length < options.limit));
  return pages;
}

function providerRun(
  name: string,
  sets: readonly OxiaCaptureSet[],
  run: (provider: OxiaProvider, steps: OxiaRunSteps) => Promise<unknown>,
  connection: (fixture: OxiaFixture, material: OxiaRunMaterial) => DatabaseConnection = fixtureConnection,
): OxiaProviderRun {
  return { kind: "provider", name, sets, connection, run };
}

function adapterRun(
  name: string,
  sets: readonly OxiaCaptureSet[],
  connection: (fixture: OxiaFixture, material: OxiaRunMaterial) => DatabaseConnection,
  run: (client: OxiaClient, call: () => OxiaCallOptions) => Promise<unknown>,
): OxiaAdapterRun {
  return { kind: "adapter", name, sets, connection, run };
}

/** A console run: the one command, as the editor takes it. */
function consoleRun(name: string, sets: readonly OxiaCaptureSet[], command: string): OxiaProviderRun {
  return providerRun(name, sets, (provider) => provider.query(command));
}

/** The console text of every console run, so a test can hold that each one parses. */
export const OXIA_RUN_COMMANDS: Readonly<Record<string, string>> = {
  "list-prefix-admin": "list --prefix /admin/",
  "list-root-level": "list -s / -e //",
  "list-children-a-b": "list -s /a/b/ -e /a/b//",
  "list-children-trail": "list -s /trail/ -e /trail//",
  "get-json": "get /values/json",
  "get-json-int64": "get /values/json-int64",
  "get-text-utf8": "get /values/text-utf8",
  "get-text-c0": "get /values/text-c0",
  "get-binary": "get /values/binary-non-utf8",
  "get-protobuf-like": "get /values/protobuf-like",
  "get-empty": "get /values/empty",
  "get-text-100KiB": "get /values/text-100KiB",
  "get-binary-hex": "get --hex /values/binary-non-utf8",
  "get-floor": "get -t floor /a/b",
  "get-ceiling": "get -t ceiling /a/b",
  "get-lower": "get -t lower /a/b",
  "get-higher": "get -t higher /a/b",
  "get-miss": "get /no/such/key",
  "get-partition-key": "get -p tenant-a /pk/tenant-a/1",
  "get-over-cap": "get /values/over-cap",
  "range-scan-budget": "range-scan -s /values/p -e /values/q",
  "range-scan-over-cap": "range-scan -s /values/o -e /values/p",
};

const command = (name: string): string => OXIA_RUN_COMMANDS[name] as string;

/** The auth table's runs: health, then the snapshot, each outcome kept. */
function authRun(name: string, file?: OxiaTokenFile): OxiaAdapterRun {
  return adapterRun(
    name,
    [A],
    (fixture, material) => secured(fixture, material, file === undefined ? {} : { token: file }),
    async (client, call) => ({
      health: await outcome(client.health(call())),
      snapshot: await outcome(client.getSnapshot(call()).then(snapshotFacts)),
    }),
  );
}

/** A TLS run: one snapshot read over the connection. */
function tlsRun(
  name: string,
  options: { readonly host?: string; readonly ca: "ca" | "otherCa"; readonly dataServers?: string },
): OxiaAdapterRun {
  return adapterRun(
    name,
    [A],
    (fixture, material) => secured(fixture, material, { ...options, token: "token.jwt" }),
    async (client, call) => snapshotFacts(await client.getSnapshot(call())),
  );
}

export const OXIA_RUNS: readonly OxiaRun[] = [
  providerRun("assignments-default", [H, S, N, B], async () => "connected"),
  providerRun(
    "assignments-unknown-namespace",
    [H, S],
    async () => "connected",
    (fixture) => oxiaConnection({ ...endpoint(fixture.target), database: "no-such-namespace" }),
  ),
  providerRun("probe-order", [H, S, N, B], (provider) => provider.readObjectSource(["0"], "shard")),
  providerRun("probe-empty-namespace", [A], (provider) => provider.readObjectSource(["0"], "shard")),
  adapterRun("health-serving", [H, S, N, B, A], fixtureConnection, (client, call) => client.health(call())),
  providerRun("conformance", [H], async (provider, steps) => {
    if (steps.assertSurface === undefined)
      throw new Error("oxia-live-support: the conformance run needs the assertSurface step of a Bun player");
    await steps.assertSurface(provider);
    return "conformant";
  }),
  providerRun("list-first-pages", [H], (provider) => keyPages(provider, { count: 500, limit: 3 })),
  providerRun("list-full-walk", [S, N, B], (provider) => keyPages(provider, { count: 50 })),
  providerRun("list-prefix-admin", [H, S], async (provider) => {
    if (OXIA_KEY_SCAN.pattern !== "prefix")
      throw new Error("oxia-live-support: OXIA_KEY_SCAN no longer takes a prefix");
    return {
      pages: await keyPages(provider, { count: OXIA_KEY_SCAN.defaultCount, pattern: "/admin/" }),
      query: await provider.query(command("list-prefix-admin")),
    };
  }),
  consoleRun("list-root-level", [H, N], command("list-root-level")),
  consoleRun("list-children-a-b", [H, N], command("list-children-a-b")),
  consoleRun("list-children-trail", [H, N], command("list-children-trail")),
  providerRun("list-nul-keys", [H, N], (provider) =>
    keyPages(provider, { count: OXIA_KEY_SCAN.defaultCount, pattern: "/nul/" }),
  ),
  ...[
    "get-json",
    "get-json-int64",
    "get-text-utf8",
    "get-text-c0",
    "get-binary",
    "get-protobuf-like",
    "get-empty",
    "get-text-100KiB",
  ].map((name) => consoleRun(name, [H, S], command(name))),
  consoleRun("get-binary-hex", [H], command("get-binary-hex")),
  ...["get-floor", "get-ceiling", "get-lower", "get-higher"].map((name) => consoleRun(name, [H, N], command(name))),
  consoleRun("get-miss", [H], command("get-miss")),
  consoleRun("get-partition-key", [H], command("get-partition-key")),
  consoleRun("get-over-cap", [H, S], command("get-over-cap")),
  consoleRun("range-scan-budget", [H, S], command("range-scan-budget")),
  consoleRun("range-scan-over-cap", [H, S], command("range-scan-over-cap")),
  authRun("auth-no-token"),
  authRun("auth-good-token", "token.jwt"),
  authRun("auth-bad-signature", "token-bad-signature.jwt"),
  authRun("auth-bad-audience", "token-bad-audience.jwt"),
  authRun("auth-bad-issuer", "token-bad-issuer.jwt"),
  authRun("auth-expired", "token-expired.jwt"),
  tlsRun("tls-right-ca", { ca: "ca" }),
  tlsRun("tls-unrelated-ca", { ca: "otherCa" }),
  // Dialled by IP, the cluster advertising localhost:6678: a user dialling a cluster by IP lists it (R27).
  tlsRun("tls-ip-target", { host: "127.0.0.1", ca: "ca", dataServers: "localhost:6678" }),
];

/** The members of a failure a summary keeps: its class, its sentence and the Oxia classification when it has one. */
interface FailureFacts {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly category?: unknown;
  readonly authCause?: unknown;
  readonly tlsFailure?: unknown;
}

/** Bytes as tests/helpers/oxia-wire.ts writes them, object keys sorted, and every `executionTime` member dropped. */
function stable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const first = value[0] as number;
    return value.length >= FILLED_FROM && value.every((byte) => byte === first)
      ? { $filled: { byte: first, length: value.length } }
      : { $bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .filter((key) => key !== "executionTime" && fields[key] !== undefined)
        .sort()
        .map((key) => [key, stable(fields[key])]),
    );
  }
  return value;
}

function failure(error: unknown): unknown {
  const facts = (error ?? {}) as FailureFacts;
  const fields: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
  for (const key of ["category", "authCause", "tlsFailure"] as const)
    if (facts[key] !== undefined) fields[key] = facts[key];
  return stable(fields);
}

/** `{ ok: value }` or `{ error: { name, message, category?, authCause?, tlsFailure? } }`. */
async function outcome(work: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: stable(await work) };
  } catch (error) {
    return { error: failure(error) };
  }
}

function freshCall(): OxiaCallOptions {
  return { signal: new AbortController().signal, deadline: Date.now() + PLAY_TIMEOUT_MS };
}

/** Plays one run over a transport and answers its summary: the value or the failure, with nothing that changes between two plays. */
export async function playOxiaRun(
  run: OxiaRun,
  fixture: OxiaFixture,
  material: OxiaRunMaterial,
  transport: OxiaWireTransport,
  steps: OxiaRunSteps = {},
): Promise<unknown> {
  const connection = run.connection(fixture, material);
  let summary: unknown;
  if (run.kind === "provider") {
    const provider = new OxiaProvider(connection, { queryTimeout: PLAY_TIMEOUT_MS }, {}, (options) =>
      createGrpcOxiaClient(options, transport),
    );
    summary = await outcome(provider.connect().then(() => run.run(provider, steps)));
    await provider.disconnect();
  } else {
    const client = createGrpcOxiaClient(
      buildOxiaConnectionOptions(connection, { executionReadOnly: false, queryTimeout: PLAY_TIMEOUT_MS }),
      transport,
    );
    try {
      summary = await outcome(run.run(client, freshCall));
    } finally {
      client.close();
    }
  }
  const text = JSON.stringify(summary);
  for (const value of Object.values(material.tokens ?? {}))
    if (text.includes(value)) throw new Error(`oxia-live-support: the summary of ${run.name} holds a token`);
  return summary;
}

/** The first row of a get, or undefined on a miss. */
async function getRow(provider: OxiaProvider, key: string): Promise<Record<string, unknown> | undefined> {
  const result = await provider.query(`get ${key}`);
  return result.rows[0];
}

/** The read-only proof: the namespace's key count, and the version of the marker and of /versions/counter where it exists. */
export async function oxiaFingerprint(
  provider: OxiaProvider,
): Promise<{ readonly keys: number; readonly versions: Readonly<Record<string, string>> }> {
  const keys = new Set<string>();
  for (const page of await keyPages(provider, { count: OXIA_KEY_SCAN.maxCount }))
    for (const key of page.keys) keys.add(key);
  const versions: Record<string, string> = {};
  for (const key of [OXIA_MARKER_KEY, "/versions/counter"]) {
    // oxlint-disable-next-line no-await-in-loop -- two reads, in a fixed order.
    const row = await getRow(provider, key);
    if (row !== undefined) versions[key] = `${String(row.version_id)}/${String(row.modifications_count)}`;
  }
  return { keys: keys.size, versions };
}

/** Refuses a server that does not hold the marker with the fixture's value. */
export async function requireOxiaMarker(provider: OxiaProvider, fixture: OxiaFixture): Promise<void> {
  if (fixture.marker === undefined) throw new Error(`oxia-live-support: ${fixture.set} has no marker to check`);
  const row = await getRow(provider, OXIA_MARKER_KEY);
  if (row?.value !== fixture.marker)
    throw new Error(
      `oxia-live-support: ${fixture.target} does not hold the marker ${fixture.marker}; run the compose seed and tests/live/oxia-seed-raw.ts first.`,
    );
}
