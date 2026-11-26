/**
 * A reader of a closed subset of JSON Schema 2020-12, the subset the grant register's schema is written in, so the
 * register is validated against its own schema in every runtime Studio loads it in: no code is compiled from the
 * schema, so it runs under a content security policy without `'unsafe-eval'` and in the VS Code webview, where a
 * validator that compiles with `new Function`, as ajv does, cannot.
 *
 * The keywords read, and nothing else:
 * - `$schema`, `$id` and `$defs` at the root, and `title` and `description` anywhere, none of which constrains a value;
 * - `$ref`, only to `#/$defs/<name>`, applied beside the node's other keywords;
 * - `type`, one name or a list of `object`, `array`, `string`, `boolean` and `null`;
 * - `const` and `enum`, compared as JSON values;
 * - `pattern` (a Unicode regular expression, unanchored as JSON Schema reads it), `minLength` and `maxLength`, over
 *   a string's code points;
 * - `properties`, `required` and `additionalProperties: false`;
 * - `items` and `uniqueItems: true`;
 * - `oneOf`, whose branches hold only `type: "object"` and `required`.
 *
 * Any other keyword, or one of these in another form (a `pattern` that does not compile among them), is refused by
 * name before a value is read (`schema-keyword-unread`, `schema-value-unread`), and so is a `$ref` chain that returns
 * to where it started without reading into the value (`schema-ref-cycle`), which would otherwise never end. A schema
 * edit can therefore never rely on a keyword this reader passes over in silence; the package's tests hold that ajv and
 * this reader agree on every fixture.
 *
 * A refusal names its rule and the JSON Pointer of the value, and never a value of the document read beyond a key's
 * name; a refusal of `const` or `enum` names the values the schema allows.
 */

/** One refusal of a value: its rule, the JSON Pointer of the value, and a sentence. */
export interface SchemaRefusal {
  readonly rule: string;
  readonly pointer: string;
  readonly sentence: string;
}

type JsonObject = { readonly [key: string]: unknown };

const TYPE_NAMES = ["object", "array", "string", "boolean", "null"];
const ROOT_KEYWORDS = ["$schema", "$id", "$defs"];
const NODE_KEYWORDS = [
  "title",
  "description",
  "$ref",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "uniqueItems",
  "oneOf",
];
const REF_FORM = /^#\/\$defs\/([^/~]+)$/;

/** Where a JSON Pointer points, in words: the pointer, or "the top level" for the empty one. */
export function where(pointer: string): string {
  return pointer === "" ? "the top level" : pointer;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

/** The JSON Pointer token of `key`. */
function token(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** `value` compiled in the Unicode mode a pattern is read in, or null when it is no string or does not compile. */
function compiled(value: unknown): RegExp | null {
  if (typeof value !== "string") return null;
  try {
    return new RegExp(value, "u");
  } catch {
    return null;
  }
}

function isLength(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Every problem of the schema itself, one line each, empty when this reader reads all of it. */
function schemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  const unread = (pointer: string, keyword: string) =>
    problems.push(`schema-keyword-unread at ${where(pointer)}: the keyword "${keyword}" is not one this reader reads`);
  const badValue = (pointer: string, keyword: string, form: string) =>
    problems.push(`schema-value-unread at ${where(pointer)}: the keyword "${keyword}" is read only as ${form}`);
  if (!isObject(schema)) return ["schema-value-unread at the top level: a schema is read only as an object"];
  const defs = own(schema, "$defs") ? schema.$defs : {};
  if (!isObject(defs)) badValue("", "$defs", "an object of schemas");

  const walk = (node: unknown, pointer: string, root: boolean): void => {
    if (!isObject(node)) {
      problems.push(`schema-value-unread at ${where(pointer)}: a schema is read only as an object`);
      return;
    }
    for (const keyword of Object.keys(node)) {
      if (!NODE_KEYWORDS.includes(keyword) && !(root && ROOT_KEYWORDS.includes(keyword))) unread(pointer, keyword);
    }
    const at = (keyword: string) => `${pointer}/${token(keyword)}`;
    if (own(node, "$ref")) {
      const name = typeof node.$ref === "string" ? REF_FORM.exec(node.$ref)?.[1] : undefined;
      if (name === undefined || !isObject(defs) || !own(defs, name)) {
        badValue(pointer, "$ref", "a reference to a schema of the root's $defs, #/$defs/<name>");
      }
    }
    if (own(node, "type")) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.length === 0 || !types.every((name) => typeof name === "string" && TYPE_NAMES.includes(name))) {
        badValue(pointer, "type", `one or a list of ${TYPE_NAMES.join(", ")}`);
      }
    }
    if (own(node, "enum") && !Array.isArray(node.enum)) badValue(pointer, "enum", "a list");
    if (own(node, "pattern") && compiled(node.pattern) === null) {
      badValue(pointer, "pattern", "a string that compiles as a Unicode regular expression");
    }
    for (const keyword of ["minLength", "maxLength"]) {
      if (own(node, keyword) && !isLength(node[keyword])) badValue(pointer, keyword, "a non-negative integer");
    }
    if (own(node, "required") && !isStringList(node.required)) badValue(pointer, "required", "a list of key names");
    if (own(node, "additionalProperties") && node.additionalProperties !== false) {
      badValue(pointer, "additionalProperties", "false");
    }
    if (own(node, "uniqueItems") && node.uniqueItems !== true) badValue(pointer, "uniqueItems", "true");
    if (own(node, "properties")) {
      if (isObject(node.properties)) {
        for (const [key, child] of Object.entries(node.properties))
          walk(child, `${at("properties")}/${token(key)}`, false);
      } else badValue(pointer, "properties", "an object of schemas");
    }
    if (own(node, "items")) walk(node.items, at("items"), false);
    if (own(node, "oneOf")) {
      const branches = node.oneOf;
      const form = 'a list of branches that each hold only type "object" and required';
      if (!Array.isArray(branches) || branches.length === 0) badValue(pointer, "oneOf", form);
      else {
        for (const branch of branches) {
          const plain =
            isObject(branch) &&
            Object.keys(branch).every((key) => key === "type" || key === "required") &&
            branch.type === "object" &&
            isStringList(branch.required);
          if (!plain) badValue(pointer, "oneOf", form);
        }
      }
    }
  };
  walk(schema, "", true);
  if (!isObject(defs)) return problems;
  for (const [name, def] of Object.entries(defs)) walk(def, `/$defs/${token(name)}`, false);
  if (problems.length > 0) return problems;
  // A node's own `$ref` is applied to the same value, so a chain of them that returns to a schema it left reads
  // nothing new and never ends: refused here, before any value is read. Every reference resolves by now.
  const starts: [string, unknown][] = [["", schema]];
  for (const [name, def] of Object.entries(defs)) starts.push([`/$defs/${token(name)}`, def]);
  for (const [start, node] of starts) {
    const seen = new Set<unknown>([node]);
    let current = node as JsonObject;
    while (typeof current.$ref === "string") {
      current = defs[REF_FORM.exec(current.$ref)?.[1] as string] as JsonObject;
      if (seen.has(current)) {
        problems.push(`schema-ref-cycle at ${where(start)}: its $ref chain returns to a schema it left`);
        break;
      }
      seen.add(current);
    }
  }
  return problems;
}

function refusal(rule: string, pointer: string, sentence: string): SchemaRefusal {
  return { rule, pointer, sentence };
}

function check(node: JsonObject, defs: JsonObject, value: unknown, pointer: string, out: SchemaRefusal[]): void {
  if (typeof node.$ref === "string") {
    check(defs[REF_FORM.exec(node.$ref)?.[1] as string] as JsonObject, defs, value, pointer, out);
  }
  if (own(node, "type")) {
    const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[];
    if (!types.includes(typeOf(value))) {
      out.push(
        refusal("wrong-type", pointer, `the value is not of the type the schema defines here, ${types.join(" or ")}`),
      );
      return;
    }
  }
  if (own(node, "const") && !jsonEqual(value, node.const)) {
    out.push(
      refusal(
        "value-not-allowed",
        pointer,
        `the value is not the one the schema allows here, ${JSON.stringify(node.const)}`,
      ),
    );
  }
  if (own(node, "enum")) {
    const allowed = node.enum as readonly unknown[];
    if (!allowed.some((item) => jsonEqual(value, item))) {
      out.push(
        refusal(
          "value-not-allowed",
          pointer,
          `the value is not one the schema allows here, ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
        ),
      );
    }
  }
  if (typeof value === "string") {
    if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) {
      out.push(refusal("pattern-mismatch", pointer, "the value does not have the form the schema defines here"));
    }
    const length = [...value].length;
    const tooShort = typeof node.minLength === "number" && length < node.minLength;
    const tooLong = typeof node.maxLength === "number" && length > node.maxLength;
    if (tooShort || tooLong) {
      out.push(refusal("out-of-range", pointer, "the value is outside the length the schema allows here"));
    }
  }
  if (isObject(value)) {
    const properties = (node.properties ?? {}) as JsonObject;
    for (const key of (node.required ?? []) as readonly string[]) {
      if (!own(value, key)) {
        out.push(
          refusal("missing-key", pointer, `the key ${JSON.stringify(key)} is missing, which the schema requires here`),
        );
      }
    }
    for (const key of Object.keys(value)) {
      if (own(properties, key)) check(properties[key] as JsonObject, defs, value[key], `${pointer}/${token(key)}`, out);
      else if (node.additionalProperties === false) {
        out.push(refusal("unknown-key", pointer, `the key ${JSON.stringify(key)} is not one the schema defines here`));
      }
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (isObject(node.items)) check(node.items, defs, item, `${pointer}/${index}`, out);
      if (node.uniqueItems === true && value.slice(0, index).some((earlier) => jsonEqual(earlier, item))) {
        out.push(refusal("duplicate", `${pointer}/${index}`, "the item repeats an earlier item of its list"));
      }
    });
  }
  if (Array.isArray(node.oneOf)) {
    const matching = node.oneOf.filter((branch) => {
      const scratch: SchemaRefusal[] = [];
      check(branch as JsonObject, defs, value, pointer, scratch);
      return scratch.length === 0;
    }).length;
    if (matching !== 1) {
      out.push(
        refusal("no-variant", pointer, "the value does not have exactly one of the shapes the schema defines here"),
      );
    }
  }
}

/**
 * Every refusal of `value` under `schema`, in document order, empty when the schema admits it.
 *
 * @throws {Error} Listing every problem of the schema itself, one line each, when it uses a keyword, a keyword form or
 * a `$ref` this reader does not read; no value is read then.
 */
export function schemaRefusals(schema: unknown, value: unknown): SchemaRefusal[] {
  const problems = schemaProblems(schema);
  if (problems.length > 0) throw new Error(["The grant register's schema is refused:", ...problems].join("\n"));
  const root = schema as JsonObject;
  const out: SchemaRefusal[] = [];
  check(root, (root.$defs ?? {}) as JsonObject, value, "", out);
  return out;
}
