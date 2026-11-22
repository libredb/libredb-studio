import { afterEach, describe, test, expect, mock, spyOn } from "bun:test";
import { createErrorResponse } from "@/lib/api/errors";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  CutValueRefusal,
  DatabaseConfigError,
  DatabaseError,
  FacetNotOfferedError,
  OffsetUnsupportedError,
  PermissionDeniedError,
  PoolExhaustedError,
  ProviderTextWithheldError,
  QueryCancelledError,
  QueryError,
  ReadAllowanceExceededError,
  RefusedBeforeSendError,
  RowBudgetRefusal,
  SerialisedResultRefusal,
  StudioByteBudgetRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
  TimeBudgetRefusal,
  TimeoutError,
  TransactionLostError,
  UnknownProviderError,
} from "@/lib/db/errors";
import { providerTextScrub, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";

describe("createErrorResponse: a statement's deadline", () => {
  // Chromium sends a POST answered 408 on a reused connection again, so a statement that reached its deadline ran
  // up to six times on the target database for one editor run. 504 is not resent.
  test("a TimeoutError answers 504 with code TIMEOUT_ERROR, never 408", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = createErrorResponse(new TimeoutError("query took too long", "postgres", 30000));
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body).toEqual({
        error: "Query timed out. Please try a simpler query or increase timeout.",
        code: "TIMEOUT_ERROR",
        statusCode: 504,
        retryable: true,
        kind: "timeout",
        outcome: "unknown",
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createErrorResponse with the connection's scrub", () => {
  const password = crypto.randomUUID();
  const connection = {
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    password,
    createdAt: new Date(0),
  } as DatabaseConnection;
  const scrub = providerTextScrub(connection, "any");
  const route = "api/db/query";

  afterEach(() => {
    mock.restore();
  });

  function quietLogger() {
    return {
      info: spyOn(logger, "info").mockImplementation(() => {}),
      warn: spyOn(logger, "warn").mockImplementation(() => {}),
      error: spyOn(logger, "error").mockImplementation(() => {}),
    };
  }

  /**
   * Each class built around a text, so the same class answers once with the credential and once without. A budget
   * refusal keeps the name QueryError, so the withheld sentence names the built error's own name.
   */
  const classes: [string, (text: string) => unknown][] = [
    ["DatabaseError", (text) => new DatabaseError(text, "postgres")],
    ["DatabaseConfigError", (text) => new DatabaseConfigError(text, "postgres")],
    ["UnknownProviderError", (text) => new UnknownProviderError({ reason: "absent", sentence: text })],
    ["FacetNotOfferedError", (text) => new FacetNotOfferedError(text, "postgres", "maintenance", "vacuum")],
    ["ConnectionError", (text) => new ConnectionError(text, "postgres")],
    ["TransactionLostError", (text) => new TransactionLostError(text, "postgres")],
    ["AuthenticationError", (text) => new AuthenticationError(text, "postgres")],
    ["PermissionDeniedError", (text) => new PermissionDeniedError(text, "postgres")],
    ["PoolExhaustedError", (text) => new PoolExhaustedError(text, "postgres", 10)],
    ["QueryError", (text) => new QueryError(text, "postgres", "SELECT 1", 3, "a detail")],
    ["OffsetUnsupportedError", (text) => new OffsetUnsupportedError(text, "postgres")],
    ["RefusedBeforeSendError", (text) => new RefusedBeforeSendError(text, "postgres")],
    ["ReadAllowanceExceededError", (text) => new ReadAllowanceExceededError(text, "postgres")],
    ["RowBudgetRefusal", (text) => new RowBudgetRefusal(text, "postgres")],
    ["ByteBudgetRefusal", (text) => new ByteBudgetRefusal(text, "postgres")],
    ["TimeBudgetRefusal", (text) => new TimeBudgetRefusal(text, "postgres")],
    ["CutValueRefusal", (text) => new CutValueRefusal(text, "postgres")],
    ["SerialisedResultRefusal", (text) => new SerialisedResultRefusal(text, "postgres")],
    ["StudioRowBudgetRefusal", (text) => new StudioRowBudgetRefusal(text, "postgres")],
    ["StudioByteBudgetRefusal", (text) => new StudioByteBudgetRefusal(text, "postgres")],
    ["StudioTimeBudgetRefusal", (text) => new StudioTimeBudgetRefusal(text, "postgres")],
    ["TimeoutError", (text) => new TimeoutError(text, "postgres", 1000)],
    ["StudioTimeoutRefusal", (text) => new StudioTimeoutRefusal(text, "postgres", 1000)],
    ["QueryCancelledError", (text) => new QueryCancelledError(text, "postgres")],
    ["a plain Error", (text) => new Error(text)],
    ["a thrown string", (text) => text],
  ];

  test.each(classes)(
    "%s holding the connection's credential answers the withheld sentence with its own status, code, kind, outcome and retryable",
    async (_label, make) => {
      quietLogger();
      const built = make("a provider's sentence");
      const replaced = built instanceof Error ? built.name : "thrown string";
      const clean = createErrorResponse(make("a provider's sentence"), { route, scrub });
      const cleanBody = await clean.json();
      const held = createErrorResponse(make(`a provider's sentence about ${password}`), { route, scrub });
      const heldBody = await held.json();
      expect(held.status).toBe(clean.status);
      for (const key of ["code", "statusCode", "kind", "outcome", "retryable"])
        expect(heldBody[key]).toEqual(cleanBody[key]);
      expect(heldBody.error).toBe(withheldErrorMessage(replaced));
      expect(JSON.stringify(heldBody)).not.toContain(password);
    },
  );

  test("a credential only in a QueryError's detail, an AuthenticationError's fix statement or a SQLSTATE withholds the whole text", async () => {
    quietLogger();
    const inSqlstate = new QueryError("relation does not exist", "postgres");
    inSqlstate.sqlstate = password;
    for (const [error, status, code] of [
      [new QueryError("syntax error", "postgres", "SELECT 1", 4, `near ${password}`), 400, "QUERY_ERROR"],
      [
        new AuthenticationError("denied", "postgres", { fixStatement: `ALTER ROLE x PASSWORD '${password}'` }),
        401,
        "AUTH_ERROR",
      ],
      [inSqlstate, 400, "QUERY_ERROR"],
    ] as const) {
      const res = createErrorResponse(error, { route, scrub });
      const body = await res.json();
      expect(res.status).toBe(status);
      expect(body.code).toBe(code);
      expect(body.error).toBe(withheldErrorMessage(error.name));
      expect(Object.hasOwn(body, "fixStatement")).toBe(false);
      expect(JSON.stringify(body)).not.toContain(password);
    }
    const positioned = await createErrorResponse(
      new QueryError("syntax error", "postgres", "SELECT 1", 4, `near ${password}`),
      { route, scrub },
    ).json();
    expect(positioned.details).toEqual({ position: 4 });
  });

  test("the log line is given the withheld error and no argument holds the credential", () => {
    for (const error of [
      new ConnectionError(`could not connect with ${password}`, "postgres"),
      new PoolExhaustedError(`pool of ${password}`, "postgres", 10),
      new DatabaseError(`failed for ${password}`, "postgres"),
      new Error(`unhandled ${password}`),
    ]) {
      const spies = quietLogger();
      createErrorResponse(error, { route, scrub });
      expect(spies.error).toHaveBeenCalledTimes(1);
      const args = spies.error.mock.calls[0];
      expect(args[1]).toBeInstanceOf(ProviderTextWithheldError);
      expect(JSON.stringify(args)).not.toContain(password);
      expect(String((args[1] as Error).stack)).not.toContain(password);
      mock.restore();
    }
  });

  test("a clean error answers as it does without the scrub", async () => {
    for (const [, make] of classes) {
      quietLogger();
      const error = make("a provider's sentence");
      const scrubbed = createErrorResponse(error, { route, scrub });
      const plain = createErrorResponse(error, { route });
      expect(scrubbed.status).toBe(plain.status);
      expect(await scrubbed.json()).toEqual(await plain.json());
      mock.restore();
    }
  });
});
