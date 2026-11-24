/**
 * The object tree's caller facade (src/lib/api/object-tree.ts; docs/providers/CONTRACT.md, clause C-65): each tree read
 * of the object routes and the VS Code backend is one host core tree call on the legacy bridge's session, under a
 * deadline of its own, the statement timeout plus ten seconds from that read's start, and the caller's signal, and
 * answers the provider's own answer by reference.
 *
 * The real host core is installed for the file; a case that needs a record the real core would answer only at a real
 * deadline installs a core of its own around the real one and restores it. Every double signals when the read reaches
 * it, and no assertion follows a timer. `object-tree-bounds.test.ts` holds a read that never answers, with a real
 * deadline, in a bounded Node child.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext, TreeAnswer, TreeRequest } from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS, executeDeadline } from "@/lib/api/editor-query";
import { type ObjectTree, objectTree } from "@/lib/api/object-tree";
import { errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { TreeRecord } from "@/lib/provider-host/core/objects";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ROUTE = "object-tree-test";
const marker = (): string => randomUUID();

const connectionWith = (fields: Partial<DatabaseConnection> = {}) =>
  ({
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    createdAt: new Date(0),
    ...fields,
  }) as DatabaseConnection;

/** A mock provider whose statement timeout is `queryTimeout`, with every tree member a recorded mock. */
function providerOf(queryTimeout?: number): DatabaseProvider {
  return createMockProvider({ config: connectionWith({ queryTimeout }) });
}

/** The mock behind a provider's member, for its recorded calls and its implementation. */
const mockOf = (fn: unknown) => fn as ReturnType<typeof mock>;

/** Runs `body` with `core` installed in place of the real one, then puts the real one back. */
async function withCore<T>(make: (real: HostCore) => HostCore, body: () => Promise<T>): Promise<T> {
  const real = hostCore();
  forgetHostCore();
  installHostCore(make(real), "test");
  try {
    return await body();
  } finally {
    forgetHostCore();
    installHostCore(real, "test");
  }
}

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The read was expected to fail, and it answered.");
}

const TIMEOUT_REASON = () => new DOMException("The call's deadline has passed.", "TimeoutError");

/** One read of each action on `tree`, each with arrays of its own. */
const READS: readonly {
  readonly action: TreeRequest["action"];
  readonly run: (tree: ObjectTree) => Promise<unknown>;
}[] = [
  { action: "containers", run: (tree) => tree.listContainers(["app"]) },
  { action: "count", run: (tree) => tree.countObjects(["app"]) },
  { action: "list", run: (tree) => tree.listObjects(["app"], "table") },
  { action: "describe", run: (tree) => tree.describeObject(["app", "orders"], "table") },
  { action: "describeMany", run: (tree) => tree.describeObjects(["app"], "table", 3) },
];

/** The member of `provider` each action reads. */
const MEMBER: Record<TreeRequest["action"], keyof DatabaseProvider> = {
  containers: "listContainers",
  count: "countObjects",
  list: "listObjects",
  describe: "describeObject",
  describeMany: "describeObjects",
};

/** D5's deadline sentence for the read `noun` on a provider whose statement timeout is `queryTimeout`. */
const deadlineSentence = (noun: string, queryTimeout: number) =>
  `${noun} did not answer within the statement timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;

const NOUN: Record<TreeRequest["action"], string> = {
  containers: "The container listing",
  count: "The object count",
  list: "The object listing",
  describe: "The object description",
  describeMany: "The description of the objects",
};

describe("objectTree", () => {
  test("each tree read is one host core tree call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start", async () => {
    const provider = providerOf(2_000);
    const seen: { request: TreeRequest; ctx: CallContext }[] = [];
    const parent = ["app"];
    const container = ["app"];
    const path = ["app", "orders"];
    // A clock the test steps, seven milliseconds further on each read, so each read's start is its own.
    const starts: number[] = [];
    const steppedClock = () => {
      const at = Date.now() + starts.length * 7;
      starts.push(at);
      return at;
    };
    await withCore(
      (real) => ({
        ...real,
        treeCall: (session, request, ctx, ports) => {
          seen.push({ request, ctx });
          return real.treeCall(session, request, ctx, ports);
        },
      }),
      async () => {
        const tree = objectTree(provider, new AbortController().signal, ROUTE, steppedClock);
        await tree.listContainers(parent);
        await tree.listContainers();
        await tree.countObjects(container);
        await tree.listObjects(container, "table");
        await tree.describeObject(path, "table");
        await tree.describeObjects(container, "table", 3);
        await tree.describeObjects(container, "view", 4, { defaultSql: true });
      },
    );

    expect(seen.map(({ request }) => request)).toEqual([
      { action: "containers", parent: ["app"] },
      { action: "containers" },
      { action: "count", container: ["app"] },
      { action: "list", container: ["app"], kind: "table" },
      { action: "describe", path: ["app", "orders"], kind: "table" },
      { action: "describeMany", container: ["app"], kind: "table", limit: 3 },
      { action: "describeMany", container: ["app"], kind: "view", limit: 4, defaultSql: true },
    ]);
    expect(Object.hasOwn(seen[1]?.request ?? {}, "parent")).toBe(false);
    expect(Object.hasOwn(seen[5]?.request ?? {}, "defaultSql")).toBe(false);
    expect(seen.map(({ ctx }) => ctx.deadline)).toEqual(starts.map((start) => executeDeadline(provider, start)));
    expect(new Set(starts).size).toBe(7);
    expect(executeDeadline(provider, starts[0] as number)).toBe((starts[0] as number) + 2_000 + EXECUTE_SLACK_MS);
    for (const owned of [parent, container, path]) expect(Object.isFrozen(owned)).toBe(false);
    const requests = seen.map(({ request }) => request as Partial<Record<"parent" | "container" | "path", unknown>>);
    expect(requests[0]?.parent).not.toBe(parent);
    expect(requests[2]?.container).not.toBe(container);
    expect(requests[4]?.path).not.toBe(path);
  });

  test("each tree read answers the provider's own answer by reference", async () => {
    const provider = providerOf();
    const containers = [{ path: ["app"], name: "app", level: 0 }];
    const counts = { table: { count: 2 } };
    const objects = [{ path: ["app", "orders"], name: "orders", kind: "table" }];
    const detail = { path: ["app", "orders"], columns: [], indexes: [], foreignKeys: [] };
    const batch = { details: [detail] };
    mockOf(provider.listContainers).mockImplementation(async () => containers);
    mockOf(provider.countObjects).mockImplementation(async () => counts);
    mockOf(provider.listObjects).mockImplementation(async () => objects);
    mockOf(provider.describeObject).mockImplementation(async () => detail);
    mockOf(provider.describeObjects).mockImplementation(async () => batch);
    const tree = objectTree(provider, new AbortController().signal, ROUTE);

    expect(await tree.listContainers()).toBe(containers);
    expect(await tree.countObjects(["app"])).toBe(counts);
    expect(await tree.listObjects(["app"], "table")).toBe(objects);
    expect(await tree.describeObject(["app", "orders"], "table")).toBe(detail);
    expect(await tree.describeObjects(["app"], "table", 3)).toBe(batch);
    expect(tree.getCapabilities()).toEqual(provider.getCapabilities());
  });

  test("an error the provider raises reaches the caller as the same object", async () => {
    const provider = providerOf();
    const thrown = READS.map(() => new Error(marker()));
    READS.forEach(({ action }, index) => {
      mockOf(provider[MEMBER[action]]).mockImplementation(async () => {
        throw thrown[index];
      });
    });
    const tree = objectTree(provider, new AbortController().signal, ROUTE);

    const caught = await Promise.all(READS.map(({ run }) => failure(() => run(tree))));

    caught.forEach((error, index) => {
      expect(error).toBe(thrown[index]);
    });
  });

  test("a caller that leaves while the provider reads is answered QueryCancelledError at once, outcome unknown, and the read's later failure is logged by kind and code, never its text", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      for (const { action, run } of READS) {
        const provider = providerOf();
        const pending = Promise.withResolvers<never>();
        const reached = Promise.withResolvers<void>();
        mockOf(provider[MEMBER[action]]).mockImplementation(() => {
          reached.resolve();
          return pending.promise;
        });
        const caller = new AbortController();
        const reading = failure(() => run(objectTree(provider, caller.signal, ROUTE)));
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, so each read's log is its own.
        await reached.promise;
        caller.abort(new DOMException("The request went away.", "AbortError"));
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, so each read's log is its own.
        const left = await reading;
        expect(left).toBeInstanceOf(QueryCancelledError);
        expect(errorOutcome(left)).toBe("unknown");
        pending.reject(new Error(secret));
        // oxlint-disable-next-line no-await-in-loop -- the late failure is logged once the provider's promise settled.
        await pending.promise.catch(() => undefined);
        // oxlint-disable-next-line no-await-in-loop -- one turn for the late handler's reaction.
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(warned).toEqual(
        READS.map(({ action }) => [
          "A tree read Studio stopped waiting for failed afterwards",
          { route: ROUTE, action, kind: "internal", code: "INTERNAL_ERROR" },
        ]),
      );
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a caller already gone reads nothing and is answered QueryCancelledError, not-sent", async () => {
    const provider = providerOf();
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const tree = objectTree(provider, caller.signal, ROUTE);

    const caught = await Promise.all(READS.map(({ run }) => failure(() => run(tree))));

    for (const error of caught) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    for (const { action } of READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
  });

  test("a tree read past its deadline answers StudioTimeoutRefusal naming the read, the statement timeout and the slack", async () => {
    const queryTimeout = 2_000;
    const provider = providerOf(queryTimeout);
    const behind = () => Date.now() - queryTimeout - EXECUTE_SLACK_MS - 1_000;
    const refused = await Promise.all(
      READS.map(({ run }) => failure(() => run(objectTree(provider, new AbortController().signal, ROUTE, behind)))),
    );
    const stopped = await withCore(
      (real) => ({
        ...real,
        treeCall: async (): Promise<TreeRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
      }),
      () =>
        Promise.all(
          READS.map(({ run }) => failure(() => run(objectTree(provider, new AbortController().signal, ROUTE)))),
        ),
    );

    READS.forEach(({ action }, index) => {
      for (const [error, outcome] of [
        [refused[index], "not-sent"],
        [stopped[index], "unknown"],
      ] as const) {
        expect(error).toBeInstanceOf(StudioTimeoutRefusal);
        expect((error as Error).message).toBe(deadlineSentence(NOUN[action], queryTimeout));
        expect(errorOutcome(error)).toBe(outcome);
      }
    });
    for (const { action } of READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
  });

  test("a tree read refused for any other reason is answered as a defect of Studio's bridge, named by its rule", async () => {
    const provider = providerOf();
    const caught = await withCore(
      (real) => ({
        ...real,
        treeCall: async (): Promise<TreeRecord> => ({
          kind: "refused",
          called: false,
          refusals: [{ rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" }],
        }),
      }),
      () => failure(() => objectTree(provider, new AbortController().signal, ROUTE).listObjects(["app"], "table")),
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(QueryCancelledError);
    expect(caught).not.toBeInstanceOf(StudioTimeoutRefusal);
    expect((caught as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
    expect((caught as Error).message).toContain("objects.tree");
  });

  test("an answer without its action's member is answered as a defect of Studio's bridge, or of the provider for the batch the bridge passes through, naming the action and the member", async () => {
    const provider = providerOf();
    const forms: Record<TreeRequest["action"], { readonly answer: TreeAnswer; readonly member: string }> = {
      containers: { answer: { objects: [] }, member: "containers" },
      count: { answer: { containers: [] }, member: "counts" },
      list: { answer: { counts: {} }, member: "objects" },
      describe: { answer: { details: [] }, member: "detail" },
      describeMany: { answer: { containers: [] }, member: "details" },
    };
    const caught = await withCore(
      (real) => ({
        ...real,
        treeCall: async (_session, request): Promise<TreeRecord> => ({
          kind: "answered",
          answer: forms[request.action].answer,
        }),
      }),
      () =>
        Promise.all(
          READS.map(({ run }) => failure(() => run(objectTree(provider, new AbortController().signal, ROUTE)))),
        ),
    );

    READS.forEach(({ action }, index) => {
      expect(caught[index]).toBeInstanceOf(Error);
      expect((caught[index] as Error).message).toBe(
        action === "describeMany"
          ? `The provider answered a describeMany tree read without details, which is a defect of the provider.`
          : `Studio's provider bridge answered a ${action} tree read without ${forms[action].member}, which is a defect of Studio.`,
      );
    });
  });

  test("a tree read before the host core is installed fails by name and reaches no provider", async () => {
    const provider = providerOf();
    const real = hostCore();
    forgetHostCore();
    let caught: unknown[];
    try {
      const tree = objectTree(provider, new AbortController().signal, ROUTE);
      caught = await Promise.all(READS.map(({ run }) => failure(() => run(tree))));
    } finally {
      installHostCore(real, "test");
    }

    for (const error of caught) expect(error).toBeInstanceOf(HostCoreBootOrderError);
    for (const { action } of READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
  });
});
