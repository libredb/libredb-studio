/**
 * The provider loader's import of a package entry, in the test process (docs/providers/CONTRACT.md, clauses C-87 to
 * C-89; docs/TOOLCHAIN.md, "The provider loader").
 *
 * Every fixture is a module written into one temporary directory before the first case, one file per case, since a
 * runtime caches a module by its URL. A fixture reaches the test through `globalThis` under
 * `Symbol.for("libredb-test.provider-loader.<case>")`: the test places a gate or a generated value there before the
 * import, and a fixture sets a flag there where it must show that none of its code ran.
 *
 * No case waits on a timer: a deadline case is settled by the loader's own timer through a plain `await`, and a late
 * settle is awaited through the promise its port resolves.
 *
 * This file imports the loader by its source path, which is how its lines are measured; Studio itself reaches it only
 * by its package name (tests/unit/lib/provider-loader/packaging.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as loader from "@/lib/provider-loader/index.cjs";

const { admitted, loadPackage } = loader;
type LateSettle = loader.LateSettle;

const DEADLINE_MS = 5_000;
const SHORT_DEADLINE_MS = 50;

let dir = "";

/** The `globalThis` slot of one case. */
const slot = (name: string): symbol => Symbol.for(`libredb-test.provider-loader.${name}`);
const slots = globalThis as unknown as Record<symbol, unknown>;

/** The fixture's source line that reads the slot of `name`. */
const slotSource = (name: string): string =>
  `globalThis[Symbol.for(${JSON.stringify(`libredb-test.provider-loader.${name}`)})]`;

/** The fixture's source line that sets the flag of `name`. */
const setFlag = (name: string): string => `${slotSource(name)} = "ran";`;

const FIXTURES: Record<string, string> = {
  "record.mjs": [
    'const record = { marker: "record" };',
    `${slotSource("record")} = record;`,
    "export default record;",
  ].join("\n"),
  "own-dependency/index.mjs": ['import dep from "dep-y";', "export default { version: dep.version };"].join("\n"),
  "own-dependency/node_modules/dep-y/package.json": JSON.stringify({
    name: "dep-y",
    version: "1.0.0",
    main: "index.js",
  }),
  "own-dependency/node_modules/dep-y/index.js": 'module.exports = { version: "1.0.0-own" };',
  "null-prototype.mjs": 'export default Object.assign(Object.create(null), { marker: "null-prototype" });',
  "no-default.mjs": "export const named = 1;",
  "interop-wrapper.mjs": [
    "const wrapper = { __esModule: true };",
    'Object.defineProperty(wrapper, "default", {',
    "  enumerable: true,",
    `  get() { ${setFlag("interop-wrapper")} return {}; },`,
    "});",
    "export default wrapper;",
  ].join("\n"),
  "not-a-record/null.mjs": "export default null;",
  "not-a-record/function.mjs": `export default function provider() { ${setFlag("not-a-record.function")} }`,
  "not-a-record/array.mjs": "export default [1, 2];",
  "not-a-record/instance.mjs": [
    "class Provider {",
    `  get open() { ${setFlag("not-a-record.instance")} return undefined; }`,
    "}",
    "export default new Provider();",
  ].join("\n"),
  "not-a-record/proxy.mjs": [
    "const handler = {};",
    "for (const trap of [",
    '  "apply", "construct", "defineProperty", "deleteProperty", "get", "getOwnPropertyDescriptor",',
    '  "getPrototypeOf", "has", "isExtensible", "ownKeys", "preventExtensions", "set", "setPrototypeOf",',
    "]) {",
    `  handler[trap] = (...args) => { ${setFlag("not-a-record.proxy")} return Reflect[trap](...args); };`,
    "}",
    "export default new Proxy({}, handler);",
  ].join("\n"),
  "not-a-record/number.mjs": "export default 1;",
  "commonjs-wrapper.cjs": 'module.exports = { __esModule: true, default: { marker: "inner" } };',
  "throws.mjs": [
    `const error = new Error(${slotSource("throws")}.message);`,
    `${slotSource("throws")}.error = error;`,
    "throw error;",
  ].join("\n"),
  "flag-at-import.mjs": [setFlag("flag-at-import"), "export default {};"].join("\n"),
  "late-success.mjs": [`await ${slotSource("late-success")}.gate;`, 'export default { marker: "late" };'].join("\n"),
  "late-rejection.mjs": [
    `await ${slotSource("late-rejection")}.gate;`,
    `const error = new Error(${slotSource("late-rejection")}.message);`,
    `${slotSource("late-rejection")}.error = error;`,
    "throw error;",
    "export default {};",
  ].join("\n"),
};

const NOT_A_RECORD = ["null", "function", "array", "instance", "proxy", "number"] as const;

/** The absolute path of a fixture. */
const fixture = (name: string): string => path.join(dir, name);

/** A late port that records each settle and resolves `settled` on the first. */
function recordingPort(): {
  readonly calls: LateSettle[];
  readonly settled: Promise<void>;
  port(settle: LateSettle): void;
} {
  const calls: LateSettle[] = [];
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    calls,
    settled,
    port(settle: LateSettle): void {
      calls.push(settle);
      resolveSettled();
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "provider-loader-load-"));
  for (const [name, text] of Object.entries(FIXTURES)) {
    mkdirSync(path.dirname(fixture(name)), { recursive: true });
    writeFileSync(fixture(name), `${text}\n`);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the loader imports an entry and reads only its default", () => {
  test("the loader exports loadPackage, registerAdmitted and admitted, and nothing else", () => {
    // An import of CommonJS adds the module's exports object as its default.
    expect(
      Object.keys(loader)
        .filter((name) => name !== "default")
        .sort(),
    ).toEqual(["admitted", "loadPackage", "registerAdmitted"]);
  });

  test("a package's entry is imported from its file URL, and its default record is answered as it was exported", async () => {
    const late = recordingPort();

    const answer = await loadPackage(fixture("record.mjs"), { deadlineMs: DEADLINE_MS, onLateSettle: late.port });

    expect(answer).toEqual({ loaded: true, entry: fixture("record.mjs"), record: { marker: "record" } });
    expect(answer.loaded && answer.record).toBe(slots[slot("record")] as object);
    expect(Object.isFrozen(answer)).toBe(true);
    expect(late.calls).toEqual([]);
  });

  test("a package's entry resolves its own dependencies from its own node_modules", async () => {
    const answer = await loadPackage(fixture("own-dependency/index.mjs"), {
      deadlineMs: DEADLINE_MS,
      onLateSettle: () => undefined,
    });

    expect(answer).toEqual({
      loaded: true,
      entry: fixture("own-dependency/index.mjs"),
      record: { version: "1.0.0-own" },
    });
  });

  test("a record with a null prototype is answered as loaded", async () => {
    const answer = await loadPackage(fixture("null-prototype.mjs"), {
      deadlineMs: DEADLINE_MS,
      onLateSettle: () => undefined,
    });

    expect(answer.loaded).toBe(true);
    expect(answer.loaded && Object.getPrototypeOf(answer.record)).toBeNull();
  });

  test("a namespace with no default is refused as PROVIDER_LOAD_FAILED, default-missing", async () => {
    const answer = await loadPackage(fixture("no-default.mjs"), {
      deadlineMs: DEADLINE_MS,
      onLateSettle: () => undefined,
    });

    expect(answer).toEqual({
      loaded: false,
      code: "PROVIDER_LOAD_FAILED",
      reason: "default-missing",
      entry: fixture("no-default.mjs"),
    });
    expect(Object.isFrozen(answer)).toBe(true);
  });

  test("an interop wrapper is refused as PROVIDER_LOAD_FAILED, interop-wrapper, and its inner default is never read", async () => {
    const answer = await loadPackage(fixture("interop-wrapper.mjs"), {
      deadlineMs: DEADLINE_MS,
      onLateSettle: () => undefined,
    });

    expect(answer).toEqual({
      loaded: false,
      code: "PROVIDER_LOAD_FAILED",
      reason: "interop-wrapper",
      entry: fixture("interop-wrapper.mjs"),
    });
    expect(slots[slot("interop-wrapper")]).toBeUndefined();
  });

  test("a default that is not a plain record is refused as PROVIDER_LOAD_FAILED, not-a-record, and none of its code runs", async () => {
    const answers = await Promise.all(
      NOT_A_RECORD.map((kind) =>
        loadPackage(fixture(`not-a-record/${kind}.mjs`), { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined }),
      ),
    );

    expect(answers).toEqual(
      NOT_A_RECORD.map((kind) => ({
        loaded: false,
        code: "PROVIDER_LOAD_FAILED",
        reason: "not-a-record",
        entry: fixture(`not-a-record/${kind}.mjs`),
      })),
    );
    expect(NOT_A_RECORD.map((kind) => slots[slot(`not-a-record.${kind}`)])).toEqual(NOT_A_RECORD.map(() => undefined));
  });

  test("under Bun, a CommonJS entry's interop wrapper is unwrapped by Bun itself, so only an ES module entry reads alike on every runtime", async () => {
    // Node answers this entry's wrapper as the default and the loader refuses it
    // (tests/unit/lib/provider-loader/node-runtime.test.ts); Bun unwraps it before the loader reads it.
    const answer = await loadPackage(fixture("commonjs-wrapper.cjs"), {
      deadlineMs: DEADLINE_MS,
      onLateSettle: () => undefined,
    });

    expect(answer).toEqual({ loaded: true, entry: fixture("commonjs-wrapper.cjs"), record: { marker: "inner" } });
  });
});

describe("the deadline and the refusals of a failed import", () => {
  test("an import that throws is refused as PROVIDER_LOAD_FAILED, import-threw, with the thrown value as its cause and no text of it in the refusal", async () => {
    const message = randomUUID();
    const state: { message: string; error?: Error } = { message };
    slots[slot("throws")] = state;

    const answer = await loadPackage(fixture("throws.mjs"), { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });

    expect(answer.loaded).toBe(false);
    if (answer.loaded) throw new Error("unreachable: the answer is a refusal");
    expect(state.error).toBeInstanceOf(Error);
    expect(answer.cause).toBe(state.error);
    const members = Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "cause"));
    expect(members).toEqual({
      loaded: false,
      code: "PROVIDER_LOAD_FAILED",
      reason: "import-threw",
      entry: fixture("throws.mjs"),
    });
    expect(JSON.stringify(members)).not.toContain(message.slice(0, 8));
    expect(Object.isFrozen(answer)).toBe(true);
  });

  test("a missing entry file is refused as PROVIDER_LOAD_FAILED, import-threw", async () => {
    const entry = fixture("missing.mjs");

    const answer = await loadPackage(entry, { deadlineMs: DEADLINE_MS, onLateSettle: () => undefined });

    expect(answer).toMatchObject({ loaded: false, code: "PROVIDER_LOAD_FAILED", reason: "import-threw", entry });
    expect(!answer.loaded && answer.cause).toBeInstanceOf(Error);
  });

  test("a relative entry, a deadline outside 1 to 2147483647 ms and a port that is not a function are refused before any import", async () => {
    const entry = fixture("flag-at-import.mjs");
    const port = (): undefined => undefined;

    await expect(
      loadPackage(path.relative(process.cwd(), entry), { deadlineMs: DEADLINE_MS, onLateSettle: port }),
    ).rejects.toThrow(new TypeError("loadPackage: entry must be an absolute path"));
    await expect(loadPackage(42 as unknown as string, { deadlineMs: DEADLINE_MS, onLateSettle: port })).rejects.toThrow(
      new TypeError("loadPackage: entry must be an absolute path"),
    );
    await Promise.all(
      [0, -1, 1.5, 2_147_483_648, Number.NaN, "100" as unknown as number].map((deadlineMs) =>
        expect(loadPackage(entry, { deadlineMs, onLateSettle: port })).rejects.toThrow(
          new TypeError("loadPackage: deadlineMs must be a whole number of milliseconds from 1 to 2147483647"),
        ),
      ),
    );
    await expect(
      loadPackage(entry, { deadlineMs: DEADLINE_MS, onLateSettle: undefined as unknown as () => void }),
    ).rejects.toThrow(new TypeError("loadPackage: onLateSettle must be a function"));
    await Promise.all(
      [undefined, null].map((options) =>
        expect(loadPackage(entry, options as unknown as Parameters<typeof loadPackage>[1])).rejects.toThrow(
          new TypeError("loadPackage: options must be an object"),
        ),
      ),
    );

    expect(slots[slot("flag-at-import")]).toBeUndefined();
  });
});

describe("a late settle is never answered as loaded and never left unhandled", () => {
  test("an import past its deadline is refused as PROVIDER_LOAD_FAILED, deadline-passed, and its late success reaches the port once and is never answered as loaded", async () => {
    let open: () => void = () => undefined;
    slots[slot("late-success")] = {
      gate: new Promise<void>((resolve) => {
        open = resolve;
      }),
    };
    const late = recordingPort();
    const entry = fixture("late-success.mjs");

    const answer = await loadPackage(entry, { deadlineMs: SHORT_DEADLINE_MS, onLateSettle: late.port });

    expect(answer).toEqual({ loaded: false, code: "PROVIDER_LOAD_FAILED", reason: "deadline-passed", entry });
    expect(late.calls).toEqual([]);
    open();
    await late.settled;
    expect(late.calls).toEqual([{ entry, outcome: "fulfilled" }]);
    expect(Object.isFrozen(late.calls[0])).toBe(true);
    expect(admitted()).toEqual([]);
  });

  test("an import that rejects after its deadline reaches the port once with its cause, and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      let open: () => void = () => undefined;
      const state: { gate: Promise<void>; message: string; error?: Error } = {
        gate: new Promise<void>((resolve) => {
          open = resolve;
        }),
        message: randomUUID(),
      };
      slots[slot("late-rejection")] = state;
      const late = recordingPort();
      const entry = fixture("late-rejection.mjs");

      const answer = await loadPackage(entry, { deadlineMs: SHORT_DEADLINE_MS, onLateSettle: late.port });

      expect(answer).toEqual({ loaded: false, code: "PROVIDER_LOAD_FAILED", reason: "deadline-passed", entry });
      open();
      await late.settled;
      await new Promise((resolve) => setImmediate(resolve));
      expect(state.error).toBeInstanceOf(Error);
      expect(late.calls).toEqual([{ entry, outcome: "rejected", cause: state.error }]);
      expect(late.calls[0]?.outcome === "rejected" && late.calls[0].cause).toBe(state.error as Error);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});
