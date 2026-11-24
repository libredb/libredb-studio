/**
 * Boot-time check of `DB_HTTP_BLOCK_PRIVATE_HOSTS`.
 *
 * The variable decides whether Studio's database connections may reach loopback, private and the other non-public
 * destinations, and core takes that decision once per process (`@/lib/db/egress-decision`). This check is the first
 * read on a standalone server: it takes the decision at boot, so the line that reports it is logged before the server
 * serves, and it refuses a value outside the accepted spellings by name, which would otherwise surface only at the
 * first guarded connection.
 *
 * It lives apart from the decision module so that `process.exit` and the banner never reach the published package or
 * the VS Code backend, which take the decision in the provider factory instead. The variable never holds a secret, so
 * the banner quotes the value it got, through `JSON.stringify`, so a control character cannot write a line.
 */

import { egressSetting } from "@/lib/db/egress-decision";

/**
 * Take the egress decision. Returns true when the variable is unset, empty or one of the accepted spellings;
 * otherwise prints a banner, exits with status 1 and returns false.
 */
export function verifyEgressDecisionAtBoot(): boolean {
  const setting = egressSetting();
  if (!("invalid" in setting)) return true;
  console.error(
    [
      "",
      "============================================================",
      " LibreDB Studio cannot start: DB_HTTP_BLOCK_PRIVATE_HOSTS is invalid",
      ` Got ${JSON.stringify(setting.invalid)}; it must be true, on or 1 to block private database destinations,`,
      " or false, off, 0 or unset to keep them reachable, the default.",
      " Studio cannot tell which way its egress guard should decide, so boot stops here.",
      "============================================================",
      "",
    ].join("\n"),
  );
  process.exit(1);
  return false;
}
