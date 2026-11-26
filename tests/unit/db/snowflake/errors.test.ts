import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { secretForms } from "@/lib/db/utils/server-text";
import {
  failureError,
  keyPairName,
  SNOWFLAKE,
  SNOWFLAKE_ERROR_SENTENCES,
  SNOWFLAKE_SERVER_TEXT_MAX_CHARS,
  SnowflakeError,
  type SnowflakeErrorCategory,
  type SnowflakeFailure,
  type SnowflakeFailureContext,
  serverMessage,
  toDatabaseError,
  transportFailureError,
  administratorStatement,
} from "@/lib/db/providers/sql/snowflake/errors";
import { SNOWFLAKE_FIELD_SENTENCES } from "@/lib/db/providers/sql/snowflake/account-host";
import { SNOWFLAKE_KEY_SENTENCES, SNOWFLAKE_TOKEN_SENTENCES } from "@/lib/db/providers/sql/snowflake/auth";
import { SNOWFLAKE_ROWS_SENTENCES } from "@/lib/db/providers/sql/snowflake/rows";
import { SNOWFLAKE_STATEMENT_SENTENCES } from "@/lib/db/providers/sql/snowflake/statements";

const PAT = "pat-sentinel-0123456789";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJYIn0.c2lnbmF0dXJl";
const UUID = "019c06a4-0000-df4f-0000-00100006589e";
const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

function context(overrides: Partial<SnowflakeFailureContext> = {}): SnowflakeFailureContext {
  return {
    host: "myorg-myaccount.snowflakecomputing.com",
    user: "studio_svc",
    role: "STUDIO_RO",
    authMethod: "keypair",
    accountClaim: "MYORG-MYACCOUNT",
    userClaim: "STUDIO_SVC",
    fingerprint: "SHA256:abc=",
    fingerprintHex8: "0a1b2c3d",
    publicKeyBody: "MIIBIjANBgkq",
    secretForms: secretForms([PAT, JWT]),
    operativeKeyword: "SELECT",
    attempts: 1,
    timeoutS: 60,
    deadlineBound: "query-timeout",
    submitAccepted: false,
    ...overrides,
  };
}
const failure = (overrides: Partial<SnowflakeFailure>): SnowflakeFailure => ({
  status: 422,
  code: null,
  sqlState: null,
  message: null,
  request: "submit",
  ...overrides,
});

const KEY_PAIR_WITH_UUID =
  "Snowflake refused the key pair (JWT token is invalid, [019c06a4-0000-df4f-0000-00100006589e]) for MYORG-MYACCOUNT.STUDIO_SVC: no user has this login name, or the key whose fingerprint is SHA256:abc= is not registered on it. Check User; an administrator registers the key with ALTER USER <name> ADD KEY PAIR, where <name> is the user's NAME from SHOW USERS, and Test connection shows the full statement to copy. If the key is registered, check the account and this computer's clock; an administrator can see the exact cause with SELECT SYSTEM$GET_LOGIN_FAILURE_DETAILS('019c06a4-0000-df4f-0000-00100006589e').";
const KEY_PAIR_WITHOUT_UUID =
  "Snowflake refused the key pair (JWT token is invalid) for MYORG-MYACCOUNT.STUDIO_SVC: no user has this login name, or the key whose fingerprint is SHA256:abc= is not registered on it. Check User; an administrator registers the key with ALTER USER <name> ADD KEY PAIR, where <name> is the user's NAME from SHOW USERS, and Test connection shows the full statement to copy. If the key is registered, check the account and this computer's clock.";
const FIX = "ALTER USER <name> ADD KEY PAIR libredb_studio_0a1b2c3d PUBLIC_KEY = 'MIIBIjANBgkq'";

/** Splits a statement on `;` outside double-quoted identifiers and single-quoted strings. */
function statements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ";") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.filter((part) => part.trim() !== "");
}

describe("failureError: every row of the error table", () => {
  const SERVER = "SQL compilation error: Object 'T' does not exist or not authorized.";
  const cases: readonly {
    readonly name: string;
    readonly failure: SnowflakeFailure;
    readonly context?: Partial<SnowflakeFailureContext>;
    readonly category: SnowflakeErrorCategory;
    readonly house: new (...args: never[]) => DatabaseError;
    readonly sentence: string;
  }[] = [
    {
      name: "role refused, 390189",
      failure: failure({
        status: 401,
        code: "390189",
        message: "Role 'X' specified in the connect string does not exist",
      }),
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_RO", "studio_svc", "STUDIO_RO", "studio_svc"),
    },
    {
      name: "role refused, 3013",
      failure: failure({ status: 422, code: "3013", message: "role not granted" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake refused role STUDIO_RO for user studio_svc: the role does not exist, it is not granted to this user, or the key pair or access token is restricted to another role. Check the Role field; an administrator grants it with GRANT ROLE STUDIO_RO TO USER studio_svc.",
    },
    {
      // The trial's answer to a role the credentials may not use: HTTP 400 on the submit, no SQLSTATE.
      name: "role refused, 390186 at HTTP 400 on the submit",
      failure: failure({
        status: 400,
        code: "390186",
        sqlState: null,
        message:
          "Role 'STUDIO_NOWH' specified in the connect string is not granted to this user, or is not permitted for the credentials being used. Contact your local system administrator, or attempt to login with another role, e.g. PUBLIC.",
        request: "submit",
      }),
      context: { role: "STUDIO_NOWH" },
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_NOWH", "studio_svc", "STUDIO_NOWH", "studio_svc"),
    },
    {
      // F's live answer to a token restricted to STUDIO_RO with Role STUDIO_RW, a role the user also holds (SF-017).
      name: "role not permitted for the token, 390186 under token sign-in: no GRANT advice",
      failure: failure({
        status: 400,
        code: "390186",
        message:
          "Role 'STUDIO_RW' specified in the connect string is not granted to this user, or is not permitted for the credentials being used.",
        request: "submit",
      }),
      context: { role: "STUDIO_RW", user: "studio_pat", authMethod: "pat" },
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake refused role STUDIO_RW for this access token: the token may be restricted to another role, since a token generated with a role restriction signs in only as that role, or role STUDIO_RW is not granted to user studio_pat. Set Role to the token's role, which SHOW USER PROGRAMMATIC ACCESS TOKENS lists under role_restriction, or use a token restricted to STUDIO_RW.",
    },
    {
      name: "role refused, 390189 under token sign-in keeps the shared sentence",
      failure: failure({ status: 401, code: "390189", message: "Role 'X' does not exist or not authorized" }),
      context: { authMethod: "pat" },
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_RO", "studio_svc", "STUDIO_RO", "studio_svc"),
    },
    {
      name: "key pair refused, 390144",
      failure: failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      category: "auth",
      house: AuthenticationError,
      sentence: KEY_PAIR_WITH_UUID,
    },
    {
      name: "token refused under a PAT",
      failure: failure({ status: 401, code: "390303", message: "Invalid OAuth access token." }),
      context: { authMethod: "pat", fingerprint: null, fingerprintHex8: null, publicKeyBody: null },
      category: "auth",
      house: AuthenticationError,
      sentence: SNOWFLAKE_ERROR_SENTENCES.patRefused,
    },
    {
      name: "token refused by PAT_INVALID",
      failure: failure({ status: 401, code: "PAT_INVALID", message: "x" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake did not accept the access token: check that it is complete and has not expired or been revoked. A token also signs in only for a user under a network policy that allows the public address Studio connects from, which on a laptop changes with the network, or under an authentication policy that sets PAT_POLICY NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED. Key-pair sign-in avoids the network-policy requirement.",
    },
    {
      name: "API disabled or network policy, 403",
      failure: failure({ status: 403, message: "Forbidden" }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake refused the request (403): the SQL API may not be enabled for this account, or a network policy blocks the address Studio connects from.",
    },
    {
      // The trial's answer to SYSTEM$WAIT(610) under a 700 s timeout on a warehouse whose timeout is 600 s.
      name: "Snowflake's 408, ended at a lower warehouse timeout",
      failure: failure({
        status: 408,
        code: "000630",
        sqlState: "57014",
        message: "Statement reached its statement or warehouse timeout of 600 second(s) and was canceled.",
        request: "status",
      }),
      context: { timeoutS: 700, submitAccepted: true },
      category: "query",
      house: QueryError,
      sentence:
        "Snowflake ended this statement at a timeout and cancelled it: the connection's query timeout of 700 s, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account. Snowflake applies the lowest of these, so raising Query Timeout (ms) on the connection cannot lengthen a statement past the others.",
    },
    {
      name: "Snowflake's 408 on a Studio read bounded by its own 30 s",
      failure: failure({ status: 408, code: "000630", sqlState: "57014", request: "status" }),
      context: { timeoutS: 30, deadlineBound: "surface" },
      category: "query",
      house: QueryError,
      sentence:
        "Snowflake ended this Studio read at a timeout and cancelled it: the 30 s bound Studio keeps for the statements it sends on its own, or a lower STATEMENT_TIMEOUT_IN_SECONDS on the warehouse, the user or the account.",
    },
    {
      name: "rate limit, 429",
      failure: failure({ status: 429, code: "390505" }),
      category: "unavailable",
      house: ConnectionError,
      sentence: "Snowflake is limiting requests from this account (429). Try again in a moment.",
    },
    ...[500, 502, 503, 504].map((status) => ({
      name: `server unavailable, ${status}`,
      failure: failure({ status }),
      context: { attempts: 5 },
      category: "unavailable" as const,
      house: ConnectionError,
      sentence: `Snowflake did not answer this request (HTTP ${status}) after 5 attempts.`,
    })),
    {
      name: "certificate refused by Snowflake, 522",
      failure: failure({ status: 522, message: "Invalid SSL Certificate" }),
      category: "unavailable",
      house: ConnectionError,
      sentence:
        "Snowflake refused the TLS certificate of this request (522). Studio sends no client certificate, so a proxy or gateway between Studio and Snowflake may be presenting one.",
    },
    ...(["000606", "391920"] as const).map((code) => ({
      name: `a warehouse named on the connection that cannot be used, ${code} (SF-016)`,
      failure: failure({ status: 422, code, message: "No active warehouse selected" }),
      context: { warehouse: "D_NOWH" },
      category: "query" as const,
      house: QueryError,
      sentence:
        "Snowflake could not use warehouse D_NOWH for this statement: it does not exist, role STUDIO_RO has no USAGE on it, or its name differs in case. Check Warehouse in the connection settings. Browsing works without a warehouse; queries do not.",
    })),
    {
      name: "headers too large, 431, as the gateway answers a 100,000-character token with a text/plain body",
      failure: failure({ status: 431 }),
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake's gateway refused the request because its headers are too large (431). The access token is the one header Studio fills from a field: paste the token alone.",
    },
    {
      name: "a token Snowflake cannot read, 390146, under token sign-in",
      failure: failure({
        status: 401,
        code: "390146",
        message: "Bearer token is missing in the HTTP request authorization header.",
      }),
      context: { authMethod: "pat" },
      category: "auth",
      house: AuthenticationError,
      sentence:
        "Snowflake found no usable token in the request (390146). Paste the access token alone, without a Bearer prefix or anything around it.",
    },
    {
      name: "a failure with no message and no code",
      failure: failure({ status: 400, message: "" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake refused the request (HTTP 400) and sent no message.",
    },
    {
      name: "a failure with a code and a blank message",
      failure: failure({ status: 422, code: "000123", message: "  " }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake refused the request (HTTP 422, code 000123) and sent no message.",
    },
    {
      name: "result gone, 404",
      failure: failure({ status: 404, request: "status" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake no longer holds this statement's result; run it again.",
    },
    {
      name: "result gone, 404 on a partition",
      failure: failure({ status: 404, request: "partition" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake no longer holds this statement's result; run it again.",
    },
    {
      // Measured 2026-10-13: the load balancer of the wildcard *.snowflakecomputing.com answers a submit for an
      // account it does not have with HTTP 404 and a text/html "File not Found" page.
      name: "account not found, 404 on the submit",
      failure: failure({ status: 404, request: "submit" }),
      category: "unavailable",
      house: ConnectionError,
      sentence: `Snowflake has no account at myorg-myaccount.snowflakecomputing.com (HTTP 404 on the first request). Check the account identifier: an organisation account is written orgname-account_name, with a hyphen after the organisation, and a locator outside AWS Oregon needs its region.`,
    },
    {
      name: "invalid payload, 390142",
      failure: failure({ status: 400, code: "390142", message: "Incoming request does not contain a valid payload." }),
      category: "defect",
      house: DatabaseError,
      sentence: "Snowflake could not read the request Studio sent (390142). This is a Studio defect; please report it.",
    },
    {
      name: "no warehouse, 000606",
      failure: failure({ status: 422, code: "000606", sqlState: "57P03", message: "No active warehouse selected" }),
      category: "query",
      house: QueryError,
      sentence:
        "No warehouse is selected for this connection. Enter one in the connection settings, or ask an administrator to set DEFAULT_WAREHOUSE on the user. Browsing works without one; queries do not.",
    },
    {
      // Measured on the trial: a statement that needs compute under a role that can use no warehouse, with or without
      // a warehouse field in the body.
      name: "no warehouse for the role, 391920",
      failure: failure({
        status: 422,
        code: "391920",
        message:
          "Unable to run the command. You must specify the warehouse to use by either setting the warehouse field in the body of the request or by setting the DEFAULT_NAMESPACE property for the current user.",
      }),
      category: "query",
      house: QueryError,
      sentence:
        "No warehouse is selected for this connection. Enter one in the connection settings, or ask an administrator to set DEFAULT_WAREHOUSE on the user. Browsing works without one; queries do not.",
    },
    {
      name: "object missing or hidden, 002003",
      failure: failure({ status: 422, code: "002003", sqlState: "42S02", message: SERVER }),
      category: "query",
      house: QueryError,
      sentence: `Snowflake says this object does not exist or role STUDIO_RO may not see it. Check the name, the database and schema, and the role; CALL EXPLAIN_PRIVILEGES(statement => '<statement>', missing_only => true) lists what is missing, and an administrator adds for_role => 'STUDIO_RO'. ${SERVER}`,
    },
    {
      name: "insufficient privileges, 003001",
      failure: failure({ status: 422, code: "003001", sqlState: "42501", message: "Insufficient privileges" }),
      category: "query",
      house: QueryError,
      sentence: "Role STUDIO_RO lacks a privilege this statement needs. Insufficient privileges",
    },
    {
      // The trial's answer to USE, and the code Snowflake gives any command its SQL API does not run.
      name: "command the SQL API does not run, 391911",
      failure: failure({
        status: 422,
        code: "391911",
        sqlState: "0A000",
        message: "Command not supported by SQL API: USE",
        request: "status",
      }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake's SQL API does not run this command. Command not supported by SQL API: USE",
    },
    {
      name: "statement failed, 422 with code and SQLSTATE",
      failure: failure({ status: 422, code: "001003", sqlState: "42000", message: "syntax error line 1" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: syntax error line 1 (code 001003, SQLSTATE 42000)",
    },
    {
      name: "statement failed without a SQLSTATE",
      failure: failure({ status: 422, code: "100038", message: "Numeric value 'x' is not recognized" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Numeric value 'x' is not recognized (code 100038)",
    },
    {
      name: "anything else, without a code",
      failure: failure({ status: 400, message: "Bad request" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Bad request",
    },
    {
      name: "anything else, another status with a code",
      failure: failure({ status: 409, code: "123456", message: "Conflict" }),
      category: "query",
      house: QueryError,
      sentence: "Snowflake: Conflict (code 123456)",
    },
  ];

  for (const row of cases) {
    test(row.name, () => {
      const error = failureError(row.failure, context(row.context));
      expect(error).toBeInstanceOf(SnowflakeError);
      expect(error.category).toBe(row.category);
      expect(error.message).toBe(row.sentence);
      const house = toDatabaseError(error, "SELECT 1");
      expect((house as object).constructor).toBe(row.house);
      expect((house as DatabaseError).provider).toBe(SNOWFLAKE);
      expect((house as DatabaseError).message).toBe(row.sentence);
    });
  }

  test("the role mismatch sentence", () => {
    expect(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("PUBLIC", "STUDIO_RO")).toBe(
      "Snowflake ran this connection as role PUBLIC, not STUDIO_RO. Check the Role field; a role-restricted key or token signs in only as its own role.",
    );
  });

  test("the fixed sentences other modules raise", () => {
    expect(SNOWFLAKE_ERROR_SENTENCES.slotsBusy(30)).toBe(
      "Studio's Snowflake statement slots stayed busy for 30 seconds, so nothing was sent. Try again when a running statement finishes.",
    );
    expect(SNOWFLAKE_ERROR_SENTENCES.cancelled).toBe("The query was cancelled.");
  });
});

describe("failureError: the key-pair refusal", () => {
  test("the sentence without a uuid drops the parenthesis' id and the last clause", () => {
    const error = failureError(failure({ status: 401, code: "390144", message: "JWT token is invalid." }), context());
    expect(error.message).toBe(KEY_PAIR_WITHOUT_UUID);
    expect(error.fixStatement).toBe(FIX);
  });

  test("the sentence holds no public key body and stays short; the statement holds it once (SF-027)", () => {
    const body = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA".repeat(9);
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      context({ publicKeyBody: body }),
    );
    expect(error.message).not.toContain(body.slice(0, 40));
    expect(error.message.length).toBeLessThan(700);
    expect(error.fixStatement?.split(body).length).toBe(2);
  });

  test("the fix statement is the administrator's registration, carried onto the AuthenticationError", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      context(),
    );
    expect(error.fixStatement).toBe(FIX);
    const house = toDatabaseError(error);
    expect(house).toBeInstanceOf(AuthenticationError);
    expect((house as AuthenticationError).fixStatement).toBe(FIX);
  });

  test("an upper-case uuid is accepted, and the last bracketed group is the one read", () => {
    const upper = UUID.toUpperCase();
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT [not-this] token is invalid. [${upper}]` }),
      context(),
    );
    expect(error.message).toContain(`SYSTEM$GET_LOGIN_FAILURE_DETAILS('${upper}')`);
    expect(error.message).toContain(`(JWT token is invalid, [${upper}])`);
  });

  test("a hostile bracketed id leaves the login-failure clause out", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: "JWT token is invalid. [x'); DROP USER y; --]" }),
      context(),
    );
    expect(error.message).not.toContain("SYSTEM$GET_LOGIN_FAILURE_DETAILS");
    expect(error.message).not.toContain("DROP USER");
    expect(error.message).toBe(KEY_PAIR_WITHOUT_UUID);
  });

  test("a key-pair context without its key is a defect, never a sentence with holes", () => {
    const error = failureError(
      failure({ status: 401, code: "390144", message: `JWT token is invalid. [${UUID}]` }),
      context({ fingerprintHex8: null }),
    );
    expect(error.category).toBe("defect");
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.keyMissing);
    expect(error.fixStatement).toBeUndefined();
  });

  test("a 401 after the submit was accepted, on a status, partition or cancel request, is the mid-run sentence", () => {
    for (const request of ["status", "partition", "cancel"] as const) {
      const error = failureError(failure({ status: 401, code: "390144", request }), context({ submitAccepted: true }));
      expect(error.category).toBe("auth");
      expect(error.message).toBe(
        "Snowflake stopped accepting Studio's key-pair token while this statement ran (390144). The statement may still be running; Studio could not read or cancel it.",
      );
      expect(error.fixStatement).toBeUndefined();
      const pat = failureError(
        failure({ status: 401, request }),
        context({
          submitAccepted: true,
          authMethod: "pat",
          fingerprint: null,
          fingerprintHex8: null,
          publicKeyBody: null,
        }),
      );
      expect(pat.message).toBe(SNOWFLAKE_ERROR_SENTENCES.patRefused);
    }
  });

  test("the mid-run sentence names HTTP 401 without a code, and the submit itself is never mid-run", () => {
    expect(
      failureError(failure({ status: 401, request: "partition" }), context({ submitAccepted: true })).message,
    ).toBe(SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("HTTP 401"));
    expect(
      failureError(
        failure({ status: 401, request: "submit", message: "JWT token is invalid." }),
        context({ submitAccepted: true }),
      ).message,
    ).toBe(KEY_PAIR_WITHOUT_UUID);
    expect(failureError(failure({ status: 401, request: "status" }), context()).message).toBe(KEY_PAIR_WITHOUT_UUID);
  });
});

describe("failureError: the network-policy refusals", () => {
  const PAT_CONTEXT: Partial<SnowflakeFailureContext> = {
    authMethod: "pat",
    fingerprint: null,
    fingerprintHex8: null,
    publicKeyBody: null,
  };
  // The trial's answers, 2026-10-13: HTTP 401 on the submit for both sign-in methods.
  const ADDRESS = "203.0.113.7";
  const notAllowed = (request: SnowflakeFailure["request"]) =>
    failure({
      status: 401,
      code: "390422",
      message: `Incoming request with IP/Token ${ADDRESS} is not allowed to access Snowflake. Contact your account administrator.`,
      request,
    });
  const required = (request: SnowflakeFailure["request"]) =>
    failure({ status: 401, code: "390432", message: "Fail : Network policy is required.", request });

  test("the sentences", () => {
    expect(SNOWFLAKE_ERROR_SENTENCES.networkPolicyRefused).toBe(
      "A network policy on the Snowflake account or on this user does not allow the address Studio connects from. An administrator adds that address to the policy's allowed list.",
    );
    expect(SNOWFLAKE_ERROR_SENTENCES.networkPolicyRequired).toBe(
      "Snowflake signs in with an access token only for a user under a network policy, and this user has none. An administrator either attaches a network policy that allows the address Studio connects from, or sets an authentication policy with PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED).",
    );
  });

  for (const [method, overrides] of [
    ["key pair", {}],
    ["token", PAT_CONTEXT],
  ] as const) {
    test(`390422 for a ${method}, at connect and mid-run, names the network policy and never the address`, () => {
      for (const [request, submitAccepted] of [
        ["submit", false],
        ["status", true],
        ["partition", true],
      ] as const) {
        const error = failureError(notAllowed(request), context({ ...overrides, submitAccepted }));
        expect(error.category).toBe("auth");
        expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.networkPolicyRefused);
        expect(error.message).not.toContain(ADDRESS);
        expect(error.message).not.toContain("IP/Token");
        expect(error.fixStatement).toBeUndefined();
        expect(toDatabaseError(error)).toBeInstanceOf(AuthenticationError);
      }
    });

    test(`390432 for a ${method}, at connect and mid-run, names the missing network policy`, () => {
      for (const [request, submitAccepted] of [
        ["submit", false],
        ["status", true],
      ] as const) {
        const error = failureError(required(request), context({ ...overrides, submitAccepted }));
        expect(error.category).toBe("auth");
        expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.networkPolicyRequired);
        expect(error.fixStatement).toBeUndefined();
      }
    });
  }
});

describe("failureError: secrets and the server-text cut", () => {
  const sentinels = [PAT, ...JWT.split(".")];
  const hostile = [
    `bad token ${PAT}`,
    `JWT token is invalid: ${JWT} [${UUID}]`,
    `segment only ${JWT.split(".")[1]}`,
    `base64 ${Buffer.from(PAT).toString("base64")}`,
  ];

  test("a 401 and a 422 whose messages echo the PAT or the JWT leave no sentinel in the error", () => {
    for (const message of hostile) {
      for (const status of [401, 422]) {
        for (const authMethod of ["keypair", "pat"] as const) {
          const error = failureError(failure({ status, code: "390144", message }), context({ authMethod }));
          const house = toDatabaseError(error);
          for (const text of [
            error.message,
            String(error),
            String(house),
            JSON.stringify(house),
            error.fixStatement ?? "",
          ]) {
            for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
            expect(text).not.toContain("pat-sentinel");
          }
        }
      }
    }
  });

  test("a code or SQLSTATE that echoes a secret, or is not code-shaped, is left out of the sentence", () => {
    expect(failureError(failure({ status: 422, code: PAT, sqlState: "42000", message: "m" }), context()).message).toBe(
      "Snowflake: m",
    );
    expect(
      failureError(failure({ status: 422, code: "1", sqlState: "a b; DROP", message: "m" }), context()).message,
    ).toBe("Snowflake: m (code 1)");
    expect(
      failureError(
        failure({ status: 401, code: JWT.split(".")[2], request: "cancel" }),
        context({ submitAccepted: true }),
      ).message,
    ).toBe(SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("HTTP 401"));
  });

  test("a 10,000-character server message is cut to the bound in the sentence", () => {
    const long = "x".repeat(10_000);
    const error = failureError(failure({ status: 422, code: "100038", message: long }), context());
    const part = error.message.slice("Snowflake: ".length, error.message.indexOf(" (code"));
    expect(part.length).toBeLessThanOrEqual(SNOWFLAKE_SERVER_TEXT_MAX_CHARS);
    expect(part).toBe("x".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS));
  });

  test("serverMessage withholds a secret past the cut instead of showing the prefix", () => {
    const forms = secretForms([PAT]);
    const text = `${"y".repeat(3_000)} ${PAT}`;
    expect(serverMessage(text, forms)).toBe(WITHHELD);
    expect(serverMessage("short", forms)).toBe("short");
    expect(serverMessage("z".repeat(2_500), forms)).toHaveLength(SNOWFLAKE_SERVER_TEXT_MAX_CHARS);
  });

  test("the cut never ends on half of a surrogate pair", () => {
    const text = `${"a".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS - 1)}\u{1F600}tail`;
    const cut = serverMessage(text, []);
    expect(cut).toBe("a".repeat(SNOWFLAKE_SERVER_TEXT_MAX_CHARS - 1));
  });
});

describe("failureError: the Scripting hint", () => {
  const syntax = (operativeKeyword: string | null, code: string) =>
    failureError(
      failure({
        status: 422,
        code,
        sqlState: "42000",
        message: "syntax error line 1 at position 0 unexpected 'BEGIN'.",
      }),
      context({ operativeKeyword }),
    ).message;

  test("a BEGIN or DECLARE unit that fails with the syntax error code gets the hint appended", () => {
    const base = "Snowflake: syntax error line 1 at position 0 unexpected 'BEGIN'. (code 001003, SQLSTATE 42000)";
    expect(syntax("BEGIN", "001003")).toBe(`${base} ${SNOWFLAKE_ERROR_SENTENCES.scriptingHint}`);
    expect(syntax("DECLARE", "001003")).toBe(`${base} ${SNOWFLAKE_ERROR_SENTENCES.scriptingHint}`);
    expect(SNOWFLAKE_ERROR_SENTENCES.scriptingHint).toBe(
      "A Snowflake Scripting block runs through the SQL API only inside EXECUTE IMMEDIATE $$ ... $$.",
    );
  });

  test("another keyword, another code or no keyword gets no hint", () => {
    expect(syntax("SELECT", "001003")).not.toContain("Scripting");
    expect(syntax("BEGIN", "002003")).not.toContain("Scripting");
    expect(syntax("BEGIN", "100038")).not.toContain("Scripting");
    expect(syntax(null, "001003")).not.toContain("Scripting");
  });
});

describe("copyable identifiers", () => {
  test("a copyable identifier: bare as is, quoted as typed when well formed, anything else re-quoted", () => {
    /** The role as the role-refused GRANT names it, the one statement that prints an identifier the user typed. */
    const named = (role: string): string => {
      const error = failureError(failure({ status: 401, code: "390189" }), context({ role, user: "studio_svc" }));
      const lead = "an administrator grants it with GRANT ROLE ";
      const statement = error.message.slice(error.message.lastIndexOf(lead) + lead.length, -1);
      return statement.slice(0, statement.lastIndexOf(" TO USER "));
    };
    expect(named("studio_svc")).toBe("studio_svc");
    expect(named("A$1")).toBe("A$1");
    expect(named('a"; GRANT ROLE ACCOUNTADMIN TO USER b; --')).toBe('"a""; GRANT ROLE ACCOUNTADMIN TO USER b; --"');
    expect(named('r" x')).toBe('"r"" x"');
    expect(named('"Mixed Role"')).toBe('"Mixed Role"');
    expect(named('"a""b"')).toBe('"a""b"');
    expect(named('"broken')).toBe('"""broken"');
    expect(named("1st")).toBe('"1st"');
    expect(named("user@example.com")).toBe('"user@example.com"');
  });

  test("the role-refused GRANT is one statement naming exactly the hostile user and role", () => {
    const user = 'a"; GRANT ROLE ACCOUNTADMIN TO USER b; --';
    const role = 'r" x';
    const error = failureError(failure({ status: 401, code: "390189" }), context({ user, role }));
    const lead = "an administrator grants it with ";
    const statement = error.message.slice(error.message.lastIndexOf(lead) + lead.length, -1);
    expect(statements(statement)).toHaveLength(1);
    expect(statement).toBe(`GRANT ROLE "r"" x" TO USER "a""; GRANT ROLE ACCOUNTADMIN TO USER b; --"`);
  });

  test("the object-missing for_role literal doubles a single quote, so the CALL stays one statement", () => {
    const error = failureError(failure({ status: 422, code: "002003", message: "gone" }), context({ role: "o'brien" }));
    expect(error.message).toContain("for_role => 'o''brien'.");
    const call = error.message.slice(error.message.indexOf("CALL "), error.message.indexOf("'. ") + 2);
    expect(statements(call)).toHaveLength(1);
  });

  test("the object-missing for_role literal doubles a backslash, so a role ending in one stays a closed literal", () => {
    const error = failureError(failure({ status: 422, code: "002003", message: "gone" }), context({ role: "ops\\" }));
    expect(error.message).toContain("for_role => 'ops\\\\'.");
  });

  test("the key name form", () => {
    expect(keyPairName("0a1b2c3d")).toBe("libredb_studio_0a1b2c3d");
  });
});

describe("transportFailureError", () => {
  const host = "myorg-myaccount.snowflakecomputing.com";

  test("an unreachable host, a DNS failure and a refused connection name the host", () => {
    for (const error of [
      new TransportError("unreachable", "No answer from x:443 after 10 s"),
      new TransportError("network", "The request failed before a complete response arrived (ENOTFOUND)"),
      new TransportError("network", "The request failed before a complete response arrived (EAI_AGAIN)"),
      new TransportError("network", "The request failed before a complete response arrived (ECONNREFUSED)"),
      new TransportError("network", "The request failed before a complete response arrived (ConnectionRefused)"),
    ]) {
      const mapped = transportFailureError(error, host);
      expect(mapped).toBeInstanceOf(SnowflakeError);
      expect((mapped as SnowflakeError).category).toBe("unavailable");
      expect((mapped as SnowflakeError).message).toBe(
        "Studio could not reach myorg-myaccount.snowflakecomputing.com. Check the account identifier; a locator outside AWS Oregon needs its region.",
      );
    }
  });

  test("a TLS failure is the certificate mismatch sentence", () => {
    const mapped = transportFailureError(
      new TransportError("tls", "The TLS connection failed (ERR_TLS_CERT_ALTNAME_INVALID)"),
      host,
    );
    expect((mapped as SnowflakeError).category).toBe("unavailable");
    expect((mapped as SnowflakeError).message).toBe(
      "The certificate myorg-myaccount.snowflakecomputing.com presented does not match its name. Check the account identifier, including the region for a locator.",
    );
  });

  test("anything else is returned unchanged", () => {
    for (const error of [
      new TransportError("aborted", "The request was cancelled"),
      new TransportError("network", "The server ended the response before it was complete", { truncated: true }),
      new TransportError("network", "The request failed before a complete response arrived (ECONNRESET)"),
      new TransportError("timeout", "The request did not finish within its time limit"),
      new QueryError("x"),
      new Error("y"),
      "z",
    ]) {
      expect(transportFailureError(error, host)).toBe(error);
    }
  });
});

describe("toDatabaseError", () => {
  test("each category becomes its house class with Snowflake as provider", () => {
    const expected: Record<SnowflakeErrorCategory, new (...args: never[]) => DatabaseError> = {
      config: DatabaseConfigError,
      auth: AuthenticationError,
      query: QueryError,
      cancelled: QueryCancelledError,
      unavailable: ConnectionError,
      defect: DatabaseError,
    };
    for (const [category, house] of Object.entries(expected) as [SnowflakeErrorCategory, typeof DatabaseError][]) {
      const mapped = toDatabaseError(new SnowflakeError(category, `m ${category}`), "SELECT 1") as DatabaseError;
      expect(mapped.constructor).toBe(house);
      expect(mapped.message).toBe(`m ${category}`);
      expect(mapped.provider).toBe(SNOWFLAKE);
    }
  });

  test("a query and a cancel keep the statement; an auth error without a fix statement has none", () => {
    expect((toDatabaseError(new SnowflakeError("query", "q"), "SELECT 2") as QueryError).query).toBe("SELECT 2");
    expect((toDatabaseError(new SnowflakeError("cancelled", "c"), "SELECT 3") as QueryCancelledError).query).toBe(
      "SELECT 3",
    );
    expect(Object.hasOwn(toDatabaseError(new SnowflakeError("auth", "a")) as object, "fixStatement")).toBe(false);
  });

  test("a non-Snowflake error is returned unchanged", () => {
    const e = new Error("x");
    expect(toDatabaseError(e)).toBe(e);
    const house = new QueryError("already mapped");
    expect(toDatabaseError(house)).toBe(house);
  });

  test("SnowflakeError keeps its category and fix statement, and names itself", () => {
    const error = new SnowflakeError("auth", "m", "fix");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SnowflakeError");
    expect(error.category).toBe("auth");
    expect(error.fixStatement).toBe("fix");
    expect(Object.hasOwn(new SnowflakeError("auth", "m"), "fixStatement")).toBe(false);
  });
});

/** The key-pair refusal with placeholders, so the registration statements are the builder's own. */
const KEY_PAIR_REFUSED = SNOWFLAKE_ERROR_SENTENCES.keyPairRefused({
  uuid: "<uuid>",
  account: "<ACCOUNT>",
  user: "<USER>",
  fingerprint: "SHA256:<fp>",
});
/** The statement the refusal carries to copy, with placeholders. */
const KEY_PAIR_FIX = administratorStatement("<fp8>", "<body>");

/** Every sentence of each exported record, each template filled with placeholders. */
const QUOTED: Readonly<Record<string, { readonly keys: readonly string[]; readonly quotes: readonly string[] }>> = {
  SNOWFLAKE_STATEMENT_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_STATEMENT_SENTENCES),
    quotes: [
      SNOWFLAKE_STATEMENT_SENTENCES.useRefused,
      SNOWFLAKE_STATEMENT_SENTENCES.settingNotCarried,
      SNOWFLAKE_STATEMENT_SENTENCES.temporaryNotCarried,
      SNOWFLAKE_STATEMENT_SENTENCES.noLastQuery,
      SNOWFLAKE_STATEMENT_SENTENCES.noTransactions,
      SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("<roles>", "<role>"),
      SNOWFLAKE_STATEMENT_SENTENCES.unresolvedDatabase("<db>", "<role>"),
      SNOWFLAKE_STATEMENT_SENTENCES.unresolvedSchema("<schema>", "<role>"),
      SNOWFLAKE_STATEMENT_SENTENCES.unresolvedWarehouse("<wh>", "<role>"),
      SNOWFLAKE_STATEMENT_SENTENCES.badHandle,
      SNOWFLAKE_STATEMENT_SENTENCES.foreignLink,
    ],
  },
  SNOWFLAKE_ROWS_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_ROWS_SENTENCES),
    quotes: [
      SNOWFLAKE_ROWS_SENTENCES.firstTooLarge,
      SNOWFLAKE_ROWS_SENTENCES.unreadable,
      SNOWFLAKE_ROWS_SENTENCES.encoding("<encoding>"),
      SNOWFLAKE_ROWS_SENTENCES.nonString("<column>"),
      SNOWFLAKE_ROWS_SENTENCES.byteCut(1234).replace("1,234", "<numRows>"),
      SNOWFLAKE_ROWS_SENTENCES.firstRowCut,
      SNOWFLAKE_ROWS_SENTENCES.rowCut,
      SNOWFLAKE_ROWS_SENTENCES.snowflakeCut,
    ],
  },
  SNOWFLAKE_ERROR_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_ERROR_SENTENCES),
    quotes: [
      KEY_PAIR_REFUSED,
      SNOWFLAKE_ERROR_SENTENCES.keyPairMidRun("<code>"),
      SNOWFLAKE_ERROR_SENTENCES.keyMissing,
      SNOWFLAKE_ERROR_SENTENCES.patRefused,
      SNOWFLAKE_ERROR_SENTENCES.networkPolicyRefused,
      SNOWFLAKE_ERROR_SENTENCES.networkPolicyRequired,
      SNOWFLAKE_ERROR_SENTENCES.roleRefused("<role>", "<user>", "<role>", "<user>"),
      SNOWFLAKE_ERROR_SENTENCES.tokenRoleRefused("<role>", "<user>"),
      SNOWFLAKE_ERROR_SENTENCES.roleMismatch("<r>", "<role>"),
      SNOWFLAKE_ERROR_SENTENCES.tokenUserMismatch("<u>", "<user>"),
      SNOWFLAKE_ERROR_SENTENCES.noWarehouse,
      SNOWFLAKE_ERROR_SENTENCES.warehouseUnusable("<wh>", "<role>"),
      SNOWFLAKE_ERROR_SENTENCES.objectMissing("<role>", "'<role>'", ""),
      SNOWFLAKE_ERROR_SENTENCES.privileges("<role>", ""),
      SNOWFLAKE_ERROR_SENTENCES.forbidden,
      SNOWFLAKE_ERROR_SENTENCES.headersTooLarge,
      SNOWFLAKE_ERROR_SENTENCES.tokenMissing,
      SNOWFLAKE_ERROR_SENTENCES.noMessage("<n>" as unknown as number, "<code>"),
      SNOWFLAKE_ERROR_SENTENCES.statementFailed("<message>", "<code>", "<sqlstate>"),
      SNOWFLAKE_ERROR_SENTENCES.deadline("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.surfaceDeadline(30),
      SNOWFLAKE_ERROR_SENTENCES.statementTimeout("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.surfaceStatementTimeout(30),
      SNOWFLAKE_ERROR_SENTENCES.unsupportedCommand(""),
      SNOWFLAKE_ERROR_SENTENCES.rateLimited,
      SNOWFLAKE_ERROR_SENTENCES.unavailable("<n>" as unknown as number, "<attempts>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.tlsRefused,
      SNOWFLAKE_ERROR_SENTENCES.resultGone,
      SNOWFLAKE_ERROR_SENTENCES.accountNotFound("<host>"),
      SNOWFLAKE_ERROR_SENTENCES.invalidPayload,
      SNOWFLAKE_ERROR_SENTENCES.connectDeadline("<host>", "<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.unreachable("<host>"),
      SNOWFLAKE_ERROR_SENTENCES.certMismatch("<host>"),
      SNOWFLAKE_ERROR_SENTENCES.slotsBusy("<n>" as unknown as number),
      SNOWFLAKE_ERROR_SENTENCES.scriptingHint,
      SNOWFLAKE_ERROR_SENTENCES.cancelled,
    ],
  },
  SNOWFLAKE_KEY_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_KEY_SENTENCES),
    quotes: [
      SNOWFLAKE_KEY_SENTENCES.keyEmpty,
      SNOWFLAKE_KEY_SENTENCES.tooLarge,
      SNOWFLAKE_KEY_SENTENCES.publicKey,
      SNOWFLAKE_KEY_SENTENCES.notPem,
      SNOWFLAKE_KEY_SENTENCES.manyBlocks,
      SNOWFLAKE_KEY_SENTENCES.truncated,
      SNOWFLAKE_KEY_SENTENCES.certificate,
      SNOWFLAKE_KEY_SENTENCES.otherBlock,
      SNOWFLAKE_KEY_SENTENCES.kdfCost,
      SNOWFLAKE_KEY_SENTENCES.scheme,
      SNOWFLAKE_KEY_SENTENCES.needsPassphrase,
      SNOWFLAKE_KEY_SENTENCES.wrongPassphrase,
      SNOWFLAKE_KEY_SENTENCES.unreadable,
      SNOWFLAKE_KEY_SENTENCES.notRsa("ec"),
      SNOWFLAKE_KEY_SENTENCES.short,
      SNOWFLAKE_KEY_SENTENCES.long("<bits>" as unknown as number),
    ],
  },
  SNOWFLAKE_TOKEN_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_TOKEN_SENTENCES),
    quotes: Object.values(SNOWFLAKE_TOKEN_SENTENCES),
  },
  SNOWFLAKE_FIELD_SENTENCES: {
    keys: Object.keys(SNOWFLAKE_FIELD_SENTENCES),
    quotes: Object.values(SNOWFLAKE_FIELD_SENTENCES),
  },
};

describe("the exported sentence records and the key-pair registration", () => {
  for (const [record, { keys, quotes }] of Object.entries(QUOTED)) {
    test(`every key of ${record} has a sentence`, () => {
      expect(quotes.length).toBe(keys.length);
    });
  }

  test("the key-pair refusal carries the administrator's statement without the key body, and the self-service form", () => {
    const admin = /^(ALTER USER <name> ADD KEY PAIR \S+ PUBLIC_KEY = )'<body>'$/.exec(KEY_PAIR_FIX);
    expect(admin).not.toBeNull();
    expect(KEY_PAIR_REFUSED).not.toContain("<body>");
    expect(KEY_PAIR_REFUSED).toContain("ALTER USER <name> ADD KEY PAIR, where <name> is the user's NAME");
  });
});
