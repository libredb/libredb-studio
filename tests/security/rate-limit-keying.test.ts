import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clientAddress } from "@/lib/api/client-address";
import { clearRateLimitState, consumeRateLimit, MAX_ENTRIES_PER_BUCKET } from "@/lib/api/rate-limit";

/**
 * Threat: an attacker who evades the limiter, or weaponises it against a legitimate user.
 *
 * X-Forwarded-For is attacker-controlled and the design does not depend on it being trustworthy.
 * NextRequest exposes no socket address, so ignoring forwarded headers would collapse every
 * anonymous caller into one shared bucket and turn the login limiter into a remote lockout switch
 * - strictly worse than a spoofable key. The compensating control is the account bucket, which is
 * keyed on the submitted account and is unaffected by header spoofing.
 */

const MUTATED = ["RATE_LIMIT_LOGIN_MAX", "RATE_LIMIT_LOGIN_ACCOUNT_MAX", "TRUSTED_PROXY_HOPS"] as const;
const snapshot: Record<string, string | undefined> = {};

function request(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  delete process.env.TRUSTED_PROXY_HOPS;
  clearRateLimitState();
});

afterEach(() => {
  clearRateLimitState();
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("an attacker rotating X-Forwarded-For", () => {
  test("earns a fresh client bucket every time, which is why it is not the only bucket", () => {
    process.env.RATE_LIMIT_LOGIN_MAX = "2";

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const key = clientAddress(request({ "x-forwarded-for": `203.0.113.${attempt}` }));
      expect(consumeRateLimit("login_client", key).allowed).toBe(true);
    }
  });

  test("is still capped per account, because that bucket does not read any header", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "3";
    const account = "hash-of-admin@libredb.org";

    let allowed = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Every attempt arrives from a different forged address; the account key is unchanged.
      clientAddress(request({ "x-forwarded-for": `203.0.113.${attempt}` }));
      if (consumeRateLimit("login_account", account).allowed) allowed += 1;
    }

    expect(allowed).toBe(3);
  });
});

describe("a legitimate deployment behind one reverse proxy", () => {
  test("buckets on the real client, not on the proxy, so one proxy is not one bucket", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    process.env.RATE_LIMIT_LOGIN_MAX = "1";

    const alice = clientAddress(request({ "x-forwarded-for": "spoofed, 198.51.100.7, 10.0.0.2" }));
    const bob = clientAddress(request({ "x-forwarded-for": "spoofed, 198.51.100.8, 10.0.0.2" }));

    expect(consumeRateLimit("login_client", alice).allowed).toBe(true);
    expect(consumeRateLimit("login_client", bob).allowed).toBe(true);
    expect(consumeRateLimit("login_client", alice).allowed).toBe(false);
  });
});

describe("an attacker flooding a cheap bucket to steer eviction", () => {
  test("cannot reset a login_account counter by flooding login_client with disposable keys", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "1";
    process.env.RATE_LIMIT_LOGIN_MAX = "1";
    const victimAccount = "victim@libredb.org";

    expect(consumeRateLimit("login_account", victimAccount).allowed).toBe(true);
    expect(consumeRateLimit("login_account", victimAccount).allowed).toBe(false);

    // Spend the first, disposable login_client key, then rotate X-Forwarded-For for
    // MAX_ENTRIES_PER_BUCKET more - one more than the bucket's own capacity, deriving the size from
    // the constant rather than a hardcoded number so this keeps forcing eviction if it ever moves.
    const firstKey = clientAddress(request({ "x-forwarded-for": "203.0.113.0" }));
    expect(consumeRateLimit("login_client", firstKey).allowed).toBe(true);
    for (let attempt = 1; attempt <= MAX_ENTRIES_PER_BUCKET; attempt += 1) {
      const key = clientAddress(request({ "x-forwarded-for": `203.0.113.${attempt}` }));
      consumeRateLimit("login_client", key);
    }

    // Eviction inside login_client actually happened: the first key was the oldest insertion, so
    // it was evicted and restarted at zero - allowed again even though RATE_LIMIT_LOGIN_MAX is 1.
    // Without this, "login_account survived" would be equally explained by nothing ever having
    // been evicted at all.
    expect(consumeRateLimit("login_client", firstKey).allowed).toBe(true);
    // The victim's login_account counter must still be tripped: flooding a different, cheap
    // bucket must never evict a counter out of login_account. Per-bucket capacity partitioning is
    // the property under test - see the module docstring in src/lib/api/rate-limit.ts.
    expect(consumeRateLimit("login_account", victimAccount).allowed).toBe(false);
  });
});
