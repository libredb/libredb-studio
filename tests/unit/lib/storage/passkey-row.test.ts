import { describe, expect, test } from "bun:test";
import { PASSKEY_COLUMNS, PASSKEY_COLUMNS_OF_C, type PasskeyRow, passkeyFromRow } from "@/lib/storage/passkey-row";

const row: PasskeyRow = {
  id: "pk-1",
  credential_id: "cred-1",
  account_email: "ada@example.com",
  public_key: "pub",
  // PostgreSQL returns BIGINT as a string.
  sign_count: "7",
  transports: '["internal","hybrid"]',
  backup_eligible: 1,
  backup_state: 0,
  rp_id: "studio.example.com",
  name: "Laptop",
  created_at: "2026-09-28T00:00:00.000Z",
  last_used_at: null,
};

describe("passkeyFromRow", () => {
  test("maps a row to a StoredPasskey", () => {
    expect(passkeyFromRow(row)).toEqual({
      id: "pk-1",
      credentialId: "cred-1",
      accountEmail: "ada@example.com",
      publicKey: "pub",
      signCount: 7,
      transports: ["internal", "hybrid"],
      backupEligible: true,
      backupState: false,
      rpId: "studio.example.com",
      name: "Laptop",
      createdAt: "2026-09-28T00:00:00.000Z",
      lastUsedAt: null,
    });
    expect(passkeyFromRow({ ...row, last_used_at: "2026-09-29T00:00:00.000Z", sign_count: 4294967295 })).toMatchObject({
      lastUsedAt: "2026-09-29T00:00:00.000Z",
      signCount: 4294967295,
    });
  });

  test("rejects a sign_count outside the unsigned 32-bit range", () => {
    for (const value of [-1, 4294967296, 1.5, "x", "", " "]) {
      expect(() => passkeyFromRow({ ...row, sign_count: value })).toThrow(`row pk-1 has sign_count ${value}`);
    }
  });

  test("rejects backup flags other than 0 and 1", () => {
    expect(() => passkeyFromRow({ ...row, backup_eligible: 2 })).toThrow("row pk-1 has backup_eligible 2");
    expect(() => passkeyFromRow({ ...row, backup_state: 2 })).toThrow("row pk-1 has backup_state 2");
    // Number("") and Number(" ") are 0, so a blank string must not read as false.
    for (const value of ["", " "]) {
      expect(() => passkeyFromRow({ ...row, backup_eligible: value })).toThrow(`row pk-1 has backup_eligible ${value}`);
      expect(() => passkeyFromRow({ ...row, backup_state: value })).toThrow(`row pk-1 has backup_state ${value}`);
    }
  });

  test("rejects transports that are not a JSON array of known names", () => {
    for (const value of ['{"a":1}', "not json", "[1]", '["internal","warp-drive"]']) {
      expect(() => passkeyFromRow({ ...row, transports: value })).toThrow("row pk-1 has transports");
    }
  });
});

describe("PASSKEY_COLUMNS_OF_C", () => {
  test("is the column list qualified by the alias c, in the same order", () => {
    expect(PASSKEY_COLUMNS_OF_C).toBe(
      "c.id, c.credential_id, c.account_email, c.public_key, c.sign_count, c.transports, c.backup_eligible, c.backup_state, c.rp_id, c.name, c.created_at, c.last_used_at",
    );
    expect(PASSKEY_COLUMNS_OF_C.replaceAll("c.", "")).toBe(PASSKEY_COLUMNS);
  });
});
