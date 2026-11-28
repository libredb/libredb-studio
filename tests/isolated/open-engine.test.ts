/**
 * The one open function (src/lib/provider-host/open-engine.ts): every engine opens through its record, the one ordered
 * open check first (`assertOpenable` in src/lib/db/open-check.ts) and then the record's open, a legacy record's through
 * the legacy adapter (`openLegacyEngine`) and a package record's through its package's `open`; what it answers is read
 * through accessors that refuse the other form as a host defect.
 *
 * Under tests/isolated because it admits fixture packages (tests/helpers/package-session-fixture.ts) and installs the
 * server catalog they compose, which the loader's registry and the catalog keep for the life of the process. The
 * check and the legacy open are observed through spies on their module namespaces, which see a call from another
 * module. Nothing awaits a timer; the package's open answers at once. No file mode, link or line ending is relied on.
 */
// oxlint-disable no-await-in-loop -- each refused open is read from the calls it alone recorded, so the opens run one at a time.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OpenContext } from "@libredb/provider-sdk/calls";
import { DatabaseConfigError } from "@/lib/db/errors";
import { errorCode, errorKind, errorOutcome } from "@/lib/db/error-record";
import * as openCheck from "@/lib/db/open-check";
import { type EngineConnection, type EngineRecord, forgetServerCatalog } from "@/lib/db/server-catalog";
import * as legacyOpen from "@/lib/provider-host/legacy-adapter/open";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import { logger } from "@/lib/logger";
import { openedProvider, openedSession, openEngine, providerForm } from "@/lib/provider-host/open-engine";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";

const ENGINE = "acmeopenengine";
const providers = scratchDirectory("studio-open-engine-");
let pkg: EngineRecord;

/** The package's hooks every case but the late failure's runs on. */
const HOOKS = {
  open: (ctx: unknown) => {
    opens.push(ctx as OpenContext);
    return Promise.resolve({ handle: { session: randomUUID() } });
  },
  close: () => Promise.resolve(),
};

/** A legacy record whose engine opens an in-memory database: chosen by its data, it admits a local file. */
const LEGACY = LEGACY_ENGINES.get("sqlite") as EngineRecord;

/** What the package's hooks saw: the open contexts its `open` was called with, and the handles it answered. */
const opens: OpenContext[] = [];

beforeAll(async () => {
  pkg = (
    await admitSessionPackages(providers, [{ name: "acme-open-engine", engine: ENGINE, env: ["LIBREDB_TEST_OE"] }])
  ).get(ENGINE) as EngineRecord;
  setHooks(ENGINE, HOOKS);
});
afterAll(() => {
  forgetServerCatalog();
  removeScratch(providers);
});
afterEach(() => {
  opens.length = 0;
});

/** A legacy connection the legacy record opens, with `fields`. */
function legacyConnection(fields: Record<string, unknown> = {}): EngineConnection {
  return { id: `oe-${randomUUID()}`, name: "OE", type: "sqlite", database: ":memory:", ...fields } as EngineConnection;
}

/** A package connection with a generated secret and `fields`. */
function packageConnection(fields: Record<string, unknown> = {}): EngineConnection {
  return {
    id: `oe-${randomUUID()}`,
    name: "OE",
    type: ENGINE,
    host: "db.local",
    password: randomUUID(),
    ...fields,
  } as unknown as EngineConnection;
}

/** The bounds of a package's open: a deadline far enough away and a signal no one aborts. */
function within() {
  return { deadline: Date.now() + 60_000, signal: new AbortController().signal };
}

/** What `work` rejected with. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("the one open function", () => {
  test("openEngine runs the one ordered open check on the context it opens with before the record's open, for a legacy and a package record", async () => {
    const order: string[] = [];
    const assertOpenable = openCheck.assertOpenable;
    const openLegacyEngine = legacyOpen.openLegacyEngine;
    const check = spyOn(openCheck, "assertOpenable").mockImplementation((...args) => {
      order.push("check");
      assertOpenable(...args);
    });
    const legacy = spyOn(legacyOpen, "openLegacyEngine").mockImplementation((...args) => {
      order.push("legacy");
      return openLegacyEngine(...args);
    });
    try {
      const execution = { allowExternalFileAccess: true };
      const connection = legacyConnection();
      await openEngine(LEGACY, { connection, execution, purpose: "connect", options: {} });
      expect(order).toEqual(["check", "legacy"]);
      expect(check.mock.calls).toEqual([[LEGACY, connection, execution, "connect"]]);
      expect(legacy.mock.calls[0]?.[0]).toBe(LEGACY);
      expect(legacy.mock.calls[0]?.[1]).toBe(connection);
      expect(legacy.mock.calls[0]?.[2]).toBe(execution);

      order.length = 0;
      check.mockClear();
      const declarations = legacyConnection();
      await openEngine(LEGACY, { connection: declarations, execution: {}, purpose: "declarations", options: {} });
      expect(check.mock.calls).toEqual([[LEGACY, declarations, {}, "declarations"]]);

      order.length = 0;
      check.mockClear();
      const owner = { allowExternalFileAccess: true, owner: "owner-a", ownerPoolMax: 2 };
      const opened = packageConnection();
      await openEngine(pkg, {
        connection: opened,
        execution: owner,
        purpose: "connect",
        options: {},
        within: within(),
      });
      expect(order).toEqual(["check"]);
      expect(check.mock.calls).toEqual([[pkg, opened, owner, "connect"]]);
      expect(opens).toHaveLength(1);
      expect(opens[0]?.policy.allowExternalFileAccess).toBe(true);
      expect(opens[0]?.pool).toMatchObject({ min: 0, max: 2 });

      // A refused connection reaches neither open.
      order.length = 0;
      opens.length = 0;
      for (const [engine, connection] of [
        [LEGACY, legacyConnection({ readOnly: "yes" })],
        [pkg, packageConnection({ readOnly: "yes" })],
      ] as const) {
        const error = await rejection(
          openEngine(engine, { connection, execution: {}, purpose: "connect", options: {}, within: within() }),
        );
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect(errorOutcome(error)).toBe("not-sent");
      }
      expect(order).toEqual(["check", "check"]);
      expect(opens).toEqual([]);
    } finally {
      check.mockRestore();
      legacy.mockRestore();
    }
  });

  test("a legacy record opens to an unconnected provider, and a package record to a connected session with its package's environment", async () => {
    const legacy = await openEngine(LEGACY, {
      connection: legacyConnection(),
      execution: { allowExternalFileAccess: true },
      purpose: "connect",
      options: {},
    });
    expect(legacy.form).toBe("provider");
    const provider = openedProvider(legacy);
    expect(provider.type).toBe("sqlite");
    expect(provider.isConnected()).toBe(false);

    const connection = packageConnection();
    const bounds = within();
    const session = await openEngine(pkg, {
      connection,
      execution: { allowExternalFileAccess: true },
      purpose: "connect",
      options: {},
      within: bounds,
    });
    expect(session.form).toBe("session");
    const opened = openedSession(session);
    expect(opens).toHaveLength(1);
    expect([opens[0]?.engine, opens[0]?.connectionId, opens[0]?.deadline]).toEqual([
      ENGINE,
      connection.id,
      bounds.deadline,
    ]);
    expect(opens[0]?.signal).toBe(bounds.signal);
    expect(typeof opened.session.close).toBe("function");
    expect(opened.env.get("LIBREDB_TEST_OE")).toBeUndefined();
    expect(() => opened.env.get("PATH")).toThrow();
  });

  test("openedProvider and openedSession answer their own form and raise a host defect naming the other", async () => {
    const legacy = await openEngine(LEGACY, {
      connection: legacyConnection(),
      execution: {},
      purpose: "declarations",
      options: {},
    });
    const session = await openEngine(pkg, {
      connection: packageConnection(),
      execution: {},
      purpose: "connect",
      options: {},
      within: within(),
    });
    expect(openedProvider(legacy)).toBe((legacy as { provider: unknown }).provider as never);
    expect(openedSession(session).session).toBe((session as { session: unknown }).session as never);

    const asProvider = (() => {
      try {
        openedProvider(session);
      } catch (error) {
        return error;
      }
    })() as Error;
    expect(asProvider.constructor).toBe(Error);
    expect(asProvider.message).toContain("session");
    const asSession = (() => {
      try {
        openedSession(legacy);
      } catch (error) {
        return error;
      }
    })() as Error;
    expect(asSession.constructor).toBe(Error);
    expect(asSession.message).toContain("legacy provider");
  });

  test("providerForm answers a held provider form itself, with the holder's own facts, and raises the host defect openedProvider raises on a session", async () => {
    const legacy = await openEngine(LEGACY, {
      connection: legacyConnection(),
      execution: {},
      purpose: "declarations",
      options: {},
    });
    const session = await openEngine(pkg, {
      connection: packageConnection(),
      execution: {},
      purpose: "connect",
      options: {},
      within: within(),
    });
    const held = { form: "provider" as const, provider: openedProvider(legacy), fact: "the holder's own" };
    expect(providerForm(held)).toBe(held);
    expect(providerForm(held).fact).toBe("the holder's own");

    const raised = (() => {
      try {
        providerForm(session);
      } catch (error) {
        return error;
      }
    })() as Error;
    expect(raised.constructor).toBe(Error);
    expect(raised.message).toBe(
      "The engine opened to a provider package's session, and this caller reads a legacy provider of it: a host defect.",
    );
  });

  test("a package record's open without a deadline and a signal is a host defect raised before the package's open is called", async () => {
    const error = (await rejection(
      openEngine(pkg, { connection: packageConnection(), execution: {}, purpose: "connect", options: {} }),
    )) as Error;
    expect(error.constructor).toBe(Error);
    expect(error.message).toContain("deadline");
    expect(opens).toEqual([]);
  });

  test("a package's open that fails after its caller stopped waiting is logged by its connection, kind and code, never its text", async () => {
    let opened!: () => void;
    const reached = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let fail!: (error: unknown) => void;
    setHooks(ENGINE, {
      ...HOOKS,
      open: () => {
        opened();
        return new Promise((_, reject) => {
          fail = reject;
        });
      },
    });
    let logged!: (args: unknown[]) => void;
    const line = new Promise<unknown[]>((resolve) => {
      logged = resolve;
    });
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      logged(args);
    });
    try {
      const connection = packageConnection();
      const stop = new AbortController();
      const work = openEngine(pkg, {
        connection,
        execution: {},
        purpose: "connect",
        options: {},
        within: { deadline: Date.now() + 60_000, signal: stop.signal },
      });
      await reached;
      const reason = new Error("the caller stopped waiting");
      stop.abort(reason);
      expect(await rejection(work)).toBe(reason);

      const text = randomUUID();
      const late = new Error(`the package failed late: ${text}`);
      fail(late);
      const [message, fields] = await line;
      expect(message).toBe("[DB] A provider package's open Studio stopped waiting for failed afterwards.");
      expect(fields).toEqual({ connectionId: connection.id, kind: errorKind(late), code: errorCode(late) });
      expect(JSON.stringify(fields)).not.toContain(text);
    } finally {
      warn.mockRestore();
      setHooks(ENGINE, HOOKS);
    }
  });
});
