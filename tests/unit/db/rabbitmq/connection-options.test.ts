/**
 * The connection rules: every refusal before any socket, each an own error with its sentence, and the two endpoints
 * a valid record maps to.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { EGRESS_REFUSAL_SENTENCES } from "@/lib/db/http/egress-policy";
import { endpointUrl } from "@/lib/db/http/endpoint";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import {
  readAmqpPort,
  readConnectionOptions,
  readPathPrefix,
} from "@/lib/db/providers/stream/rabbitmq/connection-options";
import * as E from "@/lib/db/providers/stream/rabbitmq/errors";
import { type DatabaseConnection, TUNNEL_FAR_END } from "@/lib/types";
import {
  closeAll,
  httpsListener,
  jsonAnswer,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";
import { RABBITMQ_TEST_PASSWORD, rabbitmqConnection } from "../../../helpers/rabbitmq-connection";

const CA = readFileSync(join(import.meta.dir, "../../../fixtures/tls/ca.crt"), "utf8");

/** The refusal `read` throws: an own DatabaseConfigError, whose message is returned. */
function refusal(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(E.isOwnError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

const refuse = (overrides: Partial<DatabaseConnection>) =>
  refusal(() => readConnectionOptions(rabbitmqConnection(overrides)));

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
afterEach(() => {
  delete process.env[FLAG];
});

describe("the endpoints of a valid record", () => {
  test("loopback without TLS: http management on 15672, AMQP on 5672, both named host:port", () => {
    const { management, amqp } = readConnectionOptions(rabbitmqConnection());
    expect(management).toEqual({
      origin: { scheme: "http", host: "127.0.0.1", port: 15672 },
      pathPrefix: "",
      tls: null,
      username: "studio-reader",
      password: RABBITMQ_TEST_PASSWORD,
      display: "127.0.0.1:15672",
    });
    expect(amqp).toEqual({
      host: "127.0.0.1",
      port: 5672,
      tls: null,
      username: "studio-reader",
      password: RABBITMQ_TEST_PASSWORD,
      display: "127.0.0.1:5672",
    });
  });

  test("an empty or absent AMQP port browses only, and an absent port is the management default", () => {
    expect(readConnectionOptions(rabbitmqConnection({ amqpPort: "" })).amqp).toBeNull();
    expect(readConnectionOptions(rabbitmqConnection({ amqpPort: undefined })).amqp).toBeNull();
    const absent = { ...rabbitmqConnection(), port: undefined } as unknown as DatabaseConnection;
    expect(readConnectionOptions(absent).management.origin.port).toBe(15672);
  });

  test("any SSL mode but disable is https and amqps for both, with one TLS identity: the host", () => {
    const { management, amqp } = readConnectionOptions(
      rabbitmqConnection({
        host: "mq.example",
        port: 15671,
        amqpPort: "5671",
        ssl: { mode: "verify-full", caCert: CA },
      }),
    );
    expect(management.origin).toEqual({ scheme: "https", host: "mq.example", port: 15671 });
    expect(management.tls).toMatchObject({ rejectUnauthorized: true, identity: "mq.example" });
    expect(management.tls?.ca).toBeDefined();
    expect(amqp?.tls).toBe(management.tls);
    expect(amqp?.display).toBe("mq.example:5671");
  });

  test("an IPv6 literal: bracketed in the origin and the display, bare in the AMQP host and the TLS identity", () => {
    const { management, amqp } = readConnectionOptions(
      rabbitmqConnection({ host: "[::1]", ssl: { mode: "verify-full", caCert: CA } }),
    );
    expect(management.origin.host).toBe("[::1]");
    expect(management.display).toBe("[::1]:15672");
    expect(management.tls?.identity).toBe("::1");
    expect(amqp?.host).toBe("::1");
    expect(amqp?.display).toBe("[::1]:5672");
  });

  test("a DNS host with one trailing dot keeps it in the address and the display, not in either TLS identity", () => {
    const { management, amqp } = readConnectionOptions(
      rabbitmqConnection({ host: "mq.example.com.", amqpPort: "5671", ssl: { mode: "verify-full", caCert: CA } }),
    );
    expect(management.origin.host).toBe("mq.example.com.");
    expect(management.tls?.identity).toBe("mq.example.com");
    expect(amqp?.tls?.identity).toBe("mq.example.com");
    expect(amqp?.host).toBe("mq.example.com.");
    expect(amqp?.display).toBe("mq.example.com.:5671");
  });

  test("a Path prefix loses one trailing slash", () => {
    expect(readConnectionOptions(rabbitmqConnection({ apiPath: "/rabbitmq/" })).management.pathPrefix).toBe(
      "/rabbitmq",
    );
  });
});

describe("refused before any socket", () => {
  test("a tunnelled record, by the panel or by a forwarded far end", () => {
    const tunnel = { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" as const };
    expect(refuse({ sshTunnel: tunnel })).toBe(E.TUNNEL_REFUSED);
    const forwarded = { ...rabbitmqConnection(), [TUNNEL_FAR_END]: { host: "mq", port: 15672 } };
    expect(refusal(() => readConnectionOptions(forwarded))).toBe(E.TUNNEL_REFUSED);
    expect(readConnectionOptions(rabbitmqConnection({ sshTunnel: { ...tunnel, enabled: false } })).amqp).not.toBeNull();
  });

  test("Database, Namespaces and TLS server name, named and never quoted", () => {
    expect(refuse({ database: "secret-value" })).toBe(E.fieldNotOffered("database"));
    expect(refuse({ namespaces: "a,b" })).toBe(E.fieldNotOffered("namespaces"));
    expect(refuse({ tlsServerName: "mq.internal" })).toBe(E.fieldNotOffered("tlsServerName"));
    expect(refuse({ database: "secret-value" })).not.toContain("secret-value");
  });

  test("a host or port carrying a path, query, fragment or userinfo, with the shared sentence as an own error", () => {
    for (const host of [
      "mq.example/rabbitmq",
      "mq.example?x=1",
      "mq.example#f",
      "user@mq.example",
      "http://mq.example",
    ])
      expect(refuse({ host })).toBe("Invalid host: expected a hostname, an IPv4 address or an IPv6 address");
    expect(refuse({ port: "15672/api" as unknown as number })).toBe(
      "Invalid port: expected an integer from 1 to 65535",
    );
  });

  test("an empty credential, a control character or DEL, and a colon in the username", () => {
    expect(refuse({ user: "" })).toBe(E.USER_REQUIRED);
    expect(refuse({ password: "" })).toBe(E.PASSWORD_REQUIRED);
    expect(refuse({ user: "a\tb" })).toBe(E.credentialControl("Username"));
    expect(refuse({ user: `a${String.fromCharCode(0x7f)}` })).toBe(E.credentialControl("Username"));
    expect(refuse({ password: `p${String.fromCharCode(0)}w` })).toBe(E.credentialControl("Password"));
    expect(refuse({ user: "a:b" })).toBe(E.USER_COLON);
  });

  test("a field of the wrong type is named with the type it must be", () => {
    expect(refuse({ user: 5 as unknown as string })).toBe(E.fieldWrongType("user", "a string"));
    expect(refuse({ amqpPort: 5672 as unknown as string })).toBe(E.fieldWrongType("amqpPort", "a string"));
    expect(refuse({ allowInsecureAuth: "yes" as unknown as boolean })).toBe(
      E.fieldWrongType("allowInsecureAuth", "true or false"),
    );
    expect(refuse({ sshTunnel: "on" as unknown as DatabaseConnection["sshTunnel"] })).toBe(
      E.fieldWrongType("sshTunnel", "an object"),
    );
  });

  test("a malformed SSL panel is refused with the shared sentence as an own error", () => {
    expect(refuse({ ssl: { mode: "sometimes" as "disable" } })).toStartWith("Invalid ssl.mode");
  });
});

describe("the plaintext rule", () => {
  const remote = { host: "mq.example", ssl: { mode: "disable" as const } };

  test("a password without TLS to a host that is not this machine is refused, naming TLS first and the box last", () => {
    expect(refuse(remote)).toBe(E.PLAINTEXT_REFUSAL);
    expect(refuse({ ...remote, amqpPort: "" })).toBe(E.PLAINTEXT_REFUSAL);
  });

  test("the box lifts it for both endpoints; loopback and TLS never need it", () => {
    const ticked = readConnectionOptions(rabbitmqConnection({ ...remote, allowInsecureAuth: true }));
    expect(ticked.management.origin.scheme).toBe("http");
    expect(ticked.amqp?.tls).toBeNull();
    expect(readConnectionOptions(rabbitmqConnection({ host: "localhost" })).amqp?.host).toBe("localhost");
    expect(
      readConnectionOptions(rabbitmqConnection({ host: "mq.example", ssl: { mode: "require" } })).amqp,
    ).not.toBeNull();
  });
});

describe("the egress flag", () => {
  test("a private literal under DB_HTTP_BLOCK_PRIVATE_HOSTS keeps the shared sentence, which the boundary passes", () => {
    process.env[FLAG] = "true";
    const message = refuse({ host: "10.0.0.8", ssl: { mode: "require" } });
    expect(EGRESS_REFUSAL_SENTENCES.has(message)).toBe(true);
  });
});

describe("readPathPrefix", () => {
  test("empty is no prefix, and / alone is no prefix", () => {
    expect(readPathPrefix(undefined)).toBe("");
    expect(readPathPrefix(null)).toBe("");
    expect(readPathPrefix("")).toBe("");
    expect(readPathPrefix("/")).toBe("");
  });

  test("a plain prefix, one trailing slash removed", () => {
    expect(readPathPrefix("/rabbitmq")).toBe("/rabbitmq");
    expect(readPathPrefix("/a/b-c/")).toBe("/a/b-c");
    expect(readPathPrefix("/apis")).toBe("/apis");
  });

  test("one sentence per shape", () => {
    expect(refusal(() => readPathPrefix("rabbitmq"))).toBe(E.PATH_PREFIX_NO_SLASH);
    for (const value of ["//", "/a//b", "/a/./b", "/..", "/rabbitmq//"])
      expect(refusal(() => readPathPrefix(value))).toBe(E.PATH_PREFIX_DOT_SEGMENT);
    for (const value of ["/a%2Fb", "/a?x", "/a#b", "/a b", "/\u00e9"])
      expect(refusal(() => readPathPrefix(value))).toBe(E.PATH_PREFIX_NOT_PLAIN);
    for (const value of ["/api", "/rabbitmq/api", "/api/"])
      expect(refusal(() => readPathPrefix(value))).toBe(E.PATH_PREFIX_API_SEGMENT);
    expect(refusal(() => readPathPrefix(7))).toBe(E.fieldWrongType("apiPath", "a string"));
  });
});

describe("readAmqpPort", () => {
  test("empty is browse only; digits 1 to 65535 are a port", () => {
    expect(readAmqpPort(undefined)).toBeNull();
    expect(readAmqpPort("")).toBeNull();
    expect(readAmqpPort("1")).toBe(1);
    expect(readAmqpPort("5672")).toBe(5672);
    expect(readAmqpPort("65535")).toBe(65535);
  });

  test("anything else is refused with one sentence", () => {
    for (const value of ["0", "05672", "65536", "-1", "56 72", "5672a", "+5672", "123456", "1e3"])
      expect(refusal(() => readAmqpPort(value))).toBe(E.AMQP_PORT_SHAPE);
  });
});

describe("the server name a trailing-dot host sends", () => {
  let certificates: TransportCertificates;
  beforeAll(() => {
    certificates = makeCertificates();
  });
  afterEach(closeAll);

  // Without the strip the listener sees "localhost." (measured on Node 24.14.0, Bun 1.4.2 and Node 26.10.0); the
  // AMQP endpoint carries the same identity (the case above).
  test("the management endpoint of localhost. sends the server name localhost", async () => {
    const listener = await httpsListener(certificates.local, jsonAnswer(200, "{}"));
    const { management } = readConnectionOptions(
      rabbitmqConnection({
        host: "localhost.",
        port: listener.port,
        ssl: { mode: "verify-full", caCert: certificates.ca },
      }),
    );
    const transport = createNodeTransport({
      origin: management.origin,
      tls: management.tls,
      maxSockets: 1,
      headers: {},
    });
    try {
      const answer = await transport.request({
        method: "GET",
        url: endpointUrl(management.origin, "/api/whoami"),
        signal: AbortSignal.timeout(5_000),
        maxResponseBytes: 1_024,
      });
      expect(answer.status).toBe(200);
    } finally {
      transport.close();
    }
    expect(listener.seen[0].servername).toBe("localhost");
  });
});
