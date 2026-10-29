/**
 * A Kubernetes-discovered MongoDB connection names its server by a fully qualified pod name with a trailing dot
 * (src/lib/seed/kubernetes-discovery-contract.ts), so the pod's DNS search path never applies to the name Studio
 * dials first.
 *
 * These tests take the MongoDB provider's own connection string and TLS options for such a connection and open a
 * client with them through the real `mongodb` driver, against a local server that answers the wire protocol's
 * handshake and `ping` the way mongod does, reached as `localhost.`: the trailing dot goes through the driver's seed
 * list, the resolver and the TLS server name. They also pin what the driver does next when the server is a replica
 * set member, which is what MongoDB Community runs: it drops the seed and dials the members the server advertises, by
 * the names the server gives (docs/SECURITY.md, the member-host residual of the discovery controls). Credentials are
 * left out of the client here because the stand-in server speaks no SCRAM; they do not change how hosts are handled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createPlainServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { BSON, MongoClient, type MongoClientOptions } from "mongodb";
import { MongoDBProvider } from "@/lib/db/providers/document/mongodb";
import { mapKubernetesDatabase } from "@/lib/seed/kubernetes-discovery-contract";
import type { KubernetesDiscoveredDatabase } from "@/lib/seed/kubernetes-discovery-export";
import type { DatabaseConnection } from "@/lib/types";
import { loadTlsFixtures } from "../../helpers/tls-fixtures";

const TLS = loadTlsFixtures();
/** A name the resolver takes as written, as it takes a discovered host; the fixture certificate is for localhost. */
const LOCALHOST_FQDN = "localhost.";
const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

// The hosts below are those of the default cluster domain.
delete process.env.SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN;

let server: Server | null = null;
/** Every server-side socket, destroyed after each test: `close()` waits for open ones. */
let accepted: Socket[] = [];
let client: MongoClient | null = null;

afterEach(async () => {
  await client?.close(true);
  client = null;
  for (const socket of accepted) socket.destroy();
  accepted = [];
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A discovered MongoDB Community row as Studio lists it, with TLS as the resource sets it. */
function discoveredConnection(tls: boolean): DatabaseConnection {
  const entry = {
    kind: "mongo",
    resource: {
      metadata: { namespace: "team-m", name: "catalog" },
      spec: {
        users: [{ name: "appuser", db: "admin", roles: [{ db: "catalog" }] }],
        ...(tls ? { security: { tls: { enabled: true } } } : {}),
      },
    },
    secret: {
      name: "catalog-admin-appuser",
      data: {
        "connectionString.standard":
          "mongodb://appuser:x@catalog-0.catalog-svc.team-m.svc.cluster.local:27017/admin?replicaSet=catalog&ssl=false",
        username: "appuser",
        password: "not-a-real-password-catalog",
      },
    },
  } as KubernetesDiscoveredDatabase;
  const mapped = mapKubernetesDatabase(entry);
  if (!mapped.ok) throw new Error(mapped.reason);
  const { id, name, type, host, port, database, ssl, authSource } = mapped.connection;
  if (ssl?.mode === undefined) throw new Error("the discovered connection names no TLS mode");
  return { id, name, type, host, port, database, authSource, ssl: { ...ssl, mode: ssl.mode }, createdAt: new Date() };
}

/** The provider's connection string and TLS options for `connection`; both builders are private. */
function providerSettings(connection: DatabaseConnection): { uri: string; tls: MongoClientOptions } {
  const provider = new MongoDBProvider(connection) as unknown as {
    buildConnectionString(): string;
    buildTLSOptions(): MongoClientOptions;
  };
  return { uri: provider.buildConnectionString(), tls: provider.buildTLSOptions() };
}

/** One wire message: a header of length, request id, response-to and op code, then `body`. */
function frame(requestId: number, opCode: number, body: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(requestId + 1000, 4);
  header.writeInt32LE(requestId, 8);
  header.writeInt32LE(opCode, 12);
  return Buffer.concat([header, body]);
}

/** The command document of an OP_QUERY or an OP_MSG message, with its op code. */
function commandOf(message: Buffer): { opCode: number; requestId: number; command: BSON.Document } {
  const requestId = message.readInt32LE(4);
  const opCode = message.readInt32LE(12);
  if (opCode === OP_QUERY) {
    const nameEnd = message.indexOf(0, 20);
    const at = nameEnd + 1 + 8;
    return { opCode, requestId, command: BSON.deserialize(message.subarray(at, at + message.readInt32LE(at))) };
  }
  // OP_MSG: flag bits, then a body section (kind 0) holding the command.
  const at = 21;
  return { opCode, requestId, command: BSON.deserialize(message.subarray(at, at + message.readInt32LE(at))) };
}

/** mongod's answer to `command`: a hello as a standalone or as the primary of replica set rs0, else ok. */
function answerOf(command: BSON.Document, port: number, replicaSet: boolean): BSON.Document {
  const name = Object.keys(command)[0]?.toLowerCase();
  if (name !== "hello" && name !== "ismaster") return { ok: 1 };
  const member = `localhost:${port}`;
  return {
    helloOk: true,
    ismaster: true,
    isWritablePrimary: true,
    maxBsonObjectSize: 16777216,
    maxMessageSizeBytes: 48000000,
    maxWriteBatchSize: 100000,
    localTime: new Date(),
    logicalSessionTimeoutMinutes: 30,
    connectionId: 1,
    minWireVersion: 0,
    maxWireVersion: 21,
    readOnly: false,
    ...(replicaSet
      ? {
          setName: "rs0",
          setVersion: 1,
          electionId: new BSON.ObjectId("7fffffff0000000000000001"),
          hosts: [member],
          primary: member,
          me: member,
        }
      : {}),
    ok: 1,
  };
}

/** Answers every message read from `socket` as mongod would, reading whole frames from the stream. */
function speakMongo(socket: Socket, port: () => number, replicaSet: boolean): void {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
      const message = pending.subarray(0, pending.readInt32LE(0));
      pending = pending.subarray(message.length);
      const { opCode, requestId, command } = commandOf(message);
      const document = BSON.serialize(answerOf(command, port(), replicaSet));
      if (opCode === OP_QUERY) {
        const prefix = Buffer.alloc(20);
        prefix.writeInt32LE(1, 16);
        socket.write(frame(requestId, OP_REPLY, Buffer.concat([prefix, document])));
      } else {
        socket.write(frame(requestId, OP_MSG, Buffer.concat([Buffer.alloc(5), document])));
      }
    }
  });
  socket.on("error", () => socket.destroy());
}

/** A stand-in mongod on 127.0.0.1, over TLS or not; `servernames` collects the TLS server name of each connection. */
async function listenLikeMongo(options: { tls: boolean; replicaSet: boolean }) {
  const servernames: (string | false | undefined)[] = [];
  let port = 0;
  const onSocket = (socket: Socket) => {
    accepted.push(socket);
    speakMongo(socket, () => port, options.replicaSet);
  };
  server = options.tls
    ? createTlsServer({ key: TLS.server.key, cert: TLS.server.cert }, (socket: TLSSocket) => {
        servernames.push((socket as TLSSocket & { servername?: string | false }).servername);
        onSocket(socket);
      })
    : createPlainServer(onSocket);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, servernames };
}

/**
 * Opens a client with the provider's settings for `connection`, pointed at `localhost.:<port>`, pings, and returns
 * every server address the driver opened and the addresses of its topology afterwards.
 */
async function pingThrough(connection: DatabaseConnection, port: number) {
  const { uri, tls } = providerSettings({ ...connection, host: LOCALHOST_FQDN, port });
  const opened: string[] = [];
  let servers: string[] = [];
  client = new MongoClient(uri, { ...tls, serverSelectionTimeoutMS: 5000, heartbeatFrequencyMS: 500 });
  client.on("serverOpening", (event) => opened.push(event.address));
  client.on("topologyDescriptionChanged", (event) => {
    servers = [...event.newDescription.servers.keys()];
  });
  const answer = await client.db("admin").command({ ping: 1 });
  return { answer, opened, servers };
}

describe("a Kubernetes-discovered MongoDB connection's fully qualified host", () => {
  test("reaches the driver's seed list as written, with TLS as the resource sets it", () => {
    for (const tls of [false, true]) {
      const { uri, tls: options } = providerSettings(discoveredConnection(tls));
      expect(uri).toBe("mongodb://catalog-0.catalog-svc.team-m.svc.cluster.local.:27017/catalog?authSource=admin");
      expect(options).toEqual(tls ? { tls: true, rejectUnauthorized: false } : {});
      const parsed = new MongoClient(uri, options);
      expect(parsed.options.hosts.map((host) => host.toString())).toEqual([
        "catalog-0.catalog-svc.team-m.svc.cluster.local.:27017",
      ]);
      expect(parsed.options.replicaSet).toBeUndefined();
      expect(parsed.options.directConnection).toBe(false);
    }
  });

  test("opens a session with a standalone server named with the trailing dot, and keeps that name", async () => {
    const { port } = await listenLikeMongo({ tls: false, replicaSet: false });
    const { answer, opened, servers } = await pingThrough(discoveredConnection(false), port);
    expect(answer.ok).toBe(1);
    expect(opened).toEqual([`localhost.:${port}`]);
    expect(servers).toEqual([`localhost.:${port}`]);
  });

  test("opens a TLS session as ssl mode require asks, naming the host as the TLS server name", async () => {
    const { port, servernames } = await listenLikeMongo({ tls: true, replicaSet: false });
    const { answer, opened } = await pingThrough(discoveredConnection(true), port);
    expect(answer.ok).toBe(1);
    expect(opened).toEqual([`localhost.:${port}`]);
    expect(servernames.length).toBeGreaterThan(0);
    // With or without its trailing dot: a server that does not route on the name ignores it.
    for (const name of servernames) expect(String(name).replace(/\.$/, "")).toBe("localhost");
  });

  test("against a replica set member, drops the dotted seed and dials the member name the server advertises", async () => {
    const { port, servernames } = await listenLikeMongo({ tls: true, replicaSet: true });
    const { answer, opened, servers } = await pingThrough(discoveredConnection(true), port);
    expect(answer.ok).toBe(1);
    expect(opened).toEqual([`localhost.:${port}`, `localhost:${port}`]);
    expect(servers).toEqual([`localhost:${port}`]);
    expect(servernames).toContain("localhost");
  });
});
