/**
 * The key a session's server storage rows are filed under (docs/STORAGE.md, docs/GOVERNANCE.md).
 *
 * Under governance it is `sub:` and the identity provider's subject, the key a control plane writes grants under, so
 * a user whose email changes keeps their storage. Without governance it is the session's username exactly as before,
 * also for an OIDC session that carries a subject.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { UserPayload } from "@/lib/auth";
import { storageOwnerKey } from "@/lib/storage/owner-key";

const ISSUER = "https://idp.example/realms/libredb";
const SUBJECT_MISSING = "Server storage under governance is keyed by the identity provider's subject";

let savedSource: string | undefined;

beforeEach(() => {
  savedSource = process.env.GOVERNANCE_SOURCE;
  delete process.env.GOVERNANCE_SOURCE;
});

afterEach(() => {
  if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
  else process.env.GOVERNANCE_SOURCE = savedSource;
});

/** A session the OIDC callback mints: the username for display, the provider's subject and issuer for identity. */
function oidcSession(overrides: Partial<UserPayload> = {}): UserPayload {
  return { role: "user", username: "alice@example.com", idpSubject: "kc-user-1", idpIssuer: ISSUER, ...overrides };
}

describe("storageOwnerKey", () => {
  test("without governance the key is the session's username, also for a session that carries an IdP subject", () => {
    expect(storageOwnerKey({ role: "admin", username: "admin@libredb.org" })).toBe("admin@libredb.org");
    expect(storageOwnerKey(oidcSession())).toBe("alice@example.com");
    // An empty GOVERNANCE_SOURCE leaves governance off, as an unset one does.
    process.env.GOVERNANCE_SOURCE = "";
    expect(storageOwnerKey(oidcSession())).toBe("alice@example.com");
  });

  test("without governance a username that starts with sub: is refused for server storage", () => {
    // Governance files a user's rows under sub: and the subject, so a username of that shape could later read or
    // overwrite the rows of the user whose subject it names.
    expect(() => storageOwnerKey({ role: "user", username: "sub:kc-user-1" })).toThrow(
      'A username that starts with "sub:" cannot use server storage',
    );
    expect(() => storageOwnerKey(oidcSession({ username: "sub:" }))).toThrow(
      'A username that starts with "sub:" cannot use server storage',
    );
    // Only the exact prefix is refused.
    expect(storageOwnerKey({ role: "user", username: "Sub:alice" })).toBe("Sub:alice");
    expect(storageOwnerKey({ role: "user", username: "subscriber" })).toBe("subscriber");
  });

  test("governance keys by sub: and the IdP subject, never by the username", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(storageOwnerKey(oidcSession())).toBe("sub:kc-user-1");
    expect(storageOwnerKey(oidcSession({ role: "admin" }))).toBe("sub:kc-user-1");
    // The id of an LDAP-federated Keycloak user carries colons of its own, and the key keeps it whole.
    expect(storageOwnerKey(oidcSession({ idpSubject: "f:ldap-1:alice" }))).toBe("sub:f:ldap-1:alice");
  });

  test("governance keeps the key when the user's email, and with it the username, changes", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    const before = storageOwnerKey(oidcSession({ username: "alice@example.com" }));
    const after = storageOwnerKey(oidcSession({ username: "alice.smith@example.org" }));
    expect(after).toBe(before);
  });

  test("an invalid GOVERNANCE_SOURCE counts as governance, so the key is never the username", () => {
    process.env.GOVERNANCE_SOURCE = "postgress";
    expect(storageOwnerKey(oidcSession())).toBe("sub:kc-user-1");
  });

  test("governance throws for a session without an IdP subject instead of falling back to the username", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(() => storageOwnerKey({ role: "user", username: "alice@example.com", idpIssuer: ISSUER })).toThrow(
      SUBJECT_MISSING,
    );
    // openid-client accepts `sub: ""`, so an empty subject counts as missing.
    expect(() => storageOwnerKey(oidcSession({ idpSubject: "" }))).toThrow(SUBJECT_MISSING);
  });
});
