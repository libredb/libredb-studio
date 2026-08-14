/**
 * The version this build reports, or null when nothing injected one.
 *
 * `next.config.ts` injects NEXT_PUBLIC_APP_VERSION from package.json, so the
 * standalone app always has it. The tsup library build declares no `define`, so
 * inside the published `@libredb/studio` package the lookup survives into the
 * chunk and is resolved against the HOST application's environment - where the
 * variable is normally absent, and would render the literal "vundefined" in a
 * paid product. Absence is therefore a first-class answer: callers render
 * nothing rather than a broken token.
 */
export function getAppVersion(): string | null {
  const version = (process.env.NEXT_PUBLIC_APP_VERSION ?? "").trim();
  return version === "" ? null : version;
}
