/**
 * "The agent runtime is on" stopped being one variable a test can set (#331 T5):
 * availability is derived from the `LLM_*` configuration and the ledger path, and
 * `LIBREDB_AGENT_ENABLED` is only the off-switch.
 *
 * Two hazards make this a helper rather than four copies. First, `bun` loads a
 * checkout's `.env` into `process.env`, so a suite that leaves the LLM keys alone
 * answers one way on a developer machine with a real key and the opposite way in
 * CI, which has none — the failure appears only after push. Second, the core
 * suites share one process under `bun run test`, so a file that sets a key without
 * putting it back hands the next file a model it never asked for.
 *
 * Deliberately not a `mock.module` helper: those are the ones this repository
 * refuses to share, because `mock.module` is process-wide. This only touches
 * environment variables, which each suite already saves and restores itself.
 */

const MODEL_ENV_KEYS = ["LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_API_URL"] as const;

let saved: Map<string, string | undefined> | null = null;

/**
 * Configure a model that `validateConfig` accepts without reaching anything, and
 * remember what was there. Call from `beforeEach`, paired with `restoreAgentModel`
 * in `afterEach`.
 */
export function configureAgentModel(): void {
  if (saved === null) {
    saved = new Map(MODEL_ENV_KEYS.map((key) => [key, process.env[key]]));
  }
  for (const key of MODEL_ENV_KEYS) delete process.env[key];
  process.env.LLM_PROVIDER = "gemini";
  process.env.LLM_API_KEY = "test-key";
}

/** Put the environment back exactly as it was before the first configure call. */
export function restoreAgentModel(): void {
  if (saved === null) return;
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved = null;
}
