/**
 * The one core module that evaluates each engine's connection field rules (`fieldRules` and `fieldShownWhen` of its
 * form entry in ./connection-form): the connection dialog reads it before Test Connection and Save send anything, the
 * test-connection path both post to reads it again, over the engine record's field rules, before it opens a tunnel or
 * anything else (`connectionFieldRefusal`, read by `testConnection` in src/lib/api/test-connection.ts), and the open
 * check reads it before any session of any engine opens to connect, for the required secrets (`requiredSecretOf`, read
 * by `assertOpenable` in ./open-check).
 * The rules themselves are data, the projection of each engine's declaration; this module only reads them, so every
 * reader answers the same refusal with the same sentence (docs/providers/CONTRACT.md, clause M-33).
 *
 * UI-free and provider-free: nothing here imports `react`, a component, a provider module or a Node built-in, so the
 * dialog's bundle and the server load the same functions. tests/unit/lib/db/connection-field-rules.test.ts holds its
 * run-time graph.
 */
import type { ConnectionFieldRule, FieldRuleSpec } from "@/lib/db/connection-form";
import type { ConnectionField } from "@/lib/db/connection-fields";
// The storage classification, aliased because ./connection-form's own `CONNECTION_FIELDS` is the field lists: whether
// a field is a credential is answered there once, for storage, the VS Code prompts and a required secret's blank rule.
import { CONNECTION_FIELDS as FIELD_CLASS } from "@/lib/storage/secret-fields";

/**
 * Whether the dialog draws a field the engine takes, by the engine's `fieldShownWhen`: true when the field has no
 * condition, else whether the controlling field holds the declared value. A controlling field left absent (undefined
 * or null) reads as its declared `fieldDefaults` value, the one the provider reads, so Snowflake's absent Sign-in
 * reads as Key pair.
 */
export function connectionFieldShown(
  config: Pick<FieldRuleSpec, "fieldShownWhen" | "fieldDefaults">,
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
 * The first refusal of the engine's `fieldRules` for `values`, a connection's fields, or `undefined` when every declared
 * check passes.
 * `config` is a bundled engine's form entry, or the field rules of a provider package's engine (`packageFieldRules`
 * in ./connection-form). The fields are checked in `connectionFields` order, so the dialog names the first box to fix. A `required` field is
 * refused when it is blank (`ConnectionFieldRule.required`); any other check skips a field that holds no value,
 * absent, null or empty. A field `connectionFieldShown` hides is not checked, since the dialog neither draws nor
 * writes it.
 */
export function connectionFieldRefusal(
  config: FieldRuleSpec,
  values: Readonly<Partial<Record<ConnectionField, unknown>>>,
): string | undefined {
  for (const field of config.connectionFields) {
    const rule = config.fieldRules?.[field];
    if (rule === undefined || !connectionFieldShown(config, field, values)) continue;
    const refusal = ruleRefusal(rule, field, values[field]);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * The refusal of `rule` for `field` holding `value`, or `undefined` when every check of the rule passes: `required`
 * on a blank value (`blankForRequired`) first; then, on a value that holds one, its format, its length range and its
 * named check, in that order.
 */
function ruleRefusal(rule: ConnectionFieldRule, field: ConnectionField, value: unknown): string | undefined {
  if (rule.required !== undefined && blankForRequired(field, value)) return rule.required;
  if (holdsNoValue(value)) return undefined;
  const text = String(value);
  if (rule.format !== undefined && !rule.format.pattern.test(text)) return rule.format.sentence;
  if (rule.charRange !== undefined && (text.length < rule.charRange.min || text.length > rule.charRange.max)) {
    return rule.charRange.sentence;
  }
  return rule.check?.(text);
}

/**
 * The sentence of the first required secret `config` declares that `values`, a connection's fields, shows and leaves
 * blank, or `undefined` when there is none. `config` is an engine record's field rules (`fieldRules`), a bundled
 * engine's form entry or a provider package's engine's (`packageFieldRules` in ./connection-form). A required secret is
 * a `fieldRules` entry with `required` on a field the storage classification calls `secret`, shown by
 * `connectionFieldShown` (an absent controlling field read as its `fieldDefaults` value), and blank as
 * `connectionFieldRefusal` reads it, not text or only whitespace. The fields are read in `connectionFields` order, and
 * only these: every other rule is the dialog's and the provider's. The one ordered open check reads it over every
 * engine's record before an open that may connect (`assertOpenable` in ./open-check).
 */
export function requiredSecretOf(
  config: FieldRuleSpec,
  values: Readonly<Partial<Record<ConnectionField, unknown>>>,
): string | undefined {
  for (const field of config.connectionFields) {
    const required = config.fieldRules?.[field]?.required;
    if (required === undefined || FIELD_CLASS[field] !== "secret") continue;
    if (!connectionFieldShown(config, field, values)) continue;
    if (blankForRequired(field, values[field])) return required;
  }
  return undefined;
}
