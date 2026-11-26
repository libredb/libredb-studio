/**
 * The package's TypeScript types are the schema's: `GRANT_SHAPES` states each grant member's vocabulary in the schema's
 * own terms, the compiler holds it equal to `RegisterGrants` member by member (`tsc` fails on a member added, removed
 * or retyped on one side only), and the test holds it equal to the vocabulary read from `register.schema.json`, so a
 * member added, removed or retyped in the schema alone fails here.
 */
import { describe, expect, test } from "bun:test";
import schema from "../src/register.schema.json";
import type { RegisterAgentReading, RegisterGrants, RegisterRow, RegisterStatementLanguage } from "../src/index";

/** A grant member's vocabulary in the schema's terms: the keywords that decide its TypeScript type. */
type Shape =
  | { readonly type: "boolean" | "string" | readonly ["string", "null"] }
  | { readonly enum: readonly (string | null)[] }
  | { readonly type: "array"; readonly items: Shape }
  | { readonly type: readonly ["object", "null"]; readonly properties: { readonly [key: string]: Shape } };

type TypeName = { boolean: boolean; string: string; null: null };

/** The TypeScript type a shape describes, every object and list read-only as the reader answers it. */
type Described<S> = S extends { readonly enum: readonly (infer V)[] }
  ? V
  : S extends { readonly type: "array"; readonly items: infer I }
    ? readonly Described<I>[]
    : S extends { readonly properties: infer P }
      ? { readonly [K in keyof P]: Described<P[K]> } | null
      : S extends { readonly type: infer T extends keyof TypeName | readonly (keyof TypeName)[] }
        ? T extends readonly (infer N extends keyof TypeName)[]
          ? TypeName[N]
          : TypeName[T & keyof TypeName]
        : never;

/** Whether two types are the same type, checked by the compiler. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const TEXT = { type: "string" } as const;

/** Every grant member's vocabulary; `satisfies` refuses a member `RegisterGrants` lacks and one it holds left out. */
const GRANT_SHAPES = {
  writeReach: { enum: ["open", "guarded", "none"] },
  readsFileAccessPosture: { type: "boolean" },
  deniedFileAccessRefusal: { type: ["string", "null"] },
  singleWriterFile: { type: "boolean" },
  readRootsRequired: { type: "boolean" },
  agentCredentialForm: { enum: ["token", "service-account-key", "dedicated-user", "none", null] },
  maskingExemptColumns: { type: ["object", "null"], properties: { column: TEXT, reason: TEXT } },
  exposable: { type: "boolean" },
  statementRead: { type: "boolean" },
  metadataReadChangesState: { type: "boolean" },
  agentCredentialRequired: { type: "boolean" },
  opensLocalFile: { type: "boolean" },
  hostPathFields: { type: "array", items: { enum: ["clientCertificatePath", "clientPrivateKeyPath"] } },
  serverLevelWithoutDatabase: { type: "boolean" },
  sshTunnel: { type: ["string", "null"] },
  agentCredential: {
    type: ["object", "null"],
    properties: { form: { enum: ["pair", "dedicated-pair", "secret"] }, supersededBy: { type: "array", items: TEXT } },
  },
  statementLanguage: {
    enum: [
      "sql",
      "kubectl",
      "mongo",
      "libredbkv",
      "influxql",
      "weaviateapi",
      "qdrantapi",
      "cypher",
      "milvusrpc",
      "rediscli",
      "etcdctl",
      "oxiacli",
      "rabbitread",
      "kafkaread",
      "s3api",
      "fsquery",
      "snmpget",
      "netconfrpc",
      "modbusread",
      "promql",
      "opcuaread",
      "mtconnectread",
      "mqttread",
      "sparkplugread",
      null,
    ],
  },
  agentReadings: {
    type: "array",
    items: { enum: ["sessions", "slow-queries", "table-stats", "index-stats", "storage", "health"] },
  },
  servesOneSession: { type: ["string", "null"] },
  agentExecution: { type: "boolean" },
  ownWords: { enum: ["scrubbed", "code-only"] },
} as const satisfies { readonly [M in keyof RegisterGrants]: Shape };

/** Every grant member whose described type is not its `RegisterGrants` type, never when there is none. */
type Mismatched = {
  [M in keyof RegisterGrants]: Equal<Described<(typeof GRANT_SHAPES)[M]>, RegisterGrants[M]> extends true ? never : M;
}[keyof RegisterGrants];

type Node = { readonly [keyword: string]: unknown };

/** Keywords that constrain a value without changing its TypeScript type, passed over by `shapeOf`. */
const UNTYPED_KEYWORDS = ["description", "title", "minLength", "maxLength", "pattern", "uniqueItems"];

/** The shape of a schema node, its `$ref` resolved; a keyword `shapeOf` does not know is refused by name. */
function shapeOf(node: Node, pointer: string): unknown {
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace("#/$defs/", "");
    return shapeOf((schema.$defs as Record<string, Node>)[name] as Node, `/$defs/${name}`);
  }
  const shape: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (UNTYPED_KEYWORDS.includes(keyword)) continue;
    if (keyword === "type" || keyword === "enum") shape[keyword] = value;
    else if (keyword === "items") shape.items = shapeOf(value as Node, `${pointer}/items`);
    else if (keyword === "properties") {
      shape.properties = Object.fromEntries(
        Object.entries(value as Record<string, Node>).map(([key, child]) => [
          key,
          shapeOf(child, `${pointer}/properties/${key}`),
        ]),
      );
    } else if (keyword === "required") {
      // A required member is a member the type holds; the shapes state no optional member.
      expect({ pointer, required: value }).toEqual({ pointer, required: Object.keys(node.properties as object) });
    } else if (keyword === "additionalProperties") {
      expect({ pointer, additionalProperties: value }).toEqual({ pointer, additionalProperties: false });
    } else throw new Error(`the schema keyword ${keyword} at ${pointer} has no shape this test reads`);
  }
  return shape;
}

describe("the types are the schema's", () => {
  test("each grant member's vocabulary in the schema is GRANT_SHAPES's, which the compiler holds equal to RegisterGrants", () => {
    const parity: [
      Equal<Mismatched, never>,
      Equal<keyof typeof GRANT_SHAPES, keyof RegisterGrants>,
      Equal<RegisterStatementLanguage | null, RegisterGrants["statementLanguage"]>,
      Equal<readonly RegisterAgentReading[], RegisterGrants["agentReadings"]>,
      Equal<keyof NonNullable<RegisterRow["reasons"]>, keyof RegisterGrants>,
    ] = [true, true, true, true, true];
    const grants = schema.$defs.grants;

    expect(parity).toEqual([true, true, true, true, true]);
    expect(shapeOf(grants, "/$defs/grants")).toEqual({ type: "object", properties: GRANT_SHAPES });
    expect(Object.keys(grants.properties)).toEqual(Object.keys(GRANT_SHAPES));
    expect(Object.keys(schema.$defs.reasons.properties)).toEqual(Object.keys(GRANT_SHAPES));
  });

  test("a keyword the shapes do not read is refused by name, never passed over", () => {
    expect(() => shapeOf({ const: "a" }, "/planted")).toThrow(
      "the schema keyword const at /planted has no shape this test reads",
    );
  });
});
