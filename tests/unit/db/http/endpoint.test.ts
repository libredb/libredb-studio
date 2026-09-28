/**
 * HTTP transport endpoints
 *
 * The host and port fields of an HTTP-based connection must only ever address the
 * configured server and the transport's own fixed paths. These tables pin what the
 * shared module accepts, what it refuses, and that a refusal never repeats the value
 * it refused.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import {
  endpointUrl,
  httpOrigin,
  type HttpOrigin,
  rejectRedirect,
  validateHost,
  validatePort,
} from "@/lib/db/http/endpoint";

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("httpOrigin: host", () => {
  const accepted: [label: string, input: string, host: string][] = [
    ["a single-label name", "localhost", "localhost"],
    ["a dotted name", "db.example.com", "db.example.com"],
    ["a mixed-case name, lowered the way a URL lowers it", "DB.Example.COM", "db.example.com"],
    ["a name with hyphens", "clickhouse-1.internal", "clickhouse-1.internal"],
    ["a compose service name with an underscore", "my_db", "my_db"],
    ["a name with a digit-led label", "1password.example", "1password.example"],
    ["a fully qualified name with the root dot", "example.com.", "example.com."],
    ["a 63-character label", `${"a".repeat(63)}.example`, `${"a".repeat(63)}.example`],
    ["IPv4 loopback", "127.0.0.1", "127.0.0.1"],
    ["IPv4 any", "0.0.0.0", "0.0.0.0"],
    ["IPv4 broadcast", "255.255.255.255", "255.255.255.255"],
    ["bare IPv6 loopback", "::1", "[::1]"],
    ["bracketed IPv6 loopback", "[::1]", "[::1]"],
    ["upper-case IPv6", "2001:DB8::1", "[2001:db8::1]"],
    ["full-form IPv6", "2001:0db8:0000:0000:0000:0000:0000:0001", "[2001:0db8:0000:0000:0000:0000:0000:0001]"],
    ["IPv4-mapped IPv6", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]"],
  ];

  test.each(accepted)("accepts %s", (_label, input, host) => {
    expect(httpOrigin("http", input, 8080).host).toBe(host);
  });

  const refused: [label: string, input: unknown][] = [
    ["an empty string", ""],
    ["a slash", "evil.example/path"],
    ["a question mark", "db?x=1"],
    ["a hash", "db#fragment"],
    ["an at sign", "user@evil.example"],
    ["a backslash", "db\\evil"],
    ["a percent sign", "db%2fevil"],
    ["an inner space", "db evil"],
    ["a leading space", " localhost"],
    ["a trailing newline", "localhost\n"],
    ["a tab", "\t"],
    ["a host:port pair", "db:8080"],
    ["a leading hyphen", "-db.example"],
    ["a trailing hyphen", "db-.example"],
    ["an empty label", "db..example"],
    ["a 64-character label", `${"a".repeat(64)}.example`],
    ["a name over 253 characters", `${"a.".repeat(127)}ab`],
    ["an IPv4 octet above 255", "256.1.1.1"],
    ["a three-part IPv4", "1.2.3"],
    ["an IPv4 octet with a leading zero", "01.2.3.4"],
    ["an IPv4 with a trailing dot", "1.2.3.4."],
    ["a shorthand IPv4", "127.1"],
    ["a bare number", "1234"],
    ["a hexadecimal number", "0x7f"],
    ["a hexadecimal final label", "db.0x7f"],
    ["an unclosed IPv6 bracket", "[::1"],
    ["a stray IPv6 bracket", "::1]"],
    ["a bracketed IPv4", "[127.0.0.1]"],
    ["an IPv6 zone", "fe80::1%eth0"],
    ["an encoded IPv6 zone", "[fe80::1%25eth0]"],
    ["an IPv6 with nine groups", "1:2:3:4:5:6:7:8:9"],
    ["a triple colon", ":::"],
    ["undefined", undefined],
    ["null", null],
    ["a number", 127],
  ];

  test.each(refused)("refuses %s with DatabaseConfigError", (_label, input) => {
    const error = refusal(() => httpOrigin("http", input, 8080));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toMatch(/\bhost\b/);
  });

  test("names the field without repeating the value", () => {
    const error = refusal(() => httpOrigin("https", "evil.example/leak?token=SECRET", 443));
    expect(error.message).toMatch(/\bhost\b/);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("evil.example");
  });
});

describe("httpOrigin: port", () => {
  const accepted: [input: unknown, port: number][] = [
    [1, 1],
    [80, 80],
    [8123, 8123],
    [65535, 65535],
    ["8123", 8123],
  ];

  test.each(accepted)("accepts %p", (input, port) => {
    expect(httpOrigin("http", "localhost", input).port).toBe(port);
  });

  const refused: [label: string, input: unknown][] = [
    ["zero", 0],
    ["65536", 65536],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["digits followed by letters", "8123abc"],
    ["a leading space", " 8123"],
    ["a trailing space", "8123 "],
    ["a plus sign", "+8123"],
    ["a decimal string", "8123.0"],
    ["a hexadecimal string", "0x1F"],
    ["an exponent string", "1e3"],
    ["a string above the range", "65536"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
  ];

  test.each(refused)("refuses %s with DatabaseConfigError", (_label, input) => {
    const error = refusal(() => httpOrigin("http", "localhost", input));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toMatch(/\bport\b/);
  });

  test("names the field without repeating the value", () => {
    const error = refusal(() => httpOrigin("http", "localhost", "8123/../admin"));
    expect(error.message).toMatch(/\bport\b/);
    expect(error.message).not.toContain("8123");
    expect(error.message).not.toContain("admin");
  });
});

describe("endpointUrl", () => {
  const origin = httpOrigin("http", "db.example", 8123);

  test("builds the origin and path", () => {
    expect(endpointUrl(origin, "/v1/statement")).toBe("http://db.example:8123/v1/statement");
  });

  test("omits a scheme's default port the way a URL does", () => {
    expect(endpointUrl(httpOrigin("http", "db.example", 80), "/")).toBe("http://db.example/");
    expect(endpointUrl(httpOrigin("https", "db.example", 443), "/")).toBe("https://db.example/");
  });

  test("keeps a non-default port on https", () => {
    expect(endpointUrl(httpOrigin("https", "db.example", 80), "/")).toBe("https://db.example:80/");
  });

  test("brackets an IPv6 host", () => {
    expect(endpointUrl(httpOrigin("http", "::1", 8080), "/v2/pipeline")).toBe("http://[::1]:8080/v2/pipeline");
  });

  test("compares an IPv6 host by address, not by spelling", () => {
    const url = endpointUrl(httpOrigin("http", "2001:0db8:0000:0000:0000:0000:0000:0001", 8080), "/");
    expect(url).toBe("http://[2001:db8::1]:8080/");
    expect(endpointUrl(httpOrigin("http", "::ffff:127.0.0.1", 8080), "/")).toBe("http://[::ffff:7f00:1]:8080/");
  });

  test("encodes query parameters, so a value cannot open a fragment or a new parameter", () => {
    const params = new URLSearchParams({ database: "a&b=c#d", note: "x y" });
    expect(endpointUrl(origin, "/", params)).toBe("http://db.example:8123/?database=a%26b%3Dc%23d&note=x+y");
  });

  test("keeps an already encoded path segment as it is", () => {
    expect(endpointUrl(origin, "/logs%2F2026/_mapping")).toBe("http://db.example:8123/logs%2F2026/_mapping");
  });

  test("leaves the host alone when a path starts with two slashes", () => {
    expect(new URL(endpointUrl(origin, "//evil.example/x")).hostname).toBe("db.example");
  });

  const rewritten: [label: string, path: string][] = [
    ["a relative path", "v1/statement"],
    ["a dot-dot segment", "/v1/../admin"],
    ["an encoded dot-dot segment", "/v1/%2e%2e/admin"],
    ["a backslash", "/v1\\admin"],
    ["a question mark", "/v1?admin=1"],
    ["a hash", "/v1#admin"],
    ["a space", "/v1 admin"],
  ];

  test.each(rewritten)("refuses %s, which the URL would rewrite", (_label, path) => {
    const error = refusal(() => endpointUrl(origin, path));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toMatch(/\bpath\b/);
    expect(error.message).not.toContain("admin");
  });

  // The origin is validated when it is made, and these prove the URL is checked
  // again after it is built, so an origin assembled any other way cannot slip past.
  const forged: [label: string, origin: HttpOrigin, field: string][] = [
    ["a host with an at sign", { scheme: "http", host: "user@evil.example", port: 8123 }, "host"],
    ["a host with a slash", { scheme: "http", host: "db.example/x", port: 8123 }, "host"],
    ["a host the URL parser rejects", { scheme: "http", host: "[::1", port: 8123 }, "host"],
    ["a shorthand IPv4 host", { scheme: "http", host: "127.1", port: 8123 }, "host"],
    ["an out-of-range port", { scheme: "http", host: "db.example", port: 70000 }, "port"],
  ];

  test.each(forged)("refuses a forged origin with %s", (_label, forgedOrigin, field) => {
    const error = refusal(() => endpointUrl(forgedOrigin, "/"));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toMatch(new RegExp(`\\b${field}\\b`));
    expect(error.message).not.toContain("evil");
  });
});

describe("rejectRedirect", () => {
  const requestUrl = "http://db.example:8123/v1/statement";

  function response(status: number, headers: Record<string, string> = {}): Response {
    return new Response(null, { status, headers });
  }

  test.each([200, 204, 299, 400, 401, 404, 500])("lets HTTP %i through", (status) => {
    expect(() => rejectRedirect(response(status), requestUrl)).not.toThrow();
  });

  test.each([300, 301, 302, 303, 304, 307, 308, 399])("refuses HTTP %i with ConnectionError", (status) => {
    const error = refusal(() => rejectRedirect(response(status, { location: "https://other.example/" }), requestUrl));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  test("names only the origin of the Location header", () => {
    const location = "https://user:pw@other.example:8443/login?token=SECRET#frag";
    const error = refusal(() => rejectRedirect(response(302, { location }), requestUrl));
    expect(error.message).toContain("https://other.example:8443");
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("user");
    expect(error.message).not.toContain("pw");
    expect(error.message).not.toContain("/login");
    expect(error.message).not.toContain("frag");
  });

  test("resolves a relative Location against the request", () => {
    const error = refusal(() => rejectRedirect(response(307, { location: "/login?next=SECRET" }), requestUrl));
    expect(error.message).toContain("http://db.example:8123");
    expect(error.message).not.toContain("SECRET");
  });

  test("says so when the Location header is missing", () => {
    const error = refusal(() => rejectRedirect(response(302), requestUrl));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("HTTP 302");
    expect(error.message).toMatch(/no Location header/);
  });

  test.each([
    ["a non-http scheme", "javascript:alert('SECRET')"],
    ["a file URL", "file:///etc/SECRET"],
    ["an unparsable URL", "http://[SECRET"],
  ])("does not repeat a Location with %s", (_label, location) => {
    const error = refusal(() => rejectRedirect(response(301, { location }), requestUrl));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("HTTP 301");
    expect(error.message).toContain("not an http or https URL");
    expect(error.message).not.toContain("SECRET");
  });
});

describe("validateHost and validatePort are exported for non-HTTP transports", () => {
  test("a hostname, an IPv4 and an IPv6 literal pass; IPv6 comes back bracketed", () => {
    expect(validateHost("Broker-1.Example.com")).toBe("broker-1.example.com");
    expect(validateHost("10.0.0.7")).toBe("10.0.0.7");
    expect(validateHost("::1")).toBe("[::1]");
  });

  test.each(["a:1", "a/b", "u@a", "a b", "a%25b"])(
    "URL syntax in the host %p is refused without echoing it",
    (host) => {
      const error = refusal(() => validateHost(host));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).not.toContain(host);
    },
  );

  test("a port from 1 to 65535 passes, as a number or a string of digits", () => {
    expect(validatePort(9092)).toBe(9092);
    expect(validatePort("9092")).toBe(9092);
  });

  test.each([0, 65536, "90a", -1, 1.5])("the port %p is refused", (port) => {
    expect(refusal(() => validatePort(port))).toBeInstanceOf(DatabaseConfigError);
  });
});
