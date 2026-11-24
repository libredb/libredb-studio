/**
 * The host core's endScope call (src/lib/provider-host/core/console.ts; docs/providers/CONTRACT.md, clauses C-48 and
 * C-60): an endScope call is checked before it is made and refused as a record, runs on a context and request frozen
 * in place, is waited for until the call's signal, and answers the outcome its session answered, by reference, as a
 * cancel's answer is read. The caller that minted the scope makes this call after the run; core's execute never ends a
 * scope.
 *
 * Every session here is a fake whose functions the test drives through promises it settles itself; no assertion
 * follows a timer. `console-bounds.test.ts` holds an endScope call that never settles, with a real deadline, in a
 * bounded Node child.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallContext, type EndScopeAnswer, type EndScopeRequest, envReader } from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import { type ConsoleSession, endScopeCall, type HostCallPorts } from "@/lib/provider-host/core/console";

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** A session's calls, with `console.endScope` offered unless told otherwise. */
function callsOf(endScope = true): Calls {
  return {
    console: {
      execute: { honours: ["params", "offset"] },
      cancel: "not-offered",
      endScope: endScope ? "offered" : "not-offered",
      transaction: "not-offered",
    },
    objects: { tree: "not-offered" },
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

/** A session whose endScope answers what `answer` gives, recording each call. */
function sessionOf(answer: (request: EndScopeRequest, ctx: CallContext) => Promise<EndScopeAnswer>, calls = callsOf()) {
  const ends: { readonly request: EndScopeRequest; readonly ctx: CallContext }[] = [];
  const called = Promise.withResolvers<void>();
  const session: ConsoleSession = {
    calls,
    readOnlyStatements: false,
    execute: async () => ({ results: [], warnings: [], executionTimeMs: 1, pageApplied: false }),
    endScope: (request, ctx) => {
      ends.push({ request, ctx });
      called.resolve();
      return answer(request, ctx);
    },
  };
  return { session, ends, called: called.promise };
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

describe("endScopeCall", () => {
  test("an endScope call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    const fx = sessionOf(async () => ({ openTransaction: "none" }));
    const { ports } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());
    controller.abort(reason);

    const aborted = await endScopeCall(fx.session, { scope: marker() }, contextOf(controller), ports);
    const late = await endScopeCall(
      fx.session,
      { scope: marker() },
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
    expect(fx.ends).toEqual([]);
  });

  test("an endScope call to a session without console.endScope is refused as a record before the call", async () => {
    const fx = sessionOf(async () => ({ openTransaction: "rolled-back" }), callsOf(false));
    const { ports } = portsOf();

    const record = await endScopeCall(fx.session, { scope: marker() }, contextOf(), ports);

    expect(record).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "facet-not-offered", pointer: "/console/endScope", name: "console.endScope" }],
    });
    expect(fx.ends).toEqual([]);
  });

  test("an endScope call answers the outcome its session answered, with the request and context frozen", async () => {
    const outcomes: Record<string, EndScopeAnswer["openTransaction"]> = {};
    const fx = sessionOf(async (request) => ({ openTransaction: outcomes[request.scope] ?? "none" }));
    const { ports, late } = portsOf();
    const rolled = marker();
    const clean = marker();
    outcomes[rolled] = "rolled-back";
    outcomes[clean] = "none";
    const request: EndScopeRequest = { scope: rolled };
    const ctx = contextOf();

    const rolledBack = await endScopeCall(fx.session, request, ctx, ports);
    const none = await endScopeCall(fx.session, { scope: clean }, contextOf(), ports);

    expect(rolledBack).toEqual({ kind: "answered", openTransaction: "rolled-back" });
    expect(none).toEqual({ kind: "answered", openTransaction: "none" });
    expect(fx.ends.map((end) => end.request.scope)).toEqual([rolled, clean]);
    expect(fx.ends[0]?.request).toBe(request);
    expect(fx.ends[0]?.ctx).toBe(ctx);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(late).toEqual([]);
  });

  test("an error the provider throws reaches the caller as the same object", async () => {
    const rejected = new Error(marker());
    const thrownNow = new Error(marker());
    const { ports, late } = portsOf();

    const later = await failure(() =>
      endScopeCall(
        sessionOf(async () => {
          throw rejected;
        }).session,
        { scope: marker() },
        contextOf(),
        ports,
      ),
    );
    const now = await failure(() =>
      endScopeCall(
        sessionOf(() => {
          throw thrownNow;
        }).session,
        { scope: marker() },
        contextOf(),
        ports,
      ),
    );

    expect(later).toBe(rejected);
    expect(now).toBe(thrownNow);
    expect(late).toEqual([]);
  });

  test("an endScope call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once", async () => {
    const pending = Promise.withResolvers<EndScopeAnswer>();
    const fx = sessionOf(() => pending.promise);
    const { ports, late, firstLate } = portsOf();
    const controller = new AbortController();
    const reason = new Error(marker());

    const running = endScopeCall(fx.session, { scope: marker() }, contextOf(controller), ports);
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
    expect(await firstLate).toBe(thrown);
    await watched;
    expect(settled).toBe(true);
    await turn();
    expect(late).toEqual([thrown]);

    // A later answer is dropped: nothing reaches the late handler.
    const answered = Promise.withResolvers<EndScopeAnswer>();
    const other = sessionOf(() => answered.promise);
    const otherController = new AbortController();
    const stopped = endScopeCall(other.session, { scope: marker() }, contextOf(otherController), ports);
    await other.called;
    otherController.abort(reason);
    expect(await stopped).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
    answered.resolve({ openTransaction: "rolled-back" });
    await turn();
    expect(late).toEqual([thrown]);
  });

  test("a session that offers console.endScope with no endScope function is a host defect, named", async () => {
    const { ports } = portsOf();
    const missing: ConsoleSession = {
      calls: callsOf(),
      readOnlyStatements: false,
      execute: async () => ({ results: [], warnings: [], executionTimeMs: 1, pageApplied: false }),
    };

    const defect = await failure(() => endScopeCall(missing, { scope: marker() }, contextOf(), ports));

    expect(defect).toBeInstanceOf(Error);
    expect((defect as Error).message).toBe(
      "The session offers console.endScope and has no endScope function, a defect of the host's session.",
    );
  });
});
