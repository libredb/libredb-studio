import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { comparisonCount } from "@/lib/auth-compare";
import { clearRateLimitState } from "@/lib/api/rate-limit";

/**
 * Threat: an attacker learning which accounts exist on this deployment.
 *
 * Three properties must hold TOGETHER, and each is tested here:
 *   1. Identical response - same status and same body bytes for an unknown email, a known email
 *      with a wrong password, empty credentials and non-string fields.
 *   2. Identical work - exactly one comparison per request regardless of whether the email
 *      matched. Asserted through a call counter, never through wall-clock timing: a timing
 *      assertion is flaky in CI and gets "fixed" by weakening it.
 *   3. Identical rate-limit behaviour - the 429 arrives on the same attempt number whether or not
 *      the account exists, because the account bucket is keyed on the HASH OF THE SUBMITTED EMAIL
 *      and is created either way. A bucket that existed only for real accounts would make the 429
 *      itself the oracle.
 */

mock.module("@/lib/auth", () => ({
  login: mock(async () => {}),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mock(async () => {}),
}));

const { POST } = await import("@/app/api/auth/login/route");

function loginRequest(body: unknown, address = "203.0.113.1"): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(body),
  });
}

async function attempt(body: unknown, address?: string): Promise<{ status: number; text: string }> {
  const res = await POST(loginRequest(body, address) as never);
  return { status: res.status, text: await res.text() };
}

let logSpy: ReturnType<typeof spyOn<Console, "log">>;

beforeEach(() => {
  clearRateLimitState();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  clearRateLimitState();
});

describe("the failure response tells an attacker nothing", () => {
  test("an unknown email and a known email with a wrong password are byte-identical", async () => {
    const unknown = await attempt({ email: "nobody@example.com", password: "guess" }, "203.0.113.1");
    const known = await attempt({ email: "admin@libredb.org", password: "guess" }, "203.0.113.2");

    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(unknown.text).toBe(known.text);
    expect(known.text).toBe(JSON.stringify({ success: false, message: "Invalid email or password" }));
  });

  test("empty credentials produce the same bytes", async () => {
    const empty = await attempt({ email: "", password: "" }, "203.0.113.3");

    expect(empty.status).toBe(401);
    expect(empty.text).toBe(JSON.stringify({ success: false, message: "Invalid email or password" }));
  });

  test("non-string fields produce the same bytes rather than a distinguishable 500", async () => {
    const numeric = await attempt({ email: 42, password: { toString: 1 } }, "203.0.113.4");

    expect(numeric.status).toBe(401);
    expect(numeric.text).toBe(JSON.stringify({ success: false, message: "Invalid email or password" }));
  });

  test("a null body field produces the same bytes", async () => {
    const nulls = await attempt({ email: null, password: null }, "203.0.113.5");

    expect(nulls.status).toBe(401);
    expect(nulls.text).toBe(JSON.stringify({ success: false, message: "Invalid email or password" }));
  });
});

describe("the work an attempt costs tells an attacker nothing", () => {
  test("an unknown email costs exactly one comparison, the same as a known one", async () => {
    const beforeUnknown = comparisonCount();
    await attempt({ email: "nobody@example.com", password: "guess" }, "203.0.113.6");
    const unknownCost = comparisonCount() - beforeUnknown;

    const beforeKnown = comparisonCount();
    await attempt({ email: "admin@libredb.org", password: "guess" }, "203.0.113.7");
    const knownCost = comparisonCount() - beforeKnown;

    expect(unknownCost).toBe(1);
    expect(knownCost).toBe(1);
  });

  test("empty and non-string credentials also cost exactly one comparison", async () => {
    const beforeEmpty = comparisonCount();
    await attempt({ email: "", password: "" }, "203.0.113.8");
    expect(comparisonCount() - beforeEmpty).toBe(1);

    const beforeNonString = comparisonCount();
    await attempt({ email: 7, password: 9 }, "203.0.113.9");
    expect(comparisonCount() - beforeNonString).toBe(1);
  });

  test("a correct password still costs exactly one comparison", async () => {
    const before = comparisonCount();
    const res = await attempt({ email: "admin@libredb.org", password: "LibreDB.2026" }, "203.0.113.10");

    expect(res.status).toBe(200);
    expect(comparisonCount() - before).toBe(1);
  });
});

describe("the rate limiter tells an attacker nothing either", () => {
  test("the sixth failed login returns 429", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt({ email: "admin@libredb.org", password: "guess" }, "198.51.100.1")).status).toBe(401);
    }

    const sixth = await POST(loginRequest({ email: "admin@libredb.org", password: "guess" }, "198.51.100.1") as never);

    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBeTruthy();
    expect(await sixth.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  test("the 429 arrives on the same attempt number for an account that does not exist", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt({ email: "nobody@example.com", password: "guess" }, "198.51.100.2")).status).toBe(401);
    }

    expect((await attempt({ email: "nobody@example.com", password: "guess" }, "198.51.100.2")).status).toBe(429);
  });

  test("a successful login clears the budget it had spent, so a typo is not a lockout", async () => {
    for (let i = 0; i < 3; i += 1) {
      await attempt({ email: "admin@libredb.org", password: "typo" }, "198.51.100.3");
    }

    expect((await attempt({ email: "admin@libredb.org", password: "LibreDB.2026" }, "198.51.100.3")).status).toBe(200);

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt({ email: "admin@libredb.org", password: "typo" }, "198.51.100.3")).status).toBe(401);
    }
  });

  test("an attacker rotating the forwarded address is still capped by the account bucket", async () => {
    let throttled = 0;
    for (let i = 0; i < 24; i += 1) {
      const res = await attempt({ email: "admin@libredb.org", password: "guess" }, `198.51.100.${100 + i}`);
      if (res.status === 429) throttled += 1;
    }

    // The client bucket never fills (a fresh address each time), so the account bucket - 20 per
    // window, keyed on the hash of the submitted email - is what stops the run.
    expect(throttled).toBe(4);
  });
});

describe("what the audit trail records", () => {
  test("a failed login records the submitted account and the bad-credentials reason", async () => {
    await attempt({ email: "admin@libredb.org", password: "guess" }, "198.51.100.200");
    const line = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;

    expect(line.event).toBe("login_failure");
    expect(line.reason).toBe("bad_credentials");
    expect(line.actor).toBe("admin@libredb.org");
    expect(line.ip).toBe("198.51.100.200");
    expect(JSON.stringify(line)).not.toContain("guess");
  });

  test("a failed login with no submitted email records an anonymous actor", async () => {
    await attempt({ email: "", password: "guess" }, "198.51.100.201");
    const line = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;

    expect(line.actor).toBe("anonymous");
  });

  test("a successful login is recorded", async () => {
    await attempt({ email: "admin@libredb.org", password: "LibreDB.2026" }, "198.51.100.202");
    const line = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;

    expect(line.event).toBe("login_success");
    expect(line.outcome).toBe("success");
    expect(line.actor).toBe("admin@libredb.org");
  });

  test("the trip is recorded once, not on every subsequent rejection", async () => {
    for (let i = 0; i < 8; i += 1) {
      await attempt({ email: "admin@libredb.org", password: "guess" }, "198.51.100.203");
    }

    const events = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((line) => line.event === "rate_limit_exceeded");

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("rate_limited");
    // Same address and account on every attempt, so login_client trips first - an operator reading
    // this line must be able to tell a broad address flood from a targeted single-account attack.
    expect(events[0].bucket).toBe("login_client");
  });

  test("a targeted attack on one account spread across forged addresses is recorded as the account bucket", async () => {
    for (let i = 0; i < 21; i += 1) {
      await attempt({ email: "admin@libredb.org", password: "guess" }, `198.51.100.${210 + i}`);
    }

    const events = logSpy.mock.calls
      .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
      .filter((line) => line.event === "rate_limit_exceeded");

    // Every attempt used a fresh forged address, so login_client never trips; only login_account -
    // keyed on the submitted email, immune to the spoofed address - trips, on the 21st attempt.
    expect(events).toHaveLength(1);
    expect(events[0].bucket).toBe("login_account");
  });

  test("a malformed body is recorded and its flood is bounded the same way a bad password's is", async () => {
    // A raw, unparseable body - unlike attempt()'s JSON.stringify(body) - which never reaches
    // credential extraction, so this exercises the client-bucket check that runs before parsing
    // (src/app/api/auth/login/route.ts) rather than the account bucket exercised above.
    const malformed = (address: string) =>
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": address },
        body: "not-json",
      });

    const address = "198.51.100.220";
    const first = await POST(malformed(address) as never);
    expect(first.status).toBe(400);

    const firstLine = JSON.parse(logSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(firstLine.event).toBe("login_failure");
    expect(firstLine.reason).toBe("malformed_body");
    expect(firstLine.actor).toBe("anonymous");

    // RATE_LIMIT_LOGIN_MAX defaults to 5: the first five spend the client bucket (one malformed
    // body already sent above), the sixth trips it.
    for (let i = 0; i < 4; i += 1) await POST(malformed(address) as never);
    const sixth = await POST(malformed(address) as never);
    expect(sixth.status).toBe(429);

    // Same suppression as "the trip is recorded once" above: one line per attempt while the
    // bucket has room, then a single rate_limit_exceeded line on the trip, then nothing further -
    // never one unbounded line per request.
    const linesAfterTrip = logSpy.mock.calls.length;
    await POST(malformed(address) as never);
    await POST(malformed(address) as never);
    expect(logSpy.mock.calls.length).toBe(linesAfterTrip);

    const events = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
    expect(events.filter((line) => line.reason === "malformed_body")).toHaveLength(5);
    expect(events.filter((line) => line.event === "rate_limit_exceeded")).toHaveLength(1);
  });
});
