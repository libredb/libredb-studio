/**
 * Next.js boot hook. register() runs once per server worker, ONLY when this app
 * boots its own Next.js server (never when @libredb/studio is imported by
 * libredb-platform). On standalone boot, seed the embedded sample .libredb file
 * if enabled. A failure here must never break boot.
 */
export async function register(): Promise<void> {
  // Node.js server runtime only (skip the edge runtime).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { isSampleEnabled, resolveSamplePath, seedSampleFile } = await import("@/lib/seed/libredb-sample");
  if (!isSampleEnabled()) return;

  const { logger } = await import("@/lib/logger");
  let filePath: string | undefined;
  try {
    filePath = resolveSamplePath();
    await seedSampleFile(filePath);
  } catch (error) {
    logger.warn("LibreDB embedded sample seeding skipped", {
      route: "instrumentation",
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
