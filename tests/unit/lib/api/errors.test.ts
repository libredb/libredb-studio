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
import { errorRecord, providerTextScrub, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { RateLimitError } from "@/lib/api/rate-limit";
import {
  LLMAuthError,
  LLMConfigError,
  LLMError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
} from "@/lib/llm/types";
import { logger } from "@/lib/logger";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { VaultError } from "@/lib/seed/vault-client";
import { ConnectionWriteRefused } from "@/lib/storage/types";
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
    const cases = [
      [new QueryError("syntax error", "postgres", "SELECT 1", 4, `near ${password}`), 400, "QUERY_ERROR"],
      [
        new AuthenticationError("denied", "postgres", { fixStatement: `ALTER ROLE x PASSWORD '${password}'` }),
        401,
        "AUTH_ERROR",
      ],
      [inSqlstate, 400, "QUERY_ERROR"],
    ] as const;
    const responses = cases.map(([error]) => createErrorResponse(error, { route, scrub }));
    const bodies = await Promise.all(responses.map((res) => res.json()));
    cases.forEach(([error, status, code], index) => {
      const body = bodies[index];
      expect(responses[index].status).toBe(status);
      expect(body.code).toBe(code);
      expect(body.error).toBe(withheldErrorMessage(error.name));
      expect(Object.hasOwn(body, "fixStatement")).toBe(false);
      expect(JSON.stringify(body)).not.toContain(password);
    });
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
    quietLogger();
    const pairs = classes.map(([, make]) => {
      const error = make("a provider's sentence");
      return { scrubbed: createErrorResponse(error, { route, scrub }), plain: createErrorResponse(error, { route }) };
    });
    const bodies = await Promise.all(
      pairs.map(async ({ scrubbed, plain }) => ({ scrubbed: await scrubbed.json(), plain: await plain.json() })),
    );
    mock.restore();
    pairs.forEach(({ scrubbed, plain }, index) => {
      expect(scrubbed.status).toBe(plain.status);
      expect(bodies[index].scrubbed).toEqual(bodies[index].plain);
    });
  });

  describe("every branch that answers an error's own text", () => {
    /** Each class answered with its own text, built around a text, with whether its log line is given the error. */
    const textBranches: [string, (text: string) => Error, "error" | "warn"][] = [
      ["SeedConnectionError (403)", (text) => new SeedConnectionError(text, 403), "warn"],
      ["SeedConnectionError (400)", (text) => new SeedConnectionError(text, 400), "warn"],
      ["SeedConnectionError (404)", (text) => new SeedConnectionError(text, 404), "warn"],
      ["VaultError", (text) => new VaultError(text), "warn"],
      ["ConnectionWriteRefused", (text) => new ConnectionWriteRefused(text), "warn"],
      ["LLMConfigError", (text) => new LLMConfigError(text, "openai"), "warn"],
      [
        "LLMConfigError (missing credentials)",
        (text) => new LLMConfigError(text, "openai", "missing_credentials"),
        "warn",
      ],
      ["LLMStreamError", (text) => new LLMStreamError(text, "openai"), "error"],
      ["LLMError", (text) => new LLMError(text, "gemini", 503), "error"],
      ["LLMError (no status)", (text) => new LLMError(text, "gemini"), "error"],
    ];

    test.each(textBranches)(
      "%s holding the connection's credential answers the withheld sentence with its own status, code and retryable",
      async (_label, make) => {
        quietLogger();
        const clean = createErrorResponse(make("a sentence"), { route, scrub });
        const cleanBody = await clean.json();
        const error = make(`a sentence about ${password}`);
        const held = createErrorResponse(error, { route, scrub });
        const heldBody = await held.json();
        expect(held.status).toBe(clean.status);
        for (const key of ["code", "statusCode", "retryable"]) expect(heldBody[key]).toEqual(cleanBody[key]);
        expect(heldBody.error).toBe(withheldErrorMessage(error.name));
        expect(JSON.stringify(heldBody)).not.toContain(password);
      },
    );

    test.each(textBranches)("%s answers its own text without a scrub or without a credential", async (_label, make) => {
      quietLogger();
      const text = `a sentence about ${password}`;
      expect((await createErrorResponse(make(text), { route }).json()).error).toBe(text);
      expect((await createErrorResponse(make("a sentence"), { route, scrub }).json()).error).toBe("a sentence");
    });

    test.each(textBranches)(
      "%s holding the credential gives its log line the withheld error and no argument holds it",
      (_label, make, level) => {
        const spies = quietLogger();
        createErrorResponse(make(`a sentence about ${password}`), { route, scrub });
        const calls = [...spies.info.mock.calls, ...spies.warn.mock.calls, ...spies.error.mock.calls];
        expect(JSON.stringify(calls)).not.toContain(password);
        if (level === "error") {
          expect(spies.error).toHaveBeenCalledTimes(1);
          const logged = spies.error.mock.calls[0][1] as Error;
          expect(logged).toBeInstanceOf(ProviderTextWithheldError);
          expect(String(logged.stack)).not.toContain(password);
        }
      },
    );

    test("an LLMStreamError over the model's context keeps its sentence and gives its log line the withheld error", async () => {
      const spies = quietLogger();
      const error = new LLMStreamError(`${password} exceeds the available context size`, "openai");
      const res = createErrorResponse(error, { route, scrub });
      const body = await res.json();
      expect(res.status).toBe(502);
      expect(body).toEqual({
        error: "The request is too large for the configured model's context.",
        code: "LLM_STREAM",
        statusCode: 502,
        retryable: false,
      });
      const logged = spies.error.mock.calls[0][1] as Error;
      expect(logged).toBeInstanceOf(ProviderTextWithheldError);
      expect(JSON.stringify(spies.error.mock.calls)).not.toContain(password);
    });

    test("a branch that answers a fixed sentence answers it with or without the scrub", async () => {
      for (const error of [
        new LLMSafetyError(`blocked ${password}`, "gemini"),
        new LLMAuthError(`invalid ${password}`, "openai"),
        new LLMRateLimitError(`quota ${password}`, "gemini"),
        new RateLimitError(30),
      ]) {
        const spies = quietLogger();
        const scrubbed = createErrorResponse(error, { route, scrub });
        const plain = createErrorResponse(error, { route });
        expect(scrubbed.status).toBe(plain.status);
        // oxlint-disable-next-line no-await-in-loop -- each error is answered between its own logger mock and that mock's restore.
        const body = await scrubbed.json();
        // oxlint-disable-next-line no-await-in-loop -- the same answer read without the scrub, under the same mock.
        expect(body).toEqual(await plain.json());
        expect(JSON.stringify(body)).not.toContain(password);
        expect(JSON.stringify([...spies.warn.mock.calls, ...spies.error.mock.calls])).not.toContain(password);
        mock.restore();
      }
    });
  });

  describe("a body with a scrub carries the error's record", () => {
    /** The classes of the list above that are database errors, each built with a SQLSTATE. */
    function databaseErrors(text: string, sqlstate: string): DatabaseError[] {
      const errors: DatabaseError[] = [];
      for (const [, make] of classes) {
        const error = make(text);
        if (!(error instanceof DatabaseError)) continue;
        error.sqlstate = sqlstate;
        errors.push(error);
      }
      return errors;
    }

    test("a database error's body carries the SQLSTATE its record carries", async () => {
      const errors = databaseErrors("a provider's sentence", "42P01");
      expect(errors.length).toBeGreaterThan(20);
      for (const error of errors) {
        quietLogger();
        // oxlint-disable-next-line no-await-in-loop -- each error is answered between its own logger mock and that mock's restore.
        const body = await createErrorResponse(error, { route, scrub }).json();
        expect(body.sqlState).toBe("42P01");
        expect(body.sqlState).toBe(errorRecord(scrub, error).sqlState);
        mock.restore();
      }
    });

    test("a withheld error's body carries no SQLSTATE, as its record carries none", async () => {
      const inSqlstate = new QueryError("relation does not exist", "postgres");
      inSqlstate.sqlstate = password;
      const inMessage = new QueryError(`relation ${password} does not exist`, "postgres");
      inMessage.sqlstate = "42P01";
      for (const error of [inSqlstate, inMessage]) {
        quietLogger();
        // oxlint-disable-next-line no-await-in-loop -- each error is answered between its own logger mock and that mock's restore.
        const body = await createErrorResponse(error, { route, scrub }).json();
        expect(Object.hasOwn(body, "sqlState")).toBe(false);
        expect(errorRecord(scrub, error).sqlState).toBeUndefined();
        expect(body.kind).toBe("query");
        mock.restore();
      }
    });

    test("a body without a scrub carries no SQLSTATE", async () => {
      for (const error of databaseErrors("a provider's sentence", "42P01")) {
        quietLogger();
        // oxlint-disable-next-line no-await-in-loop -- each error is answered between its own logger mock and that mock's restore.
        const body = await createErrorResponse(error, { route }).json();
        expect(Object.hasOwn(body, "sqlState")).toBe(false);
        mock.restore();
      }
    });

    test("an error no database class answers carries no SQLSTATE", async () => {
      quietLogger();
      const error = Object.assign(new Error("a provider's sentence"), { sqlstate: "42P01" });
      const body = await createErrorResponse(error, { route, scrub }).json();
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(Object.hasOwn(body, "sqlState")).toBe(false);
    });

    test("the body's kind, code and outcome are the record's for every database error class", async () => {
      for (const error of databaseErrors("a provider's sentence", "42P01")) {
        quietLogger();
        // oxlint-disable-next-line no-await-in-loop -- each error is answered between its own logger mock and that mock's restore.
        const body = await createErrorResponse(error, { route, scrub }).json();
        const record = errorRecord(scrub, error);
        expect({ kind: body.kind, code: body.code, outcome: body.outcome }).toEqual({
          kind: record.kind,
          code: record.code,
          outcome: record.outcome,
        });
        mock.restore();
      }
    });
  });
});
