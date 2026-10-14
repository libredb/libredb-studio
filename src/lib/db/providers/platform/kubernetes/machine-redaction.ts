/**
 * What the agent's read of a cluster may not carry, masked on the OUTPUT PROJECTION: the copy of an object a cell, a
 * document or a describe row is written from, never the parsed body the console routes on. `logs` still chooses its
 * container from the default-container annotation and `describe` still finds a Secret's events by its real name,
 * because both read the body this module never touches.
 *
 * Structural, not by path: a rule matches a field by its shape wherever it sits, so a pod spec inside a Deployment's
 * template, a PodTemplate, a ControllerRevision's `data` or a custom resource is masked like a Pod's own. Values are
 * masked and keys kept (A1, A5): env values, probe and hook header values, a container's command and args, exec
 * commands, every annotation value and ConfigMap data. Labels pass, keys and values. Names pass, except a Secret's
 * (A4), which `maskSecretNames` handles. What no rule reaches is the stated residue (`docs/providers/kubernetes.md`
 * section 9): log lines and event messages, status and condition messages, label values, and custom-resource fields
 * with no rule.
 *
 * Only the agent's read path calls it; `query()` never does, so the editor's output is byte for byte what it was.
 */
import { QueryError } from "@/lib/db/errors";
import { KUBERNETES_TYPE } from "./limits";
import { MACHINE_REDACTED, type RedactionTarget } from "./redaction";

/** How deep an object is walked; a real one nests far less, and deeper is refused, never read past. */
export const MACHINE_MAX_NESTING = 64;

const NESTED_TOO_DEEP_SENTENCE =
  "The API server answered with an object nested deeper than any Kubernetes object, so Studio shows nothing of it.";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every value of a string map masked, every key kept. */
function maskedValues(map: Json): Json {
  return Object.fromEntries(Object.keys(map).map((key) => [key, MACHINE_REDACTED]));
}

/** Every element of an array field masked, its length kept. */
function maskElements(node: Json, key: string): void {
  const value = node[key];
  if (Array.isArray(value)) node[key] = value.map(() => MACHINE_REDACTED);
}

/** Whether a request reads core ConfigMaps, whose data is masked whether or not each item carries its kind. */
function readsConfigMaps(target: RedactionTarget): boolean {
  return target.group === "" && target.resource === "configmaps";
}

/** The value rules, applied to one node whose children are already masked copies. */
function maskValues(node: Json): void {
  if (Array.isArray(node.env))
    node.env = node.env.map((entry) =>
      isObject(entry) && typeof entry.name === "string" && "value" in entry
        ? { ...entry, value: MACHINE_REDACTED }
        : entry,
    );
  if (Array.isArray(node.httpHeaders))
    node.httpHeaders = node.httpHeaders.map((header) =>
      isObject(header) && "value" in header ? { ...header, value: MACHINE_REDACTED } : header,
    );
  // A container is the object that names an image: its command and args are what it runs with, credentials included.
  if (typeof node.image === "string") {
    maskElements(node, "command");
    maskElements(node, "args");
  }
  if (isObject(node.exec)) maskElements(node.exec, "command");
  if (isObject(node.metadata) && isObject(node.metadata.annotations))
    node.metadata = { ...node.metadata, annotations: maskedValues(node.metadata.annotations) };
}

/** A masked deep copy: children first, then the rules on the copy. */
function walk(value: unknown, depth: number, rules: (node: Json) => void): unknown {
  if (depth > MACHINE_MAX_NESTING) throw new QueryError(NESTED_TOO_DEEP_SENTENCE, KUBERNETES_TYPE);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, rules));
  if (!isObject(value)) return value;
  const copy: Json = {};
  for (const [key, child] of Object.entries(value)) copy[key] = walk(child, depth + 1, rules);
  rules(copy);
  return copy;
}

export function maskObjectForMachine(target: RedactionTarget, object: Readonly<Record<string, unknown>>): Json {
  const masked = walk(object, 0, maskValues) as Json;
  if (readsConfigMaps(target) || masked.kind === "ConfigMap") {
    for (const field of ["data", "binaryData"] as const) {
      const map = masked[field];
      if (isObject(map)) masked[field] = maskedValues(map);
    }
  }
  return masked;
}
