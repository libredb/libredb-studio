import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  clearRateLimitState,
  consumeRateLimit,
  MAX_ENTRIES_PER_BUCKET,
  parsePositiveInt,
  peekRateLimit,
  RateLimitError,
  resetRateLimit,
} from "@/lib/api/rate-limit";

const MUTATED = [
  "RATE_LIMIT_LOGIN_MAX",
  "RATE_LIMIT_LOGIN_WINDOW_SEC",
  "RATE_LIMIT_LOGIN_ACCOUNT_MAX",
  "RATE_LIMIT_AI_MAX",
  "RATE_LIMIT_AI_WINDOW_SEC",
  "RATE_LIMIT_QUERY_MAX",
  "RATE_LIMIT_ANON_MAX",
  "RATE_LIMIT_ANON_WINDOW_SEC",
] as const;
const snapshot: Record<string, string | undefined> = {};

const T0 = new Date("2026-08-09T10:00:00.000Z");

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  clearRateLimitState();
  setSystemTime(T0);
});

afterEach(() => {
  setSystemTime();
  clearRateLimitState();
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("parsePositiveInt", () => {
  test("takes the fallback when the variable is unset", () => {
    expect(parsePositiveInt(undefined, 5, 100)).toBe(5);
  });

  test("takes the fallback when the value is not a number", () => {
    expect(parsePositiveInt("many", 5, 100)).toBe(5);
  });

  test("takes the fallback for a negative value", () => {
    expect(parsePositiveInt("-1", 5, 100)).toBe(5);
  });

  test("clamps to the ceiling so a typo cannot allocate unbounded state", () => {
    expect(parsePositiveInt("999999", 5, 100)).toBe(100);
  });

  test("accepts a surrounding-whitespace value", () => {
    expect(parsePositiveInt("  7 ", 5, 100)).toBe(7);
  });

  test("accepts zero, which is how a bucket is disabled", () => {
    expect(parsePositiveInt("0", 5, 100)).toBe(0);
  });
});

describe("consumeRateLimit", () => {
  test("allows exactly the configured budget and rejects the next request", () => {
    process.env.RATE_LIMIT_AI_MAX = "3";

    expect(consumeRateLimit("ai", "u").allowed).toBe(true);
    expect(consumeRateLimit("ai", "u").allowed).toBe(true);
    expect(consumeRateLimit("ai", "u").allowed).toBe(true);
    expect(consumeRateLimit("ai", "u").allowed).toBe(false);
  });

  test("reports the trip once, so audit records a transition and not every rejection", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    consumeRateLimit("ai", "u");

    expect(consumeRateLimit("ai", "u").tripped).toBe(true);
    expect(consumeRateLimit("ai", "u").tripped).toBe(false);
    expect(consumeRateLimit("ai", "u").allowed).toBe(false);
  });

  test("keeps buckets independent so one route cannot spend another's budget", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    consumeRateLimit("ai", "u");

    expect(consumeRateLimit("query", "u").allowed).toBe(true);
  });

  test("keeps keys independent so one caller cannot exhaust another's budget", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    consumeRateLimit("ai", "alice");

    expect(consumeRateLimit("ai", "bob").allowed).toBe(true);
  });

  test("starts a fresh window once the old one has closed", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    process.env.RATE_LIMIT_AI_WINDOW_SEC = "60";
    consumeRateLimit("ai", "u");
    expect(consumeRateLimit("ai", "u").allowed).toBe(false);

    setSystemTime(new Date(T0.getTime() + 61_000));

    expect(consumeRateLimit("ai", "u").allowed).toBe(true);
  });

  test("pins the exact boundary: still closed one millisecond before resetAt, open exactly at it", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    process.env.RATE_LIMIT_AI_WINDOW_SEC = "60";
    consumeRateLimit("ai", "u"); // resetAt = T0 + 60_000

    setSystemTime(new Date(T0.getTime() + 60_000 - 1));
    // The live check is `now < resetAt`; a change to `<=` would flip this specific assertion.
    expect(consumeRateLimit("ai", "u").allowed).toBe(false);

    setSystemTime(new Date(T0.getTime() + 60_000));
    expect(consumeRateLimit("ai", "u").allowed).toBe(true);
  });

  test("reports the seconds remaining in the window", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    process.env.RATE_LIMIT_AI_WINDOW_SEC = "60";
    consumeRateLimit("ai", "u");

    setSystemTime(new Date(T0.getTime() + 13_000));

    expect(consumeRateLimit("ai", "u").retryAfterSeconds).toBe(47);
  });

  test("treats a max of zero as unlimited, the documented way to disable a bucket", () => {
    process.env.RATE_LIMIT_AI_MAX = "0";

    for (let i = 0; i < 50; i += 1) {
      expect(consumeRateLimit("ai", "u").allowed).toBe(true);
    }
    expect(consumeRateLimit("ai", "u").retryAfterSeconds).toBe(0);
  });

  test("clamps a zero window to one second rather than degenerating into no limit at all", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    process.env.RATE_LIMIT_AI_WINDOW_SEC = "0";
    consumeRateLimit("ai", "u");

    expect(consumeRateLimit("ai", "u").allowed).toBe(false);
    expect(consumeRateLimit("ai", "u").retryAfterSeconds).toBe(1);
  });

  test("collapses keys that agree for 200 characters, which is the memory bound working", () => {
    process.env.RATE_LIMIT_AI_MAX = "1";
    const prefix = "x".repeat(250);
    consumeRateLimit("ai", `${prefix}a`);

    expect(consumeRateLimit("ai", `${prefix}b`).allowed).toBe(false);
  });
});

describe("peekRateLimit", () => {
  test("does not spend budget", () => {
    process.env.RATE_LIMIT_LOGIN_MAX = "2";

    expect(peekRateLimit("login_client", "k").allowed).toBe(true);
    expect(peekRateLimit("login_client", "k").allowed).toBe(true);
    expect(consumeRateLimit("login_client", "k").allowed).toBe(true);
    expect(consumeRateLimit("login_client", "k").allowed).toBe(true);
    expect(peekRateLimit("login_client", "k").allowed).toBe(false);
  });

  test("latches the trip so the rejection is audited once even when only peek observes it", () => {
    process.env.RATE_LIMIT_LOGIN_MAX = "1";
    consumeRateLimit("login_client", "k");

    expect(peekRateLimit("login_client", "k").tripped).toBe(true);
    expect(peekRateLimit("login_client", "k").tripped).toBe(false);
  });
});

describe("resetRateLimit", () => {
  test("clears a key, which is what a successful login does to its own two buckets", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "1";
    consumeRateLimit("login_account", "k");
    expect(peekRateLimit("login_account", "k").allowed).toBe(false);

    resetRateLimit("login_account", "k");

    expect(peekRateLimit("login_account", "k").allowed).toBe(true);
  });
});

describe("eviction", () => {
  test("stays bounded under key-rotation pressure by dropping the oldest entries first", () => {
    process.env.RATE_LIMIT_ANON_MAX = "1";
    for (let i = 0; i < 5001; i += 1) {
      consumeRateLimit("anon", `key-${i}`);
    }

    // Pruning runs BEFORE the new key is inserted, so it is never a candidate for its own
    // eviction; every key here is consumed exactly once, so all existing entries tie at count 1,
    // and a tie resolves to the earliest inserted (Map iteration order). The very first key is
    // therefore always the one that loses its slot as later keys keep arriving - a sliding
    // window. It starts again at zero. Eviction fails OPEN on purpose: a counter must never
    // become an availability control, which is why the cap is generous.
    expect(consumeRateLimit("anon", "key-0").allowed).toBe(true);
    // A recent key kept its count.
    expect(consumeRateLimit("anon", "key-5000").allowed).toBe(false);
  });

  test("reclaims closed windows before evicting live ones", () => {
    process.env.RATE_LIMIT_ANON_MAX = "1";
    process.env.RATE_LIMIT_ANON_WINDOW_SEC = "60";
    for (let i = 0; i < 5001; i += 1) {
      consumeRateLimit("anon", `key-${i}`);
    }

    setSystemTime(new Date(T0.getTime() + 61_000));
    consumeRateLimit("anon", "fresh");

    // Every earlier window closed, so the sweep reclaimed all of them and nothing live was lost.
    expect(consumeRateLimit("anon", "fresh").allowed).toBe(false);
  });

  test("partitions capacity per bucket, so flooding one bucket cannot evict another bucket's counters", () => {
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "1";
    consumeRateLimit("login_account", "victim");
    expect(peekRateLimit("login_account", "victim").allowed).toBe(false);

    process.env.RATE_LIMIT_LOGIN_MAX = "1";
    // One request for "flood-0" now, and MAX_ENTRIES_PER_BUCKET more distinct keys after it - one
    // more than the bucket's own capacity - so eviction inside login_client is forced to happen,
    // not merely possible. Deriving the size from the constant keeps this true if it ever moves.
    expect(consumeRateLimit("login_client", "flood-0").allowed).toBe(true);
    for (let i = 1; i <= MAX_ENTRIES_PER_BUCKET; i += 1) {
      consumeRateLimit("login_client", `flood-${i}`);
    }

    // Eviction inside login_client actually happened: pruning runs BEFORE the new key is
    // inserted, so it is never a candidate for its own eviction, and every existing entry here
    // ties at count 1 - a tie resolves to the earliest inserted, so "flood-0" is what loses its
    // slot. Without this assertion, "login_account survived" would be equally explained by no
    // eviction ever having occurred at all.
    expect(consumeRateLimit("login_client", "flood-0").allowed).toBe(true);
    // login_client's own eviction pressure never touches login_account's store: each bucket has
    // its own capacity, so a flood cheap enough to need no real account can only ever evict
    // entries that already belong to that same cheap bucket.
    expect(peekRateLimit("login_account", "victim").allowed).toBe(false);
  });
});

describe("RateLimitError", () => {
  test("carries the wait so the envelope can set Retry-After in exactly one place", () => {
    const error = new RateLimitError(47);

    expect(error.retryAfterSeconds).toBe(47);
    expect(error.message).toBe("Too many requests. Try again in 47 seconds.");
    expect(error.name).toBe("RateLimitError");
  });
});
