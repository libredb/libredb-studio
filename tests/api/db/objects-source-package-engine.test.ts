/**
 * The object source route on an engine an admitted provider package serves, through the real `resolveServedConnection`,
 * the provider factory's real editor cache, the real host core and the real source facade (docs/providers/CONTRACT.md,
 * clauses C-107, C-111, C-112 and C-115): the route answers the package's source document on the record's editor
 * session, opened once per key through the package; a kind its object model states without source, or does not state,
 * and a path deeper than the model admits are refused before the package is called; a package that does not offer
 * `objects.source` is refused by the record's offer before any open, and one whose open withdraws it by the session's
 * offer after the open, never as the route-level 501; a code-only package's sentences in a source document reach the
 * client as Studio's sentence and a granted one's through core's scrub, Studio's own bound sentence kept; a package's
 * document offers no edit, since its record offers no object edit; an open failure answers not-sent, a malformed
 * source answer the package's defect and the package's own error a source read; a Studio error after the open is
 * Studio's own.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Paths are built with `path.join` by the fixture, no file mode, link or line ending is read, and nothing awaits a
 * timer, so every platform reaches the same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CallRefusal,
  callRefusalSentence,
  type ObjectSourceDocument,
  SOURCE_CHARACTER_LIMIT,
  type SourceRequest,
  sourceBoundTruncationReason,
} from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { handleObjectRequest } from "@/lib/api/object-route";
import { sourceModel } from "@/lib/api/object-source";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PACKAGE_SENTENCE_WITHHELD, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin", iat: 1_700_000_000 })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin", iat: 1_700_000_000 },
  })),
}));

const sourceRoute = await import("@/app/api/db/objects/source/route");
const factory = await import("@/lib/db/factory");

/** One object kind of the model below, by its id, its source and whether its source may be edited. */
function kindOf(id: string, hasSource: boolean): ObjectModel["objectKinds"][number] {
  return {
    id,
    role: "relation",
    label: id,
    labelPlural: `${id}s`,
    hasSource,
    sourceLanguage: hasSource ? "sql" : null,
    hasColumns: true,
    acceptsSourceEdits: hasSource,
    childKinds: [],
    attachedTo: null,
    acceptsRowWrites: false,
    enumeratedBy: null,
    countIsListing: false,
    machineNames: null,
    group: null,
  };
}

/** A tree with one container level, a kind with source whose source may be edited, and a kind without source. */
const SOURCE_MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [kindOf("item", true), kindOf("plain", false)],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: false,
  agentWalkScope: null,
  schemaDiffScope: null,
  maskedNameKinds: [],
};

/** `SOURCE_MODEL` with no kind stating source, for a package that offers the tree alone. */
const TREE_MODEL: ObjectModel = { ...SOURCE_MODEL, objectKinds: [kindOf("item", false)] };

/**
 * A package offering the tree and the source read, granted no words; the same granted its words; one offering the tree
 * alone. Each names no engine of Studio's.
 */
const SOURCE = "acmesource";
const WORDS = "acmesourcewords";
const BARE = "acmesourcebare";
const withSource = {
  offered: ["objects.tree", "objects.source"],
  edit: (engine: Record<string, unknown>) => (engine.objects = structuredClone(SOURCE_MODEL) as never),
};
const providers = scratchDirectory("studio-package-engine-source-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-source", engine: SOURCE, ...withSource },
      { name: "acme-source-words", engine: WORDS, ...withSource },
      {
        name: "acme-source-bare",
        engine: BARE,
        offered: ["objects.tree"],
        edit: (engine: Record<string, unknown>) => (engine.objects = structuredClone(TREE_MODEL) as never),
      },
    ],
    { [WORDS]: { ownWords: "scrubbed" } },
  );
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

/** What one package's hooks saw, by call name. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

/** The document a source hook answers `request` unless a case gives its own: one readable part offering an edit. */
function documentOf(request: SourceRequest): ObjectSourceDocument {
  return {
    path: request.path,
    kind: request.kind,
    parts: [
      {
        id: "definition",
        label: "Definition",
        text: "SELECT 1",
        language: "sql",
        form: "complete",
        origin: "stored",
        edit: { offered: true },
      },
    ],
  };
}

/** Hooks for `engine`'s package that open a fresh handle, close, and answer each source request with `source`. */
function hooksFor(
  engine: string,
  options: { open?: () => Promise<unknown>; source?: (request: SourceRequest) => Promise<unknown> } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } }))),
    close: push("close", () => Promise.resolve()),
    source: push("source", (_handle, request) =>
      (options.source ?? ((asked: SourceRequest) => Promise.resolve(documentOf(asked))))(request as SourceRequest),
    ),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string): { readonly id: string } & Record<string, unknown> {
  return { id: `conn-${randomUUID()}`, name: "Source", type: engine, host: "source.local", password: randomUUID() };
}

/** The status and body the source route answers for `body`. */
async function post(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const response = await sourceRoute.POST(
    new Request("http://localhost:3000/api/db/objects/source", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<unknown>(response) };
}

describe("the object source route on a provider package's engine", () => {
  test("the source route answers a package engine's source through its package", async () => {
    const connection = connectionOf(SOURCE);
    const handle = { session: randomUUID() };
    const seen = hooksFor(SOURCE, { open: () => Promise.resolve({ handle }) });
    const path = ["s1", "thing"];
    const answered = await post({ connection, path, kind: "item" });
    // The package's document, its offer of an edit withdrawn: the record offers no object edit.
    const readable = { id: "definition", label: "Definition", text: "SELECT 1", language: "sql" };
    expect(answered).toEqual({
      status: 200,
      body: { path, kind: "item", parts: [{ ...readable, form: "complete", origin: "stored" }] },
    });
    expect(documentOf({ path, kind: "item" }).parts[0]).toMatchObject({ edit: { offered: true } });

    // The editor's session, opened once through the package; the package is handed the handle and the request.
    expect(names(seen)).toEqual(["open", "source"]);
    expect(factory.getProviderCacheStats().connections).toContain(connection.id);
    const [received, request] = seen.calls[1]?.args ?? [];
    expect(received).toEqual(handle);
    expect(request).toEqual({ path, kind: "item" });

    // A second read reuses the session.
    expect((await post({ connection, path, kind: "item" })).status).toBe(200);
    expect(names(seen)).toEqual(["open", "source", "source"]);

    // A read in flight counts on the entry, so the idle sweep keeps the session the read runs on.
    let swept = -1;
    hooksFor(SOURCE, {
      source: async (asked) => {
        swept = await factory.evictIdleProviders(0);
        return documentOf(asked);
      },
    });
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      expect((await post({ connection, path, kind: "item" })).status).toBe(200);
    } finally {
      info.mockRestore();
    }
    expect(swept).toBe(0);

    // A kind the model states without source, or does not state, is refused by name, not-sent, before any source call.
    const refused = hooksFor(SOURCE);
    for (const kind of ["plain", "table"]) {
      expect(await post({ connection, path, kind })).toEqual({
        status: 400,
        body: { error: `${SOURCE} declares no readable source for kind "${kind}"`, outcome: "not-sent" },
      });
    }
    // A path deeper than the model admits is refused by the core as Studio's object model refusal, not-sent.
    const deep = await post({ connection, path: ["s1", "deeper", "thing"], kind: "item" });
    expect(deep.status).toBe(400);
    expect(deep.body).toMatchObject({ outcome: "not-sent" });
    expect(names(refused)).toEqual([]);
  });

  test("a package engine whose session does not offer objects.source is refused by the record's offer, by name", async () => {
    const seen = hooksFor(BARE);
    const answer = await post({ connection: connectionOf(BARE), path: ["s1", "thing"], kind: "item" });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual(
      expect.objectContaining({
        error: "This connection's provider package does not offer objects.source, so Studio opened nothing.",
        code: "FACET_NOT_OFFERED",
        outcome: "not-sent",
      }),
    );
    // Refused before any open.
    expect(names(seen)).toEqual([]);
  });

  test("a refinement that withdraws objects.source is refused after the open by the session's offer, not-sent, and the package is not called", async () => {
    const seen = hooksFor(SOURCE, {
      open: () =>
        Promise.resolve({
          handle: { session: randomUUID() },
          refine: { calls: { objects: { source: "not-offered" } } },
        }),
    });
    expect(await post({ connection: connectionOf(SOURCE), path: ["s1", "thing"], kind: "item" })).toEqual({
      status: 400,
      body: { error: `${SOURCE} declares no readable source for kind "item"`, outcome: "not-sent" },
    });
    expect(names(seen)).toEqual(["open"]);
  });

  test("a code-only package's sentences in a source document reach the client as Studio's sentence, and a granted one's through core's scrub, Studio's own bound sentence kept", async () => {
    const bound = sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT);
    const long = "x".repeat(SOURCE_CHARACTER_LIMIT + 1);
    const cut = "x".repeat(SOURCE_CHARACTER_LIMIT);
    for (const engine of [SOURCE, WORDS]) {
      const connection = connectionOf(engine);
      const own = `the definition is hidden ${randomUUID()}`;
      const secret = `refused for ${String(connection.password)}`;
      const readable = { language: "sql", form: "complete", origin: "stored" } as const;
      hooksFor(engine, {
        source: async (request) => ({
          path: request.path,
          kind: request.kind,
          parts: [
            { id: "definition", label: "Definition", unavailable: own },
            { id: "grants", label: "Grants", unavailable: secret, statement: true },
            { id: "body", label: "Body", text: "SELECT", ...readable, truncated: { limit: 6, reason: own } },
            { id: "bounded", label: "Bounded", text: long, ...readable },
            { id: "joined", label: "Joined", text: long, ...readable, truncated: { limit: 9, reason: own } },
            { id: "comment", label: "Comment", text: "x", ...readable, edit: { offered: false, reason: own } },
          ],
        }),
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const granted = engine === WORDS;
        const sentence = (text: string) =>
          granted ? (text === secret ? PROVIDER_TEXT_WITHHELD : text) : PACKAGE_SENTENCE_WITHHELD;
        const answer = await post({ connection, path: ["s1", "thing"], kind: "item" });
        expect(answer.status).toBe(200);
        expect((answer.body as ObjectSourceDocument).parts).toEqual([
          { id: "definition", label: "Definition", unavailable: sentence(own) },
          { id: "grants", label: "Grants", unavailable: sentence(secret), statement: true },
          { id: "body", label: "Body", text: "SELECT", ...readable, truncated: { limit: 6, reason: sentence(own) } },
          // Studio's own cut carries Studio's own sentence on both grants.
          {
            id: "bounded",
            label: "Bounded",
            text: cut,
            ...readable,
            truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: bound },
          },
          {
            id: "joined",
            label: "Joined",
            text: cut,
            ...readable,
            truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: sentence(`${own}; ${bound}`) },
          },
          // The record offers no object edit, so a refused offer is withdrawn too, before its sentence is read.
          { id: "comment", label: "Comment", text: "x", ...readable },
        ]);
        // Where no row grants the words, each is logged once under the route, through core's scrub.
        const logged = warn.mock.calls.filter(([line]) => line === "A provider package's answer gave a reason");
        expect(logged.map(([, payload]) => payload)).toEqual(
          granted
            ? []
            : [
                { route: "api/db/objects/source", reason: own },
                { route: "api/db/objects/source", reason: PROVIDER_TEXT_WITHHELD },
                { route: "api/db/objects/source", reason: own },
                { route: "api/db/objects/source", reason: `${own}; ${bound}` },
              ],
        );
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("the source route answers a package's open failure as not-sent, a malformed source answer as the package's defect and the package's own error as a source read, never as a tree read", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    const body = (engine: string) => ({ connection: connectionOf(engine), path: ["s1", "thing"], kind: "item" });
    try {
      for (const engine of [SOURCE, WORDS]) {
        // The open fails in the package's own words: a not-sent connection error, its words only where granted.
        const words = `the source server is away ${randomUUID()}`;
        hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
        const opened = await post(body(engine));
        expect(opened.status).toBe(503);
        expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
        const sentence = (opened.body as { error: string }).error;
        if (engine === WORDS) expect(sentence).toBe(words);
        else
          expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);

        // A source answer naming another path: the package's defect, 500, logged once as a source read.
        error.mockClear();
        hooksFor(engine, { source: (request) => Promise.resolve(documentOf({ ...request, path: ["other"] })) });
        const malformed = await post(body(engine));
        expect(malformed.status).toBe(500);
        const refusal: CallRefusal = { rule: "source-answer-unreadable", pointer: "/path" };
        expect((malformed.body as { error: string }).error).toBe(
          engine === WORDS
            ? `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(refusal)}`
            : `${PACKAGE_DEFECT_PREFIX} it broke the rule source-answer-unreadable; the server's log names where.`,
        );
        const defects = error.mock.calls.filter(([line]) => line === "A provider package's source read failed");
        expect(defects).toHaveLength(1);
        expect((defects[0]?.[1] as Error | undefined)?.message).toBe(
          `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(refusal)}`,
        );
        expect(error).toHaveBeenCalledTimes(1);

        // A package's own error of a source read: Studio's sentence naming its code, or its words where granted.
        error.mockClear();
        const own = `the definition read failed ${randomUUID()}`;
        hooksFor(engine, { source: () => Promise.reject(new Error(own)) });
        const failed = await post(body(engine));
        expect(failed.status).toBe(500);
        const answered = (failed.body as { error: string }).error;
        if (engine === WORDS) expect(answered).toBe(own);
        else
          expect(answered).toMatch(
            /^The provider package's source read failed \(.+\); the server's log holds its words\.$/,
          );
        expect(error.mock.calls.map(([line]) => line)).toEqual(["A provider package's source read failed"]);
      }
    } finally {
      error.mockRestore();
    }
  });

  test("a Studio error after a package engine's open on the source route is answered and logged as Studio's own, never as the package's", async () => {
    const seen = hooksFor(SOURCE);
    const connection = connectionOf(SOURCE);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The route's run reads the opened session as stating no object model: a defect of Studio's host session,
      // raised by `sourceModel` after the open and before any source call of the package's.
      const answer = await handleObjectRequest(
        new Request("http://localhost:3000/api/db/objects/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connection }),
        }) as never,
        "api/db/objects/probe",
        async (target) => sourceModel({ ...target.session, objectModel: undefined }),
        { reads: "source" },
      );
      expect(answer.status).toBe(500);
      expect(await parseResponseJSON<unknown>(answer)).toEqual({
        error: "The session offers objects.source and states no object model, a defect of the host's session.",
        code: "INTERNAL_ERROR",
        statusCode: 500,
      });
      expect(error.mock.calls.map(([line]) => line)).toEqual(["Unhandled error"]);
    } finally {
      error.mockRestore();
    }
    // The editor's session of the record is the one opened.
    expect(names(seen)).toEqual(["open"]);
    expect(factory.getProviderCacheStats().connections).toContain(connection.id);
  });
});
