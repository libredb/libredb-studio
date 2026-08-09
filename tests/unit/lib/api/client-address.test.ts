import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clientAddress } from "@/lib/api/client-address";
import { logger } from "@/lib/logger";
import { resetSecurityConfigWarnings } from "@/lib/security/config";

const MUTATED = ["TRUST_PROXY_HEADERS", "TRUSTED_PROXY_HOPS"] as const;
const snapshot: Record<string, string | undefined> = {};

function request(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUSTED_PROXY_HOPS;
  // readTrustProxyHeaders() latches its unrecognized-value warning in module state shared with
  // every other file in this process (tests/unit/lib/security/config.test.ts included).
  resetSecurityConfigWarnings();
});

afterEach(() => {
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSecurityConfigWarnings();
});

describe("clientAddress", () => {
  test("takes the leftmost forwarded entry by default", () => {
    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.9");
  });

  // One trusted proxy (e.g. a single nginx using proxy_add_x_forwarded_for): it appends exactly
  // one entry, so the real client is the LAST entry, not the second-to-last - a forged leading
  // entry is fully attacker-suppliable and must never be selected.
  test("one proxy hop: takes the rightmost entry, not a forged leading one", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";

    expect(clientAddress(request({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  // Two trusted proxies each append one entry as the request passes through, so the real client
  // sits two entries in from the right; everything left of that - including a forged prefix - is
  // untrusted.
  test("two proxy hops: takes the entry two positions from the right, not a forged leading one", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";

    expect(clientAddress(request({ "x-forwarded-for": "9.9.9.9, 203.0.113.9, 198.51.100.7" }))).toBe("203.0.113.9");
  });

  test("falls back to the rightmost entry, not the leftmost, when the hop count exceeds the chain", () => {
    process.env.TRUSTED_PROXY_HOPS = "9";

    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("10.0.0.1");
  });

  test("falls back to x-real-ip when there is no forwarded chain", () => {
    expect(clientAddress(request({ "x-real-ip": " 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  test("falls back to x-real-ip when the forwarded chain has no usable entry", () => {
    expect(clientAddress(request({ "x-forwarded-for": " , ", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  test("returns the placeholder when the request carries no address signal at all", () => {
    expect(clientAddress(request({}))).toBe("unknown");
  });

  test("returns the placeholder when the operator says the headers are untrustworthy", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("unknown");
  });

  test("truncates so a 4 KB forged header cannot become a 4 KB bucket key", () => {
    expect(clientAddress(request({ "x-forwarded-for": "z".repeat(4096) })).length).toBe(64);
  });

  // Same class of typo AUTH_COOKIE_SECURE and CSP_REPORT_ONLY already warn on: an unrecognized
  // TRUST_PROXY_HEADERS value must not silently flip which failure mode this deployment picked.
  test("keeps trusting headers, and warns once, when the value is unrecognized rather than off", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    // `bun run test` shares this process (and therefore logger.warn) with every other file. A
    // debounced localStorage write elsewhere in the suite can flush into this spy's history the
    // instant it is installed, so the baseline is cleared before exercising the code under test
    // rather than assumed to start empty.
    warn.mockClear();
    try {
      process.env.TRUST_PROXY_HEADERS = "maybe";

      expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
      clientAddress(request({ "x-forwarded-for": "203.0.113.9" }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("TRUST_PROXY_HEADERS");
      expect(warn.mock.calls[0][0]).toContain("maybe");
    } finally {
      warn.mockRestore();
    }
  });
});
