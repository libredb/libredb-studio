import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuthConfigError } from "@/lib/auth-errors";
import { getAuthUsers } from "@/lib/local-auth";
import { RFC6238_SECRET } from "../../helpers/rfc6238";

describe("local-auth getAuthUsers()", () => {
  let origAdminEmail: string | undefined;
  let origAdminPassword: string | undefined;
  let origUserEmail: string | undefined;
  let origUserPassword: string | undefined;
  let origAdminTotp: string | undefined;
  let origUserTotp: string | undefined;

  /** RFC 6238's Appendix B seed, reused here purely as a known-good base32 string. */
  const VALID_SECRET = RFC6238_SECRET;

  beforeEach(() => {
    origAdminEmail = process.env.ADMIN_EMAIL;
    origAdminPassword = process.env.ADMIN_PASSWORD;
    origUserEmail = process.env.USER_EMAIL;
    origUserPassword = process.env.USER_PASSWORD;
    origAdminTotp = process.env.ADMIN_TOTP_SECRET;
    origUserTotp = process.env.USER_TOTP_SECRET;
    delete process.env.ADMIN_TOTP_SECRET;
    delete process.env.USER_TOTP_SECRET;
  });

  afterEach(() => {
    restore("ADMIN_EMAIL", origAdminEmail);
    restore("ADMIN_PASSWORD", origAdminPassword);
    restore("USER_EMAIL", origUserEmail);
    restore("USER_PASSWORD", origUserPassword);
    restore("ADMIN_TOTP_SECRET", origAdminTotp);
    restore("USER_TOTP_SECRET", origUserTotp);
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

  describe("TOTP secrets", () => {
    beforeEach(() => {
      process.env.ADMIN_PASSWORD = "admin-secret";
    });

    test("leaves both accounts without a second factor when neither variable is set", () => {
      process.env.USER_PASSWORD = "user-secret";

      const users = getAuthUsers();

      expect(users.every((u) => u.totpSecret === undefined)).toBe(true);
    });

    test("attaches ADMIN_TOTP_SECRET to the admin account", () => {
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET;

      expect(getAuthUsers()[0].totpSecret).toBe(VALID_SECRET);
    });

    test("attaches USER_TOTP_SECRET to the user account only", () => {
      process.env.USER_PASSWORD = "user-secret";
      process.env.USER_TOTP_SECRET = VALID_SECRET;

      const users = getAuthUsers();

      expect(users.find((u) => u.role === "user")?.totpSecret).toBe(VALID_SECRET);
      expect(users.find((u) => u.role === "admin")?.totpSecret).toBeUndefined();
    });

    test("protects each account independently", () => {
      process.env.USER_PASSWORD = "user-secret";
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET;

      const users = getAuthUsers();

      expect(users.find((u) => u.role === "admin")?.totpSecret).toBe(VALID_SECRET);
      expect(users.find((u) => u.role === "user")?.totpSecret).toBeUndefined();
    });

    test("trims the surrounding whitespace an env file or secret manager leaves behind", () => {
      process.env.ADMIN_TOTP_SECRET = `  ${VALID_SECRET}\n`;

      expect(getAuthUsers()[0].totpSecret).toBe(VALID_SECRET);
    });

    test("treats an empty value as no second factor, so MFA can be turned off by blanking it", () => {
      process.env.ADMIN_TOTP_SECRET = "   ";

      expect(getAuthUsers()[0].totpSecret).toBeUndefined();
    });

    test("throws AuthConfigError when ADMIN_TOTP_SECRET is not base32", () => {
      process.env.ADMIN_TOTP_SECRET = "definitely-not-base32!";

      expect(() => getAuthUsers()).toThrow(AuthConfigError);
    });

    test("names the offending variable so the operator knows which one to fix", () => {
      process.env.USER_PASSWORD = "user-secret";
      process.env.USER_TOTP_SECRET = "0189";

      expect(() => getAuthUsers()).toThrow(/USER_TOTP_SECRET/);
    });

    test("ignores USER_TOTP_SECRET when there is no user account to protect", () => {
      delete process.env.USER_PASSWORD;
      // Invalid on purpose: an inert variable must not be able to break the whole login route.
      process.env.USER_TOTP_SECRET = "not-base32!";

      expect(getAuthUsers()).toHaveLength(1);
    });
  });
});
