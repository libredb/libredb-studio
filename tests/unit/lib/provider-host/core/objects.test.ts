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
  type ObjectSourceDocument,
  type ObjectSourcePart,
  SOURCE_CHARACTER_LIMIT,
  type SourceRequest,
  sourceBoundTruncationReason,
  type TreeAnswer,
  type TreeRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, ObjectModel } from "@libredb/provider-sdk/manifest";
import type { HostCallPorts } from "@/lib/provider-host/core/console";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { type ObjectsSession, sourceCall, treeCall } from "@/lib/provider-host/core/objects";
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
    objects: { tree: tree ? "offered" : "not-offered", source: "not-offered" },
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

/** A session's calls with `objects.source` offered unless told otherwise, and the tree not offered. */
function sourceCallsOf(source = true): Calls {
  const calls = callsOf(false);
  return { ...calls, objects: { tree: "not-offered", source: source ? "offered" : "not-offered" } };
}

/**
 * A source model: one container level, the kind `routine` with source, the kind `item` without, and the kind `trigger`
 * with source and attached to `item`.
 */
function sourceModelOf(): ObjectModel {
  return {
    ...modelOf(),
    objectKinds: [
      { ...kindOf("routine"), role: "routine", hasSource: true, sourceLanguage: "sql", hasColumns: false },
      kindOf("item"),
      { ...kindOf("trigger"), role: "attached", hasSource: true, sourceLanguage: "sql", attachedTo: "item" },
    ],
  };
}

/** A readable part of `text`, complete and stored. */
function readablePart(text: string): ObjectSourcePart {
  return { id: "definition", label: "Definition", text, language: "sql", form: "complete", origin: "stored" };
}

/** A session whose source answers what `answer` gives, recording each call. */
function sourceSessionOf(
  answer: (request: SourceRequest, ctx: CallContext) => Promise<ObjectSourceDocument>,
  calls = sourceCallsOf(),
) {
  const reads: { readonly request: SourceRequest; readonly ctx: CallContext }[] = [];
  const called = Promise.withResolvers<void>();
  const session: ObjectsSession = {
    calls,
    objectModel: sourceModelOf(),
    source: (request, ctx) => {
      reads.push({ request, ctx });
      called.resolve();
      return answer(request, ctx);
    },
  };
  return { session, reads, called: called.promise };
}

/** The document a source read of `request` answers: the request's path and kind, and `parts`. */
function documentOf(request: SourceRequest, ...parts: ObjectSourcePart[]): ObjectSourceDocument {
  const [first = readablePart(marker()), ...rest] = parts;
  return { path: request.path, kind: request.kind, parts: [first, ...rest] };
}

describe("sourceCall", () => {
  test("the source call runs only where the session offers objects.source, under the call's deadline", async () => {
    const fx = sourceSessionOf(async (request) => documentOf(request));
    const unoffered = sourceSessionOf(async (request) => documentOf(request), sourceCallsOf(false));
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);
    const request = (): SourceRequest => ({ path: [marker(), marker()], kind: "routine" });

    const aborted = await sourceCall(fx.session, request(), contextOf(controller), ports);
    const late = await sourceCall(fx.session, request(), contextOf(new AbortController(), Date.now() - 1), ports);
    const refused = await sourceCall(unoffered.session, request(), contextOf(), ports);

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
    expect(refused).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/objects/source", name: "objects.source" }],
    });
    expect(fx.reads).toEqual([]);
    expect(unoffered.reads).toEqual([]);
    expect(createHostCore().sourceCall).toBe(sourceCall);
  });

  test("a source call naming a kind the model does not state or states without source, or a path the model does not admit, is refused as a record before the call, and the provider is never called", async () => {
    const fx = sourceSessionOf(async (request) => documentOf(request));
    const { ports } = portsOf();
    const unstated = marker();
    const cases: [SourceRequest, CallRefusal[]][] = [
      [{ path: [marker()], kind: unstated }, [{ rule: "request-kind-not-stated", pointer: "/kind" }]],
      [{ path: [marker()], kind: "item" }, [{ rule: "request-source-not-stated", pointer: "/kind" }]],
      [{ path: [], kind: "routine" }, [{ rule: "request-field-empty", pointer: "/path", name: "path" }]],
      [
        { path: [marker(), marker(), marker()], kind: "routine" },
        [{ rule: "request-path-not-admitted", pointer: "/path" }],
      ],
      [
        { path: [marker(), marker(), marker(), marker()], kind: "trigger" },
        [{ rule: "request-path-not-admitted", pointer: "/path" }],
      ],
    ];

    for (const [request, refusals] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each record is its own call's.
      const record = await sourceCall(fx.session, request, contextOf(), ports);
      expect(record).toEqual({ kind: "refused", called: false, refusals });
      expect(JSON.stringify(record)).not.toContain(unstated);
    }
    expect(fx.reads).toEqual([]);

    // The deepest path each kind admits is called: the container path plus the name, and the parent's for an attached kind.
    const routine = await sourceCall(fx.session, { path: [marker(), marker()], kind: "routine" }, contextOf(), ports);
    const trigger = await sourceCall(
      fx.session,
      { path: [marker(), marker(), marker()], kind: "trigger" },
      contextOf(),
      ports,
    );
    expect(routine.kind).toBe("answered");
    expect(trigger.kind).toBe("answered");
    expect(fx.reads).toHaveLength(2);
  });

  test("a session that offers objects.source and states no object model or holds no source function is a host defect, named", async () => {
    const { ports } = portsOf();
    const fx = sourceSessionOf(async (request) => documentOf(request));
    const unmodelled: ObjectsSession = { calls: fx.session.calls, source: fx.session.source };
    const missing: ObjectsSession = { calls: sourceCallsOf(), objectModel: sourceModelOf() };
    const request = (): SourceRequest => ({ path: [marker()], kind: "routine" });

    const noModel = await failure(() => sourceCall(unmodelled, request(), contextOf(), ports));
    const noFunction = await failure(() => sourceCall(missing, request(), contextOf(), ports));

    expect(noModel).toBeInstanceOf(Error);
    expect((noModel as Error).message).toBe(
      "The session offers objects.source and states no object model, a defect of the host's session.",
    );
    expect(noFunction).toBeInstanceOf(Error);
    expect((noFunction as Error).message).toBe(
      "The session offers objects.source and has no source function, a defect of the host's session.",
    );
    expect(fx.reads).toEqual([]);
  });

  test("a source call answers the provider's document cut by the SDK's bound helper, a new document with the request and context frozen, and a part with its own undefined unavailable read as the check read it", async () => {
    const { ports, late } = portsOf();
    const path = [marker(), marker()];
    const request: SourceRequest = { path, kind: "routine" };
    const ctx = contextOf();
    const fitting = readablePart(marker());
    const statement: ObjectSourcePart = { id: "note", label: "Note", unavailable: marker(), statement: true };
    const answer = documentOf(request, fitting, statement);
    const fx = sourceSessionOf(async () => answer);

    const record = await sourceCall(fx.session, request, ctx, ports);

    if (record.kind !== "answered") throw new Error(`An answer was expected, not ${record.kind}.`);
    expect(record.answer).toEqual(answer);
    expect(record.answer).not.toBe(answer);
    expect(record.answer.parts[0]).toBe(fitting);
    expect(record.answer.parts[1]).toBe(statement);
    expect(fx.reads[0]?.request).toBe(request);
    expect(fx.reads[0]?.ctx).toBe(ctx);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(path)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);

    // A text past the bound is cut and marked, a provider's own mark joined; a readable part with its own undefined
    // `unavailable` is answered without that member, cut as a readable part.
    const own = marker();
    const long = "x".repeat(SOURCE_CHARACTER_LIMIT + 5);
    const bound = sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT);
    const marked = { ...readablePart(long), truncated: { limit: 3, reason: own } };
    const hybrid = { ...readablePart(long), id: "other", unavailable: undefined } as unknown as ObjectSourcePart;
    const cut = await sourceCall(
      sourceSessionOf(async (asked) => documentOf(asked, marked, hybrid)).session,
      { path: [marker()], kind: "routine" },
      contextOf(),
      ports,
    );

    if (cut.kind !== "answered") throw new Error(`An answer was expected, not ${cut.kind}.`);
    const [first, second] = cut.answer.parts;
    expect(first).toEqual({
      ...readablePart("x".repeat(SOURCE_CHARACTER_LIMIT)),
      truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: `${own}; ${bound}` },
    });
    expect(second).toEqual({
      ...readablePart("x".repeat(SOURCE_CHARACTER_LIMIT)),
      id: "other",
      truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: bound },
    });
    expect(Object.hasOwn(second as object, "unavailable")).toBe(false);
    expect(late).toEqual([]);
  });

  test("a malformed source answer is refused at the core as source-answer-unreadable at its pointer, and the provider's error reaches the caller as the same object", async () => {
    const { ports, late } = portsOf();
    const planted = marker();
    const request = (): SourceRequest => ({ path: [marker()], kind: "routine" });
    // Each answer is the provider's, and not the closed source document of its request (clause C-115).
    const cases: [(asked: SourceRequest) => unknown, CallRefusal[]][] = [
      [
        (asked) => ({ ...documentOf(asked), path: [planted] }),
        [{ rule: "source-answer-unreadable", pointer: "/path/0" }],
      ],
      [(asked) => ({ ...documentOf(asked), kind: planted }), [{ rule: "source-answer-unreadable", pointer: "/kind" }]],
      [(asked) => ({ ...documentOf(asked), parts: [] }), [{ rule: "source-answer-unreadable", pointer: "/parts" }]],
      [
        (asked) => documentOf(asked, readablePart("")),
        [{ rule: "source-answer-unreadable", pointer: "/parts/0/text" }],
      ],
    ];

    for (const [answer, refusals] of cases) {
      const fx = sourceSessionOf(async (asked) => answer(asked) as ObjectSourceDocument);
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each record is its own call's.
      const record = await sourceCall(fx.session, request(), contextOf(), ports);
      expect(record).toEqual({ kind: "refused", called: true, refusals });
      expect(fx.reads).toHaveLength(1);
      expect(JSON.stringify(record)).not.toContain(planted);
    }

    const rejected = new Error(marker());
    const thrownNow = new Error(marker());
    const later = await failure(() =>
      sourceCall(
        sourceSessionOf(async () => {
          throw rejected;
        }).session,
        request(),
        contextOf(),
        ports,
      ),
    );
    const now = await failure(() =>
      sourceCall(
        sourceSessionOf(() => {
          throw thrownNow;
        }).session,
        request(),
        contextOf(),
        ports,
      ),
    );
    expect(later).toBe(rejected);
    expect(now).toBe(thrownNow);
    expect(late).toEqual([]);
  });

  test("a source call the caller stops waiting for answers a stop at once, its later failure reaches the late handler once, and a later answer is dropped", async () => {
    const failing = Promise.withResolvers<ObjectSourceDocument>();
    const fx = sourceSessionOf(() => failing.promise);
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = sourceCall(fx.session, { path: [marker()], kind: "routine" }, contextOf(controller), ports);
    await fx.called;
    controller.abort(reason);
    const record = await running;
    if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
    const thrown = new Error(marker());
    failing.reject(thrown);

    expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
    expect(record.reason).toBe(reason);
    expect(await firstLate).toBe(thrown);
    await record.settled;
    await turn();
    expect(late).toEqual([thrown]);

    // A later answer is dropped: the stop stands and nothing reaches the late handler.
    const answering = Promise.withResolvers<ObjectSourceDocument>();
    const dropped = sourceSessionOf(() => answering.promise);
    const stopper = new AbortController();
    const asked: SourceRequest = { path: [marker()], kind: "routine" };
    const pending = sourceCall(dropped.session, asked, contextOf(stopper), ports);
    await dropped.called;
    stopper.abort(reason);
    const stopped = await pending;
    if (stopped.kind !== "stopped") throw new Error(`A stop was expected, not ${stopped.kind}.`);
    answering.resolve(documentOf({ path: [marker()], kind: "routine" }));
    await stopped.settled;
    await turn();
    expect(late).toEqual([thrown]);
  });
});
