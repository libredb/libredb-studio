/**
 * The open context core builds for an admitted provider package's engine (src/lib/provider-host/open-context.ts;
 * docs/providers/CONTRACT.md, clause C-109): only the fields the declaration admits, core's own decisions, the
 * deadline the caller derived from the engine's connect budget, and the package's declared environment.
 *
 * Engines are composed in memory from the SDK's minimal manifest (tests/helpers/package-catalog.ts); every secret is
 * generated at run time. The trust material setting is kept per process, so the case that reads it runs the engine
 * that does not read it first. No platform behaviour is relied on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONNECT_BUDGET_MS, UndeclaredEnvironmentError } from "@libredb/provider-sdk/calls";
import { egressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { DEFAULT_POOL_CONFIG } from "@/lib/db/types";
import { packageConnectBudget, packageEnvironment, packageOpenContext } from "@/lib/provider-host/open-context";
import { LITERAL_SEED_FILE } from "@/lib/types";
import { admittedFor, admittedManifest, type EditableEngine } from "../../../helpers/package-catalog";

/** The engine of `id` composed from the minimal manifest changed by `edit`, as the server catalog holds it. */
function engineOf(id: string, edit: (engine: EditableEngine) => void = () => undefined): EngineRecord {
  const catalog = composeServerCatalog(
    [admittedFor(`acme-${id}`, admittedManifest(id, edit))],
    [],
    STUDIO_GRANT_REGISTER,
  );
  return catalog.engines.get(id) as EngineRecord;
}

/** Fields `host` and `password` only, a budget of 90 s, and the TLS modes `require` and `verify-full`. */
function narrowFields(engine: EditableEngine): void {
  engine.connection.fields = ["host", "password"];
  engine.connection.defaults = {};
  engine.connection.connectBudgetMs = 90_000;
  (engine.connection.tls as Record<string, unknown>).modes = ["require", "verify-full"];
}

const narrow = engineOf("acmeocnarrow", narrowFields);
const plain = engineOf("acmeocplain");

/** A connection of `engine` with `fields`. */
function connectionOf(engine: EngineRecord, fields: Record<string, unknown> = {}): EngineConnection {
  return { id: "conn-oc", name: "OC", type: engine.id, ...fields } as unknown as EngineConnection;
}

/** The refusal `build` throws. */
function refusalOf(build: () => unknown): DatabaseConfigError {
  try {
    build();
  } catch (error) {
    return error as DatabaseConfigError;
  }
  throw new Error("expected a refusal");
}

const signal = new AbortController().signal;
const ENV_SET = `ACME_OC_${randomUUID().replaceAll("-", "_").toUpperCase()}`;
afterAll(() => {
  delete process.env[ENV_SET];
});

describe("the open context of a provider package's engine", () => {
  test("the open context carries the deadline, the connect budget and only the fields the declaration admits", () => {
    const password = randomUUID();
    const agentPassword = randomUUID();
    const deadline = Date.now() + packageConnectBudget(narrow);
    const ctx = packageOpenContext({
      connection: connectionOf(narrow, {
        host: "db.local",
        password,
        user: "writer",
        agentUser: "agent",
        agentPassword,
        sshTunnel: { enabled: false, host: "bastion", port: 22, username: "u", authMethod: "password" },
        zzzUndeclared: "x",
        ssl: { mode: "require" },
      }),
      engine: narrow,
      execution: {},
      deadline,
      signal,
    });

    expect(ctx.engine).toBe("acmeocnarrow");
    expect(ctx.connectionId).toBe("conn-oc");
    expect(ctx.connection).toEqual({ host: "db.local", password });
    expect(Object.isFrozen(ctx.connection)).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain(agentPassword);
    expect(Object.keys(ctx).sort()).toEqual(
      [
        "connection",
        "connectionId",
        "deadline",
        "egress",
        "engine",
        "env",
        "policy",
        "pool",
        "signal",
        "tls",
        "trust",
      ].sort(),
    );
    expect(ctx.deadline).toBe(deadline);
    expect(ctx.signal).toBe(signal);
    expect(packageConnectBudget(narrow)).toBe(90_000);
    expect(packageConnectBudget(plain)).toBe(DEFAULT_CONNECT_BUDGET_MS);
    expect(ctx.policy).toEqual({
      readOnly: false,
      sendsStatements: false,
      allowExternalFileAccess: false,
      refuseWrites: false,
      managed: false,
      literalSeedFile: false,
    });

    const granted = packageOpenContext({
      connection: {
        ...connectionOf(plain, { managed: true }),
        [LITERAL_SEED_FILE]: true,
      } as EngineConnection,
      engine: plain,
      execution: { allowExternalFileAccess: true },
      deadline,
      signal,
    });
    expect(granted.connection).toEqual({});
    expect(granted.policy).toMatchObject({ allowExternalFileAccess: true, managed: true, literalSeedFile: true });
    expect(Object.hasOwn(granted, "tls")).toBe(false);
  });

  test("a field value outside the contract's value forms is refused by field, never by value", () => {
    const secret = randomUUID();
    for (const [field, value] of [
      ["host", { secret }],
      ["password", Number.NaN],
      ["host", [secret, 1]],
    ] as const) {
      const error = refusalOf(() =>
        packageOpenContext({
          connection: connectionOf(narrow, { [field]: value }),
          engine: narrow,
          execution: {},
          deadline: Date.now() + 1000,
          signal,
        }),
      );
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(
        `The connection's ${field} is not a value Studio hands a provider package: it takes a text, a finite number, true or false, or a list of texts.`,
      );
      expect(error.message).not.toContain(secret);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    const listed = packageOpenContext({
      connection: connectionOf(plain, { host: "h", port: 7001, user: "u", database: ["a", "b"], password: null }),
      engine: plain,
      execution: {},
      deadline: Date.now() + 1000,
      signal,
    });
    expect(listed.connection).toEqual({ host: "h", port: 7001, user: "u", database: ["a", "b"] });
  });

  test("tls is the connection's ssl only for a mode the declaration lists, and refused by name otherwise", () => {
    const caCert = randomUUID();
    const open = (ssl: unknown) =>
      packageOpenContext({
        connection: connectionOf(narrow, { ssl }),
        engine: narrow,
        execution: {},
        deadline: Date.now() + 1000,
        signal,
      });
    expect(open({ mode: "verify-full", caCert, rejectUnauthorized: true, extra: 1 }).tls).toEqual({
      mode: "verify-full",
      caCert,
      rejectUnauthorized: true,
    });
    expect(Object.hasOwn(open(null), "tls")).toBe(false);
    for (const ssl of [{ mode: "disable" }, {}, "require"]) {
      const error = refusalOf(() => open(ssl));
      expect(error.message).toBe(
        "The connection's TLS mode is not one its provider package declares for the engine, so Studio does not open it.",
      );
      expect(errorOutcome(error)).toBe("not-sent");
    }
    expect(refusalOf(() => open({ mode: "require", caCert: 1 })).message).toBe(
      "The connection's TLS caCert is not a text.",
    );
    expect(refusalOf(() => open({ mode: "require", rejectUnauthorized: "yes" })).message).toBe(
      "The connection's TLS rejectUnauthorized is not a boolean.",
    );
  });

  test("trust material is read only for a declaration that reads it, and egress is core's decision", () => {
    const reads = engineOf("acmeoctrust", (engine) => {
      engine.connection.readsTrustMaterial = true;
    });
    const before = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NODE_EXTRA_CA_CERTS = `/nonexistent-${randomUUID()}/ca.pem`;
    try {
      const notRead = packageOpenContext({
        connection: connectionOf(plain),
        engine: plain,
        execution: {},
        deadline: Date.now() + 1000,
        signal,
      });
      expect(notRead.trust).toEqual({ certificates: [] });
      expect(notRead.egress).toEqual(egressDecision());
      const error = refusalOf(() =>
        packageOpenContext({
          connection: connectionOf(reads),
          engine: reads,
          execution: {},
          deadline: Date.now() + 1000,
          signal,
        }),
      );
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message.startsWith("Invalid NODE_EXTRA_CA_CERTS:")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = before;
    }
  });

  test("the environment reader answers a declared name from the process and refuses any other by name, never reading it", () => {
    const value = randomUUID();
    process.env[ENV_SET] = value;
    const manifest = admittedManifest("acmeocenv");
    const declared = { ...manifest, runtime: { ...manifest.runtime, env: [{ name: ENV_SET, purpose: "a test" }] } };
    const env = packageEnvironment(declared);
    expect(env.get(ENV_SET)).toBe(value);
    expect(() => env.get("PATH")).toThrow(UndeclaredEnvironmentError);
    expect(() => packageEnvironment(manifest).get(ENV_SET)).toThrow(UndeclaredEnvironmentError);
  });

  test("the pool is core's default for a shared session and the owner's share for an owned one", () => {
    const open = (execution: Record<string, unknown>) =>
      packageOpenContext({
        connection: connectionOf(plain),
        engine: plain,
        execution,
        deadline: Date.now() + 1000,
        signal,
      }).pool;
    expect(open({})).toEqual({ ...DEFAULT_POOL_CONFIG });
    expect(open({ owner: "sub-1", ownerPoolMax: 3 })).toEqual({ ...DEFAULT_POOL_CONFIG, min: 0, max: 3 });
  });

  test("the pool is the metadata session's smaller pool when the open asks for it, shared and owned", () => {
    const pool = { min: 0, max: 2 } as const;
    const open = (execution: Record<string, unknown>) =>
      packageOpenContext({
        connection: connectionOf(plain),
        engine: plain,
        execution,
        deadline: Date.now() + 1000,
        signal,
        pool,
      }).pool;
    expect(open({})).toEqual({ ...DEFAULT_POOL_CONFIG, min: 0, max: 2 });
    expect(open({ owner: "sub-1", ownerPoolMax: 7 })).toEqual({ ...DEFAULT_POOL_CONFIG, min: 0, max: 2 });
  });
});
