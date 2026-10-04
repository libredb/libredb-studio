/**
 * What the Qdrant console's request rules hold against the vendor's pinned sources (QE10, QE11, QE21), derived by
 * tests/live/qdrant-openapi.ts and committed as tests/fixtures/qdrant/openapi-schemas.json. Pure, so
 * tests/unit/db/qdrant/openapi-derive.test.ts holds every rule over small inputs.
 *
 * - From the OpenAPI document at tag v1.19.1, pinned by its sha256: the 17 v1 operations with their method, path,
 *   query keys, body schema and that schema's required keys, and every schema a v1 request body reaches, as its
 *   keys and required keys (an object), its members (a union) or its words (an enumeration).
 * - From src/common/inference/local_model.rs at the same tag, pinned by its sha256: the model names the server
 *   runs itself.
 */
import { QDRANT_SPEC_SHA256, QDRANT_V1_OPERATIONS } from "./vector-route-tables";

export const QDRANT_LOCAL_MODEL_SHA256 = "ae34fad41bbea91df7f8fd6d552e9c664073a60ba60771cf24ade7862c59fe74";

export interface OperationFacts {
  readonly method: string;
  readonly path: string;
  readonly query: readonly string[];
  /** The schema the body references, or null where the operation takes no body. */
  readonly bodySchema: string | null;
  /** That schema's `required` array, empty where it has none. */
  readonly required: readonly string[];
}

export interface ObjectFacts {
  readonly keys: readonly string[];
  readonly required: readonly string[];
}

export interface QdrantOpenApiFacts {
  readonly $generated: {
    readonly by: string;
    readonly source: string;
    readonly sha256: string;
    readonly localModelSource: string;
    readonly localModelSha256: string;
  };
  readonly operations: Readonly<Record<string, OperationFacts>>;
  readonly objects: Readonly<Record<string, ObjectFacts>>;
  readonly unions: Readonly<Record<string, readonly string[]>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly localModels: readonly string[];
}

interface Schema {
  readonly $ref?: string;
  readonly type?: string;
  readonly format?: string;
  readonly nullable?: boolean;
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly additionalProperties?: boolean | Schema;
}

interface Operation {
  readonly operationId?: string;
  readonly parameters?: readonly { readonly name: string; readonly in: string }[];
  readonly requestBody?: { readonly content?: Readonly<Record<string, { readonly schema?: Schema }>> };
}

const PREFIX = "#/components/schemas/";
const METHODS = ["get", "put", "post", "delete", "patch"];

const named = (schema: Schema): string | undefined =>
  schema.$ref === undefined ? undefined : schema.$ref.slice(PREFIX.length);

/** One member of a union as a word: a schema's name, or the shape of an inline member. */
function member(schema: Schema): string {
  const name = named(schema);
  if (name !== undefined) return name;
  if (schema.type === "array") return `array of ${schema.items === undefined ? "anything" : member(schema.items)}`;
  if (schema.type === "object") return "object";
  if (schema.type !== undefined) return schema.format === undefined ? schema.type : `${schema.type} (${schema.format})`;
  return schema.nullable === true ? "null" : "anything";
}

/** Every schema name a schema refers to, at any depth. */
function references(schema: Schema, into: Set<string>): void {
  const name = named(schema);
  if (name !== undefined) into.add(name);
  for (const property of Object.values(schema.properties ?? {})) references(property, into);
  if (schema.items !== undefined) references(schema.items, into);
  for (const option of schema.anyOf ?? []) references(option, into);
  if (typeof schema.additionalProperties === "object") references(schema.additionalProperties, into);
}

/**
 * The facts of the 17 v1 operations and of every schema their bodies reach. A v1 operation the document lacks, a
 * body that references no schema, and a reached schema that is neither an object, a union nor an enumeration are
 * each refused, so a document of another shape writes nothing.
 */
export function qdrantOpenApiFacts(
  document: unknown,
): Pick<QdrantOpenApiFacts, "operations" | "objects" | "unions" | "enums"> {
  const root = document as {
    readonly paths?: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
    readonly components?: { readonly schemas?: Readonly<Record<string, Schema>> };
  };
  const schemas = root.components?.schemas;
  if (root.paths === undefined || schemas === undefined)
    throw new Error("the OpenAPI document has no paths or no schemas");

  const operations: Record<string, OperationFacts> = {};
  const reach: string[] = [];
  for (const [path, entries] of Object.entries(root.paths)) {
    for (const [method, operation] of Object.entries(entries)) {
      const op = operation.operationId;
      if (!METHODS.includes(method) || op === undefined) continue;
      if (!(QDRANT_V1_OPERATIONS as readonly string[]).includes(op)) continue;
      const body = operation.requestBody?.content?.["application/json"]?.schema;
      const bodySchema = body === undefined ? null : (named(body) ?? null);
      if (operation.requestBody !== undefined && bodySchema === null) {
        throw new Error(`${op} takes a body that references no schema`);
      }
      if (bodySchema !== null) reach.push(bodySchema);
      operations[op] = {
        method: method.toUpperCase(),
        path,
        query: (operation.parameters ?? [])
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => parameter.name),
        bodySchema,
        required: bodySchema === null ? [] : [...(schemas[bodySchema]?.required ?? [])],
      };
    }
  }
  const missing = QDRANT_V1_OPERATIONS.filter((op) => operations[op] === undefined);
  if (missing.length > 0) throw new Error(`the OpenAPI document lacks the v1 operations ${missing.join(", ")}`);

  const objects: Record<string, ObjectFacts> = {};
  const unions: Record<string, readonly string[]> = {};
  const enums: Record<string, readonly string[]> = {};
  const seen = new Set<string>();
  while (reach.length > 0) {
    const name = reach.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const schema = schemas[name];
    if (schema === undefined) throw new Error(`the OpenAPI document references ${name} and does not define it`);
    if (schema.anyOf !== undefined) unions[name] = schema.anyOf.map(member);
    else if (schema.enum !== undefined) enums[name] = [...schema.enum];
    else if (schema.type === "object") {
      objects[name] = { keys: Object.keys(schema.properties ?? {}), required: [...(schema.required ?? [])] };
    } else throw new Error(`${name} is neither an object, a union nor an enumeration`);
    const next = new Set<string>();
    references(schema, next);
    reach.push(...[...next].sort());
  }
  const sorted = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    operations: Object.fromEntries(QDRANT_V1_OPERATIONS.map((op) => [op, operations[op]])),
    objects: sorted(objects),
    unions: sorted(unions),
    enums: sorted(enums),
  };
}

/**
 * The model names `LocalModelName::from_str` matches, in source order. A source with no such function, or one
 * whose match holds no string literal, is refused.
 */
export function localModelNames(source: string): string[] {
  const start = source.indexOf("fn from_str(");
  const end = start === -1 ? -1 : source.indexOf("\n    }\n", start);
  if (start === -1 || end === -1) throw new Error("local_model.rs holds no LocalModelName::from_str");
  const names = [...source.slice(start, end).matchAll(/^\s*"([^"]+)"\s*=>/gm)].map((match) => match[1]);
  if (names.length === 0) throw new Error("LocalModelName::from_str matches no model name");
  return names;
}

export const QDRANT_OPENAPI_SOURCE = "github.com/qdrant/qdrant docs/redoc/master/openapi.json at tag v1.19.1";
export const QDRANT_LOCAL_MODEL_SOURCE = "github.com/qdrant/qdrant src/common/inference/local_model.rs at tag v1.19.1";

/** The committed file's whole content, from the two sources' facts. */
export function qdrantFactsFile(document: unknown, localModelSource: string): QdrantOpenApiFacts {
  return {
    $generated: {
      by: "tests/live/qdrant-openapi.ts",
      source: QDRANT_OPENAPI_SOURCE,
      sha256: QDRANT_SPEC_SHA256,
      localModelSource: QDRANT_LOCAL_MODEL_SOURCE,
      localModelSha256: QDRANT_LOCAL_MODEL_SHA256,
    },
    ...qdrantOpenApiFacts(document),
    localModels: localModelNames(localModelSource),
  };
}
