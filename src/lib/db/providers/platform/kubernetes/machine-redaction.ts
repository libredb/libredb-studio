/**
 * What the agent's read of a cluster may not carry, masked on the OUTPUT PROJECTION: the copy of an object a cell, a
 * document or a describe row is written from, never the parsed body the console routes on. `logs` still chooses its
 * container from the default-container annotation and `describe` still finds a Secret's events by its real name,
 * because both read the body this module never touches.
 *
 * Structural, not by path: a rule matches a field by its shape wherever it sits, so a pod spec inside a Deployment's
 * template, a PodTemplate, a ControllerRevision's `data` or a custom resource is masked like a Pod's own. Values are
 * masked and keys kept (A1, A5): env values, probe and hook header values, a container's command and args, exec
 * commands, every annotation value, and the data of every ConfigMap and Secret, embedded ones included (`maskByKind`).
 * Labels pass, keys and values. Names pass, except a Secret's (A4), which `maskSecretNames` handles: every
 * `secretName` string, the `name` of a `secretRef`, `secretKeyRef`, `secret` or any `*SecretRef`, each
 * `imagePullSecrets` and ServiceAccount `secrets` entry, an owner, involved, regarding or related reference whose kind
 * is `Secret`, and the `resourceNames` of an RBAC rule that reaches core Secrets (`coversSecrets`). An object's own
 * name is masked when its kind is `Secret`, at any depth; the root's also when the request reads core Secrets, and an
 * Event's about a Secret, because the server derives the Event's name from the Secret's.
 * What no rule reaches is the stated residue (`docs/providers/kubernetes.md` section 9): log lines and event messages,
 * status and condition messages, label values, and custom-resource fields with no rule.
 *
 * Only the agent's read path calls it; `query()` never does, so the editor's output is byte for byte what it was.
 */
import { QueryError } from "@/lib/db/errors";
import { builtInKind } from "./kinds";
import { KUBERNETES_TYPE } from "./limits";
import { MACHINE_REDACTED, type RedactionTarget, readsSecrets } from "./redaction";
import type { KubeTable } from "./table";

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

/** A map field's values masked, its keys kept; a field present but not a map has no keys, so it becomes the marker. */
function maskMapFields(node: Json, fields: readonly string[]): void {
  for (const field of fields) {
    const map = node[field];
    if (isObject(map)) node[field] = maskedValues(map);
    else if (map !== undefined) node[field] = MACHINE_REDACTED;
  }
}

const CONFIG_MAP_FIELDS = ["data", "binaryData"] as const;
const SECRET_FIELDS = ["data", "stringData"] as const;

/**
 * The kind rules, applied to every node that says what it is: a ConfigMap or a Secret embedded in another object (a
 * policy's generate template, a Crossplane `Object` manifest, a chart's values) is masked as a root one is. A Secret's
 * own name goes with its values, because a manifest that creates a Secret names it.
 */
function maskByKind(node: Json): void {
  if (node.kind === "ConfigMap") maskMapFields(node, CONFIG_MAP_FIELDS);
  if (node.kind !== "Secret") return;
  maskMapFields(node, SECRET_FIELDS);
  if (isObject(node.metadata) && typeof node.metadata.name === "string")
    node.metadata = { ...node.metadata, name: MACHINE_REDACTED };
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

/** The reference fields whose `name` is a Secret's: `secretRef`, `secretKeyRef`, `secret` and every `*SecretRef`. */
function namesASecret(key: string): boolean {
  return key === "secretRef" || key === "secretKeyRef" || key === "secret" || key.endsWith("SecretRef");
}

/** The arrays whose elements' `name` is a Secret's. */
const SECRET_NAME_LISTS = ["imagePullSecrets", "secrets"] as const;

/** An object reference (owner, involved, regarding, related) with its name masked when it names a Secret. */
function maskedReference(reference: unknown): unknown {
  return isObject(reference) && reference.kind === "Secret" && typeof reference.name === "string"
    ? { ...reference, name: MACHINE_REDACTED }
    : reference;
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Whether an RBAC rule reaches core Secrets: its resources name `secrets`, a Secret subresource or `*`, and its groups
 * are the core group, `*`, or absent (a hand-written rule with no `apiGroups` is read as the core group).
 */
export function coversSecrets(rule: Readonly<Record<string, unknown>>): boolean {
  const groups = rule.apiGroups === undefined ? [""] : strings(rule.apiGroups);
  const resources = strings(rule.resources);
  return (
    groups.some((group) => group === "" || group === "*") &&
    resources.some((resource) => resource === "*" || resource === "secrets" || resource.startsWith("secrets/"))
  );
}

/** The Secret-name rules, applied to one node whose children are already masked copies. */
function maskSecretNames(node: Json): void {
  if (typeof node.secretName === "string") node.secretName = MACHINE_REDACTED;
  for (const [key, value] of Object.entries(node)) {
    if (namesASecret(key) && isObject(value) && typeof value.name === "string")
      node[key] = { ...value, name: MACHINE_REDACTED };
  }
  // The entries are the walk's own copies, so they are masked in place.
  for (const key of SECRET_NAME_LISTS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (isObject(entry) && typeof entry.name === "string") entry.name = MACHINE_REDACTED;
  }
  if (Array.isArray(node.ownerReferences)) node.ownerReferences = node.ownerReferences.map(maskedReference);
  for (const key of ["involvedObject", "regarding", "related"] as const) {
    if (key in node) node[key] = maskedReference(node[key]);
  }
  if (Array.isArray(node.rules))
    node.rules = node.rules.map((rule) =>
      isObject(rule) && coversSecrets(rule) && Array.isArray(rule.resourceNames)
        ? { ...rule, resourceNames: rule.resourceNames.map(() => MACHINE_REDACTED) }
        : rule,
    );
}

/** Whether an Event is about a Secret, whose own name the server derives from the Secret's. */
function aboutASecret(object: Json): boolean {
  return [object.involvedObject, object.regarding].some(
    (reference) => isObject(reference) && reference.kind === "Secret",
  );
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
  // Read before the walk: the walk replaces `involvedObject` with a copy whose name is already masked.
  const eventAboutASecret = aboutASecret(object);
  const masked = walk(object, 0, (node) => {
    maskValues(node);
    maskSecretNames(node);
    maskByKind(node);
  }) as Json;
  // A typed list's items carry no kind, so the request target says what they are.
  if (readsConfigMaps(target)) maskMapFields(masked, CONFIG_MAP_FIELDS);
  const nameIsASecret = readsSecrets(target) || eventAboutASecret;
  if (nameIsASecret && isObject(masked.metadata) && typeof masked.metadata.name === "string")
    masked.metadata = { ...masked.metadata, name: MACHINE_REDACTED };
  return masked;
}

/** Whether a resource prints the columns of a built-in kind Studio knows; anything else prints columns its author chose. */
function printsKnownColumns(target: RedactionTarget): boolean {
  const entry = builtInKind(target.resource);
  return entry !== undefined && entry.group === target.group;
}

/** The columns a custom resource's Table keeps for the agent: the rest is whatever its printer chose to show. */
const CUSTOM_RESOURCE_COLUMNS: ReadonlySet<string> = new Set(["Name", "Age"]);

const SECRET_OBJECT_CELL = /^secret\//i;

/**
 * A Table as the agent may receive it. A Table row carries cells, not an object, so the cells are masked by what the
 * request targeted: a Secret list's names; an event's Object cell (`secret/NAME`, the server's own printed form) and
 * the event's name, which the server derives from it; and, for a custom resource or an aggregated API, every column
 * but Name and Age, because its printer columns can echo any field. Its full fields stay readable through `-o yaml`
 * under the object rules. Each row's object (`includeObject=Metadata`) is masked by those rules too.
 *
 * The Object cell is the only place an event Table names its involved kind: `includeObject=Metadata` carries the
 * event's metadata and never its `involvedObject`. The column name `Object` and the `kind/name` cell form were
 * measured on v1.35.5 (`tests/fixtures/kubernetes/v1.35.5/viewer.json`, cells like `pod/crasher`).
 */
export function maskTableForMachine(target: RedactionTarget, table: KubeTable): KubeTable {
  const secrets = readsSecrets(target);
  const events = target.resource === "events";
  const known = printsKnownColumns(target);
  const kept = table.columns.map((column) => known || CUSTOM_RESOURCE_COLUMNS.has(column.name));
  const nameAt = table.columns.findIndex((column) => column.name === "Name");
  const objectAt = table.columns.findIndex((column) => column.name === "Object");
  const rows = table.rows.map((row) => {
    const objectCell = row.cells[objectAt];
    const aboutASecret = events && typeof objectCell === "string" && SECRET_OBJECT_CELL.test(objectCell);
    const cells = row.cells
      .map((cell, index) => {
        if ((secrets || aboutASecret) && index === nameAt) return MACHINE_REDACTED;
        if (aboutASecret && index === objectAt) return `${(objectCell as string).split("/")[0]}/${MACHINE_REDACTED}`;
        return cell;
      })
      .filter((_cell, index) => kept[index]);
    if (row.object === undefined) return { ...row, cells };
    const object = maskObjectForMachine(target, row.object);
    // The row's metadata names no involved object, so only the Object cell says this event's name derives from a Secret.
    if (aboutASecret && isObject(object.metadata) && typeof object.metadata.name === "string")
      object.metadata = { ...object.metadata, name: MACHINE_REDACTED };
    return { ...row, cells, object };
  });
  return { ...table, columns: table.columns.filter((_column, index) => kept[index]), rows };
}
