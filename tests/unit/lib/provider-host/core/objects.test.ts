/**
 * The host core's tree call (src/lib/provider-host/core/objects.ts; docs/providers/CONTRACT.md, clause C-64): a tree
 * call is checked before it is made and refused as a record, runs on a context and request frozen in place, is waited
 * for until the call's signal, and reads its answer with `checkTreeAnswer` against its action's form: one that is not
 * that form is refused as a record, and one that is is answered as the session's own answer, by reference, as the
 * console calls answer theirs.
 *
 * Every session here is a fake whose `tree` the test drives through promises it settles itself; no assertion follows a
 * timer. `objects-bounds.test.ts` holds a tree call that never settles, with a real deadline, in a bounded Node child.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallContext,
  type CallRefusal,
  envReader,
  type TreeAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, ObjectModel } from "@libredb/provider-sdk/manifest";
import type { HostCallPorts } from "@/lib/provider-host/core/console";
import { type ObjectsSession, treeCall } from "@/lib/provider-host/core/objects";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import { createMockProvider } from "../../../../helpers/mock-provider";

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** A session's calls, with `objects.tree` offered unless told otherwise. */
function callsOf(tree = true): Calls {
  return {
    console: {
      execute: { honours: [] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "not-offered",
    },
    objects: { tree: tree ? "offered" : "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: "not-offered", poolStats: "not-offered" },
  };
}

/** A relation kind `id`, every member written out as a declaration states it. */
function kindOf(id: string): ObjectModel["objectKinds"][number] {
  return {
    id,
    role: "relation",
    label: id,
    labelPlural: id,
    hasSource: false,
    sourceLanguage: null,
    hasColumns: true,
    acceptsSourceEdits: false,
    childKinds: [],
    attachedTo: null,
    acceptsRowWrites: false,
    enumeratedBy: null,
    countIsListing: false,
    machineNames: null,
    group: null,
  };
}

/** A session's object model: one container level, addressed exactly, holding the kinds `table` and `view`. */
function modelOf(): ObjectModel {
  return {
    containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
    containerPathShapes: "exact",
    containerNameSpelling: null,
    objectKinds: [kindOf("table"), kindOf("view")],
    rowActions: [],
    containersNameKinds: false,
    tablesNeedContainer: false,
    tablesAreDerivedGroupings: false,
    agentWalkScope: null,
    schemaDiffScope: null,
    maskedNameKinds: [],
  };
}

function contextOf(controller = new AbortController(), deadline = Date.now() + HOUR): CallContext {
  return { deadline, signal: controller.signal, env: envReader([], () => undefined) };
}

/** Late ports that record each failure and resolve a promise with the first. */
function portsOf() {
  const late: unknown[] = [];
  const firstLate = Promise.withResolvers<unknown>();
  const ports: Pick<HostCallPorts, "late"> = {
    late: (error) => {
      late.push(error);
      firstLate.resolve(error);
    },
  };
  return { ports, late, firstLate: firstLate.promise };
}

/** A session whose tree answers what `answer` gives, recording each call. */
function sessionOf(answer: (request: TreeRequest, ctx: CallContext) => Promise<TreeAnswer>, calls = callsOf()) {
  const reads: { readonly request: TreeRequest; readonly ctx: CallContext }[] = [];
  const called = Promise.withResolvers<void>();
  const session: ObjectsSession = {
    calls,
    objectModel: modelOf(),
    tree: (request, ctx) => {
      reads.push({ request, ctx });
      called.resolve();
      return answer(request, ctx);
    },
  };
  return { session, reads, called: called.promise };
}

/** What `run` threw; a run that does not throw fails the case. */
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("The call was expected to fail, and it answered.");
}

/** Lets every callback already queued run: one turn of the event loop, never a timer an assertion waits on. */
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("treeCall", () => {
  test("a tree call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    const fx = sessionOf(async () => ({ containers: [] }));
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);

    const aborted = await treeCall(fx.session, { action: "containers" }, contextOf(controller), ports);
    const late = await treeCall(
      fx.session,
      { action: "count", container: [marker()] },
      contextOf(new AbortController(), Date.now() - 1),
      ports,
    );

    expect(aborted).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-signal-aborted", pointer: "/signal" }],
      cause: reason,
    });
    expect(late).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }],
    });
    expect(fx.reads).toEqual([]);
  });

  test("a tree call to a session without objects.tree is refused as a record before the call", async () => {
    const fx = sessionOf(async () => ({ objects: [] }), callsOf(false));
    const { ports } = portsOf();

    const record = await treeCall(
      fx.session,
      { action: "list", container: [marker()], kind: "table" },
      contextOf(),
      ports,
    );

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" }],
    });
    expect(fx.reads).toEqual([]);
  });

  test("a tree call naming a level or a kind the session's object model does not state is refused as a record before the call, and the provider is never called", async () => {
    const fx = sessionOf(async () => ({ objects: [] }));
    const { ports } = portsOf();
    const unstated = marker();
    const level: CallRefusal = { rule: "request-level-not-stated", pointer: "/container" };
    const kind: CallRefusal = { rule: "request-kind-not-stated", pointer: "/kind" };
    const cases: [TreeRequest, CallRefusal[]][] = [
      [
        { action: "containers", parent: [marker(), marker()] },
        [{ rule: "request-level-not-stated", pointer: "/parent" }],
      ],
      [{ action: "count", container: [marker(), marker()] }, [level]],
      [{ action: "list", container: [marker()], kind: unstated }, [kind]],
      [{ action: "describe", path: [marker(), marker()], kind: unstated }, [kind]],
      [{ action: "describeMany", container: [], kind: unstated }, [level, kind]],
    ];

    for (const [request, refusals] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each record is its own call's.
      const record = await treeCall(fx.session, request, contextOf(), ports);
      expect(record).toEqual({ kind: "refused", called: false, refusals });
      expect(JSON.stringify(record)).not.toContain(unstated);
    }
    expect(fx.reads).toEqual([]);

    // A request the model states is called, as before.
    const stated = await treeCall(
      fx.session,
      { action: "list", container: [marker()], kind: "view" },
      contextOf(),
      ports,
    );
    expect(stated).toEqual({ kind: "answered", answer: { objects: [] } });
    expect(fx.reads).toHaveLength(1);
  });

  test("a session that offers objects.tree and states no object model is a host defect, named, and a session that does not offer it is refused first", async () => {
    const { ports } = portsOf();
    const fx = sessionOf(async () => ({ containers: [] }));
    const unmodelled: ObjectsSession = { calls: fx.session.calls, tree: fx.session.tree };
    const notOffered = sessionOf(async () => ({ containers: [] }), callsOf(false));
    const withoutModel: ObjectsSession = { calls: notOffered.session.calls, tree: notOffered.session.tree };

    const defect = await failure(() => treeCall(unmodelled, { action: "containers" }, contextOf(), ports));
    const refused = await treeCall(withoutModel, { action: "containers" }, contextOf(), ports);

    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers objects.tree and states no object model, a defect of the host's session.",
    );
    expect(refused).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/objects/tree", name: "objects.tree" }],
    });
    expect(fx.reads).toEqual([]);
    expect(notOffered.reads).toEqual([]);
  });

  test("a tree call answers the session's own answer, with the request and context frozen", async () => {
    const answer: TreeAnswer = { objects: [{ name: marker(), kind: "table", path: [marker()] }] };
    const fx = sessionOf(async () => answer);
    const { ports, late } = portsOf();
    const container = [marker()];
    const request: TreeRequest = { action: "list", container, kind: "table" };
    const ctx = contextOf();

    const record = await treeCall(fx.session, request, ctx, ports);

    expect(record).toEqual({ kind: "answered", answer });
    if (record.kind !== "answered") throw new Error(`An answer was expected, not ${record.kind}.`);
    expect(record.answer).toBe(answer);
    expect(fx.reads).toHaveLength(1);
    expect(fx.reads[0]?.request).toBe(request);
    expect(fx.reads[0]?.ctx).toBe(ctx);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(container)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(late).toEqual([]);
  });

  test("an error the provider throws reaches the caller as the same object", async () => {
    const rejected = new Error(marker());
    const thrownNow = new Error(marker());
    const { ports, late } = portsOf();

    const later = await failure(() =>
      treeCall(
        sessionOf(async () => {
          throw rejected;
        }).session,
        { action: "containers" },
        contextOf(),
        ports,
      ),
    );
    const now = await failure(() =>
      treeCall(
        sessionOf(() => {
          throw thrownNow;
        }).session,
        { action: "containers" },
        contextOf(),
        ports,
      ),
    );

    expect(later).toBe(rejected);
    expect(now).toBe(thrownNow);
    expect(late).toEqual([]);
  });

  test("a tree call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once", async () => {
    const pending = Promise.withResolvers<TreeAnswer>();
    const fx = sessionOf(() => pending.promise);
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = treeCall(fx.session, { action: "containers" }, contextOf(controller), ports);
    await fx.called;
    controller.abort(reason);
    const record = await running;
    if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
    let settled = false;
    const watched = record.settled.then(() => {
      settled = true;
    });
    await turn();
    expect(settled).toBe(false);
    const thrown = new Error(marker());
    pending.reject(thrown);

    expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
    expect(record.reason).toBe(reason);
    expect(await firstLate).toBe(thrown);
    await watched;
    expect(settled).toBe(true);
    await turn();
    expect(late).toEqual([thrown]);
  });

  test("a tree answer that arrives after the stop is dropped, and settled resolves", async () => {
    const answered = Promise.withResolvers<TreeAnswer>();
    const fx = sessionOf(() => answered.promise);
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const stopped = treeCall(
      fx.session,
      { action: "describe", path: [marker()], kind: "table" },
      contextOf(controller),
      ports,
    );
    await fx.called;
    controller.abort(reason);
    const record = await stopped;
    if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
    answered.resolve({ containers: [] });
    await record.settled;
    await turn();

    expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
    expect(late).toEqual([]);
  });

  test("a session that throws its own signal's reason is answered as a stop", async () => {
    const { ports, late } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    const fx = sessionOf(
      (_request, ctx) =>
        new Promise<TreeAnswer>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        }),
    );

    const running = treeCall(fx.session, { action: "containers" }, contextOf(controller), ports);
    await fx.called;
    controller.abort(reason);
    const record = await running;
    if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
    await record.settled;
    await turn();

    expect(record.reason).toBe(reason);
    expect(late).toEqual([]);
  });

  test("a session that offers objects.tree with no tree function is a host defect, named", async () => {
    const { ports } = portsOf();
    const missing: ObjectsSession = { calls: callsOf(), objectModel: modelOf() };

    const defect = await failure(() => treeCall(missing, { action: "containers" }, contextOf(), ports));

    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers objects.tree and has no tree function, a defect of the host's session.",
    );
  });

  test("a malformed tree answer is refused at the core as the package's defect", async () => {
    const { ports, late } = portsOf();
    const extra = `k${marker()}`;
    const planted = marker();
    // Each answer is the package's, and not its request's action's form (clause C-62).
    const cases: [TreeRequest, unknown, CallRefusal[]][] = [
      [
        { action: "list", container: [marker()], kind: "table" },
        { containers: [] },
        [
          { rule: "tree-answer-unreadable", pointer: "/containers", name: "containers" },
          { rule: "tree-answer-unreadable", pointer: "/objects" },
        ],
      ],
      [
        { action: "count", container: [marker()] },
        { counts: { table: { count: -1 } }, [extra]: planted },
        [
          { rule: "tree-answer-unreadable", pointer: "/counts/table/count" },
          { rule: "tree-answer-unreadable", pointer: `/${extra}`, name: extra },
        ],
      ],
      [
        { action: "containers", parent: [marker()] },
        { containers: [], needsConfiguration: planted },
        [{ rule: "tree-answer-unreadable", pointer: "/needsConfiguration" }],
      ],
      [
        { action: "describe", path: [marker()], kind: "view" },
        planted,
        [{ rule: "tree-answer-unreadable", pointer: "" }],
      ],
    ];

    for (const [request, answer, refusals] of cases) {
      const fx = sessionOf(async () => answer as TreeAnswer);
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each record is its own call's.
      const record = await treeCall(fx.session, request, contextOf(), ports);
      expect(record).toEqual({ kind: "refused", called: true, refusals });
      expect(fx.reads).toHaveLength(1);
      expect(JSON.stringify(record)).not.toContain(planted);
    }
    expect(late).toEqual([]);
  });

  test("a bridged session's tree answer is held to the same form, and a well-formed one is answered by reference", async () => {
    const { ports } = portsOf();
    const objects = [{ path: ["app", marker()], name: marker(), kind: "table" }];
    const provider = createMockProvider({
      capabilities: {
        containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
        objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
      },
      objects,
    });
    const { session } = bridgedConsole(provider, {});

    const listed = await treeCall(session, { action: "list", container: ["app"], kind: "table" }, contextOf(), ports);
    if (listed.kind !== "answered") throw new Error(`An answer was expected, not ${listed.kind}.`);
    expect(listed.answer.objects).toBe(objects);

    // The legacy provider's own answer, which the bridge passes by reference, held to its action's form.
    provider.listObjects = mock(async () => [{ path: ["app"], name: 1, kind: "table" }]) as never;
    provider.describeObjects = mock(async () => ({ details: [] }) as never);
    const refused = await treeCall(session, { action: "list", container: ["app"], kind: "table" }, contextOf(), ports);
    const batch = await treeCall(
      session,
      { action: "describeMany", container: ["app"], kind: "table", limit: 1 },
      contextOf(),
      ports,
    );

    expect(refused).toEqual({
      kind: "refused",
      called: true,
      refusals: [{ rule: "tree-answer-unreadable", pointer: "/objects/0/name" }],
    });
    expect(batch).toEqual({ kind: "answered", answer: { details: [] } });
  });
});
