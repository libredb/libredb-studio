/**
 * Next.js boot hook. register() runs once per server worker, ONLY when this app
 * boots its own Next.js server (never when @libredb/studio is imported by
 * libredb-platform). On standalone boot, first install the uncaught-exception
 * exit (docs/DISTRIBUTION.md#uncaught-errors-and-restarts), then the shutdown
 * handler (docs/DISTRIBUTION.md#stopping-the-server), then bootstrap
 * missing auth env (#109), run the boot preflights and the credential
 * re-seal and check when STORAGE_ENCRYPTION_RESEAL or
 * STORAGE_ENCRYPTION_REQUIRE_V2 asks for them, and start copying the
 * built-in samples (src/lib/seed/samples.ts), which boot never waits for: a
 * sample whose copy fails is logged once and listed unavailable.
 */
export async function register(): Promise<void> {
  // Node.js server runtime only (skip the edge runtime).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // First, so that an exception thrown by any step below, or later in this process, ends it with a named code
  // instead of leaving it running in an unknown state (docs/DISTRIBUTION.md#uncaught-errors-and-restarts).
  const { installUncaughtExceptionExit } = await import("@/lib/uncaught-exception");
  installUncaughtExceptionExit(process);

  // Second, so that a signal at any later point of the boot or of the life of the process runs the shutdown hooks
  // (docs/DISTRIBUTION.md#stopping-the-server). NEXT_MANUAL_SIG_HANDLE decides who ends the process on SIGTERM and
  // SIGINT: Studio's handler for `true`, Next.js's own when unset or empty; any other value refuses the boot, and so
  // does `true` on Bun, where the request drain sees no request.
  const { exitOwnerAtBoot, installShutdownHandler } = await import("@/lib/shutdown-handler");
  const exitOwner = exitOwnerAtBoot();
  if (exitOwner === undefined) return;
  installShutdownHandler(process, exitOwner);

  // Zero-config first run (#109): fill missing auth env from the persisted
  // bootstrap file BEFORE anything reads process.env secrets. Fail-open inside.
  const { bootstrapAuth } = await import("@/lib/auth-bootstrap");
  bootstrapAuth();

  // Auth-config preflight (#227): a set-but-too-short JWT_SECRET makes every
  // login 503 while the health check stays green, so refuse to boot instead of
  // serving a deployment that only looks healthy. Runs AFTER bootstrap so a
  // generated secret is validated too.
  const { verifyAuthEnvAtBoot } = await import("@/lib/config/auth-preflight");
  if (!verifyAuthEnvAtBoot()) return;

  // Private CA preflight: Node only warns when NODE_EXTRA_CA_CERTS names a missing or
  // empty file, so refuse to boot instead; on OpenShift the cluster fills the chart's
  // trusted-CA ConfigMap after start, and the restart picks the bundle up.
  const { verifyExtraCaCertsAtBoot } = await import("@/lib/config/ca-bundle-preflight");
  if (!verifyExtraCaCertsAtBoot()) return;

  // Egress preflight: DB_HTTP_BLOCK_PRIVATE_HOSTS is read once per process, and
  // this is the first read, so the decision is taken and logged at boot, and a
  // value outside the accepted spellings refuses the boot by name instead of
  // failing at the first guarded connection.
  const { verifyEgressDecisionAtBoot } = await import("@/lib/config/egress-preflight");
  if (!verifyEgressDecisionAtBoot()) return;

  // Governance preflight (docs/GOVERNANCE.md#boot-checks): with
  // GOVERNANCE_SOURCE set, refuse an environment that contradicts governance
  // mode, such as a password, a seed file or a missing governance URL, before
  // anything acts on it. It checks nothing while governance is off.
  const { verifyGovernanceEnvAtBoot } = await import("@/lib/governance/preflight");
  if (!verifyGovernanceEnvAtBoot()) return;

  // Kubernetes access review preflight (docs/SEED_CONNECTIONS.md): with
  // KUBERNETES_ACCESS_REVIEW on, refuse an environment that contradicts the
  // review, such as a role claim, MCP or a session longer than 900 seconds,
  // before anything acts on it. It checks nothing while the review is off.
  const { verifyAccessReviewEnvAtBoot } = await import("@/lib/kubernetes-access/preflight");
  if (!verifyAccessReviewEnvAtBoot()) return;

  // Credential re-seal (docs/STORAGE.md, "Re-sealing the store"): with
  // STORAGE_ENCRYPTION_REQUIRE_V2 set, check that the store records version 1
  // as retired, before any re-seal step, and run no re-seal; without it, with
  // STORAGE_ENCRYPTION_RESEAL set, back the server store up, re-seal every
  // stored credential and retire version 1 before the server serves. A value
  // of either variable it cannot read, local mode, a re-seal that does not
  // complete, or a check that does not pass refuses the boot. It does nothing while both are unset. It runs after
  // bootstrapAuth (the storage key may come from the JWT_SECRET that fills in)
  // and after the preflights, so a boot they refuse never touches the store.
  const { resealStoreAtBoot } = await import("@/lib/storage/reseal-at-boot");
  if (!(await resealStoreAtBoot())) return;

  // Governance snapshot (docs/GOVERNANCE.md#operating-notes): load the
  // governance source in the background and keep it current. Not awaited, so
  // the server serves at once and data routes answer 503 until the first load
  // succeeds; a database outage never stops it. Imported only under governance,
  // so a Studio without GOVERNANCE_SOURCE never loads the governance pool.
  const { governanceEnabled } = await import("@/lib/governance/config");
  if (governanceEnabled()) {
    const { startGovernance } = await import("@/lib/governance/start");
    startGovernance();
  }

  // Boot banner: version, URL, and the invitation to star the repo. Printed
  // after the preflight above so a server that refuses to boot never prints a
  // welcome. Never throws.
  const { printStartupBanner } = await import("@/lib/startup-banner");
  printStartupBanner();

  // Agent resume sweep (#329 B9): pick up runs a dead process left `running`.
  // The sweep itself checks whether the agent runtime is enabled, so wiring it
  // here costs nothing when AI is off. Never throws, and never blocks boot.
  const { startAgentResumeSweep } = await import("@/lib/agent/resume-sweep");
  startAgentResumeSweep();

  // Built-in samples: which samples are enabled and admitted is decided here,
  // once, for the life of the process, and every enabled sample is marked
  // seeding before this returns, so GET /api/connections/managed lists it in
  // pendingSeeds and the client polls until it appears. The copies are not
  // awaited: a failed copy is logged once and listed unavailable. Their promise
  // rejects only for a defect, an error a copy throws that is not a
  // SampleCopyError; that sample is listed unavailable as copy-defect, and the
  // rejection, which nothing here catches, is the process's unhandled
  // rejection: Next.js logs it and goes on serving, and under
  // --unhandled-rejections=strict the uncaught-exception exit stops the server
  // with code 70.
  // The sample service loads no engine code (tests/unit/seed/no-engine-imports.test.ts).
  const { startSampleSeeding } = await import("@/lib/seed/samples");
  void startSampleSeeding();
}
