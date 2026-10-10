/**
 * The one place Secret data is removed, keyed on the REQUEST and not on an object's `kind`: a typed list's items carry
 * no kind and a metadata row says `PartialObjectMetadata`, so a response to a request for core `secrets` is redacted
 * whatever its objects say, and any object whose `kind` is `Secret` is redacted wherever it arrives.
 *
 * Redacted: `data`, `stringData`, the `kubectl.kubernetes.io/last-applied-configuration` annotation (which holds the
 * applied Secret, values included) and `managedFields`. A deploy tool may keep its own copy of the applied Secret in
 * an annotation of its own (kapp's `kapp.k14s.io/original`), so every other annotation value of a Secret that is not
 * short plain text, or that names a `data` or `stringData` key, is replaced by a marker; its key stays. Every object
 * of every response loses `managedFields`, which is bookkeeping a reader never needs.
 *
 * The walk reaches the body itself, a list's `items`, a Table's `rows[].object` and a watch event's `object`, as deep
 * as those nest up to a cap no real response comes near; deeper is refused, never read past. It changes the parsed
 * body in place and returns it, before anything is mapped to a cell, a document or a sentence.
 */
import { QueryError } from "@/lib/db/errors";
import { KUBERNETES_TYPE } from "./limits";

export const LAST_APPLIED_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";
/** What a Secret's annotation value is replaced with when it could hold the Secret's values. */
export const REMOVED_ANNOTATION_VALUE = "(removed by Studio)";
/** The longest annotation value of a Secret that is kept as it is. */
export const SECRET_ANNOTATION_MAX_CHARS = 128;
/** A `data` or `stringData` key in a JSON or YAML copy of an object; `metadata` does not match. */
const DATA_KEY = /\b(?:string)?data\b/i;
/**
 * How deep the walk follows `items`, `rows[].object` and a watch event's `object`. A real response nests about three
 * levels (a watch event, its Table, a row's object); a hostile one nested thousands deep would overflow a recursion.
 */
export const MAX_RESPONSE_NESTING = 8;

const NESTED_TOO_DEEP_SENTENCE =
  "The API server answered with objects nested deeper than any Kubernetes response, so Studio shows nothing of it.";

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
  if (!isObject(metadata) || !isObject(metadata.annotations)) return;
  const annotations = metadata.annotations;
  delete annotations[LAST_APPLIED_ANNOTATION];
  for (const [key, value] of Object.entries(annotations)) {
    if (typeof value !== "string" || value.length > SECRET_ANNOTATION_MAX_CHARS || DATA_KEY.test(value))
      annotations[key] = REMOVED_ANNOTATION_VALUE;
  }
}

/** The objects a value nests: a list's items, a Table's row objects and a watch event's object. */
function children(value: JsonObject): unknown[] {
  const found: unknown[] = [];
  // One push per item: a spread of a list of a million items would pass a million arguments.
  if (Array.isArray(value.items)) for (const item of value.items) found.push(item);
  if (Array.isArray(value.rows)) for (const row of value.rows) if (isObject(row)) found.push(row.object);
  if (typeof value.type === "string") found.push(value.object);
  return found;
}

/** Redacts a parsed response to a request for `target`, in place, and returns it. */
export function redactResponse<T>(target: RedactionTarget, body: T): T {
  const secrets = readsSecrets(target);
  // An explicit stack, so the depth is checked rather than left to the call stack.
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value: body, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (!isObject(value)) continue;
    if (depth > MAX_RESPONSE_NESTING) throw new QueryError(NESTED_TOO_DEEP_SENTENCE, KUBERNETES_TYPE);
    redactObject(value, secrets);
    for (const child of children(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return body;
}
