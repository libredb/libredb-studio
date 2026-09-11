import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { claimTotpStep, clearTotpReplayState, decodeBase32, TOTP_PERIOD_SECONDS, verifyTotp } from "@/lib/totp";
import { RFC6238_SECRET as RFC_SECRET, RFC6238_SEED_ASCII } from "../../helpers/rfc6238";

/** `T` values from RFC 6238 Appendix B, each paired with the low six digits of its vector. */
const RFC_VECTORS = [
  { seconds: 59, code: "287082" },
  { seconds: 1111111109, code: "081804" },
  { seconds: 1111111111, code: "050471" },
  { seconds: 1234567890, code: "005924" },
  { seconds: 2000000000, code: "279037" },
];

describe("decodeBase32", () => {
  test("decodes the RFC 6238 seed back to its ASCII bytes", () => {
    expect(decodeBase32(RFC_SECRET)?.toString("utf8")).toBe(RFC6238_SEED_ASCII);
  });

  test("accepts the spacing, casing and padding operators actually paste", () => {
    const spaced = decodeBase32("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq=====");
    expect(spaced?.toString("utf8")).toBe(RFC6238_SEED_ASCII);
  });

  test("rejects a secret containing a character outside the base32 alphabet", () => {
    expect(decodeBase32("GEZDGNBV1")).toBeNull();
  });

  test("rejects a secret that is only separators and padding", () => {
    expect(decodeBase32("  -- ==")).toBeNull();
  });

  test("rejects a secret too short to yield a whole byte", () => {
    expect(decodeBase32("A")).toBeNull();
  });
});

describe("verifyTotp", () => {
  for (const { seconds, code } of RFC_VECTORS) {
    test(`accepts the RFC 6238 vector at T=${seconds}`, () => {
      expect(verifyTotp(RFC_SECRET, code, seconds * 1000)).toBe(Math.floor(seconds / TOTP_PERIOD_SECONDS));
    });
  }

  test("accepts the previous step, so a slow typist is not punished", () => {
    expect(verifyTotp(RFC_SECRET, "287082", (59 + TOTP_PERIOD_SECONDS) * 1000)).toBe(1);
  });

  test("accepts the next step, so a client clock running fast still works", () => {
    expect(verifyTotp(RFC_SECRET, "287082", (59 - TOTP_PERIOD_SECONDS) * 1000)).toBe(1);
  });

  test("rejects a code two steps out", () => {
    expect(verifyTotp(RFC_SECRET, "287082", (59 + 2 * TOTP_PERIOD_SECONDS) * 1000)).toBeNull();
  });

  test("tolerates whitespace inside the submitted code", () => {
    expect(verifyTotp(RFC_SECRET, " 287 082 ", 59_000)).toBe(1);
  });

  for (const code of ["12345", "1234567", "abcdef", "", "12345a"]) {
    test(`rejects the malformed code "${code}"`, () => {
      expect(verifyTotp(RFC_SECRET, code, 59_000)).toBeNull();
    });
  }

  test("rejects every code when the configured secret is not valid base32", () => {
    expect(verifyTotp("not base32!", "287082", 59_000)).toBeNull();
  });

  test("reads the wall clock when no timestamp is supplied", () => {
    // Stubbed rather than asserted against the real clock: a test that submitted a fixed code at
    // the true current time would pass or fail by luck.
    const nowSpy = spyOn(Date, "now").mockReturnValue(59_000);
    try {
      expect(verifyTotp(RFC_SECRET, "287082")).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("claimTotpStep", () => {
  afterEach(() => {
    clearTotpReplayState();
  });

  test("accepts a step once and refuses the same step again", () => {
    expect(claimTotpStep("account-a", 1, 59_000)).toBe(true);
    expect(claimTotpStep("account-a", 1, 59_000)).toBe(false);
  });

  test("scopes spent steps per account", () => {
    expect(claimTotpStep("account-a", 1, 59_000)).toBe(true);
    expect(claimTotpStep("account-b", 1, 59_000)).toBe(true);
  });

  test("lets the same account spend the next step", () => {
    expect(claimTotpStep("account-a", 1, 59_000)).toBe(true);
    expect(claimTotpStep("account-a", 2, 89_000)).toBe(true);
  });

  test("forgets a step once its acceptance window has passed", () => {
    expect(claimTotpStep("account-a", 1, 59_000)).toBe(true);
    // Far enough ahead that verifyTotp could no longer accept step 1 at all, so remembering it
    // buys nothing and the entry is reclaimed.
    expect(claimTotpStep("account-a", 1, 59_000 + 10 * TOTP_PERIOD_SECONDS * 1000)).toBe(true);
  });

  test("bounds its own memory rather than growing with attacker-supplied keys", () => {
    const start = 59_000;
    for (let index = 0; index < 5000; index++) claimTotpStep(`account-${index}`, 1, start);
    // The earliest entries were evicted, so the very first key is claimable again: the cap held
    // and it failed open, exactly as documented.
    expect(claimTotpStep("account-0", 1, start)).toBe(true);
  });

  test("reads the wall clock when no timestamp is supplied", () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(59_000);
    try {
      expect(claimTotpStep("account-a", 1)).toBe(true);
      expect(claimTotpStep("account-a", 1)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
