/**
 * The runtime settings registry of governance contract v1 (docs/GOVERNANCE.md#runtime-settings).
 *
 * These are the only keys a control plane may set for Studio at runtime. The registry is Studio's: a control plane
 * seeds its allowlist from the published manifest (`tests/fixtures/governance/contract-v1.json`), which is generated
 * from this list, and refuses any other key. Security posture (sign-in, keys, session lifetime, custom connections,
 * CSP, HSTS) is never a runtime setting and stays in the environment.
 *
 * Pure data with no import, so the settings store, the admin status and the manifest generator can all read it
 * without loading a database driver. A later key is appended here under the same contract version, as
 * docs/GOVERNANCE.md#versioning-and-upgrade-order allows, and the manifest is regenerated in the same commit.
 */

/** A runtime setting key as the allowlist's CHECK accepts it: dotted segments, each starting with a lowercase letter. */
export const SETTING_KEY_PATTERN = "^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)+$";

/** One allowlisted key. Exactly one of `default` and `environment` is set. */
export interface SettingDefinition {
  readonly key: string;
  readonly type: "boolean" | "integer" | "string";
  /** The closed set a string value must come from; null for the other types. */
  readonly allowedValues: readonly string[] | null;
  /** Inclusive integer bounds; null for the other types. */
  readonly min: number | null;
  readonly max: number | null;
  /** What Studio uses when no valid runtime value is set and the key has no environment counterpart. */
  readonly default: boolean | number | string | null;
  /** The environment variable that decides the value when no valid runtime value is set. */
  readonly environment: string | null;
  /** The part of Studio that reads the value. */
  readonly consumer: string;
  /** The first contract version that publishes the key; `settings_v1` exposes keys up to its own version. */
  readonly sinceContract: number;
  /**
   * The description a control plane shows next to the key, which the manifest publishes
   * (docs/GOVERNANCE.md#runtime-settings).
   */
  readonly description: string;
}

export const SETTINGS_REGISTRY: readonly SettingDefinition[] = [
  {
    key: "ai.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: true,
    environment: null,
    consumer: "guardRoute for the routes of the ai bucket, which answer 403 AI_DISABLED while the value is false",
    sinceContract: 1,
    description: "AI assistance routes are available",
  },
  {
    key: "agent.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: null,
    environment: "LIBREDB_AGENT_ENABLED",
    consumer: "readAgentEnableFlag, which still needs a configured model",
    sinceContract: 1,
    description: "The query agent is available when its prerequisites are configured",
  },
  {
    key: "mcp.enabled",
    type: "boolean",
    allowedValues: null,
    min: null,
    max: null,
    default: null,
    environment: "LIBREDB_MCP_ENABLED",
    consumer: "readMcpSwitch, re-verified by the MCP route on every request",
    sinceContract: 1,
    description: "The MCP endpoint is available when its prerequisites are configured",
  },
  {
    key: "query.timeoutMs",
    type: "integer",
    allowedValues: null,
    min: 1000,
    max: 3600000,
    default: 60000,
    environment: null,
    consumer: "The queryTimeout of every governed connection",
    sinceContract: 1,
    description: "Statement timeout applied to governed connections",
  },
  {
    key: "provider.poolMaxPerUser",
    type: "integer",
    allowedValues: null,
    min: 1,
    max: 10,
    default: 3,
    environment: null,
    consumer: "The pool size of per-user providers, applied to providers created after the change",
    sinceContract: 1,
    description: "Maximum pooled database sessions per user and connection",
  },
  {
    key: "queryLog.statementCapture",
    type: "string",
    allowedValues: ["none", "redacted", "full"],
    min: null,
    max: null,
    default: "none",
    environment: null,
    consumer: "The query event builder, and the notice the editor shows when the value is full",
    sinceContract: 1,
    description: "What Studio records of a statement in bridge.query_events_v1",
  },
  {
    key: "queryLog.maxStatementBytes",
    type: "integer",
    allowedValues: null,
    min: 256,
    max: 65536,
    default: 4096,
    environment: null,
    consumer: "The query event builder, which truncates a captured statement to this many UTF-8 bytes",
    sinceContract: 1,
    description: "UTF-8 byte cap applied to a captured statement before insert",
  },
  {
    key: "queryLog.onSinkFailure",
    type: "string",
    allowedValues: ["continue", "refuse"],
    min: null,
    max: null,
    default: "continue",
    environment: null,
    consumer: "The admission gate that runs before every recorded execution",
    sinceContract: 1,
    description: "Whether Studio keeps executing while it cannot record query events",
  },
];
