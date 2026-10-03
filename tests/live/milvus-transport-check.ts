/**
 * The live check of the Milvus transport (vector-family spec E2, E3, E6, E7, E14, 5.9): the real provider modules
 * against the services of docker/milvus/README.md, one PASS or FAIL line per check, exit 1 on any FAIL.
 *
 *   T1  every call of a session arrives through a local forwarder, on one connection (E2)
 *   T2  proxy variables naming a counting listener record nothing (E2)
 *   T3  after a failing query, the management port's telemetry client list, read as root, is empty (E3)
 *   T4  TLS by name, by IP under the IP rule, mutual TLS, and the client certificates the preflight refuses (E6)
 *   T5  a silently dropped connection fails the first call after idle in about 6 s, and the next call reconnects (E7)
 *   T6  a call every 3 s for 75 s on the native TLS port meets no too_many_pings (E7)
 *   T7  the port share's 300 s idle close is met by a reconnect on the next call (E7), skipped with --skip-idle
 *   T8  a cancelled waiting query ends as cancelled within a second (E14)
 *   T9  every deadline shape, on both ports, reads as the deadline sentence (E14, R41 F7)
 *   T10 GetVersion reads 3.0.2 and passes every gate (5.9)
 *
 * Run by hand, never by `bun run test`:
 *   bun tests/live/milvus-transport-check.ts --certs <dir> [--skip-idle]
 *   bun build tests/live/milvus-transport-check.ts --target=node --outfile <file> && node <file> --certs <dir>
 * <dir> is a copy of the certificate volume outside the repository. Port 19091 is the management port, published on
 * loopback for T3 alone; the provider never dials it.
 *
 * The TLS server holds no seeded data, so T9's waiting query there waits on a collection of the check's own,
 * `libredb_evidence_check_wait`, which it creates empty and loaded over that server's REST listener (19541) before
 * T9 and drops after it; the provider's allowlist has no write.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import {
  buildMilvusConnectionOptions,
  milvusErrorConnection,
} from "@/lib/db/providers/vector/milvus/connection-options";
import { toProviderError } from "@/lib/db/providers/vector/milvus/errors";
import { createGrpcMilvusClient } from "@/lib/db/providers/vector/milvus/grpc-client";
import { readMilvusVersion, versionGateRefusal } from "@/lib/db/providers/vector/milvus/versions";

/** Milvus's documented default root credential (docker/milvus/README.md): no compose file sets it. */
const ROOT_CREDENTIAL = { user: "root", password: "Milvus" } as const;
const RUNTIME = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.versions.node}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let failures = 0;

function report(id: string, what: string, ok: boolean, seen: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${what} :: ${JSON.stringify(seen)}`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const certsDir = argument("--certs") ?? "";
const pem = (file: string) => readFileSync(path.join(certsDir, file), "utf8");

function options(overrides: Record<string, unknown>, queryTimeout = 30_000) {
  return buildMilvusConnectionOptions(
    {
      id: "check",
      name: "check",
      type: "milvus",
      createdAt: new Date(0),
      host: "127.0.0.1",
      port: 19530,
      ...ROOT_CREDENTIAL,
      ...overrides,
    } as never,
    { executionReadOnly: false, queryTimeout },
  );
}

const call = (signal = new AbortController().signal) => ({ db: "default", signal });

/** What a failure reads as, through the provider's error table. */
function sentence(
  error: unknown,
  opts: ReturnType<typeof options>,
): { readonly name: string; readonly message: string } {
  const mapped = toProviderError(error, {
    operation: "check",
    write: false,
    connection: milvusErrorConnection(opts),
    secretForms: opts.secretForms,
  });
  return { name: mapped.name, message: mapped.message };
}

/** A local forwarder to `port`: counts connections; `arm()` stops forwarding on the connections open now. */
async function forwarder(port: number) {
  const open = new Set<net.Socket>();
  const silenced = new Set<net.Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    const upstream = net.connect(port, "127.0.0.1");
    for (const end of [socket, upstream]) {
      open.add(end);
      end.on("error", () => undefined);
      end.on("close", () => open.delete(end));
    }
    socket.on("data", (chunk) => {
      if (!silenced.has(socket)) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!silenced.has(socket)) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    accepted: () => accepted,
    arm: () => {
      for (const socket of open) silenced.add(socket);
    },
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

const TLS_WAIT_COLLECTION = "libredb_evidence_check_wait";

/** A Query that waits on a guarantee timestamp two minutes ahead: on docs_int64, or on the TLS server's own collection. */
function waitingQuery(collection: "docs_int64" | typeof TLS_WAIT_COLLECTION = "docs_int64") {
  const seeded = collection === "docs_int64";
  return {
    collection_name: collection,
    expr: seeded ? "seq >= 0" : "id >= 0",
    output_fields: [seeded ? "seq" : "id"],
    query_params: [{ key: "limit", value: "1" }],
    guarantee_timestamp: (BigInt(Date.now() + 120_000) * BigInt(262_144)).toString(),
    consistency_level: "Customized",
    use_default_consistency: false,
  };
}

/** One REST call to the TLS server's own listener, as root, verified against the test CA. */
function tlsRest(route: string, body: object): Promise<{ code?: number; data?: unknown; message?: string }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "localhost",
        port: 19541,
        method: "POST",
        path: `/v2/vectordb/${route}`,
        ca: pem("ca.pem"),
        headers: {
          authorization: `Bearer ${ROOT_CREDENTIAL.user}:${ROOT_CREDENTIAL.password}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      },
    );
    request.on("error", reject);
    request.end(text);
  });
}

async function dropTlsWait(): Promise<void> {
  await tlsRest("collections/drop", { collectionName: TLS_WAIT_COLLECTION });
}

/** The TLS server's waiting collection, empty and loaded; the quick setup indexes and loads it. */
async function createTlsWait(): Promise<void> {
  await dropTlsWait();
  const created = await tlsRest("collections/create", { collectionName: TLS_WAIT_COLLECTION, dimension: 2 });
  if (created.code !== 0) throw new Error(`creating ${TLS_WAIT_COLLECTION} failed: ${JSON.stringify(created)}`);
  for (let waited = 0; waited < 60_000; waited += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each read waits for the one before it.
    const state = await tlsRest("collections/get_load_state", { collectionName: TLS_WAIT_COLLECTION });
    if ((state.data as { loadState?: string } | undefined)?.loadState === "LoadStateLoaded") return;
    // oxlint-disable-next-line no-await-in-loop -- the poll's interval.
    await sleep(1000);
  }
  throw new Error(`${TLS_WAIT_COLLECTION} did not load within 60 s`);
}

/**
 * The management port's telemetry client list, read as root over Basic authorization, the only scheme that route
 * takes. node:http and not fetch, so no proxy variable of T2 can reach the read.
 */
function telemetryClients(): Promise<unknown> {
  const basic = Buffer.from(`${ROOT_CREDENTIAL.user}:${ROOT_CREDENTIAL.password}`, "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port: 19091,
          path: "/api/v1/_telemetry/clients",
          headers: { authorization: `Basic ${basic}` },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        },
      )
      .on("error", reject);
  });
}

async function main(): Promise<void> {
  console.log(`START ${RUNTIME}`);

  // T1
  {
    const relay = await forwarder(19530);
    const opts = options({ port: relay.port });
    const client = await createGrpcMilvusClient(opts);
    const answers = [
      await client.getVersion(call()),
      await client.listDatabases(call()),
      await client.showCollections(call()),
      await client.describeCollection({ collection_name: "docs_int64" }, call()),
      await client.query(
        {
          collection_name: "docs_int64",
          expr: "seq < 3",
          output_fields: ["seq"],
          query_params: [{ key: "limit", value: "3" }],
        },
        call(),
      ),
    ];
    client.close();
    relay.close();
    report(
      "T1",
      "five calls through a local forwarder on one connection",
      answers.length === 5 && relay.accepted() === 1,
      { accepted: relay.accepted() },
    );
  }

  // T2
  {
    let proxied = 0;
    const proxy = net.createServer((socket) => {
      proxied++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    for (const name of ["grpc_proxy", "https_proxy", "http_proxy"]) process.env[name] = proxyUrl;
    const client = await createGrpcMilvusClient(options({}));
    const version = await client.getVersion(call());
    client.close();
    for (const name of ["grpc_proxy", "https_proxy", "http_proxy"]) delete process.env[name];
    proxy.close();
    report(
      "T2",
      "proxy variables name a listener that receives nothing",
      proxied === 0 && version.version === "3.0.2",
      { proxied },
    );
  }

  // T3
  {
    const opts = options({});
    const client = await createGrpcMilvusClient(opts);
    const failed = await client
      .query(
        {
          collection_name: "docs_int64",
          expr: "seq >>> 3",
          output_fields: ["seq"],
          query_params: [{ key: "limit", value: "1" }],
        },
        call(),
      )
      .then(
        () => false,
        (error: unknown) => error instanceof MilvusError && error.status?.code === 1100,
      );
    client.close();
    const body = (await telemetryClients()) as { clients?: unknown[] };
    report(
      "T3",
      "after a failing query the telemetry client list is empty",
      failed && Array.isArray(body.clients) && body.clients.length === 0,
      body,
    );
  }

  // T4
  {
    const ca = pem("ca.pem");
    const tlsCases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["by name", { host: "localhost", port: 19531, ssl: { mode: "verify-full", caCert: ca } }],
      ["by IP under the IP rule", { host: "127.0.0.1", port: 19531, ssl: { mode: "verify-full", caCert: ca } }],
      [
        "mutual TLS",
        {
          host: "localhost",
          port: 19532,
          ssl: { mode: "verify-full", caCert: ca, clientCert: pem("client.pem"), clientKey: pem("client.key") },
        },
      ],
    ];
    for (const [what, overrides] of tlsCases) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time.
      const client = await createGrpcMilvusClient(options(overrides));
      // oxlint-disable-next-line no-await-in-loop -- the connection's one call.
      const version = await client.getVersion(call()).then(
        (answer) => answer.version,
        (error: unknown) => sentence(error, options(overrides)),
      );
      client.close();
      report("T4", `TLS ${what}`, version === "3.0.2", version);
    }
    const missingOptions = options({ host: "localhost", port: 19532, ssl: { mode: "verify-full", caCert: ca } });
    const missing = await createGrpcMilvusClient(missingOptions);
    const refused = await missing.getVersion(call()).then(
      () => undefined,
      (error: unknown) => sentence(error, missingOptions),
    );
    missing.close();
    report(
      "T4",
      "mutual TLS with no client certificate is a connection error",
      refused?.name === "ConnectionError",
      refused,
    );
    for (const [what, cert, key, words] of [
      ["serverAuth only", "client-serverauth.pem", "client-serverauth.key", "not issued for client authentication"],
      ["expired", "client-expired.pem", "client-expired.key", "expired on"],
      ["a mismatched key", "client.pem", "client-mismatched.key", "is not the key of the Client Certificate"],
    ] as const) {
      let refusal: unknown;
      try {
        options({
          host: "localhost",
          port: 19532,
          ssl: { mode: "verify-full", caCert: ca, clientCert: pem(cert), clientKey: pem(key) },
        });
      } catch (error) {
        refusal = error;
      }
      report(
        "T4",
        `the preflight refuses ${what} before any channel`,
        refusal instanceof DatabaseConfigError && refusal.message.includes(words),
        (refusal as Error | undefined)?.message,
      );
    }
  }

  // T5
  {
    const relay = await forwarder(19530);
    const opts = options({ port: relay.port });
    const client = await createGrpcMilvusClient(opts);
    await client.getVersion(call());
    relay.arm();
    await sleep(11_000);
    const started = Date.now();
    const lost = await client.getVersion(call()).then(
      () => undefined,
      (error: unknown) => sentence(error, opts),
    );
    const elapsed = Date.now() - started;
    const next = await client.getVersion(call()).then(
      (answer) => answer.version,
      () => "failed",
    );
    client.close();
    relay.close();
    report(
      "T5",
      "a dropped connection fails in about 6 s as lost, and the next call reconnects",
      lost?.message.startsWith("The connection to Milvus was lost; run it again.") === true &&
        elapsed >= 5000 &&
        elapsed <= 9000 &&
        next === "3.0.2",
      { lost, elapsed, next },
    );
  }

  // T6
  {
    const opts = options({ host: "localhost", port: 19531, ssl: { mode: "verify-full", caCert: pem("ca.pem") } });
    const client = await createGrpcMilvusClient(opts);
    const failed: unknown[] = [];
    for (let elapsed = 0; elapsed < 75_000; elapsed += 3000) {
      // oxlint-disable-next-line no-await-in-loop -- one call every 3 s, as a busy session makes them.
      await client.getVersion(call()).catch((error: unknown) => failed.push(sentence(error, opts)));
      // oxlint-disable-next-line no-await-in-loop -- the interval.
      await sleep(3000);
    }
    client.close();
    report("T6", "75 s of calls on the native TLS port meet no too_many_pings", failed.length === 0, failed);
  }

  // T7
  if (process.argv.includes("--skip-idle")) {
    console.log("SKIP T7 the port share's idle close (--skip-idle)");
  } else {
    const client = await createGrpcMilvusClient(options({}));
    await client.getVersion(call());
    await sleep(310_000);
    const after = await client.getVersion(call()).then(
      (answer) => answer.version,
      (error: unknown) => sentence(error, options({})),
    );
    client.close();
    report("T7", "after the port share's 300 s idle close the next call reconnects", after === "3.0.2", after);
  }

  // T8
  {
    const client = await createGrpcMilvusClient(options({}));
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.query(waitingQuery(), call(controller.signal)).then(
      () => "answered",
      (error: unknown) => (error as MilvusError).category,
    );
    setTimeout(() => controller.abort(), 300);
    const category = await pending;
    client.close();
    report(
      "T8",
      "a cancelled waiting query ends as cancelled within a second",
      category === "cancelled" && Date.now() - started < 1300,
      { category },
    );
  }

  // T9
  await createTlsWait();
  try {
    for (const [where, overrides, collection] of [
      ["the port share", {}, "docs_int64"],
      [
        "the native TLS port",
        { host: "localhost", port: 19531, ssl: { mode: "verify-full", caCert: pem("ca.pem") } },
        TLS_WAIT_COLLECTION,
      ],
    ] as const) {
      const opts = options(overrides, 3000);
      // oxlint-disable-next-line no-await-in-loop -- one port at a time.
      const client = await createGrpcMilvusClient(opts);
      const names: string[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- one waiting call at a time.
        names.push(
          await client.query(waitingQuery(collection), call()).then(
            () => "answered",
            (error: unknown) => sentence(error, opts).name,
          ),
        );
      }
      client.close();
      report(
        "T9",
        `every deadline shape on ${where} reads as the deadline`,
        names.every((name) => name === "TimeoutError"),
        names,
      );
    }
  } finally {
    await dropTlsWait();
  }

  // T10
  {
    const client = await createGrpcMilvusClient(options({}));
    const version = readMilvusVersion(await client.getVersion(call()));
    client.close();
    report(
      "T10",
      "GetVersion reads 3.0.2 and passes every gate",
      version.reported === "3.0.2" && versionGateRefusal("orderByFields", version) === undefined,
      version,
    );
  }

  console.log(`END ${RUNTIME} failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(2);
});
