/**
 * Standalone boot banner: one short human-readable block naming the version,
 * the local URL and the repository. Printed from instrumentation.register(),
 * which only runs when this app boots its own Next.js server - so the banner
 * is standalone-only by construction and needs no extra gate.
 *
 * console.log on purpose, not the app logger (which emits structured JSON):
 * this block is for a human reading `docker logs`, same idiom as the first-run
 * credentials banner in auth-bootstrap.ts. Nothing here touches the network -
 * the star invitation is a static line, never a live count.
 *
 * Set LIBREDB_NO_BANNER=1 (or true) to silence it.
 */

import { getAppVersion } from "@/lib/app-version";
import { REPO_URL } from "@/lib/community/repo";

const DEFAULT_PORT = "3000";
const DEFAULT_HOST = "127.0.0.1";

function isSuppressed(): boolean {
  const value = (process.env.LIBREDB_NO_BANNER ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * The URL the server actually answers on. The bind address comes from
 * HOSTNAME — the same variable bin/studio.js forwards to the standalone
 * server — so a non-loopback bind prints a usable URL instead of a
 * hardcoded localhost that only works on loopback. Wildcards print a
 * loopback URL (the same convention as bin/lib/launcher-utils.mjs).
 */
function resolveUrl(): string {
  const port = (process.env.PORT ?? "").trim();
  let host = (process.env.HOSTNAME ?? "").trim();
  if (!host) host = DEFAULT_HOST;
  if (host === "0.0.0.0") host = DEFAULT_HOST;
  else if (host === "::" || host === "[::]") host = "[::1]";
  else if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port || DEFAULT_PORT}`;
}

/**
 * Print the boot banner. Never throws: a failure here must not break boot.
 */
export function printStartupBanner(): void {
  try {
    if (isSuppressed()) return;

    // Absent in unbuilt contexts; drop the token rather than print "undefined".
    const version = getAppVersion();
    const title = version ? `LibreDB Studio ${version}` : "LibreDB Studio";

    console.log(
      ["", `${title}  ->  ${resolveUrl()}`, "", "  Star the project if it helps you:", `  ${REPO_URL}`, ""].join("\n"),
    );
  } catch {
    // A banner is never worth a failed boot - stay silent and carry on.
  }
}
