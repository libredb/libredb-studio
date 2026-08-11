/**
 * Server-side configuration for the agent runtime (#329, epic #325).
 *
 * Two knobs, both server-side only (never `NEXT_PUBLIC_`), mirroring the shape
 * of the storage-provider selection in `src/lib/storage/factory.ts`: a
 * capability flag and a backend selector with a zero-config default plus one
 * opt-in mode. Two deliberate differences from that module:
 *
 *  - The flag is **default off**. The agent rail is an additive capability that
 *    must be invisible until an operator turns it on, so an absent, empty or
 *    misspelled value all mean off.
 *  - An unrecognised backend is **refused**, not defaulted away. The storage
 *    factory can safely fall back to `local` because every value it accepts is
 *    one of its own; this variable is read by the workflow runtime itself,
 *    which treats any value other than its own two keywords as a MODULE
 *    SPECIFIER it require()s. An allowlist is therefore the control that stops
 *    a stray value from loading arbitrary code into the server, and it is also
 *    what keeps the running backend equal to one of the two ratified ones.
 *
 * The variables are read from `process.env` on every call, not captured at
 * module load, so this module sees exactly what the runtime sees.
 */

/** Capability flag for the whole agent rail. Absent means off. */
export const AGENT_ENABLED_ENV = "LIBREDB_AGENT_ENABLED";

/**
 * Durable-execution backend selector. The name is the workflow runtime's own
 * variable — this module validates it rather than introducing a second one, so
 * there is exactly one value in play and no way for the two to disagree.
 */
export const AGENT_WORLD_TARGET_ENV = "WORKFLOW_TARGET_WORLD";

/**
 * Set by the hosted platform the runtime targets by default. Read here only to
 * refuse that implicit selection: with no explicit target the runtime would
 * pick its hosted world, which is not one of the two ratified backends.
 */
const HOSTED_DEPLOYMENT_ENV = "VERCEL_DEPLOYMENT_ID";

/** The two official modes. `local` is zero-config; `postgres` is multi-replica. */
export type AgentDurableBackend = "local" | "postgres";

/**
 * Allowlist of accepted `WORKFLOW_TARGET_WORLD` values, mapped onto the backend
 * they select. The keys are the exact strings the runtime itself recognises —
 * matching is case-sensitive and untrimmed on purpose, because the runtime
 * compares the raw value, so accepting a variant here would validate one thing
 * and run another.
 */
export const SANCTIONED_WORLD_TARGETS: Readonly<Record<string, AgentDurableBackend>> = Object.freeze({
  local: "local",
  "@workflow/world-postgres": "postgres",
});

type AgentConfigDenyCode = "UNSANCTIONED_WORLD_TARGET" | "IMPLICIT_HOSTED_WORLD";

/**
 * Raised when the agent runtime cannot be configured safely. This is an
 * operator error, and it is thrown lazily at call time rather than at module
 * load so a misconfiguration cannot take down unrelated imports.
 */
export class AgentConfigError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: AgentConfigDenyCode,
  ) {
    super(message);
    this.name = "AgentConfigError";
    Object.setPrototypeOf(this, AgentConfigError.prototype);
  }
}

/** Resolved runtime configuration. Disabled carries no backend at all. */
export type AgentRuntimeConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly backend: AgentDurableBackend };

// Affirmative/negative vocabulary copied from the AUTH_BOOTSTRAP convention in
// src/lib/auth-bootstrap.ts so operators meet one spelling of "on" per project.
const AFFIRMATIVE_VALUES = new Set(["on", "true", "1"]);
const NEGATIVE_VALUES = new Set(["off", "false", "0"]);

const ACCEPTED_TARGETS = Object.keys(SANCTIONED_WORLD_TARGETS).join(", ");

// Messages are built on one line each: bun's line coverage under-counts the
// continuation lines of multi-line string concatenation.
const unrecognizedFlagMessage = (raw: string): string =>
  `LibreDB Studio: unrecognized ${AGENT_ENABLED_ENV} value "${raw}"; the agent runtime stays off (use "true" to enable)`;

const unsanctionedTargetMessage = (raw: string): string =>
  `LibreDB Studio: unsupported ${AGENT_WORLD_TARGET_ENV} value "${raw}"; the agent runtime accepts only: ${ACCEPTED_TARGETS}`;

const implicitHostedWorldMessage = (): string =>
  `LibreDB Studio: ${HOSTED_DEPLOYMENT_ENV} is set with no ${AGENT_WORLD_TARGET_ENV}; set it explicitly to one of: ${ACCEPTED_TARGETS}`;

/**
 * Whether the agent runtime is enabled. Off unless explicitly turned on; an
 * unrecognised value warns and stays off, so a typo never silently enables it.
 */
export function isAgentRuntimeEnabled(): boolean {
  const raw = process.env[AGENT_ENABLED_ENV];
  if (!raw) return false;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return false;
  if (AFFIRMATIVE_VALUES.has(normalized)) return true;
  if (!NEGATIVE_VALUES.has(normalized)) console.warn(unrecognizedFlagMessage(raw));
  return false;
}

/**
 * The durable-execution backend to run on. Absent selects the zero-config local
 * backend; anything outside the allowlist is refused rather than defaulted.
 */
export function resolveAgentDurableBackend(): AgentDurableBackend {
  const raw = process.env[AGENT_WORLD_TARGET_ENV];

  if (!raw) {
    if (process.env[HOSTED_DEPLOYMENT_ENV]) {
      throw new AgentConfigError(implicitHostedWorldMessage(), "IMPLICIT_HOSTED_WORLD");
    }
    return "local";
  }

  // Own-property check, not a truthiness check on the lookup: the allowlist is
  // an object literal, so it also answers for every member of Object.prototype
  // ("constructor", "toString", ...) and a truthy inherited function would be
  // handed back as if it were a sanctioned backend.
  if (Object.hasOwn(SANCTIONED_WORLD_TARGETS, raw)) return SANCTIONED_WORLD_TARGETS[raw];

  throw new AgentConfigError(unsanctionedTargetMessage(raw), "UNSANCTIONED_WORLD_TARGET");
}

/**
 * The composed configuration. The backend is resolved only when the runtime is
 * enabled: while the flag is off nothing builds a world, so refusing over a
 * variable no code path reads would take the server down for no gain.
 */
export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  if (!isAgentRuntimeEnabled()) return { enabled: false };
  return { enabled: true, backend: resolveAgentDurableBackend() };
}
