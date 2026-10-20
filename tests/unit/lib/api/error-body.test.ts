import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { databaseErrorBody, internalErrorBody, TIMEOUT_SENTENCE } from "@/lib/api/error-body";
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
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";

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
    body: { error: "Query was cancelled", code: ApiErrorCode.QUERY_CANCELLED, statusCode: 499 },
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
    },
    log: { level: "warn", message: "Query error", context: { provider: "postgres" } },
  },
  {
    name: "QueryError with neither",
    error: new QueryError("Incorrect syntax near 'FROM'.", "mssql"),
    body: { error: "Incorrect syntax near 'FROM'.", code: ApiErrorCode.QUERY_ERROR, statusCode: 400 },
    log: { level: "warn", message: "Query error", context: { provider: "mssql" } },
  },
  {
    name: "DatabaseConfigError",
    error: new DatabaseConfigError("Host is required", "mysql"),
    body: { error: "Host is required", code: ApiErrorCode.CONFIG_ERROR, statusCode: 400 },
    log: { level: "warn", message: "Database config error", context: { provider: "mysql" } },
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
    },
    log: { level: "warn", message: "Database auth error", context: { provider: "postgres" } },
  },
  {
    name: "AuthenticationError without one",
    error: new AuthenticationError("bad password", "mongodb"),
    body: { error: "bad password", code: ApiErrorCode.AUTH_ERROR, statusCode: 401 },
    log: { level: "warn", message: "Database auth error", context: { provider: "mongodb" } },
  },
  {
    name: "PermissionDeniedError",
    error: new PermissionDeniedError("permission denied for table orders", "postgres"),
    body: { error: "permission denied for table orders", code: ApiErrorCode.PERMISSION_DENIED, statusCode: 403 },
    log: { level: "warn", message: "Database permission denied", context: { provider: "postgres" } },
  },
  {
    name: "TimeoutError",
    error: new TimeoutError("query took too long", "postgres", 30000),
    body: { error: TIMEOUT_SENTENCE, code: ApiErrorCode.TIMEOUT_ERROR, statusCode: 504, retryable: true },
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
    },
    log: { level: "error", message: "Connection error", context: { provider: "postgres" } },
  },
  {
    name: "PoolExhaustedError",
    error: new PoolExhaustedError("no connections available", "mssql", 10),
    body: { error: "no connections available", code: ApiErrorCode.POOL_EXHAUSTED, statusCode: 503, retryable: true },
    log: { level: "error", message: "Pool exhausted", context: { provider: "mssql" } },
  },
  {
    name: "DatabaseError without a code",
    error: new DatabaseError("could not roll back", "postgres"),
    body: { error: "could not roll back", code: ApiErrorCode.DATABASE_ERROR, statusCode: 500 },
    log: { level: "error", message: "Database error", context: { provider: "postgres" } },
  },
  {
    name: "DatabaseError with a code of its own",
    error: new DatabaseError("odd", "mysql", ApiErrorCode.QUERY_ERROR),
    body: { error: "odd", code: ApiErrorCode.QUERY_ERROR, statusCode: 500 },
    log: { level: "error", message: "Database error", context: { provider: "mysql" } },
  },
];

describe("databaseErrorBody", () => {
  test.each(ROWS.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    expect(JSON.parse(JSON.stringify(databaseErrorBody(row.error)))).toEqual(
      JSON.parse(JSON.stringify({ body: row.body, log: row.log })),
    );
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

const SRC = resolve(import.meta.dir, "../../../../src");

/** The source file a specifier names, or null for a package. */
function resolveSource(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(importer), specifier);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${importer}`);
}

/** Every module reached through value imports from `entry`, source files named as `@/` specifiers, deduplicated. */
async function reachableModules(entry: string): Promise<string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const reached = new Set<string>();
  const seen = new Set<string>();
  const queue = [join(SRC, entry.replace(/^src\//, ""))];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const target = resolveSource(path, file);
      if (target === null) {
        reached.add(path);
        continue;
      }
      reached.add(`@/${relative(SRC, target).replace(/(\/index)?\.tsx?$/, "")}`);
      queue.push(target);
    }
  }
  return [...reached];
}

describe("the error body is Next-free", () => {
  test("no module it reaches imports next or the logger", async () => {
    const reached = await reachableModules("src/lib/api/error-body.ts");
    expect(reached.filter((s) => s === "next" || s.startsWith("next/") || s === "@/lib/logger")).toEqual([]);
    expect(reached.sort()).toEqual(["@/lib/api/error-codes", "@/lib/db/errors"]);
  });
});
