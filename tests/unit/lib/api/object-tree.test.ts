/**
 * The object tree's caller facade (src/lib/api/object-tree.ts; docs/providers/CONTRACT.md, clause C-65): each tree read
 * of the object routes and the VS Code backend is one host core tree call on the session of the target its caller hands
 * it, a legacy provider's bridged session (`providerTreeTarget` in src/lib/api/session-target.ts) or a provider
 * package's, under a deadline of its own, the statement timeout plus ten seconds from that read's start, and the
 * caller's signal, and answers the session's own answer by reference.
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
import {
  type GrantedObjectTree,
  grantedObjectTree,
  type ObjectTree,
  objectTree,
  objectTreeWithinCall,
} from "@/lib/api/object-tree";
import type { BudgetGrant } from "@/lib/api/provider-monitoring";
import { providerTreeTarget, type TreeTarget } from "@/lib/api/session-target";
import { errorOutcome } from "@/lib/db/error-record";
import {
  FacetNotOfferedError,
  QueryCancelledError,
  StudioObjectModelRefusal,
  StudioTimeoutRefusal,
  waitedSeconds,
} from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import { HOST_DEFECT_PREFIX, HostDefectError } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { RefusedRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { declaredObjectModel } from "@/lib/provider-host/legacy-object-model";
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

/**
 * A mock provider whose statement timeout is `queryTimeout`, with every tree member a recorded mock, and whose object
 * model states the one container level and the kinds `table` and `view` the reads below name.
 */
function providerOf(queryTimeout?: number): DatabaseProvider {
  return createMockProvider({
    config: connectionWith({ queryTimeout }),
    capabilities: {
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    },
  });
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

/** A grant of `ms` from now on the route, its time refusal `refusal` by reference and its hold `hold`. */
function grantOf(
  over: Partial<BudgetGrant> = {},
  refusal: Error = new Error(marker()),
): BudgetGrant & { readonly hold: ReturnType<typeof mock<(settled: Promise<unknown>) => void>> } {
  const hold = mock<(settled: Promise<unknown>) => void>(() => {});
  return {
    deadline: Date.now() + 60_000,
    timeRefusal: () => refusal,
    route: ROUTE,
    holdUntilSettled: hold,
    hold,
    ...over,
  };
}

/** One read of each action the granted tree offers, each with arrays of its own. */
const GRANTED_READS: readonly {
  readonly action: Exclude<TreeRequest["action"], "describe">;
  readonly run: (tree: GrantedObjectTree) => Promise<unknown>;
}[] = [
  { action: "containers", run: (tree) => tree.containers(["app"]) },
  { action: "count", run: (tree) => tree.countObjects(["app"]) },
  { action: "list", run: (tree) => tree.listObjects(["app"], "table") },
  { action: "describeMany", run: (tree) => tree.describeObjects(["app"], "table", 3) },
];

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
        const tree = objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE, steppedClock);
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
    const tree = objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE);

    expect(await tree.listContainers()).toBe(containers);
    expect(await tree.countObjects(["app"])).toBe(counts);
    expect(await tree.listObjects(["app"], "table")).toBe(objects);
    expect(await tree.describeObject(["app", "orders"], "table")).toBe(detail);
    expect(await tree.describeObjects(["app"], "table", 3)).toBe(batch);
    expect(tree.objectModel).toEqual(declaredObjectModel(provider.getCapabilities()));
  });

  test("the editor's tree reads every read on one bridged session, and its object model is that session's", async () => {
    const provider = providerOf();
    const sessions: unknown[] = [];
    const unstated = marker();
    const { tree, refused } = await withCore(
      (real) => ({
        ...real,
        treeCall: (session, request, ctx, ports) => {
          sessions.push(session);
          return real.treeCall(session, request, ctx, ports);
        },
      }),
      async () => {
        const read = objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE);
        await read.listContainers();
        await read.countObjects(["app"]);
        await read.listObjects(["app"], "view");
        return { tree: read, refused: await failure(() => read.listObjects(["app"], unstated)) };
      },
    );

    expect(sessions).toHaveLength(4);
    expect(new Set(sessions).size).toBe(1);
    expect(tree.objectModel === (sessions[0] as { objectModel: unknown }).objectModel).toBe(true);
    expect(tree.objectModel.objectKinds.map((kind) => kind.id)).toEqual(["table", "view"]);
    // A kind the session's model does not state is refused before the provider is asked, in Studio's words.
    expect(refused).toBeInstanceOf(StudioObjectModelRefusal);
    expect(errorOutcome(refused)).toBe("not-sent");
    expect((refused as Error).message).not.toContain(unstated);
    expect(mockOf(provider.listObjects).mock.calls as unknown[]).toEqual([[["app"], "view"]]);
  });

  test("an error the provider raises reaches the caller as the same object", async () => {
    const provider = providerOf();
    const thrown = READS.map(() => new Error(marker()));
    READS.forEach(({ action }, index) => {
      mockOf(provider[MEMBER[action]]).mockImplementation(async () => {
        throw thrown[index];
      });
    });
    const tree = objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE);

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
        const reading = failure(() => run(objectTree(providerTreeTarget(provider), caller.signal, ROUTE)));
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
    const tree = objectTree(providerTreeTarget(provider), caller.signal, ROUTE);

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
      READS.map(({ run }) =>
        failure(() => run(objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE, behind))),
      ),
    );
    const stopped = await withCore(
      (real) => ({
        ...real,
        treeCall: async (): Promise<StoppedRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
      }),
      () =>
        Promise.all(
          READS.map(({ run }) =>
            failure(() => run(objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE))),
          ),
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
        treeCall: async (): Promise<RefusedRecord> => ({
          kind: "refused",
          called: false,
          // A rule none of the accessor's rows for a refusing package session reads (clause C-111).
          refusals: [{ rule: "request-field-empty", pointer: "/objects/tree", name: "objects.tree" }],
        }),
      }),
      () =>
        failure(() =>
          objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE).listObjects(["app"], "table"),
        ),
    );

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(QueryCancelledError);
    expect(caught).not.toBeInstanceOf(StudioTimeoutRefusal);
    expect((caught as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
    expect((caught as Error).message).toContain("objects.tree");
  });

  test("a tree answer the core refuses as tree-answer-unreadable is answered as a host defect naming the rule, with no check of the facade's own", async () => {
    // The legacy provider's own answers, each outside its action's form, which the bridge passes by reference.
    const malformed: Partial<DatabaseProvider> = {
      listContainers: mock(async () => [{ path: ["app"], name: 1, level: 0 }]) as never,
      countObjects: mock(async () => ({ table: { count: -1 } })) as never,
      listObjects: mock(async () => [{ path: ["app", "orders"], name: "orders", kind: 1 }]) as never,
      describeObject: mock(async () => ({
        path: ["app", "orders"],
        columns: marker(),
        indexes: [],
        foreignKeys: [],
      })) as never,
      describeObjects: mock(async () => ({})) as never,
    };
    const pointers: Record<TreeRequest["action"], string> = {
      containers: "/containers/0/name",
      count: "/counts/table/count",
      list: "/objects/0/kind",
      describe: "/detail/columns",
      describeMany: "/details",
    };

    const editor = await Promise.all(
      READS.map(({ run }) =>
        failure(() =>
          run(
            objectTree(providerTreeTarget(Object.assign(providerOf(), malformed)), new AbortController().signal, ROUTE),
          ),
        ),
      ),
    );
    const granted = await Promise.all(
      GRANTED_READS.map(({ run }) =>
        failure(() => run(grantedObjectTree(providerTreeTarget(Object.assign(providerOf(), malformed)), grantOf()))),
      ),
    );

    for (const [index, { action }] of READS.entries()) {
      const caught = editor[index];
      expect(caught).toBeInstanceOf(HostDefectError);
      expect((caught as HostDefectError).refusals).toEqual([
        { rule: "tree-answer-unreadable", pointer: pointers[action] },
      ]);
      expect((caught as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
      expect(errorOutcome(caught)).toBe("unknown");
    }
    for (const [index, { action }] of GRANTED_READS.entries()) {
      expect((granted[index] as HostDefectError).refusals).toEqual([
        { rule: "tree-answer-unreadable", pointer: pointers[action] },
      ]);
    }
  });

  test("a containers answer that says the inventory needs configuration reaches the granted tree whole and the editor's listing as its containers alone", async () => {
    const reason = marker();
    const provider = Object.assign(providerOf(), {
      inventoryNeedsConfiguration: mock<() => Promise<string | undefined>>(async () => reason),
    });

    const listed = await objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE).listContainers();
    const whole = await grantedObjectTree(providerTreeTarget(provider), grantOf()).containers();

    expect(listed).toEqual([]);
    expect(whole).toEqual({ containers: [], needsConfiguration: reason });
    expect(mockOf(provider.listContainers)).not.toHaveBeenCalled();
  });

  test("a tree read before the host core is installed fails by name and sends the provider no tree call, its capabilities read once when the facade is built", async () => {
    const provider = providerOf();
    const real = hostCore();
    forgetHostCore();
    let caught: unknown[];
    try {
      const tree = objectTree(providerTreeTarget(provider), new AbortController().signal, ROUTE);
      caught = await Promise.all(READS.map(({ run }) => failure(() => run(tree))));
    } finally {
      installHostCore(real, "test");
    }

    for (const error of caught) expect(error).toBeInstanceOf(HostCoreBootOrderError);
    for (const { action } of READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
    // Building the facade states its session's object model, the one provider read made before the core is read.
    expect(mockOf(provider.getCapabilities)).toHaveBeenCalledTimes(1);
  });
});

describe("grantedObjectTree", () => {
  test("each granted read is one host core tree call on the walk's one bridged session, a fresh request, and a fresh context on the grant's one deadline and one signal, of deadline, signal and env alone", async () => {
    const provider = providerOf();
    const seen: { session: unknown; request: TreeRequest; ctx: CallContext }[] = [];
    const container = ["app"];
    const grant = grantOf({ deadline: Date.now() + 45_000 });
    await withCore(
      (real) => ({
        ...real,
        treeCall: (session, request, ctx, ports) => {
          seen.push({ session, request, ctx });
          return real.treeCall(session, request, ctx, ports);
        },
      }),
      async () => {
        const tree = grantedObjectTree(providerTreeTarget(provider), grant);
        await tree.containers();
        await tree.containers(container);
        await tree.countObjects(container);
        await tree.listObjects(container, "table");
        await tree.describeObjects(container, "table", 3);
      },
    );

    expect(seen.map(({ request }) => request)).toEqual([
      { action: "containers" },
      { action: "containers", parent: ["app"] },
      { action: "count", container: ["app"] },
      { action: "list", container: ["app"], kind: "table" },
      { action: "describeMany", container: ["app"], kind: "table", limit: 3 },
    ]);
    expect(new Set(seen.map(({ session }) => session)).size).toBe(1);
    expect(new Set(seen.map(({ ctx }) => ctx)).size).toBe(seen.length);
    expect(new Set(seen.map(({ ctx }) => ctx.signal)).size).toBe(1);
    for (const { ctx } of seen) {
      expect(Object.keys(ctx).sort()).toEqual(["deadline", "env", "signal"]);
      expect(ctx.deadline).toBe(grant.deadline);
      expect(ctx.signal.aborted).toBe(false);
    }
    expect(Object.isFrozen(container)).toBe(false);
    const requests = seen.map(({ request }) => request as Partial<Record<"parent" | "container", unknown>>);
    for (const request of requests.slice(1)) expect(request.parent ?? request.container).not.toBe(container);
    expect(grant.hold).not.toHaveBeenCalled();
  });

  test("a granted read hands the target's read allowance to the bridge by reference, and none where the target has none", async () => {
    const readAllowance = new RunReadAllowance(5);
    const billed = providerOf();
    const tree = grantedObjectTree(providerTreeTarget(billed, { readAllowance }), grantOf());
    await tree.countObjects(["app"]);
    await tree.listObjects(["app"], "table");
    await tree.describeObjects(["app"], "table", 3);
    const unbilled = providerOf();
    const plain = grantedObjectTree(providerTreeTarget(unbilled), grantOf());
    await plain.countObjects(["app"]);
    await plain.listObjects(["app"], "table");
    await plain.describeObjects(["app"], "table", 3);

    expect(mockOf(billed.countObjects).mock.calls).toEqual([[["app"], { readAllowance }]]);
    expect(mockOf(billed.listObjects).mock.calls).toEqual([[["app"], "table", { readAllowance }]]);
    expect(mockOf(billed.describeObjects).mock.calls).toEqual([[["app"], "table", 3, { readAllowance }]]);
    const [, counted] = mockOf(billed.countObjects).mock.calls[0] as [unknown, { readAllowance: unknown }];
    const [, , listed] = mockOf(billed.listObjects).mock.calls[0] as [unknown, unknown, { readAllowance: unknown }];
    const [, , , described] = mockOf(billed.describeObjects).mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { readAllowance: unknown },
    ];
    for (const options of [counted, listed, described]) expect(options.readAllowance).toBe(readAllowance);
    expect(mockOf(unbilled.countObjects).mock.calls[0]).toHaveLength(1);
    expect(mockOf(unbilled.listObjects).mock.calls[0]).toHaveLength(2);
    expect(mockOf(unbilled.describeObjects).mock.calls[0]).toHaveLength(3);
  });

  test("a granted read its deadline stopped answers the grant's own time refusal, hands the stopped read's settlement to the grant's hold, and logs a later failure by kind and code only", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      const provider = providerOf();
      const pending = Promise.withResolvers<never>();
      let memberSettled = false;
      mockOf(provider.countObjects).mockImplementation(() =>
        pending.promise.finally(() => {
          memberSettled = true;
        }),
      );
      const refusal = new Error(marker());
      const grant = grantOf({ deadline: Date.now() + 50 }, refusal);
      const tree = grantedObjectTree(providerTreeTarget(provider), grant);

      // A plain await of the read, which the grant's real deadline ends.
      const caught = await failure(() => tree.countObjects(["app"]));

      expect(caught).toBe(refusal);
      expect(grant.hold).toHaveBeenCalledTimes(1);
      const held = grant.hold.mock.calls[0]?.[0] as Promise<unknown>;
      let heldSettled = false;
      const watched = held.then(() => {
        heldSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(heldSettled).toBe(false);
      pending.reject(new Error(secret));
      await watched;
      expect(memberSettled).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));

      expect(warned).toEqual([
        [
          "A tree read Studio stopped waiting for failed afterwards",
          { route: ROUTE, action: "count", kind: "internal", code: "INTERNAL_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
      expect(mockOf(provider.listObjects)).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a granted read after the grant's deadline is refused before the call with the grant's own time refusal and reads nothing", async () => {
    const provider = providerOf();
    const refusal = new Error(marker());
    const grant = grantOf({ deadline: Date.now() - 1 }, refusal);
    const tree = grantedObjectTree(providerTreeTarget(provider), grant);

    const caught = await Promise.all(GRANTED_READS.map(({ run }) => failure(() => run(tree))));

    for (const error of caught) expect(error).toBe(refusal);
    for (const { action } of GRANTED_READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
    expect(grant.hold).not.toHaveBeenCalled();
  });

  test("a granted read passes the provider's error as the same object", async () => {
    const provider = providerOf();
    const thrown = GRANTED_READS.map(() => new Error(marker()));
    GRANTED_READS.forEach(({ action }, index) => {
      mockOf(provider[MEMBER[action]]).mockImplementation(async () => {
        throw thrown[index];
      });
    });
    const tree = grantedObjectTree(providerTreeTarget(provider), grantOf());

    const caught = await Promise.all(GRANTED_READS.map(({ run }) => failure(() => run(tree))));

    caught.forEach((error, index) => {
      expect(error).toBe(thrown[index]);
    });
  });

  test("a granted tree before the host core is installed throws by name and reads nothing", () => {
    const provider = providerOf();
    const real = hostCore();
    forgetHostCore();
    let thrown: unknown;
    try {
      grantedObjectTree(providerTreeTarget(provider), grantOf());
    } catch (error) {
      thrown = error;
    } finally {
      installHostCore(real, "test");
    }

    expect(thrown).toBeInstanceOf(HostCoreBootOrderError);
    for (const { action } of GRANTED_READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
  });
});

/** What a within-call tree is handed: the call's deadline, its caller signal, its own time refusal and its route. */
type WithinCall = Parameters<typeof objectTreeWithinCall>[1];

/** A call of `ms` from now whose time refusal is `refusal` by reference, its caller signal `caller`'s. */
function withinCallOf(
  caller: AbortController = new AbortController(),
  ms = 60_000,
  refusal: Error = new Error(marker()),
): WithinCall {
  return { deadline: Date.now() + ms, caller: caller.signal, timeRefusal: () => refusal, route: ROUTE };
}

/** One read of each action the within-call tree offers, each with arrays of its own. */
const WITHIN_READS: readonly {
  readonly action: Extract<TreeRequest["action"], "containers" | "list" | "describe">;
  readonly run: (tree: ObjectTree) => Promise<unknown>;
}[] = [
  { action: "containers", run: (tree) => tree.listContainers(["app"]) },
  { action: "list", run: (tree) => tree.listObjects(["app"], "table") },
  { action: "describe", run: (tree) => tree.describeObject(["app", "orders"], "table") },
];

describe("objectTreeWithinCall", () => {
  test("each read is one host core tree call on the tree's one bridged session, a fresh request, and a fresh context on the call's one deadline and one signal, of deadline, signal and env alone", async () => {
    const provider = providerOf();
    const seen: { session: unknown; request: TreeRequest; ctx: CallContext }[] = [];
    const parent = ["app"];
    const path = ["app", "orders"];
    const caller = new AbortController();
    const call = withinCallOf(caller, 45_000);
    await withCore(
      (real) => ({
        ...real,
        treeCall: (session, request, ctx, ports) => {
          seen.push({ session, request, ctx });
          return real.treeCall(session, request, ctx, ports);
        },
      }),
      async () => {
        const tree = objectTreeWithinCall(providerTreeTarget(provider), call);
        await tree.listContainers();
        await tree.listContainers(parent);
        await tree.listObjects(parent, "table");
        await tree.describeObject(path, "table");
      },
    );

    expect(seen.map(({ request }) => request)).toEqual([
      { action: "containers" },
      { action: "containers", parent: ["app"] },
      { action: "list", container: ["app"], kind: "table" },
      { action: "describe", path: ["app", "orders"], kind: "table" },
    ]);
    expect(new Set(seen.map(({ session }) => session)).size).toBe(1);
    expect(new Set(seen.map(({ ctx }) => ctx)).size).toBe(seen.length);
    expect(new Set(seen.map(({ ctx }) => ctx.signal)).size).toBe(1);
    for (const { ctx } of seen) {
      expect(Object.keys(ctx).sort()).toEqual(["deadline", "env", "signal"]);
      expect(ctx.deadline).toBe(call.deadline);
      expect(ctx.signal.aborted).toBe(false);
    }
    for (const owned of [parent, path]) expect(Object.isFrozen(owned)).toBe(false);
    const requests = seen.map(({ request }) => request as Partial<Record<"parent" | "container" | "path", unknown>>);
    expect(requests[1]?.parent).not.toBe(parent);
    expect(requests[2]?.container).not.toBe(parent);
    expect(requests[3]?.path).not.toBe(path);
    const reason = new DOMException(marker(), "AbortError");
    caller.abort(reason);
    expect(seen[0]?.ctx.signal.aborted).toBe(true);
    expect(seen[0]?.ctx.signal.reason).toBe(reason);
  });

  test("it answers the provider's answer by reference, states its session's object model, and reads a listing that says the inventory needs configuration as no container", async () => {
    const provider = providerOf();
    const containers = [{ path: ["app"], name: "app", level: 0 }];
    const objects = [{ path: ["app", "orders"], name: "orders", kind: "table" }];
    const detail = { path: ["app", "orders"], columns: [], indexes: [], foreignKeys: [] };
    mockOf(provider.listContainers).mockImplementation(async () => containers);
    mockOf(provider.listObjects).mockImplementation(async () => objects);
    mockOf(provider.describeObject).mockImplementation(async () => detail);
    const tree = objectTreeWithinCall(providerTreeTarget(provider), withinCallOf());

    expect(await tree.listContainers()).toBe(containers);
    expect(await tree.listObjects(["app"], "table")).toBe(objects);
    expect(await tree.describeObject(["app", "orders"], "table")).toBe(detail);
    expect(tree.objectModel).toEqual(declaredObjectModel(provider.getCapabilities()));

    const unconfigured = Object.assign(providerOf(), {
      inventoryNeedsConfiguration: mock<() => Promise<string | undefined>>(async () => marker()),
    });
    expect(await objectTreeWithinCall(providerTreeTarget(unconfigured), withinCallOf()).listContainers()).toEqual([]);
    expect(mockOf(unconfigured.listContainers)).not.toHaveBeenCalled();
  });

  test("a caller that leaves while a read is pending is answered QueryCancelledError at once, and the read's later failure is logged by kind and code only", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      for (const { action, run } of WITHIN_READS) {
        const provider = providerOf();
        const pending = Promise.withResolvers<never>();
        const entered = Promise.withResolvers<void>();
        mockOf(provider[MEMBER[action]]).mockImplementation(() => {
          entered.resolve();
          return pending.promise;
        });
        const caller = new AbortController();
        const reading = failure(() => run(objectTreeWithinCall(providerTreeTarget(provider), withinCallOf(caller))));
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, so each read's log is its own.
        await entered.promise;
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
        WITHIN_READS.map(({ action }) => [
          "A tree read Studio stopped waiting for failed afterwards",
          { route: ROUTE, action, kind: "internal", code: "INTERNAL_ERROR" },
        ]),
      );
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a read its deadline stopped answers the call's own time refusal, and its later failure is logged by kind and code only", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      const provider = providerOf();
      const pending = Promise.withResolvers<never>();
      mockOf(provider.describeObject).mockImplementation(() => pending.promise);
      const built: Error[] = [];
      const call: WithinCall = {
        deadline: Date.now() + 50,
        caller: new AbortController().signal,
        timeRefusal: () => {
          const refusal = new Error(marker());
          built.push(refusal);
          return refusal;
        },
        route: ROUTE,
      };

      // A plain await of the read, which the call's real deadline ends.
      const caught = await failure(() =>
        objectTreeWithinCall(providerTreeTarget(provider), call).describeObject(["app", "t"], "table"),
      );

      expect(built).toHaveLength(1);
      expect(caught).toBe(built[0]);
      pending.reject(new Error(secret));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warned).toEqual([
        [
          "A tree read Studio stopped waiting for failed afterwards",
          { route: ROUTE, action: "describe", kind: "internal", code: "INTERNAL_ERROR" },
        ],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a read after the call's deadline or after the caller left is refused before the call and reads nothing", async () => {
    const passedProvider = providerOf();
    const refusal = new Error(marker());
    const passed = objectTreeWithinCall(
      providerTreeTarget(passedProvider),
      withinCallOf(new AbortController(), -1, refusal),
    );
    const leftProvider = providerOf();
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const left = objectTreeWithinCall(providerTreeTarget(leftProvider), withinCallOf(caller));

    const late = await Promise.all(WITHIN_READS.map(({ run }) => failure(() => run(passed))));
    const gone = await Promise.all(WITHIN_READS.map(({ run }) => failure(() => run(left))));

    for (const error of late) expect(error).toBe(refusal);
    for (const error of gone) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    for (const provider of [passedProvider, leftProvider]) {
      for (const { action } of WITHIN_READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
    }
  });

  test("a read passes the provider's error as the same object", async () => {
    const provider = providerOf();
    const thrown = WITHIN_READS.map(() => new Error(marker()));
    WITHIN_READS.forEach(({ action }, index) => {
      mockOf(provider[MEMBER[action]]).mockImplementation(async () => {
        throw thrown[index];
      });
    });
    const syncProvider = providerOf();
    const syncThrown = new Error(marker());
    mockOf(syncProvider.listContainers).mockImplementation(() => {
      throw syncThrown;
    });
    const tree = objectTreeWithinCall(providerTreeTarget(provider), withinCallOf());

    const caught = await Promise.all(WITHIN_READS.map(({ run }) => failure(() => run(tree))));

    caught.forEach((error, index) => {
      expect(error).toBe(thrown[index]);
    });
    expect(
      await failure(() => objectTreeWithinCall(providerTreeTarget(syncProvider), withinCallOf()).listContainers()),
    ).toBe(syncThrown);
  });

  test("before the host core is installed it throws by name and reads nothing", () => {
    const provider = providerOf();
    const real = hostCore();
    forgetHostCore();
    let thrown: unknown;
    try {
      objectTreeWithinCall(providerTreeTarget(provider), withinCallOf());
    } catch (error) {
      thrown = error;
    } finally {
      installHostCore(real, "test");
    }

    expect(thrown).toBeInstanceOf(HostCoreBootOrderError);
    for (const { action } of WITHIN_READS) expect(mockOf(provider[MEMBER[action]])).not.toHaveBeenCalled();
  });
});

/** A session's calls with `objects.tree` offered or not, and every other call not offered. */
function callsWith(tree: "offered" | "not-offered") {
  return {
    console: {
      execute: { honours: [] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "not-offered",
    },
    objects: { tree },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: "not-offered", poolStats: "not-offered" },
  } as unknown as TreeTarget["session"]["calls"];
}

/**
 * A target of a session of the package form: a tree function recording each call's request and context and answering
 * an empty answer of its action, the provider double's object model, an environment of its own and run marks counted.
 */
function packageTarget(tree: "offered" | "not-offered" = "offered", timeout = 2_000) {
  const calls: { request: TreeRequest; ctx: CallContext }[] = [];
  const marks: string[] = [];
  const empty: Record<TreeRequest["action"], TreeAnswer> = {
    containers: { containers: [] },
    count: { counts: {} },
    list: { objects: [] },
    describe: { detail: { path: ["app", "orders"], columns: [], indexes: [], foreignKeys: [] } },
    describeMany: { details: [] },
  };
  const env = { get: () => undefined } as unknown as TreeTarget["env"];
  const target: TreeTarget = {
    session: {
      calls: callsWith(tree),
      objectModel: providerTreeTarget(providerOf()).session.objectModel,
      tree: async (request, ctx) => {
        calls.push({ request, ctx });
        return empty[request.action];
      },
    },
    env,
    timeout: () => timeout,
    wholeServer: () => null,
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(`ended ${record?.kind}`);
    },
  };
  return { target, calls, marks, env };
}

describe("the tree facades on a session target", () => {
  test("the tree facades read any session the target states, a package's and the bridge's alike, under its environment and timeout, counting each read on the entry", async () => {
    const { target, calls, marks, env } = packageTarget("offered", 2_000);
    const start = Date.now();
    const tree = objectTree(target, new AbortController().signal, ROUTE, () => start);
    await Promise.all(READS.map(({ run }) => run(tree)));
    expect(calls.map(({ request }) => request.action)).toEqual(READS.map(({ action }) => action));
    for (const { ctx } of calls) {
      expect(ctx.env).toBe(env);
      expect(ctx.deadline).toBe(start + 2_000 + EXECUTE_SLACK_MS);
    }
    expect(marks).toEqual([...READS.map(() => "started"), ...READS.map(() => "ended answered")]);

    calls.length = 0;
    marks.length = 0;
    const within = objectTreeWithinCall(target, withinCallOf());
    await Promise.all(WITHIN_READS.map(({ run }) => run(within)));
    const granted = grantedObjectTree(target, grantOf());
    await Promise.all(GRANTED_READS.map(({ run }) => run(granted)));
    expect(calls).toHaveLength(WITHIN_READS.length + GRANTED_READS.length);
    for (const { ctx } of calls) expect(ctx.env).toBe(env);
    expect(marks.filter((mark) => mark === "started")).toHaveLength(calls.length);
    expect(marks.filter((mark) => mark === "ended answered")).toHaveLength(calls.length);

    // A read the session's tree function fails ends its mark too, the failure passed as the same object.
    const failed = packageTarget();
    const thrown = new Error(marker());
    failed.target.session.tree = () => Promise.reject(thrown);
    const caught = await failure(() =>
      objectTree(failed.target, new AbortController().signal, ROUTE).listObjects(["app"], "table"),
    );
    expect(caught).toBe(thrown);
    expect(failed.marks).toEqual(["started", "ended undefined"]);

    // The bridge's session of a legacy provider is read the same way, under the provider's own statement timeout.
    const provider = providerOf(4_000);
    const bridged = providerTreeTarget(provider);
    expect(bridged.timeout()).toBe(4_000);
    await objectTree(bridged, new AbortController().signal, ROUTE).listObjects(["app"], "table");
    expect(mockOf(provider.listObjects)).toHaveBeenCalledTimes(1);
  });

  test("a target whose session does not offer objects.tree is refused when the facade is built, before any read", async () => {
    const { target, calls, marks } = packageTarget("not-offered");
    const built: unknown[] = [];
    for (const build of [
      () => objectTree(target, new AbortController().signal, ROUTE),
      () => objectTreeWithinCall(target, withinCallOf()),
      () => grantedObjectTree(target, grantOf()),
    ]) {
      try {
        build();
        built.push("built");
      } catch (error) {
        built.push(error);
      }
    }
    for (const error of built) {
      expect(error).toBeInstanceOf(FacetNotOfferedError);
      expect((error as FacetNotOfferedError).message).toBe(
        "This connection's provider package does not offer objects.tree, so Studio did not call it.",
      );
      expect([(error as FacetNotOfferedError).facet, (error as FacetNotOfferedError).operation]).toEqual([
        "objects",
        "tree",
      ]);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    expect(calls).toEqual([]);
    expect(marks).toEqual([]);

    // A session that offers the tree and states no object model is the host's defect, named, before any read.
    const unstated = packageTarget();
    const { calls: offered, tree } = unstated.target.session;
    expect(() =>
      objectTree({ ...unstated.target, session: { calls: offered, tree } }, new AbortController().signal, ROUTE),
    ).toThrow("The session offers objects.tree and states no object model, a defect of the host's session.");
    expect(unstated.calls).toEqual([]);
  });
});
