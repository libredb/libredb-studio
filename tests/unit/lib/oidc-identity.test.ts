import { describe, expect, test } from "bun:test";
import { comparableIssuer, emailDomainOf, isEmailDomainAllowed, oidcUsername } from "@/lib/oidc-identity";

describe("comparableIssuer", () => {
  test("drops one trailing slash and normalizes the host, and is null for a value that is not a URL", () => {
    expect(comparableIssuer("https://IdP.example.test/")).toBe("https://idp.example.test");
    expect(comparableIssuer("https://idp.example.test/realms/libredb")).toBe("https://idp.example.test/realms/libredb");
    expect(comparableIssuer("not a url")).toBeNull();
  });
});

// `username` keys a person's saved work, rate limit and audit lines, so it is taken only from a claim the provider
// stands behind: an email it did not mark unverified, else a username that cannot pass for someone else's email.
describe("oidcUsername", () => {
  test("takes the email when the provider marks it verified or says nothing about it", () => {
    expect(oidcUsername({ email: "ada@example.test", email_verified: true, preferred_username: "ada" })).toBe(
      "ada@example.test",
    );
    expect(oidcUsername({ email: "ada@example.test", preferred_username: "ada" })).toBe("ada@example.test");
  });

  test("passes over an email the provider marks unverified", () => {
    expect(oidcUsername({ email: "bob@example.test", email_verified: false, preferred_username: "mallory" })).toBe(
      "mallory",
    );
    expect(oidcUsername({ email: "bob@example.test", email_verified: false })).toBeNull();
  });

  test('reads email_verified sent as a string, as some providers do, so "false" is not taken for verified', () => {
    for (const unverified of ["false", "FALSE", " False "]) {
      expect(
        oidcUsername({ email: "bob@example.test", email_verified: unverified, preferred_username: "mallory" }),
      ).toBe("mallory");
    }
    expect(oidcUsername({ email: "ada@example.test", email_verified: "true", preferred_username: "ada" })).toBe(
      "ada@example.test",
    );
  });

  test("never takes an email-shaped preferred_username, which a user may be free to choose", () => {
    expect(oidcUsername({ preferred_username: "bob@example.test" })).toBeNull();
    expect(
      oidcUsername({ email: "bob@example.test", email_verified: false, preferred_username: "bob@example.test" }),
    ).toBeNull();
  });

  test("ignores empty and non-string values", () => {
    expect(oidcUsername({ email: "", preferred_username: "ada" })).toBe("ada");
    expect(oidcUsername({ email: 42, preferred_username: ["ada"] })).toBeNull();
    expect(oidcUsername({})).toBeNull();
  });
});

// OIDC_ALLOWED_EMAIL_DOMAINS is enforced on the domain the provider stands behind: Google's `hd`, or an email the
// provider marks verified. Google is recognised by the configured issuer, not by a claim a token carries.
describe("isEmailDomainAllowed", () => {
  const GOOGLE = "https://accounts.google.com";
  const IDP = "https://idp.example.test";

  test("admits every account while the list is empty, as before the variable existed", () => {
    expect(isEmailDomainAllowed({ email: "anyone@gmail.test" }, [], IDP)).toBe(true);
    expect(isEmailDomainAllowed({}, [], GOOGLE)).toBe(true);
  });

  test("reads Google's hd claim, and refuses a Google token without it instead of reading the email", () => {
    expect(isEmailDomainAllowed({ hd: "topvisor.test" }, ["topvisor.test"], GOOGLE)).toBe(true);
    expect(isEmailDomainAllowed({ hd: "topvisor.test" }, ["thundo.test"], GOOGLE)).toBe(false);
    expect(isEmailDomainAllowed({ email: "ada@topvisor.test", email_verified: true }, ["topvisor.test"], GOOGLE)).toBe(
      false,
    );
  });

  test("recognises Google's issuer whatever its case or trailing slash", () => {
    for (const issuer of [GOOGLE, "https://accounts.google.com/", "HTTPS://Accounts.Google.com"]) {
      expect(isEmailDomainAllowed({ hd: "example.test" }, ["example.test"], issuer), issuer).toBe(true);
    }
  });

  test("ignores hd from any other issuer, which a provider or a client can set", () => {
    expect(isEmailDomainAllowed({ hd: "topvisor.test" }, ["topvisor.test"], IDP)).toBe(false);
  });

  test("matches exactly: a parent domain covers no subdomain, and no suffix or second address counts", () => {
    for (const email of [
      "a@sub.example.test",
      "a@evil-example.test",
      "a@example.test.evil",
      "a@example.test@evil.test",
    ]) {
      expect(isEmailDomainAllowed({ email, email_verified: true }, ["example.test"], IDP), email).toBe(false);
    }
    expect(isEmailDomainAllowed({ hd: "EXAMPLE.TEST" }, ["example.test"], GOOGLE)).toBe(true);
  });

  test("takes an email domain only when the provider marks the email verified", () => {
    for (const email_verified of [true, "true"]) {
      expect(isEmailDomainAllowed({ email: "dev@example.test", email_verified }, ["example.test"], IDP)).toBe(true);
    }
    for (const email_verified of [undefined, false, "false", "TRUE", 1]) {
      expect(isEmailDomainAllowed({ email: "dev@example.test", email_verified }, ["example.test"], IDP)).toBe(false);
    }
  });

  test("ignores empty and non-string values", () => {
    expect(emailDomainOf({ hd: "  " }, GOOGLE)).toBeNull();
    expect(emailDomainOf({ hd: 42 }, GOOGLE)).toBeNull();
    expect(emailDomainOf({ email: "not-an-email", email_verified: true }, IDP)).toBeNull();
    expect(emailDomainOf({ email: "ada@", email_verified: true }, IDP)).toBeNull();
    expect(emailDomainOf({}, IDP)).toBeNull();
  });
});
