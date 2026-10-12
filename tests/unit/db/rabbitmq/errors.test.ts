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
      "mq.example:15672 does not speak TLS: turn TLS off, or use the TLS port (15671 for management, 5671 for AMQP).",
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
      "mq.example:15672 does not speak TLS: turn TLS off, or use the TLS port (15671 for management, 5671 for AMQP).";
    const untrusted =
      "mq.example:15672 presented a certificate Studio does not trust for this host: check the CA and the host name under SSL / TLS.";
    const refused =
      "mq.example:15672 refused the TLS connection: check the client certificate and key under SSL / TLS.";
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
      'This account can read classic or quorum queue "orders" in virtual host "/": a client using it could take their messages. Studio never does; narrow the read permission to stream names.',
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
