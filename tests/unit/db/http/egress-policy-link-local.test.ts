/**
 * The link-local and instance-metadata refusal a byte transport applies whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says
 * (byte transport design 3.9).
 *
 * node:dns is mocked, as tests/unit/db/http/egress-policy-transport.test.ts mocks it, so every answer is chosen here
 * and no resolver is asked. The runner starts a process per file, so the mock reaches no other test file. Literals are
 * passed to the checks directly, never through validateHost, so a later change cannot start hand-parsing addresses.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";

const realDns = { ...(await import("node:dns")) };
const lookups: string[] = [];
/** The options each resolver call received, so a test can see the lookup always asks for every address. */
const lookupOptions: { all?: boolean }[] = [];
/** The mock's answers, by the exact name asked; any other name is a resolver error. */
const ANSWERS = new Map<string, readonly LookupAddress[]>([
  ["metadata.test", [{ address: "169.254.169.254", family: 4 }]],
  [
    "mixed.test",
    [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
  ],
  ["private.test", [{ address: "10.0.0.5", family: 4 }]],
  ["local.test", [{ address: "127.0.0.1", family: 4 }]],
  ["empty.test", []],
  ["mismatch.test", [{ address: "10.0.0.5", family: 6 }]],
  ["zoned.test", [{ address: "fe80::1%eth0", family: 6 }]],
]);

mock.module("node:dns", () => ({
  ...realDns,
  lookup(
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, addresses: LookupAddress[]) => void,
  ) {
    lookups.push(hostname);
    lookupOptions.push({ ...options });
    const answer = ANSWERS.get(hostname);
    if (answer === undefined) callback(new Error("DNS failure"), []);
    else callback(null, [...answer]);
  },
}));

const { DatabaseConfigError } = await import("@/lib/db/errors");
const { assertNoLinkLocalDnsAnswer, assertNotLinkLocalLiteral, LINK_LOCAL_NETWORKS, linkLocalRefusingLookup } =
  await import("@/lib/db/http/egress-policy");

const LINK_LOCAL =
  "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says";
const UNUSABLE = "Invalid host: the name did not resolve to a usable IP address";
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];

afterEach(() => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  lookups.length = 0;
  lookupOptions.length = 0;
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

interface Looked {
  readonly error: Error | null;
  readonly address: string | LookupAddress[];
  readonly family: number | undefined;
}

function look(hostname: string, all: boolean): Promise<Looked> {
  return new Promise((resolve) => {
    linkLocalRefusingLookup(hostname, { all }, (error, address, family) => resolve({ error, address, family }));
  });
}

describe("LINK_LOCAL_NETWORKS", () => {
  test("lists IPv4 link-local, IPv6 link-local, AWS's IPv6 metadata address and the NAT64 form, in that order", () => {
    expect(LINK_LOCAL_NETWORKS).toEqual([
      ["169.254.0.0", 16, "ipv4"],
      ["fe80::", 10, "ipv6"],
      ["fd00:ec2::254", 128, "ipv6"],
      ["64:ff9b::a9fe:0", 112, "ipv6"],
    ]);
  });
});

describe("assertNotLinkLocalLiteral", () => {
  test.each([
    "169.254.169.254",
    "169.254.0.1",
    "[fe80::1]",
    "[fd00:ec2::254]",
    "[::ffff:169.254.169.254]",
    "[64:ff9b::a9fe:a9fe]",
    "[64:ff9b::169.254.169.254]",
    "[fd00:ec2:0::254]",
    "[0:0:0:0:0:ffff:a9fe:a9fe]",
    "[FE80::1]",
    // A zone index scopes an address to one interface: Bun's BlockList does not match fe80::1%eth0 where Node's does,
    // so every zoned IPv6 literal is refused, whatever its address.
    "[fe80::1%eth0]",
    "[fe80::1%25eth0]",
    "[::1%lo]",
  ])("refuses %s with the sentence and never echoes it", (host) => {
    const error = refusal(() => assertNotLinkLocalLiteral(host));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(LINK_LOCAL);
    expect(error.message).not.toContain(host.replace(/^\[|\]$/g, ""));
  });

  test.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.10",
    "100.64.0.1",
    "[::1]",
    "[fd00::1]",
    "[fd00:ec2::253]",
    "169.253.255.255",
    "8.8.8.8",
    "minio.local",
  ])("passes %s", (host) => {
    expect(() => assertNotLinkLocalLiteral(host)).not.toThrow();
  });

  test("refuses whatever the guard flag says", () => {
    process.env[FLAG] = "false";
    expect(refusal(() => assertNotLinkLocalLiteral("169.254.169.254")).message).toBe(LINK_LOCAL);
  });
});

describe("assertNoLinkLocalDnsAnswer", () => {
  test.each([
    ["the metadata address", [{ address: "169.254.169.254", family: 4 }]],
    [
      "a mixed answer",
      [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ],
    ["an IPv6 link-local address", [{ address: "fe80::1", family: 6 }]],
    ["AWS's IPv6 metadata address", [{ address: "fd00:ec2::254", family: 6 }]],
    ["a zoned IPv6 link-local address", [{ address: "fe80::1%eth0", family: 6 }]],
    ["a zoned IPv6 loopback address", [{ address: "::1%lo", family: 6 }]],
  ] as const)("refuses %s with the link-local sentence", (_label, addresses) => {
    const error = refusal(() => assertNoLinkLocalDnsAnswer(addresses));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(LINK_LOCAL);
  });

  test.each([
    ["an empty answer", []],
    ["an IPv4 address marked family 6", [{ address: "10.0.0.5", family: 6 }]],
    ["an IPv6 address marked family 4", [{ address: "::1", family: 4 }]],
    ["an unknown family", [{ address: "10.0.0.5", family: 5 }]],
  ] as const)("refuses %s with the usable-address sentence", (_label, addresses) => {
    const error = refusal(() => assertNoLinkLocalDnsAnswer(addresses));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(UNUSABLE);
  });

  test("passes private and loopback answers", () => {
    expect(() =>
      assertNoLinkLocalDnsAnswer([
        { address: "10.0.0.5", family: 4 },
        { address: "127.0.0.1", family: 4 },
        { address: "fd00::1", family: 6 },
      ]),
    ).not.toThrow();
  });
});

describe("linkLocalRefusingLookup", () => {
  test("answers a usable name in the shape that asks for every address", async () => {
    const answer = await look("private.test", true);
    expect(answer.error).toBeNull();
    expect(answer.address).toEqual([{ address: "10.0.0.5", family: 4 }]);
  });

  test("answers a usable name in the shape that asks for one address", async () => {
    const answer = await look("private.test", false);
    expect(answer.error).toBeNull();
    expect({ address: answer.address, family: answer.family }).toEqual({ address: "10.0.0.5", family: 4 });
  });

  test("refuses a name that resolves to 169.254.169.254", async () => {
    const answer = await look("metadata.test", false);
    expect(answer.error).toBeInstanceOf(DatabaseConfigError);
    expect(answer.error?.message).toBe(LINK_LOCAL);
  });

  test("refuses a name that resolves to a zoned link-local address", async () => {
    expect((await look("zoned.test", true)).error?.message).toBe(LINK_LOCAL);
  });

  test("refuses a mixed answer", async () => {
    expect((await look("mixed.test", true)).error?.message).toBe(LINK_LOCAL);
  });

  test("passes a resolver error through unchanged", async () => {
    expect((await look("missing.test", true)).error?.message).toBe("DNS failure");
  });

  test("refuses an empty answer and a family mismatch with the usable-address sentence", async () => {
    expect((await look("empty.test", true)).error?.message).toBe(UNUSABLE);
    expect((await look("mismatch.test", true)).error?.message).toBe(UNUSABLE);
  });

  test("asks the resolver once per call, always for every address", async () => {
    await look("private.test", false);
    expect(lookups).toEqual(["private.test"]);
    expect(lookupOptions).toHaveLength(1);
    expect(lookupOptions[0].all).toBe(true);
  });
});

const { httpOrigin } = await import("@/lib/db/http/endpoint");
const { createNodeByteTransport } = await import("@/lib/db/http/node-transport");
const { closeAll, rawAnswer, rawHttpListener } = await import("../../../helpers/node-transport-fixtures");

describe("through a byte transport with the guard off", () => {
  const transports: Array<{ close(): void }> = [];
  afterEach(async () => {
    for (const transport of transports.splice(0)) transport.close();
    await closeAll();
  });

  const OK = (): Buffer => rawAnswer("200 OK", ["content-length: 2"], "ok");

  function connect(host: string, port: number) {
    delete process.env[FLAG];
    const transport = createNodeByteTransport({
      origin: httpOrigin("http", host, port),
      tls: null,
      maxSockets: 4,
      headers: {},
    });
    transports.push(transport);
    return () =>
      transport.request({
        method: "GET",
        target: { path: "/b/k", query: "" },
        signal: AbortSignal.timeout(5000),
        maxResponseBytes: 1024,
      });
  }

  test("a name the resolver answers with 169.254.169.254 is refused with the sentence, and nothing is accepted", async () => {
    const listener = await rawHttpListener(OK);
    const request = connect("metadata.test", listener.port);
    let error: Error | undefined;
    try {
      await request();
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(LINK_LOCAL);
    expect(listener.accepted()).toBe(0);
  });

  test("a name the resolver answers with 127.0.0.1 reaches the listener", async () => {
    const listener = await rawHttpListener(OK);
    const answer = await connect("local.test", listener.port)();
    expect(answer.bytes.toString()).toBe("ok");
    expect(listener.accepted()).toBe(1);
  });

  test("five requests open one socket after one lookup", async () => {
    const listener = await rawHttpListener(OK);
    const request = connect("local.test", listener.port);
    for (let index = 0; index < 5; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses the pooled socket.
      expect((await request()).status).toBe(200);
    }
    expect(lookups.filter((name) => name === "local.test")).toEqual(["local.test"]);
    expect(listener.accepted()).toBe(1);
  });
});

const BLOCKED = "Invalid host: this HTTP database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS";

describe("a byte transport refuses every link-local form whatever the guard flag says, and opens no socket", () => {
  const transports: Array<{ close(): void }> = [];
  afterEach(async () => {
    for (const transport of transports.splice(0)) transport.close();
    await closeAll();
  });

  const OK = (): Buffer => rawAnswer("200 OK", ["content-length: 2"], "ok");

  /** The guard flag off or on, then a byte transport on the host and port given, read raw so no validation runs first. */
  function build(host: string, port: number, guard: "off" | "on") {
    if (guard === "on") process.env[FLAG] = "true";
    else delete process.env[FLAG];
    const transport = createNodeByteTransport({
      origin: { scheme: "http", host, port },
      tls: null,
      maxSockets: 4,
      headers: {},
    });
    transports.push(transport);
    return transport;
  }

  async function failureOf(run: () => Promise<unknown>): Promise<Error> {
    try {
      await run();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the request to fail");
  }

  const LITERALS = [
    "169.254.169.254",
    "[fe80::1]",
    "[fd00:ec2::254]",
    "[::ffff:169.254.169.254]",
    "[::ffff:a9fe:a9fe]",
    "[64:ff9b::a9fe:a9fe]",
  ];

  // The guard's sentence when the flag is on, because the guard runs first; the link-local sentence otherwise.
  const CASES = [
    ...LITERALS.map((host) => [host, "off", LINK_LOCAL] as const),
    ...LITERALS.map((host) => [host, "on", BLOCKED] as const),
  ];

  // A refusal when the transport is built leaves no transport to send with, so there is no listener to count here.
  test.each(CASES)("the literal %s with the guard %s is refused when built", (host, guard, sentence) => {
    const error = refusal(() => build(host, 80, guard));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(sentence);
    expect(error.message).not.toContain(host.replace(/^\[|\]$/g, ""));
  });

  test.each([
    ["metadata.test", "off", LINK_LOCAL],
    ["mixed.test", "off", LINK_LOCAL],
    ["metadata.test", "on", BLOCKED],
    ["mixed.test", "on", BLOCKED],
    ["zoned.test", "off", LINK_LOCAL],
    // The guard's own answer check has no zone rule, and Bun's BlockList does not match fe80::1%eth0 against
    // fe80::/10, so on Bun the guard passes this answer and the link-local check, run after it, refuses it.
    ["zoned.test", "on", LINK_LOCAL],
  ] as const)(
    "the name %s with the guard %s is refused at the lookup, and nothing is accepted",
    async (host, guard, sentence) => {
      const listener = await rawHttpListener(OK);
      const transport = build(host, listener.port, guard);
      const error = await failureOf(() =>
        transport.request({
          method: "GET",
          target: { path: "/b/k", query: "" },
          signal: AbortSignal.timeout(5000),
          maxResponseBytes: 1024,
        }),
      );
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(sentence);
      expect(error.message).not.toContain(host);
      expect(error.message).not.toContain("169.254");
      expect(error.message).not.toContain("8.8.8.8");
      expect(lookups).toEqual([host]);
      expect(listener.accepted()).toBe(0);
    },
  );
});
