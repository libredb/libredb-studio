/**
 * The one place Secret data is removed, keyed on the REQUEST and not on an object's `kind`: a typed list's items carry
 * no kind and a metadata row says `PartialObjectMetadata`, so a response to a request for core `secrets` is redacted
 * whatever its objects say, and any object whose `kind` is `Secret` is redacted wherever it arrives.
 *
 * Redacted: `data`, `stringData`, the `kubectl.kubernetes.io/last-applied-configuration` annotation (which holds the
 * applied Secret, values included) and `managedFields`. Every object of every response loses `managedFields`, which
 * is bookkeeping a reader never needs. The walk reaches the body itself, a list's `items`, a Table's `rows[].object`
 * and a watch event's `object`, at any depth those nest; it changes the parsed body in place and returns it, before
 * anything is mapped to a cell, a document or a sentence.
 */

export const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";

/** The resource a response answers. */
export interface RedactionTarget {
  readonly group: string;
  readonly resource: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a request reads core Secrets, whose every answer is redacted. */
export function readsSecrets(target: RedactionTarget): boolean {
  return target.group === "" && target.resource === "secrets";
}

function redactObject(object: JsonObject, secrets: boolean): void {
  const metadata = object.metadata;
  if (isObject(metadata)) delete metadata.managedFields;
  if (!secrets && object.kind !== "Secret") return;
  delete object.data;
  delete object.stringData;
  if (isObject(metadata) && isObject(metadata.annotations)) delete metadata.annotations[LAST_APPLIED_ANNOTATION];
}

function visit(value: unknown, secrets: boolean): void {
  if (!isObject(value)) return;
  redactObject(value, secrets);
  if (Array.isArray(value.items)) for (const item of value.items) visit(item, secrets);
  if (Array.isArray(value.rows)) for (const row of value.rows) if (isObject(row)) visit(row.object, secrets);
  if (typeof value.type === "string") visit(value.object, secrets);
}

/** Redacts a parsed response to a request for `target`, in place, and returns it. */
export function redactResponse<T>(target: RedactionTarget, body: T): T {
  visit(body, readsSecrets(target));
  return body;
}
