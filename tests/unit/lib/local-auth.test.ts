import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuthConfigError, getAuthUsers } from "@/lib/local-auth";

describe("local-auth getAuthUsers()", () => {
  let origAdminEmail: string | undefined;
  let origAdminPassword: string | undefined;
  let origUserEmail: string | undefined;
  let origUserPassword: string | undefined;

  beforeEach(() => {
    origAdminEmail = process.env.ADMIN_EMAIL;
    origAdminPassword = process.env.ADMIN_PASSWORD;
    origUserEmail = process.env.USER_EMAIL;
    origUserPassword = process.env.USER_PASSWORD;
  });

  afterEach(() => {
    restore("ADMIN_EMAIL", origAdminEmail);
    restore("ADMIN_PASSWORD", origAdminPassword);
    restore("USER_EMAIL", origUserEmail);
    restore("USER_PASSWORD", origUserPassword);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  test("throws AuthConfigError when ADMIN_PASSWORD is missing", () => {
    delete process.env.ADMIN_PASSWORD;
    expect(() => getAuthUsers()).toThrow(AuthConfigError);
  });

  test("throws AuthConfigError when ADMIN_PASSWORD is empty", () => {
    process.env.ADMIN_PASSWORD = "";
    expect(() => getAuthUsers()).toThrow(AuthConfigError);
  });

  test("returns admin-only when USER_PASSWORD is not set", () => {
    process.env.ADMIN_PASSWORD = "admin-secret";
    delete process.env.USER_PASSWORD;

    const users = getAuthUsers();

    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: "admin", password: "admin-secret" });
  });

  test("includes the optional user account only when USER_PASSWORD is set", () => {
    process.env.ADMIN_PASSWORD = "admin-secret";
    process.env.USER_PASSWORD = "user-secret";

    const users = getAuthUsers();

    expect(users).toHaveLength(2);
    expect(users.find((u) => u.role === "user")).toMatchObject({ password: "user-secret" });
  });

  test("defaults emails when not provided", () => {
    process.env.ADMIN_PASSWORD = "admin-secret";
    process.env.USER_PASSWORD = "user-secret";
    delete process.env.ADMIN_EMAIL;
    delete process.env.USER_EMAIL;

    const users = getAuthUsers();

    expect(users.find((u) => u.role === "admin")?.email).toBe("admin@libredb.org");
    expect(users.find((u) => u.role === "user")?.email).toBe("user@libredb.org");
  });
});
