/**
 * Next.js boot hook. register() runs once per server worker, ONLY when this app
 * boots its own Next.js server (never when @libredb/studio is imported by
 * libredb-platform). On standalone boot, bootstrap missing auth env (#109) and
 * seed the embedded samples if enabled. A failure here must never break boot.
 */
export async function register(): Promise<void> {
  // Node.js server runtime only (skip the edge runtime).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Zero-config first run (#109): fill missing auth env from the persisted
  // bootstrap file BEFORE anything reads process.env secrets. Fail-open inside.
  const { bootstrapAuth } = await import("@/lib/auth-bootstrap");
  bootstrapAuth();

  const { logger } = await import("@/lib/logger");

  // LibreDB sample: programmatic and fast — seeded synchronously as before.
  const { isSampleEnabled, resolveSamplePath, seedSampleFile } = await import("@/lib/seed/libredb-sample");
  if (isSampleEnabled()) {
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

  // SQLite sample: a file copy — fire-and-forget so boot never waits on it.
  // The seed state lets GET /api/connections/managed advertise the pending
  // seed, and the client polls until the sample appears (no page refresh).
  // The inner try/catch guarantees no unhandled rejection; on failure the
  // server keeps running and the sample is silently absent.
  const { isSqliteSampleEnabled, resolveSqliteSamplePath, seedSqliteSampleFile, setSqliteSampleSeedState } =
    await import("@/lib/seed/sqlite-sample");
  if (!isSqliteSampleEnabled()) return;

  // "seeding" is set BEFORE the IIFE so no request can observe "idle" while a
  // first-boot copy is about to start; on fast-path boots (file already
  // present) the window closes within the first fs call, before the HTTP
  // server accepts its first request.
  setSqliteSampleSeedState("seeding");
  void (async () => {
    const started = Date.now();
    let filePath: string | undefined;
    try {
      filePath = resolveSqliteSamplePath();
      const outcome = await seedSqliteSampleFile(filePath);
      setSqliteSampleSeedState("done");
      if (outcome === "skipped") {
        // Every boot after the first takes this path — keep it to one quiet
        // line instead of a started/completed info pair (PR #191 review).
        logger.debug("SQLite embedded sample already present", { route: "instrumentation", path: filePath });
      } else {
        logger.info("SQLite embedded sample seed completed", {
          route: "instrumentation",
          path: filePath,
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      setSqliteSampleSeedState("failed");
      logger.warn("SQLite embedded sample seeding skipped", {
        route: "instrumentation",
        path: filePath,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
