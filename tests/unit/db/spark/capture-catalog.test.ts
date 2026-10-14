/**
 * The Spark capture catalog: every capture the catalog names exists for every version it lists, in
 * the capture shape, from its service's pinned image and the server version of its directory; every captured request is
 * stored as the provider's codec reads it back; no capture holds the token, a client-chosen id or a configured
 * catalog's value, inside its bytes values included; each stays under 2 MB; every statement an entry runs before its
 * capture is captured too, and a FetchErrorDetails capture asks for the errorId of its own failure capture and holds
 * that failure's text as its root message; every capture's surface is the one its entry gives it, which `--surfaces`
 * rewrites alone; the session settings the harness sends are the provider's; the harness dials only an address a
 * fixture container publishes; and README.md is what the harness renders.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  captureBytes,
  readSparkCapture,
  type SparkCapture,
  type SparkCaptureVersion,
} from "../../../helpers/spark-captures";
import {
  captureSurfaces,
  captureText,
  fixtureAddress,
  reencodedRequest,
  renderSparkFixturesReadme,
  SPARK_CAPTURE_LOADER_OPTIONS,
  type SparkCaptureRpc,
  statusDetailsOf,
  withoutCatalogValues,
  withSurface,
} from "../../../live/spark-evidence";
import {
  capturesOf,
  SPARK_CAPTURE_CATALOG,
  SPARK_CAPTURE_METADATA_SESSION_CONF,
  SPARK_CAPTURE_NAMES,
  SPARK_CAPTURE_SESSION_CONF,
  SPARK_EVERY_TYPE_SELECT,
  SPARK_FIXTURE_CONTAINERS,
  SPARK_SERVICE_IMAGES,
  type SparkCaptureEntry,
  type SparkCaptureName,
} from "../../../live/spark-evidence-plan";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "spark");
const VERSIONS: readonly SparkCaptureVersion[] = ["4.2.0", "4.1.3"];
const CATALOG_PREFIX = "spark.sql.catalog.";

interface Written {
  readonly entry: SparkCaptureEntry;
  /** `primary` is the entry's own name, `before` a statement it runs before its capture, `step` its other captures. */
  readonly role: "primary" | "before" | "step";
  /** The statement of a `before` capture. */
  readonly sql: string | undefined;
}

function expected(version: SparkCaptureVersion): Map<SparkCaptureName, Written> {
  const names = new Map<SparkCaptureName, Written>();
  for (const entry of SPARK_CAPTURE_CATALOG.filter((candidate) => candidate.versions.includes(version))) {
    const before = new Map((entry.before ?? []).map((statement) => [statement.name, statement.sql]));
    for (const name of capturesOf(entry)) {
      const sql = before.get(name);
      names.set(name, { entry, role: name === entry.name ? "primary" : sql === undefined ? "step" : "before", sql });
    }
  }
  return names;
}

/** The statement an ExecutePlan command step sent. */
function commandSql(capture: SparkCapture): unknown {
  const request = capture.$captured.request as {
    readonly plan?: {
      readonly command?: {
        readonly sql_command?: { readonly input?: { readonly sql?: { readonly query?: unknown } } };
      };
    };
  };
  return request.plan?.command?.sql_command?.input?.sql?.query;
}

/** Every {"$bytes": "<base64>"} value inside `value`, decoded. */
function bytesValues(value: unknown): Uint8Array[] {
  if (Array.isArray(value)) return value.flatMap(bytesValues);
  if (value === null || typeof value !== "object") return [];
  if ("$bytes" in value) return [captureBytes(value)];
  return Object.values(value).flatMap(bytesValues);
}

/** The lines of one top-level service of database-compose.yml, from its key to the next service key. */
function serviceBlock(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`database-compose.yml has no service ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z0-9-]+:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the catalog", () => {
  test("the session settings are the provider's, in its order", () => {
    expect(SPARK_CAPTURE_SESSION_CONF).toEqual([
      ["spark.sql.variable.substitute", "false"],
      ["spark.sql.execution.arrow.compression.codec", "none"],
      ["spark.sql.execution.arrow.useLargeVarTypes", "false"],
      ["spark.connect.session.resultChunking.maxChunkSize", "4194304"],
      ["spark.sql.execution.arrow.maxRecordsPerBatch", "1000"],
      ["spark.connect.progress.reportInterval", "2s"],
      ["spark.sql.connect.enrichError.enabled", "true"],
    ]);
    expect(SPARK_CAPTURE_METADATA_SESSION_CONF).toEqual([
      ["spark.sql.legacy.keepCommandOutputSchema", "false"],
      ["spark.sql.debug.maxToStringFields", "10000"],
    ]);
  });

  test("requests are read back with the provider's loader options (SPARK_LOADER_OPTIONS)", () => {
    expect(SPARK_CAPTURE_LOADER_OPTIONS).toEqual({
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
  });

  test("every name is written by exactly one entry, and every written name is in SPARK_CAPTURE_NAMES", () => {
    const written = SPARK_CAPTURE_CATALOG.flatMap(capturesOf);
    expect(new Set(written).size).toBe(written.length);
    expect([...written].sort()).toEqual([...SPARK_CAPTURE_NAMES].sort());
  });

  test("a statement the replay sends before a capture is captured under its own name; only the others run uncaptured", () => {
    expect(
      SPARK_CAPTURE_CATALOG.flatMap((entry) => (entry.before ?? []).map((statement) => [entry.name, statement.name])),
    ).toEqual([
      ["large-var-types-refused", "large-var-types-set"],
      ["temp-view-script", "temp-view-create"],
      ["substitution-off", "substitution-set"],
      ["compressed-zstd", "compressed-zstd-set"],
      ["compressed-lz4", "compressed-lz4-set"],
    ]);
    // Entries that run statements uncaptured: setup steps whose answers set-catalog and use-namespace hold, which the
    // replay sends, and the namespace switch before use-namespace-current and the 200 temp views of
    // command-over-batch-bound, which no replay sends.
    expect(
      SPARK_CAPTURE_CATALOG.filter((entry) => entry.uncaptured !== undefined).map((entry) => entry.name),
    ).toStrictEqual([
      "use-namespace",
      "use-namespace-current",
      "connect-current-namespace-studio",
      "command-over-batch-bound",
    ]);
    // The answer a connect with a catalog and a namespace replays is recorded after the very statements it sends.
    const sql = (name: SparkCaptureName): string => {
      const { action } = SPARK_CAPTURE_CATALOG.find((entry) => entry.name === name) as SparkCaptureEntry;
      if (action.kind !== "statement") throw new Error(`the capture plan's ${name} runs no statement`);
      return action.sql;
    };
    expect(
      SPARK_CAPTURE_CATALOG.find((entry) => entry.name === "connect-current-namespace-studio")?.uncaptured,
    ).toStrictEqual([sql("set-catalog"), sql("use-namespace")]);
  });

  test("a FetchErrorDetails entry writes its failing step, the details of that failure's errorId, and a passing command step before a failing relation step", () => {
    const entries = SPARK_CAPTURE_CATALOG.filter((entry) => entry.action.kind === "fetch-error-details");
    expect(entries.map((entry) => [entry.name, entry.expect, capturesOf(entry)])).toStrictEqual([
      ["time-type-refused", "error", ["time-type-refused", "time-type-refused-details", "time-type-refused-command"]],
      ["error-syntax", "error", ["error-syntax", "error-syntax-details"]],
      ["error-missing-table", "error", ["error-missing-table", "error-missing-table-details"]],
      ["error-permission-denied", "error", ["error-permission-denied", "error-permission-denied-details"]],
      [
        "error-max-result-size",
        "error",
        ["error-max-result-size", "error-max-result-size-details", "error-max-result-size-command"],
      ],
      ["show-namespaces-unloaded", "error", ["show-namespaces-unloaded", "show-namespaces-unloaded-details"]],
      ["show-create-table-missing", "error", ["show-create-table-missing", "show-create-table-missing-details"]],
    ]);
  });

  test("the every-type SELECT reads the stored table and adds the two types no table stores", () => {
    expect(SPARK_EVERY_TYPE_SELECT).toContain("FROM spark_catalog.studio.every_type");
    expect(SPARK_EVERY_TYPE_SELECT).not.toMatch(/\bTIME\b/);
  });
});

describe.each([...VERSIONS])("the captures of %s", (version) => {
  const names = expected(version);

  test("the directory holds exactly the catalogued captures", () => {
    const files = readdirSync(path.join(FIXTURES, version)).sort();
    expect(files).toEqual([...names.keys()].map((name) => `${name}.json`).sort());
  });

  test.each([...names.keys()])("%s is a capture from its pinned image", (name) => {
    const { entry, role, sql } = names.get(name) as Written;
    const capture = readSparkCapture(version, name);
    const service = version === "4.1.3" ? "spark-4-1" : entry.service;
    expect(capture.$captured.service).toBe(service);
    expect(capture.$captured.image).toBe(SPARK_SERVICE_IMAGES[service].image);
    expect(capture.$captured.digest).toBe(SPARK_SERVICE_IMAGES[service].digest);
    expect(capture.$captured.sparkVersion).toBe(version);
    expect(capture.$captured.runtime).toMatch(/^bun \d+\.\d+\.\d+$/);
    expect(capture.$captured.rpc).toMatch(
      /^SparkConnectService\/(ExecutePlan|AnalyzePlan|Config|Interrupt|ReleaseSession|FetchErrorDetails)$/,
    );
    expect(Number.isNaN(Date.parse(capture.$captured.date))).toBe(false);
    if (role === "primary" && entry.action.kind !== "interrupt") expect(capture.outcome).toBe(entry.expect);
    if (role === "before") {
      expect(capture.$captured.rpc).toBe("SparkConnectService/ExecutePlan");
      expect(commandSql(capture)).toBe(sql);
      expect(capture.outcome).toBe("pass");
    }
    if (capture.outcome === "error") {
      expect(Number.isInteger(capture.code)).toBe(true);
      expect(typeof capture.details).toBe("string");
    }
    const request = capture.$captured.request;
    if ("session_id" in request) expect(request.session_id).toBe("<session>");
    if ("tags" in request) for (const tag of request.tags as unknown[]) expect(tag).toBe("<tag>");
    if (typeof request.operation_id === "string") expect(request.operation_id).toBe("<operation>");
    if (typeof request.operation_tag === "string") expect(request.operation_tag).toBe("<tag>");
    // The request is stored as the provider's codec reads it back, so the replay's matcher reads it unchanged.
    const rpc = capture.$captured.rpc.slice("SparkConnectService/".length) as SparkCaptureRpc;
    expect(reencodedRequest(rpc, request)).toEqual(request);
  });

  test("no capture is larger than 2 MB, or holds a bearer token or a client-chosen tag, inside its bytes values too", () => {
    for (const name of names.keys()) {
      const file = path.join(FIXTURES, version, `${name}.json`);
      const bytes = readFileSync(file);
      expect({ name, small: bytes.length <= 2_000_000 }).toEqual({ name, small: true });
      const text = bytes.toString("utf8");
      const decoded = bytesValues(JSON.parse(text)).map((bytes) => Buffer.from(bytes).toString("latin1"));
      for (const value of [text, ...decoded]) {
        expect({ name, bearer: /Bearer (?!<token>)/.test(value) }).toEqual({ name, bearer: false });
        expect({ name, ids: /libredb-studio-[0-9a-f]{8}-/.test(value) }).toEqual({ name, ids: false });
      }
    }
  });

  test("every capture's surface is the one its entry gives it, so --surfaces leaves each as written", () => {
    const differing = [...names]
      .map(([name, { entry }]) => ({
        name,
        stored: readSparkCapture(version, name).$captured.surface,
        given: captureSurfaces(entry).get(name),
      }))
      .filter(({ stored, given }) => stored !== given);
    // The failure lists every capture whose surface differs: bun tests/live/spark-evidence.ts --surfaces rewrites them.
    expect(differing).toEqual([]);
  });

  test("an error capture's status details carry the message its details show, ids masked alike", () => {
    for (const name of names.keys()) {
      const capture = readSparkCapture(version, name);
      if (capture.outcome !== "error" || capture.metadata["grpc-status-details-bin"] === undefined) continue;
      const status = statusDetailsOf(capture.metadata["grpc-status-details-bin"]);
      expect({ name, message: status?.message }).toEqual({ name, message: capture.details });
    }
  });

  test("every Config answer writes <value> for each key whose full key lies under spark.sql.catalog.", () => {
    for (const name of names.keys()) {
      const capture = readSparkCapture(version, name);
      if (capture.$captured.rpc !== "SparkConnectService/Config" || capture.outcome !== "pass") continue;
      const prefix =
        (capture.$captured.request as { readonly operation?: { readonly get_all?: { readonly prefix?: string } } })
          .operation?.get_all?.prefix ?? "";
      const pairs =
        (capture.payload as { readonly pairs?: readonly { readonly key: string; readonly value?: unknown }[] }).pairs ??
        [];
      for (const pair of pairs) {
        if (!pair.key.startsWith(CATALOG_PREFIX) && !`${prefix}${pair.key}`.startsWith(CATALOG_PREFIX)) continue;
        expect({ name, key: pair.key, value: pair.value }).toEqual({ name, key: pair.key, value: "<value>" });
      }
    }
  });
});

describe("the answers the captures hold", () => {
  test("Config get_all of spark.sql.catalog. keeps the key names and writes every value <value>", () => {
    const capture = readSparkCapture("4.2.0", "config-catalog-keys");
    if (capture.outcome !== "pass") throw new Error("config-catalog-keys is an error capture");
    const pairs = (capture.payload as { readonly pairs: readonly { readonly key: string; readonly value: string }[] })
      .pairs;
    expect(pairs.map((pair) => pair.key)).toContain("studio_unloaded");
    for (const pair of pairs) expect(pair.value).toBe("<value>");
  });

  test("a failure carries Spark's status details byte for byte", () => {
    const capture = readSparkCapture("4.2.0", "error-syntax");
    if (capture.outcome !== "error") throw new Error("error-syntax is a pass capture");
    expect(captureBytes(capture.metadata["grpc-status-details-bin"]).length).toBeGreaterThan(0);
  });

  test("each FetchErrorDetails capture asks for the errorId of the failure captured in the same run", () => {
    const pairs = SPARK_CAPTURE_CATALOG.filter((entry) => entry.action.kind === "fetch-error-details").flatMap(
      (entry) => entry.versions.map((version) => [version, entry.name] as const),
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const [version, name] of pairs) {
      const failure = readSparkCapture(version, name);
      if (failure.outcome !== "error") throw new Error(`${version}/${name} is a pass capture`);
      const errorId = statusDetailsOf(failure.metadata["grpc-status-details-bin"])?.errorInfo?.metadata.errorId;
      expect({ version, name, errorId }).toStrictEqual({
        version,
        name,
        errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      const details = readSparkCapture(version, `${name}-details` as SparkCaptureName);
      expect({ version, name, asked: details.$captured.request.error_id }).toStrictEqual({
        version,
        name,
        asked: errorId,
      });
    }
  });

  test("each FetchErrorDetails capture's root message is the failure text its paired capture holds, both as the harness writes them", () => {
    const pairs = VERSIONS.flatMap((version) =>
      [...expected(version).keys()].filter((name) => name.endsWith("-details")).map((name) => [version, name] as const),
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const [version, name] of pairs) {
      const failure = readSparkCapture(version, name.slice(0, -"-details".length) as SparkCaptureName);
      if (failure.outcome !== "error") throw new Error(`${version}/${name} pairs with a pass capture`);
      const details = readSparkCapture(version, name);
      if (details.outcome !== "pass") throw new Error(`${version}/${name} is an error capture`);
      const { root_error_idx: rootIndex, errors } = details.payload as {
        readonly root_error_idx?: number;
        readonly errors: readonly { readonly message?: string }[];
      };
      expect({ version, name, root: rootIndex === undefined ? undefined : errors[rootIndex]?.message }).toStrictEqual({
        version,
        name,
        root: failure.details,
      });
    }
  });

  test("a call on a released session, a Config get and a metadata statement alike, answers INVALID_HANDLE.SESSION_CLOSED", () => {
    for (const name of ["session-closed", "session-closed-show-catalogs"] as const) {
      const capture = readSparkCapture("4.2.0", name);
      if (capture.outcome !== "error") throw new Error(`${name} is a pass capture`);
      const info = statusDetailsOf(capture.metadata["grpc-status-details-bin"])?.errorInfo;
      expect({ name, errorClass: info?.metadata.errorClass }).toStrictEqual({
        name,
        errorClass: "INVALID_HANDLE.SESSION_CLOSED",
      });
    }
  });
});

describe("what the harness writes", () => {
  const SESSION = "2d8c6406-0119-44cf-bd82-56fa1fb1a24d";
  const IDS = {
    session: SESSION,
    operations: ["5b2e8a35-7c9f-4f62-9a51-1c3d2e4f5a6b"],
    tags: ["libredb-studio-9f8e7d6c-5b4a-4321-8fed-cba987654321"],
  };
  const TOKEN = "capture-test-token-0123456789";
  const varint = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...varint(n >>> 7)]);
  const field = (tag: number, body: Uint8Array): Buffer =>
    Buffer.concat([Buffer.from([tag, ...varint(body.length)]), body]);
  const utf8 = (text: string): Buffer => Buffer.from(text, "utf8");
  /** A google.rpc.Status with one ErrorInfo, encoded by hand as Spark sends it. */
  function statusBytes(message: string, handle: string): Buffer {
    const entry = Buffer.concat([field(0x0a, utf8("messageParameters")), field(0x12, utf8(`{"handle":"${handle}"}`))]);
    const info = Buffer.concat([
      field(0x0a, utf8("INVALID_HANDLE.SESSION_CLOSED")),
      field(0x12, utf8("org.apache.spark")),
      field(0x1a, entry),
    ]);
    const any = Buffer.concat([field(0x0a, utf8("type.googleapis.com/google.rpc.ErrorInfo")), field(0x12, info)]);
    return Buffer.concat([Buffer.from([0x08, 9]), field(0x12, utf8(message)), field(0x1a, any)]);
  }
  const header = { rpc: "SparkConnectService/Config", request: { session_id: SESSION } };

  test("a client id inside grpc-status-details-bin is masked in the Status message and the ErrorInfo values", () => {
    const text = captureText(
      "session-closed",
      header,
      {
        outcome: "error",
        code: 9,
        details: `The handle ${SESSION} is invalid.`,
        metadata: { "grpc-status-details-bin": statusBytes(`The handle ${SESSION} is invalid.`, SESSION) },
      },
      IDS,
      [TOKEN],
    );
    expect(text).not.toContain(SESSION);
    const written = JSON.parse(text) as { readonly details: string; readonly metadata: Record<string, unknown> };
    const status = statusDetailsOf(written.metadata["grpc-status-details-bin"]);
    expect(written.details).toBe("The handle <session> is invalid.");
    expect(status?.code).toBe(9);
    expect(status?.message).toBe("The handle <session> is invalid.");
    expect(status?.errorInfo).toEqual({
      reason: "INVALID_HANDLE.SESSION_CLOSED",
      metadata: { messageParameters: '{"handle":"<session>"}' },
    });
  });

  test("status details that hold no client id are written byte for byte", () => {
    const bytes = statusBytes("The handle 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 is invalid.", "server-chosen");
    const written = JSON.parse(
      captureText(
        "session-closed",
        header,
        { outcome: "error", code: 9, details: "x", metadata: { "grpc-status-details-bin": bytes } },
        IDS,
        [TOKEN],
      ),
    ) as { readonly metadata: Record<string, unknown> };
    expect(captureBytes(written.metadata["grpc-status-details-bin"])).toEqual(new Uint8Array(bytes));
  });

  test.each([
    [TOKEN, "every-type-relation: the capture would hold the token; nothing was written"],
    [IDS.tags[0] as string, "every-type-relation: a bytes value would hold a client-chosen id; nothing was written"],
    [
      IDS.operations[0] as string,
      "every-type-relation: a bytes value would hold a client-chosen id; nothing was written",
    ],
  ])("a bytes value that holds %s stops the write", (inside, message) => {
    const payload = [{ arrow_batch: { row_count: "1", data: Buffer.from(`row ${inside} row`, "latin1") } }];
    expect(() => captureText("every-type-relation", header, { outcome: "pass", payload }, IDS, [TOKEN])).toThrow(
      message,
    );
  });

  test("--surfaces changes a capture's surface and no other byte, and refuses a text the harness did not write", () => {
    const text = readFileSync(path.join(FIXTURES, "4.2.0", "batch-rows.json"), "utf8");
    const { surface } = JSON.parse(text).$captured as { readonly surface: string };
    const rewritten = withSurface("4.2.0/batch-rows", text, "a new surface: relation step");
    expect(rewritten).not.toBe(text);
    expect(JSON.parse(rewritten).$captured.surface).toBe("a new surface: relation step");
    expect(withSurface("4.2.0/batch-rows", rewritten, surface)).toBe(text);
    expect(withSurface("4.2.0/batch-rows", text, surface)).toBe(text);
    for (const changed of [text.trimEnd(), text.replace("{\n  ", "{\n    "), JSON.stringify(JSON.parse(text))]) {
      expect(() => withSurface("4.2.0/batch-rows", changed, surface)).toThrow(
        "4.2.0/batch-rows: the capture is not as the harness writes it; nothing was written",
      );
    }
  });

  test("a Config answer's value is written <value> when a shorter get_all prefix returns a catalog key", () => {
    const answer = withoutCatalogValues(
      "Config",
      { operation: { get_all: { prefix: "spark." } } },
      {
        outcome: "pass",
        payload: {
          pairs: [
            { key: "sql.catalog.studio_unloaded", value: "org.example.Catalog" },
            { key: "app.name", value: "Spark Connect server" },
          ],
        },
      },
    );
    expect(answer).toEqual({
      outcome: "pass",
      payload: {
        pairs: [
          { key: "sql.catalog.studio_unloaded", value: "<value>" },
          { key: "app.name", value: "Spark Connect server" },
        ],
      },
    });
  });

  test("a sparse request is stored as the codec reads it back, defaults and oneof names included", () => {
    const sparse = { session_id: "<session>", operation: { get_all: { prefix: "spark.app." } } };
    const stored = reencodedRequest("Config", sparse);
    expect(stored).not.toEqual(sparse);
    expect(stored).toMatchObject({
      session_id: "<session>",
      operation: { op_type: "get_all", get_all: { prefix: "spark.app." } },
    });
    expect(reencodedRequest("Config", stored)).toEqual(stored);
  });
});

describe("the fixture the harness reaches", () => {
  test("each service's container, pinned image and published port are database-compose.yml's", () => {
    const compose = readFileSync(path.join(ROOT, "database-compose.yml"), "utf8");
    for (const [service, fixture] of Object.entries(SPARK_FIXTURE_CONTAINERS)) {
      const block = serviceBlock(compose, service);
      expect(block).toContain(`    container_name: ${fixture.container}`);
      expect(block).toContain(`    image: ${fixture.image}`);
      expect(block).toMatch(new RegExp(`\\n {6}- "127\\.0\\.0\\.1:\\d+:${fixture.port}"`));
    }
    for (const service of ["spark", "spark-4-1", "spark-auth"] as const) {
      const { image, digest } = SPARK_SERVICE_IMAGES[service];
      expect(SPARK_FIXTURE_CONTAINERS[service].image).toBe(`${image}@${digest}`);
    }
    expect(SPARK_FIXTURE_CONTAINERS["spark-tls"].container).toBe("libredb-spark-tls");
  });

  test("the harness dials the target only when the fixture container publishes that loopback address", () => {
    expect(fixtureAddress("libredb-spark", { host: "127.0.0.1", port: 15002 }, "127.0.0.1:15002\n")).toBe(
      "127.0.0.1:15002",
    );
    expect(fixtureAddress("libredb-spark", { host: "localhost", port: 15002 }, "127.0.0.1:15002\n")).toBe(
      "127.0.0.1:15002",
    );
    expect(fixtureAddress("libredb-spark-tls", { host: "::1", port: 15005 }, "[::1]:15005\n")).toBe("[::1]:15005");
    for (const [target, published] of [
      [{ host: "127.0.0.1", port: 15009 }, "127.0.0.1:15002\n"],
      [{ host: "::1", port: 15002 }, "127.0.0.1:15002\n"],
      [{ host: "127.0.0.1", port: 15002 }, "0.0.0.0:15002\n"],
      [{ host: "127.0.0.1", port: 15002 }, ""],
    ] as const) {
      expect(() => fixtureAddress("libredb-spark", target, published)).toThrow(
        "libredb-spark does not publish the target",
      );
    }
  });
});

describe("the reader", () => {
  test("captureBytes reads a $bytes value and refuses anything else", () => {
    expect([...captureBytes({ $bytes: Buffer.from([1, 2, 255]).toString("base64") })]).toEqual([1, 2, 255]);
    for (const value of [null, "AQI=", { $bytes: 1 }, { $bytes: "AQI=", extra: true }]) {
      expect(() => captureBytes(value)).toThrow('captureBytes reads a {"$bytes": "<base64>"} value only');
    }
  });

  test("a capture that is absent is refused naming its file", () => {
    expect(() => readSparkCapture("4.1.3", "auth-no-token")).toThrow(
      "tests/fixtures/spark/4.1.3/auth-no-token.json is missing: capture it with bun tests/live/spark-evidence.ts --capture <service>",
    );
  });
});

test("README.md is what the harness renders from the captures", () => {
  expect(readFileSync(path.join(FIXTURES, "README.md"), "utf8")).toBe(renderSparkFixturesReadme());
});
