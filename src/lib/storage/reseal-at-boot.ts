/**
 * STORAGE_ENCRYPTION_RESEAL, the operator's re-seal of the server store (docs/STORAGE.md, "Re-sealing the store").
 *
 * Set on every server once every server runs this version, and removed after one restart: the first start backs the
 * store up completely, re-seals every stored credential as a version 2 envelope bound to its place, and records that
 * version 1 is retired; any other replica starting at the same time waits on the store's lock and finds nothing to do.
 * It follows ADMIN_PASSWORD_RESET (an environment variable plus a restart) and the boot preflights (a banner and exit
 * status 1 on refusal), and runs in src/instrumentation.ts register() after the preflights and before the server
 * serves.
 *
 * Unset, empty, `false`, `0` and `off` do nothing. `true`, `1` and `on`, in any letter case, re-seal. Any other value
 * refuses the boot by name rather than being skipped: a requested migration that cannot be read must not pass
 * silently. So does setting it with STORAGE_PROVIDER=local, which has no server store. A re-seal that fails refuses
 * the boot with the error; the store is then exactly as it was.
 *
 * It lives apart from the storage modules so that `process.exit` and the banner never reach the published package.
 */

import { logger } from "@/lib/logger";
import { getStorageProvider } from "./factory";
import { getStorageProviderType } from "./provider-type";
import { resealStore } from "./reseal";

const ON = new Set(["true", "1", "on"]);
const OFF = new Set(["", "false", "0", "off"]);

function refuse(lines: string[]): false {
  console.error(
    [
      "",
      "============================================================",
      ...lines,
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}

/**
 * Runs the re-seal when STORAGE_ENCRYPTION_RESEAL asks for it. Returns true when the boot goes on (nothing asked, a
 * re-seal that succeeded, or a store already retired); otherwise prints a banner, exits with status 1 and returns false.
 */
export async function resealStoreAtBoot(): Promise<boolean> {
  const raw = process.env.STORAGE_ENCRYPTION_RESEAL;
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (OFF.has(value)) return true;
  if (!ON.has(value)) {
    return refuse([
      " LibreDB Studio cannot start: STORAGE_ENCRYPTION_RESEAL is invalid",
      ` Got ${JSON.stringify(raw)}; it must be true, on or 1 to re-seal the stored credentials,`,
      " or false, off, 0 or unset to start without re-sealing.",
      " A requested re-seal that cannot be read must not be skipped, so boot stops here.",
    ]);
  }
  if (getStorageProviderType() === "local") {
    return refuse([
      " LibreDB Studio cannot start: STORAGE_ENCRYPTION_RESEAL is set, but STORAGE_PROVIDER is local",
      " There is no server store to re-seal. Remove STORAGE_ENCRYPTION_RESEAL, or set STORAGE_PROVIDER",
      " to sqlite or postgres.",
    ]);
  }
  try {
    // Not null: the provider type is sqlite or postgres here.
    const provider = (await getStorageProvider())!;
    const report = await resealStore(provider, new Date());
    if (report.kind === "already-retired") {
      logger.warn(
        "STORAGE_ENCRYPTION_RESEAL: this store retired version 1 already, so nothing was read, written or backed up. Remove STORAGE_ENCRYPTION_RESEAL now.",
        { route: "storage-reseal" },
      );
      return true;
    }
    logger.warn(
      `STORAGE_ENCRYPTION_RESEAL: backed up the store to ${report.backup}, re-sealed ${report.resealed} value(s) and kept ${report.kept} already sealed for their place; version 1 is retired.`,
      { route: "storage-reseal" },
    );
    if (report.unopened.length > 0) {
      logger.warn(
        `STORAGE_ENCRYPTION_RESEAL: left ${report.unopened.length} value(s) as they were, because they open nowhere here: ${report.unopened.join(", ")}.`,
        { route: "storage-reseal" },
      );
    }
    if (report.unread.length > 0) {
      logger.warn(
        `STORAGE_ENCRYPTION_RESEAL: left ${report.unread.length} row(s) or element(s) unread, because they are not connections: ${report.unread.join(", ")}.`,
        { route: "storage-reseal" },
      );
    }
    logger.warn("STORAGE_ENCRYPTION_RESEAL: remove it now; every start re-checks the store while it is set.", {
      route: "storage-reseal",
    });
    return true;
  } catch (error) {
    return refuse([
      " LibreDB Studio cannot start: the credential re-seal failed",
      ` ${error instanceof Error ? error.message : String(error)}`,
      " The store is as it was: the re-seal runs in one transaction, so every change was rolled back,",
      " and version 1 is still accepted. A SQLite run that stopped after its backup leaves that copy",
      " of the unchanged store beside the store file.",
      " Fix the cause and start again, or remove STORAGE_ENCRYPTION_RESEAL to start without re-sealing.",
    ]);
  }
}
