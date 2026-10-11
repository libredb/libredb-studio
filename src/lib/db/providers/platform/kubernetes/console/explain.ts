/**
 * `kubectl explain TYPE[.field.path]` from OpenAPI v3: the index at `/openapi/v3`, then the one group document the
 * resource's group version names, read by its immutable hashed URL and kept in the connection's cache, so a second
 * explain of the same group reads only the index. Both are parsed as JSON whatever their content type, because the
 * index answers `text/plain`. A group document is at most 4 MiB.
 *
 * The grid is FIELD, TYPE and DESCRIPTION: the explained resource or field first, then its fields (their names), or
 * with --recursive every field below it by its full dotted path. Types read as kubectl prints them: `<string>`,
 * `<[]Container>`, `<map[string]string>`, `<Object>`, with `-required-` where the schema requires the field. A
 * schema that refers back to itself is not descended into again, and a type defined through itself, by array items or
 * map values, answers a sentence.
 */
import { QueryError } from "@/lib/db/errors";
import type { IndexedResource } from "../discovery";
import { KubernetesResponseTooLargeError } from "../errors";
import { KUBERNETES_EXPLAIN_DOCUMENT_BYTES, KUBERNETES_MAX_STATEMENT_ROWS, KUBERNETES_TYPE } from "../limits";
import { resolveResource } from "../resolve";
import {
  byCodeUnit,
  type KubectlContext,
  type KubectlGrid,
  objectOf,
  resolveType,
  stringOf,
  textGrid,
} from "./context";
import type { KubectlStatement } from "./parse";

type ExplainStatement = Extract<KubectlStatement, { readonly command: "explain" }>;

type Schema = Readonly<Record<string, unknown>>;

/** How many group documents one connection keeps: a few groups explained in turn need no second read. */
export const EXPLAIN_CACHE_ENTRIES = 8;

const HASH = /[?&]hash=([0-9A-Fa-f]{1,128})(?:&|$)/;

function refuse(message: string): never {
  throw new QueryError(message, KUBERNETES_TYPE);
}

/** The resource at the group version --api-version names, or the resolved one without it. */
async function explainedResource(context: KubectlContext, statement: ExplainStatement): Promise<IndexedResource> {
  if (statement.apiVersion === undefined) return resolveType(context, statement.type);
  const slash = statement.apiVersion.indexOf("/");
  const group = slash === -1 ? "" : statement.apiVersion.slice(0, slash);
  const version = slash === -1 ? statement.apiVersion : statement.apiVersion.slice(slash + 1);
  const resolution = resolveResource(await context.surface.discovery.get(), `${statement.type}.${version}.${group}`);
  if (resolution.kind !== "resource")
    refuse(
      `This server serves no such resource type in ${statement.apiVersion}; list the types with kubectl api-resources.`,
    );
  return resolution.resource;
}

/** The group document's request: its group, version and hash, read from the index's entry for the group version. */
async function groupDocumentAddress(
  context: KubectlContext,
  resource: IndexedResource,
): Promise<{ readonly group: string; readonly version: string; readonly hash: string; readonly key: string }> {
  const index = objectOf(await context.surface.client.json({ op: "openapi-index" }, context.call())) ?? {};
  const key = resource.group === "" ? `api/${resource.version}` : `apis/${resource.group}/${resource.version}`;
  const entry = objectOf(objectOf(index.paths)?.[key]);
  const url = stringOf(entry?.serverRelativeURL);
  const hash = url === undefined ? undefined : HASH.exec(url)?.[1];
  if (hash === undefined)
    refuse(`The server's OpenAPI index lists no hashed document for ${key}, so explain cannot read it.`);
  return { group: resource.group, version: resource.version, hash, key: `${key}?hash=${hash}` };
}

async function groupDocument(context: KubectlContext, resource: IndexedResource): Promise<Schema> {
  const address = await groupDocumentAddress(context, resource);
  const cached = context.explainCache.get(address.key);
  if (cached !== undefined) return cached as Schema;
  let body: unknown;
  try {
    body = await context.surface.client.json(
      { op: "openapi-group", group: address.group, version: address.version, hash: address.hash },
      { ...context.call(), maxResponseBytes: KUBERNETES_EXPLAIN_DOCUMENT_BYTES },
    );
  } catch (error) {
    if (error instanceof KubernetesResponseTooLargeError)
      refuse(`The OpenAPI document for ${address.key.split("?")[0]} is larger than 4 MiB, the most explain reads.`);
    throw error;
  }
  const document = objectOf(body) ?? {};
  context.explainCache.set(address.key, document);
  return document;
}

/** A local `$ref`'s schema name, the last part of `#/components/schemas/<name>`. */
function refName(schema: Schema): string | undefined {
  const direct = stringOf(schema.$ref);
  if (direct !== undefined) return direct.split("/").pop();
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  const first = allOf.length === 1 ? objectOf(allOf[0]) : undefined;
  return first === undefined ? undefined : refName(first);
}

function resolved(schemas: Schema, schema: Schema): Schema {
  const name = refName(schema);
  if (name === undefined) return schema;
  return {
    ...(objectOf(schemas[name]) ?? {}),
    ...(schema.description === undefined ? {} : { description: schema.description }),
  };
}

/** The sentence for a schema whose array items or map values lead back to it, which would never end. */
const EXPLAIN_SELF_TYPE_SENTENCE =
  "The server's OpenAPI document defines a type through itself, so explain cannot print it.";

/**
 * The schema a reference names, the reference's name recorded in `seen`: a chase through array items or map values
 * that meets a name it already followed refers back to itself without end, so it is refused.
 */
function chased(schemas: Schema, schema: Schema, seen: Set<string>): Schema {
  const name = refName(schema);
  if (name !== undefined) {
    if (seen.has(name)) refuse(EXPLAIN_SELF_TYPE_SENTENCE);
    seen.add(name);
  }
  return resolved(schemas, schema);
}

/** The type kubectl prints for a schema, without its angle brackets. */
function typeName(schemas: Schema, schema: Schema, chase = new Set<string>()): string {
  const target = chased(schemas, schema, chase);
  if (target["x-kubernetes-int-or-string"] === true) return "IntOrString";
  const type = stringOf(target.type);
  if (type === "array") return `[]${typeName(schemas, objectOf(target.items) ?? {}, chase)}`;
  if (type === "object" && target.properties === undefined && objectOf(target.additionalProperties) !== undefined)
    return `map[string]${typeName(schemas, objectOf(target.additionalProperties) ?? {}, chase)}`;
  if (type !== undefined && type !== "object") return type;
  const name = refName(schema);
  return name === undefined ? "Object" : (name.split(".").pop() as string);
}

/** The schema a field's own fields come from: through a reference and through an array's items. */
function fieldsSchema(schemas: Schema, schema: Schema, chase = new Set<string>()): Schema {
  const target = chased(schemas, schema, chase);
  return stringOf(target.type) === "array" ? fieldsSchema(schemas, objectOf(target.items) ?? {}, chase) : target;
}

/** The refs a schema stands on, so a recursive walk stops where a schema would repeat. */
function refsOf(schemas: Schema, schema: Schema, chase = new Set<string>()): readonly string[] {
  const target = chased(schemas, schema, chase);
  const own = refName(schema);
  const items = stringOf(target.type) === "array" ? refsOf(schemas, objectOf(target.items) ?? {}, chase) : [];
  return own === undefined ? items : [own, ...items];
}

const describedType = (schemas: Schema, schema: Schema, required: boolean): string =>
  `<${typeName(schemas, schema)}>${required ? " -required-" : ""}`;

const descriptionOf = (schemas: Schema, schema: Schema): string =>
  stringOf(resolved(schemas, schema).description) ?? "";

export async function explain(context: KubectlContext, statement: ExplainStatement): Promise<KubectlGrid> {
  const resource = await explainedResource(context, statement);
  const document = await groupDocument(context, resource);
  const schemas = objectOf(objectOf(document.components)?.schemas) ?? {};
  const rootName = Object.keys(schemas).find((name) => {
    const kinds = objectOf(schemas[name])?.["x-kubernetes-group-version-kind"];
    return (
      Array.isArray(kinds) &&
      kinds.some((entry) => {
        const gvk = objectOf(entry) ?? {};
        return gvk.group === resource.group && gvk.version === resource.version && gvk.kind === resource.kind;
      })
    );
  });
  if (rootName === undefined)
    refuse(
      `The OpenAPI document of ${resource.group === "" ? resource.version : `${resource.group}/${resource.version}`} holds no schema for ${resource.kind}.`,
    );
  let schema: Schema = { $ref: `#/components/schemas/${rootName}` };
  let required = false;
  const seen: string[] = [rootName];
  for (const segment of statement.fieldPath) {
    const parent = fieldsSchema(schemas, schema);
    const child = objectOf(objectOf(parent.properties)?.[segment]);
    if (child === undefined) refuse(`field "${segment}" does not exist`);
    required = Array.isArray(parent.required) && parent.required.includes(segment);
    schema = child;
    seen.push(...refsOf(schemas, child));
  }
  const rows: unknown[][] = [
    [
      [resource.kind, ...statement.fieldPath].join("."),
      describedType(schemas, schema, required),
      descriptionOf(schemas, schema),
    ],
  ];
  const walk = (parent: Schema, prefix: readonly string[], refs: readonly string[]): void => {
    const own = fieldsSchema(schemas, parent);
    const properties = objectOf(own.properties) ?? {};
    const requiredNames = Array.isArray(own.required) ? own.required : [];
    for (const name of Object.keys(properties).sort(byCodeUnit)) {
      const child = objectOf(properties[name]) ?? {};
      const path = [...prefix, name];
      rows.push([
        statement.recursive ? path.join(".") : name,
        describedType(schemas, child, requiredNames.includes(name)),
        descriptionOf(schemas, child),
      ]);
      if (rows.length > KUBERNETES_MAX_STATEMENT_ROWS)
        refuse(
          "explain reaches more than 5,000 fields here: explain a narrower field path, such as pods.spec, instead.",
        );
      const childRefs = refsOf(schemas, child);
      if (statement.recursive && !childRefs.some((ref) => refs.includes(ref)))
        walk(child, path, [...refs, ...childRefs]);
    }
  };
  walk(schema, statement.fieldPath, seen);
  return textGrid(["FIELD", "TYPE", "DESCRIPTION"], rows);
}
