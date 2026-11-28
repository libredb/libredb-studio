/**
 * The object source's caller facade (src/lib/api/object-source.ts; docs/providers/CONTRACT.md, clauses C-115 and
 * C-111): each source read is one host core source call on the session of the target its caller hands it, a legacy
 * provider's bridged session (`providerSourceTarget` in src/lib/api/session-target.ts) or any other session offering
 * `objects.source`, under a deadline of its own, the statement timeout plus ten seconds from that read's start, and the
 * caller's signal, and answers the document the core checked and cut.
 *
 * The real host core is installed for the file; a case that reads what the core was handed installs a core of its own
 * around the real one and restores it. A deadline is passed by the clock and a stop by an aborted signal, every double
 * signals when the read reaches it, and no assertion follows a timer.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallContext,
  envReader,
  type ObjectSourceDocument,
  SOURCE_CHARACTER_LIMIT,
  type SourceRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls, ObjectModel } from "@libredb/provider-sdk/manifest";
import { EXECUTE_SLACK_MS } from "@/lib/api/editor-query";
import { objectSource, sourceModel } from "@/lib/api/object-source";
import { type CallEnd, providerSourceTarget, type SessionTarget } from "@/lib/api/session-target";
import { errorCode, errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  QueryCancelledError,
  QueryError,
  StudioObjectModelRefusal,
  StudioTimeoutRefusal,
  waitedSeconds,
} from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HostDefectError } from "@/lib/provider-host/access";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
import { forgetHostCore, HostCoreBootOrderError, hostCore, installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseConnection } from "@/lib/types";
import { createMockProvider } from "../../../helpers/mock-provider";

beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

const ROUTE = "object-source-test";
const marker = (): string => randomUUID();

/** A session's calls with `objects.source` offered unless told otherwise. */
function callsOf(source = true): Calls {
  return {
    console: { execute: { honours: [] }, cancel: "not-offered", endScope: "not-offered", transaction: "not-offered" },
    objects: { tree: "not-offered", source: source ? "offered" : "not-offered" },
    maintenance: { run: "not-offered", preview: "not-offered" },
    monitoring: { panel: "not-offered", poolStats: "not-offered" },
  };
}

/** An object model of one container level and the one kind `routine`, with source. */
const MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "routine",
      role: "routine",
      label: "Routine",
      labelPlural: "Routines",
      hasSource: true,
      sourceLanguage: "sql",
      hasColumns: false,
      acceptsSourceEdits: false,
      childKinds: [],
      attachedTo: null,
      acceptsRowWrites: false,
      enumeratedBy: null,
      countIsListing: false,
      machineNames: null,
      group: null,
    },
  ],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: false,
  agentWalkScope: null,
  schemaDiffScope: null,
  maskedNameKinds: [],
};

/** The document a read of `request` answers: its path and kind, and one readable part of `text`. */
function documentOf(request: SourceRequest, text = marker()): ObjectSourceDocument {
  return {
    path: request.path,
    kind: request.kind,
    parts: [{ id: "definition", label: "Definition", text, language: "sql", form: "complete", origin: "stored" }],
  };
}

/**
 * A planted target whose session answers what `answer` gives, recording each call and each mark; `timeout` is its
 * statement timeout, and `reached` resolves when a read reaches the session.
 */
function targetOf(
  answer: (request: SourceRequest, ctx: CallContext) => Promise<ObjectSourceDocument> = async (request) =>
    documentOf(request),
  timeout = 4_000,
) {
  const reads: { readonly request: SourceRequest; readonly ctx: CallContext }[] = [];
  const marks: (string | CallEnd)[] = [];
  const reached = Promise.withResolvers<void>();
  const env = envReader([], () => undefined);
  const target: SessionTarget<ObjectsSession> = {
    session: {
      calls: callsOf(),
      objectModel: MODEL,
      source: (request, ctx) => {
        reads.push({ request, ctx });
        reached.resolve();
        return answer(request, ctx);
      },
    },
    env,
    timeout: () => timeout,
    started: () => {
      marks.push("started");
    },
    ended: (record) => {
      marks.push(record);
    },
  };
  return { target, reads, marks, env, reached: reached.promise };
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

/** The deadline sentence of a source read on a target whose statement timeout is `timeout`. */
const deadlineSentence = (timeout: number) =>
  `The source read did not answer within the statement timeout of ${waitedSeconds(timeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`;

/** A mock provider that reads source, whose statement timeout is `queryTimeout`. */
function readingProvider(queryTimeout?: number) {
  const readObjectSource = mock(async (path: readonly string[], kind: string) => documentOf({ path: [...path], kind }));
  const provider = createMockProvider({
    config: { id: "c1", name: "Prod", type: "postgres", host: "h", queryTimeout } as DatabaseConnection,
    capabilities: {
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
      objectKinds: [
        {
          id: "routine",
          role: "routine",
          label: "Routine",
          labelPlural: "Routines",
          hasSource: true,
          sourceLanguage: "sql",
        },
      ],
    },
  });
  return { provider: Object.assign(provider, { readObjectSource }) as DatabaseProvider, readObjectSource };
}

describe("objectSource", () => {
  test("the source facade reads any session the target states through the host core, under its environment and timeout, counting each read on the target", async () => {
    const fx = targetOf();
    const seen: { session: unknown; request: SourceRequest; ctx: CallContext }[] = [];
    const now = Date.now();
    const path = [marker(), marker()];

    const document = await withCore(
      (real) => ({
        ...real,
        sourceCall: (session, request, ctx, ports) => {
          seen.push({ session, request, ctx });
          return real.sourceCall(session, request, ctx, ports);
        },
      }),
      () => objectSource(fx.target, new AbortController().signal, ROUTE, () => Date.now()).read(path, "routine"),
    );

    expect(document).toEqual(documentOf({ path, kind: "routine" }, (document.parts[0] as { text: string }).text));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.session).toBe(fx.target.session);
    // A fresh request, so the core freezes nothing the caller holds.
    expect(seen[0]?.request).toEqual({ path, kind: "routine" });
    expect(seen[0]?.request.path).not.toBe(path);
    expect(Object.isFrozen(path)).toBe(false);
    expect(seen[0]?.ctx.env).toBe(fx.env);
    expect(fx.marks).toEqual(["started", expect.objectContaining({ kind: "answered" })]);

    // The deadline is the read's own: the clock at its start, plus the target's timeout and the slack.
    const stamped = targetOf();
    const deadlines: number[] = [];
    await withCore(
      (real) => ({
        ...real,
        sourceCall: (session, request, ctx, ports) => {
          deadlines.push(ctx.deadline);
          return real.sourceCall(session, request, ctx, ports);
        },
      }),
      () => objectSource(stamped.target, new AbortController().signal, ROUTE, () => now).read([marker()], "routine"),
    );
    expect(deadlines).toEqual([now + 4_000 + EXECUTE_SLACK_MS]);

    // A legacy provider's target: one bridged session, its statement timeout, the bound the source route passes.
    const { provider, readObjectSource } = readingProvider(7_000);
    const target = providerSourceTarget(provider);
    expect(target.timeout()).toBe(7_000);
    expect(() => target.env.get("PATH")).toThrow();
    target.started();
    target.ended(undefined);
    const bridged = await objectSource(target, new AbortController().signal, ROUTE).read(["app", "f"], "routine");
    expect(bridged.path).toEqual(["app", "f"]);
    expect(readObjectSource.mock.calls as unknown[]).toEqual([[["app", "f"], "routine", SOURCE_CHARACTER_LIMIT]]);
    expect(sourceModel(target.session)).toBe(target.session.objectModel as ObjectModel);
  });

  test("providerSourceTarget builds one bridged session of the provider with no environment and no marks, its timeout the provider's", () => {
    const { provider } = readingProvider();
    const target = providerSourceTarget(provider);

    expect(target.session.calls.objects.source).toBe("offered");
    expect(typeof target.session.source).toBe("function");
    expect(target.session.objectModel?.objectKinds.map((kind) => kind.id)).toEqual(["routine"]);
    expect(target.timeout()).toBe(60_000);
    expect(target.started()).toBeUndefined();
    expect(target.ended({ kind: "answered" })).toBeUndefined();
    // A provider without the method is bridged too, its session offering no source.
    expect(providerSourceTarget(createMockProvider()).session.calls.objects.source).toBe("not-offered");
  });

  test("a source read past its deadline, left by its caller, refused by the model or answered malformed answers Studio's errors, and a later failure is logged by route, kind and code, never its text", async () => {
    // A deadline already passed at the read's start: the source sentence, not-sent, the session never called.
    const late = targetOf(undefined, 2_000);
    const timedOut = await failure(() =>
      objectSource(late.target, new AbortController().signal, ROUTE, () => Date.now() - 3_600_000).read(
        [marker()],
        "routine",
      ),
    );
    expect(timedOut).toBeInstanceOf(StudioTimeoutRefusal);
    expect((timedOut as Error).message).toBe(deadlineSentence(2_000));
    expect(errorOutcome(timedOut)).toBe("not-sent");
    expect(late.reads).toEqual([]);

    // A caller that already left.
    const left = new AbortController();
    left.abort(new Error(marker()));
    const cancelled = await failure(() =>
      objectSource(targetOf().target, left.signal, ROUTE).read([marker()], "routine"),
    );
    expect(cancelled).toBeInstanceOf(QueryCancelledError);

    // A path deeper than the model admits: Studio's model refusal, not-sent, before any call.
    const deep = targetOf();
    const refused = await failure(() =>
      objectSource(deep.target, new AbortController().signal, ROUTE).read([marker(), marker(), marker()], "routine"),
    );
    expect(refused).toBeInstanceOf(StudioObjectModelRefusal);
    expect(errorOutcome(refused)).toBe("not-sent");
    expect(deep.reads).toEqual([]);

    // A malformed answer: the host defect naming the rule, never a value of the answer.
    const planted = marker();
    const malformed = await failure(() =>
      objectSource(
        targetOf(async (request) => ({ ...documentOf(request), kind: planted })).target,
        new AbortController().signal,
        ROUTE,
      ).read([marker()], "routine"),
    );
    expect(malformed).toBeInstanceOf(HostDefectError);
    expect((malformed as HostDefectError).refusals).toEqual([{ rule: "source-answer-unreadable", pointer: "/kind" }]);
    expect((malformed as Error).message).not.toContain(planted);

    // A read the caller stops waiting for: cancelled at once, counted until it settled, its later failure logged.
    const failing = Promise.withResolvers<ObjectSourceDocument>();
    const stopped = targetOf(() => failing.promise);
    const caller = new AbortController();
    const logged = Promise.withResolvers<void>();
    const warn = spyOn(logger, "warn").mockImplementation(() => {
      logged.resolve();
    });
    try {
      const running = failure(() => objectSource(stopped.target, caller.signal, ROUTE).read([marker()], "routine"));
      await stopped.reached;
      caller.abort(new Error(marker()));
      expect(await running).toBeInstanceOf(QueryCancelledError);
      const secret = marker();
      const thrown = new QueryError(secret);
      failing.reject(thrown);
      await logged.promise;
      expect(warn.mock.calls).toEqual([
        [
          "A source read Studio stopped waiting for failed afterwards",
          { route: ROUTE, objectKind: "routine", kind: errorKind(thrown), code: errorCode(thrown) },
        ],
      ]);
      expect(errorKind(thrown)).not.toBe("internal");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      expect(stopped.marks).toEqual(["started", expect.objectContaining({ kind: "stopped" })]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a source read before the host core is installed fails by name and sends the session no source call", async () => {
    const fx = targetOf();
    const real = hostCore();
    forgetHostCore();
    let caught: unknown;
    try {
      caught = await failure(() =>
        objectSource(fx.target, new AbortController().signal, ROUTE).read([marker()], "routine"),
      );
    } finally {
      installHostCore(real, "test");
    }

    expect(caught).toBeInstanceOf(HostCoreBootOrderError);
    expect(fx.reads).toEqual([]);
    expect(fx.marks).toEqual([]);
  });

  test("sourceModel answers the session's object model, and a session that states none is a host defect, named", () => {
    const fx = targetOf();
    expect(sourceModel(fx.target.session)).toBe(MODEL);
    const unmodelled: ObjectsSession = { calls: callsOf() };
    expect(() => sourceModel(unmodelled)).toThrow(
      "The session offers objects.source and states no object model, a defect of the host's session.",
    );
  });
});
