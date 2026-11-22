/**
 * The operator settings of the credential envelope (docs/STORAGE.md, "Re-sealing the store"), read from the
 * environment where they act: STORAGE_ENCRYPTION_RESEAL at boot, and STORAGE_ENCRYPTION_REQUIRE_V2 at boot and when
 * the encrypting provider initializes.
 *
 * Both take the same spellings: unset, empty, `false`, `0` and `off` are off; `true`, `1` and `on` are on; any letter
 * case, surrounding spaces ignored. STORAGE_ENCRYPTION_RESEAL also takes `leave-unopened`, which re-seals and retires
 * version 1 over version 1 values the key in use does not open. Any other value throws `InvalidStorageSetting` by name,
 * because a setting about the store's credentials that cannot be read must not be taken as off.
 */

const ON = new Set(["true", "1", "on"]);
const OFF = new Set(["", "false", "0", "off"]);
const LEAVE_UNOPENED = "leave-unopened";

/** What STORAGE_ENCRYPTION_RESEAL asks for: nothing, a re-seal, or a re-seal that leaves values it cannot open. */
export type ResealSetting = "off" | "reseal" | "leave-unopened";

/**
 * Logged as the refusal when STORAGE_ENCRYPTION_REQUIRE_V2 is set and the store does not record that version 1 is
 * retired: by initialize, and by the boot check after the re-seal. A missing row does not say which of the three cases
 * the store is in, so the refusal names them and when to re-seal rather than restore.
 */
export const VERSION_TWO_NOT_RECORDED =
  "STORAGE_ENCRYPTION_REQUIRE_V2 is set, but the store holds no credential_envelope row recording that version 1 is retired. A store that was never re-sealed holds none, and neither does one restored from a copy taken before its re-seal or one whose row was deleted. Re-seal only a store whose contents you know, by starting once with STORAGE_ENCRYPTION_RESEAL=true as well, which seals every version 1 and unsealed value it holds for the record and field that hold it and records the row; otherwise restore the store from a backup taken after its re-seal (docs/STORAGE.md, Requiring version 2).";

/** A credential envelope setting whose value is none of its spellings. */
export class InvalidStorageSetting extends Error {
  constructor(
    readonly variable: string,
    readonly raw: string,
    accepted: string,
  ) {
    super(`${variable} is invalid: got ${JSON.stringify(raw)}; it must be ${accepted}, or false, off, 0 or unset.`);
    this.name = "InvalidStorageSetting";
  }
}

/** STORAGE_ENCRYPTION_RESEAL as the boot step reads it. */
export function resealSetting(): ResealSetting {
  const raw = process.env.STORAGE_ENCRYPTION_RESEAL;
  if (raw === undefined) return "off";
  const value = raw.trim().toLowerCase();
  if (OFF.has(value)) return "off";
  if (ON.has(value)) return "reseal";
  if (value === LEAVE_UNOPENED) return "leave-unopened";
  throw new InvalidStorageSetting("STORAGE_ENCRYPTION_RESEAL", raw, "true, on, 1 or leave-unopened");
}

/** Whether STORAGE_ENCRYPTION_REQUIRE_V2 is set: version 1 and unsealed values are refused whatever the store holds. */
export function requiresVersionTwo(): boolean {
  const raw = process.env.STORAGE_ENCRYPTION_REQUIRE_V2;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (OFF.has(value)) return false;
  if (ON.has(value)) return true;
  throw new InvalidStorageSetting("STORAGE_ENCRYPTION_REQUIRE_V2", raw, "true, on or 1");
}
