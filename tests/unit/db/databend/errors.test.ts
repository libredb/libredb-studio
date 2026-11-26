/**
 * The Databend error table (design 3.13, 6.3; X02, X07): one case per row, each asserting the category, the
 * repository class `toDatabaseError` gives it and the exported sentence a person reads. Classification reads
 * Databend's code, the gateway kind, the HTTP status, the transport kind and Studio's own cancel and deadline state,
 * never message text; every server text a sentence carries passes `serverText` first.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  type DatabaseError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { DatabendRefusal } from "@/lib/db/providers/sql/databend/answer";
import {
  answerError,
  DATABEND_ERROR_SENTENCES as S,
  DATABEND_PROTOCOL_FAULTS,
  type DatabendFailureContext,
  latchedError,
  latchesSignIn,
  protocolError,
  refusalError,
  serverWords,
  signInAnswerOf,
  stopError,
  toDatabaseError,
  transportFailure,
  unsentStopError,
} from "@/lib/db/providers/sql/databend/errors";
import {
  DatabendError,
  type DatabendErrorCategory,
  type DatabendTruncation,
} from "@/lib/db/providers/sql/databend/transport";
import { secretForms, serverText } from "@/lib/db/utils/server-text";
import path from "node:path";
import { createErrorResponse } from "@/lib/api/errors";
import { DATABEND_DSN_CAUTIONS, DATABEND_DSN_REFUSALS, DATABEND_SSLMODE_NOTICES } from "@/lib/connection-string-parser";
import { DATABEND_ANSWER_SENTENCES } from "@/lib/db/providers/sql/databend/answer";
import { databendCloudHostWarehouse } from "@/lib/db/providers/sql/databend/cloud-host";
import {
  DATABEND_CELL_BUDGET,
  DATABEND_CONNECTION_SENTENCES,
  DATABEND_DEFAULT_PORT,
  DATABEND_STATEMENT_BYTES,
} from "@/lib/db/providers/sql/databend/connection-options";
import { DATABEND_PROVIDER_SENTENCES } from "@/lib/db/providers/sql/databend/index";
import { DATABEND_MONITORING_SENTENCES } from "@/lib/db/providers/sql/databend/introspect";
import { DATABEND_LABEL_SENTENCES } from "@/lib/db/providers/sql/databend/labels";
import { DATABEND_OBJECT_SENTENCES } from "@/lib/db/providers/sql/databend/objects";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { DATABEND_EXPLAIN_DECLINES } from "@/lib/explain/databend-text";
import { readFileSync } from "node:fs";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "pass word/1";
const FORMS = secretForms([TEST_PASSWORD, `${TEST_USER}:${TEST_PASSWORD}`]);
const WITHHELD = serverText(TEST_PASSWORD, FORMS);

const SQL = "SELECT a\nFROM t";

function context(overrides: Partial<DatabendFailureContext> = {}): DatabendFailureContext {
  return {
    request: "post",
    origin: "user",
    sql: SQL,
    endpoint: { host: "db.example.test", port: 8000 },
    timeoutMs: 60_000,
    secretForms: FORMS,
    ...overrides,
  };
}

function refusal(overrides: Partial<DatabendRefusal> = {}): DatabendRefusal {
  return { status: 500, contentType: "application/json", code: null, gatewayKind: null, text: "", ...overrides };
}

const answered = { answered: true, killAcknowledged: false };
const acknowledged = { answered: true, killAcknowledged: true };
const unanswered = { answered: false, killAcknowledged: false };

/** One row: the category, the house class `toDatabaseError` gives it, and the sentence. */
function expectRow(
  error: DatabendError,
  category: DatabendErrorCategory,
  houseClass: new (...args: never[]) => DatabaseError,
  message: string,
  ctx: DatabendFailureContext = context(),
): DatabaseError {
  expect(error).toBeInstanceOf(DatabendError);
  expect(error.category).toBe(category);
  expect(error.message).toBe(message);
  const house = toDatabaseError(error, ctx);
  expect(house).toBeInstanceOf(houseClass);
  expect(house.message).toBe(message);
  expect(house.provider).toBe("databend");
  return house;
}

describe("the latched key", () => {
  test("is auth with no request, naming when the sign-in was refused and when the latch lifts, in UTC", () => {
    const at = new Date("2026-10-08T01:20:30Z");
    const until = new Date("2026-10-08T01:35:30Z");
    const error = latchedError(at, until);
    expectRow(error, "auth", AuthenticationError, S.latched("2026-10-08 01:20", "2026-10-08 01:35"));
    // The latch is one process's (D252), so the promise is this server's, never all of Studio's (RI-6).
    expect(error.message).toBe(
      "Databend refused this sign-in at 2026-10-08 01:20 UTC, so this Studio server will not send this password again before 2026-10-08 01:35 UTC, or until it changes.",
    );
  });
});

describe("a refused sign-in (L10, UC1, UC2, UC6)", () => {
  for (const code of [5100, 5101, 5103, 2201]) {
    test(`401 with ${code} is auth with Databend's detail`, () => {
      const error = refusalError(
        refusal({ status: 401, code, text: "Authentication failed: incorrect password" }),
        context(),
      );
      expectRow(error, "auth", AuthenticationError, `${S.signInRefused} Authentication failed: incorrect password.`);
      expect(error.code).toBe(code);
      expect(error.status).toBe(401);
      expect(error.detail).toBe("Authentication failed: incorrect password");
    });
  }

  test("500 with 2215 is auth and adds the possible lockout", () => {
    const text = "Disable login before 2026-10-08 01:35:00 UTC because of too many password fails";
    expectRow(
      refusalError(refusal({ status: 500, code: 2215, text }), context()),
      "auth",
      AuthenticationError,
      `${S.signInRefused} ${text}. ${S.possibleLockout}`,
    );
  });

  test("the server's words end a sentence before the next one, without a second full stop", () => {
    const text = "User 'no_such_user'@'%' does not exist.";
    expect(refusalError(refusal({ status: 401, code: 5100, text }), context({ warehouse: "wh" })).message).toBe(
      `${S.signInRefused} ${text} ${S.cloudSqlUser}`,
    );
  });

  test("with Warehouse set it adds that the console login is not a SQL user", () => {
    expectRow(
      refusalError(refusal({ status: 401, code: 5100, text: "" }), context({ warehouse: "wh" })),
      "auth",
      AuthenticationError,
      `${S.signInRefused} ${S.cloudSqlUser}`,
    );
  });

  for (const kind of ["AuthorizationFailed", "PasswordAuthFailed", "JWTVerificationFailed"]) {
    test(`the gateway kind ${kind} is auth, read as Cloud`, () => {
      expectRow(
        refusalError(
          refusal({ status: 403, gatewayKind: kind, text: "Please check your username and password" }),
          context(),
        ),
        "auth",
        AuthenticationError,
        `${S.signInRefused} Please check your username and password. ${S.cloudSqlUser}`,
      );
    });
  }

  test("a Cloud refusal wrapping 401 with 5100 is auth with the upstream message as its detail (I19)", () => {
    const error = refusalError(
      refusal({
        status: 401,
        gatewayKind: "AuthorizationFailed",
        text: 'status: 401, message: {"error":{"code":5100,"message":"Authentication failed: incorrect password"}}: Authorization failed',
        upstreamStatus: 401,
        upstreamCode: 5100,
        upstreamMessage: "Authentication failed: incorrect password",
      }),
      context({ warehouse: "default" }),
    );
    expectRow(
      error,
      "auth",
      AuthenticationError,
      `${S.signInRefused} Authentication failed: incorrect password. ${S.cloudSqlUser}`,
    );
    expect(error.code).toBe(5100);
    expect(error.status).toBe(401);
    expect(error.detail).toBe("Authentication failed: incorrect password");
  });

  test("a Cloud Unexpected wrapping 500 with 2215 is auth and adds the possible lockout (I19)", () => {
    const text = "Disable login before 2026-10-08 00:54:35.574391755 UTC because of too many password fails";
    const error = refusalError(
      refusal({
        status: 500,
        gatewayKind: "Unexpected",
        text: `status: 500, message: {"error":{"code":2215,"message":"${text}"}}: Unexpected`,
        upstreamStatus: 500,
        upstreamCode: 2215,
        upstreamMessage: text,
      }),
      context({ warehouse: "default" }),
    );
    expectRow(error, "auth", AuthenticationError, `${S.signInRefused} ${text}. ${S.possibleLockout} ${S.cloudSqlUser}`);
    expect(error.code).toBe(2215);
  });

  test("a wrapped upstream message is scrubbed before it is shown", () => {
    const error = refusalError(
      refusal({
        status: 401,
        gatewayKind: "AuthorizationFailed",
        text: "wrapper",
        upstreamStatus: 401,
        upstreamCode: 5100,
        upstreamMessage: `bad password ${TEST_PASSWORD}`,
      }),
      context(),
    );
    expect(error.message).toBe(`${S.signInRefused} ${WITHHELD}. ${S.cloudSqlUser}`);
    expect(error.message).not.toContain(TEST_PASSWORD);
  });

  test("another 401 is a refused follow-up request, protocol", () => {
    expectRow(
      refusalError(refusal({ status: 401, code: 5104, text: "session mismatch" }), context({ request: "get" })),
      "protocol",
      ConnectionError,
      S.followUpRefused,
    );
  });

  test("another 401 on the POST is the request refused before it ran, never a follow-up, protocol", () => {
    for (const code of [5104, null]) {
      const error = refusalError(refusal({ status: 401, code, text: "Unauthorized" }), context());
      expectRow(error, "protocol", ConnectionError, S.middlewareRefused("Unauthorized"));
      expect(error.status).toBe(401);
    }
  });

  test("another 401 on the POST shows the server's words scrubbed and cut, as the middleware's 400 does", () => {
    const scrubbed = refusalError(refusal({ status: 401, text: `denied ${TEST_PASSWORD}` }), context());
    expect(scrubbed.message).toBe(S.middlewareRefused(WITHHELD));
    const cut = refusalError(refusal({ status: 401, text: "x".repeat(400) }), context());
    expect(cut.message).toBe(S.middlewareRefused(`${"x".repeat(300)}...`));
  });

  test("another 401 on the POST with no server text ends the sentence with no colon (Z4)", () => {
    const error = refusalError(refusal({ status: 401, contentType: null, text: "" }), context());
    expectRow(error, "protocol", ConnectionError, "Databend refused the request before running it.");
    expect(error.message).toBe(S.middlewareRefused(""));
    // The middleware's 400 reads the same sentence, so it reads the same with no text.
    expect(refusalError(refusal({ status: 400, code: 400, text: "" }), context()).message).toBe(error.message);
  });
});

describe("the gateway's statement and sign-in kinds (I19)", () => {
  test("ForbiddenAccessUser is a refused statement with the gateway's text, never auth", () => {
    const error = refusalError(
      refusal({ status: 403, gatewayKind: "ForbiddenAccessUser", text: "Permission denied" }),
      context({ warehouse: "default" }),
    );
    expectRow(error, "statement", QueryError, S.statementForbidden("Permission denied"));
    expect(S.statementForbidden("Permission denied")).toBe(
      "Databend Cloud refused this statement for this user: Permission denied.",
    );
  });

  test("ForbiddenAccessUser's text is scrubbed", () => {
    const error = refusalError(
      refusal({ status: 403, gatewayKind: "ForbiddenAccessUser", text: `denied for ${TEST_USER}:${TEST_PASSWORD}` }),
      context(),
    );
    expect(error.message).toBe(S.statementForbidden(serverText(`denied for ${TEST_USER}:${TEST_PASSWORD}`, FORMS)));
    expect(error.message).not.toContain(TEST_PASSWORD);
  });

  test("ForbiddenAccessUser stays a refused statement when its message wraps a sign-in code (I19: never latched)", () => {
    const error = refusalError(
      refusal({
        status: 403,
        gatewayKind: "ForbiddenAccessUser",
        text: 'status: 401, message: {"error":{"code":5100,"message":"x"}}: y',
        upstreamStatus: 401,
        upstreamCode: 5100,
        upstreamMessage: "x",
      }),
      context({ warehouse: "default" }),
    );
    expectRow(error, "statement", QueryError, S.statementForbidden("x"));
  });

  test("AuthorizationRequired is config: no sign-in reached Databend Cloud", () => {
    expectRow(
      refusalError(
        refusal({
          status: 401,
          gatewayKind: "AuthorizationRequired",
          text: "no Password or Authorization provided: Authorization is required",
        }),
        context({ warehouse: "default" }),
      ),
      "config",
      DatabaseConfigError,
      S.signInMissing,
    );
    expect(S.signInMissing).toBe(
      "No sign-in reached Databend Cloud: a proxy between Studio and Databend may drop the Authorization header.",
    );
  });
});

describe("the gateway's configuration kinds", () => {
  for (const kind of ["WarehouseNotFound", "BadWarehouse", "WarehouseHeaderRequired"]) {
    test(`${kind} names Warehouse`, () => {
      expectRow(
        refusalError(refusal({ status: 404, gatewayKind: kind }), context({ warehouse: "wh-1" })),
        "config",
        DatabaseConfigError,
        S.warehouseRefused("wh-1"),
      );
    });
  }

  test("a warehouse kind with no Warehouse set asks for one", () => {
    expectRow(
      refusalError(refusal({ status: 400, gatewayKind: "WarehouseHeaderRequired" }), context()),
      "config",
      DatabaseConfigError,
      S.warehouseRequired,
    );
  });

  for (const kind of ["TenantNotFound", "BadTenant", "IllegalHostName"]) {
    test(`${kind} names Host`, () => {
      expectRow(
        refusalError(refusal({ status: 404, gatewayKind: kind }), context()),
        "config",
        DatabaseConfigError,
        S.hostRefused,
      );
    });
  }
});

describe("the session middleware's 400 on the POST", () => {
  test("is config with 300 scrubbed characters", () => {
    const text = "Some(400) UnknownDatabase. Code: 1003, Text = Unknown database 'no_such_db'.";
    expectRow(
      refusalError(refusal({ status: 400, code: 400, text }), context()),
      "config",
      DatabaseConfigError,
      S.middlewareRefused(text),
    );
  });

  test("cuts the text at 300 characters", () => {
    const error = refusalError(refusal({ status: 400, code: 400, text: "x".repeat(400) }), context());
    expect(error.message).toBe(S.middlewareRefused(`${"x".repeat(300)}...`));
  });

  test("a 400 page is server, not the middleware row", () => {
    expectRow(
      refusalError(refusal({ status: 400, code: 400, text: "closed for timed out" }), context({ request: "get" })),
      "server",
      ConnectionError,
      S.server(400, "closed for timed out"),
    );
  });
});

describe("a fail-to-start answer (id empty)", () => {
  test("2803 is config with Databend's text, nothing ran", () => {
    const message = 'Value bogus is not within the allowed values ["display", "driver"]';
    expectRow(
      answerError({ id: "", error: { code: 2803, message, detail: null } }, context(), null),
      "config",
      DatabaseConfigError,
      `${message} ${S.nothingRan}`,
    );
  });

  test("any other code is statement with Databend's text, nothing ran", () => {
    const error = answerError(
      { id: "", error: { code: 1001, message: "Failed to upgrade session", detail: null } },
      context(),
      null,
    );
    const house = expectRow(error, "statement", QueryError, `Failed to upgrade session ${S.nothingRan}`);
    expect((house as QueryError).query).toBe(SQL);
  });
});

describe("unavailable", () => {
  test("ProvisionWarehouseTimeout after retries gives the resuming sentence", () => {
    expectRow(
      refusalError(refusal({ status: 500, gatewayKind: "ProvisionWarehouseTimeout" }), context({ warehouse: "wh" })),
      "unavailable",
      ConnectionError,
      S.resuming("wh", "60"),
    );
  });

  test("a GET 503 or 429 after retries gives the resuming sentence with Warehouse set", () => {
    for (const status of [503, 429]) {
      expectRow(
        refusalError(refusal({ status }), context({ request: "get", warehouse: "wh", timeoutMs: 10_000 })),
        "unavailable",
        ConnectionError,
        S.resuming("wh", "10"),
      );
    }
  });

  test("without Warehouse it gives the plain sentence", () => {
    expectRow(
      refusalError(refusal({ status: 503 }), context({ request: "get", timeoutMs: 1_500 })),
      "unavailable",
      ConnectionError,
      S.unavailable("HTTP 503", "1.5"),
    );
    expectRow(
      refusalError(refusal({ status: 500, gatewayKind: "ProvisionWarehouseTimeout" }), context()),
      "unavailable",
      ConnectionError,
      S.unavailable("ProvisionWarehouseTimeout", "60"),
    );
  });
});

describe("no answer on the POST", () => {
  for (const status of [503, 429, 502, 504, 520]) {
    test(`a user POST answered ${status} is outcome-unknown`, () => {
      expectRow(
        refusalError(refusal({ status }), context()),
        "outcome-unknown",
        ConnectionError,
        S.noAnswer(`HTTP ${status}`),
      );
    });
  }

  test("another gateway kind is read by its status", () => {
    expectRow(
      refusalError(refusal({ status: 504, gatewayKind: "GatewayTimeout" }), context()),
      "outcome-unknown",
      ConnectionError,
      S.noAnswer("HTTP 504"),
    );
  });

  test("with Warehouse set it adds that a suspended warehouse may still be starting", () => {
    expectRow(
      refusalError(refusal({ status: 502 }), context({ warehouse: "wh" })),
      "outcome-unknown",
      ConnectionError,
      `${S.noAnswer("HTTP 502")} ${S.warehouseStarting}`,
    );
  });

  test("a provider POST answered 502 is network with the 6.3 sentence", () => {
    const house = expectRow(
      refusalError(refusal({ status: 502 }), context({ origin: "provider" })),
      "network",
      ConnectionError,
      S.network("db.example.test", 8000, "HTTP 502"),
    );
    expect((house as ConnectionError).host).toBe("db.example.test");
    expect((house as ConnectionError).port).toBe(8000);
  });

  test("a provider POST answered 503 or 429 without a kind is outcome-unknown, not network", () => {
    for (const status of [503, 429]) {
      expectRow(
        refusalError(refusal({ status }), context({ origin: "provider" })),
        "outcome-unknown",
        ConnectionError,
        S.noAnswer(`HTTP ${status}`),
      );
    }
  });

  test("a user POST that failed on the network is outcome-unknown with the transport's words", () => {
    const failure = new TransportError("network", "connection reset", { truncated: true });
    const error = transportFailure(failure, unanswered, context());
    expectRow(error, "outcome-unknown", ConnectionError, S.noAnswer("connection reset"));
    expect(error.cause).toBe(failure);
  });

  test("a provider statement that failed on the network gets the 6.3 network sentence", () => {
    expectRow(
      transportFailure(new TransportError("network", "ECONNREFUSED"), unanswered, context({ origin: "provider" })),
      "network",
      ConnectionError,
      S.network("db.example.test", 8000, "ECONNREFUSED"),
    );
    expect(S.network("h", 1, "w")).toBe(
      "The server at h:1 did not answer Databend's HTTP API (w). It listens on 8000 self-hosted and 443 on Databend Cloud; 3307 (MySQL) and 8900 (Flight SQL) are not used.",
    );
  });
});

describe("latchesSignIn, the one latching rule that refusalError and the latch both read (I18)", () => {
  test.each([
    ["401 with 5100", { status: 401, code: 5100 }],
    ["401 with 5101", { status: 401, code: 5101 }],
    ["401 with 5103", { status: 401, code: 5103 }],
    ["401 with 2201", { status: 401, code: 2201 }],
    ["500 with 2215", { status: 500, code: 2215 }],
    ["gateway PasswordAuthFailed", { status: 401, gatewayKind: "PasswordAuthFailed" }],
    ["gateway JWTVerificationFailed", { status: 401, gatewayKind: "JWTVerificationFailed" }],
    ["gateway AuthorizationFailed", { status: 401, gatewayKind: "AuthorizationFailed" }],
    [
      "wrapped 401 with 5100",
      { status: 401, gatewayKind: "AuthorizationFailed", upstreamStatus: 401, upstreamCode: 5100 },
    ],
    [
      "wrapped 401 with 2201",
      { status: 401, gatewayKind: "AuthorizationFailed", upstreamStatus: 401, upstreamCode: 2201 },
    ],
    ["wrapped 500 with 2215", { status: 500, gatewayKind: "Unexpected", upstreamStatus: 500, upstreamCode: 2215 }],
    ["a wrapped 401 with 5101 under another gateway status", { status: 502, upstreamStatus: 401, upstreamCode: 5101 }],
    ["401 with 5100 beside an unrelated gateway kind", { status: 401, code: 5100, gatewayKind: "SomethingElse" }],
    ["500 with 2215 beside an unrelated gateway kind", { status: 500, code: 2215, gatewayKind: "SomethingElse" }],
  ])("%s latches", (_label, answer) => {
    expect(latchesSignIn(answer)).toBe(true);
  });

  test.each([
    ["an in-body 2215 over a 200, which is also a complexity error", { status: 200, code: 2215 }],
    ["a 200", { status: 200 }],
    ["another 401, a session mismatch", { status: 401, code: 1001 }],
    ["a 401 with no code", { status: 401 }],
    ["2215 over a 401", { status: 401, code: 2215 }],
    ["5100 over a 500", { status: 500, code: 5100 }],
    ["a 503", { status: 503 }],
    ["another gateway kind", { status: 400, gatewayKind: "WarehouseNotFound" }],
    ["gateway ForbiddenAccessUser, a refused statement", { status: 403, gatewayKind: "ForbiddenAccessUser" }],
    ["gateway AuthorizationRequired, no sign-in sent", { status: 401, gatewayKind: "AuthorizationRequired" }],
    [
      "a wrapped 500 with another code",
      { status: 500, gatewayKind: "Unexpected", upstreamStatus: 500, upstreamCode: 1001 },
    ],
    [
      "a wrapped 2215 over an upstream 401",
      { status: 500, gatewayKind: "Unexpected", upstreamStatus: 401, upstreamCode: 2215 },
    ],
    [
      "a wrapped 5100 over an upstream 500",
      { status: 401, gatewayKind: "Unexpected", upstreamStatus: 500, upstreamCode: 5100 },
    ],
    [
      "gateway ForbiddenAccessUser over a wrapped 401 with 5100",
      { status: 403, gatewayKind: "ForbiddenAccessUser", upstreamStatus: 401, upstreamCode: 5100 },
    ],
    [
      "gateway ForbiddenAccessUser beside 401 with 5100",
      { status: 401, code: 5100, gatewayKind: "ForbiddenAccessUser" },
    ],
  ])("%s does not latch", (_label, answer) => {
    expect(latchesSignIn(answer)).toBe(false);
  });

  test("signInAnswerOf carries every field of a refusal the rule reads, upstream ones included", () => {
    const lockout = refusal({
      status: 500,
      gatewayKind: "Unexpected",
      upstreamStatus: 500,
      upstreamCode: 2215,
      upstreamMessage: "Disable login",
    });
    expect(signInAnswerOf(lockout)).toEqual({
      status: 500,
      code: undefined,
      gatewayKind: "Unexpected",
      upstreamStatus: 500,
      upstreamCode: 2215,
    });
    expect(latchesSignIn(signInAnswerOf(lockout))).toBe(true);
    expect(signInAnswerOf(refusal({ status: 401, code: 5100 }))).toEqual({
      status: 401,
      code: 5100,
      gatewayKind: undefined,
      upstreamStatus: undefined,
      upstreamCode: undefined,
    });
  });

  test("every answer that latches is the auth refusal, and every one that does not is another category", () => {
    for (const answer of [
      { status: 401, code: 5100 },
      { status: 500, code: 2215 },
      { status: 401, gatewayKind: "AuthorizationFailed" },
      { status: 500, gatewayKind: "Unexpected", upstreamStatus: 500, upstreamCode: 2215 },
    ]) {
      const error = refusalError(
        refusal({
          status: answer.status,
          code: answer.code ?? null,
          gatewayKind: answer.gatewayKind ?? null,
          upstreamStatus: answer.upstreamStatus,
          upstreamCode: answer.upstreamCode,
        }),
        context(),
      );
      expect(latchesSignIn(answer)).toBe(true);
      expect(error.category).toBe("auth");
    }
    for (const answer of [
      { status: 401, code: 1001 },
      { status: 500, code: 5100 },
      { status: 401, code: 2215 },
    ]) {
      expect(latchesSignIn(answer)).toBe(false);
      expect(refusalError(refusal({ status: answer.status, code: answer.code }), context()).category).not.toBe("auth");
    }
    for (const kind of ["ForbiddenAccessUser", "AuthorizationRequired"]) {
      expect(latchesSignIn({ status: 403, gatewayKind: kind })).toBe(false);
      expect(refusalError(refusal({ status: 403, gatewayKind: kind }), context()).category).not.toBe("auth");
    }
  });
});

describe("a stop before anything was sent (a latch wait cut short, I18)", () => {
  test("our cancel is cancelled and our deadline timeout or the resuming outcome, never outcome-unknown, since nothing can still run", () => {
    expectRow(unsentStopError("cancel", context()), "cancelled", QueryCancelledError, S.cancelled);
    expectRow(unsentStopError("deadline", context()), "timeout", TimeoutError, S.deadline("60"));
    const ctx = context({ origin: "provider", warehouse: "wh", timeoutMs: 10_000 });
    expectRow(unsentStopError("cancel", ctx), "cancelled", QueryCancelledError, S.cancelled, ctx);
    // On a named warehouse Studio's own read is the resuming outcome, never a timeout (GAP-CL-1).
    expectRow(unsentStopError("deadline", ctx), "unavailable", ConnectionError, S.resuming("wh", "10"), ctx);
  });
});

describe("our cancel and our deadline (X02, X07)", () => {
  test("a cancel after an answer with no kill 200 and no 1043 is outcome-unknown", () => {
    expectRow(stopError("cancel", answered, context()), "outcome-unknown", ConnectionError, S.cancelUnanswered);
    expect(S.cancelUnanswered).toBe(
      "Studio asked Databend to stop the statement and got no answer, so it may still finish.",
    );
  });

  test("a cancel acknowledged by a kill 200 is cancelled", () => {
    expectRow(
      stopError("cancel", { answered: true, killAcknowledged: true }, context()),
      "cancelled",
      QueryCancelledError,
      S.cancelled,
    );
    expectRow(
      stopError("cancel", { answered: false, killAcknowledged: true }, context()),
      "cancelled",
      QueryCancelledError,
      S.cancelled,
    );
  });

  test("a cancel acknowledged by a 1043 answer is cancelled", () => {
    expectRow(
      answerError({ id: "q", error: { code: 1043, message: "canceled by client", detail: null } }, context(), "cancel"),
      "cancelled",
      QueryCancelledError,
      S.cancelled,
    );
  });

  test("a pre-answer cancel or deadline never acknowledged is outcome-unknown", () => {
    expectRow(
      stopError("cancel", unanswered, context()),
      "outcome-unknown",
      ConnectionError,
      S.noAnswer(S.cancelledBeforeAnswer),
    );
    expectRow(
      stopError("deadline", unanswered, context({ timeoutMs: 10_000, warehouse: "wh" })),
      "outcome-unknown",
      ConnectionError,
      `${S.noAnswer(S.deadlineBeforeAnswer("10"))} ${S.warehouseStarting}`,
    );
  });

  test("our deadline after an answer, with the kill acknowledged, is timeout: Studio cancelled it", () => {
    const ctx = context({ timeoutMs: 60_000 });
    const house = expectRow(stopError("deadline", acknowledged, ctx), "timeout", TimeoutError, S.deadline("60"), ctx);
    expect((house as TimeoutError).timeout).toBe(60_000);
    expect((house as TimeoutError).query).toBe(SQL);
    expect(S.deadline("60")).toBe("The statement did not finish within 60 seconds, so Studio cancelled it.");
  });

  test("our deadline after an answer, with a kill Databend did not acknowledge, is outcome-unknown (X02)", () => {
    expectRow(
      stopError("deadline", answered, context()),
      "outcome-unknown",
      ConnectionError,
      S.deadlineUnacknowledged("60"),
    );
    expect(S.deadlineUnacknowledged("60")).toBe(
      "The statement did not finish within 60 seconds, and Databend did not acknowledge Studio's request to stop it, so it may still finish: check before running it again.",
    );
  });

  test("an unacknowledged deadline names no starting warehouse: the warehouse already answered", () => {
    expectRow(
      stopError("deadline", answered, context({ warehouse: "wh" })),
      "outcome-unknown",
      ConnectionError,
      S.deadlineUnacknowledged("60"),
    );
  });

  test.each([
    ["a user statement's", "before", "outcome-unknown", "user", unanswered, S.noAnswer(S.deadlineBeforeAnswer("10"))],
    ["a user statement's", "after", "outcome-unknown", "user", answered, S.deadlineUnacknowledged("10")],
    ["Studio's own read's", "before", "timeout", "provider", unanswered, S.deadline("10")],
    ["Studio's own read's", "after", "timeout", "provider", answered, S.deadline("10")],
  ] as const)(
    "%s deadline %s its first answer, with a kill Databend did not acknowledge, is %s (Z5)",
    (_label, _when, category, origin, state, message) => {
      const ctx = context({ origin, timeoutMs: 10_000 });
      const houseClass = category === "timeout" ? TimeoutError : ConnectionError;
      expectRow(stopError("deadline", state, ctx), category, houseClass, message, ctx);
    },
  );

  test("Studio's own read with the kill acknowledged is timeout too", () => {
    const ctx = context({ origin: "provider", timeoutMs: 10_000 });
    expectRow(stopError("deadline", acknowledged, ctx), "timeout", TimeoutError, S.deadline("10"), ctx);
  });

  test("a deadline under a second is said exactly, never as 0 seconds", () => {
    expectRow(
      stopError("deadline", acknowledged, context({ timeoutMs: 40 })),
      "timeout",
      TimeoutError,
      S.deadline("0.04"),
    );
    expectRow(
      stopError("deadline", acknowledged, context({ timeoutMs: 1 })),
      "timeout",
      TimeoutError,
      S.deadline("0.001"),
    );
    expectRow(
      stopError("deadline", answered, context({ timeoutMs: 40 })),
      "outcome-unknown",
      ConnectionError,
      S.deadlineUnacknowledged("0.04"),
    );
  });

  test("a 1043 answer under our deadline is timeout", () => {
    expectRow(
      answerError(
        {
          id: "q",
          error: { code: 1043, message: "Query aborted due to execution time exceeding maximum limit", detail: null },
        },
        context(),
        "deadline",
      ),
      "timeout",
      TimeoutError,
      S.deadline("60"),
    );
  });

  test("a 1043 answer with no cancel or deadline of ours is Databend's statement error", () => {
    const message = "Aborted query, because the server is shutting down or the query was killed.";
    expectRow(
      answerError({ id: "q", error: { code: 1043, message, detail: null } }, context(), null),
      "statement",
      QueryError,
      message,
    );
  });

  // A `ConnectionError`, so Studio's routes answer it with HTTP 503 and the sentence itself, where a `TimeoutError` is
  // answered with HTTP 504 and the route's own sentence (GAP-CL-1).
  test("with Warehouse set a probe or surface timeout is the resuming outcome, a ConnectionError", () => {
    const ctx = context({ origin: "provider", warehouse: "wh", timeoutMs: 10_000 });
    expectRow(stopError("deadline", unanswered, ctx), "unavailable", ConnectionError, S.resuming("wh", "10"), ctx);
    expectRow(stopError("deadline", answered, ctx), "unavailable", ConnectionError, S.resuming("wh", "10"), ctx);
    expectRow(stopError("deadline", acknowledged, ctx), "unavailable", ConnectionError, S.resuming("wh", "10"), ctx);
    expect(S.resuming("wh", "10")).toBe(
      'Warehouse "wh" did not answer within 10 seconds; it may be resuming. Try again in a minute, or resume it in the Databend Cloud console.',
    );
  });

  test("without Warehouse a probe or surface timeout gives the plain one", () => {
    const ctx = context({ origin: "provider", timeoutMs: 10_000 });
    expectRow(stopError("deadline", unanswered, ctx), "timeout", TimeoutError, S.deadline("10"), ctx);
  });

  test("a user statement's timeout never gives the resuming sentence", () => {
    expectRow(
      stopError("deadline", acknowledged, context({ warehouse: "wh" })),
      "timeout",
      TimeoutError,
      S.deadline("60"),
    );
  });

  test("a provider statement's cancel needs a kill 200 or a 1043 too", () => {
    const ctx = context({ origin: "provider" });
    expectRow(stopError("cancel", answered, ctx), "outcome-unknown", ConnectionError, S.cancelUnanswered, ctx);
    expectRow(stopError("cancel", unanswered, ctx), "outcome-unknown", ConnectionError, S.cancelUnanswered, ctx);
    expectRow(
      stopError("cancel", { answered: true, killAcknowledged: true }, ctx),
      "cancelled",
      QueryCancelledError,
      S.cancelled,
      ctx,
    );
  });

  test("the transport's aborted and timeout kinds are our cancel and our deadline", () => {
    expectRow(
      transportFailure(new TransportError("aborted", "aborted"), answered, context()),
      "outcome-unknown",
      ConnectionError,
      S.cancelUnanswered,
    );
    expectRow(
      transportFailure(new TransportError("timeout", "timed out"), acknowledged, context()),
      "timeout",
      TimeoutError,
      S.deadline("60"),
    );
    expectRow(
      transportFailure(new TransportError("timeout", "timed out"), answered, context()),
      "outcome-unknown",
      ConnectionError,
      S.deadlineUnacknowledged("60"),
    );
  });

  test("a connect that never completed, which this transport does not report, would be a network failure", () => {
    const sentence =
      "No answer from databend.test:8000 after 10 seconds: check the address, the port and the network path.";
    const error = transportFailure(new TransportError("unreachable", sentence), answered, context());
    expect(error.category).toBe("network");
    expect(error.message).toBe(sentence);
  });
});

describe("an in-body error", () => {
  test("is statement with Databend's message, the position from --> SQL:2:5 and the detail", () => {
    const message = "error: \n  --> SQL:2:5\n  |\n2 | FROM t\n  |      ^ Unknown table\n\n";
    const error = answerError(
      { id: "q", error: { code: 1025, message, detail: "at file 'select.csv', line 1" } },
      context(),
      null,
    );
    const house = expectRow(error, "statement", QueryError, message.trimEnd()) as QueryError;
    // "SELECT a\n" is nine characters, so line 2 column 5 is the 14th character.
    expect(error.position).toBe(14);
    expect(house.position).toBe(14);
    expect(SQL.charAt(14 - 1)).toBe(" ");
    expect(house.detail).toBe("at file 'select.csv', line 1");
    expect(house.query).toBe(SQL);
    expect(error.code).toBe(1025);
  });

  test("has no position without a --> SQL line or past the statement's last line", () => {
    const plain = answerError(
      { id: "q", error: { code: 1006, message: "divided by zero", detail: null } },
      context(),
      null,
    );
    expect(plain.position).toBeUndefined();
    expect(plain.detail).toBeUndefined();
    const past = answerError({ id: "q", error: { code: 1005, message: "--> SQL:3:1", detail: null } }, context(), null);
    expect(past.position).toBeUndefined();
  });

  test.each([
    ["column 0", "--> SQL:1:0", undefined],
    ["a column past the line", "--> SQL:1:999", undefined],
    ["a 20-digit column", "--> SQL:1:99999999999999999999", undefined],
    ["the caret just past the line's end", "--> SQL:1:9", 9],
  ])("bounds the column: %s", (_name, message, position) => {
    expect(answerError({ id: "q", error: { code: 1005, message, detail: null } }, context(), null).position).toBe(
      position,
    );
  });

  test("is cut at 1000 characters", () => {
    const error = answerError(
      { id: "q", error: { code: 1006, message: "y".repeat(1200), detail: null } },
      context(),
      null,
    );
    expect(error.message).toBe(`${"y".repeat(1000)}...`);
  });

  test("1003 on a user statement adds the current-database hint", () => {
    expectRow(
      answerError({ id: "q", error: { code: 1003, message: "Unknown database 'x'", detail: null } }, context(), null),
      "statement",
      QueryError,
      `Unknown database 'x' ${S.currentDatabase}`,
    );
  });

  // Measured on the pinned image: the tree's read of a path under a database Databend does not hold.
  test("1003 on a provider statement, which names its full path, is the server's text alone", () => {
    const ctx = context({
      origin: "provider",
      sql: "SHOW CREATE TABLE `default`.`no_such_db`.`t` WITH QUOTED_IDENTIFIERS",
    });
    expectRow(
      answerError(
        { id: "q", error: { code: 1003, message: "Unknown database 'no_such_db'", detail: null } },
        ctx,
        null,
      ),
      "statement",
      QueryError,
      "Unknown database 'no_such_db'",
      ctx,
    );
  });
});

describe("protocol", () => {
  test("names what was wrong in the protocol sentence", () => {
    const cause = new SyntaxError("bad");
    const error = protocolError(DATABEND_PROTOCOL_FAULTS.notJson, cause);
    expectRow(error, "protocol", ConnectionError, S.protocol(DATABEND_PROTOCOL_FAULTS.notJson));
    expect(error.cause).toBe(cause);
    expect(S.protocol("x")).toBe(
      "Databend's answer did not follow its HTTP protocol (x), so Studio stopped and cancelled the statement.",
    );
  });
});

describe("server", () => {
  test("a non-200 page other than 401 is server with 300 scrubbed characters", () => {
    expectRow(
      refusalError(
        refusal({ status: 500, contentType: "text/plain", text: "[HTTP-PANIC] Internal server error" }),
        context({ request: "get" }),
      ),
      "server",
      ConnectionError,
      S.server(500, "[HTTP-PANIC] Internal server error"),
    );
  });

  test("another 5xx on the POST is server", () => {
    const error = refusalError(refusal({ status: 500, code: 1006, text: "boom" }), context());
    expectRow(error, "server", ConnectionError, S.server(500, "boom"));
    expect(error.code).toBe(1006);
    expect(error.status).toBe(500);
  });
});

describe("a TransportError on a provider statement, by kind", () => {
  test("tls gets the transport's words plus the 6.3 TLS sentence", () => {
    const words = "The TLS connection failed (DEPTH_ZERO_SELF_SIGNED_CERT)";
    expectRow(
      transportFailure(new TransportError("tls", words), unanswered, context({ origin: "provider" })),
      "tls",
      ConnectionError,
      S.tls(words),
    );
    expect(S.tls(words)).toBe(
      "The TLS connection failed (DEPTH_ZERO_SELF_SIGNED_CERT). Self-hosted Databend serves plain HTTP on 8000 unless TLS is configured: set SSL mode to disable, or enable TLS on the query node; a certificate error means the CA or host name does not match.",
    );
  });

  test("too-large is a QueryError with the transport's words", () => {
    expectRow(
      transportFailure(new TransportError("too-large", "The answer exceeded 16 MiB."), answered, context()),
      "too-large",
      QueryError,
      "The answer exceeded 16 MiB.",
    );
  });

  for (const kind of ["redirect", "encoding"] as const) {
    test(`${kind} keeps the transport's words`, () => {
      expectRow(
        transportFailure(new TransportError(kind, `words for ${kind}`), answered, context()),
        kind,
        ConnectionError,
        `words for ${kind}`,
      );
    });
  }
});

describe("the configured credential never reaches a sentence", () => {
  const encoded = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const forms: readonly [string, string][] = [
    ["the password", TEST_PASSWORD],
    ["its base64", encoded(TEST_PASSWORD)],
    ["its URL form", encodeURIComponent(TEST_PASSWORD)],
    ["base64(user:password)", encoded(`${TEST_USER}:${TEST_PASSWORD}`)],
  ];

  for (const [name, form] of forms) {
    test(`${name} in an in-body message gives the withheld sentence`, () => {
      const error = answerError(
        { id: "q", error: { code: 1006, message: `bad value ${form} here`, detail: null } },
        context(),
        null,
      );
      expect(error.message).toBe(WITHHELD);
      expect(error.message).not.toContain(form);
    });

    test(`${name} in an in-body detail gives the withheld sentence`, () => {
      const error = answerError(
        { id: "q", error: { code: 1006, message: "failed", detail: `Basic ${form}` } },
        context(),
        null,
      );
      expect(error.message).toBe("failed");
      expect(error.detail).toBe(WITHHELD);
    });

    test(`${name} in a text 500 gives the withheld sentence`, () => {
      const error = refusalError(
        refusal({ status: 500, contentType: "text/plain", text: `header dump ${form}` }),
        context({ request: "get" }),
      );
      expect(error.message).toBe(S.server(500, WITHHELD));
      expect(error.message).not.toContain(form);
    });
  }

  // A password with a quote and a backslash is escaped inside a gateway wrapper's JSON, where no secret form matches it.
  const QUOTED_PASSWORD = 'p"w\\1';
  const QUOTED_FORMS = secretForms([QUOTED_PASSWORD, `${TEST_USER}:${QUOTED_PASSWORD}`]);
  const QUOTED_WITHHELD = serverText(QUOTED_PASSWORD, QUOTED_FORMS);
  const wrapped = (inner: unknown) => `status: 401, message: ${JSON.stringify(inner)}: Forbidden`;

  test.each([
    ["a code that is not a number", wrapped({ error: { code: "5100", message: `bad ${QUOTED_PASSWORD}` } })],
    [
      "a wrapper nested twice",
      wrapped({ error: { code: 5100, message: wrapped({ error: { code: 1, message: QUOTED_PASSWORD } }) } }),
    ],
    ["no wrapper at all, escaped JSON", JSON.stringify({ note: `bad ${QUOTED_PASSWORD}` })],
    ["a \\u escape", String.raw`status: 401, message: {"error":{"code":"x","message":"bad p\u0022w\\1\n"}}: y`],
  ])("an escaped password in a gateway text that is not unwrapped (%s) gives the withheld sentence", (_label, text) => {
    expect(text).not.toContain(QUOTED_PASSWORD);
    for (const gatewayKind of ["ForbiddenAccessUser", "Unexpected"]) {
      const error = refusalError(refusal({ status: 418, gatewayKind, text }), context({ secretForms: QUOTED_FORMS }));
      expect(error.message).toContain(QUOTED_WITHHELD);
      expect(error.message).not.toContain("bad");
    }
  });

  test("a refused sign-in's detail is scrubbed too", () => {
    const error = refusalError(refusal({ status: 401, code: 5100, text: `bad ${TEST_PASSWORD}` }), context());
    expect(error.message).toBe(`${S.signInRefused} ${WITHHELD}.`);
    expect(error.detail).toBe(WITHHELD);
  });
});

describe("serverWords, a server text a sentence names on its own (HASIM-D-5)", () => {
  test("is the text as received when it holds no form and fits", () => {
    expect(serverWords("max_threads", FORMS)).toBe("max_threads");
    expect(serverWords("", FORMS)).toBe("");
  });

  test.each([
    ["the password", `x ${TEST_PASSWORD}`],
    ["user:password in base64", Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")],
    ["the password with its slash escaped", `x ${TEST_PASSWORD.replace("/", "\\/")}`],
  ])("withholds a text holding %s, whole", (_label, text) => {
    expect(serverWords(text, FORMS)).toBe(WITHHELD);
  });

  test("is cut at 300 characters, as a refusal's text is, after the forms are looked for", () => {
    expect(serverWords("x".repeat(400), FORMS)).toBe(`${"x".repeat(300)}...`);
    expect(serverWords(`${"x".repeat(400)}${TEST_PASSWORD}`, FORMS)).toBe(WITHHELD);
  });
});

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
/** A placeholder standing where a template takes a number. */
const slot = (name: string): number => name as unknown as number;
/** The statement budget's own cut, as a cut result reports it. */
const BYTES_CUT: DatabendTruncation = { bound: "bytes", limit: DATABEND_STATEMENT_BYTES };
const CELLS_CUT: DatabendTruncation = { bound: "cells", limit: DATABEND_CELL_BUDGET };
const ROWS_CUT: DatabendTruncation = { bound: "rows", limit: MAX_UNLIMITED_ROWS };
/**
 * Every sentence of each exported record, keyed as the record is, each template filled with placeholders.
 * A key the code adds and this map lacks fails the key check below.
 */
const QUOTED: Readonly<Record<string, { readonly keys: readonly string[]; readonly quotes: readonly string[] }>> = {
  DATABEND_CONNECTION_SENTENCES: {
    keys: Object.keys(DATABEND_CONNECTION_SENTENCES),
    quotes: [
      DATABEND_CONNECTION_SENTENCES.userRequired,
      DATABEND_CONNECTION_SENTENCES.userColon,
      DATABEND_CONNECTION_SENTENCES.control("User"),
      DATABEND_CONNECTION_SENTENCES.control("Password"),
      DATABEND_CONNECTION_SENTENCES.malformed("User"),
      DATABEND_CONNECTION_SENTENCES.malformed("Password"),
      DATABEND_CONNECTION_SENTENCES.warehouse,
      DATABEND_CONNECTION_SENTENCES.plaintext,
      DATABEND_CONNECTION_SENTENCES.queryTimeout,
      DATABEND_CONNECTION_SENTENCES.wrongType("[field]", "[type]"),
    ],
  },
  DATABEND_ANSWER_SENTENCES: {
    keys: Object.keys(DATABEND_ANSWER_SENTENCES),
    quotes: [DATABEND_ANSWER_SENTENCES.resultMode(""), DATABEND_ANSWER_SENTENCES.resultMode("[mode]")],
  },
  DATABEND_ERROR_SENTENCES: {
    keys: Object.keys(S),
    quotes: [
      S.latched("[time]", "[until]"),
      S.signInRefused,
      S.possibleLockout,
      S.cloudSqlUser,
      S.statementForbidden("[server text]"),
      S.signInMissing,
      S.followUpRefused,
      S.warehouseRefused("[warehouse]"),
      S.warehouseRequired,
      S.hostRefused,
      S.middlewareRefused("[server text]"),
      S.middlewareRefused(""),
      S.nothingRan,
      S.resuming("[warehouse]", "[seconds]"),
      S.unavailable("[cause]", "[seconds]"),
      S.noAnswer("[cause]"),
      S.warehouseStarting,
      S.cancelledBeforeAnswer,
      S.deadlineBeforeAnswer("[seconds]"),
      S.cancelUnanswered,
      S.deadline("[seconds]"),
      S.deadlineUnacknowledged("[seconds]"),
      S.cancelled,
      S.protocol("[fault]"),
      S.server(slot("[status]"), "[server text]"),
      S.tls("[transport error]"),
      S.network("[host]", slot("[port]"), "[cause]"),
      S.currentDatabase,
    ],
  },
  DATABEND_PROTOCOL_FAULTS: {
    keys: Object.keys(DATABEND_PROTOCOL_FAULTS),
    quotes: [
      DATABEND_PROTOCOL_FAULTS.notAnswer,
      DATABEND_PROTOCOL_FAULTS.notJson,
      DATABEND_PROTOCOL_FAULTS.prototypeKey,
      DATABEND_PROTOCOL_FAULTS.field("[field]"),
      DATABEND_PROTOCOL_FAULTS.cell,
      DATABEND_PROTOCOL_FAULTS.width(slot("[cells]"), slot("[columns]")),
      DATABEND_PROTOCOL_FAULTS.link,
      DATABEND_PROTOCOL_FAULTS.queryId,
      DATABEND_PROTOCOL_FAULTS.sessionId,
      DATABEND_PROTOCOL_FAULTS.proxySession,
      DATABEND_PROTOCOL_FAULTS.pageSchema,
      DATABEND_PROTOCOL_FAULTS.pollBound,
      DATABEND_PROTOCOL_FAULTS.rows,
      DATABEND_PROTOCOL_FAULTS.schema,
      DATABEND_PROTOCOL_FAULTS.values,
      DATABEND_PROTOCOL_FAULTS.depth,
    ],
  },
  DATABEND_LABEL_SENTENCES: {
    keys: Object.keys(DATABEND_LABEL_SENTENCES),
    quotes: Object.values(DATABEND_LABEL_SENTENCES),
  },
  DATABEND_PROVIDER_SENTENCES: {
    keys: Object.keys(DATABEND_PROVIDER_SENTENCES),
    quotes: [
      DATABEND_PROVIDER_SENTENCES.params,
      DATABEND_PROVIDER_SENTENCES.resultCut(BYTES_CUT),
      DATABEND_PROVIDER_SENTENCES.resultCut(CELLS_CUT),
      DATABEND_PROVIDER_SENTENCES.resultCut(ROWS_CUT),
      DATABEND_PROVIDER_SENTENCES.closeFailed("final"),
      DATABEND_PROVIDER_SENTENCES.closeFailed("rollback"),
      DATABEND_PROVIDER_SENTENCES.closeFailed("logout"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("final"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("rollback"),
      DATABEND_PROVIDER_SENTENCES.closeRefused("logout"),
      DATABEND_PROVIDER_SENTENCES.closeSkipped("logout"),
      DATABEND_PROVIDER_SENTENCES.warningsLeftOut(slot("[count]")),
      DATABEND_PROVIDER_SENTENCES.databaseMissing("[database]"),
      DATABEND_PROVIDER_SENTENCES.unverifiedTls,
      DATABEND_PROVIDER_SENTENCES.slotsBusy("[seconds]"),
      DATABEND_PROVIDER_SENTENCES.maintenanceRefused("[operation]"),
    ],
  },
  DATABEND_MONITORING_SENTENCES: {
    keys: Object.keys(DATABEND_MONITORING_SENTENCES),
    quotes: [
      DATABEND_MONITORING_SENTENCES.killNeedsId,
      DATABEND_MONITORING_SENTENCES.killIdRefused,
      DATABEND_MONITORING_SENTENCES.killAsked("[session id]"),
    ],
  },
  DATABEND_DSN_REFUSALS: {
    keys: Object.keys(DATABEND_DSN_REFUSALS),
    quotes: Object.values(DATABEND_DSN_REFUSALS),
  },
  DATABEND_SSLMODE_NOTICES: {
    keys: Object.keys(DATABEND_SSLMODE_NOTICES),
    quotes: Object.values(DATABEND_SSLMODE_NOTICES),
  },
  DATABEND_DSN_CAUTIONS: {
    keys: Object.keys(DATABEND_DSN_CAUTIONS),
    quotes: [DATABEND_DSN_CAUTIONS.caFile, DATABEND_DSN_CAUTIONS.sslmode("verify-full")],
  },
  DATABEND_EXPLAIN_DECLINES: {
    keys: Object.keys(DATABEND_EXPLAIN_DECLINES),
    quotes: [
      DATABEND_EXPLAIN_DECLINES.binding("[word]", "[construct]"),
      DATABEND_EXPLAIN_DECLINES.writer("[name]"),
      DATABEND_EXPLAIN_DECLINES.hint,
      DATABEND_EXPLAIN_DECLINES.stage,
      DATABEND_EXPLAIN_DECLINES.formFeed,
      DATABEND_EXPLAIN_DECLINES.taggedDollar,
      DATABEND_EXPLAIN_DECLINES.unterminated,
      DATABEND_EXPLAIN_DECLINES.hintAdvice,
      DATABEND_EXPLAIN_DECLINES.formFeedAdvice,
      DATABEND_EXPLAIN_DECLINES.taggedDollarAdvice,
    ],
  },
  DATABEND_OBJECT_SENTENCES: {
    keys: Object.keys(DATABEND_OBJECT_SENTENCES),
    quotes: [
      DATABEND_OBJECT_SENTENCES.bound(BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.incomplete("[surface]", BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.bulkCut(BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.incomplete("definition", BYTES_CUT),
      DATABEND_OBJECT_SENTENCES.unknownTableType("[type]"),
      DATABEND_OBJECT_SENTENCES.unknownKind("[kind]"),
      DATABEND_OBJECT_SENTENCES.badLimit(slot("[limit]")),
      DATABEND_OBJECT_SENTENCES.noColumns("[object]"),
      DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(["[object]"]),
      DATABEND_OBJECT_SENTENCES.noDefinition("[object]"),
      DATABEND_OBJECT_SENTENCES.noPassword("[user]"),
      DATABEND_OBJECT_SENTENCES.sourceLabel,
    ],
  },
};

describe("the sentences of the error paths and the exported records", () => {
  test("the network sentence says the MySQL and Flight SQL ports are not used (owner decision Q6)", () => {
    expect(S.network("[host]", slot("[port]"), "[cause]")).toContain("3307 (MySQL) and 8900 (Flight SQL) are not used");
  });

  test("an older Cloud host's warehouse is named as a Warehouse is in the no-answer and resuming sentences (RI-3)", () => {
    // The sentences once connect() has put the host's warehouse into the options they read, which
    // cloud-host.test.ts drives through the provider.
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT 1",
      warehouse: databendCloudHostWarehouse("tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com"),
      endpoint: { host: "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com", port: 443 },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const refusal = (status: number) => ({
      status,
      contentType: "text/plain",
      code: null,
      gatewayKind: null,
      text: "",
    });
    expect(refusalError(refusal(502), ctx).message).toBe(`${S.noAnswer("HTTP 502")} ${S.warehouseStarting}`);
    expect(refusalError(refusal(503), { ...ctx, request: "get" }).message).toBe(S.resuming("eric", "60"));
    // Only the no-answer sentence adds it: a dropped connection and a stop before the first answer do, and the
    // outcome-unknown sentences of a stop after it do not (Z1).
    const unanswered = { answered: false, killAcknowledged: false };
    const answered = { answered: true, killAcknowledged: false };
    expect(transportFailure(new TransportError("network", "reset"), unanswered, ctx).message).toBe(
      `${S.noAnswer("reset")} ${S.warehouseStarting}`,
    );
    expect(stopError("cancel", unanswered, ctx).message).toBe(
      `${S.noAnswer(S.cancelledBeforeAnswer)} ${S.warehouseStarting}`,
    );
    expect(stopError("cancel", answered, ctx).message).toBe(S.cancelUnanswered);
    expect(stopError("deadline", answered, ctx).message).toBe(S.deadlineUnacknowledged("60"));
  });

  test("a kill refused for want of the privilege is shown as Databend wrote it (cl-ops F2)", () => {
    // Databend's refusal as the pinned image answered `studio_reader`'s kill of another session (measured 2026-10-08).
    const refusal =
      "Permission denied: privilege [Super] is required on *.* for user 'studio_reader'@'%' with roles [public,studio_ro]. Note: Please ensure that your current role have the appropriate permissions to create a new Object";
    // The refusal answers with the statement's id, so Studio shows it as Databend wrote it, nothing appended.
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "provider",
      sql: "KILL QUERY 's1'",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 10_000,
      secretForms: [],
    };
    const refused = answerError({ id: "q", error: { code: 1063, message: refusal, detail: null } }, ctx, null);
    expect(refused.message).toBe(refusal);
  });

  test("every exported sentence record has exactly the keys listed, in order", () => {
    const expectedKeys: Readonly<Record<string, readonly string[]>> = {
      DATABEND_CONNECTION_SENTENCES: [
        "userRequired",
        "userColon",
        "control",
        "malformed",
        "warehouse",
        "plaintext",
        "queryTimeout",
        "wrongType",
      ],
      DATABEND_ANSWER_SENTENCES: ["resultMode"],
      DATABEND_ERROR_SENTENCES: [
        "latched",
        "signInRefused",
        "possibleLockout",
        "cloudSqlUser",
        "statementForbidden",
        "signInMissing",
        "followUpRefused",
        "warehouseRefused",
        "warehouseRequired",
        "hostRefused",
        "middlewareRefused",
        "nothingRan",
        "resuming",
        "unavailable",
        "noAnswer",
        "warehouseStarting",
        "cancelledBeforeAnswer",
        "deadlineBeforeAnswer",
        "cancelUnanswered",
        "deadline",
        "deadlineUnacknowledged",
        "cancelled",
        "protocol",
        "server",
        "tls",
        "network",
        "currentDatabase",
      ],
      DATABEND_PROTOCOL_FAULTS: [
        "notAnswer",
        "notJson",
        "prototypeKey",
        "field",
        "cell",
        "width",
        "link",
        "queryId",
        "sessionId",
        "proxySession",
        "pageSchema",
        "pollBound",
        "rows",
        "schema",
        "values",
        "depth",
      ],
      DATABEND_LABEL_SENTENCES: [
        "analyzeGlobalDesc",
        "vacuumGlobalDesc",
        "slowQueriesEmptyState",
        "sessionsEmptyState",
        "tableStatsCaption",
      ],
      DATABEND_PROVIDER_SENTENCES: [
        "params",
        "resultCut",
        "closeFailed",
        "closeRefused",
        "closeSkipped",
        "warningsLeftOut",
        "databaseMissing",
        "unverifiedTls",
        "slotsBusy",
        "maintenanceRefused",
      ],
      DATABEND_MONITORING_SENTENCES: ["killNeedsId", "killIdRefused", "killAsked"],
      DATABEND_DSN_REFUSALS: ["fragment", "userinfo", "signIn", "flight", "jdbc", "shellExport"],
      DATABEND_SSLMODE_NOTICES: ["require", "enable"],
      DATABEND_DSN_CAUTIONS: ["caFile", "sslmode"],
      DATABEND_EXPLAIN_DECLINES: [
        "binding",
        "writer",
        "hint",
        "stage",
        "formFeed",
        "taggedDollar",
        "unterminated",
        "hintAdvice",
        "formFeedAdvice",
        "taggedDollarAdvice",
      ],
      DATABEND_OBJECT_SENTENCES: [
        "bound",
        "incomplete",
        "bulkCut",
        "unknownTableType",
        "unknownKind",
        "badLimit",
        "noColumns",
        "noColumnsLeftOut",
        "noDefinition",
        "noPassword",
        "sourceLabel",
      ],
    };
    for (const [record, { keys }] of Object.entries(QUOTED)) {
      expect(keys, record).toEqual([...expectedKeys[record]]);
    }
  });

  test("the resuming sentence reaches a route as written with 503, and a timeout gets 504 (GAP-CL-1)", async () => {
    const ctx: DatabendFailureContext = {
      request: "get",
      origin: "provider",
      sql: "SELECT 1",
      warehouse: "[warehouse]",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 10_000,
      secretForms: [],
    };
    const resuming = createErrorResponse(
      toDatabaseError(stopError("deadline", { answered: true, killAcknowledged: true }, ctx), ctx),
    );
    expect(resuming.status).toBe(503);
    expect(((await resuming.json()) as { error: string }).error).toBe(S.resuming("[warehouse]", "10"));
    const timeout = createErrorResponse(new TimeoutError(S.deadline("10"), "databend", 10_000));
    expect(timeout.status).toBe(504);
  });

  test("an in-body error's position is in Databend's own excerpt and on the error, never marked in the editor (SHC-2)", () => {
    expect(read("src/components/studio/BottomPanel.tsx")).toContain("The query failed.");
    // The editor draws no marker for a query error: a marker added later changes this row.
    expect(read("src/components/QueryEditor.tsx")).not.toContain("setModelMarkers");
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT nope",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const excerpt = "error: \n  --> SQL:1:8\n  |\n1 | SELECT nope\n  |        ^^^^ column nope doesn't exist";
    const failed = answerError({ id: "q", error: { code: 1065, message: excerpt, detail: null } }, ctx, null);
    expect(failed.position).toBe(8);
  });

  test("a long refusal and a long statement error are cut and marked", () => {
    const ctx: DatabendFailureContext = {
      request: "post",
      origin: "user",
      sql: "SELECT 1",
      endpoint: { host: "localhost", port: DATABEND_DEFAULT_PORT },
      timeoutMs: 60_000,
      secretForms: [],
    };
    const long = "x".repeat(5000);
    const refused = refusalError(
      { status: 400, contentType: "text/plain", code: 400, gatewayKind: null, text: long },
      ctx,
    );
    const refusalCut = /x+/.exec(refused.message)?.[0].length ?? 0;
    expect(refused.message).toBe(S.middlewareRefused(`${"x".repeat(refusalCut)}...`));
    const failed = answerError({ id: "q", error: { code: 1006, message: long, detail: null } }, ctx, null);
    const statementCut = /x+/.exec(failed.message)?.[0].length ?? 0;
    expect(failed.message).toBe(`${"x".repeat(statementCut)}...`);
  });
});
