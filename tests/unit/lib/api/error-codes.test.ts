import { describe, test, expect } from "bun:test";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { API_CODES } from "@/lib/governance/contract";

/**
 * The groups the source declares, restated here so each one is named by a test.
 *
 * This used to be `expect(Object.keys(ApiErrorCode)).toHaveLength(18)`, which pinned a
 * MAGNITUDE. A magnitude is the wrong thing to assert: adding a code fails the gate
 * with "expected 18, received 19", which says nothing about what was added, and the
 * only way through is to edit the digit - so the guard taught everybody to edit it
 * rather than to think. #789 added a code and then removed it again, hitting that twice.
 *
 * What the count was actually FOR is exhaustiveness: a code added to the source and
 * named by none of the group tests below was invisible, so the groups could drift into
 * covering a subset while every test stayed green. That is the property worth keeping,
 * and it is derived here rather than counted: the union of the groups must equal the
 * declared keys, in both directions. A new code fails the gate by NAME until it is
 * filed under a group, and a code deleted from the source fails it too.
 */
const GROUPS = {
  database: [
    "QUERY_CANCELLED",
    "QUERY_ERROR",
    "CONFIG_ERROR",
    "AUTH_ERROR",
    "PERMISSION_DENIED",
    "TIMEOUT_ERROR",
    "CONNECTION_ERROR",
    "POOL_EXHAUSTED",
    "DATABASE_ERROR",
    "EDIT_PLAN_INVALID",
    "INVENTORY_PAIR_LIMIT",
  ],
  llm: ["LLM_SAFETY", "LLM_AUTH", "LLM_RATE_LIMIT", "LLM_CONFIG", "LLM_UNCONFIGURED", "LLM_STREAM", "LLM_ERROR"],
  rateLimit: ["RATE_LIMITED"],
  session: [
    "AUTH_REQUIRED",
    "WORKSPACE_OWNER_MISMATCH",
    "IDENTITY_PROVIDER_UNAVAILABLE",
    "BEARER_NO_ROLE",
    "BEARER_NO_IDENTITY",
    "ADMIN_REQUIRED",
    "ACCOUNT_STORE_UNAVAILABLE",
  ],
  transaction: ["TRANSACTION_NOT_OWNED"],
  connectionPolicy: ["CUSTOM_CONNECTIONS_DISABLED"],
  governance: [
    "AI_DISABLED",
    "AUDIT_UNAVAILABLE",
    "CONNECTION_NOT_FOUND",
    "GOVERNANCE_UNAVAILABLE",
    "TRANSACTION_CREDENTIAL_CHANGED",
  ],
  generic: ["INTERNAL_ERROR", "NETWORK_ERROR"],
} as const;

describe("ApiErrorCode", () => {
  test("every declared code is filed under exactly one group, and every grouped code is declared", () => {
    const grouped: string[] = Object.values(GROUPS).flat();
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...Object.keys(ApiErrorCode)].sort());
  });

  test("values match keys", () => {
    for (const [key, value] of Object.entries(ApiErrorCode) as [string, string][]) {
      expect(value).toBe(key);
    }
  });

  test("contains all database error codes", () => {
    for (const code of GROUPS.database) expect(ApiErrorCode[code]).toBe(code);
  });

  test("contains all LLM error codes", () => {
    for (const code of GROUPS.llm) expect(ApiErrorCode[code]).toBe(code);
  });

  test("contains generic error codes", () => {
    for (const code of GROUPS.generic) expect(ApiErrorCode[code]).toBe(code);
  });

  test("contains the database's privilege refusal code, distinct from its refused credential's AUTH_ERROR", () => {
    expect(ApiErrorCode.PERMISSION_DENIED).toBe("PERMISSION_DENIED");
    expect(ApiErrorCode.PERMISSION_DENIED).not.toBe(ApiErrorCode.AUTH_ERROR);
  });

  test("contains the session-required code, distinct from a database's AUTH_ERROR", () => {
    expect(ApiErrorCode.AUTH_REQUIRED).toBe("AUTH_REQUIRED");
    expect(ApiErrorCode.AUTH_REQUIRED).not.toBe(ApiErrorCode.AUTH_ERROR);
  });

  test("contains the workspace owner mismatch code, distinct from the session-required code", () => {
    expect(ApiErrorCode.WORKSPACE_OWNER_MISMATCH).toBe("WORKSPACE_OWNER_MISMATCH");
    expect(ApiErrorCode.WORKSPACE_OWNER_MISMATCH).not.toBe(ApiErrorCode.AUTH_REQUIRED);
  });

  test("contains the account store unavailable code, distinct from AUTH_REQUIRED (#1942)", () => {
    expect(ApiErrorCode.ACCOUNT_STORE_UNAVAILABLE).toBe("ACCOUNT_STORE_UNAVAILABLE");
    expect(ApiErrorCode.ACCOUNT_STORE_UNAVAILABLE).not.toBe(ApiErrorCode.AUTH_REQUIRED);
  });

  test("contains the custom-connections refusal code, distinct from a role refusal's AUTH_ERROR", () => {
    expect(ApiErrorCode.CUSTOM_CONNECTIONS_DISABLED).toBe("CUSTOM_CONNECTIONS_DISABLED");
    expect(ApiErrorCode.CUSTOM_CONNECTIONS_DISABLED).not.toBe(ApiErrorCode.AUTH_ERROR);
  });

  test("contains the governance code a data route answers while the snapshot cannot be served", () => {
    for (const code of GROUPS.governance) expect(ApiErrorCode[code]).toBe(code);
    expect(ApiErrorCode.GOVERNANCE_UNAVAILABLE).not.toBe(ApiErrorCode.CONNECTION_ERROR);
  });

  test("contains the governed miss, one code for a connection that does not exist and one not granted", () => {
    expect(ApiErrorCode.CONNECTION_NOT_FOUND).toBe("CONNECTION_NOT_FOUND");
    expect(ApiErrorCode.CONNECTION_NOT_FOUND).not.toBe(ApiErrorCode.AUTH_ERROR);
  });

  test("contains the governed refusal of a transaction whose grant level or credential changed while it was open", () => {
    expect(ApiErrorCode.TRANSACTION_CREDENTIAL_CHANGED).toBe("TRANSACTION_CREDENTIAL_CHANGED");
  });

  test("contains the governed refusal of the AI routes while the runtime setting ai.enabled is false", () => {
    expect(ApiErrorCode.AI_DISABLED).toBe("AI_DISABLED");
    expect(ApiErrorCode.AI_DISABLED).not.toBe(ApiErrorCode.LLM_UNCONFIGURED);
  });

  test("contains the governed refusal of an execution while query events cannot be recorded", () => {
    expect(ApiErrorCode.AUDIT_UNAVAILABLE).toBe("AUDIT_UNAVAILABLE");
    expect(ApiErrorCode.AUDIT_UNAVAILABLE).not.toBe(ApiErrorCode.GOVERNANCE_UNAVAILABLE);
  });

  test("every API code governance contract v1 publishes is declared, in the governance group", () => {
    const declared: readonly string[] = Object.keys(ApiErrorCode);
    const governance: readonly string[] = GROUPS.governance;
    const published = API_CODES.map((entry) => entry.code);
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((code) => !declared.includes(code) || !governance.includes(code))).toEqual([]);
  });

  test("contains the object search's refusal over the inventory pair bound", () => {
    expect(ApiErrorCode.INVENTORY_PAIR_LIMIT).toBe("INVENTORY_PAIR_LIMIT");
  });

  test("contains the application rate-limit error code", () => {
    expect(ApiErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
  });
});
