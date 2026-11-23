/**
 * Every part of every frame the memory test transport carries is read as the closed shape of its call type
 * (docs/providers/CONTRACT.md, clause C-20).
 *
 * Each case starts from a well-formed part, changes one thing, and asserts the exact refusal list: the rule, the call,
 * the part and a JSON Pointer into the part, never a value of the frame. Every planted string is generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FRAME_REFUSAL_RULES,
  type FramePart,
  type FrameRefusal,
  FrameRefusalError,
  type FrameRefusalRule,
  frameRefusalSentence,
  readFrame,
  SERVED_CALLS,
  type ServedCall,
} from "@libredb/provider-sdk/testing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft part each case bends into a shape the reader refuses.
type Json = Record<string, any>;

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: Record<string, { enum?: string[] }> };

const marker = (): string => randomUUID();

function openContext(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    deadline: 1_900_000_000_000,
    engine: "exampledb",
    connectionId: marker(),
    seedId: marker(),
    connection: { host: marker(), port: 7000, user: marker(), password: marker(), allowInsecureAuth: false },
    tunnelFarEnd: { host: marker(), port: 22 },
    tunnelRoute: marker(),
    admittedFile: ":memory:",
    admittedHostPaths: { clientCertificatePath: `/${marker()}`, clientPrivateKeyPath: `/${marker()}` },
    tls: { mode: "verify-full", caCert: marker(), clientCert: marker(), clientKey: marker(), rejectUnauthorized: true },
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: [marker()] },
    policy: {
      readOnly: false,
      sendsStatements: true,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
    pool: { min: 0, max: 4, idleTimeout: 30_000, acquireTimeout: 5_000 },
    timezone: "UTC",
  };
  change(draft);
  return draft;
}

function executeAnswer(change: (draft: Json) => void = () => {}): Json {
  const draft: Json = {
    results: [
      {
        result: marker(),
        columns: [
          { name: "id", type: "int4" },
          {
            name: "embedding",
            vector: { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "index-map" },
          },
        ],
        rowCount: 2,
      },
    ],
    warnings: [
      { message: marker(), code: 1, severity: "notice" },
      { message: marker(), code: "01000" },
    ],
    executionTimeMs: 3,
    pageApplied: false,
    boundApplied: true,
    explainPlan: { plan: [marker()] },
  };
  change(draft);
  return draft;
}

/** One well-formed value of each part of each call, and a second, minimal one where a part has optional members. */
function wellFormed(): readonly (readonly [ServedCall, FramePart, unknown])[] {
  return [
    ["open", "context", openContext()],
    [
      "open",
      "context",
      openContext((c) => {
        for (const key of ["seedId", "tunnelFarEnd", "tunnelRoute", "admittedFile", "admittedHostPaths", "tls", "pool"])
          delete c[key];
        delete c.timezone;
        c.connection = {};
      }),
    ],
    ["open", "answer", { serverVersion: marker(), refine: { calls: { console: { cancel: "not-offered" } } } }],
    ["open", "answer", {}],
    ["close", "context", { deadline: 1 }],
    ["console.execute", "context", { deadline: 1 }],
    [
      "console.execute",
      "request",
      {
        statement: marker(),
        runId: marker(),
        params: [1, marker(), null, [2], { a: 1 }],
        page: { limit: 500, offset: 0 },
        scope: marker(),
      },
    ],
    ["console.execute", "request", { statement: marker(), page: { unlimited: true } }],
    ["console.execute", "answer", executeAnswer()],
    [
      "console.execute",
      "answer",
      executeAnswer((a) => {
        a.results = [];
        a.warnings = [];
        delete a.boundApplied;
        delete a.explainPlan;
      }),
    ],
    ["console.cancel", "context", { deadline: 1 }],
    ["console.cancel", "request", { runId: marker() }],
    ["console.cancel", "answer", { cancelled: true }],
    ["console.endScope", "context", { deadline: 1 }],
    ["console.endScope", "request", { scope: marker() }],
    ["console.endScope", "answer", { openTransaction: "rolled-back" }],
    ["result.next", "request", { maxRows: 100, maxBytes: 1_048_576 }],
    [
      "result.next",
      "answer",
      {
        rows: [
          [1, marker()],
          [null, { a: [1] }],
        ],
        done: true,
      },
    ],
    ["result.next", "answer", { rows: [], done: false }],
  ];
}

/** readFrame over any call and part, for a table of cases; each call's own parts are typed at its call site. */
function read(call: ServedCall, part: FramePart, value: unknown): readonly FrameRefusal[] {
  return (readFrame as (call: ServedCall, part: FramePart, value: unknown) => readonly FrameRefusal[])(
    call,
    part,
    value,
  );
}

function refusal(
  rule: FrameRefusalRule,
  call: ServedCall,
  part: FramePart,
  pointer: string,
  name?: string,
): FrameRefusal {
  return name === undefined ? { rule, call, part, pointer } : { rule, call, part, pointer, name };
}

describe("readFrame", () => {
  test("a well-formed frame of every call and part is admitted", () => {
    const cases = wellFormed();

    for (const [call, part, value] of cases) expect([call, part, read(call, part, value)]).toEqual([call, part, []]);
    expect([...new Set(cases.map(([call, part]) => `${call} ${part}`))]).toEqual([
      "open context",
      "open answer",
      "close context",
      "console.execute context",
      "console.execute request",
      "console.execute answer",
      "console.cancel context",
      "console.cancel request",
      "console.cancel answer",
      "console.endScope context",
      "console.endScope request",
      "console.endScope answer",
      "result.next request",
      "result.next answer",
    ]);
    expect(new Set(cases.map(([call]) => call))).toEqual(
      new Set(SERVED_CALLS.filter((call) => call !== "result.close")),
    );
  });

  test("a key a frame's shape does not define is refused as frame-key-unknown at its pointer", () => {
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.extra = marker())),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/extra", "extra")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.tls["a/b~c"] = 1)),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/tls/a~1b~0c", "a/b~c")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.signal = {})),
      ),
    ).toEqual([refusal("frame-key-unknown", "open", "context", "/signal", "signal")]);
    expect(readFrame("open", "answer", { handle: {} })).toEqual([
      refusal("frame-key-unknown", "open", "answer", "/handle", "handle"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => {
          a.results[0].columns[1].vector.extra = 1;
          a.warnings[1].extra = 1;
        }),
      ),
    ).toEqual([
      refusal("frame-key-unknown", "console.execute", "answer", "/results/0/columns/1/vector/extra", "extra"),
      refusal("frame-key-unknown", "console.execute", "answer", "/warnings/1/extra", "extra"),
    ]);
    expect(readFrame("result.next", "request", { maxRows: 1, maxBytes: 1, rows: 1 })).toEqual([
      refusal("frame-key-unknown", "result.next", "request", "/rows", "rows"),
    ]);
    expect(
      readFrame("console.cancel", "answer", Object.defineProperty({ cancelled: true }, "hidden", { value: 1 })),
    ).toEqual([refusal("frame-key-unknown", "console.cancel", "answer", "/hidden", "hidden")]);
  });

  test("a required key a frame lacks is refused as frame-key-missing", () => {
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => delete c.egress),
      ),
    ).toEqual([refusal("frame-key-missing", "open", "context", "/egress", "egress")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => delete c.policy.managed),
      ),
    ).toEqual([refusal("frame-key-missing", "open", "context", "/policy/managed", "managed")]);
    expect(readFrame("close", "context", {})).toEqual([
      refusal("frame-key-missing", "close", "context", "/deadline", "deadline"),
    ]);
    expect(readFrame("console.execute", "request", { page: { unlimited: true } })).toEqual([
      refusal("frame-key-missing", "console.execute", "request", "/statement", "statement"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => delete a.results[0].columns),
      ),
    ).toEqual([refusal("frame-key-missing", "console.execute", "answer", "/results/0/columns", "columns")]);
    expect(readFrame("result.next", "answer", { rows: [] })).toEqual([
      refusal("frame-key-missing", "result.next", "answer", "/done", "done"),
    ]);
  });

  test("a value of the wrong type or outside its vocabulary is refused as frame-value-unreadable", () => {
    const unreadable = (call: ServedCall, part: FramePart, pointer: string) =>
      refusal("frame-value-unreadable", call, part, pointer);
    const withHole: unknown[] = [];
    withHole.length = 2 ** 32 - 1;
    let reads = 0;
    const accessor = Object.defineProperty({ deadline: 1 }, "deadline", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });

    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.tls.mode = "verify")),
      ),
    ).toEqual([unreadable("open", "context", "/tls/mode")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => (c.egress.source = "inferred")),
      ),
    ).toEqual([unreadable("open", "context", "/egress/source")]);
    expect(
      readFrame(
        "open",
        "context",
        openContext((c) => {
          c.deadline = String(c.deadline);
          c.trust.certificates = [1];
          c.pool.max = null;
          c.policy.readOnly = "false";
          c.tunnelFarEnd = [];
        }),
      ),
    ).toEqual([
      unreadable("open", "context", "/deadline"),
      unreadable("open", "context", "/tunnelFarEnd"),
      unreadable("open", "context", "/trust/certificates/0"),
      unreadable("open", "context", "/policy/readOnly"),
      unreadable("open", "context", "/pool/max"),
    ]);
    expect(
      readFrame(
        "console.execute",
        "answer",
        executeAnswer((a) => {
          a.results[0].columns[1].vector = { kind: "ragged", dtype: "float128", dimension: "3", sparseEncoding: "csr" };
          a.warnings[0].code = true;
          a.boundApplied = false;
        }),
      ),
    ).toEqual([
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/kind"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/dtype"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/dimension"),
      unreadable("console.execute", "answer", "/results/0/columns/1/vector/sparseEncoding"),
      unreadable("console.execute", "answer", "/warnings/0/code"),
      unreadable("console.execute", "answer", "/boundApplied"),
    ]);
    expect(readFrame("console.endScope", "answer", { openTransaction: "open" })).toEqual([
      unreadable("console.endScope", "answer", "/openTransaction"),
    ]);
    expect(readFrame("result.next", "answer", { rows: [[1], 2], done: true })).toEqual([
      unreadable("result.next", "answer", "/rows/1"),
    ]);
    expect(readFrame("console.cancel", "answer", null)).toEqual([unreadable("console.cancel", "answer", "")]);
    expect(
      readFrame("console.execute", "request", { statement: "s", params: withHole, page: { unlimited: true } }),
    ).toEqual([unreadable("console.execute", "request", "/params/0")]);
    expect(readFrame("close", "context", accessor)).toEqual([unreadable("close", "context", "/deadline")]);
    expect(reads).toBe(0);
  });

  test("a page bound is exactly one of its two forms", () => {
    const page = (bound: unknown) => readFrame("console.execute", "request", { statement: marker(), page: bound });
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "console.execute", "request", pointer);

    expect(page({ limit: 1, offset: 0 })).toEqual([]);
    expect(page({ unlimited: true })).toEqual([]);
    expect(page({ limit: 1, offset: 0, unlimited: true })).toEqual([unreadable("/page")]);
    expect(page({})).toEqual([unreadable("/page")]);
    expect(page([])).toEqual([unreadable("/page")]);
    expect(page({ unlimited: false })).toEqual([unreadable("/page/unlimited")]);
    expect(page({ limit: 1 })).toEqual([
      refusal("frame-key-missing", "console.execute", "request", "/page/offset", "offset"),
    ]);
  });

  test("a connection's keys are the contract's field names and each value a connection field value", () => {
    const fieldNames = SCHEMA.$defs.fieldName?.enum ?? [];
    const connection = (value: Json) =>
      readFrame(
        "open",
        "context",
        openContext((c) => (c.connection = value)),
      );
    const unreadable = (pointer: string) => refusal("frame-value-unreadable", "open", "context", pointer);

    expect(fieldNames).toHaveLength(35);
    expect(connection(Object.fromEntries(fieldNames.map((name) => [name, marker()])))).toEqual([]);
    expect(connection({ host: marker(), port: 1, allowInsecureAuth: true, namespaces: [marker(), marker()] })).toEqual(
      [],
    );
    expect(connection({ notAField: marker() })).toEqual([
      refusal("frame-key-unknown", "open", "context", "/connection/notAField", "notAField"),
    ]);
    expect(connection({ host: null, port: { value: 1 }, namespaces: [1], database: [[marker()]] })).toEqual([
      unreadable("/connection/host"),
      unreadable("/connection/port"),
      unreadable("/connection/namespaces/0"),
      unreadable("/connection/database/0"),
    ]);
  });

  test("no frame refusal and no sentence carries a value of the frame", () => {
    const planted = [marker(), marker(), marker(), marker()];
    const refusals = [
      ...readFrame(
        "open",
        "context",
        openContext((c) => {
          c.tls.mode = planted[0];
          c.connection.port = { [marker()]: planted[1] };
          c.unknown = planted[2];
          c.engine = [planted[3]];
        }),
      ),
      ...readFrame("console.endScope", "answer", { openTransaction: planted[0] }),
    ];
    const text = JSON.stringify(refusals) + new FrameRefusalError(refusals).message;

    expect(refusals.length).toBe(5);
    for (const value of planted) expect(text).not.toContain(value);
  });
});

describe("frameRefusalSentence", () => {
  test("every frame refusal rule is worded in one sentence", () => {
    for (const rule of FRAME_REFUSAL_RULES) {
      for (const call of SERVED_CALLS) {
        const forms: FrameRefusal[] = [
          { rule, call, part: "answer", pointer: "" },
          { rule, call, part: "request", pointer: "/a\nb", name: 'a"\nb' },
        ];
        for (const item of forms) {
          const sentence = frameRefusalSentence(item);

          expect(sentence).toMatch(/^[A-Z][^\n]*\.$/);
          expect(sentence).not.toMatch(/\. [A-Z]/);
          expect(sentence).toContain(call);
        }
        expect(frameRefusalSentence(forms[0])).toContain("the top level");
        expect(frameRefusalSentence(forms[1])).toContain('"/a\\nb"');
      }
    }
  });

  test("a FrameRefusalError carries every refusal and words each", () => {
    const refusals = readFrame(
      "open",
      "context",
      openContext((c) => {
        delete c.egress;
        c.extra = 1;
      }),
    );
    const error = new FrameRefusalError(refusals);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FrameRefusalError");
    expect(error.refusals).toEqual([
      refusal("frame-key-unknown", "open", "context", "/extra", "extra"),
      refusal("frame-key-missing", "open", "context", "/egress", "egress"),
    ]);
    expect(error.refusals).not.toBe(refusals);
    expect(Object.isFrozen(error.refusals)).toBe(true);
    expect(error.message).toBe(refusals.map(frameRefusalSentence).join(" "));
    expect(frameRefusalSentence(error.refusals[0] as FrameRefusal)).toBe(
      'The key "extra" at "/extra" of the context of the open frame is one its shape does not define.',
    );
  });
});
