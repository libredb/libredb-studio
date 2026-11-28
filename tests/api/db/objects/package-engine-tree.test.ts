/**
 * The object tree's routes and the other object routes on an engine an admitted provider package serves, through the
 * real `resolveServedConnection`, the provider factory's real metadata cache, the real host core and the real tree
 * facade (docs/providers/CONTRACT.md, clauses C-66, C-107, C-111 and C-112): each tree route answers the package's tree
 * on the record's metadata session, opened once per key through the package; a level or a kind its object model does not
 * state is refused before the package is called; a code-only package's sentences in a tree answer reach the client as
 * Studio's sentence and a granted one's through core's scrub; an open failure answers not-sent, and a malformed tree
 * answer the package's defect; the target a tree route is handed keeps every function its session offers, the source
 * read among them; a session that offers no tree is refused by its offer, and the edit plan, the edit apply and the key
 * scan by the record's offer before any open, none of them as the route-level 501.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Paths are built with `path.join` by the fixture, no file mode, link or line ending is read, and nothing awaits a
 * timer, so every platform reaches the same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallRefusal, callRefusalSentence, type TreeRequest } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { handleObjectRequest } from "@/lib/api/object-route";
import { objectTree } from "@/lib/api/object-tree";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PACKAGE_SENTENCE_WITHHELD, PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../../helpers/provider-artifacts";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin", iat: 1_700_000_000 })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin", iat: 1_700_000_000 },
  })),
}));

/** Each route under test, by its path under /api/db. */
const ROUTES: Readonly<Record<string, { POST: (req: never) => Promise<Response> }>> = {
  "objects/containers": await import("@/app/api/db/objects/containers/route"),
  "objects/counts": await import("@/app/api/db/objects/counts/route"),
  "objects/list": await import("@/app/api/db/objects/list/route"),
  "objects/describe": await import("@/app/api/db/objects/describe/route"),
  "objects/inventory": await import("@/app/api/db/objects/inventory/route"),
  "objects/search": await import("@/app/api/db/objects/search/route"),
  "objects/edit-plan": await import("@/app/api/db/objects/edit-plan/route"),
  "objects/edit-apply": await import("@/app/api/db/objects/edit-apply/route"),
  "keys/scan": await import("@/app/api/db/keys/scan/route"),
};
const factory = await import("@/lib/db/factory");

/** A tree with one container level and one kind of objects with columns: names no engine of Studio's. */
const TREE_MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "item",
      role: "relation",
      label: "Item",
      labelPlural: "Items",
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

/** `TREE_MODEL` with its one kind stating source, for a package that offers the source read too. */
const SOURCE_MODEL: ObjectModel = {
  ...TREE_MODEL,
  objectKinds: TREE_MODEL.objectKinds.map((kind) => ({ ...kind, hasSource: true, sourceLanguage: "sql" })),
};

/**
 * A package offering the tree, granted no words; one granted its words; one offering no tree; one offering the tree and
 * the source read.
 */
const TREE = "acmetreeroute";
const WORDS = "acmetreewords";
const BARE = "acmetreebare";
const SOURCE = "acmetreesource";
const withTree = {
  offered: ["objects.tree"],
  edit: (engine: Record<string, unknown>) => (engine.objects = structuredClone(TREE_MODEL) as never),
};
const providers = scratchDirectory("studio-package-engine-tree-");

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-tree-route", engine: TREE, ...withTree },
      { name: "acme-tree-words", engine: WORDS, ...withTree },
      { name: "acme-tree-bare", engine: BARE },
      {
        name: "acme-tree-source",
        engine: SOURCE,
        offered: ["objects.tree", "objects.source"],
        edit: (engine: Record<string, unknown>) => (engine.objects = structuredClone(SOURCE_MODEL) as never),
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

/** The answer a tree hook gives each action unless a case gives its own. */
function answerOf(request: TreeRequest): unknown {
  switch (request.action) {
    case "containers":
      return { containers: [{ path: ["s1"], name: "s1", level: 0, isSessionDefault: true }] };
    case "count":
      return { counts: { item: { count: 3 } } };
    case "list":
      return { objects: [{ path: [...request.container, "thing"], name: "thing", kind: "item" }] };
    case "describe":
      return { detail: { path: request.path, columns: [], indexes: [], foreignKeys: [] } };
    case "describeMany":
      return { details: [] };
  }
}

/** Hooks for `engine`'s package that open a fresh handle, close, and answer each tree request with `tree`. */
function hooksFor(
  engine: string,
  options: { open?: () => Promise<unknown>; tree?: (request: TreeRequest) => Promise<unknown> } = {},
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
    tree: push("tree", (_handle, request) =>
      (options.tree ?? ((asked: TreeRequest) => Promise.resolve(answerOf(asked))))(request as TreeRequest),
    ),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string): Record<string, unknown> {
  return { id: `conn-${randomUUID()}`, name: "Tree", type: engine, host: "tree.local", password: randomUUID() };
}

/** The status and body `route` answers for `body`. */
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const handler = ROUTES[route] as { POST: (req: never) => Promise<Response> };
  const response = await handler.POST(
    new Request(`http://localhost:3000/api/db/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<unknown>(response) };
}

/** Each tree route's body for `connection`, and what it answers from `answerOf`'s answers. */
function treeRequests(connection: Record<string, unknown>): [string, Record<string, unknown>, unknown][] {
  const thing = { path: ["s1", "thing"], name: "thing", kind: "item" };
  return [
    ["objects/containers", { connection }, [{ path: ["s1"], name: "s1", level: 0, isSessionDefault: true }]],
    ["objects/counts", { connection, container: ["s1"] }, { item: { count: 3 } }],
    ["objects/list", { connection, container: ["s1"], kind: "item" }, [thing]],
    [
      "objects/describe",
      { connection, path: ["s1", "thing"], kind: "item" },
      { path: ["s1", "thing"], columns: [], indexes: [], foreignKeys: [] },
    ],
    ["objects/inventory", { connection }, { objects: [thing], defaultContainer: ["s1"] }],
    ["objects/search", { connection, term: "THI" }, [thing]],
  ];
}

describe("the object tree's routes on a provider package's engine", () => {
  test("each tree route answers a package engine's tree through its package", async () => {
    const connection = connectionOf(TREE);
    const seen = hooksFor(TREE);
    for (const [route, body, answered] of treeRequests(connection)) {
      expect([route, await post(route, body)]).toEqual([route, { status: 200, body: answered }]);
    }
    // One metadata session, opened once through the package, read for every route; the editor's is never opened.
    expect(names(seen).filter((name) => name === "open")).toEqual(["open"]);
    expect(factory.getProviderCacheStats().connections).not.toContain(connection.id);
    // Each request reaches the package as the action its route reads, the walks' listings among them.
    const actions = seen.calls.filter(({ name }) => name === "tree").map(({ args }) => (args[1] as TreeRequest).action);
    expect(actions).toEqual(["containers", "count", "list", "describe", "containers", "list", "containers", "list"]);

    // A read in flight counts on the entry, so the idle sweep keeps the session the read runs on.
    let swept = -1;
    hooksFor(TREE, {
      tree: async (request) => {
        swept = await factory.evictIdleProviders(0);
        return answerOf(request);
      },
    });
    const info = spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      expect((await post("objects/counts", { connection, container: ["s1"] })).status).toBe(200);
    } finally {
      info.mockRestore();
    }
    expect(swept).toBe(0);

    // A kind or a level the model does not state is refused by name, not-sent, and the package is not called.
    const refused = hooksFor(TREE);
    const unstated = await post("objects/list", { connection, container: ["s1"], kind: "table" });
    expect(unstated.status).toBe(400);
    expect(unstated.body).toMatchObject({ outcome: "not-sent" });
    expect((unstated.body as { error: string }).error).toBe(
      "The request names an object kind this connection's object model does not state, so Studio did not call the provider.",
    );
    const deep = await post("objects/containers", { connection, parent: ["s1", "deeper"] });
    expect(deep.status).toBe(400);
    expect(deep.body).toEqual({
      error: `${TREE} declares a container depth of 1, and "parent" has 2 segments: ["s1","deeper"]`,
      outcome: "not-sent",
    });
    expect(names(refused)).toEqual([]);
  });

  test("a code-only package's sentences in a tree answer reach the client as Studio's sentence, and a granted one's through core's scrub", async () => {
    const sentences = (password: unknown) => {
      const own = `the folder is busy ${randomUUID()}`;
      const secret = `refused for ${String(password)}`;
      return { own, secret };
    };
    for (const engine of [TREE, WORDS]) {
      const connection = connectionOf(engine);
      const { own, secret } = sentences(connection.password);
      hooksFor(engine, {
        tree: async (request) => {
          if (request.action === "count") {
            return { counts: { item: { unavailable: own }, other: { count: 2, sampledFrom: secret } } };
          }
          if (request.action === "describe") {
            return { detail: { path: request.path, columns: [], indexes: { unavailable: own }, foreignKeys: [] } };
          }
          if (request.action === "describeMany") {
            return {
              details: [{ path: ["s1", "thing"], columns: [], indexes: { unavailable: secret }, foreignKeys: [] }],
              truncated: { limit: 1, reason: own },
            };
          }
          return answerOf(request);
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const granted = engine === WORDS;
        const ownAnswer = granted ? own : PACKAGE_SENTENCE_WITHHELD;
        const secretAnswer = granted ? PROVIDER_TEXT_WITHHELD : PACKAGE_SENTENCE_WITHHELD;
        expect(await post("objects/counts", { connection, container: ["s1"] })).toEqual({
          status: 200,
          body: { item: { unavailable: ownAnswer }, other: { count: 2, sampledFrom: secretAnswer } },
        });
        expect((await post("objects/describe", { connection, path: ["s1", "thing"], kind: "item" })).body).toEqual({
          path: ["s1", "thing"],
          columns: [],
          indexes: { unavailable: ownAnswer },
          foreignKeys: [],
        });
        const inventory = await post("objects/inventory", { connection, includeColumns: true });
        expect(inventory.body).toMatchObject({
          details: [{ path: ["s1", "thing"], indexes: { unavailable: secretAnswer } }],
          truncated: { limit: 1, reason: ownAnswer },
        });
        // Where no row grants the words, each is logged once under its route, through core's scrub.
        const logged = warn.mock.calls.filter(([line]) => line === "A provider package's answer gave a reason");
        expect(logged.map(([, payload]) => payload)).toEqual(
          granted
            ? []
            : [
                { route: "api/db/objects/counts", reason: own },
                { route: "api/db/objects/counts", reason: PROVIDER_TEXT_WITHHELD },
                { route: "api/db/objects/describe", reason: own },
                { route: "api/db/objects/inventory", reason: PROVIDER_TEXT_WITHHELD },
                { route: "api/db/objects/inventory", reason: own },
              ],
        );
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("a tree route answers a package's open failure as not-sent and a malformed tree answer as the package's defect", async () => {
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      for (const engine of [TREE, WORDS]) {
        // The open fails in the package's own words: a not-sent connection error, its words only where granted.
        const words = `the tree server is away ${randomUUID()}`;
        hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
        const opened = await post("objects/containers", { connection: connectionOf(engine) });
        expect(opened.status).toBe(503);
        expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
        const sentence = (opened.body as { error: string }).error;
        if (engine === WORDS) expect(sentence).toBe(words);
        else
          expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);

        // A tree answer outside its action's form: the package's defect, 500, logged once with the prefix.
        error.mockClear();
        hooksFor(engine, { tree: () => Promise.resolve({ containers: "none" }) });
        const malformed = await post("objects/containers", { connection: connectionOf(engine) });
        expect(malformed.status).toBe(500);
        const refusal: CallRefusal = { rule: "tree-answer-unreadable", pointer: "/containers" };
        expect((malformed.body as { error: string }).error).toBe(
          engine === WORDS
            ? `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(refusal)}`
            : `${PACKAGE_DEFECT_PREFIX} it broke the rule tree-answer-unreadable; the server's log names where.`,
        );
        const defects = error.mock.calls.filter(([line]) => line === "A provider package's tree read failed");
        expect(defects).toHaveLength(1);
        expect((defects[0]?.[1] as Error | undefined)?.message).toBe(
          `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(refusal)}`,
        );
        expect(error).toHaveBeenCalledTimes(1);

        // A package's own error of a tree read: Studio's sentence naming its code, or its words where granted.
        error.mockClear();
        const own = `the walk failed ${randomUUID()}`;
        hooksFor(engine, { tree: () => Promise.reject(new Error(own)) });
        const failed = await post("objects/containers", { connection: connectionOf(engine) });
        expect(failed.status).toBe(500);
        const answered = (failed.body as { error: string }).error;
        if (engine === WORDS) expect(answered).toBe(own);
        else
          expect(answered).toMatch(
            /^The provider package's tree read failed \(.+\); the server's log holds its words\.$/,
          );
        expect(error.mock.calls.filter(([line]) => line === "A provider package's tree read failed")).toHaveLength(1);
      }
    } finally {
      error.mockRestore();
    }
  });

  test("a Studio error after a package engine's open is answered and logged as Studio's own, never as the package's", async () => {
    const seen = hooksFor(TREE);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      // The route's run hands the facade the opened session as stating no object model: a defect of Studio's host
      // session, raised by `objectTree` after the open and before any tree call of the package's.
      const answer = await handleObjectRequest(
        new Request("http://localhost:3000/api/db/objects/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connection: connectionOf(TREE) }),
        }) as never,
        "api/db/objects/probe",
        async (tree) =>
          objectTree(
            { ...tree, session: { ...tree.session, objectModel: undefined } },
            new AbortController().signal,
            "api/db/objects/probe",
          ).objectModel,
        { reads: "tree" },
      );
      expect(answer.status).toBe(500);
      expect(await parseResponseJSON<unknown>(answer)).toEqual({
        error: "The session offers objects.tree and states no object model, a defect of the host's session.",
        code: "INTERNAL_ERROR",
        statusCode: 500,
      });
      expect(error.mock.calls.map(([line]) => line)).toEqual(["Unhandled error"]);
    } finally {
      error.mockRestore();
    }
    expect(names(seen)).toEqual(["open"]);
  });

  test("the tree arm hands a route every member its session offers, the source read among them, and answers a value it raised as the package's", async () => {
    // ObjectsSession holds `source` exactly when the session offers objects.source, so the target the tree arm hands a
    // route keeps it, recording what it raised as the tree function's raises are recorded (`recordingRaised`).
    const own = `the source read failed ${randomUUID()}`;
    hooksFor(TREE);
    setHooks(SOURCE, {
      open: () => Promise.resolve({ handle: { session: randomUUID() } }),
      close: () => Promise.resolve(),
      source: () => Promise.reject(new Error(own)),
    });
    const members: Record<string, boolean> = {};
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const probe = (engine: string) =>
        handleObjectRequest(
          new Request("http://localhost:3000/api/db/objects/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ connection: connectionOf(engine) }),
          }) as never,
          "api/db/objects/probe",
          async (tree) => {
            members[engine] = Object.hasOwn(tree.session, "source");
            const source = tree.session.source;
            if (source === undefined) return { source: "not-offered" };
            return source.call(tree.session, { path: ["s1", "thing"], kind: "item" }, {} as never);
          },
          { reads: "tree" },
        );
      const offered = await probe(SOURCE);
      expect(await probe(TREE).then((answer) => parseResponseJSON<unknown>(answer))).toEqual({
        source: "not-offered",
      });
      expect(members).toEqual({ [SOURCE]: true, [TREE]: false });
      // The package's own error, answered by the record in Studio's sentence naming its code, and logged once.
      expect(offered.status).toBe(500);
      expect((await parseResponseJSON<{ error: string }>(offered)).error).toMatch(
        /^The provider package's tree read failed \(.+\); the server's log holds its words\.$/,
      );
      expect(error.mock.calls.filter(([line]) => line === "A provider package's tree read failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("a package engine whose session does not offer objects.tree is refused by the session's offer, not 501", async () => {
    const connection = connectionOf(BARE);
    const seen = hooksFor(BARE);
    for (const [route, body] of treeRequests(connection)) {
      const answer = await post(route, body);
      expect([route, answer.status]).toEqual([route, 400]);
      expect([route, answer.body]).toEqual([
        route,
        expect.objectContaining({
          error: "This connection's provider package does not offer objects.tree, so Studio did not call it.",
          code: "FACET_NOT_OFFERED",
          outcome: "not-sent",
        }),
      ]);
    }
    // The session is opened, once, and then refused by its offer; no tree call is made.
    expect(names(seen)).toEqual(["open"]);
  });

  test("the edit plan, the edit apply and the key scan refuse a package engine by the record's offer before any open", async () => {
    const connection = connectionOf(TREE);
    const seen = hooksFor(TREE);
    const requests: [string, Record<string, unknown>, string][] = [
      [
        "objects/edit-plan",
        { connection, path: ["s1", "thing"], kind: "item", partId: "p", text: "x" },
        "object edit plan",
      ],
      ["objects/edit-apply", { connection, plan: {}, planToken: "t" }, "object edit"],
      ["keys/scan", { connection, pattern: "*" }, "key scan"],
    ];
    for (const [route, body, noun] of requests) {
      const answer = await post(route, body);
      expect([route, answer.status, answer.body]).toEqual([
        route,
        400,
        expect.objectContaining({
          error: `This connection's engine offers no ${noun} in this LibreDB Studio, so Studio opened nothing.`,
          code: "FACET_NOT_OFFERED",
          outcome: "not-sent",
        }),
      ]);
    }
    expect(names(seen)).toEqual([]);
  });
});
