/**
 * The Milvus captures (vector-family spec 7.3), read through tests/helpers/milvus-fixtures.ts. This half pins the
 * reader's rules on values it builds itself; the rest reads the captures the harness wrote.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { CallOptions, MilvusClient, WireStatus } from "@/lib/db/providers/vector/milvus/client";
import type { MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { statusFailure, toMilvusError, toProviderError } from "@/lib/db/providers/vector/milvus/errors";
import { createGrpcMilvusClient, type MilvusRpc } from "@/lib/db/providers/vector/milvus/grpc-client";
import { readMilvusVersion, versionGateRefusal } from "@/lib/db/providers/vector/milvus/versions";
import {
  capturedAnswer,
  capturedFailure,
  MILVUS_FIXTURE_NAMES,
  MILVUS_FIXTURES_DIR,
  type MilvusCapture,
  milvusCapture,
  milvusCaptureFiles,
  reviveMilvusFixture,
} from "../../../helpers/milvus-fixtures";
import { recordedMilvusWire } from "../../../helpers/milvus-wire";

const provenance = {
  service: "milvus",
  image: "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0",
  version: "3.0.2",
  date: "2026-10-03",
  runtime: "bun 1.4.2",
  rpc: "Search",
  user: "root",
  surface: "s",
  request: {},
} as const;

describe("the capture reader's rules", () => {
  test("bytes, non-finite floats and nested values revive as grpc-js hands them over", () => {
    expect(
      reviveMilvusFixture({
        a: { $bytes: Buffer.from([1, 2, 255]).toString("base64") },
        scores: [{ $float: "Infinity" }, 0.5, { $float: "-Infinity" }],
        n: { $float: "NaN" },
        ids: { int_id: { data: ["469489107428444015"] } },
      }),
    ).toEqual({
      a: Buffer.from([1, 2, 255]),
      scores: [Number.POSITIVE_INFINITY, 0.5, Number.NEGATIVE_INFINITY],
      n: Number.NaN,
      ids: { int_id: { data: ["469489107428444015"] } },
    });
  });

  test("a gRPC failure revives as an error carrying its code, details and metadata, a missing code as undefined", () => {
    const failed: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { code: 16, details: "auth", message: "16 UNAUTHENTICATED: auth" } },
    };
    expect(capturedFailure(failed)).toMatchObject({ code: 16, details: "auth", message: "16 UNAUTHENTICATED: auth" });
    const broken: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { code: null, details: null, message: "x" } },
    };
    const error = capturedFailure(broken) as Error & { code?: unknown };
    expect(Object.hasOwn(error, "code")).toBe(true);
    expect(error.code).toBeUndefined();
  });

  test("a runtime throw revives as a plain error with its name and message", () => {
    const thrown: MilvusCapture = {
      $captured: provenance,
      outcome: "fail",
      payload: { error: { name: "Error", message: "key values mismatch" } },
    };
    const error = capturedFailure(thrown);
    expect(error.message).toBe("key values mismatch");
    expect(Object.hasOwn(error, "code")).toBe(false);
  });

  test("an answer is the revived payload, and asking for the failure of an answer, or the answer of a failure, throws", () => {
    const answered: MilvusCapture = {
      $captured: provenance,
      outcome: "pass",
      payload: { status: { code: 0 }, version: "3.0.2" },
    };
    expect(capturedAnswer(answered)).toEqual({ status: { code: 0 }, version: "3.0.2" });
    expect(() => capturedFailure(answered)).toThrow("holds an answer, not a failure");
    expect(() => capturedAnswer({ ...answered, payload: { error: { name: "Error", message: "x" } } })).toThrow(
      "holds a failure, not an answer",
    );
  });

  test("the catalog has 109 names, sorted, each under one of the three services", () => {
    expect(MILVUS_FIXTURE_NAMES).toHaveLength(109);
    expect([...MILVUS_FIXTURE_NAMES]).toEqual([...MILVUS_FIXTURE_NAMES].sort());
    for (const name of MILVUS_FIXTURE_NAMES) expect(name).toMatch(/^(milvus|milvus-tls|milvus-mtls)\/[a-z0-9_-]+$/);
  });
});

const ROOT = path.resolve(import.meta.dir, "../../../..");
const IMAGE = "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0";
const OPTIONS: MilvusConnectionOptions = {
  target: "dns:127.0.0.1:19530",
  endpoint: { host: "127.0.0.1", port: 19530 },
  auth: { kind: "none" },
  database: "default",
  callTimeoutMs: 30_000,
  receiveCapBytes: 16 * 1024 * 1024,
  secretForms: [],
};
const call: CallOptions = { db: "default", signal: new AbortController().signal };

function filesOnDisk(): string[] {
  return readdirSync(MILVUS_FIXTURES_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) =>
      path.relative(MILVUS_FIXTURES_DIR, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/** The harness's ROOT_CREDENTIAL, read by parsing it, so this file never repeats the default password. */
function harnessRootCredential(): { readonly user: string; readonly password: string } {
  const file = path.join(ROOT, "tests", "live", "milvus-evidence.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let found: Record<string, string> | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === "ROOT_CREDENTIAL" &&
      node.initializer !== undefined
    ) {
      const literal = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isObjectLiteralExpression(literal)) {
        found = Object.fromEntries(
          literal.properties
            .filter(ts.isPropertyAssignment)
            .map((property) => [property.name.getText(sf), (property.initializer as ts.StringLiteral).text]),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found?.user === undefined || found.password === undefined)
    throw new Error("the harness declares no ROOT_CREDENTIAL");
  return { user: found.user, password: found.password };
}

async function replaying(rpc: MilvusRpc, name: string): Promise<MilvusClient> {
  const wire = recordedMilvusWire({ [rpc]: () => capturedAnswer(milvusCapture(name)) });
  return createGrpcMilvusClient(OPTIONS, wire.transport);
}

describe("the captures on disk (7.3)", () => {
  test("the directory holds exactly the catalog, each name once or as a Bun and Node pair", () => {
    const files = filesOnDisk();
    expect([...new Set(files.map((file) => file.replace(/\.(?:bun|node)\.json$|\.json$/, "")))].sort()).toEqual([
      ...MILVUS_FIXTURE_NAMES,
    ]);
    for (const name of MILVUS_FIXTURE_NAMES) {
      const forms = files.filter((file) => [`${name}.json`, `${name}.bun.json`, `${name}.node.json`].includes(file));
      expect([[`${name}.json`], [`${name}.bun.json`, `${name}.node.json`]]).toContainEqual(forms);
      expect(milvusCaptureFiles(name)).toHaveLength(forms.length);
    }
  });

  test("every capture records the pinned image, Milvus 3.0.2, its date, its runtime, its RPC and user", () => {
    for (const name of MILVUS_FIXTURE_NAMES) {
      for (const runtime of ["bun", "node"] as const) {
        const { $captured } = milvusCapture(name, runtime);
        expect({ name, image: $captured.image, version: $captured.version }).toEqual({
          name,
          image: IMAGE,
          version: "3.0.2",
        });
        expect($captured.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect($captured.runtime).toMatch(/^(?:bun|node) \d/);
        expect($captured.rpc.length).toBeGreaterThan(0);
        expect(["root", "reader", "nobody", "wrong", "none"]).toContain($captured.user);
      }
    }
  });

  test("no capture holds the default pair or its base64, another credential's header, or a PEM block", () => {
    const { user, password } = harnessRootCredential();
    const pair = `${user}:${password}`;
    const forbidden = [
      pair,
      Buffer.from(pair, "utf8").toString("base64").replace(/=+$/, ""),
      "authorization",
      "-----BEGIN",
    ];
    for (const file of filesOnDisk()) {
      const text = readFileSync(path.join(MILVUS_FIXTURES_DIR, file), "utf8");
      for (const form of forbidden) expect({ file, holds: text.includes(form) }).toEqual({ file, holds: false });
    }
  });
});

describe("what the captures decode to through the real adapter (5.1, 5.9, E20)", () => {
  test("GetVersion answers 3.0.2, which passes every version gate", async () => {
    const client = await replaying("GetVersion", "milvus/get-version-root");
    const version = readMilvusVersion(await client.getVersion(call));
    expect(version).toEqual({ reported: "3.0.2", major: 3, minor: 0 });
    expect(versionGateRefusal("orderByFields", version)).toBeUndefined();
  });

  test("DescribeCollection of every seeded collection decodes; docs_int64's vec is a FloatVector of dimension 8", async () => {
    for (const name of MILVUS_FIXTURE_NAMES.filter((candidate) =>
      candidate.startsWith("milvus/describe-collection-"),
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one replay per capture.
      const client = await replaying("DescribeCollection", name);
      // oxlint-disable-next-line no-await-in-loop -- the replay's one call.
      const answer = await client.describeCollection({ collection_name: "x" }, call);
      expect({ name, fields: (answer.schema?.fields.length ?? 0) > 0 }).toEqual({ name, fields: true });
    }
    const client = await replaying("DescribeCollection", "milvus/describe-collection-default-docs_int64");
    const vec = (await client.describeCollection({ collection_name: "docs_int64" }, call)).schema?.fields.find(
      (field) => field.name === "vec",
    );
    expect(vec?.data_type).toBe("FloatVector");
    expect(vec?.type_params).toContainEqual({ key: "dim", value: "8" });
  });

  test("the non-finite score of the sparse self-search equals the value PR 1v derived (3.3)", async () => {
    const expected = JSON.parse(
      readFileSync(path.join(ROOT, "tests", "fixtures", "vector", "expected-scores.json"), "utf8"),
    ) as {
      milvus: { id: number | string; score: string };
    };
    const client = await replaying("Search", "milvus/search-edge-values-sp");
    const results = (
      await client.search(
        {
          collection_name: "edge_values",
          dsl: "",
          dsl_type: "BoolExprV1",
          output_fields: [],
          search_params: [],
          nq: "1",
        },
        call,
      )
    ).results;
    expect(String(results?.scores[0])).toBe(expected.milvus.score);
    expect(results?.ids?.int_id?.data[0]).toBe(String(expected.milvus.id));
  });

  test("int64 keys arrive as exact decimal strings (VF6)", async () => {
    const client = await replaying("Query", "milvus/query-root");
    const answer = await client.query(
      { collection_name: "docs_int64", expr: "", output_fields: [], query_params: [] },
      call,
    );
    expect(answer.fields_data.length).toBeGreaterThan(0);
    const seq = answer.fields_data.find((field) => field.field_name === "seq");
    for (const value of seq?.scalars?.long_data?.data ?? []) expect(value).toMatch(/^\d+$/);
  });
});

describe("every error row classifies as 5.10 says (E6, E7, E13, E14, E20)", () => {
  type Expected = { readonly categories: readonly string[]; readonly status?: number; readonly tlsFailure?: string };
  const ROWS: Readonly<Record<string, (runtime: "bun" | "node") => Expected>> = {
    "milvus/error-unauthenticated": () => ({ categories: ["unauthenticated"] }),
    "milvus/error-permission-denied": () => ({ categories: ["permission-denied"] }),
    "milvus/error-unimplemented": () => ({ categories: ["unimplemented"] }),
    "milvus/error-connection-dropped": () => ({ categories: ["connection-dropped"] }),
    "milvus/error-deadline-exceeded": () => ({ categories: ["deadline-exceeded"] }),
    "milvus/error-deadline-status-10001": () => ({ categories: ["deadline-exceeded"], status: 10_001 }),
    "milvus/error-cancelled-on-client": () => ({ categories: ["cancelled"] }),
    "milvus/error-receive-cap": () => ({ categories: ["receive-cap"] }),
    "milvus/error-receive-cap-decompressed": () => ({ categories: ["receive-cap"] }),
    "milvus/error-not-loaded": () => ({ categories: ["status"], status: 101 }),
    "milvus/error-input": () => ({ categories: ["status"], status: 1100 }),
    "milvus/error-collection-not-exists": () => ({ categories: ["status"], status: 100 }),
    "milvus/error-database-not-exists": () => ({ categories: ["status"], status: 800 }),
    "milvus/error-query-node-2000": () => ({ categories: ["status"], status: 2000 }),
    "milvus/error-query-node-2001": () => ({ categories: ["status"], status: 2001 }),
    "milvus/error-query-node-2099": () => ({ categories: ["status"], status: 2099 }),
    "milvus/error-tls-to-plaintext": () => ({ categories: ["tls", "not-connected"] }),
    "milvus-tls/error-tls-chain": () => ({ categories: ["tls"], tlsFailure: "chain" }),
    "milvus-tls/error-plaintext-to-tls": () => ({ categories: ["not-connected", "unavailable"] }),
    "milvus-tls/error-deadline-cancelled": () => ({ categories: ["deadline-exceeded"] }),
    "milvus-tls/error-ping-goaway": () => ({ categories: ["ping-goaway"] }),
    "milvus-mtls/error-tls-client-certificate-required": (runtime) =>
      runtime === "node"
        ? { categories: ["tls"], tlsFailure: "client-certificate-required" }
        : { categories: ["not-connected"] },
    "milvus-mtls/error-tls-client-certificate-refused": (runtime) =>
      runtime === "node"
        ? { categories: ["tls"], tlsFailure: "client-certificate-refused" }
        : { categories: ["not-connected"] },
    "milvus-mtls/error-tls-client-certificate-expired": (runtime) =>
      runtime === "node"
        ? { categories: ["tls"], tlsFailure: "client-certificate-expired" }
        : { categories: ["not-connected"] },
    "milvus-mtls/error-tls-client-key-mismatch": () => ({ categories: ["unknown"] }),
  };

  test("the table names every error capture", () => {
    expect(Object.keys(ROWS).sort()).toEqual(
      MILVUS_FIXTURE_NAMES.filter((name) => name.split("/")[1]?.startsWith("error-")),
    );
  });

  test.each(Object.keys(ROWS))("%s", (name) => {
    for (const runtime of ["bun", "node"] as const) {
      const capture = milvusCapture(name, runtime);
      const failed = (capture.payload as { error?: unknown }).error !== undefined;
      const cancelled = new AbortController();
      cancelled.abort();
      const error = failed
        ? toMilvusError(capturedFailure(capture), name.endsWith("cancelled-on-client") ? cancelled.signal : undefined)
        : statusFailure((capture.payload as { status?: WireStatus | null }).status ?? null, capture.$captured.rpc);
      const expected = ROWS[name]?.(runtime) as Expected;
      expect({ name, runtime, category: expected.categories.includes(error?.category ?? "none") }).toEqual({
        name,
        runtime,
        category: true,
      });
      if (expected.status !== undefined) expect(error?.status?.code).toBe(expected.status);
      if (expected.tlsFailure !== undefined) expect(error?.tlsFailure).toBe(expected.tlsFailure);
    }
  });

  test("a code 2000, 2001 or 2099 capture's raw text reaches no sentence (E20)", () => {
    for (const name of [
      "milvus/error-query-node-2000",
      "milvus/error-query-node-2001",
      "milvus/error-query-node-2099",
    ]) {
      const capture = milvusCapture(name);
      const status = (capture.payload as { status: WireStatus }).status;
      const message = toProviderError(statusFailure(status, "Search"), {
        operation: "search",
        write: false,
        connection: {
          host: "127.0.0.1",
          port: 19530,
          runtimeReportsTlsCause: true,
          receiveCapBytes: 16 * 1024 * 1024,
          timeoutMs: 30_000,
        },
        secretForms: [],
      }).message;
      expect({ name, raw: message.includes(status.reason) }).toEqual({ name, raw: false });
      expect(message).toStartWith("Milvus rejected the request on the query node");
    }
  });
});
