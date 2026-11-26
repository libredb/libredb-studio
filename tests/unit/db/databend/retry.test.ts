import { describe, expect, test } from "bun:test";
import { type RetryInput, type RetryRequest, retryDecision } from "@/lib/db/providers/sql/databend/retry";

/** A first failed attempt with a minute left, jitter at its midpoint and nothing else said. */
function input(overrides: Partial<RetryInput>): RetryInput {
  return {
    request: "query",
    status: null,
    gatewayKind: null,
    transportKind: null,
    attempt: 1,
    msLeft: 60_000,
    retryAfter: null,
    random: 0.5,
    pageTimerRetried: false,
    ...overrides,
  };
}

const GETS: readonly RetryRequest[] = ["page", "final", "kill"];

describe("retryDecision: the rows of design 3.11", () => {
  test.each([
    ["query", 503],
    ["query", 200],
    ["page", 401],
    ["final", 500],
    ["kill", 404],
  ] as const)("a gateway ProvisionWarehouseTimeout retries a %s whatever its status (%i)", (request, status) => {
    expect(retryDecision(input({ request, status, gatewayKind: "ProvisionWarehouseTimeout" }))).toEqual({
      retry: true,
      delayMs: 1000,
    });
  });

  test("another gateway kind is not retried", () => {
    expect(retryDecision(input({ request: "page", status: 503, gatewayKind: "WarehouseNotFound" }))).toEqual({
      retry: false,
    });
  });

  test.each([503, 429])("a POST answered %i without a gateway kind is not resent", (status) => {
    expect(retryDecision(input({ status }))).toEqual({ retry: false });
  });

  test.each(GETS.flatMap((request) => [503, 429].map((status) => [request, status] as const)))(
    "a %s GET answered %i without a gateway kind is retried",
    (request, status) => {
      expect(retryDecision(input({ request, status }))).toEqual({ retry: true, delayMs: 1000 });
    },
  );

  test.each([502, 504, 520])("a POST answered %i is not resent", (status) => {
    expect(retryDecision(input({ status }))).toEqual({ retry: false });
  });

  test.each(GETS.flatMap((request) => [502, 504, 520].map((status) => [request, status] as const)))(
    "a %s GET answered %i is retried",
    (request, status) => {
      expect(retryDecision(input({ request, status }))).toEqual({ retry: true, delayMs: 1000 });
    },
  );

  test("a POST that failed on the network is not resent", () => {
    expect(retryDecision(input({ transportKind: "network" }))).toEqual({ retry: false });
  });

  test.each([...GETS])("a %s GET that failed on the network is retried", (request) => {
    expect(retryDecision(input({ request, transportKind: "network" }))).toEqual({ retry: true, delayMs: 1000 });
  });

  test("the page attempt timer, with deadline left, retries the same page at once [X15]", () => {
    expect(retryDecision(input({ request: "page", transportKind: "timeout", msLeft: 1 }))).toEqual({
      retry: true,
      delayMs: 0,
    });
  });

  test("the page attempt timer retries the same page once only [X15]", () => {
    expect(
      retryDecision(input({ request: "page", transportKind: "timeout", attempt: 2, pageTimerRetried: true })),
    ).toEqual({ retry: false });
  });

  test("the page attempt timer retry counts in the three GET attempts [X15]", () => {
    expect(retryDecision(input({ request: "page", transportKind: "timeout", attempt: 2 }))).toEqual({
      retry: true,
      delayMs: 0,
    });
    expect(retryDecision(input({ request: "page", transportKind: "timeout", attempt: 3 }))).toEqual({
      retry: false,
    });
  });

  test.each([0, -5])("a page timeout with %i ms left is the statement deadline, never retried [X15]", (msLeft) => {
    expect(retryDecision(input({ request: "page", transportKind: "timeout", msLeft }))).toEqual({ retry: false });
  });

  test.each(["query", "final", "kill"] as const)("a %s timeout is not retried", (request) => {
    expect(retryDecision(input({ request, transportKind: "timeout" }))).toEqual({ retry: false });
  });

  test.each(
    (["query", ...GETS] as const).flatMap((request) =>
      (["tls", "redirect", "encoding", "too-large", "aborted"] as const).map((kind) => [request, kind] as const),
    ),
  )("a %s with a %s transport failure is not retried", (request, transportKind) => {
    expect(retryDecision(input({ request, transportKind }))).toEqual({ retry: false });
  });

  test.each(
    (["query", ...GETS] as const).flatMap((request) =>
      [200, 400, 401, 403, 404, 500, 501].map((status) => [request, status] as const),
    ),
  )("a %s answered %i (an in-body error at 200) is not retried", (request, status) => {
    expect(retryDecision(input({ request, status }))).toEqual({ retry: false });
  });

  test.each(["rollback", "logout"] as const)("a %s is never retried, not even for a gateway kind", (request) => {
    expect(retryDecision(input({ request, gatewayKind: "ProvisionWarehouseTimeout", status: 503 }))).toEqual({
      retry: false,
    });
    expect(retryDecision(input({ request, transportKind: "network" }))).toEqual({ retry: false });
  });
});

describe("retryDecision: attempts and backoff", () => {
  const provision = { gatewayKind: "ProvisionWarehouseTimeout", status: 503 } as const;

  test("a POST backs off 1, 2, 4, 8, 8 s at no jitter and is sent at most six times", () => {
    const delays = [1, 2, 3, 4, 5].map((attempt) => retryDecision(input({ ...provision, attempt })));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000].map((delayMs) => ({ retry: true, delayMs })));
    expect(retryDecision(input({ ...provision, attempt: 6 }))).toEqual({ retry: false });
  });

  test("a GET backs off 1, 2 s and is sent at most three times", () => {
    const delays = [1, 2].map((attempt) => retryDecision(input({ request: "page", status: 503, attempt })));
    expect(delays).toEqual([1000, 2000].map((delayMs) => ({ retry: true, delayMs })));
    expect(retryDecision(input({ request: "page", status: 503, attempt: 3 }))).toEqual({ retry: false });
  });

  test("the jitter is 20 percent either way: 0.8 times at the minimum random, 1.2 times at the maximum", () => {
    const at = (random: number, attempt: number) => retryDecision(input({ ...provision, attempt, random }));
    expect([1, 2, 3, 4, 5].map((attempt) => at(0, attempt))).toEqual(
      [800, 1600, 3200, 6400, 6400].map((delayMs) => ({ retry: true, delayMs })),
    );
    const largest = 1 - Number.EPSILON;
    expect([1, 2, 3, 4, 5].map((attempt) => at(largest, attempt))).toEqual(
      [1200, 2400, 4800, 9600, 9600].map((delayMs) => ({ retry: true, delayMs })),
    );
  });

  test("never waits past msLeft: a delay that would reach the deadline is no retry", () => {
    expect(retryDecision(input({ ...provision, msLeft: 1001 }))).toEqual({ retry: true, delayMs: 1000 });
    expect(retryDecision(input({ ...provision, msLeft: 1000 }))).toEqual({ retry: false });
    expect(retryDecision(input({ ...provision, msLeft: 0 }))).toEqual({ retry: false });
  });

  test("a Retry-After in seconds is honoured when longer than the backoff, and within msLeft", () => {
    expect(retryDecision(input({ request: "page", status: 503, retryAfter: "5" }))).toEqual({
      retry: true,
      delayMs: 5000,
    });
    expect(retryDecision(input({ request: "page", status: 429, retryAfter: "0" }))).toEqual({
      retry: true,
      delayMs: 1000,
    });
    expect(retryDecision(input({ request: "page", status: 503, retryAfter: "5", msLeft: 5000 }))).toEqual({
      retry: false,
    });
  });

  test.each(["Wed, 21 Oct 2026 07:28:00 GMT", "-1", "1.5", " 5", ""])(
    "a Retry-After of %p is not a number of seconds, so the backoff stands",
    (retryAfter) => {
      expect(retryDecision(input({ request: "page", status: 503, retryAfter }))).toEqual({
        retry: true,
        delayMs: 1000,
      });
    },
  );
});

describe("the retry schedule", () => {
  test("a page retries twice, a provisioning warehouse five times with backoff, and a query 503 not at all", () => {
    const steps = [1, 2, 3, 4, 5].map((attempt) =>
      retryDecision({
        request: "page",
        status: 503,
        gatewayKind: null,
        transportKind: null,
        attempt,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      }),
    );
    expect(steps.slice(0, 2)).toEqual([
      { retry: true, delayMs: 1000 },
      { retry: true, delayMs: 2000 },
    ]);
    expect(steps[2]).toEqual({ retry: false });
    const post = (attempt: number) =>
      retryDecision({
        request: "query",
        status: 200,
        gatewayKind: "ProvisionWarehouseTimeout",
        transportKind: null,
        attempt,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      });
    expect([1, 2, 3, 4, 5].map((attempt) => post(attempt))).toEqual(
      [1000, 2000, 4000, 8000, 8000].map((delayMs) => ({ retry: true, delayMs })),
    );
    expect(post(6)).toEqual({ retry: false });
    expect(
      retryDecision({
        request: "query",
        status: 503,
        gatewayKind: null,
        transportKind: null,
        attempt: 1,
        msLeft: 600_000,
        retryAfter: null,
        random: 0.5,
        pageTimerRetried: false,
      }),
    ).toEqual({ retry: false });
  });
});
