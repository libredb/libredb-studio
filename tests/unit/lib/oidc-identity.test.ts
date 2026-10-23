import { describe, expect, test } from "bun:test";
import { comparableIssuer, oidcUsername } from "@/lib/oidc-identity";

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
