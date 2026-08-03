/**
 * Couchbase transport seam guard (issue #262, decision 2)
 *
 * The Couchbase provider is worth building without the official SDK only while
 * swapping the transport stays cheap, and it stays cheap only while the REST
 * envelope lives in exactly one file. This test is the mechanism that keeps
 * that true: it parses every source of the provider and fails the build the
 * moment a wire field is read outside http-transport.ts.
 *
 * The detector is a parser, not a grep. A substring search for the envelope
 * names is simultaneously too loose and too strict - it fires on prose, on
 * `statusText`, on a local variable named `results` and on the `r.requestId`
 * column of `system:completed_requests`, while missing `payload["results"]` -
 * and a guard that cries wolf is a guard the next contributor deletes. The
 * detector is therefore tested against a compliant sample and a violating one,
 * so it is proven to fire and proven not to over-fire.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "document", "couchbase");

/** The fields the Query Service wraps every response in. */
const ENVELOPE_FIELDS = new Set(["results", "signature", "requestID", "status"]);

/** The single file allowed to know the wire format. */
const TRANSPORT_FILE = "http-transport.ts";

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting
 * the test.
 */
const SEAM_RULE = [
  `The Couchbase REST envelope leaked out of ${TRANSPORT_FILE}.`,
  "",
  "The Query Service wraps every response in { requestID, signature, results, status, metrics }.",
  "Issue #262 decision 2 keeps that envelope inside the transport: provider logic reads the neutral",
  "CouchbaseQueryResult (rows, fieldNames, executionTimeMs, mutationCount, warnings) through the",
  "CouchbaseTransport seam. That is what makes adopting the official Couchbase SDK later one new file",
  "implementing the same interface, instead of a rewrite of the provider, the introspection and the",
  "explain strategy.",
  "",
  `Fix an access below by mapping the field inside ${TRANSPORT_FILE} and widening CouchbaseQueryResult`,
  "when the value is genuinely needed. A management payload (/pools/default...) that happens to carry",
  "one of these names belongs there too - manage() stays HTTP permanently, so HTTP-shaped knowledge",
  "lives in the transport. Do not weaken or delete this test: it is the only thing keeping the seam real.",
  "",
  "Envelope reads outside the transport:",
].join("\n");

interface EnvelopeAccess {
  file: string;
  line: number;
  field: string;
  snippet: string;
}

/**
 * The payload field this node reads, or null when it reads none.
 *
 * Only three syntactic forms actually take a field off a payload, and all three
 * are envelope access regardless of how the value is spelled afterwards:
 *
 *   payload.results / payload?.results   PropertyAccessExpression
 *   payload["results"]                   ElementAccessExpression, literal key
 *   const { results } = payload          BindingElement of an object pattern
 *
 * A declaration or a constructed literal (`interface E { results: Row[] }`,
 * `return { status: "ok" }`) is deliberately not a violation: a shape is inert
 * until something reads it, and the read is what the three forms above catch.
 */
function accessedField(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) ? key.text : null;
  }
  // Array patterns bind by position, so only an object pattern names a field.
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
  }
  return null;
}

function findEnvelopeAccesses(file: string, source: string): EnvelopeAccess[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const found: EnvelopeAccess[] = [];

  const visit = (node: ts.Node): void => {
    const field = accessedField(node);
    if (field !== null && ENVELOPE_FIELDS.has(field)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.push({ file, line: line + 1, field, snippet: lines[line].trim() });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** Empty when the seam holds; the rule plus every offending line when it does not. */
function violationReport(accesses: EnvelopeAccess[]): string {
  if (accesses.length === 0) return "";
  const offences = accesses.map(
    (access) => `  ${access.file}:${access.line} reads "${access.field}" -> ${access.snippet}`,
  );
  return [SEAM_RULE, ...offences].join("\n");
}

function providerSources(): string[] {
  return readdirSync(PROVIDER_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function readProviderSource(file: string): string {
  return readFileSync(join(PROVIDER_DIR, file), "utf8");
}

describe("Couchbase transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken
  // one, so the file that is SUPPOSED to speak REST must light it up.
  test("the transport itself reads the envelope, proving the detector looks at real code", () => {
    const fields = findEnvelopeAccesses(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((a) => a.field);

    expect(fields).toContain("results");
    expect(fields).toContain("signature");
    expect(fields).toContain("status");
  });

  test(`the REST envelope is read only in ${TRANSPORT_FILE}`, () => {
    const violations = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findEnvelopeAccesses(file, readProviderSource(file)));

    expect(violationReport(violations)).toBe("");
  });
});

describe("the seam guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does with these words:
   * name them in prose, read them off a row that the cluster produced, keep a
   * local variable called `results`, and build an object with a `status` key.
   * None of it is envelope access, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the envelope: results, signature, requestID and status all
 * stay behind the seam. Even payload.status written in a comment is prose.
 */
import type { CouchbaseTransport } from "./transport";

const LIST_REQUESTS = "SELECT r.requestId, r.status FROM system:completed_requests AS r";

export async function listRequests(transport: CouchbaseTransport, field: string) {
  const outcome = await transport.query(LIST_REQUESTS);
  const { rows, fieldNames } = outcome;
  const results = rows.filter((row) => row.state !== "cancelled");
  const [first] = results;
  const dynamic = first[field];
  return { rows, fieldNames, dynamic, status: "ok", statusText: outcome.warnings.length };
}
`;

  const VIOLATING_SAMPLE = `
export function readEnvelope(payload: Record<string, unknown>) {
  const { requestID } = payload;
  return { id: requestID, rows: payload.results, columns: payload["signature"] };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findEnvelopeAccesses("index.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that reads the envelope, once per access", () => {
    const violations = findEnvelopeAccesses("index.ts", VIOLATING_SAMPLE);

    expect(violations.map((violation) => violation.field)).toEqual(["requestID", "results", "signature"]);
    expect(violations[0].line).toBe(3);
    expect(violations[1].line).toBe(4);
    expect(violations[1].snippet).toBe(
      'return { id: requestID, rows: payload.results, columns: payload["signature"] };',
    );
  });

  test.each<[string, string, string]>([
    ["a member access", "const rows = payload.results;", "results"],
    ["an optional-chained access", "const columns = payload?.signature;", "signature"],
    ["a bracket access with a literal key", 'const id = payload["requestID"];', "requestID"],
    ["a destructured field", "const { status } = payload;", "status"],
    ["a renamed destructured field", "const { results: rows } = payload;", "results"],
    [
      "the status check decision 5 warns about",
      'if (payload.status === "errors") throw new Error("failed");',
      "status",
    ],
  ])("flags %s", (_label, source, field) => {
    const [violation, ...rest] = findEnvelopeAccesses("index.ts", source);

    expect(rest).toEqual([]);
    expect(violation.field).toBe(field);
    expect(violation.line).toBe(1);
  });

  test.each([
    ["a near-miss property name", "const label = response.statusText;"],
    ["a local variable that shares a name", "const results = rows.slice(0, 10);"],
    ["an array destructuring binding", "const [results, signature] = tuple;"],
    ["a computed key that is not a literal", "const value = payload[field];"],
    ["a constructed object, which declares rather than reads", 'return { status: "ok", results: rows };'],
  ])("does not flag %s", (_label, source) => {
    expect(findEnvelopeAccesses("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and points at the issue", () => {
    const report = violationReport(findEnvelopeAccesses("index.ts", "const rows = payload.results;"));

    expect(report).toContain("#262");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("CouchbaseQueryResult");
    expect(report).toContain('index.ts:1 reads "results" -> const rows = payload.results;');
  });
});
