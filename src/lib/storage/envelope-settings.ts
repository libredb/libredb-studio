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
 * retired: by initialize, and by the boot check, which runs before any re-seal step. While STORAGE_ENCRYPTION_REQUIRE_V2
 * is set the re-seal runs only on a store that records it, so the refusal says when to restore and how to re-seal.
 */
export const VERSION_TWO_NOT_RECORDED =
  "STORAGE_ENCRYPTION_REQUIRE_V2 is set, but this store records no re-seal: it holds no credential_envelope row recording that version 1 is retired, and while STORAGE_ENCRYPTION_REQUIRE_V2 is set the re-seal runs only on a store that records it. If this store was re-sealed before, restore it from a backup taken after that re-seal. To re-seal a store whose contents you know, start once with STORAGE_ENCRYPTION_RESEAL=true and without STORAGE_ENCRYPTION_REQUIRE_V2, then remove STORAGE_ENCRYPTION_RESEAL and set STORAGE_ENCRYPTION_REQUIRE_V2 again (docs/STORAGE.md, Requiring version 2).";

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
