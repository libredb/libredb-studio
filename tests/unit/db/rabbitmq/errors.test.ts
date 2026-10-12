/**
 * The RabbitMQ sentences: each class, each filled sentence, the name escaping and cut, and the boundary that lets
 * only own errors and the shared egress refusal through.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { EGRESS_REFUSAL_SENTENCES } from "@/lib/db/http/egress-policy";
import { TransportError } from "@/lib/db/http/node-transport";
import * as E from "@/lib/db/providers/stream/rabbitmq/errors";

describe("own errors", () => {
  test("each builder gives its class, tagged rabbitmq, and registers it as own", () => {
    const built: [Error, new (...args: never[]) => Error][] = [
      [E.configError("a"), DatabaseConfigError],
      [E.connectionError("b"), ConnectionError],
      [E.authenticationError("c"), AuthenticationError],
      [E.queryError("d"), QueryError],
      [E.timeoutError("e", 5_000), TimeoutError],
      [E.cancelledError("f"), QueryCancelledError],
    ];
    for (const [error, kind] of built) {
      expect(error).toBeInstanceOf(kind);
      expect((error as { provider?: string }).provider).toBe("rabbitmq");
      expect(E.isOwnError(error)).toBe(true);
    }
    expect((E.timeoutError("e", 5_000) as TimeoutError).timeout).toBe(5_000);
  });

  test("an error of the same class built elsewhere is not own, and neither is a non-error", () => {
    expect(E.isOwnError(new QueryError("x", "rabbitmq"))).toBe(false);
    expect(E.isOwnError("x")).toBe(false);
    expect(E.isOwnError(undefined)).toBe(false);
  });
});

describe("names in sentences", () => {
  test("a short name is a JSON string literal", () => {
    expect(E.quoteName("orders")).toBe('"orders"');
    expect(E.quoteName('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("C0 and C1 controls, DEL, line separators and every bidi control are escaped as \\uXXXX", () => {
    const name = "a\u0007\u007F\u0085\u2028\u2029\u061c\u200e\u200f\u202a\u202e\u2066\u2069\nz";
    const quoted = E.quoteName(name);
    expect(quoted).toBe('"a\\u0007\\u007f\\u0085\\u2028\\u2029\\u061c\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069\\nz"');
    expect(JSON.parse(quoted)).toBe(name);
  });

  test("a name past 64 code points is cut, with ... after the closing quote; a request quote is never cut", () => {
    const long = `${"\u00e9".repeat(70)}`;
    expect(E.quoteName(long)).toBe(`"${"\u00e9".repeat(64)}"...`);
    expect(E.quoteName("x".repeat(64))).toBe(`"${"x".repeat(64)}"`);
    const name = `${"\u{1F600}".repeat(63)}\u202e`;
    expect(JSON.parse(E.quoteNameInRequest(name))).toBe(name);
    expect(E.quoteNameInRequest(long)).not.toContain("...");
  });

  test("quoteNames joins with a comma and a space", () => {
    expect(E.quoteNames(["a", "b; c"])).toBe('"a", "b; c"');
  });

  test("endpointText brackets an IPv6 literal only", () => {
    expect(E.endpointText("mq.example", 5672)).toBe("mq.example:5672");
    expect(E.endpointText("::1", 15672)).toBe("[::1]:15672");
  });
});

describe("connection sentences", () => {
  test("the fixed sentences, word for word", () => {
    expect(E.TUNNEL_REFUSED).toBe(
      "RabbitMQ connections cannot use an SSH tunnel: one tunnel carries one port, and the management API and AMQP use two.",
    );
    expect(E.PATH_PREFIX_NO_SLASH).toBe("Path prefix starts with /, for example /rabbitmq.");
    expect(E.PATH_PREFIX_DOT_SEGMENT).toBe("Path prefix may not contain an empty, . or .. segment.");
    expect(E.PATH_PREFIX_NOT_PLAIN).toBe("Path prefix takes a plain path: no %, ? or #.");
    expect(E.PATH_PREFIX_API_SEGMENT).toBe(
      "Path prefix may not contain a segment named api, which Studio reserves for the management API's own paths.",
    );
    expect(E.PLAINTEXT_REFUSAL).toStartWith(
      "This connection would send its password without TLS to a host that is not this machine",
    );
    expect(E.PLAINTEXT_REFUSAL).toEndWith(
      'Or tick "Send the password without TLS", which this connection then does on every management request and read.',
    );
    expect(E.PLAINTEXT_REFUSAL).not.toContain("SSH tunnel");
    expect(E.AMQP_PORT_REQUIRED).toBe(
      "Reading a stream needs AMQP port: set it on the connection (5672, or 5671 with TLS).",
    );
    expect(E.AMQP_PORT_EMPTY_CAUTION).toBe(
      "AMQP port is empty, so this connection browses streams but cannot read their messages; set AMQP port to read them.",
    );
  });

  test("a field not offered is named, never its value", () => {
    expect(E.fieldNotOffered("database")).toBe(
      "RabbitMQ connections take no Database: Studio discovers the virtual hosts from the management API. Clear the field; nothing was sent.",
    );
    expect(E.fieldNotOffered("namespaces")).toContain("take no Namespaces:");
    expect(E.fieldNotOffered("tlsServerName")).toBe(
      "RabbitMQ connections take no TLS server name: the certificate is always checked against Host. Clear the field; nothing was sent.",
    );
  });

  test("the credential and field sentences name the field", () => {
    expect(E.credentialControl("Username")).toStartWith("Username holds a control character");
    expect(E.credentialControl("Password")).toStartWith("Password holds a control character");
    expect(E.fieldWrongType("amqpPort", "a string of digits")).toBe(
      "The connection's amqpPort must be a string of digits; nothing was sent.",
    );
    for (const sentence of [E.USER_REQUIRED, E.PASSWORD_REQUIRED, E.USER_COLON, E.AMQP_PORT_SHAPE])
      expect(sentence).toEndWith("Nothing was sent.");
  });

  test("the version refusals are configuration errors; the unreadable one never shows the value", () => {
    const old = E.versionTooOld("4.1.9");
    expect(old).toBeInstanceOf(DatabaseConfigError);
    expect(old.message).toBe("This broker runs RabbitMQ 4.1.9; Studio supports 4.2 and later.");
    const unreadable = E.versionUnreadable();
    expect(unreadable).toBeInstanceOf(DatabaseConfigError);
    expect(unreadable.message).toBe(
      "This server's management API reports a version Studio cannot read; Studio supports RabbitMQ 4.2 and later.",
    );
  });

  test("the version refusals name the floor they are given, a .0 patch left out, so a raised floor is not stale", () => {
    expect(E.versionTooOld("4.2.9", "4.3.0").message).toBe(
      "This broker runs RabbitMQ 4.2.9; Studio supports 4.3 and later.",
    );
    expect(E.versionTooOld("4.2.0", "4.2.1").message).toBe(
      "This broker runs RabbitMQ 4.2.0; Studio supports 4.2.1 and later.",
    );
    expect(E.versionUnreadable("5.0.0").message).toBe(
      "This server's management API reports a version Studio cannot read; Studio supports RabbitMQ 5.0 and later.",
    );
  });
});

describe("the closing sentences", () => {
  test("disconnect and maintenance", () => {
    expect(E.PROVIDER_CLOSED).toBe("This connection was closed while Studio was using it, so nothing more was read.");
    expect(E.MAINTENANCE_REFUSED).toBe(
      "RabbitMQ offers no maintenance operation in Studio: Studio reads the broker and never changes it.",
    );
  });
});

/** A sentence's text must never carry a route URL: every {route} is a fixed label. */
const ROUTE = "the queue listing";

function context(overrides: Partial<E.ManagementFailureContext> = {}): E.ManagementFailureContext {
  return {
    endpoint: "mq.example:15672",
    route: ROUTE,
    scope: "object",
    site: "browse",
    vhost: "/",
    name: "orders",
    ...overrides,
  };
}

const EVERY_EGRESS_SENTENCE = [...EGRESS_REFUSAL_SENTENCES];

describe("management failures", () => {
  test("a 401 on whoami maps by its answer, the credential sentence when nothing matches", () => {
    const whoami = context({ scope: "whoami", site: "connect" });
    const local = E.managementStatusError(401, '{"reason":"User can only log in via localhost"}', whoami);
    expect(local).toBeInstanceOf(AuthenticationError);
    expect(local.message).toBe(
      "This broker accepts this user only from its own host: create a dedicated user for Studio.",
    );
    expect(E.managementStatusError(401, '{"reason":"Not management user"}', whoami).message).toBe(
      "This user may not use the management API: give it the management tag.",
    );
    expect(E.managementStatusError(401, '{"error":"not_authorized"}', whoami).message).toBe(
      "The broker refused this username and password on the management API.",
    );
    expect(E.managementStatusError(401, "", context({ scope: "server" })).message).toBe(
      "The broker refused this username and password on the management API.",
    );
  });

  test("a 404 on whoami names Management port and Path prefix", () => {
    const error = E.managementStatusError(404, "", context({ scope: "whoami", site: "connect" }));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(
      "mq.example:15672 has no RabbitMQ management API at /api/whoami: check Management port (15672, or 15671 with TLS) and Path prefix.",
    );
  });

  test("a 401, or RabbitMQ's own 404, on a vhost route is a VhostAccessError carrying the vhost and the sentence", () => {
    for (const [status, body] of [
      [401, ""],
      [404, '{"error":"not_found","reason":"vhost_not_found"}'],
      [404, '{"error":"Object Not Found","reason":"Not Found"}'],
    ] as const) {
      const error = E.managementStatusError(status, body, context({ scope: "vhost", vhost: "billing" }));
      expect(error).toBeInstanceOf(E.VhostAccessError);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as E.VhostAccessError).vhost).toBe("billing");
      expect(error.message).toBe(E.vhostUnavailableSentence("billing"));
      expect(E.isOwnError(error)).toBe(true);
    }
    expect(E.vhostUnavailableSentence("billing")).toBe(
      'This user has no permissions on virtual host "billing": grant them to show its queues and exchanges.',
    );
  });

  test("on an object route, Object Not Found names the vhost and the object; any other 404 or a 401 is vhost access", () => {
    const missing = E.managementStatusError(404, '{"error":"Object Not Found"}', context());
    expect(missing).toBeInstanceOf(QueryError);
    expect(missing.message).toBe(
      'Virtual host "/" has no queue, stream or exchange "orders", or the virtual host does not exist: refresh the tree.',
    );
    expect(E.managementStatusError(404, '{"error":"not_found"}', context())).toBeInstanceOf(E.VhostAccessError);
    expect(E.managementStatusError(401, "", context())).toBeInstanceOf(E.VhostAccessError);
  });

  test("a 404 RabbitMQ did not write, on a vhost or an object route, names the vhost and the proxy", () => {
    const proxyPage = "<html><body><h1>404 Not Found</h1></body></html>";
    for (const scope of ["vhost", "object"] as const) {
      for (const body of [proxyPage, ""]) {
        const error = E.managementStatusError(404, body, context({ scope, vhost: "/" }));
        expect(error).toBeInstanceOf(QueryError);
        expect(error).not.toBeInstanceOf(E.VhostAccessError);
        expect(error.message).toBe(
          'Virtual host "/" does not exist, or a proxy in front of the management API answered for it: refresh the tree.',
        );
      }
    }
    expect(E.vhostOrProxyNotFound("a\u202eb").message).toContain('"a\\u202eb"');
    expect(E.isOwnError(E.vhostOrProxyNotFound("/"))).toBe(true);
  });

  test("a 5xx is a server error naming the status; anything else is the unexpected-answer sentence", () => {
    const server = E.managementStatusError(503, "", context());
    expect(server).toBeInstanceOf(ConnectionError);
    expect(server.message).toBe("The management API at mq.example:15672 answered with a server error (503).");
    expect(E.managementStatusError(418, "teapot body", context()).message).toBe(
      `Studio could not read the broker's answer for ${ROUTE}.`,
    );
    expect(E.managementStatusError(404, "", context({ scope: "server" })).message).not.toContain("teapot");
  });

  test("the broker's body text never reaches a sentence", () => {
    const body = "PEER-SENTINEL Not management user User can only log in via localhost Object Not Found";
    for (const scope of ["whoami", "server", "vhost", "object"] as const) {
      for (const status of [400, 401, 403, 404, 500]) {
        expect(E.managementStatusError(status, body, context({ scope })).message).not.toContain("PEER-SENTINEL");
      }
    }
  });

  test("each transport kind maps to its sentence, never the transport's own text", () => {
    const at = context();
    const map = (kind: TransportError["kind"], message = "PEER-SENTINEL", truncated = false) =>
      E.managementTransportError(new TransportError(kind, message, { truncated }), at);
    // The client maps a deadline and a cap itself, because only it knows their numbers.
    expect(map("timeout").message).toBe(`Studio could not read the broker's answer for ${ROUTE}.`);
    expect(map("too-large").message).toBe(`Studio could not read the broker's answer for ${ROUTE}.`);
    expect(map("aborted")).toBeInstanceOf(QueryCancelledError);
    expect(map("aborted").message).toBe(E.PROVIDER_CLOSED);
    expect(map("tls", "The TLS connection failed (EPROTO)").message).toBe(
      "mq.example:15672 does not speak TLS: choose SSL mode disable under SSL / TLS, or use the TLS port (15671 for management, 5671 for AMQP).",
    );
    expect(map("redirect").message).toBe(
      "mq.example:15672 answered with a redirect, which Studio does not follow: set Host, Management port and Path prefix to the management API itself.",
    );
    expect(map("encoding").message).toStartWith("mq.example:15672 answered with a compressed or encoded body");
    expect(map("unreachable").message).toBe(
      "The connection to mq.example:15672 failed before the management API answered completely.",
    );
    expect(map("network", "The request failed before a complete response arrived (ECONNREFUSED)").message).toBe(
      "The connection to mq.example:15672 failed before the management API answered completely.",
    );
    for (const kind of [
      "timeout",
      "too-large",
      "aborted",
      "tls",
      "redirect",
      "encoding",
      "unreachable",
      "network",
    ] as const)
      expect(map(kind).message).not.toContain("PEER-SENTINEL");
  });

  test("at connect, a refused, reset or non-HTTP answer gets its own sentence; a truncated body does not", () => {
    const at = context({ scope: "whoami", site: "connect" });
    const network = (code: string, truncated = false) =>
      E.managementTransportError(
        new TransportError("network", `The request failed before a complete response arrived (${code})`, { truncated }),
        at,
      ).message;
    expect(network("ECONNREFUSED")).toBe(
      "Nothing listens on mq.example:15672: check Management port and that the rabbitmq_management plugin is enabled.",
    );
    expect(network("ECONNRESET")).toStartWith("mq.example:15672 closed the connection without an HTTP answer");
    expect(network("HPE_INVALID_CONSTANT")).toStartWith("mq.example:15672 answered with something that is not HTTP");
    expect(network("ECONNRESET", true)).toStartWith("The connection to mq.example:15672 failed");
    expect(network("EPIPE")).toStartWith("The connection to mq.example:15672 failed");
  });

  test("a TLS failure is a plain listener, a certificate Studio does not trust, or a refused connection, by its code", () => {
    const at = context({ scope: "whoami", site: "connect" });
    const tls = (code: string) =>
      E.managementTransportError(new TransportError("tls", `The TLS connection failed (${code})`), at).message;
    const plain =
      "mq.example:15672 does not speak TLS: choose SSL mode disable under SSL / TLS, or use the TLS port (15671 for management, 5671 for AMQP).";
    const untrusted =
      "mq.example:15672 presented a certificate Studio does not trust for this host: check the CA certificate under SSL / TLS, and that the certificate names the host set in Host.";
    const refused =
      "mq.example:15672 refused the TLS connection: check the client certificate and key under SSL / TLS (shown in verify-ca and verify-full).";
    // The codes measured on Node 24.14.0, Bun 1.4.2 and Node 26.10.0 against local listeners, plus two of the list.
    for (const code of ["EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PACKET_LENGTH_TOO_LONG"])
      expect(tls(code)).toBe(plain);
    for (const code of [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ])
      expect(tls(code)).toBe(untrusted);
    for (const code of [
      "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
      "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
      "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
    ])
      expect(tls(code)).toBe(refused);
    expect(E.tlsCertificateUntrusted("mq.example:15672")).toBeInstanceOf(ConnectionError);
    expect(E.tlsCertificateUntrusted("mq.example:15672").message).toBe(untrusted);
    expect(E.tlsClientCertificateRefused("mq.example:15672").message).toBe(refused);
    expect(E.isOwnError(E.tlsClientCertificateRefused("mq.example:15672"))).toBe(true);
  });

  test("tlsFailureKind reads a dial's code the same way, and a TLS connection ended with no code is a refusal", () => {
    expect(E.tlsFailureKind("ERR_SSL_WRONG_VERSION_NUMBER")).toBe("not-tls");
    expect(E.tlsFailureKind("HOSTNAME_MISMATCH")).toBe("certificate");
    // Node's own spelling of a TLS 1.2 handshake alert on a raw socket, measured on Node 24.14.0 and 26.10.0.
    expect(E.tlsFailureKind("ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE")).toBe("client-certificate");
    expect(E.tlsFailureKind("ECONNRESET")).toBe("client-certificate");
    expect(E.tlsFailureKind(undefined)).toBe("client-certificate");
    const reset = new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)");
    expect(E.transportCode(reset)).toBe("ECONNRESET");
    expect(E.transportCode(new TransportError("tls", "no code here"))).toBeUndefined();
  });

  test("an aborted GET of a read is the read's cancel sentence", () => {
    const error = E.managementTransportError(new TransportError("aborted", "x"), context({ site: "read" }));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe(E.READ_CANCELLED_BEFORE_START);
    expect(E.READ_CANCELLED_BEFORE_START).toBe("The read was stopped before it started; nothing was read.");
  });

  test("the cap, depth, JSON, shape and timeout sentences name the route and the cap in KiB or MiB", () => {
    expect(E.managementTooLarge(context(), 65_536).message).toBe(
      `The broker's answer for ${ROUTE} is larger than the 64 KiB Studio accepts.`,
    );
    expect(E.managementTooLarge(context(), 16_777_216).message).toContain("the 16 MiB Studio accepts");
    expect(E.managementTooLarge(context(), 1_000).message).toContain("the 1000 bytes Studio accepts");
    expect(E.managementTooDeep(context()).message).toBe(
      `The broker's answer for ${ROUTE} nests deeper than 64 levels, which Studio does not accept.`,
    );
    expect(E.managementNotJson(context())).toBeInstanceOf(ConnectionError);
    expect(E.managementNotJson(context()).message).toBe(
      "mq.example:15672 answered with something that is not the management API's JSON: check Management port and Path prefix.",
    );
    expect(E.managementWrongShape(context()).message).toBe(
      `The broker's answer for ${ROUTE} is not in the shape Studio reads.`,
    );
    const timeout = E.managementTimeout(context(), 0.5);
    expect(timeout.message).toContain("within 0.5 s.");
    expect((timeout as TimeoutError).timeout).toBe(500);
    expect(E.dotSegmentRefusal().message).toBe(
      "Studio cannot address a virtual host, queue, stream or exchange named . or .. over the management API.",
    );
  });

  test("the management client's own refusals and the overview's fixed words", () => {
    const empty = E.emptyNameRefusal();
    expect(empty).toBeInstanceOf(QueryError);
    expect(empty.message).toBe(
      "Studio cannot address a virtual host, queue, stream or exchange with an empty name over the management API.",
    );
    expect(E.unknownKind("topic").message).toBe('RabbitMQ declares no object kind "topic".');
    expect(E.unknownKind(`a${String.fromCharCode(0x202e)}b`).message).toContain('"a\\u202eb"');
    expect(E.NOT_CONNECTED).toBe("Provider is not connected. Call connect() first.");
    expect(E.MANAGEMENT_SLOTS_FULL).toBe(
      "Too many management requests are waiting on this Studio server; try again when one ends.",
    );
    expect(E.NO_ALARM_STATUS).toBe("No resource alarm");
    expect(E.OVERVIEW_COUNT_NOT_READ).toBe(
      "no listing, because the overview reads only the version and the alarms; the tree counts each virtual host's streams",
    );
  });

  test("a VhostAccessError built by the client carries the sentence it is given and is own", () => {
    const error = new E.VhostAccessError(E.vhostUnavailableSentence("billing"), "billing");
    expect(error.message).toBe(E.vhostUnavailableSentence("billing"));
    expect(error.vhost).toBe("billing");
    expect(E.isOwnError(error)).toBe(true);
  });
});

describe("the boundary", () => {
  const at: E.BoundaryContext = { site: "browse", endpoint: "mq.example:15672", route: ROUTE };

  test("an own error and every shared egress refusal pass through unchanged", () => {
    const own = E.queryError("mine");
    expect(E.rabbitmqBoundary(own, at)).toBe(own);
    expect(EVERY_EGRESS_SENTENCE.length).toBe(3);
    for (const sentence of EVERY_EGRESS_SENTENCE) {
      const egress = new DatabaseConfigError(sentence);
      expect(E.rabbitmqBoundary(egress, at)).toBe(egress);
    }
  });

  test("anything else becomes the unexpected-answer sentence, and the original is not its message or cause", () => {
    const values: unknown[] = [
      new Error("PEER-SENTINEL"),
      new TypeError("PEER-SENTINEL in a type error"),
      new SyntaxError("Unexpected token < in JSON at position 0: <html>PEER-SENTINEL"),
      new DOMException("PEER-SENTINEL", "AbortError"),
      new DatabaseConfigError("PEER-SENTINEL"),
      new QueryError("PEER-SENTINEL", "rabbitmq"),
      "PEER-SENTINEL",
      undefined,
    ];
    for (const value of values) {
      const mapped = E.rabbitmqBoundary(value, at);
      expect(mapped).toBeInstanceOf(QueryError);
      expect(mapped.message).toBe(`Studio could not read the broker's answer for ${ROUTE}.`);
      expect(JSON.stringify({ message: mapped.message, cause: mapped.cause })).not.toContain("PEER-SENTINEL");
    }
  });

  test("an unmapped TransportError maps by kind; a deadline or a cap the client should have mapped is unexpected", () => {
    const map = (kind: TransportError["kind"], site: E.ErrorSite = "browse") =>
      E.rabbitmqBoundary(new TransportError(kind, "content-encoding: PEERSENTINEL"), { ...at, site });
    expect(map("aborted")).toBeInstanceOf(QueryCancelledError);
    expect(map("aborted", "read").message).toBe(E.READ_CANCELLED_BEFORE_START);
    expect(map("tls").message).toContain("refused the TLS connection");
    const certificate = new TransportError("tls", "The TLS connection failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
    expect(E.rabbitmqBoundary(certificate, at).message).toContain("presented a certificate Studio does not trust");
    const plain = new TransportError("tls", "The TLS connection failed (EPROTO)");
    expect(E.rabbitmqBoundary(plain, at).message).toContain("does not speak TLS");
    expect(map("redirect").message).toContain("answered with a redirect");
    expect(map("encoding").message).toContain("compressed or encoded body");
    expect(map("unreachable").message).toContain("failed before the management API answered completely");
    expect(map("network").message).toContain("failed before the management API answered completely");
    expect(map("timeout").message).toBe(`Studio could not read the broker's answer for ${ROUTE}.`);
    expect(map("too-large").message).toBe(`Studio could not read the broker's answer for ${ROUTE}.`);
    for (const kind of [
      "aborted",
      "tls",
      "redirect",
      "encoding",
      "unreachable",
      "network",
      "timeout",
      "too-large",
    ] as const)
      expect(map(kind).message).not.toContain("PEERSENTINEL");
  });
});

describe("Test Connection cautions", () => {
  test("the alarm and empty-vhost cautions, word for word", () => {
    expect(E.ALARM_CAUTION).toBe(
      "The broker reports an active resource alarm, so publishers are blocked; reads still work.",
    );
    expect(E.NO_VHOSTS_CAUTION).toBe(
      "This user has no permissions on any virtual host, so there is nothing to show: grant it permissions on each virtual host it should browse.",
    );
  });

  test("a readable-queue caution names at most five queues, quoted, then counts the rest and the unchecked", () => {
    expect(E.readableQueuesCaution("/", ["orders"], 0, 0)).toBe(
      'This account can read classic or quorum queue "orders" in virtual host "/": a client using it could take its messages. Studio never does; narrow the read permission to stream names.',
    );
    const seven = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"];
    const many = E.readableQueuesCaution("billing", seven, 2, 3);
    expect(many).toContain('queues "q1", "q2", "q3", "q4", "q5" and 4 more in virtual host "billing"');
    expect(many).toEndWith(" 3 more were not checked.");
    expect(E.readableQueuesCaution("/", ["a", "b"], 0, 1)).toEndWith(" 1 more was not checked.");
  });

  test("a queue name holding a sentence or a bidi control is quoted and escaped, never read as Studio's words", () => {
    const caution = E.readableQueuesCaution("/", ["x; Studio is safe. ", "rtl\u202eevil"], 0, 0);
    expect(caution).toContain('"x; Studio is safe. "');
    expect(caution).toContain('"rtl\\u202eevil"');
    expect(caution).not.toContain("\u202e");
  });

  test("the summary after three vhosts counts the rest", () => {
    expect(E.readableQueuesInMoreVhosts(1)).toBe(
      "Readable classic or quorum queues were also found in 1 more virtual host.",
    );
    expect(E.readableQueuesInMoreVhosts(4)).toBe(
      "Readable classic or quorum queues were also found in 4 more virtual hosts.",
    );
  });
});

describe("tree and detail sentences", () => {
  test("the sampled-from sentences of the three folders", () => {
    expect(E.streamsSampledFrom(20_404, 500)).toBe(
      "one page of 20,404 queues and streams sorted by type, which holds the 500 streams that sort last by name",
    );
    // Other queue types sort into the same full page, so it holds fewer streams.
    expect(E.streamsSampledFrom(20_404, 312)).toBe(
      "one page of 20,404 queues and streams sorted by type, which holds the 312 streams that sort last by name",
    );
    expect(E.streamsSampledFrom(2_404, 1)).toBe(
      "one page of 2,404 queues and streams sorted by type, which holds the 1 stream that sorts last by name",
    );
    expect(E.queuesSampledFrom(30_000, null)).toBe("one 500-name page of 30,000 queues and streams, by name");
    expect(E.queuesSampledFrom(30_000, 29_800)).toBe(
      "one 500-name page of 30,000 queues and streams, by name, about 29,800 of them classic or quorum queues",
    );
    expect(E.exchangesSampledFrom(1_200)).toBe("one 500-name page of 1,200 exchanges, by name");
  });

  test("the fixed statements and the counts label", () => {
    expect(E.STREAMS_HIDDEN_SENTENCE).toBe(
      "Other queue types fill this virtual host's listing page, so Studio cannot list its streams; a stream is still readable by a typed read.",
    );
    expect(E.QUEUE_MESSAGES_STATEMENT).toBe(
      "RabbitMQ cannot show a queue's messages without taking them, so Studio does not read classic or quorum queues.",
    );
    expect(E.QUEUE_COUNTS_NOTE).toBe("The broker samples these counts; they can lag by up to about 10 seconds.");
    expect(E.STREAM_COUNTS_NOTE).toBe(
      "A stream's message count is sampled every 5 seconds and can include compressed batches that no AMQP reader receives.",
    );
    expect(E.countsLabel("12:00:05")).toBe("Counts (sampled at 12:00:05)");
  });
});

describe("read request sentences", () => {
  test("an unknown key is named quoted, escaped and cut", () => {
    expect(E.unknownRequestKey("offset")).toBe(
      'Unknown key "offset" in the read request; the keys are vhost, stream, from and limit.',
    );
    expect(E.unknownRequestKey("a\u202eb")).toContain('"a\\u202eb"');
  });

  test("the request refusals, word for word", () => {
    expect(E.FROM_FORMS).toBe(
      '"from" is "first", "last", "next", {"offset": n}, {"timestamp": "<ISO-8601 with a zone>"} or {"age": "<n><unit>"}, with unit Y, M (months), D, h, m (minutes) or s.',
    );
    expect(E.LIMIT_RANGE).toBe('"limit" must be a whole number from 1 to 500.');
    expect(E.NAMES_REQUIRED).toBe(
      '"vhost" and "stream" are required strings of 1 to 255 bytes, without NUL, and not . or ..',
    );
    expect(E.OFFSET_NOT_WHOLE).toBe(
      "The offset must be a non-negative whole number; above 9007199254740991 write it as a digit string.",
    );
    expect(E.OFFSET_TOO_LARGE).toBe("The offset must be at most 9223372036854775807.");
    expect(E.TIMESTAMP_BEFORE_EPOCH).toBe("The timestamp must be at or after 1970-01-01T00:00:00Z.");
    expect(E.TIMESTAMP_FORM).toContain("RabbitMQ");
    expect(E.TIMESTAMP_FORM).not.toContain("Kafka");
    expect(E.TIMESTAMP_DAY).toBe("The timestamp names a day of a month that does not have it.");
    for (const sentence of [E.REQUEST_NOT_OBJECT, E.REQUEST_EMPTY])
      expect(JSON.parse(sentence.slice(sentence.indexOf("{"), -1))).toBeDefined();
    expect(E.REQUEST_PARAMS).toBe("Bound params are not supported: a RabbitMQ read request has no placeholders.");
  });

  test("the type check names classic and quorum, and nothing else the broker reports", () => {
    expect(E.notAStream("jobs", "classic").message).toBe(
      '"jobs" is a classic queue; Studio reads streams only, because reading a queue removes messages.',
    );
    expect(E.notAStream("jobs", "quorum").message).toContain("is a quorum queue");
    const other = E.notAStream("jobs", "<script>");
    expect(other).toBeInstanceOf(QueryError);
    expect(other.message).toBe('"jobs" is not a stream; Studio reads streams only.');
  });
});

describe("read failures before consume-ok", () => {
  const read: E.ReadFailureContext = {
    endpoint: "mq.example:5672",
    vhost: "billing",
    stream: "audit",
    online: ["rabbit@a"],
    members: ["rabbit@a", "rabbit@b"],
  };
  const close = (replyCode: number, replyText: string, scope: "connection" | "channel" = "connection") =>
    E.amqpCloseError({ replyCode, replyText, classId: 0, methodId: 0, scope }, read);

  test("every protocol fact is a fixed phrase", () => {
    const facts: E.ProtocolFact[] = [
      "frame-too-large",
      "frame-end",
      "unknown-field",
      "body-ceiling",
      "header-too-large",
      "unexpected-frame",
      "unknown-frame-type",
      "missing-offset",
      "malformed-frame",
    ];
    const sentences = facts.map((fact) => E.amqpProtocolError("mq.example:5672", fact).message);
    expect(new Set(sentences).size).toBe(facts.length);
    expect(sentences[0]).toBe(
      "The server at mq.example:5672 broke the AMQP 0-9-1 protocol (a frame larger than the negotiated size); the read was stopped.",
    );
    expect(sentences[3]).toContain("(a message body above 512 MiB)");
    expect(sentences[7]).toContain("(a message without its stream offset)");
    expect(sentences[8]).toContain("(a frame whose fields do not fit its size)");
  });

  test("a 403 is the credential refusal at handshake and the read refusal on the channel", () => {
    const auth = close(
      403,
      "ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN. user: 'studio-reader'",
    );
    expect(auth).toBeInstanceOf(AuthenticationError);
    expect(auth.message).toBe("The broker refused this username and password on the AMQP port.");
    const channel = close(
      403,
      "ACCESS_REFUSED - read access to queue 'audit' in vhost 'billing' refused for user 'studio-reader'",
      "channel",
    );
    expect(channel).toBeInstanceOf(QueryError);
    expect(channel.message).toBe(
      'This user may not read stream "audit": its read permission pattern on "billing" does not match the name.',
    );
    expect(channel.message).not.toContain("studio-reader");
  });

  test("a 530 by its fixed patterns, the code alone otherwise", () => {
    expect(close(530, "NOT_ALLOWED - vhost billing not found").message).toBe(
      'The broker has no virtual host "billing".',
    );
    const access = close(530, "NOT_ALLOWED - access to vhost 'billing' refused for user 'studio-reader'");
    expect(access).toBeInstanceOf(AuthenticationError);
    expect(access.message).toBe('This user may not open virtual host "billing" over AMQP: grant it permissions there.');
    expect(close(530, "SOMETHING ELSE").message).toBe(
      'Virtual host "billing" does not exist, or this user may not open it over AMQP: check both in the management UI.',
    );
  });

  test("a 404, a 406 without a replica, a 541 and any other code", () => {
    expect(close(404, "NOT_FOUND - no queue 'audit'", "channel").message).toContain(
      'has no queue, stream or exchange "audit"',
    );
    expect(close(406, "PRECONDITION_FAILED - x-stream-offset", "channel").message).toBe(
      '"audit" is not a stream; Studio reads streams only.',
    );
    expect(close(541, "INTERNAL_ERROR").message).toBe(E.conversionAtConsume("audit").message);
    expect(close(320, "CONNECTION_FORCED - PEER-SENTINEL").message).toBe(
      "Studio could not read the broker's answer for the stream read.",
    );
  });

  test("the no-replica 406 picks its sentence from the type check's node lists", () => {
    const replica =
      "PRECONDITION_FAILED - stream queue 'audit' in vhost 'billing' does not have a running replica on the local node";
    const at = (online: string[], members: string[]) =>
      E.amqpCloseError(
        { replyCode: 406, replyText: replica, classId: 60, methodId: 20, scope: "channel" },
        { ...read, online, members },
      ).message;
    expect(at(["rabbit@a"], ["rabbit@a", "rabbit@b"])).toBe(
      'The node behind AMQP port holds no running replica of stream "audit"; replicas are reported online on other nodes: point AMQP port at one of them.',
    );
    expect(at([], ["rabbit@a"])).toBe('No replica of stream "audit" is reported online.');
    expect(at(["rabbit@b", "rabbit@a"], ["rabbit@a", "rabbit@b"])).toBe(
      'The node behind AMQP port may still be starting its replica of stream "audit": read again in a few seconds.',
    );
  });

  test("the AMQP connection sentences name the endpoint only", () => {
    const at = "mq.example:5672";
    expect(E.amqpUnreachable(at).message).toBe("Nothing listens on mq.example:5672: check the address and AMQP port.");
    expect(E.amqpNotTls(at).message).toContain("does not speak TLS");
    expect(E.amqpExpectsTls(at).message).toBe(
      "mq.example:5672 expects TLS: choose an SSL mode under SSL / TLS, or use 5672.",
    );
    expect(E.amqpNoSession(at).message).toBe(
      "mq.example:5672 did not start an AMQP session: check that AMQP port is 5672 (5671 with TLS).",
    );
    expect(E.amqpOtherProtocol(at).message).toContain("not 5552 or 15672");
    expect(E.amqpNoPlain(at).message).toBe(
      "The server at mq.example:5672 offers no PLAIN login, the only one Studio uses.",
    );
    expect(E.frameMaxTooSmall(4_096).message).toBe(
      "The broker proposed a frame size of 4,096 bytes, below the 8,192 RabbitMQ requires.",
    );
    expect(E.heartbeatsMissed(at).message).toBe("mq.example:5672 stopped answering during the AMQP handshake.");
    for (const error of [E.amqpUnreachable(at), E.amqpNoPlain(at), E.frameMaxTooSmall(1), E.heartbeatsMissed(at)])
      expect(error).toBeInstanceOf(ConnectionError);
  });

  test("each phase timeout names its phase and is a TimeoutError", () => {
    const at = { seconds: 30, endpoint: "mq.example:5672", stream: "audit" };
    expect(E.readPhaseTimeout("queued", at).message).toBe("Waited 30 s for a read slot; the stream was not read.");
    expect(E.readPhaseTimeout("connecting", at).message).toBe("No answer from mq.example:5672 within 30 s.");
    expect(E.readPhaseTimeout("tls", at).message).toBe(
      "mq.example:5672 accepted the connection but did not finish the TLS handshake within 30 s.",
    );
    expect(E.readPhaseTimeout("handshake", at).message).toBe(
      'Waited 30 s for the broker to start the read of stream "audit"; nothing was read.',
    );
    expect(E.readPhaseTimeout("queued", at)).toBeInstanceOf(TimeoutError);
    expect((E.readPhaseTimeout("queued", at) as TimeoutError).timeout).toBe(30_000);
    expect(E.READ_SLOTS_FULL).toBe("Too many stream reads are running on this Studio server; try again when one ends.");
    expect(E.conversionAtConsume("audit").message).toStartWith(
      'The broker closed the connection (541 INTERNAL_ERROR) while starting the read of stream "audit"',
    );
  });
});

describe("stop warnings", () => {
  const big = BigInt("9223372036854775806");

  test("idle, next, budget and wire, with offsets as decimal strings", () => {
    expect(E.IDLE_WARNING).toBe("No further message arrived within 1 s; this is not proof that the stream ends here.");
    expect(E.NEXT_EMPTY_WARNING).toContain('A read from "next" reads only messages published after the read started');
    expect(E.budgetWarning(big)).toBe(
      "The result reached its 8 MiB limit before offset 9223372036854775806; read again from offset 9223372036854775806.",
    );
    expect(E.wireWarning(BigInt(42))).toBe(
      "The read transferred 64 MiB before offset 42, mostly bodies longer than 262,144 bytes; read again from offset 42 with a smaller limit.",
    );
    expect(E.wireOversizeAtOffset(big)).toContain("read from offset 9223372036854775807 to continue past it.");
    expect(E.wireOversizeUnknown(BigInt(7))).toBe(
      "A message after offset 7 is larger than the 64 MiB one read may transfer, so Studio cannot show it or name its offset.",
    );
    expect(E.wireOversizeUnknown(null)).toStartWith("A message at the read's start is larger");
  });

  test("the last-chunk hint steps back 50 offsets, never below 0, and quotes a request that parses back", () => {
    const hint = E.lastIdleWarning("/", "orders", 3, BigInt(120));
    expect(hint).toBe(
      'Read from "last" starts at the broker\'s last stored chunk, here 3 messages; for older messages read {"vhost": "/", "stream": "orders", "from": {"offset": "70"}}.',
    );
    expect(E.lastIdleWarning("/", "orders", 1, BigInt(10))).toContain("here 1 message; for older messages read");
    expect(E.lastIdleWarning("/", "orders", 1, BigInt(10))).toContain('{"offset": "0"}');
    const name = `x${"\u00e9".repeat(200)}\u202e`;
    const quoted = E.lastIdleWarning(name, name, 2, BigInt(5));
    const request = JSON.parse(quoted.slice(quoted.indexOf('{"vhost"'), -1)) as { vhost: string; stream: string };
    expect(request).toMatchObject({ vhost: name, stream: name });
  });

  test("server cancel, close, deadline and cancel, with and without a row", () => {
    expect(E.serverCancelWarning(BigInt(9))).toBe(
      "The broker ended the read after offset 9: the stream may have been deleted.",
    );
    expect(E.serverCancelWarning(null)).toContain("before delivering any message");
    expect(E.closedWarning(BigInt(9))).toBe(
      "The broker closed the connection after offset 9; the rows read so far are shown.",
    );
    expect(E.closedWarning(null)).toBe("The broker closed the connection before delivering any message.");
    expect(E.deadlineWarning(30, BigInt(9))).toBe(
      "The read stopped at its time limit of 30 s after offset 9; rows read so far are shown; read again from offset 9.",
    );
    expect(E.deadlineWarning(1.1, null)).toBe(
      "The read stopped at its time limit of 1.1 s before any message arrived.",
    );
    expect(E.cancelWarning(BigInt(9))).toBe("The read was stopped after offset 9; rows read so far are shown.");
    expect(E.cancelWarning(null)).toBe("The read was stopped before any message arrived.");
    expect(E.TIMESTAMP_START_WARNING).toStartWith("A timestamp read starts at the chunk that holds that second");
  });
});

describe("conversion sentences", () => {
  test("after offset N with prefetch above 1 bounds the message within P, and quotes a one-row read from N + 1", () => {
    expect(E.conversionAfter(BigInt(41), 10, "/", "orders")).toBe(
      'The broker closed the connection (541 INTERNAL_ERROR) after offset 41: it could not convert the next message to AMQP 0-9-1. The message is within the next 10 messages after offset 41, and messages between may not have been delivered. Read {"vhost": "/", "stream": "orders", "from": {"offset": "42"}, "limit": 1} and step one offset at a time to find it; a read that returns no row stops on it.',
    );
  });

  test("with prefetch 1 the first sentence names the next message after N and the bound is left out", () => {
    const one = E.conversionAfter(BigInt(41), 1, "/", "orders");
    expect(one).toStartWith(
      "The broker closed the connection (541 INTERNAL_ERROR) after offset 41: it could not convert the next message after offset 41 to AMQP 0-9-1. Read",
    );
    expect(one).not.toContain("within the next");
  });

  test("no row from a numeric start names S and P, or the first message with P = 1", () => {
    const many = E.conversionNoRowNumeric(BigInt(100), 10, "/", "orders");
    expect(many).toContain(
      "it could not convert one of the first 10 messages it would deliver from offset 100 to AMQP 0-9-1.",
    );
    expect(many).toContain('Read {"vhost": "/", "stream": "orders", "from": {"offset": "100"}, "limit": 1}');
    expect(E.conversionNoRowNumeric(BigInt(100), 1, "/", "orders")).toContain(
      "it could not convert the first message it would deliver from offset 100",
    );
  });

  test("no row from a keyword start bisects, and a last start adds the message-count hint", () => {
    const first = E.conversionNoRowKeyword('"first"', false, "/", "orders");
    expect(first).toContain('one of the first messages from "first" cannot be converted to AMQP 0-9-1.');
    expect(first).toContain('Read {"vhost": "/", "stream": "orders", "from": "first", "limit": 1}');
    expect(first).not.toContain("message count in its detail");
    const last = E.conversionNoRowKeyword('"last"', true, "/", "orders");
    expect(last).toContain("The stream's message count in its detail, read as an offset");
    expect(last.indexOf("message count in its detail")).toBeLessThan(last.indexOf("Halve the range"));
  });

  test("every quoted request holds the full escaped names and parses back to them", () => {
    const vhost = `v${"x".repeat(254)}`;
    const stream = 'a\nb\u202ec, "d"';
    for (const sentence of [
      E.conversionAfter(BigInt(1), 10, vhost, stream),
      E.conversionNoRowNumeric(BigInt(1), 10, vhost, stream),
      E.conversionNoRowKeyword('{"age": "1h"}', false, vhost, stream),
    ]) {
      const start = sentence.indexOf('{"vhost"');
      const end = sentence.indexOf('"limit": 1}', start) + '"limit": 1}'.length;
      const request = JSON.parse(sentence.slice(start, end)) as { vhost: string; stream: string };
      expect(request.vhost).toBe(vhost);
      expect(request.stream).toBe(stream);
      expect(sentence).not.toContain("\u202e");
    }
  });
});

describe("rendering warnings", () => {
  test("each count is singular for one and plural otherwise", () => {
    expect(E.timestampsOutOfRange(1)).toBe(
      "1 timestamp is outside the range a date can show and is shown as seconds since the epoch.",
    );
    expect(E.timestampsOutOfRange(2)).toBe(
      "2 timestamps are outside the range a date can show and are shown as seconds since the epoch.",
    );
    expect(E.cellsCut(1)).toBe("1 cell was cut at 65,536 characters.");
    expect(E.cellsCut(3)).toBe("3 cells were cut at 65,536 characters.");
    expect(E.amqp10Bodies(1)).toBe("1 message was published over AMQP 1.0; Studio shows their encoded bytes.");
    expect(E.amqp10Bodies(2)).toBe("2 messages were published over AMQP 1.0; Studio shows their encoded bytes.");
    expect(E.deepPayloads(1)).toBe("1 payload nests deeper than 64 levels and is shown as base64.");
    expect(E.deepPayloads(5)).toBe("5 payloads nest deeper than 64 levels and are shown as base64.");
    expect(E.cutBodies(1)).toBe(
      "1 payload longer than 262,144 bytes shows its first bytes only; payload_bytes has the full size.",
    );
    expect(E.cutBodies(4)).toBe(
      "4 payloads longer than 262,144 bytes show their first bytes only; payload_bytes has the full size.",
    );
  });
});
