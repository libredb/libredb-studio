/**
 * The runtime settings store (docs/GOVERNANCE.md#runtime-settings): the values a control plane set in `settings_v1`,
 * checked against the registry Studio owns (`settings-registry.ts`).
 *
 * Every load of the snapshot passes the rows it read through `validateSettings()`, which keeps the value of each row
 * whose key the registry publishes for the contract in use and whose value is inside that key's domain. Any other row
 * is ignored and becomes a skipped item `{kind: "setting", id: <key>, code: "SETTING_INVALID"}`, which the heartbeat
 * and the admin status report by key and code, never by value. A row whose key is not even a well-formed setting key
 * has no id to report and is only counted, as the loader counts the other rows that break the contract's rules.
 *
 * `runtimeSetting(key)` answers the valid runtime value of a key, or undefined: with governance off, before the first
 * load, and when the control plane set no valid value. On undefined the consumer applies its environment value or the
 * Studio default, as it does without governance, so a valid runtime value wins and prerequisites stay in the
 * environment.
 *
 * The store is pure: it imports no `pg` and no Node built-in, only the registry, the switch and the state holder, so a
 * route handler can read it without pulling the governance pool into its graph. The proxy never reads it
 * (docs/GOVERNANCE.md#runtime-settings): runtime values are applied by route handlers, which
 * tests/unit/governance-proxy-boundary.test.ts pins.
 */
import type { SkippedItem } from "./admission";
import { governanceEnabled } from "./config";
import { SETTING_KEY_PATTERN, SETTINGS_REGISTRY, type SettingDefinition } from "./settings-registry";
import { governanceState, type SettingRow } from "./state";

/** The value type of each key of the registry. */
export interface RuntimeSettingValues {
  "ai.enabled": boolean;
  "agent.enabled": boolean;
  "mcp.enabled": boolean;
  "query.timeoutMs": number;
  "provider.poolMaxPerUser": number;
  "queryLog.statementCapture": "none" | "redacted" | "full";
  "queryLog.maxStatementBytes": number;
  "queryLog.onSinkFailure": "continue" | "refuse";
}

export type SettingKey = keyof RuntimeSettingValues;

type SettingValue = RuntimeSettingValues[SettingKey];

/** What one load made of the rows of `settings_v1`. */
export interface RuntimeSettings {
  /** The valid runtime value of each key a row set. */
  readonly values: ReadonlyMap<string, SettingValue>;
  /** The keys whose rows were ignored, as the heartbeat reports them, in row order and once per key. */
  readonly ignored: readonly SkippedItem[];
  /** The rows ignored without a report, because their key is not a well-formed setting key. */
  readonly malformed: number;
}

/** Where the value of a key comes from at the moment: the control plane, the environment, or Studio's default. */
export type SettingSource = "runtime" | "environment" | "default";

const KEY = new RegExp(SETTING_KEY_PATTERN);

/** True when `value` is inside the domain the registry gives `definition`. */
function inDomain(definition: SettingDefinition, value: unknown): value is SettingValue {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (value as number) >= (definition.min as number) &&
        (value as number) <= (definition.max as number)
      );
    case "string":
      return typeof value === "string" && (definition.allowedValues as readonly string[]).includes(value);
  }
}

/**
 * Checks the rows of one load against the registry, for the contract version in use. Two rows for one key set
 * nothing, because Studio cannot tell which one the control plane meant, and the key is reported once.
 */
export function validateSettings(rows: readonly SettingRow[], contractVersion: number): RuntimeSettings {
  const published = new Map(
    SETTINGS_REGISTRY.filter((definition) => definition.sinceContract <= contractVersion).map((definition) => [
      definition.key,
      definition,
    ]),
  );
  const rowsPerKey = new Map<string, number>();
  let malformed = 0;
  for (const { key } of rows) {
    if (typeof key === "string" && KEY.test(key)) rowsPerKey.set(key, (rowsPerKey.get(key) ?? 0) + 1);
    else malformed += 1;
  }
  const values = new Map<string, SettingValue>();
  const ignored: SkippedItem[] = [];
  for (const { key, value } of rows) {
    if (typeof key !== "string" || !rowsPerKey.has(key)) continue;
    const definition = published.get(key);
    if (definition !== undefined && rowsPerKey.get(key) === 1 && inDomain(definition, value)) {
      values.set(key, value);
    } else if (!ignored.some((item) => item.id === key)) {
      ignored.push({ kind: "setting", id: key, code: "SETTING_INVALID" });
    }
  }
  return { values, ignored, malformed };
}

/**
 * The valid runtime value of `key`, or undefined when governance is off, before the first successful load, or when
 * the control plane set no valid value for it. The last snapshot keeps answering while a later load fails.
 */
export function runtimeSetting<K extends SettingKey>(key: K): RuntimeSettingValues[K] | undefined {
  if (!governanceEnabled()) return undefined;
  return governanceState().snapshot?.settings.values.get(key) as RuntimeSettingValues[K] | undefined;
}

/** Where the value of `definition`'s key comes from: a valid runtime value, else its environment variable or default. */
export function settingSource(definition: SettingDefinition): SettingSource {
  if (runtimeSetting(definition.key as SettingKey) !== undefined) return "runtime";
  return definition.environment === null ? "default" : "environment";
}
