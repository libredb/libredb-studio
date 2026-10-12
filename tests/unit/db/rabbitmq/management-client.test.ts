/**
 * The management client: one transport per client with the shared transport's refusals on, one permit of the route's
 * one limiter per GET, the per-GET deadline from the injected factory, each route's byte cap and decoder, and every
 * failure as a sentence from errors.ts that quotes nothing the broker wrote.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { createNodeTransport, TransportError } from "@/lib/db/http/node-transport";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import { cancelledError, VhostAccessError } from "@/lib/db/providers/stream/rabbitmq/errors";
import {
  createManagementClient,
  type ManagementClient,
  type ManagementTransportFactory,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
  type RouteAnswers,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import type { ManagementRouteId } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import type { DatabaseConnection } from "@/lib/types";
import {
  closeAll,
  httpListener,
  httpsListener,
  jsonAnswer,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  createManagementStub,
  hangUntilAbort,
  jsonOk,
  type ManagementStub,
  manualDeadlines,
  SAMPLE_BODIES,
  SAMPLE_NODE,
} from "../../../helpers/rabbitmq-management-stub";

/** The test connection's password, built at run time by the helper; no sentence may carry it. */
const TEST_PASSWORD = rabbitmqConnection().password as string;

const SENTINEL = "PEER-SENTINEL";

interface Harness {
  readonly client: ManagementClient;
  readonly stub: ManagementStub;
  readonly deadlines: ReturnType<typeof manualDeadlines>;
  readonly lifetime: AbortController;
}

function harness(
  options: {
    readonly connection?: DatabaseConnection;
    readonly queryTimeoutMs?: number;
    readonly transport?: ManagementTransportFactory;
  } = {},
): Harness {
  const stub = createManagementStub();
  const deadlines = manualDeadlines();
  const lifetime = new AbortController();
  const client = createManagementClient({
    endpoint: readConnectionOptions(options.connection ?? rabbitmqConnection()).management,
    transport: options.transport ?? stub.factory,
    deadlineSignal: deadlines.factory,
    queryTimeoutMs: options.queryTimeoutMs ?? 60_000,
    lifetime: lifetime.signal,
    limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
  });
  return { client, stub, deadlines, lifetime };
}

/** The stub key of each JSON route for vhost "/" and object "obj". */
const KEYS: Record<Exclude<ManagementRouteId, "stream-tracking">, string> = {
  whoami: "GET /api/whoami",
  "overview-version": "GET /api/overview?columns=rabbitmq_version,product_name",
  "overview-full": "GET /api/overview?columns=rabbitmq_version,product_name,management_version",
  vhosts: "GET /api/vhosts",
  "queues-page":
    "GET /api/queues/%2F?columns=name,type,state,messages,messages_ready,messages_unacknowledged&disable_stats=true&enable_queue_totals=true&page=1&page_size=500&sort=name",
  "streams-page":
    "GET /api/queues/%2F?columns=name,type,state&disable_stats=true&page=1&page_size=500&sort=type&sort_reverse=true",
  "exchanges-page":
    "GET /api/exchanges/%2F?columns=name,type,durable,auto_delete,internal&page=1&page_size=500&sort=name",
  queue: "GET /api/queues/%2F/obj",
  "stream-type": "GET /api/queues/%2F/obj?columns=type,online,members&disable_stats=true",
  exchange: "GET /api/exchanges/%2F/obj",
  "queue-bindings": "GET /api/queues/%2F/obj/bindings",
  "exchange-bindings-source": "GET /api/exchanges/%2F/obj/bindings/source",
  "exchange-bindings-destination": "GET /api/exchanges/%2F/obj/bindings/destination",
  policies: "GET /api/policies/%2F",
  "operator-policies": "GET /api/operator-policies/%2F",
  alarms: "GET /api/health/checks/alarms",
  extensions: "GET /api/extensions",
};
const PARTS = { vhost: "/", name: "obj" };
const LABELS: Record<keyof typeof KEYS, string> = {
  whoami: "the user check",
  "overview-version": "the version check",
  "overview-full": "the overview",
  vhosts: "the virtual host listing",
  "queues-page": "the queue listing",
  "streams-page": "the stream listing",
  "exchanges-page": "the exchange listing",
  queue: "the queue details",
  "stream-type": "the stream type check",
  exchange: "the exchange details",
  "queue-bindings": "the queue bindings",
  "exchange-bindings-source": "the exchange bindings as source",
  "exchange-bindings-destination": "the exchange bindings as destination",
  policies: "the policies",
  "operator-policies": "the operator policies",
  alarms: "the alarm check",
  extensions: "the plugin list",
};
const CAPS: Record<keyof typeof KEYS, number> = {
  whoami: 65_536,
  "overview-version": 65_536,
  "overview-full": 65_536,
  vhosts: 1_048_576,
  "queues-page": 1_048_576,
  "streams-page": 1_048_576,
  "exchanges-page": 1_048_576,
  queue: 1_048_576,
  "stream-type": 65_536,
  exchange: 1_048_576,
  "queue-bindings": 16_777_216,
  "exchange-bindings-source": 16_777_216,
  "exchange-bindings-destination": 16_777_216,
  policies: 1_048_576,
  "operator-policies": 1_048_576,
  alarms: 65_536,
  extensions: 65_536,
};
/** Each cap as the size sentence shows it. */
const CAP_TEXT: Readonly<Record<number, string>> = { 65_536: "64 KiB", 1_048_576: "1 MiB", 16_777_216: "16 MiB" };
/** One wrong-typed field per route. */
const WRONG: Record<keyof typeof KEYS, unknown> = {
  whoami: { name: 7 },
  "overview-version": { rabbitmq_version: 4.3 },
  "overview-full": { rabbitmq_version: "4.3.6", management_version: ["4.3.6"] },
  vhosts: [{ name: "x".repeat(256) }],
  "queues-page": { filtered_count: 1, items: [{ name: "q", type: "classic", messages: -1 }] },
  "streams-page": { filtered_count: 1.5, items: [] },
  "exchanges-page": {
    filtered_count: 1,
    items: [{ name: "x", type: "direct", durable: "yes", auto_delete: false, internal: false }],
  },
  queue: { ...SAMPLE_BODIES.queue, consumers: "1" },
  "stream-type": { type: "stream", online: "rabbit@a", members: [] },
  exchange: { ...SAMPLE_BODIES.exchange, internal: null },
  "queue-bindings": [{ source: "", destination: 1, destination_type: "queue", routing_key: "", arguments: {} }],
  "exchange-bindings-source": { rows: [] },
  "exchange-bindings-destination": [
    { source: "a", destination: "b", destination_type: "queue", routing_key: "k", arguments: [] },
  ],
  policies: [{ name: "p", pattern: "^x", "apply-to": "queues", definition: {}, priority: 1.5 }],
  "operator-policies": [{ name: "p", pattern: "^x", "apply-to": "queues", definition: "max", priority: 1 }],
  alarms: { status: "maybe" },
  extensions: [{ javascript: 3 }],
};

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("the transport the client builds", () => {
  test("one transport per client: Basic credentials, accept the one request header, link-local and upgrades refused", () => {
    const { stub } = harness();
    expect(stub.built).toHaveLength(1);
    const [options] = stub.built;
    expect(options.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 15672 });
    expect(options.tls).toBeNull();
    expect(options.maxSockets).toBe(5);
    expect(options.headers).toEqual({
      authorization: `Basic ${Buffer.from(`studio-reader:${TEST_PASSWORD}`).toString("base64")}`,
    });
    expect(options.requestHeaderNames).toEqual(["accept"]);
    expect(options.refusesLinkLocal).toBe(true);
    expect(options.refusesUpgrade).toBe(true);
    expect(options.reportsUnreachable).toBe(true);
  });

  test("close() closes the transport, and a GET after it is refused before any request", async () => {
    const { client, stub } = harness();
    client.close();
    expect(stub.closed()).toBe(1);
    const error = await failure(client.get("whoami", {}));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("decoding", () => {
  test("each route's sample answer decodes to the fields Studio keeps", async () => {
    const { client, stub } = harness();
    for (const [id, key] of Object.entries(KEYS)) stub.answer(key, jsonOk(SAMPLE_BODIES[id as keyof typeof KEYS]));
    expect(await client.get("whoami", {})).toEqual({});
    expect(await client.get("overview-version", {})).toEqual({ version: "4.3.6" });
    expect(await client.get("overview-full", {})).toEqual({ version: "4.3.6", managementVersion: "4.3.6" });
    expect(await client.get("vhosts", {})).toEqual([{ name: "/" }, { name: "billing" }]);
    expect(await client.get("queues-page", PARTS)).toEqual({
      filteredCount: 3,
      items: [
        { name: "orders", type: "classic", state: "running", messages: 3, messagesReady: 3, messagesUnacknowledged: 0 },
        {
          name: "payments",
          type: "quorum",
          state: "running",
          messages: 2,
          messagesReady: 2,
          messagesUnacknowledged: 0,
        },
        {
          name: "st-orders",
          type: "stream",
          state: "running",
          messages: null,
          messagesReady: null,
          messagesUnacknowledged: null,
        },
      ],
    });
    expect((await client.get("streams-page", PARTS)).items[0]).toEqual({
      name: "st-orders",
      type: "stream",
      state: "running",
    });
    expect((await client.get("exchanges-page", PARTS)).items[0]).toEqual({
      name: "",
      type: "direct",
      durable: true,
      autoDelete: false,
      internal: false,
    });
    const queue = await client.get("queue", PARTS);
    expect(queue.consumerDetails).toEqual([
      {
        exclusive: false,
        ackRequired: true,
        prefetchCount: 10,
        active: true,
        activityStatus: "up",
        consumerTimeout: 1800000,
      },
    ]);
    expect(queue.deliveryLimit).toBe(20);
    expect(queue.leader).toBe(SAMPLE_NODE);
    const kept = JSON.stringify(queue);
    for (const dropped of [
      "ctag-marker",
      "consumer-argument-marker",
      "10.0.0.9",
      "other-user",
      "owner-marker",
      "admin-marker",
    ])
      expect(kept).not.toContain(dropped);
    expect(await client.get("stream-type", PARTS)).toEqual({
      type: "stream",
      online: [SAMPLE_NODE],
      members: [SAMPLE_NODE],
    });
    expect(JSON.stringify(await client.get("exchange", PARTS))).not.toContain("admin-marker");
    expect(await client.get("queue-bindings", PARTS)).toEqual({
      total: 2,
      rows: [
        { source: "", destination: "orders", destinationType: "queue", routingKey: "orders", arguments: {} },
        { source: "ex-direct", destination: "orders", destinationType: "queue", routingKey: "o", arguments: {} },
      ],
    });
    expect(await client.get("policies", PARTS)).toEqual([
      { name: "pol-maxlen", pattern: "^q-", applyTo: "queues", definition: { "max-length": 10000 }, priority: 1 },
    ]);
    expect(await client.get("operator-policies", PARTS)).toEqual([]);
    expect(await client.get("alarms", {})).toEqual({ active: false });
    expect(await client.get("extensions", {})).toEqual({ streamManagement: true });
    expect(stub.unanswered).toEqual([]);
  });

  test("whoami keeps nothing, so a user name over 255 bytes, an LDAP DN, still decodes", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS.whoami, jsonOk({ name: `cn=${"a".repeat(300)},ou=people,dc=example,dc=org`, tags: [] }));
    expect(await client.get("whoami", {})).toEqual({});
  });

  test("a classic queue's type check answers without online and members", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS["stream-type"], jsonOk({ type: "classic" }));
    expect(await client.get("stream-type", PARTS)).toEqual({ type: "classic", online: [], members: [] });
  });

  test("an active alarm answers 503 with the alarms, read as active and keeping no node name", async () => {
    const { client, stub } = harness();
    stub.answer(
      KEYS.alarms,
      jsonOk({ status: "failed", reason: SENTINEL, alarms: [{ node: SAMPLE_NODE, resource: "memory" }] }, 503),
    );
    const answer: RouteAnswers["alarms"] = await client.get("alarms", {});
    expect(answer).toEqual({ active: true });
  });

  test("the plugin list without stream.js, or with it as a single string, is read either way", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS.extensions, jsonOk([{ javascript: "dispatcher.js" }, []]));
    expect(await client.get("extensions", {})).toEqual({ streamManagement: false });
    stub.answer(KEYS.extensions, jsonOk([{ javascript: "stream.js" }, {}]));
    expect(await client.get("extensions", {})).toEqual({ streamManagement: true });
  });

  test("a bindings answer keeps 1,000 rows and counts the rest", async () => {
    const { client, stub } = harness();
    const rows = Array.from({ length: 1_500 }, (_, i) => ({
      source: "ex",
      destination: `q-${i}`,
      destination_type: "queue",
      routing_key: "k",
      arguments: {},
    }));
    stub.answer(KEYS["queue-bindings"], jsonOk(rows));
    const answer = await client.get("queue-bindings", PARTS);
    expect(answer.rows).toHaveLength(1_000);
    expect(answer.total).toBe(1_500);
  });

  test("a bindings answer of 16 MiB whose rows carry large arguments is kept at 1 MiB, the rest counted", async () => {
    const { client, stub } = harness();
    const big = "a".repeat(100_000);
    const rows = Array.from({ length: 160 }, (_, i) => ({
      source: "ex",
      destination: `q-${i}`,
      destination_type: "queue",
      routing_key: "k",
      arguments: { "x-big": big },
    }));
    stub.answer(KEYS["exchange-bindings-source"], jsonOk(rows));
    const answer = await client.get("exchange-bindings-source", PARTS);
    expect(answer.total).toBe(160);
    expect(answer.rows.length).toBe(10);
    expect(Buffer.byteLength(JSON.stringify(answer.rows))).toBeLessThanOrEqual(1_048_576);
  });
});

describe("refused answers", () => {
  for (const id of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
    test(`${id}: cap plus one byte, a depth-65 body and a wrong-typed field each refuse with their sentence`, async () => {
      const { client, stub } = harness();
      stub.answer(KEYS[id], { status: 200, body: " ".repeat(CAPS[id] + 1) });
      const tooLarge = await failure(client.get(id, PARTS));
      expect(tooLarge).toBeInstanceOf(QueryError);
      expect(tooLarge.message).toBe(
        `The broker's answer for ${LABELS[id]} is larger than the ${CAP_TEXT[CAPS[id]]} Studio accepts.`,
      );

      stub.answer(KEYS[id], { status: 200, body: `${"[".repeat(65)}${"]".repeat(65)}` });
      const tooDeep = await failure(client.get(id, PARTS));
      expect(tooDeep.message).toBe(
        `The broker's answer for ${LABELS[id]} nests deeper than 64 levels, which Studio does not accept.`,
      );

      stub.answer(KEYS[id], jsonOk(WRONG[id]));
      const wrongShape = await failure(client.get(id, PARTS));
      expect(wrongShape).toBeInstanceOf(QueryError);
      expect(wrongShape.message).toBe(`The broker's answer for ${LABELS[id]} is not in the shape Studio reads.`);
    });
  }

  test("a 200 whose body is not JSON names the port and prefix, and the body is never quoted", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS.vhosts, { status: 200, body: `<html>${SENTINEL}`, contentType: "text/html" });
    const error = await failure(client.get("vhosts", {}));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(
      "127.0.0.1:15672 answered with something that is not the management API's JSON: check Management port and Path prefix.",
    );
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  test("statuses map through errors.ts by scope, never quoting the body", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS.whoami, jsonOk({ error: "not_authorised", reason: "Not management user" }, 401));
    const tag = await failure(client.get("whoami", {}));
    expect(tag).toBeInstanceOf(AuthenticationError);
    expect(tag.message).toBe("This user may not use the management API: give it the management tag.");

    stub.answer(KEYS["queues-page"], jsonOk({ error: "not_found", reason: "Not Found" }, 404));
    const access = await failure(client.get("queues-page", PARTS));
    expect(access).toBeInstanceOf(VhostAccessError);
    expect((access as VhostAccessError).vhost).toBe("/");

    stub.answer(KEYS.vhosts, { status: 502, body: `<html>${SENTINEL}</html>` });
    const server = await failure(client.get("vhosts", {}));
    expect(server.message).toBe("The management API at 127.0.0.1:15672 answered with a server error (502).");
    expect(JSON.stringify(server)).not.toContain(SENTINEL);
  });
});

describe("transport failures", () => {
  function failing(error: unknown): ManagementTransportFactory {
    return () => ({
      request: async () => {
        throw error;
      },
      close() {},
    });
  }

  test("a redirect, an encoded body and a lost connection each have their own sentence, naming no token", async () => {
    const cases: [TransportError, string][] = [
      [
        new TransportError("redirect", "Redirect to https://elsewhere.example/ refused"),
        "127.0.0.1:15672 answered with a redirect, which Studio does not follow: set Host, Management port and Path prefix to the management API itself.",
      ],
      [
        new TransportError("encoding", `The server answered with content-encoding ${SENTINEL}`),
        "127.0.0.1:15672 answered with a compressed or encoded body, which Studio does not read: check Path prefix and any proxy in front of the management API.",
      ],
      [
        new TransportError("network", "Network failure (ECONNRESET)", { truncated: true }),
        "The connection to 127.0.0.1:15672 failed before the management API answered completely.",
      ],
    ];
    for (const [thrown, sentence] of cases) {
      const { client } = harness({ transport: failing(thrown) });
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, so a failure names its own sentence.
      const error = await failure(client.get("vhosts", {}));
      expect(error.message).toBe(sentence);
      expect(error.message).not.toContain("elsewhere.example");
      expect(error.message).not.toContain(SENTINEL);
    }
  });

  test("over TLS, a reset before whoami's answer is the broker refusing the TLS connection", async () => {
    const reset = () =>
      new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)");
    const overTls = rabbitmqConnection({ ssl: { mode: "require" } });
    const refused = await failure(
      harness({ connection: overTls, transport: failing(reset()) }).client.get("whoami", {}),
    );
    expect(refused).toBeInstanceOf(ConnectionError);
    expect(refused.message).toBe(
      "127.0.0.1:15672 refused the TLS connection: check the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).",
    );
    // Over plain HTTP, on any later route, or after part of an answer, a reset keeps the connection sentences.
    const lost = "The connection to 127.0.0.1:15672 failed before the management API answered completely.";
    expect((await failure(harness({ transport: failing(reset()) }).client.get("whoami", {}))).message).toBe(lost);
    const later = harness({ connection: overTls, transport: failing(reset()) });
    expect((await failure(later.client.get("vhosts", {}))).message).toBe(lost);
    const cut = new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)", {
      truncated: true,
    });
    const truncated = harness({ connection: overTls, transport: failing(cut) });
    expect((await failure(truncated.client.get("whoami", {}))).message).toBe(lost);
  });

  test("the egress guard's refusal passes through unchanged", async () => {
    const refusal = new DatabaseConfigError(
      "Invalid host: this database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS",
    );
    const { client } = harness({ transport: failing(refusal) });
    expect(await failure(client.get("whoami", {}))).toBe(refusal);
  });

  test("anything else becomes the unexpected-answer sentence, and its own message is never kept", async () => {
    for (const thrown of [new Error(SENTINEL), new TypeError(`bad ${SENTINEL}`), new SyntaxError(SENTINEL)]) {
      const { client } = harness({ transport: failing(thrown) });
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, so a failure names its own value.
      const error = await failure(client.get("queue", PARTS));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe("Studio could not read the broker's answer for the queue details.");
      expect(JSON.stringify(error)).not.toContain(SENTINEL);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });
});

describe("over the real node transport, against local listeners (R-S8's management half)", () => {
  let certificates: TransportCertificates;
  beforeAll(() => {
    certificates = makeCertificates();
  });
  afterEach(closeAll);

  const WHOAMI_BODY = JSON.stringify({ name: "studio-reader", tags: ["monitoring"] });

  async function whoami(port: number, ssl: Record<string, string>, host = "localhost"): Promise<unknown> {
    const connection = rabbitmqConnection({ host, port, ssl: ssl as never });
    const { client } = harness({ connection, transport: createNodeTransport });
    try {
      return await client.get("whoami", {});
    } catch (error) {
      return error;
    } finally {
      client.close();
    }
  }

  test("a certificate Studio does not trust, a wrong name, a plain listener and a refused client certificate", async () => {
    const at = (port: number) => `localhost:${port}`;
    const trusted = await httpsListener(certificates.local, jsonAnswer(200, WHOAMI_BODY));
    const verify = { mode: "verify-full", caCert: certificates.ca };
    expect(await whoami(trusted.port, verify)).not.toBeInstanceOf(Error);

    const untrusted = (port: number) =>
      `${at(port)} presented a certificate Studio does not trust for this host: check the CA certificate under SSL / TLS, and that the certificate names the host set in Host.`;
    const rogue = (await whoami(trusted.port, { mode: "verify-full", caCert: certificates.rogueCa })) as Error;
    expect(rogue.message).toBe(untrusted(trusted.port));
    const farName = await httpsListener(certificates.farName, jsonAnswer(200, WHOAMI_BODY));
    expect(((await whoami(farName.port, verify)) as Error).message).toBe(untrusted(farName.port));

    const plain = await httpListener(jsonAnswer(200, WHOAMI_BODY));
    expect(((await whoami(plain.port, verify)) as Error).message).toBe(
      `${at(plain.port)} does not speak TLS: choose SSL mode disable under SSL / TLS, or use the TLS port (15671 for management, 5671 for AMQP).`,
    );

    const mutual = await httpsListener(
      { ...certificates.local, clientCa: certificates.ca },
      jsonAnswer(200, WHOAMI_BODY),
    );
    const refused = `${at(mutual.port)} refused the TLS connection: check the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).`;
    expect(((await whoami(mutual.port, verify)) as Error).message).toBe(refused);
    const stranger = { ...verify, clientCert: certificates.second.cert, clientKey: certificates.second.key };
    expect(((await whoami(mutual.port, stranger)) as Error).message).toBe(refused);
    const own = { ...verify, clientCert: certificates.client.cert, clientKey: certificates.client.key };
    expect(await whoami(mutual.port, own)).not.toBeInstanceOf(Error);
    expect(mutual.seen.map((seen) => seen.url)).toEqual(["/api/whoami"]);
  });
});

describe("deadlines and the lifetime", () => {
  test("each GET asks the factory for min(queryTimeout, 15 s), and its firing is the timeout sentence naming those seconds", async () => {
    const { client, stub, deadlines } = harness({ queryTimeoutMs: 5_000 });
    stub.answer(KEYS.vhosts, hangUntilAbort());
    const pending = failure(client.get("vhosts", {}));
    await Bun.sleep(0);
    expect(deadlines.asked).toEqual([5_000]);
    deadlines.fire(0);
    const error = await pending;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      "The management API at 127.0.0.1:15672 did not answer the virtual host listing within 5 s.",
    );

    const longer = harness({ queryTimeoutMs: 60_000 });
    longer.stub.answer(KEYS.vhosts, jsonOk([]));
    await longer.client.get("vhosts", {});
    expect(longer.deadlines.asked).toEqual([15_000]);
  });

  test("Test Connection's check deadline joins the per-GET one", async () => {
    const { client, stub } = harness();
    stub.answer(KEYS.vhosts, hangUntilAbort());
    const within = new AbortController();
    const pending = failure(client.get("vhosts", {}, { within: within.signal, site: "test-connection" }));
    await Bun.sleep(0);
    within.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await pending).toBeInstanceOf(TimeoutError);
  });

  test("a caller's signal is used alone: no deadline is built, and its abort rejects with its own reason", async () => {
    const { client, stub, deadlines } = harness();
    stub.answer(KEYS["stream-type"], hangUntilAbort());
    const run = new AbortController();
    const pending = failure(client.get("stream-type", PARTS, { signal: run.signal, site: "read" }));
    await Bun.sleep(0);
    const reason = cancelledError("The query was cancelled.");
    run.abort(reason);
    expect(await pending).toBe(reason);
    expect(deadlines.asked).toEqual([]);
  });

  test("the provider's lifetime aborting ends a GET in flight with the closed sentence's class", async () => {
    const { client, stub, lifetime } = harness();
    stub.answer(KEYS.vhosts, hangUntilAbort());
    const pending = failure(client.get("vhosts", {}));
    await Bun.sleep(0);
    lifetime.abort(cancelledError("closed"));
    const error = await pending;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("closed");
  });
});

describe("the status-only route", () => {
  test("answers the tracking status with the body discarded, under its permit and deadline", async () => {
    const { client, stub, deadlines } = harness();
    stub.answer("GET /api/stream/%2F/obj/tracking", { status: 503, body: JSON.stringify({ reason: SENTINEL }) });
    expect(await client.status("stream-tracking", PARTS)).toBe(503);
    expect(deadlines.asked).toEqual([15_000]);
  });

  test("the JSON entry refuses the status-only route, and the status entry refuses every other", async () => {
    const { client, stub } = harness();
    await expect(client.get("stream-tracking" as "whoami", PARTS)).rejects.toThrow(
      "The management route stream-tracking is read for its status only",
    );
    await expect(client.status("whoami" as "stream-tracking", {})).rejects.toThrow(
      "The management route whoami is not read for its status",
    );
    expect(stub.requests).toHaveLength(0);
  });

  test("a route outside the table, the issue's four admin endpoints included, is refused before any request", async () => {
    const { client, stub } = harness();
    for (const id of ["definitions", "users", "permissions", "parameters", "toString", "__proto__"]) {
      // oxlint-disable-next-line no-await-in-loop -- one id at a time, so a failure names its own id.
      await expect(client.get(id as never, {})).rejects.toThrow(`No management route ${JSON.stringify(id)}`);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expect(client.status(id as never, {})).rejects.toThrow(`No management route ${JSON.stringify(id)}`);
    }
    expect(stub.requests).toHaveLength(0);
    expect(stub.built).toHaveLength(1);
  });
});

describe("limiters", () => {
  test("with 2 bindings GETs in flight a third waits, and 14 queued bindings GETs never hold back a listing", async () => {
    const harnesses = Array.from({ length: 16 }, () => harness());
    const started: number[] = [];
    for (const [index, h] of harnesses.entries())
      h.stub.answer(
        KEYS["queue-bindings"],
        hangUntilAbort(() => started.push(index)),
      );
    const pending = harnesses.map((h) => failure(h.client.get("queue-bindings", PARTS)));
    await Bun.sleep(0);
    expect(started).toEqual([0, 1]);

    // Another connection's tree listing takes a management permit, which no waiting bindings GET holds.
    const other = harness();
    other.stub.answer(KEYS.vhosts, jsonOk([{ name: "/" }]));
    expect(await other.client.get("vhosts", {})).toEqual([{ name: "/" }]);

    // The first bindings GET's deadline frees its permit, and the next waiting one starts.
    harnesses[0].deadlines.fire(0);
    await Bun.sleep(0);
    expect(started).toEqual([0, 1, 2]);
    for (const h of harnesses) h.deadlines.fire();
    for (const error of await Promise.all(pending)) expect(error).toBeInstanceOf(TimeoutError);
  });

  test("a full bindings queue refuses at once with Studio's own sentence", async () => {
    const harnesses = Array.from({ length: 18 }, () => harness());
    for (const h of harnesses) h.stub.answer(KEYS["queue-bindings"], hangUntilAbort());
    const pending = harnesses.map((h) => failure(h.client.get("queue-bindings", PARTS)));
    const extra = harness();
    const refused = await failure(extra.client.get("queue-bindings", PARTS));
    expect(refused).toBeInstanceOf(QueryError);
    expect(refused.message).toBe(
      "Too many management requests are waiting on this Studio server; try again when one ends.",
    );
    expect(extra.stub.requests).toHaveLength(0);
    for (const h of harnesses) h.deadlines.fire();
    await Promise.all(pending);
  });

  test("a GET's deadline covers its wait for a permit: it times out while waiting, before any request", async () => {
    // The bindings limiter: two holders, a third fired while it waits.
    const holders = Array.from({ length: 2 }, () => harness());
    for (const h of holders) h.stub.answer(KEYS["queue-bindings"], hangUntilAbort());
    const held = holders.map((h) => failure(h.client.get("queue-bindings", PARTS)));
    const x = harness();
    x.stub.answer(KEYS["queue-bindings"], jsonOk([]));
    let waited: Error | undefined;
    const waiting = failure(x.client.get("queue-bindings", PARTS)).then((error) => {
      waited = error;
    });
    await Bun.sleep(0);
    x.deadlines.fire(0);
    await Bun.sleep(0);
    expect(waited).toBeInstanceOf(TimeoutError);
    expect(x.stub.requests).toHaveLength(0);
    for (const h of holders) h.deadlines.fire();
    await Promise.all([...held, waiting]);

    // The management limiter: sixteen holders, a seventeenth fired while it waits.
    const many = Array.from({ length: 4 }, () => harness());
    const holding = many.flatMap((h) => {
      h.stub.answer(KEYS.vhosts, hangUntilAbort());
      return Array.from({ length: 4 }, () => failure(h.client.get("vhosts", {})));
    });
    const y = harness();
    y.stub.answer(KEYS.vhosts, jsonOk([]));
    let queued: Error | undefined;
    const queuedDone = failure(y.client.get("vhosts", {})).then((error) => {
      queued = error;
    });
    await Bun.sleep(0);
    y.deadlines.fire(0);
    await Bun.sleep(0);
    expect(queued).toBeInstanceOf(TimeoutError);
    expect(y.stub.requests).toHaveLength(0);
    for (const h of many) h.deadlines.fire();
    await Promise.all([...holding, queuedDone]);
  });

  test("16 trickling GETs hold the process's management permits until their deadlines fire, then another connection's GET runs", async () => {
    const harnesses = Array.from({ length: 4 }, () => harness());
    const pending = harnesses.flatMap((h) => {
      h.stub.answer(KEYS.vhosts, hangUntilAbort());
      return Array.from({ length: 4 }, () => failure(h.client.get("vhosts", {})));
    });
    await Bun.sleep(0);
    const other = harness();
    let answered = false;
    other.stub.answer(KEYS.vhosts, jsonOk([]));
    const waiting = other.client.get("vhosts", {}).then(() => {
      answered = true;
    });
    await Bun.sleep(0);
    expect(answered).toBe(false);
    harnesses[0].deadlines.fire(0);
    await waiting;
    expect(answered).toBe(true);
    for (const h of harnesses) h.deadlines.fire();
    for (const error of await Promise.all(pending)) expect(error).toBeInstanceOf(TimeoutError);
  });
});
