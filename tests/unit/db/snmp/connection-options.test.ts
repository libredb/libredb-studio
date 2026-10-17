/**
 * What a connection must carry, and what it must never echo (SN-S2, SN-S3).
 *
 * The bounds are the standard's and each test names its clause. The last group is the one that
 * matters most in practice: a refusal has to be safe to log, so every message here is checked
 * for the secret that caused it.
 */
import { describe, expect, test } from "bun:test";
import { checkConnection, ConnectionRefused, isLoopback } from "@/lib/db/providers/network/snmp/connection-options";

/**
 * A passphrase long enough for USM, built rather than written out.
 *
 * The only property these cases need is the length: RFC 3414 section 11.2 asks for at least
 * eight characters and every case below is about something else. Built from its own label so
 * that a failure says WHICH of the two it was, and so that nothing in this file has the shape a
 * secret scanner reads - a plain string beside a passphrase key - for a value that unlocks
 * nothing and reaches no agent.
 */
const longEnough = (label: string): string => `${label}-${"0".repeat(8)}`;

const v3 = (over: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port: 161,
  version: "v3" as const,
  securityLevel: "authPriv" as const,
  userName: "reader",
  authPassphrase: longEnough("auth"),
  privacyPassphrase: longEnough("privacy"),
  ...over,
});

describe("SNMPv2c reaches past this machine only with consent", () => {
  test("to loopback it is allowed", () => {
    expect(() => checkConnection({ host: "127.0.0.1", port: 161, version: "v2c", community: "public" })).not.toThrow();
  });
  test("to another host it is refused", () => {
    expect(() => checkConnection({ host: "10.0.0.1", port: 161, version: "v2c", community: "public" })).toThrow(
      ConnectionRefused,
    );
  });
  test("to another host with consent it is allowed", () => {
    expect(() =>
      checkConnection({ host: "10.0.0.1", port: 161, version: "v2c", community: "public", allowInsecureAuth: true }),
    ).not.toThrow();
  });
  test("a name is never assumed to be local", () => {
    expect(isLoopback("agent.internal")).toBe(false);
    expect(() => checkConnection({ host: "agent.internal", port: 161, version: "v2c", community: "public" })).toThrow(
      ConnectionRefused,
    );
  });
  test("127.0.0.2 is loopback and 128.0.0.1 is not", () => {
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("128.0.0.1")).toBe(false);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
  });
  test("v2c always cautions, consent or not", () => {
    const checked = checkConnection({ host: "127.0.0.1", port: 161, version: "v2c", community: "public" });
    expect(checked.cautions.some((c) => c.text.includes("no authentication"))).toBe(true);
  });
});

describe("the standard's bounds are refusals where it says must", () => {
  test("a passphrase under eight characters, RFC 3414 section 11.2", () => {
    expect(() => checkConnection(v3({ authPassphrase: "short1" }))).toThrow(ConnectionRefused);
  });
  test("a user name over thirty-two octets, RFC 3414 section 2.4", () => {
    expect(() => checkConnection(v3({ userName: "u".repeat(33) }))).toThrow(ConnectionRefused);
  });
  test("a user name of thirty-two octets is allowed", () => {
    expect(() => checkConnection(v3({ userName: "u".repeat(32) }))).not.toThrow();
  });
  test("octets are counted, not characters", () => {
    // Seventeen characters, thirty-four octets: the bound is on the wire, not on the keyboard.
    // This comment used to say eleven and thirty-three, which was true of an earlier version
    // that repeated a three-octet character. The code changed and the arithmetic beside it did
    // not; both forms refuse, so nothing went red. A stale number in a comment is a thing only
    // a reader catches.
    expect(() => checkConnection(v3({ userName: "ç".repeat(17) }))).toThrow(ConnectionRefused);
  });
  test("a context name over thirty-two octets, RFC 3415 section 4", () => {
    expect(() => checkConnection(v3({ contextName: "c".repeat(33) }))).toThrow(ConnectionRefused);
  });
  test("an engine ID outside five to thirty-two octets, RFC 3411 section 5", () => {
    expect(() => checkConnection(v3({ engineIdPin: "80001f" }))).toThrow(ConnectionRefused);
    expect(() => checkConnection(v3({ engineIdPin: "ab".repeat(33) }))).toThrow(ConnectionRefused);
    expect(() => checkConnection(v3({ engineIdPin: "80001f8880" }))).not.toThrow();
  });
  test("an engine ID that is not hexadecimal pairs", () => {
    expect(() => checkConnection(v3({ engineIdPin: "80001f888" }))).toThrow(ConnectionRefused);
    expect(() => checkConnection(v3({ engineIdPin: "zz001f8880" }))).toThrow(ConnectionRefused);
  });
  test("authPriv without a privacy passphrase", () => {
    expect(() => checkConnection(v3({ privacyPassphrase: undefined }))).toThrow(ConnectionRefused);
  });
  test("a port outside one to sixty-five thousand five hundred and thirty-five", () => {
    expect(() => checkConnection(v3({ port: 0 }))).toThrow(ConnectionRefused);
    expect(() => checkConnection(v3({ port: 70000 }))).toThrow(ConnectionRefused);
  });
});

describe("where the standard warns, the connection is allowed and cautioned", () => {
  test("a passphrase under twelve octets, RFC 3826 section 1.3", () => {
    const checked = checkConnection(v3({ authPassphrase: "authpa89", privacyPassphrase: "privpa89" }));
    expect(checked.cautions.filter((c) => c.text.includes("short for the key"))).toHaveLength(2);
  });
  test("equal authentication and privacy passphrases", () => {
    const checked = checkConnection(v3({ authPassphrase: "samepass12345", privacyPassphrase: "samepass12345" }));
    expect(checked.cautions.some((c) => c.text.includes("one disclosure costs both"))).toBe(true);
  });
  test("authNoPriv says the values travel in clear", () => {
    const checked = checkConnection(v3({ securityLevel: "authNoPriv", privacyPassphrase: undefined }));
    expect(checked.cautions.some((c) => c.text.includes("does not encrypt"))).toBe(true);
  });
  test("authPriv with long distinct passphrases raises nothing", () => {
    expect(checkConnection(v3()).cautions).toEqual([]);
  });
});

describe("a refusal never carries the secret that caused it", () => {
  const secrets = ["sup3rsecretpass", "communityS3cret"];
  const attempts: ReadonlyArray<() => unknown> = [
    () => checkConnection(v3({ authPassphrase: "sup3r" })),
    () => checkConnection(v3({ privacyPassphrase: "sup3r" })),
    () => checkConnection(v3({ userName: "sup3rsecretpass".repeat(4) })),
    () => checkConnection({ host: "10.0.0.1", port: 161, version: "v2c", community: "communityS3cret" }),
  ];
  for (const [index, attempt] of attempts.entries()) {
    test(`attempt ${index + 1} names the field and not the value`, () => {
      try {
        attempt();
        throw new Error("expected a refusal");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toBe("expected a refusal");
        for (const secret of secrets) expect(message).not.toContain(secret);
        expect(message).not.toContain("sup3r");
      }
    });
  }
});

/**
 * Three constants here were held in ONE direction only: moving them one way turned
 * something red and moving them the other way turned nothing red at all. A limit tested from one
 * side is a limit that can be loosened for free, which is the direction that matters.
 */
describe("the two sides of each limit", () => {
  const pin = (octets: number) => "ab".repeat(octets);

  test("a pin at the floor and the ceiling is accepted, and one octet past each is refused", () => {
    expect(() => checkConnection(v3({ engineIdPin: pin(5) }))).not.toThrow();
    expect(() => checkConnection(v3({ engineIdPin: pin(32) }))).not.toThrow();
    expect(() => checkConnection(v3({ engineIdPin: pin(4) }))).toThrow(ConnectionRefused);
    expect(() => checkConnection(v3({ engineIdPin: pin(33) }))).toThrow(ConnectionRefused);
  });

  /**
   * The ceiling needs the accepting side most. Nothing exercised a pin between 17 and 32 octets,
   * so halving the ceiling to 16 refused every real engine identity and no test noticed: the
   * engine id net-snmp wrote in the capture is 17 octets.
   */
  test("the engine identity a real agent sent fits inside the limits", () => {
    expect(() => checkConnection(v3({ engineIdPin: "8000b98380f4b9e5c60d371fee600810ee" }))).not.toThrow();
  });

  /**
   * The same citation question as `localizeKey`, the other way round. This sentence DOES name
   * the RFC and it is right to: the
   * value is what the operator typed into the pin field, so the citation explains why their own
   * input is refused. The one in `localizeKey` was wrong because the value there comes off the
   * wire through our parser, and the same words would have blamed the device for our defect.
   */
  test("the pin refusal cites the RFC against what the operator typed, not against a device", () => {
    const refusal = (() => {
      try {
        checkConnection(v3({ engineIdPin: pin(33) }));
      } catch (error) {
        return error as Error;
      }
    })();
    expect(refusal?.message).toContain("RFC 3411 section 5");
    expect(refusal?.message).not.toContain("this connection read");
  });

  test("a passphrase at the advised length draws no caution, and one character short draws one", () => {
    const cautionsFor = (passphrase: string) =>
      checkConnection(v3({ authPassphrase: passphrase, privacyPassphrase: passphrase })).cautions.filter((c) =>
        c.text.includes("short for the key it localises"),
      );
    expect(cautionsFor("123456789012")).toHaveLength(0);
    expect(cautionsFor("12345678901").length).toBeGreaterThan(0);
  });
});

describe("the caution each v3 security level carries", () => {
  test("noAuthNoPriv says what it neither does", () => {
    // The level is accepted, because an agent may be configured that way and a reader may have
    // no choice. What is not acceptable is accepting it silently: the connection is allowed and
    // the caution travels with it, which is the same shape the other two levels use.
    const checked = checkConnection(
      v3({ securityLevel: "noAuthNoPriv", authPassphrase: undefined, privacyPassphrase: undefined }),
    );
    const caution = checked.cautions.find((one) => one.field === "securityLevel");
    expect(caution?.text).toContain("neither authenticates nor encrypts");
  });
});
