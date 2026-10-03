/**
 * The filters the Milvus provider composes and the expression-template values it sends (vector-family spec 5.4,
 * E12). Pure, and reached from the browser through request.ts.
 *
 * Every value Studio puts into a filter travels as a template value, never concatenated into the filter text: ids
 * become `pk in {ids}` with one array value, so an id holding a quote is one value that matches nothing else (R45
 * F3), and an integer travels as `int64_val` built from validated digits, because proto-loader wraps
 * `9223372036854775808` to its negative and turns `abc`, `1.5`, ` 12` and `007` into numbers without an error
 * (R40 M2).
 */
import type { MilvusInt64, WireTemplateValue } from "./client";

const INT64_DIGITS = /^(0|-?[1-9][0-9]{0,18})$/;
const INT64_MIN = BigInt("-9223372036854775808");
const INT64_MAX = BigInt("9223372036854775807");

/** `text` when it is the canonical decimal of an Int64, undefined otherwise (E12). */
export function int64Digits(text: string): MilvusInt64 | undefined {
  if (!INT64_DIGITS.test(text)) return undefined;
  const value = BigInt(text);
  return value < INT64_MIN || value > INT64_MAX ? undefined : text;
}

/** A name Milvus's filter grammar reads bare, and the rule for a template name and a dynamic projection (5.4). */
export const FILTER_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/** One validated template value; request.ts builds it, and only from what the user typed. */
export type TemplateParam =
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int64"; readonly digits: MilvusInt64 }
  | { readonly kind: "double"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool-array"; readonly values: readonly boolean[] }
  | { readonly kind: "int64-array"; readonly values: readonly MilvusInt64[] }
  | { readonly kind: "double-array"; readonly values: readonly number[] }
  | { readonly kind: "string-array"; readonly values: readonly string[] };

export function templateValue(param: TemplateParam): WireTemplateValue {
  switch (param.kind) {
    case "bool":
      return { bool_val: param.value };
    case "int64":
      return { int64_val: param.digits };
    case "double":
      return { float_val: param.value };
    case "string":
      return { string_val: param.value };
    case "bool-array":
      return { array_val: { bool_data: { data: param.values } } };
    case "int64-array":
      return { array_val: { long_data: { data: param.values } } };
    case "double-array":
      return { array_val: { double_data: { data: param.values } } };
    case "string-array":
      return { array_val: { string_data: { data: param.values } } };
  }
}

/** The request's `expr_template_values`, built on a null-prototype object. */
export function templateValues(params: Readonly<Record<string, TemplateParam>>): Record<string, WireTemplateValue> {
  const values: Record<string, WireTemplateValue> = Object.create(null);
  for (const name of Object.keys(params)) values[name] = templateValue(params[name]);
  return values;
}

/** The template name of an `entities/get` filter; the route takes no exprParams, so it cannot collide. */
const IDS_TEMPLATE = "ids";

export type TypedIds =
  | { readonly kind: "int64"; readonly values: readonly MilvusInt64[] }
  | { readonly kind: "string"; readonly values: readonly string[] };

/** `<pk> in {ids}` with the ids as one array value: long_data for an Int64 key, string_data for VarChar (E12). */
export function idsFilter(
  primaryKey: string,
  ids: TypedIds,
): { readonly expr: string; readonly values: Record<string, WireTemplateValue> } {
  if (!FILTER_IDENTIFIER.test(primaryKey)) {
    throw new TypeError(`The primary key ${JSON.stringify(primaryKey)} cannot be written bare in a filter`);
  }
  const param: TemplateParam =
    ids.kind === "int64" ? { kind: "int64-array", values: ids.values } : { kind: "string-array", values: ids.values };
  return { expr: `${primaryKey} in {${IDS_TEMPLATE}}`, values: templateValues({ [IDS_TEMPLATE]: param }) };
}
