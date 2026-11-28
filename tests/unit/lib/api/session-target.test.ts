/**
 * The session targets of the caller facades (src/lib/api/session-target.ts): what a facade of the provider host core
 * runs its calls on, a session, the environment each call is given, its statement timeout and the run marks of its
 * cache entry. A legacy provider's target is one bridged session of it, with no environment, its provider's statement
 * timeout and marks that count nothing; `markedCall` brackets one call with a target's marks.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CallRefusalError } from "@libredb/provider-sdk/calls";
import {
  entryConsoleTarget,
  entryMonitoringTarget,
  markedCall,
  packageMaintenanceOpening,
  providerConsoleTarget,
  providerMaintenanceTarget,
  providerMonitoringTarget,
  providerTreeTarget,
  type SessionTarget,
} from "@/lib/api/session-target";
import type { CachedSession } from "@/lib/db/factory";
import type { EngineConnection } from "@/lib/db/server-catalog";
import { DEFAULT_QUERY_TIMEOUT, type DatabaseProvider, type MaintenanceDeclaration } from "@/lib/db/types";
import { bridgedConsole, bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { OpenedPackageSession } from "@/lib/provider-host/open-engine";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

/** A declaration with vacuum on a row and whole, and analyze on a row. */
const DECLARED: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "analyze"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum", perEntity: true, global: true },
    analyze: { label: "Analyze", perEntity: true, global: false },
  },
};

/** A mock PostgreSQL provider whose statement timeout is `queryTimeout`, connected as `DECLARED`. */
function providerOf(queryTimeout?: number): DatabaseProvider {
  return createMockProvider({
    config: { id: "c1", name: "Prod", type: "postgres", host: "db.internal", queryTimeout } as DatabaseConnection,
    capabilities: { supportsMaintenance: true, ...DECLARED },
  });
}

/** The mock behind a provider's member, for its recorded calls and its implementation. */
const mockOf = (fn: unknown) => fn as ReturnType<typeof mock>;

/** Marks that record each mark in `marks`. */
function recordedMarks(marks: string[]): Pick<SessionTarget<unknown>, "started" | "ended"> {
  return {
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(`ended ${record?.kind}`);
    },
  };
}

describe("the session targets of a legacy provider", () => {
  test("a provider's monitoring target is one bridged session with no environment and no marks under the provider's statement timeout, and its maintenance target reads the provider's narrowed maintenance when a call reads it, never when it is built", async () => {
    const provider = providerOf(4_000);
    const monitoring = providerMonitoringTarget(provider);
    expect(monitoring.session.calls.monitoring.panel).toBe("offered");
    expect(monitoring.session.panels).toBe(bridgedConsole(provider, {}).session.panels);
    expect(typeof monitoring.session.health).toBe("function");
    // No environment: the reader a legacy provider's tree target holds, which declares no variable.
    expect(monitoring.env).toBe(providerTreeTarget(provider).env);
    expect(() => monitoring.env.get(randomUUID())).toThrow();
    // The statement timeout is read when asked, so a later change of the connection's timeout is the one read.
    expect(monitoring.timeout()).toBe(4_000);
    provider.config.queryTimeout = 7_000;
    expect(monitoring.timeout()).toBe(7_000);
    expect(monitoring.started()).toBeUndefined();
    expect(monitoring.ended({ kind: "answered" })).toBeUndefined();

    // The maintenance target's session is the bridged one without its maintenance, which no builder reads.
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockClear();
    const maintenance = providerMaintenanceTarget(provider, DECLARED);
    const builtReads = capabilities.mock.calls.length;
    expect(Object.hasOwn(maintenance.session, "maintenance")).toBe(false);
    expect(maintenance.session.calls.maintenance.run).toBe("offered");
    expect(maintenance.env).toBe(monitoring.env);
    expect(maintenance.timeout()).toBe(7_000);
    expect(maintenance.started()).toBeUndefined();
    expect(maintenance.ended(undefined)).toBeUndefined();
    // Read on each call: the declaration narrowed by what the connected provider accepts at that call.
    const first = maintenance.maintenance();
    expect(capabilities.mock.calls.length).toBe(builtReads + 1);
    expect(first).toEqual(bridgedMaintenance(provider, DECLARED));
    capabilities.mockImplementation(() => ({ supportsMaintenance: true, maintenanceOperations: ["vacuum"] }));
    const second = maintenance.maintenance();
    expect(second).not.toBe(first);
    expect(second).toEqual(bridgedMaintenance(provider, DECLARED));
    expect(second).not.toEqual(first);

    // A declaration the SDK refuses to narrow is refused by `maintenance()`, never by the builder.
    const refused = { ...DECLARED, maintenanceOperations: ["vacuum", "analyze", "shrink"] };
    const unreadable = {
      ...refused,
      maintenanceOperationSpecs: { ...DECLARED.maintenanceOperationSpecs, shrink: { label: "Shrink" } },
    } as unknown as MaintenanceDeclaration;
    const built = providerMaintenanceTarget(provider, unreadable);
    expect(() => built.maintenance()).toThrow(CallRefusalError);

    // The engine user is the provider's, read when asked: none for a provider that names none.
    expect(maintenance.engineUser()).toBeUndefined();
    const engineUser = `user-${randomUUID()}`;
    const named = providerMaintenanceTarget(
      { ...provider, engineUser: () => engineUser } as DatabaseProvider,
      DECLARED,
    );
    expect(named.engineUser()).toBe(engineUser);
  });

  test("markedCall marks a call started before it runs and ended as its record once it answered, and ended undefined for a call that threw, passing the error as the same object", async () => {
    const marks: string[] = [];
    const target = recordedMarks(marks);
    const answer = { kind: "answered" as const, answer: randomUUID() };
    const record = await markedCall(target, async () => {
      marks.push("called");
      return answer;
    });
    expect(record).toBe(answer);
    expect(marks).toEqual(["started", "called", "ended answered"]);

    marks.length = 0;
    const thrown = new Error(randomUUID());
    let caught: unknown;
    try {
      await markedCall(target, () => Promise.reject(thrown));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(marks).toEqual(["started", "ended undefined"]);
  });
});

describe("the monitoring target of a cache entry", () => {
  /** A provider package's session entry offering `maintenance.run` or not, with a full spec and a bare one. */
  function packageEntry(run: "offered" | "not-offered") {
    const session = {
      calls: { maintenance: { run, preview: "offered" } },
      maintenance: {
        maintenance: ["vacuum", "kill"],
        maintenanceSpecs: [
          {
            operation: "vacuum",
            label: "Vacuum",
            perEntity: true,
            global: false,
            title: "Vacuum the table",
            description: "Reclaims space.",
            confirmation: "typed-target",
            preview: true,
            kinds: ["table"],
          },
          {
            operation: "kill",
            label: "Kill",
            perEntity: false,
            global: false,
            title: null,
            description: null,
            confirmation: null,
            preview: false,
            kinds: null,
          },
        ],
      },
      marker: randomUUID(),
    };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    return { entry, session, env };
  }
  const connection = { id: "p", name: "p", type: "acmemon", queryTimeout: 1234 } as unknown as EngineConnection;

  test("a package entry's monitoring target is its session under its declared environment and the connection's timeout, its calls marked on the entry, and its accepted maintenance the session's narrowed maintenance in Studio's form", async () => {
    const { entry, session, env } = packageEntry("offered");
    const target = entryMonitoringTarget(entry, connection);
    expect(target.session as unknown).toBe(session);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    expect(entryMonitoringTarget(entry, { ...connection, queryTimeout: undefined }).timeout()).toBe(
      DEFAULT_QUERY_TIMEOUT,
    );
    await markedCall(target, async () => {
      expect(entry.running).toBe(1);
      return { kind: "answered" as const };
    });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);

    // Studio's form: each spec's absent card fields absent, and `preview` only where the spec states it true.
    const accepted = target.accepted();
    expect(accepted).toEqual({
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum", "kill"],
      maintenanceOperationSpecs: {
        vacuum: {
          label: "Vacuum",
          perEntity: true,
          global: false,
          title: "Vacuum the table",
          description: "Reclaims space.",
          confirmation: "typed-target",
          preview: true,
          kinds: ["table"],
        },
        kill: { label: "Kill", perEntity: false, global: false },
      },
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.keys(accepted.maintenanceOperationSpecs?.kill ?? {})).toEqual(["label", "perEntity", "global"]);
    // A copy: what a caller reads cannot reach the session's own lists.
    expect(accepted.maintenanceOperations).not.toBe(session.maintenance.maintenance);
    expect(accepted.maintenanceOperationSpecs?.vacuum?.kinds).not.toBe(session.maintenance.maintenanceSpecs[0]?.kinds);

    // A session that does not offer `maintenance.run` accepts none, whatever its declaration lists.
    expect(entryMonitoringTarget(packageEntry("not-offered").entry, connection).accepted()).toEqual({
      supportsMaintenance: false,
      maintenanceOperations: [],
      maintenanceOperationSpecs: {},
    });
  });

  test("a provider entry's monitoring target is the provider's, whose accepted maintenance is the provider's capabilities read when asked", () => {
    const provider = providerOf(4_000);
    const entry = { opened: { form: "provider", provider }, running: 0 } as unknown as CachedSession;
    const capabilities = mockOf(provider.getCapabilities);
    capabilities.mockClear();
    // A legacy provider's target reads the provider's own statement timeout, never the connection's.
    const target = entryMonitoringTarget(entry, connection);
    expect(target.session.calls.monitoring.panel).toBe("offered");
    expect(target.timeout()).toBe(4_000);
    expect(target.env).toBe(providerMonitoringTarget(provider).env);
    target.started();
    target.ended({ kind: "answered" });
    expect(entry.running).toBe(0);

    const fresh = { supportsMaintenance: true, maintenanceOperations: ["analyze"] };
    capabilities.mockImplementation(() => fresh);
    const before = capabilities.mock.calls.length;
    expect(target.accepted()).toBe(fresh as never);
    expect(capabilities.mock.calls.length).toBe(before + 1);
    expect(providerMonitoringTarget(provider).accepted()).toBe(fresh as never);
  });
});

describe("the console target", () => {
  test("a provider's console target is one bridged session with no environment and no marks, and an entry's is its session by form, the package's counting each call on the entry", async () => {
    // A provider's: one bridged session, which offers the cancel exactly where the provider can cancel.
    const provider = providerOf(4_000);
    Object.assign(provider, { cancelQuery: mock(async () => true) });
    const target = providerConsoleTarget(provider);
    expect(target.session.calls.console.cancel).toBe("offered");
    expect(target.session.calls).toEqual(bridgedConsole(provider, {}).session.calls);
    expect(target.env).toBe(providerTreeTarget(provider).env);
    expect(target.timeout()).toBe(4_000);
    expect(target.started()).toBeUndefined();
    expect(target.ended({ kind: "answered" })).toBeUndefined();
    expect(providerConsoleTarget(providerOf()).session.calls.console.cancel).toBe("not-offered");

    // A provider entry's: the provider's console target, its statement timeout the provider's own.
    const providerEntry = { opened: { form: "provider", provider }, running: 0 } as unknown as CachedSession;
    const connection = { id: "p", name: "p", type: "acmecon", queryTimeout: 1234 } as unknown as EngineConnection;
    const fromProvider = entryConsoleTarget(providerEntry, connection);
    expect(fromProvider.session.calls).toEqual(target.session.calls);
    expect(fromProvider.env).toBe(target.env);
    expect(fromProvider.timeout()).toBe(4_000);
    fromProvider.started();
    fromProvider.ended({ kind: "answered" });
    expect(providerEntry.running).toBe(0);

    // A package entry's: its session, its declared environment, the connection's timeout or Studio's default, and
    // each call counted on the entry until it answered, or until the call a stop answered has settled.
    const session = { calls: { console: { cancel: "offered" } }, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    const packaged = entryConsoleTarget(entry, connection);
    expect(packaged.session as unknown).toBe(session);
    expect(packaged.env as unknown).toBe(env);
    expect(packaged.timeout()).toBe(1234);
    expect(entryConsoleTarget(entry, { ...connection, queryTimeout: undefined }).timeout()).toBe(DEFAULT_QUERY_TIMEOUT);
    packaged.started();
    expect(entry.running).toBe(1);
    packaged.ended({ kind: "answered" });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);
    const settled = Promise.withResolvers<void>();
    packaged.started();
    packaged.ended({ kind: "stopped", settled: settled.promise });
    expect(entry.running).toBe(1);
    settled.resolve();
    await settled.promise;
    await Promise.resolve();
    expect(entry.running).toBe(0);
  });
});

describe("the maintenance opening of a provider package's cache entry", () => {
  /** A session offering `maintenance.run` or not, its narrowed maintenance one vacuum spec. */
  function packageOpened(run: "offered" | "not-offered", engineUser?: string) {
    const maintenance = {
      maintenance: ["vacuum"],
      maintenanceSpecs: [
        {
          operation: "vacuum",
          label: "Vacuum",
          perEntity: false,
          global: true,
          title: null,
          description: null,
          confirmation: null,
          preview: false,
          kinds: null,
        },
      ],
    };
    const session = { calls: { maintenance: { run, preview: "not-offered" } }, maintenance, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const opened = { session, env, ...(engineUser === undefined ? {} : { engineUser }) };
    const entry = { opened: { form: "session", ...opened }, running: 0, lastUsed: 0 } as unknown as CachedSession;
    return { entry, opened: opened as unknown as OpenedPackageSession, session, env, maintenance };
  }
  const connection = { id: "p", name: "p", type: "acmemaint", queryTimeout: 1234 } as unknown as EngineConnection;

  test("a package entry's maintenance opening accepts the session's narrowed maintenance and its target is the session under its environment and timeout, marked on the entry, with the engine user its open answered", async () => {
    const engineUser = `user-${randomUUID()}`;
    const { entry, opened, session, env, maintenance } = packageOpened("offered", engineUser);
    const opening = packageMaintenanceOpening(entry, opened, connection);
    expect(opening.accepted()).toEqual({
      supportsMaintenance: true,
      maintenanceOperations: ["vacuum"],
      maintenanceOperationSpecs: { vacuum: { label: "Vacuum", perEntity: false, global: true } },
    });
    const target = await opening.target();
    expect(target.session as unknown).toBe(session);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    expect(target.maintenance() as unknown).toBe(maintenance);
    expect(target.engineUser()).toBe(engineUser);
    await markedCall(target, async () => {
      expect(entry.running).toBe(1);
      return { kind: "answered" as const };
    });
    expect([entry.running, entry.lastUsed > 0]).toEqual([0, true]);
    const untimed = await packageMaintenanceOpening(entry, opened, { ...connection, queryTimeout: undefined }).target();
    expect(untimed.timeout()).toBe(DEFAULT_QUERY_TIMEOUT);

    // An open that answered no engine user names none; a session that does not offer `maintenance.run` accepts none.
    const unnamed = packageOpened("not-offered");
    const refusing = packageMaintenanceOpening(unnamed.entry, unnamed.opened, connection);
    expect((await refusing.target()).engineUser()).toBeUndefined();
    expect(refusing.accepted()).toEqual({
      supportsMaintenance: false,
      maintenanceOperations: [],
      maintenanceOperationSpecs: {},
    });
  });
});
