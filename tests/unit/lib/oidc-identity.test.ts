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
// provider marks verified, so a claim another person could choose cannot pass for a listed one.
describe("isEmailDomainAllowed", () => {
  const GOOGLE = "https://accounts.google.com";
  const IDP = "https://idp.example.test";

  test("admits every account while the list is empty, as before the variable existed", () => {
    expect(isEmailDomainAllowed({ email: "anyone@gmail.test" }, [])).toBe(true);
    expect(isEmailDomainAllowed({}, [])).toBe(true);
  });

  test("reads Google's hd claim, and refuses a Google token without it instead of reading the email", () => {
    expect(isEmailDomainAllowed({ iss: GOOGLE, hd: "topvisor.test" }, ["topvisor.test"])).toBe(true);
    expect(isEmailDomainAllowed({ iss: GOOGLE, hd: "topvisor.test" }, ["thundo.test"])).toBe(false);
    expect(
      isEmailDomainAllowed({ iss: GOOGLE, email: "ada@topvisor.test", email_verified: true }, ["topvisor.test"]),
    ).toBe(false);
  });

  test("ignores hd from any other issuer, which a provider or a client can set", () => {
    expect(isEmailDomainAllowed({ iss: IDP, hd: "topvisor.test" }, ["topvisor.test"])).toBe(false);
  });

  test("takes an email domain only when the provider marks the email verified", () => {
    for (const email_verified of [true, "true"]) {
      expect(isEmailDomainAllowed({ iss: IDP, email: "dev@example.test", email_verified }, ["example.test"])).toBe(
        true,
      );
    }
    for (const email_verified of [undefined, false, "false", "TRUE", 1]) {
      expect(isEmailDomainAllowed({ iss: IDP, email: "dev@example.test", email_verified }, ["example.test"])).toBe(
        false,
      );
    }
  });

  test("ignores empty and non-string values", () => {
    expect(emailDomainOf({ iss: GOOGLE, hd: "  " })).toBeNull();
    expect(emailDomainOf({ iss: GOOGLE, hd: 42 })).toBeNull();
    expect(emailDomainOf({ iss: IDP, email: "not-an-email", email_verified: true })).toBeNull();
    expect(emailDomainOf({ iss: IDP, email: "ada@", email_verified: true })).toBeNull();
    expect(emailDomainOf({})).toBeNull();
  });
});
