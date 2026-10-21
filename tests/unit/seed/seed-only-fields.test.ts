import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { filterByRoles } from "@/lib/seed/connection-filter";
import type { SeedConnection } from "@/lib/seed/types";
import { seedBase, seedIssues } from "../db/connection-string/fixtures";

/**
 * The fields only one engine's provider reads are refused on every other type, at load by the seed schema and again by
 * the projection gate in `filterByRoles`. These cases hold today's answers; the last one holds that neither module
 * names the owning engine in a comparison, so the rows in SEED_ONLY_FIELDS are the only place that fact lives.
 */

const OPCUA_SENTENCE = (field: string) =>
  `${field} is OPC UA only: no other engine's provider reads it, so this connection would be listed as carrying it and would not. Remove ${field} from this connection.`;

const API_KEY_PREFIX = "apiKeyId and apiKeySecret are Elasticsearch-only.";

describe("seed-only fields at load", () => {
  test("an OPC UA field on postgres is refused at its path", () => {
    expect(seedIssues({ ...seedBase("postgres"), clientCertificatePath: "/c" })).toEqual([
      { path: ["clientCertificatePath"], message: OPCUA_SENTENCE("clientCertificatePath") },
    ]);
  });

  test("opcua carries all five of its fields with no seed-only issue", () => {
    const issues = seedIssues({
      ...seedBase("opcua"),
      securityMode: "SignAndEncrypt",
      serverCertificateThumbprint: "a".repeat(64),
      securityPolicyUri: "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256",
      clientCertificatePath: "/c",
      clientPrivateKeyPath: "/k",
    });
    expect(issues.filter((i) => i.message.includes("OPC UA only"))).toEqual([]);
  });

  test("the API key secret alone on opensearch is refused once at its path", () => {
    const issues = seedIssues({ ...seedBase("opensearch"), apiKeySecret: "s" });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(["apiKeySecret"]);
    expect(issues[0].message.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  test("on mysql the OPC UA issue comes before the API key issue", () => {
    const issues = seedIssues({ ...seedBase("mysql"), securityMode: "None", apiKeyId: "k" });
    expect(issues.map((i) => i.path)).toEqual([["securityMode"], ["apiKeyId"]]);
    expect(issues[0].message).toBe(OPCUA_SENTENCE("securityMode"));
    expect(issues[1].message.startsWith(API_KEY_PREFIX)).toBe(true);
  });
});

describe("seed-only fields at projection", () => {
  const inMemory = (extra: Partial<SeedConnection>): SeedConnection =>
    ({ id: "x", name: "X", type: "opensearch", host: "h", port: 9200, roles: ["*"], ...extra }) as SeedConnection;

  test("an in-memory opensearch seed with an API key id is refused", () => {
    expect(() => filterByRoles([inMemory({ apiKeyId: "k" })], ["admin"])).toThrow(
      'Seed connection "x" of type "opensearch" carries an Elasticsearch API key pair.',
    );
  });

  test("an empty API key id is not a pair", () => {
    expect(() => filterByRoles([inMemory({ apiKeyId: "" })], ["admin"])).not.toThrow();
  });
});

describe("no owning engine named in a comparison", () => {
  const OWNERS = new Set(["opcua", "elasticsearch"]);
  const COMPARISONS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

  const ownerLiterals = (file: string): string[] => {
    const path = join(import.meta.dir, "../../../src/lib/seed", file);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const isOwner = (n: ts.Node) => ts.isStringLiteralLike(n) && OWNERS.has(n.text);
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
        for (const side of [node.left, node.right]) if (isOwner(side)) found.push(side.getText(source));
      }
      if (ts.isCaseClause(node) && isOwner(node.expression)) found.push(node.expression.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  test.each(["types.ts", "connection-filter.ts"])("%s", (file) => {
    expect(ownerLiterals(file)).toEqual([]);
  });
});
