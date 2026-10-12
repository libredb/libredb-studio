/**
 * The AMQP dial under Bun: one attempt, no plain retry after a TLS failure, the server name for a DNS host only, the
 * identity as given for a host with a trailing dot, the client certificate presented, the egress rule on literals and
 * on lookups (the refusal classified before the TLS class), each TLS failure by its kind (a plain listener, a certificate,
 * a refused client certificate, before and after a TLS 1.3 handshake), and the phase a stopped dial was in. dial-runtimes.test.ts runs the same rules on Node.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST, LINK_LOCAL_HOST } from "@/lib/db/http/egress-policy";
import { type AmqpSocket, DialAborted, DialFailed, dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { readStream } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import type { AmqpEndpoint } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import { tlsClientCertificateRefused } from "@/lib/db/providers/stream/rabbitmq/errors";
import { makeCertificates, type TransportCertificates } from "../../../../helpers/node-transport-fixtures";
import { closedPort, createManualClock, until } from "../../../../helpers/rabbitmq-fake-peer";

interface Counted {
  readonly server: Server;
  readonly port: number;
  accepted: number;
  /** The server names TLS clients sent; false for none. */
  readonly names: (string | false)[];
}

const servers: Counted[] = [];
const open = new Set<Socket>();
let certificates: TransportCertificates;

async function listen(
  kind:
    | "plain"
    | "silent"
    | "amqp"
    | {
        readonly cert: string;
        readonly key: string;
        readonly clientCa?: string;
        /** Require a client certificate the CA signed, refusing the connection without one, at this TLS version. */
        readonly refuse?: "TLSv1.2" | "TLSv1.3";
      },
  host = "127.0.0.1",
) {
  const counted = { accepted: 0, names: [] as (string | false)[] } as Counted & { server: Server; port: number };
  const server =
    typeof kind === "object"
      ? createTlsServer(
          {
            cert: kind.cert,
            key: kind.key,
            // With clientCa, the server asks for a client certificate and answers whether one it trusts came.
            ...(kind.clientCa === undefined
              ? {}
              : { ca: kind.clientCa, requestCert: true, rejectUnauthorized: kind.refuse !== undefined }),
            ...(kind.refuse === undefined ? {} : { maxVersion: kind.refuse }),
          },
          (socket: TLSSocket) => {
            counted.names.push(socket.servername ?? false);
            socket.on("error", () => {});
            if (kind.clientCa !== undefined && kind.refuse === undefined)
              socket.end(socket.authorized ? "authorized" : "unauthorized");
          },
        )
      : createServer((socket: Socket) => {
          socket.on("error", () => {});
          // As RabbitMQ answers a header it does not speak: its own protocol header, then the end.
          if (kind === "amqp")
            socket.once("data", () => socket.end(Buffer.from("AMQP\u0000\u0000\u0009\u0001", "latin1")));
        });
  server.on("connection", (socket: Socket) => {
    counted.accepted += 1;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
  });
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  Object.assign(counted, { server, port: (server.address() as AddressInfo).port });
  servers.push(counted);
  return counted;
}

const endpoint = (host: string, port: number, tls: AmqpEndpoint["tls"] = null): AmqpEndpoint => ({
  host,
  port,
  tls,
  username: "u",
  password: ["p", "w"].join(""),
  display: `${host}:${port}`,
});
const tlsTo = (identity: string, ca: string) => ({ rejectUnauthorized: true, ca: Buffer.from(ca), identity });

async function failure(promise: Promise<AmqpSocket>): Promise<Error> {
  try {
    const socket = await promise;
    socket.destroy();
  } catch (error) {
    return error as Error;
  }
  throw new Error("the dial succeeded");
}

async function withFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  if (value === undefined) delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  else process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
    else process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = before;
  }
}

beforeAll(() => {
  certificates = makeCertificates();
});
afterAll(async () => {
  for (const socket of open) socket.destroy();
  for (const { server } of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("plain dials", () => {
  test("a dial resolves once the server accepts, with one connection", async () => {
    const plain = await listen("plain");
    const socket = await dialAmqp(endpoint("127.0.0.1", plain.port), new AbortController().signal);
    expect(socket.destroyed).toBe(false);
    // The client's connect event can run before the server's connection event: macOS runners measured accepted 0 here.
    await until(() => plain.accepted === 1, "the server's accept");
    socket.destroy();
    expect(plain.accepted).toBe(1);
  });

  test("a closed port is refused once", async () => {
    const error = await failure(dialAmqp(endpoint("127.0.0.1", await closedPort()), new AbortController().signal));
    expect(error).toBeInstanceOf(DialFailed);
    expect((error as DialFailed).kind).toBe("refused");
  });

  test("an IPv6 literal dials without brackets and without a lookup", async () => {
    const v6 = await listen("plain", "::1");
    const socket = await withFlag(undefined, () => dialAmqp(endpoint("::1", v6.port), new AbortController().signal));
    await until(() => v6.accepted === 1, "the server's accept");
    socket.destroy();
    expect(v6.accepted).toBe(1);
  });

  test("a signal aborted before the dial, or before the connect, names the connecting phase", async () => {
    const plain = await listen("plain");
    const aborted = new AbortController();
    aborted.abort();
    const before = await failure(dialAmqp(endpoint("127.0.0.1", plain.port), aborted.signal));
    expect(before).toBeInstanceOf(DialAborted);
    expect((before as DialAborted).phase).toBe("connecting");

    const controller = new AbortController();
    const pending = dialAmqp(endpoint("127.0.0.1", plain.port), controller.signal);
    controller.abort();
    expect(((await failure(pending)) as DialAborted).phase).toBe("connecting");
  });
});

describe("TLS dials", () => {
  test("a DNS host sends its identity, a host with a trailing dot included; an IP literal sends none", async () => {
    const secure = await listen(certificates.local);
    // connection-options.ts gives a host with a trailing dot the identity without it; the dialled host keeps it.
    for (const [host, identity] of [
      ["localhost", "localhost"],
      ["localhost.", "localhost"],
      ["127.0.0.1", "127.0.0.1"],
    ] as const) {
      const socket = await dialAmqp(
        endpoint(host, secure.port, tlsTo(identity, certificates.ca)),
        new AbortController().signal,
      );
      socket.destroy();
    }
    await until(() => secure.names.length === 3, "three handshakes");
    expect(secure.names).toEqual(["localhost", "localhost", false]);
  });

  test("the client certificate and key of the TLS material are presented to a server that asks for one", async () => {
    const asking = await listen({ ...certificates.local, clientCa: certificates.ca });
    const verdict = async (material: AmqpEndpoint["tls"]): Promise<string> => {
      const socket = await dialAmqp(endpoint("localhost", asking.port, material), new AbortController().signal);
      const answer = await new Promise<string>((resolve) => {
        let text = "";
        socket.on("data", (chunk) => {
          text += Buffer.from(chunk).toString();
        });
        socket.on("end", () => resolve(text));
      });
      socket.destroy();
      return answer;
    };
    const pair = { cert: Buffer.from(certificates.client.cert), key: Buffer.from(certificates.client.key) };
    expect(await verdict({ ...tlsTo("localhost", certificates.ca), ...pair })).toBe("authorized");
    expect(await verdict(tlsTo("localhost", certificates.ca))).toBe("unauthorized");
  });

  test("a wrong CA and a wrong name fail once as the certificate, a plain listener as TLS, with no plain retry", async () => {
    const rogue = await listen(certificates.local);
    const misnamed = await listen(certificates.farName);
    const plain = await listen("amqp");
    for (const [listener, ca, kind] of [
      [rogue, certificates.rogueCa, "certificate"],
      [misnamed, certificates.ca, "certificate"],
      [plain, certificates.ca, "tls"],
    ] as const) {
      const error = await failure(
        dialAmqp(endpoint("localhost", listener.port, tlsTo("localhost", ca)), new AbortController().signal),
      );
      expect(error).toBeInstanceOf(DialFailed);
      expect((error as DialFailed).kind).toBe(kind);
      expect(listener.accepted).toBe(1);
    }
  });

  test("a TLS 1.2 broker that requires a client certificate refuses the dial without one, once", async () => {
    const refusing = await listen({ ...certificates.local, clientCa: certificates.ca, refuse: "TLSv1.2" });
    const error = await failure(
      dialAmqp(endpoint("localhost", refusing.port, tlsTo("localhost", certificates.ca)), new AbortController().signal),
    );
    expect(error).toBeInstanceOf(DialFailed);
    expect((error as DialFailed).kind).toBe("client-certificate");
    expect(refusing.accepted).toBe(1);
  });

  test("a TLS 1.3 broker refusing the client certificate after the handshake ends the read with that sentence", async () => {
    const refusing = await listen({ ...certificates.local, clientCa: certificates.ca, refuse: "TLSv1.3" });
    const at = endpoint("localhost", refusing.port, tlsTo("localhost", certificates.ca));
    const error = await readStream({
      endpoint: at,
      vhost: "/",
      stream: "st-orders",
      from: { kind: "keyword", value: "last" },
      limit: 1,
      signal: new AbortController().signal,
      deadlineSeconds: 30,
      replicas: { online: [], members: [] },
      dial: dialAmqp,
      clock: createManualClock(),
      studioVersion: null,
    }).then(
      () => new Error("the read succeeded"),
      (rejected: Error) => rejected,
    );
    expect(error.message).toBe(tlsClientCertificateRefused(at.display).message);
    expect(refusing.accepted).toBe(1);
  });

  test("a server that accepts and never finishes the handshake, stopped, names the TLS phase", async () => {
    const silent = await listen("silent");
    const controller = new AbortController();
    const pending = dialAmqp(
      endpoint("127.0.0.1", silent.port, tlsTo("127.0.0.1", certificates.ca)),
      controller.signal,
    );
    await until(() => silent.accepted === 1, "the TCP accept");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await failure(pending);
    expect(error).toBeInstanceOf(DialAborted);
    expect((error as DialAborted).phase).toBe("tls");
  });

  test("a server that closes after the TCP accept refuses the TLS connection", async () => {
    const closing = await listen("plain");
    closing.server.on("connection", (socket: Socket) => socket.destroy());
    const error = await failure(
      dialAmqp(endpoint("127.0.0.1", closing.port, tlsTo("127.0.0.1", certificates.ca)), new AbortController().signal),
    );
    expect((error as DialFailed).kind).toBe("client-certificate");
  });
});

describe("egress", () => {
  test("with the flag on, a private literal is refused before any connection, and a name by its lookup", async () => {
    const plain = await listen("plain");
    const secure = await listen(certificates.local);
    await withFlag("true", async () => {
      const literal = await failure(dialAmqp(endpoint("127.0.0.1", plain.port), new AbortController().signal));
      expect(literal).toBeInstanceOf(DatabaseConfigError);
      expect(literal.message).toBe(BLOCKED_HOST);
      const named = await failure(dialAmqp(endpoint("localhost", plain.port), new AbortController().signal));
      expect(named).toBeInstanceOf(DatabaseConfigError);
      expect(named.message).toBe(BLOCKED_HOST);
      const namedTls = await failure(
        dialAmqp(endpoint("localhost", secure.port, tlsTo("localhost", certificates.ca)), new AbortController().signal),
      );
      expect(namedTls).toBeInstanceOf(DatabaseConfigError);
      expect(namedTls.message).toBe(BLOCKED_HOST);
      const aborted = new AbortController();
      aborted.abort();
      expect((await failure(dialAmqp(endpoint("127.0.0.1", plain.port), aborted.signal))).message).toBe(BLOCKED_HOST);
    });
    expect(plain.accepted).toBe(0);
    expect(secure.accepted).toBe(0);
  });

  test("with the flag off, link-local literals are refused on both families", async () => {
    await withFlag(undefined, async () => {
      for (const host of ["169.254.169.254", "fe80::1"]) {
        const error = await failure(dialAmqp(endpoint(host, 5672), new AbortController().signal));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(error.message).toBe(LINK_LOCAL_HOST);
      }
    });
  });
});
