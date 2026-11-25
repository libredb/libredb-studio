/**
 * The maintenance caller facade (src/lib/api/provider-maintenance.ts; docs/providers/CONTRACT.md, clause C-70): each
 * maintenance run and preview of the two maintenance routes is one host core maintenance call on the legacy bridge's
 * session, its maintenance the provider's declaration narrowed by what the connected provider accepts, under a deadline
 * of its own, the statement timeout plus ten seconds from that call's start, and the caller's signal, and answers the
 * provider's own answer by reference.
 *
 * The real host core is installed for the file; a case that needs a record the real core would answer only at a real
 * deadline installs a core of its own around the real one and restores it. Every double signals when the call reaches
 * it, and no assertion follows a timer. `provider-maintenance-bounds.test.ts` holds a run that never answers, with a
 * real deadline, in a bounded Node child.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  CallContext,
  MaintenancePreview,
  MaintenancePreviewRequest,
  MaintenanceRunRequest,
} from "@libredb/provider-sdk/calls";
import { EXECUTE_SLACK_MS, executeDeadline } from "@/lib/api/editor-query";
import { type MaintenanceRunOutcome, providerMaintenance } from "@/lib/api/provider-maintenance";
import { errorOutcome } from "@/lib/db/error-record";
import { QueryCancelledError, StudioTimeoutRefusal, waitedSeconds } from "@/lib/db/errors";
import type { DatabaseProvider, MaintenanceDeclaration, MaintenanceResult } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { MaintenancePreviewRecord, MaintenanceRunRecord } from "@/lib/provider-host/core/maintenance";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ROUTE = "provider-maintenance-test";
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

/** A declaration with vacuum on a row and whole, kill on neither and release previewed on a row. */
const DECLARED: Required<MaintenanceDeclaration> = {
  maintenanceOperations: ["vacuum", "kill", "release"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum", perEntity: true, global: true },
    kill: { label: "Terminate", perEntity: false, global: false },
    release: { label: "Release", perEntity: true, global: false, preview: true },
  },
};

/** A mock provider whose statement timeout is `queryTimeout`, connected as `DECLARED`, with a recorded preview. */
function providerOf(queryTimeout?: number, previews = true): DatabaseProvider {
  const provider = createMockProvider({
    config: connectionWith({ queryTimeout }),
    capabilities: { supportsMaintenance: true, ...DECLARED },
  });
  if (!previews) return provider;
  return Object.assign(provider, {
    previewMaintenance: mock(async (): Promise<MaintenancePreview> => ({ summary: marker(), facts: [] })),
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
  throw new Error("The call was expected to fail, and it answered.");
}

/** The error of a run outcome that is not an answer; an answer fails the case. */
function errorOf(outcome: MaintenanceRunOutcome, kind: "not-sent" | "stopped"): Error {
  if (outcome.kind !== kind) throw new Error(`A ${kind} outcome was expected, not ${outcome.kind}.`);
  return outcome.error;
}

const TIMEOUT_REASON = () => new DOMException("The call's deadline has passed.", "TimeoutError");

/** The deadline sentence of `noun` on a provider whose statement timeout is `queryTimeout`. */
const deadlineSentence = (noun: "run" | "preview", queryTimeout: number) =>
  `The maintenance ${noun} did not answer within the statement timeout of ${waitedSeconds(queryTimeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;

describe("providerMaintenance", () => {
  test("each maintenance run and preview is one host core call with a fresh request, on a deadline of the statement timeout plus ten seconds from its own start", async () => {
    const provider = providerOf(2_000);
    const seen: { request: MaintenanceRunRequest | MaintenancePreviewRequest; ctx: CallContext; session: unknown }[] =
      [];
    const path = ["app", "orders"];
    const starts: number[] = [];
    // A clock the test steps, seven milliseconds further on each call, so each call's start is its own.
    const steppedClock = () => {
      const at = Date.now() + starts.length * 7;
      starts.push(at);
      return at;
    };
    await withCore(
      (real) => ({
        ...real,
        maintenanceRunCall: (session, request, ctx, ports) => {
          seen.push({ request, ctx, session });
          return real.maintenanceRunCall(session, request, ctx, ports);
        },
        maintenancePreviewCall: (session, request, ctx, ports) => {
          seen.push({ request, ctx, session });
          return real.maintenancePreviewCall(session, request, ctx, ports);
        },
      }),
      async () => {
        const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE, steppedClock);
        await maintenance.run("vacuum", "users", "app");
        await maintenance.run("vacuum");
        await maintenance.run("kill", "4711");
        await maintenance.preview("release", path);
      },
    );

    expect(seen.map(({ request }) => request)).toEqual([
      { operation: "vacuum", target: "users", container: "app" },
      { operation: "vacuum" },
      { operation: "kill", target: "4711" },
      { operation: "release", path: ["app", "orders"] },
    ]);
    expect(Object.hasOwn(seen[1]?.request ?? {}, "target")).toBe(false);
    expect(Object.hasOwn(seen[1]?.request ?? {}, "container")).toBe(false);
    expect(Object.hasOwn(seen[2]?.request ?? {}, "container")).toBe(false);
    expect(seen.map(({ ctx }) => ctx.deadline)).toEqual(starts.map((start) => executeDeadline(provider, start)));
    expect(new Set(starts).size).toBe(4);
    expect(executeDeadline(provider, starts[0] as number)).toBe((starts[0] as number) + 2_000 + EXECUTE_SLACK_MS);
    expect(Object.isFrozen(path)).toBe(false);
    const [first, , , previewed] = seen;
    if (first === undefined || previewed === undefined) throw new Error("Four calls were expected.");
    expect((previewed.request as MaintenancePreviewRequest).path).not.toBe(path);
    expect((first.session as { maintenance: unknown }).maintenance).toEqual({
      maintenance: ["vacuum", "kill", "release"],
      maintenanceSpecs: [
        expect.objectContaining({ operation: "vacuum", perEntity: true, global: true }),
        expect.objectContaining({ operation: "kill", perEntity: false, global: false }),
        expect.objectContaining({ operation: "release", perEntity: true, global: false, preview: true }),
      ],
    });
    expect(mockOf(provider.runMaintenance).mock.calls).toEqual([
      ["vacuum", "users", "app"],
      ["vacuum", undefined, undefined],
      ["kill", "4711", undefined],
    ]);
  });

  test("a run and a preview answer the provider's own answer by reference, and the preview's offer is the bridged session's", async () => {
    const provider = providerOf();
    const result: MaintenanceResult = { success: true, executionTime: 4, message: marker(), rows: [], fields: [] };
    const preview: MaintenancePreview = { summary: marker(), facts: [{ label: marker(), value: marker() }] };
    mockOf(provider.runMaintenance).mockImplementation(async () => result);
    mockOf(provider.previewMaintenance).mockImplementation(async () => preview);
    const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE);

    const ran = await maintenance.run("vacuum");
    const previewed = await maintenance.preview("release", ["app", "orders"]);

    if (ran.kind !== "answered") throw new Error(`An answer was expected, not ${ran.kind}.`);
    expect(ran.result).toBe(result);
    expect(previewed).toBe(preview);
    expect(maintenance.previewOffered).toBe(true);
    expect(providerMaintenance(providerOf(undefined, false), DECLARED, new AbortController().signal, ROUTE)).toEqual(
      expect.objectContaining({ previewOffered: false }),
    );
  });

  test("an error the provider raises reaches the caller as the same object", async () => {
    const provider = providerOf();
    const ranThrown = new Error(marker());
    const previewThrown = new Error(marker());
    mockOf(provider.runMaintenance).mockImplementation(async () => {
      throw ranThrown;
    });
    mockOf(provider.previewMaintenance).mockImplementation(async () => {
      throw previewThrown;
    });
    const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE);

    expect(await failure(() => maintenance.run("vacuum", "users"))).toBe(ranThrown);
    expect(await failure(() => maintenance.preview("release", ["orders"]))).toBe(previewThrown);
  });

  test("a caller that leaves while the provider runs is answered a stop at once, QueryCancelledError outcome unknown, and the later failure is logged by kind and code, never its text", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      for (const facet of ["run", "preview"] as const) {
        const provider = providerOf();
        const pending = Promise.withResolvers<never>();
        const reached = Promise.withResolvers<void>();
        const member = facet === "run" ? provider.runMaintenance : provider.previewMaintenance;
        mockOf(member).mockImplementation(() => {
          reached.resolve();
          return pending.promise;
        });
        const caller = new AbortController();
        const maintenance = providerMaintenance(provider, DECLARED, caller.signal, ROUTE);
        const calling =
          facet === "run"
            ? maintenance.run("vacuum").then((outcome) => errorOf(outcome, "stopped"))
            : failure(() => maintenance.preview("release", ["orders"]));
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each call's log is its own.
        await reached.promise;
        caller.abort(new DOMException("The request went away.", "AbortError"));
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, so each call's log is its own.
        const left = await calling;
        expect(left).toBeInstanceOf(QueryCancelledError);
        expect(errorOutcome(left)).toBe("unknown");
        pending.reject(new Error(secret));
        // oxlint-disable-next-line no-await-in-loop -- the late failure is logged once the provider's promise settled.
        await pending.promise.catch(() => undefined);
        // oxlint-disable-next-line no-await-in-loop -- one turn for the late handler's reaction.
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(warned).toEqual(
        ["run", "preview"].map((facet) => [
          "A maintenance call Studio stopped waiting for failed afterwards",
          { route: ROUTE, facet, kind: "internal", code: "INTERNAL_ERROR" },
        ]),
      );
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a run the caller stopped waiting for that answers afterwards is logged by route and facet, never its text", async () => {
    const warned: unknown[][] = [];
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    const secret = marker();
    try {
      const provider = providerOf();
      const pending = Promise.withResolvers<MaintenanceResult>();
      const reached = Promise.withResolvers<void>();
      mockOf(provider.runMaintenance).mockImplementation(() => {
        reached.resolve();
        return pending.promise;
      });
      const caller = new AbortController();
      const maintenance = providerMaintenance(provider, DECLARED, caller.signal, ROUTE);
      const calling = maintenance.run("vacuum").then((outcome) => errorOf(outcome, "stopped"));
      await reached.promise;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      expect(await calling).toBeInstanceOf(QueryCancelledError);
      expect(warned).toEqual([]);

      pending.resolve({ success: true, executionTime: 1, message: secret });
      await pending.promise;
      await new Promise((resolve) => setImmediate(resolve));

      expect(warned).toEqual([
        ["A maintenance call Studio stopped waiting for answered afterwards", { route: ROUTE, facet: "run" }],
      ]);
      expect(JSON.stringify(warned)).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a caller already gone sends nothing and is answered not-sent", async () => {
    const provider = providerOf();
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));
    const maintenance = providerMaintenance(provider, DECLARED, caller.signal, ROUTE);

    const ran = errorOf(await maintenance.run("vacuum"), "not-sent");
    const previewed = await failure(() => maintenance.preview("release", ["orders"]));

    for (const error of [ran, previewed]) {
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    expect(mockOf(provider.runMaintenance)).not.toHaveBeenCalled();
    expect(mockOf(provider.previewMaintenance)).not.toHaveBeenCalled();
  });

  test("a maintenance call past its deadline answers StudioTimeoutRefusal naming the run or the preview, the statement timeout and the slack", async () => {
    const queryTimeout = 2_000;
    const provider = providerOf(queryTimeout);
    const behind = () => Date.now() - queryTimeout - EXECUTE_SLACK_MS - 1_000;
    const late = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE, behind);
    const refusedRun = errorOf(await late.run("vacuum"), "not-sent");
    const refusedPreview = await failure(() => late.preview("release", ["orders"]));
    const stopped = await withCore(
      (real) => ({
        ...real,
        maintenanceRunCall: async (): Promise<MaintenanceRunRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
        maintenancePreviewCall: async (): Promise<MaintenancePreviewRecord> => ({
          kind: "stopped",
          reason: TIMEOUT_REASON(),
          settled: Promise.resolve(),
        }),
      }),
      async () => {
        const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE);
        return [
          errorOf(await maintenance.run("vacuum"), "stopped"),
          await failure(() => maintenance.preview("release", ["orders"])),
        ];
      },
    );

    for (const [error, noun, outcome] of [
      [refusedRun, "run", "not-sent"],
      [refusedPreview, "preview", "not-sent"],
      [stopped[0], "run", "unknown"],
      [stopped[1], "preview", "unknown"],
    ] as const) {
      expect(error).toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message).toBe(deadlineSentence(noun, queryTimeout));
      expect(errorOutcome(error)).toBe(outcome);
    }
    expect(mockOf(provider.runMaintenance)).not.toHaveBeenCalled();
    expect(mockOf(provider.previewMaintenance)).not.toHaveBeenCalled();
  });

  test("a maintenance call refused for any other reason is answered as a defect of Studio's bridge, named by its rule", async () => {
    const provider = providerOf();
    const refusal = { kind: "refused", called: false, refusals: [] } as const;
    const caught = await withCore(
      (real) => ({
        ...real,
        maintenanceRunCall: async (): Promise<MaintenanceRunRecord> => ({
          ...refusal,
          refusals: [{ rule: "request-operation-not-offered", pointer: "/operation" }],
        }),
        maintenancePreviewCall: async (): Promise<MaintenancePreviewRecord> => ({
          ...refusal,
          // A rule none of the accessor's rows for a refusing package session reads (clause C-111).
          refusals: [{ rule: "request-field-empty", pointer: "/maintenance/preview", name: "maintenance.preview" }],
        }),
      }),
      async () => {
        const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE);
        return [
          errorOf(await maintenance.run("vacuum"), "not-sent"),
          await failure(() => maintenance.preview("release", ["orders"])),
        ];
      },
    );

    for (const error of caught) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(QueryCancelledError);
      expect(error).not.toBeInstanceOf(StudioTimeoutRefusal);
      expect((error as Error).message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);
    }
    expect((caught[0] as Error).message).toContain('"/operation"');
    expect((caught[1] as Error).message).toContain("maintenance.preview");
  });

  test("a maintenance call before the host core is installed fails by name and reaches no provider", async () => {
    const provider = providerOf();
    const real = hostCore();
    forgetHostCore();
    let caught: unknown[];
    let ran: MaintenanceRunOutcome;
    try {
      const maintenance = providerMaintenance(provider, DECLARED, new AbortController().signal, ROUTE);
      ran = await maintenance.run("vacuum");
      caught = [await failure(() => maintenance.preview("release", ["orders"]))];
    } finally {
      installHostCore(real, "test");
    }

    // A run answers how it ended: the error raised before the call, as not-sent.
    expect(ran.kind).toBe("not-sent");
    caught.push((ran as { readonly error: Error }).error);
    for (const error of caught) expect(error).toBeInstanceOf(HostCoreBootOrderError);
    expect(mockOf(provider.runMaintenance)).not.toHaveBeenCalled();
    expect(mockOf(provider.previewMaintenance)).not.toHaveBeenCalled();
  });
});
