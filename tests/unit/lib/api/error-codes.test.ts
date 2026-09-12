import { describe, test, expect } from "bun:test";
import { ApiErrorCode } from "@/lib/api/error-codes";

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
    "TIMEOUT_ERROR",
    "CONNECTION_ERROR",
    "POOL_EXHAUSTED",
    "DATABASE_ERROR",
  ],
  llm: ["LLM_SAFETY", "LLM_AUTH", "LLM_RATE_LIMIT", "LLM_CONFIG", "LLM_UNCONFIGURED", "LLM_STREAM", "LLM_ERROR"],
  rateLimit: ["RATE_LIMITED"],
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

  test("contains the application rate-limit error code", () => {
    expect(ApiErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
  });
});
