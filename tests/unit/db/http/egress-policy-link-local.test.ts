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
