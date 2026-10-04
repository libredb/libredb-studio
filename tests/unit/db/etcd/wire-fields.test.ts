/**
 * The adapter's wire types against the descriptor (spec 3.2).
 *
 * `grpc-client.ts` types every message it sends and reads as an interface named `Wire` plus the descriptor's
 * message name, and TypeScript then refuses a property the interface does not declare. This file holds each
 * declared property to the descriptor, so a field name the adapter misspells, or reads with the wrong type, fails
 * here instead of reading `undefined` from a decoded message. It reads both files as text, with the TypeScript
 * compiler API for the adapter and the generated literal for the descriptor, and imports neither: only the adapter
 * and its two transport tests may import the descriptor (spec E11).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const ETCD_DIR = path.join(ROOT, "src", "lib", "db", "providers", "keyvalue", "etcd");
const ADAPTER_FILE = path.join(ETCD_DIR, "grpc-client.ts");
const DESCRIPTOR_FILE = path.join(ETCD_DIR, "proto", "descriptor.ts");

interface DescriptorField {
  readonly type: string;
  readonly id: number;
  readonly rule?: string;
}
interface DescriptorType {
  readonly fields?: Readonly<Record<string, DescriptorField>>;
  readonly values?: Readonly<Record<string, number>>;
  readonly nested?: Readonly<Record<string, DescriptorType>>;
  readonly methods?: Readonly<Record<string, { readonly requestType: string; readonly responseType: string }>>;
}

/** The generated literal of `proto/descriptor.ts`, read as a file: it is JSON.stringify output (plan C0). */
function readDescriptor(): Readonly<Record<string, DescriptorType>> {
  const text = readFileSync(DESCRIPTOR_FILE, "utf8");
  const source = ts.createSourceFile(DESCRIPTOR_FILE, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const [declaration] = statement.declarationList.declarations;
    if (declaration.name.getText(source) !== "ETCD_DESCRIPTOR") continue;
    const initializer = declaration.initializer;
    if (initializer === undefined || !ts.isAsExpression(initializer)) {
      throw new Error("ETCD_DESCRIPTOR is not an asserted literal");
    }
    const root = JSON.parse(initializer.expression.getText(source)) as { nested: Record<string, DescriptorType> };
    return { etcdserverpb: root.nested.etcdserverpb, mvccpb: root.nested.mvccpb, authpb: root.nested.authpb };
  }
  throw new Error("proto/descriptor.ts declares no ETCD_DESCRIPTOR");
}

const PACKAGES = readDescriptor();

/** A message or enum of the descriptor by its qualified name, "etcdserverpb.RangeRequest" or "authpb.Permission.Type". */
function lookup(qualified: string): DescriptorType | undefined {
  const [pkg, ...names] = qualified.split(".");
  let found: DescriptorType | undefined = { nested: PACKAGES[pkg]?.nested };
  for (const name of names) found = found?.nested?.[name];
  return found;
}

/** Where a message of that name lives: exactly one package, or undefined when none holds it or two do. */
function qualify(message: string): string | undefined {
  const holders = Object.keys(PACKAGES).filter((pkg) => PACKAGES[pkg].nested?.[message]?.fields !== undefined);
  return holders.length === 1 ? `${holders[0]}.${message}` : undefined;
}

/** A field's type name resolved as protobuf does: the message's own nested types, its package's, then qualified. */
function resolveType(message: string, typeName: string): string | undefined {
  const pkg = message.split(".")[0];
  return [`${message}.${typeName}`, `${pkg}.${typeName}`, typeName].find((name) => lookup(name) !== undefined);
}

/** What ETCD_LOADER_OPTIONS decodes each scalar to: `longs: String` makes every 64-bit integer a string. */
const SCALARS: Readonly<Record<string, string>> = {
  bytes: "Uint8Array",
  string: "string",
  bool: "boolean",
  int64: "string",
  uint64: "string",
  sint64: "string",
  fixed64: "string",
  sfixed64: "string",
  int32: "number",
  uint32: "number",
  sint32: "number",
  fixed32: "number",
  sfixed32: "number",
  double: "number",
  float: "number",
};

type WireType =
  | { readonly kind: "scalar"; readonly name: string }
  | { readonly kind: "literals"; readonly values: readonly string[] }
  | { readonly kind: "message"; readonly name: string }
  | { readonly kind: "array"; readonly element: WireType };

/** A property's declared type, in the four shapes a wire interface may use; anything else is refused by name. */
function readType(node: ts.TypeNode, source: ts.SourceFile): WireType {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return readType(node.type, source);
  }
  if (ts.isArrayTypeNode(node)) return { kind: "array", element: readType(node.elementType, source) };
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.filter(
      (member) => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
    );
    if (members.length === 1) return readType(members[0], source);
    if (members.every((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))) {
      return {
        kind: "literals",
        values: members.map((member) => ((member as ts.LiteralTypeNode).literal as ts.StringLiteral).text),
      };
    }
  }
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return { kind: "literals", values: [node.literal.text] };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source);
    return name.startsWith("Wire") ? { kind: "message", name: name.slice("Wire".length) } : { kind: "scalar", name };
  }
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "scalar", name: "string" };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "scalar", name: "boolean" };
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: "scalar", name: "number" };
  throw new Error(`a wire property is typed ${node.getText(source)}, which this test does not read`);
}

interface WireProperty {
  readonly name: string;
  readonly type: WireType;
  readonly text: string;
}

/** Every interface of a source text whose name is `Wire` plus a capital, with its properties. */
function wireInterfaces(text: string): ReadonlyMap<string, readonly WireProperty[]> {
  const source = ts.createSourceFile(ADAPTER_FILE, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, WireProperty[]>();
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || !/^Wire[A-Z]/.test(statement.name.text)) continue;
    found.set(
      statement.name.text.slice("Wire".length),
      statement.members.filter(ts.isPropertySignature).map((member) => {
        if (member.type === undefined) {
          throw new Error(`${statement.name.text}.${member.name.getText(source)} has no type`);
        }
        return {
          name: member.name.getText(source),
          type: readType(member.type, source),
          text: member.type.getText(source),
        };
      }),
    );
  }
  return found;
}

/** Why a declared type is not what the descriptor field decodes to, or undefined when it is. */
function mismatch(message: string, field: DescriptorField, declared: WireType): string | undefined {
  if (field.rule === "repeated") {
    if (declared.kind !== "array") return "the field is repeated, and the property is not an array";
    return mismatch(message, { ...field, rule: undefined }, declared.element);
  }
  if (declared.kind === "array") return "the property is an array, and the field is not repeated";
  const scalar = SCALARS[field.type];
  if (scalar !== undefined) {
    return declared.kind === "scalar" && declared.name === scalar
      ? undefined
      : `a ${field.type} field reads as ${scalar}`;
  }
  const resolved = resolveType(message, field.type);
  const target = resolved === undefined ? undefined : lookup(resolved);
  if (target?.values !== undefined) {
    const names = Object.keys(target.values);
    if (declared.kind !== "literals") return `an enum field reads as a union of its names (${names.join(", ")})`;
    const unknown = declared.values.filter((value) => !names.includes(value));
    return unknown.length === 0 ? undefined : `${unknown.join(", ")} is not a name of ${resolved}`;
  }
  if (target?.fields !== undefined) {
    const expected = resolved?.split(".").pop();
    return declared.kind === "message" && declared.name === expected
      ? undefined
      : `a message field reads as Wire${expected}`;
  }
  return `the field's type ${field.type} does not resolve`;
}

/** Every finding for a source text's wire interfaces: an interface no message has, a property no field has, a wrong type. */
function findings(text: string): string[] {
  const found: string[] = [];
  for (const [name, properties] of wireInterfaces(text)) {
    const qualified = qualify(name);
    if (qualified === undefined) {
      found.push(`Wire${name} names no message of the descriptor`);
      continue;
    }
    const fields = lookup(qualified)?.fields ?? {};
    for (const property of properties) {
      const field = fields[property.name];
      if (field === undefined) {
        found.push(`Wire${name}.${property.name} is not a field of ${qualified}`);
        continue;
      }
      const problem = mismatch(qualified, field, property.type);
      if (problem !== undefined) found.push(`Wire${name}.${property.name}: ${property.text}, but ${problem}`);
    }
  }
  return found;
}

const ADAPTER_TEXT = readFileSync(ADAPTER_FILE, "utf8");

/** The RPCs the adapter lists, read from its ETCD_ALLOWLISTED_RPCS literal. */
function allowlisted(text: string): string[] {
  const source = ts.createSourceFile(ADAPTER_FILE, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const [declaration] = statement.declarationList.declarations;
    if (declaration.name.getText(source) !== "ETCD_ALLOWLISTED_RPCS" || declaration.initializer === undefined) continue;
    let literal: ts.Expression = declaration.initializer;
    while (ts.isSatisfiesExpression(literal) || ts.isAsExpression(literal)) literal = literal.expression;
    if (ts.isArrayLiteralExpression(literal)) {
      return literal.elements.map((element) => (element as ts.StringLiteral).text);
    }
  }
  throw new Error("grpc-client.ts declares no ETCD_ALLOWLISTED_RPCS array literal");
}

/**
 * How each allowlisted RPC's messages are typed: the interface of each request the adapter sends and each answer
 * it reads, or "empty" for a request with no field, which it sends as `{}`, and "unread" for an answer it only
 * awaits.
 */
const RPC_MESSAGES: Readonly<Record<string, { readonly request: string; readonly response: string }>> = {
  "KV/Range": { request: "RangeRequest", response: "RangeResponse" },
  "KV/DeleteRange": { request: "DeleteRangeRequest", response: "DeleteRangeResponse" },
  "KV/Txn": { request: "TxnRequest", response: "TxnResponse" },
  "Watch/Watch": { request: "WatchRequest", response: "WatchResponse" },
  "Lease/LeaseGrant": { request: "LeaseGrantRequest", response: "LeaseGrantResponse" },
  "Lease/LeaseRevoke": { request: "LeaseRevokeRequest", response: "LeaseRevokeResponse" },
  "Lease/LeaseKeepAlive": { request: "LeaseKeepAliveRequest", response: "LeaseKeepAliveResponse" },
  "Lease/LeaseTimeToLive": { request: "LeaseTimeToLiveRequest", response: "LeaseTimeToLiveResponse" },
  "Lease/LeaseLeases": { request: "empty", response: "LeaseLeasesResponse" },
  "Cluster/MemberList": { request: "MemberListRequest", response: "MemberListResponse" },
  "Maintenance/Status": { request: "empty", response: "StatusResponse" },
  "Maintenance/Alarm": { request: "AlarmRequest", response: "AlarmResponse" },
  "KV/Compact": { request: "CompactionRequest", response: "unread" },
  "Maintenance/Defragment": { request: "empty", response: "unread" },
  "Auth/AuthStatus": { request: "empty", response: "AuthStatusResponse" },
  "Auth/Authenticate": { request: "AuthenticateRequest", response: "AuthenticateResponse" },
  "Auth/UserList": { request: "empty", response: "AuthUserListResponse" },
  "Auth/UserGet": { request: "AuthUserGetRequest", response: "AuthUserGetResponse" },
  "Auth/RoleList": { request: "empty", response: "AuthRoleListResponse" },
  "Auth/RoleGet": { request: "AuthRoleGetRequest", response: "AuthRoleGetResponse" },
};

describe("the adapter's wire types against the descriptor (spec 3.2)", () => {
  const interfaces = wireInterfaces(ADAPTER_TEXT);

  test("the adapter declares its wire types, so this test reads real code", () => {
    expect(interfaces.size).toBeGreaterThan(40);
    expect(interfaces.get("RangeRequest")?.map((property) => property.name)).toContain("range_end");
  });

  test("every Wire interface names a descriptor message, and every property is one of its fields, with its type", () => {
    expect(findings(ADAPTER_TEXT)).toEqual([]);
  });

  test("the table of messages covers exactly the allowlist, and matches each method's request and response types", () => {
    const rpcs = allowlisted(ADAPTER_TEXT);
    expect(Object.keys(RPC_MESSAGES).sort()).toEqual([...rpcs].sort());
    for (const rpc of rpcs) {
      const [service, method] = rpc.split("/");
      const declared = PACKAGES.etcdserverpb.nested?.[service]?.methods?.[method];
      const { request, response } = RPC_MESSAGES[rpc];
      if (request === "empty") {
        const fields = Object.keys(lookup(`etcdserverpb.${declared?.requestType}`)?.fields ?? { missing: true });
        expect({ rpc, fields }).toEqual({ rpc, fields: [] });
      } else {
        expect({ rpc, request, typed: interfaces.has(request) }).toEqual({
          rpc,
          request: declared?.requestType ?? "no such method",
          typed: true,
        });
      }
      if (response !== "unread") {
        expect({ rpc, response, typed: interfaces.has(response) }).toEqual({
          rpc,
          response: declared?.responseType ?? "no such method",
          typed: true,
        });
      }
    }
  });

  test("every message a wire type holds is typed too", () => {
    const untyped: string[] = [];
    const visit = (type: WireType, owner: string) => {
      if (type.kind === "array") visit(type.element, owner);
      else if (type.kind === "message" && !interfaces.has(type.name)) {
        untyped.push(`${owner} holds Wire${type.name}, which is not declared`);
      }
    };
    for (const [name, properties] of interfaces) {
      for (const property of properties) visit(property.type, `Wire${name}.${property.name}`);
    }
    expect(untyped).toEqual([]);
  });

  test("no Range carries a sort or a revision filter, and no watch a progress request or a filter (spec E14, 5.1.3)", () => {
    const names = (message: string) => interfaces.get(message)?.map((property) => property.name) ?? [];
    for (const refused of [
      "sort_order",
      "sort_target",
      "min_mod_revision",
      "max_mod_revision",
      "min_create_revision",
      "max_create_revision",
    ]) {
      expect(names("RangeRequest")).not.toContain(refused);
    }
    expect(names("WatchCreateRequest")).not.toContain("progress_notify");
    expect(names("WatchCreateRequest")).not.toContain("filters");
    expect(names("WatchRequest")).toEqual(["create_request"]);
  });

  test("an alarm request can name GET and DEACTIVATE and no other action (spec E11)", () => {
    const action = interfaces.get("AlarmRequest")?.find((property) => property.name === "action")?.type;
    expect(action).toEqual({ kind: "literals", values: ["GET", "DEACTIVATE"] });
  });
});

describe("the detector", () => {
  const planted = (from: string, to: string) => {
    expect(ADAPTER_TEXT).toContain(from);
    return findings(ADAPTER_TEXT.replace(from, to));
  };

  test("a misspelled field fails by name", () => {
    expect(
      planted(
        "  readonly mod_revision: string;\n  readonly version: string;",
        "  readonly mod_revison: string;\n  readonly version: string;",
      ),
    ).toEqual(["WireKeyValue.mod_revison is not a field of mvccpb.KeyValue"]);
  });

  test("a 64-bit integer read as a number, a message field read as another message, and a repeated field read alone fail", () => {
    expect(planted("  readonly dbSize: string;", "  readonly dbSize: number;")).toEqual([
      "WireStatusResponse.dbSize: number, but a int64 field reads as string",
    ]);
    expect(planted("  readonly kv: WireKeyValue | null;", "  readonly kv: WireResponseHeader | null;")).toEqual([
      "WireEvent.kv: WireResponseHeader | null, but a message field reads as WireKeyValue",
    ]);
    expect(planted("  readonly kvs: readonly WireKeyValue[];", "  readonly kvs: WireKeyValue;")).toEqual([
      "WireRangeResponse.kvs: WireKeyValue, but the field is repeated, and the property is not an array",
    ]);
  });

  test("an enum name the descriptor does not have, and an interface no message has, fail", () => {
    expect(
      planted('readonly action: "GET" | "DEACTIVATE";', 'readonly action: "GET" | "DEACTIVATE" | "DISARM";'),
    ).toEqual([
      'WireAlarmRequest.action: "GET" | "DEACTIVATE" | "DISARM", but DISARM is not a name of etcdserverpb.AlarmRequest.AlarmAction',
    ]);
    expect(findings(`${ADAPTER_TEXT}\ninterface WireRangeRequests {\n  readonly key: Uint8Array;\n}\n`)).toEqual([
      "WireRangeRequests names no message of the descriptor",
    ]);
  });

  test("a bytes field read as a string, and an enum field read as a string, fail", () => {
    expect(
      planted(
        "interface WireKeyValue {\n  readonly key: Uint8Array;",
        "interface WireKeyValue {\n  readonly key: string;",
      ),
    ).toEqual(["WireKeyValue.key: string, but a bytes field reads as Uint8Array"]);
    expect(planted('readonly type: "PUT" | "DELETE";', "readonly type: string;")).toEqual([
      "WireEvent.type: string, but an enum field reads as a union of its names (PUT, DELETE)",
    ]);
  });
});
