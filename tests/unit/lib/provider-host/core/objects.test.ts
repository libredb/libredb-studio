/**
 * The host core's tree call (src/lib/provider-host/core/objects.ts; docs/providers/CONTRACT.md, clause C-64): a tree
 * call is checked before it is made and refused as a record, runs on a context and request frozen in place, is waited
 * for until the call's signal, and answers the session's own answer by reference, as the console calls answer theirs.
 *
 * Every session here is a fake whose `tree` the test drives through promises it settles itself; no assertion follows a
 * timer. `objects-bounds.test.ts` holds a tree call that never settles, with a real deadline, in a bounded Node child.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallContext, envReader, type TreeAnswer, type TreeRequest } from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import type { HostCallPorts } from "@/lib/provider-host/core/console";
import { type ObjectsSession, treeCall } from "@/lib/provider-host/core/objects";

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
    const missing: ObjectsSession = { calls: callsOf() };

    const defect = await failure(() => treeCall(missing, { action: "containers" }, contextOf(), ports));

    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers objects.tree and has no tree function, a defect of the host's session.",
    );
  });
});
