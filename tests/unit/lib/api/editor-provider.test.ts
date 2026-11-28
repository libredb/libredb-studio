import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { callRefusalSentence } from "@libredb/provider-sdk/calls";
import { isStudioFailure, packageFailureAnswer } from "@/lib/api/package-errors";
import { DatabaseConfigError, FacetNotOfferedError } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import type { ProviderTextScrub } from "@/lib/db/operations/provider-text";
import type { CachedSession } from "@/lib/db/factory";
import type { EngineConnection, EngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseProvider, MaintenanceDeclaration } from "@/lib/db/types";
import { HOST_DEFECT_PREFIX, HostDefectError } from "@/lib/provider-host/access";
import { bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

const opened: { connection: DatabaseConnection; context: unknown; wait: unknown[] }[] = [];
let connected: DatabaseProvider;
/** Every read of a legacy provider's declarations, as `readProviderDeclarations` receives it, and what it answers. */
const declarationReads: { connection: DatabaseConnection; context: unknown }[] = [];
let declared: MaintenanceDeclaration = { maintenanceOperations: [], maintenanceOperationSpecs: {} };

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(
    async (connection: DatabaseConnection, _options: unknown, context: unknown, ...wait: unknown[]) => {
      opened.push({ connection, context, wait });
      return connected;
    },
  ),
  readProviderDeclarations: async (connection: DatabaseConnection, context: unknown) => {
    declarationReads.push({ connection, context });
    return { capabilities: declared };
  },
}));

/** The writable cache by key, as `findCachedProvider` reads it. */
const cachedByKey = new Map<string, DatabaseProvider>();
/** Every open of an editor session, as `getOrCreateEditorSession` receives it, and the entry the case sets it to answer. */
const openedEditor: { connection: EngineConnection; engine: EngineRecord; context: unknown; rest: unknown[] }[] = [];
let editorEntry: CachedSession;
/** Every open of a metadata session of any record, as `getOrCreateMetadataSession` receives it, and its entry. */
const openedMetadataSessions: {
  connection: EngineConnection;
  engine: EngineRecord;
  context: unknown;
  rest: unknown[];
}[] = [];
let metadataEntry: CachedSession;
mock.module("@/lib/db/factory", () => ({
  getOrCreateMetadataSession: async (
    connection: EngineConnection,
    engine: EngineRecord,
    context: unknown,
    ...rest: unknown[]
  ) => {
    openedMetadataSessions.push({ connection, engine, context, rest });
    return metadataEntry;
  },
  findCachedProvider: (key: string) => cachedByKey.get(key) ?? null,
  getOrCreateEditorSession: async (
    connection: EngineConnection,
    engine: EngineRecord,
    context: unknown,
    ...rest: unknown[]
  ) => {
    openedEditor.push({ connection, engine, context, rest });
    return editorEntry;
  },
}));

const {
  assertEditorFieldsOffered,
  cachedEditorProvider,
  editorMaintenanceOpening,
  editorMonitoringTarget,
  editorProvider,
  editorSourceTarget,
  editorTarget,
  metadataMaintenanceOpening,
  metadataMonitoringTarget,
  metadataTreeTarget,
} = await import("@/lib/api/editor-provider");
const { providerSourceTarget, providerTreeTarget } = await import("@/lib/api/session-target");

const connection = { id: "c", name: "c", type: "postgres", host: "h", database: "" } as DatabaseConnection;
const session = (role: string) => ({ role });

function providerOf(capabilities: Record<string, unknown>, sessions: Record<string, DatabaseProvider> = {}) {
  return {
    type: "postgres",
    config: connection,
    getCapabilities: () => capabilities,
    forCatalog: async (catalog: string) => sessions[catalog],
  } as unknown as DatabaseProvider;
}

/** The one provider an editor request runs on (#1530). */
describe("editorProvider", () => {
  test("opens the connection under the session's editor posture, and without a catalog runs on it", async () => {
    connected = providerOf({});
    opened.length = 0;

    expect(await editorProvider(session("admin"), connection, undefined)).toBe(connected);
    expect(await editorProvider(session("user"), connection, undefined)).toBe(connected);
    expect(opened.map((open) => open.context)).toEqual([
      { allowExternalFileAccess: true },
      { allowExternalFileAccess: false },
    ]);
    expect(opened[0].connection).toBe(connection);
  });

  test("an editor request's open wait reaches the factory", async () => {
    connected = providerOf({});
    opened.length = 0;
    const wait = { signal: new AbortController().signal };

    expect(await editorProvider(session("user"), connection, undefined, wait)).toBe(connected);
    expect(await editorProvider(session("user"), connection, undefined)).toBe(connected);
    expect(opened[0]?.wait).toEqual([wait]);
    expect(opened[0]?.wait[0]).toBe(wait);
    expect(opened[1]?.wait).toEqual([undefined]);
  });

  test("a catalog runs on that database's session, and a connection without sessions refuses one", async () => {
    const shop = providerOf({});
    connected = providerOf({ catalogSessions: true }, { shop });
    expect(await editorProvider(session("user"), connection, "shop")).toBe(shop);

    connected = providerOf({});
    await expect(editorProvider(session("user"), connection, "shop")).rejects.toThrow(DatabaseConfigError);
  });
});

/** What the query route runs one statement on, for any record: the editor's session of the record, opened once. */
describe("editorTarget", () => {
  const legacyEngine = { id: "postgres", offers: { legacyProvider: true } } as unknown as EngineRecord;
  const packageEngine = { id: "acmeps", offers: { legacyProvider: false } } as unknown as EngineRecord;
  const packageConnection = { id: "p", name: "p", type: "acmeps", queryTimeout: 1234 } as unknown as EngineConnection;
  /** A provider package's session entry, its session and environment stand-ins the case reads back by reference. */
  function sessionEntry() {
    const session = { calls: {}, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session, env }, engine: packageEngine, running: 0 } as unknown;
    return { entry: entry as CachedSession, session, env };
  }

  test("editorTarget opens any record's editor session under the session's editor posture: a legacy provider in the request's catalog, and a package's session with its entry and the connection's statement timeout", async () => {
    const shopCapabilities = {};
    const serverCapabilities = { catalogSessions: true };
    const shop = providerOf(shopCapabilities);
    const server = providerOf(serverCapabilities, { shop });
    editorEntry = { opened: { form: "provider", provider: server }, engine: legacyEngine } as unknown as CachedSession;
    openedEditor.length = 0;
    const wait = { signal: new AbortController().signal };

    // A legacy provider's console target reads the provider it was built from: the catalog's session, or the server's.
    const legacy = await editorTarget(session("admin"), connection, legacyEngine, "shop", wait);
    expect(legacy.explainSupport()).toBe(shopCapabilities as never);
    const whole = await editorTarget(session("user"), connection, legacyEngine, undefined);
    expect(whole.explainSupport()).toBe(serverCapabilities as never);

    // A package's: its session, its declared environment, the connection's statement timeout, each call on the entry.
    const { entry, session: packageSession, env } = sessionEntry();
    editorEntry = entry;
    const target = await editorTarget(session("user"), packageConnection, packageEngine, undefined, wait);
    expect(target.session as unknown).toBe(packageSession);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    target.started();
    expect(entry.running).toBe(1);
    target.ended({ kind: "page" });
    expect(entry.running).toBe(0);

    // One open per call, of the record handed, under the editor posture of the session, with the request's own wait.
    expect(openedEditor.map((open) => [open.connection, open.engine, open.context])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }],
      [connection, legacyEngine, { allowExternalFileAccess: false }],
      [packageConnection, packageEngine, { allowExternalFileAccess: false }],
    ]);
    expect(openedEditor[0]?.rest[0]).toBe(wait);
    expect(openedEditor[1]?.rest).toEqual([undefined]);
    expect(openedEditor[2]?.rest[0]).toBe(wait);
  });

  test("a catalog handed with a provider package's session is Studio's host defect, raised by name before any run", async () => {
    editorEntry = sessionEntry().entry;
    openedEditor.length = 0;

    const raised = await editorTarget(session("user"), packageConnection, packageEngine, "shop").catch(
      (error: unknown) => error,
    );
    const refusal = { rule: "request-field-not-honoured", pointer: "/catalog", name: "catalog" } as const;
    expect(raised).toBeInstanceOf(HostDefectError);
    expect((raised as HostDefectError).refusals).toEqual([refusal]);
    expect((raised as HostDefectError).message).toBe(`${HOST_DEFECT_PREFIX} ${callRefusalSentence(refusal)}`);
    expect(openedEditor).toHaveLength(1);
  });

  test("the catalog host defect is Studio's own failure, so the query route's open answers it as itself, never as the package's", async () => {
    editorEntry = sessionEntry().entry;
    const raised = await editorTarget(session("user"), packageConnection, packageEngine, "shop").catch(
      (error: unknown) => error,
    );

    expect(isStudioFailure(raised)).toBe(true);
    // Studio's own failure returns before the scrub or the route is read, so neither is a working stand-in here.
    expect(packageFailureAnswer(packageEngine, "open", raised, {} as ProviderTextScrub, "/api/db/query")).toBe(raised);
  });
});

/** The request fields of the editor's routes a record may not offer, refused by name before any open. */
describe("assertEditorFieldsOffered", () => {
  const offering = (offers: Partial<EngineRecord["offers"]>) =>
    ({
      id: "acmefields",
      offers: {
        legacyProvider: false,
        explain: false,
        database: false,
        catalog: false,
        unboundedPage: false,
        ...offers,
      },
    }) as unknown as EngineRecord;
  const NOTHING = offering({});
  const EVERYTHING = offering({
    legacyProvider: true,
    explain: true,
    database: true,
    catalog: true,
    unboundedPage: true,
  });
  const request = (fields: { explain?: boolean; database?: number; unlimited?: boolean; catalog?: unknown }) => ({
    body: fields.catalog === undefined ? {} : { catalog: fields.catalog },
    explain: fields.explain === true,
    database: fields.database,
    unlimited: fields.unlimited === true,
  });
  /** What `assertEditorFieldsOffered` raised for `engine` and `fields`, or undefined when it raised nothing. */
  const refusalOf = (engine: EngineRecord, fields: Parameters<typeof request>[0]): unknown => {
    try {
      assertEditorFieldsOffered(engine, request(fields));
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const fieldSentence = (field: string) =>
    `This connection's engine does not offer the request field ${field} in this LibreDB Studio, so Studio opened nothing.`;
  const CATALOG_SENTENCE =
    "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.";

  test("refuses the first field the record does not offer by name, FacetNotOfferedError not-sent, explain before database before catalog before options.unlimited, and reads a catalog only where the record offers none", () => {
    const all = { explain: true, database: 2, catalog: "shop", unlimited: true };
    for (const [fields, operation, sentence] of [
      [all, "explain", fieldSentence("explain")],
      [{ ...all, explain: false }, "database", fieldSentence("database")],
      [{ catalog: "shop", unlimited: true }, "catalog", CATALOG_SENTENCE],
      [{ unlimited: true }, "options.unlimited", fieldSentence("options.unlimited")],
    ] as const) {
      const refused = refusalOf(NOTHING, fields);
      expect(refused).toBeInstanceOf(FacetNotOfferedError);
      const { message, facet, provider } = refused as FacetNotOfferedError;
      expect([message, facet, (refused as FacetNotOfferedError).operation, provider]).toEqual([
        sentence,
        "console",
        operation,
        undefined,
      ]);
      expect(errorOutcome(refused)).toBe("not-sent");
    }

    // A request setting none of them, and a record that offers each field it sets, are refused nothing.
    expect(refusalOf(NOTHING, {})).toBeUndefined();
    expect(refusalOf(EVERYTHING, all)).toBeUndefined();

    // A malformed catalog is read where the record offers none, so its 400 comes before any field's refusal; where the
    // record offers catalogs it is not read here, and keeps its answer where the route reads it.
    expect(refusalOf(NOTHING, { explain: true, catalog: 7 })).toBeInstanceOf(DatabaseConfigError);
    expect(refusalOf(EVERYTHING, { catalog: 7 })).toBeUndefined();
  });
});

/** The connection's metadata session, under the editor's posture, as the maintenance route runs a kill on it (C-66). */
describe("metadataMaintenanceOpening", () => {
  const legacyEngine = {
    id: connection.type,
    offers: { legacyProvider: true, catalog: true },
  } as unknown as EngineRecord;

  test("opens the connection's metadata session with the editor's connection and posture, and without a catalog runs on it", async () => {
    const metadata = providerOf({ supportsMaintenance: true, maintenanceOperations: ["kill"] });
    metadataEntry = { opened: { form: "provider", provider: metadata } } as unknown as CachedSession;
    connected = providerOf({});
    openedMetadataSessions.length = 0;
    opened.length = 0;

    const admin = await metadataMaintenanceOpening(session("admin"), connection, legacyEngine, undefined);
    const user = await metadataMaintenanceOpening(session("user"), connection, legacyEngine, undefined);
    expect([admin.accepted(), user.accepted()]).toEqual([metadata.getCapabilities(), metadata.getCapabilities()]);
    await editorProvider(session("admin"), connection, undefined);
    await editorProvider(session("user"), connection, undefined);

    expect(openedMetadataSessions.map((open) => open.context)).toEqual([
      { allowExternalFileAccess: true },
      { allowExternalFileAccess: false },
    ]);
    // Each the context editorProvider hands the editor's open for the same session.
    expect(openedMetadataSessions.map((open) => open.context)).toEqual(opened.map((open) => open.context));
    expect(openedMetadataSessions.map((open) => [open.engine, open.rest])).toEqual([
      [legacyEngine, []],
      [legacyEngine, []],
    ]);
    expect(openedMetadataSessions[0]?.connection).toBe(connection);
  });

  test("a catalog runs on that database's session of the metadata session, and a connection without sessions refuses one", async () => {
    const shop = providerOf({ supportsMaintenance: true, maintenanceOperations: ["kill"] });
    metadataEntry = {
      opened: { form: "provider", provider: providerOf({ catalogSessions: true }, { shop }) },
    } as unknown as CachedSession;
    const scoped = await metadataMaintenanceOpening(session("admin"), connection, legacyEngine, "shop");
    expect(scoped.accepted()).toBe(shop.getCapabilities() as never);

    metadataEntry = { opened: { form: "provider", provider: providerOf({}) } } as unknown as CachedSession;
    await expect(metadataMaintenanceOpening(session("admin"), connection, legacyEngine, "shop")).rejects.toThrow(
      DatabaseConfigError,
    );
  });
});

/** The object tree's session of any record: the record's metadata session by its form (C-66). */
describe("metadataTreeTarget", () => {
  const legacyEngine = { id: connection.type, offers: { legacyProvider: true } } as unknown as EngineRecord;
  const packageEngine = { id: "acmeps", offers: { legacyProvider: false } } as unknown as EngineRecord;
  const packageConnection = { id: "p", name: "p", type: "acmeps", queryTimeout: 1234 } as unknown as EngineConnection;

  test("the metadata tree target is the record's metadata session by its form, and a provider's target is one bridged session", async () => {
    // A legacy record's entry holds a provider: its target is one bridged session of it, no environment, the
    // provider's statement timeout, no marks, and its type as the whole server where it declares catalog sessions.
    const server = providerOf({ catalogSessions: true });
    metadataEntry = {
      opened: { form: "provider", provider: server },
      engine: legacyEngine,
    } as unknown as CachedSession;
    openedMetadataSessions.length = 0;
    const legacy = await metadataTreeTarget(session("admin"), connection, legacyEngine);
    expect(legacy.session.calls.objects.tree).toBe("offered");
    expect(legacy.session.objectModel).toEqual(providerTreeTarget(server).session.objectModel);
    expect(() => legacy.env.get("PATH")).toThrow();
    expect([legacy.timeout(), legacy.wholeServer()]).toEqual([60_000, connection.type]);
    expect(providerTreeTarget(providerOf({})).wholeServer()).toBeNull();
    expect(providerTreeTarget({ ...providerOf({}), config: { ...connection, queryTimeout: 5 } }).timeout()).toBe(5);
    legacy.started();
    legacy.ended(undefined);

    // A provider package's entry holds its session: its target is that session with its declared environment, the
    // connection's own statement timeout, no whole server, and each read counted on the entry while it runs.
    const packageSession = { calls: {}, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = {
      opened: { form: "session", session: packageSession, env },
      engine: packageEngine,
      running: 0,
      lastUsed: 0,
    } as unknown as CachedSession;
    metadataEntry = entry;
    const target = await metadataTreeTarget(session("user"), packageConnection, packageEngine);
    expect(target.session as unknown).toBe(packageSession);
    expect(target.env as unknown).toBe(env);
    expect([target.timeout(), target.wholeServer()]).toEqual([1234, null]);
    const untimed = await metadataTreeTarget(
      session("user"),
      { ...packageConnection, queryTimeout: undefined },
      packageEngine,
    );
    expect(untimed.timeout()).toBe(60_000);

    target.started();
    expect(entry.running).toBe(1);
    target.ended({ kind: "answered" });
    expect(entry.running).toBe(0);
    expect(entry.lastUsed).toBeGreaterThan(0);
    // A stopped read counts until the call it stopped waiting for has settled.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    target.started();
    target.ended({ kind: "stopped", settled });
    expect(entry.running).toBe(1);
    settle();
    await settled;
    await Promise.resolve();
    expect(entry.running).toBe(0);

    // One open per call, of the record handed, under the editor posture of the session.
    expect(openedMetadataSessions.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }, []],
      [packageConnection, packageEngine, { allowExternalFileAccess: false }, []],
      [{ ...packageConnection, queryTimeout: undefined }, packageEngine, { allowExternalFileAccess: false }, []],
    ]);
  });
});

/** The monitoring reads' session of any record: the metadata session for the dashboard and health, the editor's for pool statistics. */
describe("the monitoring openers", () => {
  const legacyEngine = {
    id: connection.type,
    offers: { legacyProvider: true, catalog: true },
  } as unknown as EngineRecord;
  const packageEngine = { id: "acmemon", offers: { legacyProvider: false, catalog: false } } as unknown as EngineRecord;
  const packageConnection = { id: "p", name: "p", type: "acmemon", queryTimeout: 1234 } as unknown as EngineConnection;
  /** A provider package's session entry, its session and environment stand-ins read back by reference. */
  function sessionEntry() {
    const packageSession = { calls: { maintenance: { run: "not-offered" } }, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session: packageSession, env }, running: 0, lastUsed: 0 } as unknown;
    return { entry: entry as CachedSession, packageSession, env };
  }

  test("the monitoring openers open any record's metadata or editor session, scope a legacy provider to the request's catalog, and refuse a catalog the record does not offer before any open", async () => {
    // A legacy record: the metadata session for the dashboard and health, the editor's for pool statistics, each
    // scoped to the request's catalog through the same `scopeToCatalog`.
    const shop = providerOf({ supportsMaintenance: true, maintenanceOperations: ["vacuum"] });
    const server = providerOf({ catalogSessions: true }, { shop });
    metadataEntry = { opened: { form: "provider", provider: server } } as unknown as CachedSession;
    editorEntry = { opened: { form: "provider", provider: server } } as unknown as CachedSession;
    openedMetadataSessions.length = 0;
    openedEditor.length = 0;
    const metadata = await metadataMonitoringTarget(session("admin"), connection, legacyEngine, "shop");
    const editor = await editorMonitoringTarget(session("user"), connection, legacyEngine, "shop");
    const whole = await metadataMonitoringTarget(session("user"), connection, legacyEngine, undefined);
    expect([metadata.accepted(), editor.accepted()]).toEqual([shop.getCapabilities(), shop.getCapabilities()]);
    expect(whole.accepted()).toEqual(server.getCapabilities());
    expect(openedMetadataSessions.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }, []],
      [connection, legacyEngine, { allowExternalFileAccess: false }, []],
    ]);
    // The editor's session with no wait of the request's own, as pool statistics opened it before.
    expect(openedEditor.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: false }, []],
    ]);

    // A provider package's entry: its session with its declared environment and the connection's timeout.
    const { entry, packageSession, env } = sessionEntry();
    metadataEntry = entry;
    editorEntry = entry;
    for (const open of [metadataMonitoringTarget, editorMonitoringTarget]) {
      const target = await open(session("user"), packageConnection, packageEngine, undefined);
      expect([target.session as unknown, target.env as unknown, target.timeout()]).toEqual([packageSession, env, 1234]);
    }

    // A catalog the record does not offer is refused by name, not-sent, before any open.
    openedMetadataSessions.length = 0;
    openedEditor.length = 0;
    for (const open of [metadataMonitoringTarget, editorMonitoringTarget]) {
      const refused = await open(session("user"), packageConnection, packageEngine, "shop").catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(FacetNotOfferedError);
      const { message, facet, operation, provider } = refused as FacetNotOfferedError;
      expect([message, facet, operation, provider]).toEqual([
        "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.",
        "monitoring",
        "catalog",
        undefined,
      ]);
      expect(errorOutcome(refused)).toBe("not-sent");
    }
    expect([openedMetadataSessions, openedEditor]).toEqual([[], []]);
  });
});

/** What a maintenance request opens, for any record: the editor's session, or the metadata session for a kill (C-66). */
describe("the maintenance openings", () => {
  const legacyEngine = {
    id: connection.type,
    offers: { legacyProvider: true, catalog: true },
  } as unknown as EngineRecord;
  const packageEngine = {
    id: "acmemaint",
    offers: { legacyProvider: false, catalog: false },
  } as unknown as EngineRecord;
  const packageConnection = {
    id: "p",
    name: "p",
    type: "acmemaint",
    queryTimeout: 1234,
  } as unknown as EngineConnection;
  const DECLARED: MaintenanceDeclaration = {
    maintenanceOperations: ["vacuum", "kill"],
    maintenanceOperationSpecs: { vacuum: { label: "Vacuum", perEntity: false, global: true } },
  };

  test("the maintenance openings open any record's editor or metadata session, read the accepted maintenance after the open and the target after the checks, and refuse a catalog the record does not offer before any open", async () => {
    // A legacy record: the editor's session, or the metadata session, each with no wait of the request's own and
    // scoped to the request's catalog through the same `scopeToCatalog`.
    const shop = providerOf({ supportsMaintenance: true, maintenanceOperations: ["vacuum"] });
    const server = providerOf({ catalogSessions: true }, { shop });
    metadataEntry = { opened: { form: "provider", provider: server } } as unknown as CachedSession;
    editorEntry = { opened: { form: "provider", provider: server } } as unknown as CachedSession;
    openedMetadataSessions.length = 0;
    openedEditor.length = 0;
    declarationReads.length = 0;
    const editor = await editorMaintenanceOpening(session("admin"), connection, legacyEngine, "shop");
    const metadata = await metadataMaintenanceOpening(session("user"), connection, legacyEngine, "shop");
    expect([editor.accepted(), metadata.accepted()]).toEqual([shop.getCapabilities(), shop.getCapabilities()]);
    expect(openedEditor.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }, []],
    ]);
    expect(openedMetadataSessions.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: false }, []],
    ]);
    // Nothing of the declarations is read until the target is asked for, after the route's checks.
    expect(declarationReads).toEqual([]);

    // The target reads the provider's declarations once, under the editor posture, and is the provider's maintenance
    // target: its maintenance the declaration narrowed by what the provider accepts, its engine user the provider's.
    const engineUser = `user-${randomUUID()}`;
    const provider = createMockProvider({
      config: connection,
      capabilities: { supportsMaintenance: true, ...DECLARED },
    });
    const named = { ...provider, engineUser: () => engineUser } as DatabaseProvider;
    editorEntry = { opened: { form: "provider", provider: named } } as unknown as CachedSession;
    declared = DECLARED;
    const opening = await editorMaintenanceOpening(session("admin"), connection, legacyEngine, undefined);
    const capabilities = provider.getCapabilities as unknown as ReturnType<typeof mock>;
    capabilities.mockClear();
    expect(opening.accepted()).toEqual(provider.getCapabilities());
    expect(capabilities.mock.calls.length).toBe(2);
    const target = await opening.target();
    expect(declarationReads).toEqual([{ connection, context: { allowExternalFileAccess: true } }]);
    expect(declarationReads[0]?.connection).toBe(connection);
    expect(target.maintenance()).toEqual(bridgedMaintenance(named, DECLARED));
    expect(target.engineUser()).toBe(engineUser);
    expect(target.session.calls.maintenance.run).toBe("offered");

    // A provider package's entry: its session's opening, the session's narrowed maintenance accepted.
    const packageSession = {
      calls: { maintenance: { run: "offered" } },
      maintenance: { maintenance: ["vacuum"], maintenanceSpecs: [] },
      marker: randomUUID(),
    };
    const env = { marker: randomUUID() };
    const entry = { opened: { form: "session", session: packageSession, env }, running: 0 } as unknown as CachedSession;
    metadataEntry = entry;
    editorEntry = entry;
    declarationReads.length = 0;
    for (const open of [editorMaintenanceOpening, metadataMaintenanceOpening]) {
      const packaged = await open(session("user"), packageConnection, packageEngine, undefined);
      expect(packaged.accepted()).toEqual({
        supportsMaintenance: true,
        maintenanceOperations: ["vacuum"],
        maintenanceOperationSpecs: {},
      });
      const packageTarget = await packaged.target();
      expect([packageTarget.session as unknown, packageTarget.env as unknown, packageTarget.timeout()]).toEqual([
        packageSession,
        env,
        1234,
      ]);
      expect(packageTarget.engineUser()).toBeUndefined();
    }
    // A package's target reads no declarations: its session states its maintenance.
    expect(declarationReads).toEqual([]);

    // A catalog the record does not offer is refused by name, not-sent, before any open.
    openedMetadataSessions.length = 0;
    openedEditor.length = 0;
    for (const open of [editorMaintenanceOpening, metadataMaintenanceOpening]) {
      const refused = await open(session("user"), packageConnection, packageEngine, "shop").catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(FacetNotOfferedError);
      const { message, facet, operation, provider: refusedProvider } = refused as FacetNotOfferedError;
      expect([message, facet, operation, refusedProvider]).toEqual([
        "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.",
        "maintenance",
        "catalog",
        undefined,
      ]);
      expect(errorOutcome(refused)).toBe("not-sent");
    }
    expect([openedMetadataSessions, openedEditor]).toEqual([[], []]);
  });

  test("a provider package's session handed a catalog by a record that offers one is Studio's host defect on every monitoring and maintenance opener, never ignored", async () => {
    // No real package record offers a catalog session, so the record here is planted: its offer lets the catalog past
    // the check before the open, and the session-form entry is then refused by name after the open.
    const catalogEngine = {
      id: "acmecatalog",
      offers: { legacyProvider: false, catalog: true },
    } as unknown as EngineRecord;
    const entry = {
      opened: { form: "session", session: { calls: {} }, env: {} },
      running: 0,
    } as unknown as CachedSession;
    metadataEntry = entry;
    editorEntry = entry;
    const refusal = { rule: "request-field-not-honoured", pointer: "/catalog", name: "catalog" } as const;
    const openers = [
      metadataMonitoringTarget,
      editorMonitoringTarget,
      editorMaintenanceOpening,
      metadataMaintenanceOpening,
    ];
    for (const open of openers) {
      openedMetadataSessions.length = 0;
      openedEditor.length = 0;
      const raised = await (open as typeof metadataMonitoringTarget)(
        session("user"),
        packageConnection,
        catalogEngine,
        "shop",
      ).catch((error: unknown) => error);
      expect(raised).toBeInstanceOf(HostDefectError);
      expect((raised as HostDefectError).refusals).toEqual([refusal]);
      expect(isStudioFailure(raised)).toBe(true);
      // Refused after the open, of the one session the opener opens.
      expect(openedMetadataSessions.length + openedEditor.length).toBe(1);
    }
  });
});

describe("editorSourceTarget", () => {
  const legacyEngine = { id: connection.type, offers: { legacyProvider: true } } as unknown as EngineRecord;
  const packageEngine = { id: "acmeps", offers: { legacyProvider: false } } as unknown as EngineRecord;
  const packageConnection = { id: "p", name: "p", type: "acmeps", queryTimeout: 1234 } as unknown as EngineConnection;

  test("the editor's source target is the record's editor session by its form, and a provider's target is one bridged session", async () => {
    // A legacy record's entry holds a provider: its target is one bridged session of it, offering objects.source
    // exactly where the provider defines readObjectSource, no environment, the provider's statement timeout, no marks.
    const reader = {
      ...providerOf({}),
      config: { ...connection, queryTimeout: 5 },
      readObjectSource: async () => ({ path: [], kind: "view", parts: [] }),
    } as unknown as DatabaseProvider;
    editorEntry = { opened: { form: "provider", provider: reader }, engine: legacyEngine } as unknown as CachedSession;
    openedEditor.length = 0;
    const legacy = await editorSourceTarget(session("admin"), connection, legacyEngine);
    expect(legacy.session.calls.objects.source).toBe("offered");
    expect(legacy.session.objectModel).toEqual(providerSourceTarget(reader).session.objectModel);
    expect(() => legacy.env.get("PATH")).toThrow();
    expect(legacy.timeout()).toBe(5);
    legacy.started();
    legacy.ended(undefined);
    editorEntry = {
      opened: { form: "provider", provider: providerOf({}) },
      engine: legacyEngine,
    } as unknown as CachedSession;
    const plain = await editorSourceTarget(session("admin"), connection, legacyEngine);
    expect(plain.session.calls.objects.source).toBe("not-offered");
    expect(Object.hasOwn(plain.session, "source")).toBe(false);

    // A provider package's entry holds its session: its target is that session with its declared environment, the
    // connection's own statement timeout or Studio's default, and each read counted on the entry while it runs.
    const packageSession = { calls: {}, marker: randomUUID() };
    const env = { marker: randomUUID() };
    const entry = {
      opened: { form: "session", session: packageSession, env },
      engine: packageEngine,
      running: 0,
      lastUsed: 0,
    } as unknown as CachedSession;
    editorEntry = entry;
    const target = await editorSourceTarget(session("user"), packageConnection, packageEngine);
    expect(target.session as unknown).toBe(packageSession);
    expect(target.env as unknown).toBe(env);
    expect(target.timeout()).toBe(1234);
    const untimed = await editorSourceTarget(
      session("user"),
      { ...packageConnection, queryTimeout: undefined },
      packageEngine,
    );
    expect(untimed.timeout()).toBe(60_000);

    target.started();
    expect(entry.running).toBe(1);
    target.ended({ kind: "answered" });
    expect(entry.running).toBe(0);
    expect(entry.lastUsed).toBeGreaterThan(0);
    // A stopped read counts until the call it stopped waiting for has settled.
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    target.started();
    target.ended({ kind: "stopped", settled });
    expect(entry.running).toBe(1);
    settle();
    await settled;
    await Promise.resolve();
    expect(entry.running).toBe(0);

    // One open per call, of the record handed, under the editor posture of the session, with no wait of its own.
    expect(openedEditor.map((open) => [open.connection, open.engine, open.context, open.rest])).toEqual([
      [connection, legacyEngine, { allowExternalFileAccess: true }, []],
      [connection, legacyEngine, { allowExternalFileAccess: true }, []],
      [packageConnection, packageEngine, { allowExternalFileAccess: false }, []],
      [{ ...packageConnection, queryTimeout: undefined }, packageEngine, { allowExternalFileAccess: false }, []],
    ]);
  });
});

/**
 * The provider an earlier editor request ran on, found again by the key it resolved
 * (docs/GOVERNANCE.md#per-user-providers).
 */
describe("cachedEditorProvider", () => {
  test("answers the provider cached under the key, in the catalog editorProvider scoped, and opens nothing", async () => {
    const shop = providerOf({});
    const server = providerOf({ catalogSessions: true }, { shop });
    cachedByKey.set("key-of-the-write-credential", server);
    opened.length = 0;

    expect(await cachedEditorProvider("key-of-the-write-credential", undefined)).toBe(server);
    expect(await cachedEditorProvider("key-of-the-write-credential", "shop")).toBe(shop);
    // Nothing is cached under another key: the idle sweep or a disconnect removed it, or it was never opened.
    expect(await cachedEditorProvider("key-of-the-read-credential", undefined)).toBeNull();
    expect(opened).toEqual([]);
  });
});

/**
 * Scoping is decided in one place. A route that scoped by hand could open the provider under another
 * posture, or skip the catalog check, and nothing else would notice. MCP is the one other caller: its
 * provider comes from its own context, not from an editor request.
 */
describe("catalog scoping call sites", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  test("only the editor provider and the MCP database choice call scopeToCatalog", () => {
    const callers = sources("src")
      .filter((path) => readFileSync(path, "utf8").includes("scopeToCatalog("))
      .map((path) => path.replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "src/lib/api/editor-provider.ts",
      "src/lib/db/catalog-scope.ts",
      "src/lib/mcp/tools/database-choice.ts",
    ]);
  }, 60_000);
});
