/**
 * The host core's maintenance calls (src/lib/provider-host/core/maintenance.ts; docs/providers/CONTRACT.md, clause
 * C-69): a maintenance run or preview is checked before it is made, its facet and its request against the session's
 * maintenance included, and refused as a record; it runs on a context and request frozen in place, is waited for until
 * the call's signal, and answers the session's own answer by reference, as the tree call answers its own.
 *
 * Every session here is a fake whose `run` and `preview` the test drives through promises it settles itself; no
 * assertion follows a timer. `maintenance-bounds.test.ts` holds a call that never settles, with a real deadline, in a
 * bounded Node child.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallContext,
  type EngineMaintenance,
  envReader,
  type MaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, MaintenanceSpec } from "@libredb/provider-sdk/manifest";
import type { HostCallPorts } from "@/lib/provider-host/core/console";
import {
  type MaintenancePreviewRecord,
  type MaintenanceRunRecord,
  type MaintenanceSession,
  maintenancePreviewCall,
  maintenanceRunCall,
} from "@/lib/provider-host/core/maintenance";

const HOUR = 3_600_000;
const marker = (): string => randomUUID();

/** A session's calls, with both maintenance facets offered unless told otherwise. */
function callsOf(run = true, preview = true): Calls {
  return {
    console: {
      execute: { honours: [] },
      cancel: "not-offered",
      endScope: "not-offered",
      transaction: "not-offered",
    },
    objects: { tree: "not-offered" },
    maintenance: { run: run ? "offered" : "not-offered", preview: preview ? "offered" : "not-offered" },
  };
}

function specOf(operation: MaintenanceSpec["operation"], perEntity: boolean, global: boolean, preview = false) {
  return {
    operation,
    label: operation,
    perEntity,
    global,
    title: null,
    description: null,
    confirmation: null,
    preview,
    kinds: null,
  } satisfies MaintenanceSpec;
}

/** A maintenance with vacuum over the whole database only, kill on neither placement and release previewed on a row. */
const MAINTENANCE: EngineMaintenance = {
  maintenance: ["vacuum", "kill", "release"],
  maintenanceSpecs: [specOf("vacuum", false, true), specOf("kill", false, false), specOf("release", true, false, true)],
};

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

interface Read {
  readonly request: MaintenanceRunRequest | MaintenancePreviewRequest;
  readonly ctx: CallContext;
}

/** A session whose run and preview answer what `run` and `preview` give, recording each call. */
function sessionOf(
  run: (request: MaintenanceRunRequest, ctx: CallContext) => Promise<MaintenanceRunAnswer>,
  preview: (request: MaintenancePreviewRequest, ctx: CallContext) => Promise<MaintenancePreview>,
  calls = callsOf(),
) {
  const reads: Read[] = [];
  const called = Promise.withResolvers<void>();
  const session: MaintenanceSession = {
    calls,
    maintenance: MAINTENANCE,
    run: (request, ctx) => {
      reads.push({ request, ctx });
      called.resolve();
      return run(request, ctx);
    },
    preview: (request, ctx) => {
      reads.push({ request, ctx });
      called.resolve();
      return preview(request, ctx);
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

type Facet = "run" | "preview";

/** One call of `facet` on `session`, with a request the maintenance above takes. */
function callOf(
  facet: Facet,
  session: MaintenanceSession,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<MaintenanceRunRecord | MaintenancePreviewRecord> {
  return facet === "run"
    ? maintenanceRunCall(session, { operation: "vacuum" }, ctx, ports)
    : maintenancePreviewCall(session, { operation: "release", path: [marker(), marker()] }, ctx, ports);
}

/** A session whose run and preview both answer `answer`. */
function answering(
  answer: () => Promise<never> | Promise<MaintenanceRunAnswer & MaintenancePreview>,
  calls = callsOf(),
) {
  return sessionOf(answer as never, answer as never, calls);
}

const FACETS: readonly Facet[] = ["run", "preview"];

describe("maintenanceRunCall and maintenancePreviewCall", () => {
  test("a maintenance call whose signal aborted or whose deadline passed is refused as a record, and the provider is never called", async () => {
    for (const facet of FACETS) {
      const fx = answering(async () => {
        throw new Error("never called");
      });
      const { ports } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());
      controller.abort(reason);

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const aborted = await callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const late = await callOf(facet, fx.session, contextOf(new AbortController(), Date.now() - 1), ports);

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
    }
  });

  test("a maintenance call to a session without its facet is refused as a record before the call", async () => {
    for (const facet of FACETS) {
      const fx = answering(
        async () => {
          throw new Error("never called");
        },
        callsOf(facet !== "run", facet !== "preview"),
      );
      const { ports } = portsOf();

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each record is its own call's.
      const record = await callOf(facet, fx.session, contextOf(), ports);

      expect(record).toEqual({
        kind: "refused",
        called: false,
        refusals: [{ rule: "facet-not-offered", pointer: `/maintenance/${facet}`, name: `maintenance.${facet}` }],
      });
      expect(fx.reads).toEqual([]);
    }
  });

  test("a maintenance request the session's maintenance does not take is refused as a record before the call", async () => {
    const fx = answering(async () => {
      throw new Error("never called");
    });
    const { ports } = portsOf();

    const unlisted = await maintenanceRunCall(fx.session, { operation: "analyze" }, contextOf(), ports);
    const withdrawn = await maintenanceRunCall(
      fx.session,
      { operation: "vacuum", target: marker() },
      contextOf(),
      ports,
    );
    const noPreview = await maintenancePreviewCall(
      fx.session,
      { operation: "vacuum", path: [marker()] },
      contextOf(),
      ports,
    );

    expect(unlisted).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-operation-not-offered", pointer: "/operation" }],
    });
    expect(withdrawn).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-placement-not-offered", pointer: "/target" }],
    });
    expect(noPreview).toEqual({
      kind: "refused",
      called: false,
      refusals: [{ rule: "request-preview-not-offered", pointer: "/operation" }],
    });
    expect(fx.reads).toEqual([]);
  });

  test("a maintenance call answers the session's own answer, with the request and context frozen", async () => {
    const runAnswer: MaintenanceRunAnswer = { success: true, executionTime: 3, message: marker() };
    const previewAnswer: MaintenancePreview = { summary: marker(), facts: [{ label: marker(), value: marker() }] };
    const fx = sessionOf(
      async () => runAnswer,
      async () => previewAnswer,
    );
    const { ports, late } = portsOf();
    const runRequest: MaintenanceRunRequest = { operation: "kill", target: marker() };
    const path = [marker(), marker()];
    const previewRequest: MaintenancePreviewRequest = { operation: "release", path };
    const runContext = contextOf();
    const previewContext = contextOf();

    const ran = await maintenanceRunCall(fx.session, runRequest, runContext, ports);
    const previewed = await maintenancePreviewCall(fx.session, previewRequest, previewContext, ports);

    if (ran.kind !== "answered" || previewed.kind !== "answered") throw new Error("Answers were expected.");
    expect(ran.answer).toBe(runAnswer);
    expect(previewed.answer).toBe(previewAnswer);
    expect(fx.reads.map((read) => read.request)).toEqual([runRequest, previewRequest]);
    expect(fx.reads[0]?.request).toBe(runRequest);
    expect(fx.reads[0]?.ctx).toBe(runContext);
    expect(fx.reads[1]?.request).toBe(previewRequest);
    expect(fx.reads[1]?.ctx).toBe(previewContext);
    for (const frozen of [runRequest, previewRequest, path, runContext, previewContext]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(late).toEqual([]);
  });

  test("an error the provider throws reaches the caller as the same object", async () => {
    for (const facet of FACETS) {
      const rejected = new Error(marker());
      const thrownNow = new Error(marker());
      const { ports, late } = portsOf();

      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each error is its own call's.
      const later = await failure(() =>
        callOf(
          facet,
          answering(async () => {
            throw rejected;
          }).session,
          contextOf(),
          ports,
        ),
      );
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each error is its own call's.
      const now = await failure(() =>
        callOf(
          facet,
          answering(() => {
            throw thrownNow;
          }).session,
          contextOf(),
          ports,
        ),
      );

      expect(later).toBe(rejected);
      expect(now).toBe(thrownNow);
      expect(late).toEqual([]);
    }
  });

  test("a maintenance call the caller stops waiting for answers a stop at once, and its later failure reaches the late handler once", async () => {
    for (const facet of FACETS) {
      const pending = Promise.withResolvers<never>();
      const fx = answering(() => pending.promise);
      const { ports, late, firstLate } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());

      const running = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await running;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      let settled = false;
      const watched = record.settled.then(() => {
        settled = true;
      });
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();
      expect(settled).toBe(false);
      const thrown = new Error(marker());
      pending.reject(thrown);

      expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
      expect(record.reason).toBe(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      expect(await firstLate).toBe(thrown);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await watched;
      expect(settled).toBe(true);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();
      expect(late).toEqual([thrown]);
    }
  });

  test("a maintenance answer that arrives after the stop is dropped, and settled resolves", async () => {
    for (const facet of FACETS) {
      const answered = Promise.withResolvers<MaintenanceRunAnswer & MaintenancePreview>();
      const fx = answering(() => answered.promise);
      const { ports, late } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());

      const stopped = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await stopped;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      answered.resolve({ success: true, executionTime: 1, message: marker(), summary: marker(), facts: [] });
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await record.settled;
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();

      expect(record).toEqual({ kind: "stopped", reason, settled: expect.any(Promise) });
      expect(late).toEqual([]);
    }
  });

  test("a session that throws its own signal's reason is answered as a stop", async () => {
    for (const facet of FACETS) {
      const { ports, late } = portsOf();
      const controller = new AbortController();
      const reason = new Error(marker());
      const own = (_request: unknown, ctx: CallContext) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      const fx = sessionOf(own, own);

      const running = callOf(facet, fx.session, contextOf(controller), ports);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await fx.called;
      controller.abort(reason);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      const record = await running;
      if (record.kind !== "stopped") throw new Error(`A stop was expected, not ${record.kind}.`);
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await record.settled;
      // oxlint-disable-next-line no-await-in-loop -- one facet at a time, so each stop is its own call's.
      await turn();

      expect(record.reason).toBe(reason);
      expect(late).toEqual([]);
    }
  });

  test("a session that offers a maintenance facet with no function is a host defect, named", async () => {
    const { ports } = portsOf();
    const missing: MaintenanceSession = { calls: callsOf(), maintenance: MAINTENANCE };

    const run = await failure(() => callOf("run", missing, contextOf(), ports));
    const preview = await failure(() => callOf("preview", missing, contextOf(), ports));

    expect(run).toBeInstanceOf(Error);
    expect((run as Error).message).toBe(
      "The session offers maintenance.run and has no run function, a defect of the host's session.",
    );
    expect((preview as Error).message).toBe(
      "The session offers maintenance.preview and has no preview function, a defect of the host's session.",
    );
  });
});
