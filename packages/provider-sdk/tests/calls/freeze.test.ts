/**
 * The host passes every context and request deep-frozen, leaving the signal and the environment reader as they are
 * (docs/providers/CONTRACT.md, clauses C-11 and C-12).
 *
 * The test files are modules, so each write below runs in strict mode, where a write to a frozen object throws.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ExecuteRequest,
  envReader,
  freezeContext,
  freezeData,
  type OpenContext,
} from "@libredb/provider-sdk/calls";
import { encodeValue, ValueCodecError } from "@libredb/provider-sdk/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a frozen value written to through a loose type, to see the write throw.
type Loose = any;

/** Every object and array `value` holds, at every depth, with its pointer; never `skip`. */
function objects(value: unknown, pointer = "", skip: readonly unknown[] = []): [string, object][] {
  if (typeof value !== "object" || value === null || skip.includes(value)) return [];
  return [
    [pointer, value],
    ...Object.entries(value).flatMap(([key, item]) => objects(item, `${pointer}/${key}`, skip)),
  ];
}

function openContext(): { ctx: OpenContext; controller: AbortController } {
  const controller = new AbortController();
  const ctx: OpenContext = {
    deadline: Date.now() + 60_000,
    signal: controller.signal,
    env: envReader([{ name: "EXAMPLE_HOME", purpose: "where the client is" }], () => undefined),
    engine: "exampledb",
    connectionId: randomUUID(),
    connection: { host: "db.example", port: 7000, user: "reader", database: "main", dataServers: ["a", "b"] },
    tunnelFarEnd: { host: "inner.example", port: 7001 },
    admittedHostPaths: { clientCertificatePath: "/etc/example/client.pem" },
    tls: { mode: "verify-full", rejectUnauthorized: true },
    egress: { blocksPrivateHosts: true, source: "default" },
    trust: { certificates: ["-----BEGIN CERTIFICATE-----", "-----END CERTIFICATE-----"] },
    policy: {
      readOnly: false,
      sendsStatements: true,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    },
    pool: { min: 0, max: 4, idleTimeout: 10_000, acquireTimeout: 5_000 },
  };
  return { ctx, controller };
}

describe("freezeContext", () => {
  test("a context is frozen at every depth, and a write to any of it throws", () => {
    const { ctx } = openContext();

    expect(freezeContext(ctx)).toBe(ctx);
    const found = objects(ctx, "", [ctx.signal, ctx.env]);
    expect(found.map(([pointer]) => pointer)).toEqual([
      "",
      "/connection",
      "/connection/dataServers",
      "/tunnelFarEnd",
      "/admittedHostPaths",
      "/tls",
      "/egress",
      "/trust",
      "/trust/certificates",
      "/policy",
      "/pool",
    ]);
    for (const [, value] of found) expect(Object.isFrozen(value)).toBe(true);
    const loose = ctx as Loose;
    const writes: (() => void)[] = [
      () => (loose.engine = "other"),
      () => (loose.connection.host = "elsewhere"),
      () => loose.connection.dataServers.push("c"),
      () => (loose.tunnelFarEnd.port = 1),
      () => (loose.admittedHostPaths.clientPrivateKeyPath = "/tmp/key"),
      () => (loose.tls.mode = "disable"),
      () => (loose.egress.blocksPrivateHosts = false),
      () => loose.trust.certificates.push("more"),
      () => (loose.policy.readOnly = true),
      () => delete loose.pool.max,
    ];
    for (const write of writes) expect(write).toThrow(TypeError);
  });

  test("the signal and the environment reader are left as the host passed them, and the signal still aborts", () => {
    const { ctx, controller } = openContext();
    const { signal, env } = ctx;

    freezeContext(ctx);

    expect(ctx.signal).toBe(signal);
    expect(ctx.env).toBe(env);
    expect(Object.isFrozen(ctx.signal)).toBe(false);
    let heard = 0;
    ctx.signal.addEventListener("abort", () => (heard += 1));
    const dependant = AbortSignal.any([ctx.signal]);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
    expect(heard).toBe(1);
    expect(dependant.aborted).toBe(true);
  });
});

describe("freezeData", () => {
  test("a request is frozen at every depth, except its typed arrays and dates", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const when = new Date(86_400_000);
    const nested = { a: { b: [1, "two"] } };
    const request: ExecuteRequest = {
      statement: "select $1, $2, $3, $4",
      params: [bytes, when, BigInt(10), nested, null, Object.assign(Object.create(null), { c: 1 })],
      page: { limit: 500, offset: 0 },
    };

    expect(freezeData(request)).toBe(request);
    const found = objects(request, "", [bytes, when]);
    expect(found.map(([pointer]) => pointer)).toEqual([
      "",
      "/params",
      "/params/3",
      "/params/3/a",
      "/params/3/a/b",
      "/params/5",
      "/page",
    ]);
    for (const [, value] of found) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(false);
    expect(Object.isFrozen(when)).toBe(false);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(when.getTime()).toBe(86_400_000);
    expect(() => (request.params as Loose[]).push(1)).toThrow(TypeError);
    expect(() => ((request.page as Loose).offset = 500)).toThrow(TypeError);
    expect(freezeData("text")).toBe("text");
    expect(freezeData(BigInt(7))).toBe(BigInt(7));
  });

  test("a value that holds itself is frozen once", () => {
    const value: Loose = { list: [] };
    value.self = value;
    value.list.push(value, value.list);

    expect(freezeData(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
  });

  test("an object outside the value codec's domain is refused by its pointer", () => {
    class Point {
      x = 1;
    }
    const { ctx } = openContext();
    const cases: [Loose, string, (value: Loose) => unknown][] = [
      [{ statement: "s", params: [new Map()], page: { limit: 1, offset: 0 } }, "/params/0", freezeData],
      [{ statement: "s", params: [{ at: new Point() }], page: { limit: 1, offset: 0 } }, "/params/0/at", freezeData],
      [{ statement: "s", page: { limit: 1, offset: 0, next: () => 2 } }, "/page/next", freezeData],
      [{ ...ctx, connection: { "a/b": new Set() } }, "/connection/a~1b", freezeContext],
    ];

    for (const [value, pointer, freeze] of cases) {
      let thrown: unknown;
      try {
        freeze(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as TypeError).message).toContain(JSON.stringify(pointer));
      // Nothing is frozen when anything is refused.
      for (const [, item] of objects(value, "", [value.signal, value.env])) expect(Object.isFrozen(item)).toBe(false);
    }
  });

  test("an accessor property is refused by its pointer, its getter never runs, and nothing is frozen", () => {
    let calls = 0;
    const held = { secret: "kept" };
    const getter = { get: () => ((calls += 1), held), enumerable: true, configurable: true };
    const request: Loose = { statement: "s", params: [{ a: {} }], page: { limit: 1, offset: 0 } };
    Object.defineProperty(request.params[0].a, "b/c", getter);
    const { ctx } = openContext();
    const context: Loose = { ...ctx, connection: { host: "db.example" } };
    Object.defineProperty(context, "tls", getter);

    for (const [value, pointer, freeze, plain] of [
      [
        request,
        "/params/0/a/b~1c",
        freezeData,
        [request, request.params, request.params[0], request.params[0].a, request.page],
      ],
      [context, "/tls", freezeContext, [context, context.connection, context.policy]],
    ] as [Loose, string, (value: Loose) => unknown, object[]][]) {
      expect(() => freeze(value)).toThrow(`The value at ${JSON.stringify(pointer)} is an accessor property`);
      for (const item of [...plain, held]) expect(Object.isFrozen(item)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  test("a symbol-keyed property is refused by the pointer of the object that holds it, and nothing is frozen", () => {
    const inner = { list: [1] };
    const request: Loose = { statement: "s", params: [{ inner }], page: { limit: 1, offset: 0 } };
    Object.defineProperty(inner.list, Symbol("hidden"), { value: { x: 1 }, enumerable: false });
    const { ctx } = openContext();
    const context: Loose = { ...ctx, [Symbol("extra")]: { y: 2 } };

    for (const [value, at, freeze] of [
      [request, JSON.stringify("/params/0/inner/list"), freezeData],
      [context, "the top level", freezeContext],
    ] as [Loose, string, (value: Loose) => unknown][]) {
      expect(() => freeze(value)).toThrow(`The value at ${at} holds a symbol-keyed property`);
      for (const [, item] of objects(value, "", [value.signal, value.env])) expect(Object.isFrozen(item)).toBe(false);
    }
  });

  test("an invalid Date is refused by its pointer, as the value codec refuses it, and nothing is frozen", () => {
    const request: Loose = {
      statement: "s",
      params: [new Date(86_400_000), { when: new Date(Number.NaN) }],
      page: { limit: 1, offset: 0 },
    };
    const { ctx } = openContext();
    const context: Loose = { ...ctx, connection: { since: new Date("not a date") } };

    for (const [value, pointer, freeze] of [
      [request, "/params/1/when", freezeData],
      [context, "/connection/since", freezeContext],
    ] as [Loose, string, (value: Loose) => unknown][]) {
      expect(() => freeze(value)).toThrow(`The value at ${JSON.stringify(pointer)} is an invalid Date`);
      for (const [, item] of objects(value, "", [value.signal, value.env])) expect(Object.isFrozen(item)).toBe(false);
    }
    expect(() => encodeValue(new Date(Number.NaN))).toThrow(ValueCodecError);
  });
});
