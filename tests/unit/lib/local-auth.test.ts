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

    /**
     * RFC 4226 R6 makes 128 bits a MUST, and a secret below it is not a weaker second factor but
     * an absent one: a single observed code narrows an 8-bit key to one candidate. The alphabet
     * check alone let `AA` through, which reads as MFA everywhere in the UI and the docs while
     * costing an attacker nothing. Sliced off the RFC seed so the boundary is unmistakable.
     */
    test("rejects a secret below the 128 bits RFC 4226 requires", () => {
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET.slice(0, 25); // 125 bits -> 15 whole bytes

      expect(() => getAuthUsers()).toThrow(AuthConfigError);
    });

    test("says the secret is too short rather than repeating the base32 hint", () => {
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET.slice(0, 25);

      expect(() => getAuthUsers()).toThrow(/ADMIN_TOTP_SECRET is too short/);
    });

    test("accepts a secret of exactly the minimum length", () => {
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET.slice(0, 26); // 130 bits -> 16 whole bytes

      expect(getAuthUsers()[0].totpSecret).toBe(VALID_SECRET.slice(0, 26));
    });

    test("measures the decoded length, not the pasted one, so grouping does not fake it", () => {
      // 16 base32 characters is 10 bytes however it is spaced out; the separators are not payload.
      process.env.ADMIN_TOTP_SECRET = VALID_SECRET.slice(0, 16)
        .replace(/(.{4})/g, "$1 ")
        .trim();

      expect(() => getAuthUsers()).toThrow(/ADMIN_TOTP_SECRET is too short/);
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
