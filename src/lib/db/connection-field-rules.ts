/**
 * The one core module that evaluates each engine's connection field rules (`fieldRules` and `fieldShownWhen` of its
 * form entry in ./connection-form): the connection dialog reads it before Test Connection and Save send anything, the
 * test-connection path both post to reads it again before it opens a tunnel or builds a provider (`fieldRuleRefusal`,
 * read by `testConnection` in src/lib/api/test-connection.ts), and core reads it before it builds a provider to
 * connect, for the required secrets. The rules themselves are data, the projection of each engine's declaration; this
 * module only reads them, so every reader answers the same refusal with the same sentence
 * (docs/providers/CONTRACT.md, clause M-33).
 *
 * UI-free and provider-free: nothing here imports `react`, a component, a provider module or a Node built-in, so the
 * dialog's bundle and the server load the same functions. tests/unit/lib/db/connection-field-rules.test.ts holds its
 * run-time graph.
 */
import { CONNECTION_FORM, type ConnectionFormSpec } from "@/lib/db/connection-form";
import type { ConnectionField } from "@/lib/db/connection-fields";
import { typeIdRow } from "@/lib/db/type-id";
// The storage classification, aliased because ./connection-form's own `CONNECTION_FIELDS` is the field lists: whether
// a field is a credential is answered there once, for storage, the VS Code prompts and a required secret's blank rule.
import { CONNECTION_FIELDS as FIELD_CLASS } from "@/lib/storage/secret-fields";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * Whether the dialog draws a field the engine takes, by the engine's `fieldShownWhen`: true when the field has no
 * condition, else whether the controlling field holds the declared value. A controlling field left absent (undefined
 * or null) reads as its declared `fieldDefaults` value, the one the provider reads, so Snowflake's absent Sign-in
 * reads as Key pair.
 */
export function connectionFieldShown(
  config: ConnectionFormSpec,
  field: ConnectionField,
  connection: Partial<Record<ConnectionField, unknown>>,
): boolean {
  const condition = config.fieldShownWhen?.[field];
  if (condition === undefined) return true;
  const value = connection[condition.field] ?? config.fieldDefaults?.[condition.field];
  return value !== undefined && String(value) === condition.equals;
}

/**
 * Whether a field holds no value: absent, null or empty. Every provider's text reader reads null as absent, as
 * `connectionFieldShown` does, so a field holding null is checked by no rule but `required`.
 */
function holdsNoValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Whether `value` is blank for the `required` rule of `field`: for a field the storage classification calls `secret`,
 * a value that is not text or holds only whitespace, as the provider reads a secret it cannot sign in without; for any
 * other field, no value (`holdsNoValue`).
 */
function blankForRequired(field: ConnectionField, value: unknown): boolean {
  if (FIELD_CLASS[field] === "secret") return typeof value !== "string" || value.trim() === "";
  return holdsNoValue(value);
}

/**
 * The first refusal of the engine's `fieldRules` for a connection, or `undefined` when every declared check passes.
 * The fields are checked in `connectionFields` order, so the dialog names the first box to fix. A `required` field is
 * refused when it is blank (`ConnectionFieldRule.required`); any other check skips a field that holds no value,
 * absent, null or empty. A field `connectionFieldShown` hides is not checked, since the dialog neither draws nor
 * writes it.
 */
export function connectionFieldRefusal(config: ConnectionFormSpec, connection: DatabaseConnection): string | undefined {
  const values = connection as Partial<Record<ConnectionField, unknown>>;
  for (const field of config.connectionFields) {
    const rule = config.fieldRules?.[field];
    if (rule === undefined) continue;
    if (!connectionFieldShown(config, field, values)) continue;
    const value = values[field];
    if (rule.required !== undefined && blankForRequired(field, value)) return rule.required;
    if (holdsNoValue(value)) continue;
    if (rule.format !== undefined && !rule.format.pattern.test(String(value))) return rule.format.sentence;
    if (
      rule.charRange !== undefined &&
      (String(value).length < rule.charRange.min || String(value).length > rule.charRange.max)
    ) {
      return rule.charRange.sentence;
    }
    const checked = rule.check?.(String(value));
    if (checked !== undefined) return checked;
  }
  return undefined;
}

/**
 * The first refusal of the field rules of `type`'s form entry for `connection`, or `undefined` when every declared
 * check passes: `connectionFieldRefusal` on that entry, the dialog's own answer, read on the server path Test
 * Connection and Save post to. The entry is read through `typeIdRow` (FND-1), so a type outside the `DatabaseType`
 * union is refused by name.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function fieldRuleRefusal(type: DatabaseType, connection: DatabaseConnection): string | undefined {
  return connectionFieldRefusal(typeIdRow(CONNECTION_FORM, type), connection);
}

/**
 * The sentence of the first required secret the engine's form entry declares that `connection` shows and leaves blank,
 * or `undefined` when there is none: a `fieldRules` entry with `required` on a field the storage classification calls
 * `secret`, shown by `connectionFieldShown` (an absent controlling field read as its `fieldDefaults` value), and blank
 * as `connectionFieldRefusal` reads it, not text or only whitespace. The fields are read in `connectionFields` order,
 * and only these: every other rule is the dialog's and the provider's. Core reads it before it builds a provider to
 * connect (`createDatabaseProvider` in ./factory), so a provider is never built without a secret its engine declares
 * it cannot sign in without. The entry is read through `typeIdRow` (FND-1), so a type outside the `DatabaseType` union
 * is refused by name.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 */
export function requiredSecretRefusal(type: DatabaseType, connection: DatabaseConnection): string | undefined {
  const config = typeIdRow(CONNECTION_FORM, type);
  const values = connection as Partial<Record<ConnectionField, unknown>>;
  for (const field of config.connectionFields) {
    const required = config.fieldRules?.[field]?.required;
    if (required === undefined || FIELD_CLASS[field] !== "secret") continue;
    if (!connectionFieldShown(config, field, values)) continue;
    if (blankForRequired(field, values[field])) return required;
  }
  return undefined;
}
