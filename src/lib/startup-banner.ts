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

function isSuppressed(): boolean {
  const value = (process.env.LIBREDB_NO_BANNER ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/** The port the server actually listens on; never invent a hostname. */
function resolveUrl(): string {
  const port = (process.env.PORT ?? "").trim();
  return `http://localhost:${port || DEFAULT_PORT}`;
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
