/**
 * The HTTP origins take the egress decision their provider was built with (FND-2 slice 2b-3a, docs/SECURITY.md row
 * 0.6).
 *
 * MTConnect, Qdrant, Weaviate, S3-compatible object storage and RabbitMQ's management API each build their origin
 * through `httpOrigin` in `src/lib/db/http/endpoint.ts`, which checks an address literal against the decision it is
 * handed and reads no setting. Each provider here is built directly, as a test or a live script builds it outside
 * Studio's factory, with a decision the test hands it, and connects to a local HTTP server on 127.0.0.1 that counts
 * the requests it receives. The variable is left unset, so a refusal shows the handed decision decided.
 *
 * The inverse, an allowing decision while the variable is `true` at a literal, waits for FND-2 slice 2b-4 for these
 * five: their node transport reads core's decision on the provider's behalf until then. The fetch kind's inverse is in
 * `egress-policy-providers.test.ts`, and RabbitMQ's management origin's in `egress-policy-socket-dials.test.ts`, over
 * a recorded management API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST, EGRESS_DECISION_MISSING } from "@/lib/db/http/egress-policy";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import { S3Provider } from "@/lib/db/providers/objectstore/s3/index";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate/index";
import type { DatabaseConnection, DatabaseProvider, EgressDecision } from "@/lib/db/types";
import { BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;

/** A local HTTP server on 127.0.0.1 that counts the requests it receives; `close` stops it. */
interface CountingServer {
  readonly port: number;
  hits(): number;
  close(): Promise<void>;
}

const servers: CountingServer[] = [];

afterEach(async () => {
  setEgressFlag(original);
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function countingServer(): Promise<CountingServer> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.statusCode = 500;
    response.end("unexpected request");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const counting: CountingServer = {
    port: (server.address() as AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(counting);
  return counting;
}

/** The build context a case hands: a decision, or none at all. */
type Context = { readonly egress?: EgressDecision };

type Build = (host: string, port: number, context: Context) => DatabaseProvider;

/**
 * A short deadline, so a case whose refusal regressed fails inside the test's time budget instead of waiting out the
 * default one.
 */
const OPTIONS = { queryTimeout: 1500 };

function connection(type: DatabaseConnection["type"], host: string, port: number): DatabaseConnection {
  return { id: `origin-${type}`, name: `origin ${type}`, type, host, port, createdAt: new Date() };
}

const BUILDS: readonly [string, Build][] = [
  ["MTConnect", (host, port, context) => new MTConnectProvider(connection("mtconnect", host, port), OPTIONS, context)],
  ["Qdrant", (host, port, context) => new QdrantProvider(connection("qdrant", host, port), OPTIONS, context)],
  ["Weaviate", (host, port, context) => new WeaviateProvider(connection("weaviate", host, port), OPTIONS, context)],
  [
    "S3-compatible object storage",
    // A pinned bucket, so connect() makes one request; no key pair, so the half-pair refusal does not fire first.
    (host, port, context) => new S3Provider({ ...connection("s3", host, port), database: "test" }, OPTIONS, context),
  ],
  [
    "RabbitMQ",
    // The default management transport, a real node transport: "no request" is the server's own count.
    (host, port, context) =>
      new RabbitMQProvider(rabbitmqConnection({ host, port, password: crypto.randomUUID() }), OPTIONS, context),
  ],
];

/** Runs `connect()` and disconnects, resolving to the error `connect()` rejected with, or null when it succeeded. */
async function connected(provider: DatabaseProvider): Promise<unknown> {
  const outcome = await provider.connect().then(
    () => null,
    (error: unknown) => error,
  );
  await provider.disconnect();
  return outcome;
}

describe("a provider builds its origin by the egress decision it was built with (FND-2 slice 2b-3a)", () => {
  test.each(BUILDS)(
    "%s handed a blocking decision refuses 127.0.0.1 when connect() builds its origin, before any request, while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset",
    async (_name, build) => {
      setEgressFlag(undefined);
      const server = await countingServer();
      const failure = await connected(build("127.0.0.1", server.port, { egress: BLOCKS_PRIVATE_HOSTS }));
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(BLOCKED_HOST);
      expect(server.hits()).toBe(0);
    },
  );

  test.each(BUILDS)(
    "%s built without an egress decision is built, and refuses to connect by name before any request",
    async (_name, build) => {
      setEgressFlag(undefined);
      const server = await countingServer();
      const provider = build("127.0.0.1", server.port, {});
      expect(provider.getCapabilities().defaultPort).not.toBeUndefined();
      const failure = await connected(provider);
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
      expect(server.hits()).toBe(0);
    },
  );
});
