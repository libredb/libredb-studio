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
