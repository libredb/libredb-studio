/**
 * The strict encoders a byte request target is built with, the Host value the byte transport sends, and the exported
 * loopback predicate (byte transport design 3.2 and 3.4).
 *
 * Every output of the encoders is in the request-target grammar the byte transport checks, which is also SigV4's
 * UriEncode alphabet with upper-case hex, so a path built here is a canonical URI as it stands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  endpointUrl,
  type HttpOrigin,
  httpOrigin,
  isLoopbackHost,
  originHost,
  rfc3986Encode,
  rfc3986Path,
  rfc3986Query,
} from "@/lib/db/http/endpoint";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { closeAll, httpListener, jsonAnswer } from "../../../helpers/node-transport-fixtures";

const LONE_SURROGATE = "Invalid text: expected well-formed Unicode, so it cannot be percent-encoded";
/** The byte transport's target grammar (byte transport design 3.4), written out again so the test owns it. */
const PATH_GRAMMAR = /^\/(?!\/)(?:[A-Za-z0-9._~/-]|%[0-9A-F]{2})*$/;
const QUERY_CHARACTER = "(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})";
const QUERY_GRAMMAR = new RegExp(
  `^(?:${QUERY_CHARACTER}+=${QUERY_CHARACTER}*(?:&${QUERY_CHARACTER}+=${QUERY_CHARACTER}*)*)?$`,
);

afterEach(async () => {
  await closeAll();
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("rfc3986Encode", () => {
  test.each([
    ["unreserved characters", "AZaz09-._~", "AZaz09-._~"],
    ["a space", " ", "%20"],
    ["a plus", "+", "%2B"],
    ["an asterisk", "*", "%2A"],
    ["a tilde", "~", "~"],
    ["the four marks encodeURIComponent keeps", "!'()", "%21%27%28%29"],
    ["a two-byte character", "é", "%C3%A9"],
    ["a slash", "/", "%2F"],
    ["a percent sign", "%", "%25"],
    ["the measured mix", "a b+c*~!'()é/%", "a%20b%2Bc%2A~%21%27%28%29%C3%A9%2F%25"],
  ])("%s", (_label, text, encoded) => {
    expect(rfc3986Encode(text)).toBe(encoded);
  });

  test("a lone surrogate is refused with the sentence", () => {
    const error = refusal(() => rfc3986Encode("key\uD800"));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(LONE_SURROGATE);
  });
});

describe("rfc3986Path", () => {
  test.each([
    ["dot segments kept as given", ["b", "sp", ".", "dot.txt"], "/b/sp/./dot.txt"],
    ["an empty segment kept", ["b", "", "k"], "/b//k"],
    ["a slash inside one segment escaped", ["b", "a/b"], "/b/a%2Fb"],
    ["a double-dot segment kept", ["b", "x", "..", "dotdot.txt"], "/b/x/../dotdot.txt"],
  ])("%s", (_label, segments, path) => {
    expect(rfc3986Path(segments)).toBe(path);
  });
});

describe("rfc3986Query", () => {
  test("keeps the given order and escapes both sides", () => {
    expect(
      rfc3986Query([
        ["prefix", "a b"],
        ["delimiter", "/"],
      ]),
    ).toBe("prefix=a%20b&delimiter=%2F");
  });

  test("an empty value gives name=", () => {
    expect(rfc3986Query([["location", ""]])).toBe("location=");
  });

  test("no pairs give the empty string", () => {
    expect(rfc3986Query([])).toBe("");
  });
});

describe("every encoder output is in the byte transport's target grammar", () => {
  test.each([
    rfc3986Path(["b", "sp", ".", "dot.txt"]),
    rfc3986Path(["b", "", "k"]),
    rfc3986Path(["b", "a/b"]),
    rfc3986Path(["b", "a b+c*~!'()é/%"]),
  ])("path %s", (path) => {
    expect(path).toMatch(PATH_GRAMMAR);
  });

  test.each([
    rfc3986Query([
      ["prefix", "a b"],
      ["delimiter", "/"],
    ]),
    rfc3986Query([["location", ""]]),
    rfc3986Query([]),
    rfc3986Query([["prefix", "a b+c*~!'()é/%"]]),
  ])("query %s", (query) => {
    expect(query).toMatch(QUERY_GRAMMAR);
  });
});

describe("originHost", () => {
  const origin = (scheme: "http" | "https", host: string, port: number): HttpOrigin => ({ scheme, host, port });

  test.each([
    ["http on its default port", origin("http", "h", 80), "h"],
    ["http on 443", origin("http", "h", 443), "h:443"],
    ["https on its default port", origin("https", "h", 443), "h"],
    ["https on 9443", origin("https", "h", 9443), "h:9443"],
    ["an IPv6 literal on the default port", origin("http", "[::1]", 80), "[::1]"],
    ["an IPv4 literal on 9000", origin("http", "127.0.0.1", 9000), "127.0.0.1:9000"],
  ])("%s", (_label, given, host) => {
    expect(originHost(given)).toBe(host);
  });

  test.each([
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "::1"],
  ])("equals the Host the runtime writes for %s", async (host, bind) => {
    const listener = await httpListener(jsonAnswer(200, "{}"), bind);
    const origin = httpOrigin("http", host, listener.port);
    const transport = createNodeTransport({ origin, tls: null, maxSockets: 1, headers: {} });
    try {
      await transport.request({
        method: "GET",
        url: endpointUrl(origin, "/"),
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: 1024,
      });
    } finally {
      transport.close();
    }
    expect(listener.seen[0].headers.host).toBe(originHost(origin));
  });
});

describe("isLoopbackHost", () => {
  test.each([
    ["127.0.0.1", true],
    ["[::1]", true],
    ["[::ffff:127.0.0.1]", true],
    ["localhost", true],
    ["LOCALHOST", true],
    ["10.0.0.5", false],
  ])("%s is %p", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });
});
