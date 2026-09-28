import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { enforceLoginLimit, withLoginBudget } from "@/lib/api/login-budget";
import { clearRateLimitState, consumeRateLimit, peekRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { hmacHex } from "@/lib/auth-compare";
import { AccountError } from "@/lib/local-accounts";

const ADDRESS = "203.0.113.1";
const EMAIL = "Owner@Example.com";

function requestFrom(address: string): Request {
  return new Request("http://localhost/api/x", { method: "POST", headers: { "x-forwarded-for": address } });
}

function auditLines(log: ReturnType<typeof spyOn>): Array<Record<string, unknown>> {
  return log.mock.calls
    .map((call: unknown[]) => call[0])
    .filter((line: unknown): line is string => typeof line === "string" && line.startsWith("{"))
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let log: ReturnType<typeof spyOn>;

beforeEach(() => {
  clearRateLimitState();
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  clearRateLimitState();
});

describe("enforceLoginLimit", () => {
  test("enforceLoginLimit lets a caller under budget through without spending", () => {
    for (let i = 0; i < 5; i++) enforceLoginLimit("login_client", "k", "anonymous", ADDRESS, "POST /x");
    expect(peekRateLimit("login_client", "k").allowed).toBe(true);
    expect(auditLines(log)).toHaveLength(0);
  });

  test("enforceLoginLimit throws RateLimitError once the bucket is spent and audits the trip once, naming the route", () => {
    for (let i = 0; i < 5; i++) consumeRateLimit("login_client", "k");
    for (let i = 0; i < 2; i++) {
      expect(() => enforceLoginLimit("login_client", "k", "anonymous", ADDRESS, "POST /x")).toThrow(RateLimitError);
    }
    const trips = auditLines(log).filter((line) => line.event === "rate_limit_exceeded");
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      route: "POST /x",
      bucket: "login_client",
      actor: "anonymous",
      ip: ADDRESS,
      reason: "rate_limited",
    });
  });

  test("a broken audit sink does not change the 429", () => {
    log.mockImplementation(() => {
      throw new Error("sink down");
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) consumeRateLimit("login_client", "k");
      expect(() => enforceLoginLimit("login_client", "k", "anonymous", ADDRESS, "POST /x")).toThrow(RateLimitError);
      const lines = error.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines.some((line) => line.includes("Failed to record rate_limit_exceeded audit event"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});

describe("withLoginBudget", () => {
  const accountKey = hmacHex(EMAIL.toLowerCase());

  function spent(): { client: boolean; account: boolean } {
    // One unit spent under a budget of 5 and 20 leaves the bucket allowed, so read the spend by
    // exhausting the remainder: a spent unit makes the bucket refuse one call earlier.
    const saved = [process.env.RATE_LIMIT_LOGIN_MAX, process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX];
    process.env.RATE_LIMIT_LOGIN_MAX = "1";
    process.env.RATE_LIMIT_LOGIN_ACCOUNT_MAX = "1";
    try {
      return {
        client: !peekRateLimit("login_client", ADDRESS).allowed,
        account: !peekRateLimit("login_account", accountKey).allowed,
      };
    } finally {
      restore("RATE_LIMIT_LOGIN_MAX", saved[0]);
      restore("RATE_LIMIT_LOGIN_ACCOUNT_MAX", saved[1]);
    }
  }

  test("withLoginBudget charges both buckets only for a 401 AccountError", async () => {
    const wrong = withLoginBudget(requestFrom(ADDRESS), EMAIL, async () => {
      throw new AccountError(401, "wrong password");
    });
    await expect(wrong).rejects.toBeInstanceOf(AccountError);
    expect(spent()).toEqual({ client: true, account: true });

    clearRateLimitState();
    const invalid = withLoginBudget(requestFrom(ADDRESS), EMAIL, async () => {
      throw new AccountError(400, "invalid");
    });
    await expect(invalid).rejects.toBeInstanceOf(AccountError);
    const plain = withLoginBudget(requestFrom(ADDRESS), EMAIL, async () => {
      throw new Error("boom");
    });
    await expect(plain).rejects.toThrow("boom");
    expect(spent()).toEqual({ client: false, account: false });

    clearRateLimitState();
    expect(await withLoginBudget(requestFrom(ADDRESS), EMAIL, async () => "done")).toBe("done");
    expect(spent()).toEqual({ client: false, account: false });
  });

  test("withLoginBudget refuses before running when either bucket is spent", async () => {
    let ran = 0;
    const run = async () => {
      ran += 1;
      return "ran";
    };

    for (let i = 0; i < 5; i++) consumeRateLimit("login_client", ADDRESS);
    await expect(withLoginBudget(requestFrom(ADDRESS), EMAIL, run)).rejects.toBeInstanceOf(RateLimitError);

    clearRateLimitState();
    for (let i = 0; i < 20; i++) consumeRateLimit("login_account", accountKey);
    await expect(withLoginBudget(requestFrom(ADDRESS), EMAIL, run)).rejects.toBeInstanceOf(RateLimitError);

    expect(ran).toBe(0);
  });
});
