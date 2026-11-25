import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { databaseErrorBody, internalErrorBody, TIMEOUT_SENTENCE, withWithheldText } from "@/lib/api/error-body";
import type { ApiErrorResponse, DatabaseErrorLog } from "@/lib/api/error-body";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";
import { RateLimitError } from "@/lib/api/rate-limit";
import { LLMAuthError } from "@/lib/llm/types";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { VaultError } from "@/lib/seed/vault-client";
import {
  AuthenticationError,
  ByteBudgetRefusal,
  ConnectionError,
  CutValueRefusal,
  DatabaseConfigError,
  DatabaseError,
  FacetNotOfferedError,
  OffsetUnsupportedError,
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
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
  markNotSent,
} from "@/lib/db/errors";
import { openDeadlineSentence } from "@/lib/db/connect-budget";
import { errorKind } from "@/lib/db/error-record";
import { errorRecord, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { secretForms } from "@/lib/db/utils/server-text";
import { serverOnlyReach, valueImportClosure } from "../../../helpers/value-import-closure";

interface Row {
  readonly name: string;
  readonly error: unknown;
  readonly body: ApiErrorResponse;
  readonly log: DatabaseErrorLog;
}

const ROWS: readonly Row[] = [
  {
    name: "QueryCancelledError",
    error: new QueryCancelledError("Query was cancelled", "postgres", "SELECT 1"),
    body: {
      error: "Query was cancelled",
      code: ApiErrorCode.QUERY_CANCELLED,
      statusCode: 499,
      kind: "cancelled",
      outcome: "unknown",
    },
    log: { level: "info", message: "Query cancelled", context: { provider: "postgres" } },
  },
  {
    name: "QueryError with a position and a detail",
    error: new QueryError('syntax error at or near "SELEC"', "postgres", "SELEC 1", 1, "the detail"),
    body: {
      error: 'syntax error at or near "SELEC"',
      code: ApiErrorCode.QUERY_ERROR,
      statusCode: 400,
      details: { position: 1, detail: "the detail" },
      kind: "query",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Query error", context: { provider: "postgres" } },
  },
  {
    name: "QueryError with neither",
    error: new QueryError("Incorrect syntax near 'FROM'.", "mssql"),
    body: {
      error: "Incorrect syntax near 'FROM'.",
      code: ApiErrorCode.QUERY_ERROR,
      statusCode: 400,
      kind: "query",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Query error", context: { provider: "mssql" } },
  },
  {
    name: "DatabaseConfigError",
    error: new DatabaseConfigError("Host is required", "mysql"),
    body: {
      error: "Host is required",
      code: ApiErrorCode.CONFIG_ERROR,
      statusCode: 400,
      kind: "config",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Database config error", context: { provider: "mysql" } },
  },
  {
    name: "an UnknownProviderError answers 400 PROVIDER_UNKNOWN with its sentence: an unknown type",
    error: new UnknownProviderError({
      reason: "unknown",
      typeId: "acmefoo",
      sentence: 'No provider for the connection type "acmefoo" is installed in this LibreDB Studio.',
    }),
    body: {
      error: 'No provider for the connection type "acmefoo" is installed in this LibreDB Studio.',
      code: ApiErrorCode.PROVIDER_UNKNOWN,
      statusCode: 400,
      kind: "unknown-provider",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Unknown provider", context: { reason: "unknown", type: '"acmefoo"' } },
  },
  {
    name: "an UnknownProviderError answers 400 PROVIDER_UNKNOWN with its sentence: an absent type",
    error: new UnknownProviderError({
      reason: "absent",
      sentence: "This connection names no type, so no provider in this LibreDB Studio can open it.",
    }),
    body: {
      error: "This connection names no type, so no provider in this LibreDB Studio can open it.",
      code: ApiErrorCode.PROVIDER_UNKNOWN,
      statusCode: 400,
      kind: "unknown-provider",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Unknown provider", context: { reason: "absent" } },
  },
  {
    name: "an UnknownProviderError of a type that is not text answers 400 PROVIDER_UNKNOWN and logs only its reason",
    error: new UnknownProviderError({
      reason: "malformed",
      sentence:
        "This connection's type is not text, so it is not a type id, and no provider in this LibreDB Studio can open it.",
    }),
    body: {
      error:
        "This connection's type is not text, so it is not a type id, and no provider in this LibreDB Studio can open it.",
      code: ApiErrorCode.PROVIDER_UNKNOWN,
      statusCode: 400,
      kind: "unknown-provider",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Unknown provider", context: { reason: "malformed" } },
  },
  {
    name: "a FacetNotOfferedError answers 400 FACET_NOT_OFFERED with its sentence and a warn line naming the provider",
    error: new FacetNotOfferedError(
      '"vacuum" is not a maintenance operation LibreDB Studio offers on Apache Kafka, which offers none.',
      "kafka",
      "maintenance",
      "vacuum",
    ),
    body: {
      error: '"vacuum" is not a maintenance operation LibreDB Studio offers on Apache Kafka, which offers none.',
      code: ApiErrorCode.FACET_NOT_OFFERED,
      statusCode: 400,
      kind: "not-offered",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Facet not offered", context: { provider: "kafka" } },
  },
  {
    name: "AuthenticationError with a fix statement",
    error: new AuthenticationError("refused", "postgres", {
      fixStatement: "ALTER USER ADD KEY PAIR k PUBLIC_KEY = 'b'",
    }),
    body: {
      error: "refused",
      code: ApiErrorCode.AUTH_ERROR,
      statusCode: 401,
      fixStatement: "ALTER USER ADD KEY PAIR k PUBLIC_KEY = 'b'",
      kind: "authentication",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Database auth error", context: { provider: "postgres" } },
  },
  {
    name: "AuthenticationError without one",
    error: new AuthenticationError("bad password", "mongodb"),
    body: {
      error: "bad password",
      code: ApiErrorCode.AUTH_ERROR,
      statusCode: 401,
      kind: "authentication",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Database auth error", context: { provider: "mongodb" } },
  },
  {
    name: "PermissionDeniedError",
    error: new PermissionDeniedError("permission denied for table orders", "postgres"),
    body: {
      error: "permission denied for table orders",
      code: ApiErrorCode.PERMISSION_DENIED,
      statusCode: 403,
      kind: "permission",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Database permission denied", context: { provider: "postgres" } },
  },
  {
    name: "TimeoutError",
    error: new TimeoutError("query took too long", "postgres", 30000),
    body: {
      error: TIMEOUT_SENTENCE,
      code: ApiErrorCode.TIMEOUT_ERROR,
      statusCode: 504,
      retryable: true,
      kind: "timeout",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Query timeout", context: { provider: "postgres", duration: 30000 } },
  },
  {
    name: "ConnectionError",
    error: new ConnectionError("connect ECONNREFUSED 127.0.0.1:5432", "postgres"),
    body: {
      error: "connect ECONNREFUSED 127.0.0.1:5432",
      code: ApiErrorCode.CONNECTION_ERROR,
      statusCode: 503,
      retryable: true,
      kind: "connection",
      outcome: "unknown",
    },
    log: { level: "error", message: "Connection error", context: { provider: "postgres" } },
  },
  {
    name: "TransactionLostError, which is a ConnectionError and not retryable",
    error: new TransactionLostError("The transaction was lost: its database session ended (x).", "postgres"),
    body: {
      error: "The transaction was lost: its database session ended (x).",
      code: ApiErrorCode.TRANSACTION_LOST,
      statusCode: 503,
      kind: "transaction-lost",
      outcome: "unknown",
    },
    log: { level: "warn", message: "Transaction lost", context: { provider: "postgres" } },
  },
  {
    name: "PoolExhaustedError",
    error: new PoolExhaustedError("no connections available", "mssql", 10),
    body: {
      error: "no connections available",
      code: ApiErrorCode.POOL_EXHAUSTED,
      statusCode: 503,
      retryable: true,
      kind: "pool-exhausted",
      outcome: "unknown",
    },
    log: { level: "error", message: "Pool exhausted", context: { provider: "mssql" } },
  },
  {
    name: "DatabaseError without a code",
    error: new DatabaseError("could not roll back", "postgres"),
    body: {
      error: "could not roll back",
      code: ApiErrorCode.DATABASE_ERROR,
      statusCode: 500,
      kind: "database",
      outcome: "unknown",
    },
    log: { level: "error", message: "Database error", context: { provider: "postgres" } },
  },
  {
    name: "a ProviderUnavailableError answers 503 PROVIDER_UNAVAILABLE with its sentence and logs the quoted type and the codes",
    error: new ProviderUnavailableError("the package was refused", "acme\u2028gone", [
      "PROVIDER_DIGEST_MISMATCH",
      "PROVIDER_LOAD_FAILED",
    ]),
    body: {
      error: "the package was refused",
      code: ApiErrorCode.PROVIDER_UNAVAILABLE,
      statusCode: 503,
      kind: "provider-unavailable",
      outcome: "unknown",
    },
    log: {
      level: "warn",
      message: "Provider unavailable",
      context: { type: '"acme\\u2028gone"', codes: ["PROVIDER_DIGEST_MISMATCH", "PROVIDER_LOAD_FAILED"] },
    },
  },
  {
    name: "a PackageEngineUnsupportedError answers 501 PACKAGE_ENGINE_UNSUPPORTED with its sentence and logs the quoted type",
    error: new PackageEngineUnsupportedError("not served yet", "acmeserved"),
    body: {
      error: "not served yet",
      code: ApiErrorCode.PACKAGE_ENGINE_UNSUPPORTED,
      statusCode: 501,
      kind: "package-engine-unsupported",
      outcome: "unknown",
    },
    log: { level: "info", message: "Package engine unsupported", context: { type: '"acmeserved"' } },
  },
  {
    name: "DatabaseError with a code of its own",
    error: new DatabaseError("odd", "mysql", ApiErrorCode.QUERY_ERROR),
    body: { error: "odd", code: ApiErrorCode.QUERY_ERROR, statusCode: 500, kind: "database", outcome: "unknown" },
    log: { level: "error", message: "Database error", context: { provider: "mysql" } },
  },
];

describe("databaseErrorBody", () => {
  test.each(ROWS.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    expect(JSON.parse(JSON.stringify(databaseErrorBody(row.error)))).toEqual(
      JSON.parse(JSON.stringify({ body: row.body, log: row.log })),
    );
  });

  test("PROVIDER_UNAVAILABLE answers 503 naming the codes and the quoted type, PACKAGE_ENGINE_UNSUPPORTED answers 501", () => {
    const unavailable = databaseErrorBody(
      new ProviderUnavailableError("refused", "acmegone", ["PROVIDER_LOAD_FAILED"]),
    );
    expect([unavailable?.body.statusCode, unavailable?.body.code, unavailable?.log.context]).toEqual([
      503,
      "PROVIDER_UNAVAILABLE",
      { type: '"acmegone"', codes: ["PROVIDER_LOAD_FAILED"] },
    ]);
    const unsupported = databaseErrorBody(new PackageEngineUnsupportedError("not yet", "acmeserved"));
    expect([unsupported?.body.statusCode, unsupported?.body.code]).toEqual([501, "PACKAGE_ENGINE_UNSUPPORTED"]);
    // Distinct from the identity provider's code, which a client compares by exact value.
    expect(ApiErrorCode.PROVIDER_UNAVAILABLE).not.toBe(ApiErrorCode.IDENTITY_PROVIDER_UNAVAILABLE);
  });

  test("the body's code is the record's code for every database error class", () => {
    const scrub: ProviderTextScrub = { type: "postgres", forms: secretForms([crypto.randomUUID()]) };
    const errors = [
      new DatabaseError("failed", "postgres"),
      new DatabaseConfigError("bad config", "postgres"),
      new UnknownProviderError({ reason: "absent", sentence: "no type" }),
      new FacetNotOfferedError("not offered", "mysql", "maintenance", "vacuum"),
      new ConnectionError("lost", "postgres"),
      new TransactionLostError("lost", "postgres"),
      new AuthenticationError("refused", "postgres"),
      new PermissionDeniedError("denied", "postgres"),
      new PoolExhaustedError("pool", "postgres", 10),
      new QueryError("syntax", "postgres"),
      new OffsetUnsupportedError("no offset", "cassandra"),
      new RefusedBeforeSendError("refused", "postgres"),
      new ReadAllowanceExceededError("over the allowance", "postgres"),
      new RowBudgetRefusal("over the row budget", "postgres"),
      new ByteBudgetRefusal("over the byte budget", "postgres"),
      new TimeBudgetRefusal("over the time budget", "postgres"),
      new CutValueRefusal("a cut value", "mssql"),
      new SerialisedResultRefusal("a serialised result", "mssql"),
      new StudioRowBudgetRefusal("over Studio's row budget", "postgres"),
      new StudioByteBudgetRefusal("over Studio's byte budget", "postgres"),
      new StudioTimeBudgetRefusal("over Studio's time budget", "postgres"),
      new TimeoutError("timed out", "postgres", 1000),
      new StudioTimeoutRefusal("Studio's time limit", "postgres", 1000),
      new QueryCancelledError("cancelled", "postgres"),
      new ProviderTextWithheldError("withheld", "postgres"),
    ];
    expect(new Set(errors.map((error) => errorKind(error))).size).toBe(25);
    for (const error of errors) {
      const record = errorRecord(scrub, error);
      const body = databaseErrorBody(error)!.body;
      expect(body.code, error.name).toBe(record.code as ApiErrorCode);
      expect(body.kind, error.name).toBe(record.kind);
      expect(body.outcome, error.name).toBe(record.outcome);
    }
  });

  test("a Studio timeout refusal answers its own sentence and a provider's timeout the shared one", () => {
    const open = new StudioTimeoutRefusal(openDeadlineSentence(70_000), "postgres", 70_000);
    markNotSent(open);
    expect(databaseErrorBody(open)?.body).toEqual({
      error: "The connection did not open within 70 seconds, so Studio stopped waiting for it and sent nothing.",
      code: ApiErrorCode.TIMEOUT_ERROR,
      statusCode: 504,
      retryable: true,
      kind: "studio-timeout-refusal",
      outcome: "not-sent",
    });
    const deadline = new StudioTimeoutRefusal(
      "The statement did not answer within its timeout of 60 seconds and 10 seconds more, so Studio stopped waiting for it.",
      "postgres",
      70_000,
    );
    expect(databaseErrorBody(deadline)?.body).toEqual({
      error:
        "The statement did not answer within its timeout of 60 seconds and 10 seconds more, so Studio stopped waiting for it.",
      code: ApiErrorCode.TIMEOUT_ERROR,
      statusCode: 504,
      retryable: true,
      kind: "studio-timeout-refusal",
      outcome: "unknown",
    });
    expect(
      databaseErrorBody(new TimeoutError("canceling statement due to statement timeout", "postgres"))?.body,
    ).toEqual({
      error: TIMEOUT_SENTENCE,
      code: ApiErrorCode.TIMEOUT_ERROR,
      statusCode: 504,
      retryable: true,
      kind: "timeout",
      outcome: "unknown",
    });
  });

  test("a refusal with no fix statement carries no fixStatement key", () => {
    expect(Object.hasOwn(databaseErrorBody(new AuthenticationError("refused"))!.body, "fixStatement")).toBe(false);
  });

  test.each([
    ["a plain Error", new Error("boom")],
    ["a string", "boom"],
    ["an LLM error", new LLMAuthError("invalid key", "openai")],
    ["a Vault error", new VaultError('Vault is unreachable for "secret/data/prod/postgres"')],
    [
      "a seed refusal",
      new SeedConnectionError("Custom connections are disabled on this server", 403, "CUSTOM_CONNECTIONS_DISABLED"),
    ],
    ["a rate-limit rejection", new RateLimitError(47)],
  ])("%s is not a database error", (_name, error) => {
    expect(databaseErrorBody(error)).toBeNull();
  });
});

describe("internalErrorBody", () => {
  test("an internal error body carries no kind and no outcome", () => {
    for (const error of [new Error("boom"), "boom", undefined]) {
      const body = internalErrorBody(error);
      expect(Object.hasOwn(body, "kind")).toBe(false);
      expect(Object.hasOwn(body, "outcome")).toBe(false);
    }
  });

  test("an Error answers 500 INTERNAL_ERROR with its message", () => {
    expect(internalErrorBody(new Error("boom"))).toEqual({
      error: "boom",
      code: ApiErrorCode.INTERNAL_ERROR,
      statusCode: 500,
    });
  });

  test("anything else answers the fixed sentence", () => {
    expect(internalErrorBody("boom")).toEqual({
      error: "Internal server error",
      code: ApiErrorCode.INTERNAL_ERROR,
      statusCode: 500,
    });
  });
});

describe("withWithheldText", () => {
  const message = "(Studio withheld the text of this QueryError because it contained a credential of this connection)";

  test("replaces the sentence, keeps a numeric position and leaves out the detail and the fix statement", () => {
    const body: ApiErrorResponse = {
      error: "a provider's sentence",
      code: ApiErrorCode.QUERY_ERROR,
      statusCode: 400,
      details: { position: 7, detail: "a provider's detail" },
      fixStatement: "ALTER ROLE x",
      kind: "query",
      outcome: "unknown",
    };
    expect(withWithheldText(body, message)).toEqual({
      error: message,
      code: ApiErrorCode.QUERY_ERROR,
      statusCode: 400,
      details: { position: 7 },
      kind: "query",
      outcome: "unknown",
    });
    const noPosition = withWithheldText({ ...body, details: { position: undefined, detail: "d" } }, message);
    expect(Object.hasOwn(noPosition, "details")).toBe(false);
    expect(Object.hasOwn(withWithheldText({ ...body, details: undefined }, message), "details")).toBe(false);
    expect(Object.hasOwn(withWithheldText({ ...body, details: "a text" }, message), "details")).toBe(false);
  });

  test("keeps the status, code, retryable, kind and outcome, and does not change the body given", () => {
    const body: ApiErrorResponse = {
      error: "a provider's sentence",
      code: ApiErrorCode.CONNECTION_ERROR,
      statusCode: 503,
      retryable: true,
      kind: "connection",
      outcome: "not-sent",
    };
    const given = structuredClone(body);
    expect(withWithheldText(body, message)).toEqual({ ...given, error: message });
    expect(body).toEqual(given);
  });
});

describe("createErrorResponse and databaseErrorBody agree", () => {
  afterEach(() => {
    mock.restore();
  });

  test.each(ROWS.map((row) => [row.name, row] as const))("%s: status, body and log line", async (_name, row) => {
    const spies = {
      info: spyOn(logger, "info").mockImplementation(() => {}),
      warn: spyOn(logger, "warn").mockImplementation(() => {}),
      error: spyOn(logger, "error").mockImplementation(() => {}),
    };
    const answer = databaseErrorBody(row.error)!;
    const res = createErrorResponse(row.error, { route: "api/db/query" });
    expect(res.status).toBe(answer.body.statusCode);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(answer.body)));
    const context = { route: "api/db/query", ...answer.log.context };
    if (answer.log.level === "error") expect(spies.error).toHaveBeenCalledWith(answer.log.message, row.error, context);
    else expect(spies[answer.log.level]).toHaveBeenCalledWith(answer.log.message, context);
    expect(spies.info.mock.calls.length + spies.warn.mock.calls.length + spies.error.mock.calls.length).toBe(1);
  });

  test.each([
    ["an Error", new Error("boom")],
    ["a string", "boom"],
  ])("%s: the 500 body", async (_name, error) => {
    const spy = spyOn(logger, "error").mockImplementation(() => {});
    const res = createErrorResponse(error, { route: "api/db/query" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(internalErrorBody(error));
    expect(spy).toHaveBeenCalledWith("Unhandled error", error, { route: "api/db/query" });
  });
});

describe("the error body is Next-free", () => {
  test("no module it reaches imports next or the logger", () => {
    const closure = valueImportClosure("src/lib/api/error-body.ts");
    expect(closure.unresolved).toEqual([]);
    expect(serverOnlyReach(closure)).toEqual([]);
    expect(closure.modules).toEqual([
      "src/lib/api/error-body.ts",
      "src/lib/api/error-codes.ts",
      "src/lib/db/compatibility.ts",
      "src/lib/db/engine-catalog/catalog.generated.ts",
      "src/lib/db/engine-catalog/connection-flags.generated.ts",
      "src/lib/db/error-record.ts",
      "src/lib/db/errors.ts",
      "src/lib/db/type-id.ts",
    ]);
    // The error record's vocabulary, the provider contract's errors entry, whose module imports no value.
    expect(closure.packages).toEqual(["@libredb/provider-sdk/errors"]);
  });

  test("a control: the same walk over createErrorResponse's module finds Next and the logger", () => {
    const closure = valueImportClosure("src/lib/api/errors.ts");
    expect(serverOnlyReach(closure)).toContain("next/server");
    expect(closure.modules).toContain("src/lib/logger.ts");
  });
});
