import { describe, test, expect } from "bun:test";
import { parseHostUri, tlsModeAfterScheme, type HostUriResult, type HostUriScheme } from "@/lib/connection-host-uri";
import { validateHost, validatePort } from "@/lib/db/http/endpoint";
import type { SSLMode } from "@/lib/types";

const BOTH: readonly HostUriScheme[] = ["http", "https"];

const SENTENCES = {
  userinfo:
    "Host takes no user name or password inside the address: remove the part before @ and enter the credentials in their own fields.",
  path: "Host takes a scheme, a host and a port only: remove the path after the host.",
  query: "Host takes a scheme, a host and a port only: remove the query string, from ? onwards.",
  fragment: "Host takes a scheme, a host and a port only: remove the fragment, from # onwards.",
  host: "The address names no valid host: expected a host name, an IPv4 address or an IPv6 address in brackets.",
  port: "The address names no valid port: expected an integer from 1 to 65535.",
} as const;

/**
 * Addresses as the engines' own documentation writes them, and the shapes around them that a user pastes.
 * The port column is the point: an explicit 443 or 80 is kept, and an address with no port means its
 * scheme's port, never an engine default, because a cloud endpoint serves on 443.
 */
const ACCEPTED: [string, HostUriScheme, string, number][] = [
  ["http://localhost:19530", "http", "localhost", 19530],
  ["http://127.0.0.1:19530/", "http", "127.0.0.1", 19530],
  ["https://in01-abc.api.gcp-us-west1.zillizcloud.com:443", "https", "in01-abc.api.gcp-us-west1.zillizcloud.com", 443],
  ["https://in01-abc.api.gcp-us-west1.zillizcloud.com", "https", "in01-abc.api.gcp-us-west1.zillizcloud.com", 443],
  ["http://localhost:6333", "http", "localhost", 6333],
  ["http://localhost:6333/", "http", "localhost", 6333],
  [
    "https://xyz-example.eu-central.aws.cloud.qdrant.io:6333",
    "https",
    "xyz-example.eu-central.aws.cloud.qdrant.io",
    6333,
  ],
  ["https://xyz-example.cloud.qdrant.io", "https", "xyz-example.cloud.qdrant.io", 443],
  // An InfluxDB Cloud endpoint as its documentation writes it, which both InfluxDB types take in the Host box (R7).
  ["https://us-east-1-1.aws.cloud2.influxdata.com:443", "https", "us-east-1-1.aws.cloud2.influxdata.com", 443],
  ["https://us-east-1-1.aws.cloud2.influxdata.com", "https", "us-east-1-1.aws.cloud2.influxdata.com", 443],
  ["https://h:443", "https", "h", 443],
  ["http://h:80", "http", "h", 80],
  ["http://h", "http", "h", 80],
  ["HTTP://LOCALHOST:6333", "http", "localhost", 6333],
  ["  http://localhost:6333  ", "http", "localhost", 6333],
  ["http://milvus_standalone:19530", "http", "milvus_standalone", 19530],
  ["http://xn--bcher-kva.example:8080", "http", "xn--bcher-kva.example", 8080],
  ["http://[::1]:6333", "http", "[::1]", 6333],
  ["https://[2001:DB8::1]", "https", "[2001:db8::1]", 443],
  ["http://[::ffff:127.0.0.1]:6333", "http", "[::ffff:127.0.0.1]", 6333],
  ["http://h:08080", "http", "h", 8080],
];

const REFUSED: [string, keyof typeof SENTENCES][] = [
  ["http://root:password-second@localhost:19530", "userinfo"],
  ["http://@localhost:19530", "userinfo"],
  ["http://localhost:6333/collections", "path"],
  ["http://localhost:6333//", "path"],
  ["http://localhost:6333?api-key=x", "query"],
  ["http://localhost:6333/?x=1", "query"],
  ["http://localhost:6333?", "query"],
  ["http://localhost:6333#top", "fragment"],
  ["http://localhost:6333/#top", "fragment"],
  ["http://:6333", "host"],
  ["http://fe80::1", "host"],
  ["http://[fe80::1%25eth0]:6333", "host"],
  ["http://[::1", "host"],
  ["http://[::1]x", "host"],
  ["http://[1::2::3]:1", "host"],
  ["http://h.example.:6333", "host"],
  ["http://127.1:6333", "host"],
  ["http://0x7f:6333", "host"],
  ["http://1.2.3.4.5:6333", "host"],
  ["http://bücher.example:6333", "host"],
  ["http://１２７.0.0.1:6333", "host"],
  ["http://a..b:6333", "host"],
  ["http://-a.example:6333", "host"],
  ["http://local host:6333", "host"],
  ["http://h:0", "port"],
  ["http://h:65536", "port"],
  ["http://h:", "port"],
  ["http://h:12a", "port"],
  ["http://h:123456", "port"],
];

describe("parseHostUri", () => {
  test.each(ACCEPTED)("%s is an address", (text, scheme, host, port) => {
    expect(parseHostUri(text, BOTH)).toEqual({ kind: "uri", scheme, host, port });
  });

  test.each(REFUSED)("%s is refused for its %s", (text, reason) => {
    expect(parseHostUri(text, BOTH)).toEqual({ kind: "refused", reason, sentence: SENTENCES[reason] });
  });

  test.each(["", "localhost", "localhost:6333", "10.0.0.5", "db.internal"])(
    "%p has no scheme, so it is a host",
    (text) => {
      expect(parseHostUri(text, BOTH)).toEqual({ kind: "host" });
    },
  );

  test("a scheme the engine does not declare is refused, naming the ones it does", () => {
    expect(parseHostUri("ftp://h", BOTH)).toEqual({
      kind: "refused",
      reason: "scheme",
      sentence: "Host takes http:// or https:// addresses for this connection type, or a host name alone.",
    });
    expect(parseHostUri("https://h", ["http"])).toEqual({
      kind: "refused",
      reason: "scheme",
      sentence: "Host takes http:// addresses for this connection type, or a host name alone.",
    });
    expect(parseHostUri("http://h", [])).toEqual({
      kind: "refused",
      reason: "scheme",
      sentence: "Host takes a host name or an address alone for this connection type, without a scheme.",
    });
  });

  test("a refusal never repeats the address it refuses", () => {
    const refused = parseHostUri("http://root:s3cret-value@h:1/p?k=v#f", BOTH);
    expect(refused.kind).toBe("refused");
    expect(JSON.stringify(refused)).not.toContain("s3cret-value");
  });
});

/**
 * The parser runs in the browser and may not import endpoint.ts, which imports node:net, so it holds a copy of
 * its host and port rules. These two tests keep the copy from drifting: everything the parser returns passes
 * the Node-side validators unchanged, and everything `validateHost` refuses the parser refuses too.
 */
describe("parseHostUri against validateHost and validatePort", () => {
  test.each(ACCEPTED)("%s returns a host and port the provider accepts unchanged", (text) => {
    const result = parseHostUri(text, BOTH) as Extract<HostUriResult, { kind: "uri" }>;
    expect(validateHost(result.host)).toBe(result.host);
    expect(validatePort(result.port)).toBe(result.port);
  });

  const REFUSED_BY_VALIDATE_HOST = [
    "[fe80::1%eth0]",
    "127.1",
    "0x7f",
    "a.0x10",
    "1.2.3.4.5",
    "bücher.example",
    "１２７.0.0.1",
    "-a.example",
    "a..b",
    `${"a".repeat(64)}.example`,
    `${"a.".repeat(127)}a`,
    "under score.example",
  ];

  test.each(REFUSED_BY_VALIDATE_HOST)("%s is refused by validateHost and by the parser", (host) => {
    expect(() => validateHost(host)).toThrow();
    expect(parseHostUri(`http://${host}:1`, BOTH)).toMatchObject({ kind: "refused", reason: "host" });
  });

  test("a trailing dot, which validateHost accepts, is refused by the parser on purpose", () => {
    expect(validateHost("h.example.")).toBe("h.example.");
    expect(parseHostUri("http://h.example.:1", BOTH)).toMatchObject({ kind: "refused", reason: "host" });
  });
});

describe("tlsModeAfterScheme", () => {
  const CASES: [HostUriScheme, SSLMode | undefined, SSLMode | undefined][] = [
    ["https", undefined, "verify-system"],
    ["https", "disable", "verify-system"],
    ["https", "require", "require"],
    ["https", "verify-system", "verify-system"],
    ["https", "verify-ca", "verify-ca"],
    ["https", "verify-full", "verify-full"],
    ["http", undefined, undefined],
    ["http", "disable", "disable"],
    ["http", "require", "require"],
    ["http", "verify-full", "verify-full"],
  ];
  test.each(CASES)("%s over %p gives %p, never a lower mode", (scheme, current, expected) => {
    expect(tlsModeAfterScheme(scheme, current)).toBe(expected);
  });
});
