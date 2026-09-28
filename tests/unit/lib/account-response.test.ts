import { describe, expect, test } from "bun:test";
import { accountFailureResponse } from "@/lib/api/account-response";
import { AuthConfigError } from "@/lib/auth-errors";
import { AccountError } from "@/lib/local-accounts";

describe("accountFailureResponse", () => {
  test("keeps an account error's status", async () => {
    const res = accountFailureResponse(new AccountError(409, "nope"), "POST /api/admin/accounts");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  test("a missing code answers 400 with codeRequired", async () => {
    const res = accountFailureResponse(new AccountError(400, "x", { codeRequired: true }), "POST /api/auth/passkey");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "x", codeRequired: true });
    const plain = accountFailureResponse(new AccountError(400, "x"), "POST /api/auth/passkey");
    expect(await plain.json()).not.toHaveProperty("codeRequired");
  });

  test("turns a missing admin password into the login 503", async () => {
    const res = accountFailureResponse(new AuthConfigError("set ADMIN_PASSWORD"), "GET /api/admin/accounts");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "set ADMIN_PASSWORD" });
  });

  test("anything else is the generic 500", async () => {
    const res = accountFailureResponse(new Error("boom"), "GET /api/admin/accounts");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("boom");
  });
});
