/**
 * Boot-time check of `LIBREDB_RUN_CONFIRMATION` (`@/lib/config/run-confirmation`).
 *
 * A value outside the accepted spellings refuses every run that needs a confirmation, by name, at run time; this check
 * refuses it before a standalone server serves instead. It lives apart from the mode reader so that `process.exit`
 * and the banner never reach a module a route imports. The variable never holds a secret, so the banner quotes the
 * value it got, through `JSON.stringify`, so a control character cannot write a line.
 */

import { runConfirmationSetting } from "@/lib/config/run-confirmation";

/**
 * Read the run confirmation mode. Returns true when the variable is unset, empty or one of the accepted spellings;
 * otherwise prints a banner, exits with status 1 and returns false.
 */
export function verifyRunConfirmationAtBoot(): boolean {
  const setting = runConfirmationSetting();
  if (!("invalid" in setting)) return true;
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: LIBREDB_RUN_CONFIRMATION is invalid",
      ` Got ${JSON.stringify(setting.invalid)}; it must be advisory, the default when unset, or required.`,
      " Studio cannot tell which runs to refuse without a confirmation, so boot stops here.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}
