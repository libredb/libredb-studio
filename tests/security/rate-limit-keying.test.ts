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

    // One trusted proxy appends exactly one entry - the rightmost - so that is the position that
    // must vary between two different real clients; "spoofed" and the middle entry are both
    // attacker-suppliable prefix and must never affect which bucket a request lands in.
    const alice = clientAddress(request({ "x-forwarded-for": "spoofed, 10.0.0.2, 198.51.100.7" }));
    const bob = clientAddress(request({ "x-forwarded-for": "spoofed, 10.0.0.2, 198.51.100.8" }));

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

    // Rotate X-Forwarded-For for MAX_ENTRIES_PER_BUCKET + 1 disposable login_client keys - one
    // more than the bucket's own capacity, deriving the size from the constant rather than a
    // hardcoded number so this keeps forcing eviction if it ever moves.
    const firstKey = clientAddress(request({ "x-forwarded-for": "203.0.113.0" }));
    consumeRateLimit("login_client", firstKey);
    for (let attempt = 1; attempt <= MAX_ENTRIES_PER_BUCKET; attempt += 1) {
      const key = clientAddress(request({ "x-forwarded-for": `203.0.113.${attempt}` }));
      consumeRateLimit("login_client", key);
    }

    // Eviction inside login_client actually happened: pruning runs BEFORE the new key is
    // inserted, so the arriving key is never a candidate for its own eviction - every existing
    // entry here is tied at count 1, and a tie resolves to the earliest inserted, so the very
    // first key is what loses its slot. Without this, "login_account survived" would be equally
    // explained by nothing ever having been evicted.
    expect(consumeRateLimit("login_client", firstKey).allowed).toBe(true);
    // The victim's login_account counter must still be tripped: flooding a different, cheap
    // bucket must never evict a counter out of login_account. Per-bucket capacity partitioning is
    // the property under test - see the module docstring in src/lib/api/rate-limit.ts.
    expect(consumeRateLimit("login_account", victimAccount).allowed).toBe(false);
  });
});

describe("an attacker trying to buy back a spent login_account budget", () => {
  test("an entry deep into its budget survives a flood of fresh single-use guesses, which are evicted instead", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "10";
    const target = "victim@libredb.org";

    // The target is deep into its budget: 9 of 10 failed attempts already spent, one left before
    // it trips. login_account's key is hmacHex(email), fully attacker-chosen - the attacker picks
    // every guessed email below for free, unlike login_client's address-derived key.
    for (let i = 0; i < 9; i += 1) {
      consumeRateLimit("login_account", target);
    }

    // Flood the SAME bucket with MAX_ENTRIES_PER_BUCKET fresh, single-use guessed accounts. One
    // more than the bucket's own capacity guarantees an eviction happens.
    const firstGuess = "guess-0@example.com";
    consumeRateLimit("login_account", firstGuess);
    for (let i = 1; i < MAX_ENTRIES_PER_BUCKET; i += 1) {
      consumeRateLimit("login_account", `guess-${i}@example.com`);
    }

    // The target's budget was NOT bought back by the flood: it still has exactly the one attempt
    // it had left, not a fresh ten. The target's own count (9) makes it the highest in the
    // bucket, and the entry being inserted is never a candidate for its own eviction, so nothing
    // here can ever pick the target as the victim.
    expect(consumeRateLimit("login_account", target).allowed).toBe(true);
    expect(consumeRateLimit("login_account", target).allowed).toBe(false);
    // A flood entry, not the target, is what actually lost its slot: every guess ties at count 1,
    // and a tie resolves to the earliest inserted.
    expect(consumeRateLimit("login_account", firstGuess).allowed).toBe(true);
  });
});

describe("a target account established after login_account is already saturated with decoys", () => {
  test("still accumulates a persistent count and still trips at its budget", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "10";
    const target = "victim@libredb.org";

    // Saturate the bucket to capacity BEFORE the target ever appears, with decoys hit exactly
    // once each - cheap, and audit-silent because none of them trip. This is the ordering that
    // exposed the bug in an earlier version of this file: pruning ran AFTER insert, so the
    // target's own brand-new entry (count 0) was always the lowest count and evicted itself on
    // every single attempt, and the target's count could never rise above 1 - it would never
    // trip at all, which is a complete, sustained, audit-silent bypass.
    for (let i = 0; i < MAX_ENTRIES_PER_BUCKET; i += 1) {
      consumeRateLimit("login_account", `decoy-${i}@example.com`);
    }

    // The target must still take a slot - by evicting a decoy, since pruning excludes the target
    // itself from candidacy - and accumulate a REAL, persistent count across repeated attempts.
    // All 10 of the budget's attempts must be allowed (a fresh entry that keeps resetting to zero
    // would also pass every individual check here), so the 11th - past the budget - is what
    // actually proves the count persisted rather than restarting on every request.
    for (let i = 0; i < 10; i += 1) {
      expect(consumeRateLimit("login_account", target).allowed).toBe(true);
    }
    expect(consumeRateLimit("login_account", target).allowed).toBe(false);
  });
});
