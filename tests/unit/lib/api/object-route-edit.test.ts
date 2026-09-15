import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { ObjectRouteError, boundSourceDocument, objectRouteErrorBody, readBoundedJson } from "@/lib/api/object-route";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type { ObjectSourceDocument, ProviderCapabilities } from "@/lib/db/types";

const EDITABLE: ProviderCapabilities = {
  objectKinds: [
    {
      id: "function",
      role: "routine",
      label: "Function",
      labelPlural: "Functions",
      hasSource: true,
      sourceLanguage: "pgsql",
      acceptsSourceEdits: true,
    },
    { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "pgsql" },
  ],
} as unknown as ProviderCapabilities;

const document = (part: Record<string, unknown>, kind = "function"): ObjectSourceDocument =>
  ({ path: ["app", "f(integer)"], kind, parts: [part] }) as unknown as ObjectSourceDocument;

const READABLE = {
  id: "definition",
  label: "Definition",
  text: "CREATE ...",
  language: "pgsql",
  form: "complete",
  origin: "regenerated",
};

describe("readBoundedJson", () => {
  const request = (body: string, headers: Record<string, string> = {}): NextRequest =>
    new NextRequest("http://localhost:3000/api/db/objects/edit-plan", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  test("parses an ordinary body", async () => {
    expect(await readBoundedJson(request(JSON.stringify({ kind: "function" })), 1024)).toEqual({ kind: "function" });
  });

  test("THREE conditions the shipped arm collapses into one, each with its own true sentence", async () => {
    // `handleObjectRequest`'s own body-parse arm answers 400 "Empty request body" for a body that
    // was TRUNCATED at 10,485,760 bytes, which is one condition reported with a wrong sentence.
    // These two routes do not inherit it.
    await expect(readBoundedJson(request(""), 1024)).rejects.toThrow("this request carried no body");
    await expect(readBoundedJson(request("{not json"), 1024)).rejects.toThrow("this request body is not valid JSON");
    await expect(readBoundedJson(request(JSON.stringify({ text: "x".repeat(2048) })), 1024)).rejects.toThrow(
      "this request body is larger than",
    );
  });

  test("the bound holds WITHOUT a Content-Length, because the framework truncates a chunked body silently", async () => {
    // Counting the stream is what makes this true whether or not a length was sent. A check on the
    // header alone is satisfied by omitting the header.
    //
    // THE HARNESS ITSELF IS MEASURED, so this test is not resting on an assumption about the
    // runtime. Run on bun 1.4.2 with this repository's own `next` while this plan was repaired:
    // `new NextRequest(url, { body: <ReadableStream>, duplex: "half" })` CONSTRUCTS, the request's
    // `content-length` header is `null`, `req.body` is a real stream and reading it to completion
    // yields 4,107 bytes for the 4,096-character payload below. So the property this test claims
    // to measure, a body over the bound with NO length header, is the property it measures: it
    // does not throw at construction and it is not silently buffered into a length.
    // If the construction ever DOES throw, the test fails for the wrong reason and the repair is
    // the harness, not the bound.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"text":"${"x".repeat(4096)}"}`));
        controller.close();
      },
    });
    const chunked = new NextRequest("http://localhost:3000/api/db/objects/edit-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
      // The cast is `ConstructorParameters<typeof NextRequest>[1]` and NOT the global `RequestInit`
      // the plan wrote. MEASURED with this repository's own tsc 6.0.3: the global one declares
      // `signal?: AbortSignal | null` while `NextRequest`'s init declares `signal?: AbortSignal`,
      // so `as RequestInit & { duplex: "half" }` is error TS2345 at this call and the file does not
      // compile. The cast exists only because `duplex` is absent from the lib's own init type; the
      // runtime object is unchanged and the measurement in the comment above still describes it.
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
    await expect(readBoundedJson(chunked, 1024)).rejects.toThrow("this request body is larger than");
  });

  test("the bound is EXCLUSIVE: exactly byteLimit bytes resolves, one byte more is refused", async () => {
    // THE BOUNDARY ITSELF, which the over-limit tests above do not reach: they send 2048 and 4,107
    // bytes against a 1024 bound, so `>=` in place of `>` passes every one of them. The arithmetic
    // in `readBoundedJson`'s docblock reasons explicitly that a body AT `EDIT_BODY_BYTE_LIMIT` is
    // inside the bound, and the 413's sentence, "larger than N bytes", is FALSE of a body of
    // exactly N. Both sides are asserted because one side alone is satisfied by the wrong operator.
    //
    // THE HARNESS IS MEASURED rather than assumed: the byte length of each body is asserted before
    // it is sent, so a test that silently sent 65 bytes for the at-limit case would fail as a
    // harness error rather than pass as a bound.
    const limit = 64;
    const body = (bytes: number): string => `{"t":"${"x".repeat(bytes - 8)}"}`;
    expect(new TextEncoder().encode(body(limit)).byteLength).toBe(limit);
    expect(new TextEncoder().encode(body(limit + 1)).byteLength).toBe(limit + 1);

    expect(await readBoundedJson(request(body(limit)), limit)).toEqual({ t: "x".repeat(limit - 8) });
    await expect(readBoundedJson(request(body(limit + 1)), limit)).rejects.toThrow(
      "this request body is larger than 64 bytes",
    );
  });

  test("an EMPTY JSON object is returned rather than refused, which the default read does not do", async () => {
    // The divergence between the two body reads on one handler, pinned on this side. `readBoundedJson`
    // has three conditions and "no named fields" is not one of them: `{}` parsed, and it is a JSON
    // object, so it is answered and `resolveConnection` is what refuses it. `readDefaultBody` refuses
    // `{}` itself with `Empty request body`. The handler-level half of this pair, both answers
    // measured end to end through `handleObjectRequest`, is `tests/api/db-objects.test.ts`, under
    // `describe("the body read the handler actually performs")`.
    expect(await readBoundedJson(request("{}"), 1024)).toEqual({});
  });

  test("a body that is not a JSON OBJECT is refused rather than reaching a provider", async () => {
    await expect(readBoundedJson(request("[1,2,3]"), 1024)).rejects.toThrow("this request body is not valid JSON");
    await expect(readBoundedJson(request("null"), 1024)).rejects.toThrow("this request body is not valid JSON");
  });
});

describe("the affordance the route strips", () => {
  test("a part of an editable kind keeps the provider's offer", () => {
    const bounded = boundSourceDocument(
      document({ ...READABLE, edit: { offered: true } }),
      SOURCE_CHARACTER_LIMIT,
      EDITABLE,
    );
    expect((bounded.parts[0] as { edit?: unknown }).edit).toEqual({ offered: true });
  });

  test("a part whose KIND declares no edit loses it, however the provider answered", () => {
    // ENFORCE rather than trust, on `boundSourceDocument`'s own precedent: a number merely passed
    // to an implementation is a request and not a bound.
    const bounded = boundSourceDocument(
      document({ ...READABLE, edit: { offered: true } }, "view"),
      SOURCE_CHARACTER_LIMIT,
      EDITABLE,
    );
    expect(Object.hasOwn(bounded.parts[0], "edit")).toBe(false);
  });

  test("a REFUSAL part carrying an offer loses it", () => {
    // Representable, because the excess-property check on a union admits any property declared on
    // any member of it, so a provider spreading a conditional affordance onto a refusal would ship
    // an editable refusal. The test CONSTRUCTS the hybrid deliberately, because that is the only
    // way to reach it.
    const bounded = boundSourceDocument(
      document({ id: "definition", label: "Definition", unavailable: "no", edit: { offered: true } }),
      SOURCE_CHARACTER_LIMIT,
      EDITABLE,
    );
    expect(Object.hasOwn(bounded.parts[0], "edit")).toBe(false);
  });

  test("a part the ROUTE truncates loses it, and the ORDER is what makes that true", () => {
    // `boundPart` MARKS truncation itself when a provider over-answers, so the stripping must run
    // AFTER the bound or a route-truncated part keeps the affordance. This is the case that fails
    // if the two are swapped.
    const bounded = boundSourceDocument(
      document({ ...READABLE, text: "x".repeat(SOURCE_CHARACTER_LIMIT + 1), edit: { offered: true } }),
      SOURCE_CHARACTER_LIMIT,
      EDITABLE,
    );
    expect(Object.hasOwn(bounded.parts[0], "truncated")).toBe(true);
    expect(Object.hasOwn(bounded.parts[0], "edit")).toBe(false);
  });

  test("a part the PROVIDER already marked truncated loses it too", () => {
    const bounded = boundSourceDocument(
      document({ ...READABLE, truncated: { limit: 10, reason: "bounded by the provider" }, edit: { offered: true } }),
      SOURCE_CHARACTER_LIMIT,
      EDITABLE,
    );
    expect(Object.hasOwn(bounded.parts[0], "edit")).toBe(false);
  });
});

describe("the wire body one refusal renders as", () => {
  // ADDED to the plan's own test list, with its reason: the `code` arm of the catch in
  // `handleObjectRequest` has exactly ONE producer, `EDIT_PLAN_INVALID` raised by
  // `src/app/api/db/objects/edit-apply/route.ts`, and nothing else in this file's suite reaches it.
  // Left inline in the catch it would be a branch line coverage reports as covered because it
  // shares a line with the arm every other refusal takes. That is this epic's signature defect, a
  // guard measured by a population nothing here builds, so the population is built here instead.
  // An earlier revision of this comment said the arm had no producer anywhere, which was true
  // before the edit routes landed.
  test("a refusal with no code renders `{ error }` and does NOT carry the key", () => {
    const body = objectRouteErrorBody(new ObjectRouteError("this request carried no body", 400));
    expect(body).toEqual({ error: "this request carried no body" });
    expect(Object.hasOwn(body, "code")).toBe(false);
  });

  test("a refusal WITH a code renders both, and the code is the declared string", () => {
    const body = objectRouteErrorBody(
      new ObjectRouteError("that plan is not one this server will run", 400, ApiErrorCode.EDIT_PLAN_INVALID),
    );
    expect(body).toEqual({ error: "that plan is not one this server will run", code: "EDIT_PLAN_INVALID" });
  });

  test("the 413 the bound answers carries the status and no code", async () => {
    // The status is asserted here rather than through `.rejects.toThrow`, which reads the message
    // only: a 413 answered as a 400 would pass every sentence test above.
    const request = new NextRequest("http://localhost:3000/api/db/objects/edit-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(2048) }),
    });
    const raised = await readBoundedJson(request, 1024).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raised).toBeInstanceOf(ObjectRouteError);
    expect((raised as ObjectRouteError).status).toBe(413);
    expect((raised as ObjectRouteError).code).toBeUndefined();
  });

  test("the two 400 conditions are 400 and not the bound's status", async () => {
    for (const body of ["", "{not json", "[1,2,3]"]) {
      const request = new NextRequest("http://localhost:3000/api/db/objects/edit-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const raised = await readBoundedJson(request, 1024).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((raised as ObjectRouteError).status).toBe(400);
    }
  });
});

/**
 * The docblocks in `src/lib/api/object-route.ts` cite test files BY PATH as the evidence for the
 * claims they make, and a citation that points at nothing is worse than no citation: a reader who
 * cannot find the file concludes the claim was never measured, and a reader who does not look
 * concludes it was. This round found exactly that, twice: the fix round before it drove the two
 * body reads end to end from a file called `tests/api/object-route-handler.test.ts`, measured that
 * a second `mock.module("@/lib/db", ...)` in one process breaks `tests/api/db/profile.test.ts`,
 * DELETED that file and appended the tests to `tests/api/db-objects.test.ts`, and left both
 * docblock pointers aimed at the deleted path.
 *
 * THE POPULATION THIS RUNS OVER IS REAL AND IT IS NOT EMPTY: measured at this commit, the regex
 * below matches two citations in that one source file. If it ever matches zero the count assertion
 * fails, because a guard that certifies nothing when its population empties is the defect class
 * this phase keeps finding rather than a guard.
 *
 * Scope is ONE file on purpose. Forty-eight distinct `tests/...test.ts` paths are cited across
 * `src/` at this commit, and a repo-wide version of this check belongs to whoever owns the repo's
 * lint surface, not to this task.
 */
describe("the test files object-route.ts cites in its docblocks", () => {
  test("every cited path exists on disk", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../src/lib/api/object-route.ts"), "utf8");
    const cited = [...new Set(source.match(/tests\/[A-Za-z0-9_./-]*\.test\.ts/g) ?? [])];

    expect(cited.length).toBeGreaterThan(0);
    const missing = cited.filter((relative) => !existsSync(join(import.meta.dir, "../../../..", relative)));
    expect(missing).toEqual([]);
  });
});

/**
 * The same docblocks cite SOURCE lines as `path:line`, and that pointer rots in silence. Any
 * insertion ABOVE the cited line invalidates it, from a hand nowhere near this module, and nothing
 * in CI reads a code-comment citation. It happened inside the branch that WROTE the paragraph:
 * backlog entry DOC5 was filed because the docblock told a reader a write-path guard was missing
 * when it was two files away, the rewrite named where each half is enforced, and a later commit on
 * the same branch moved the read-definition bound twelve lines down. The paragraph went on naming
 * the old number, which by then was a comment inside a helper, so the closure re-created a smaller
 * copy of the defect it closed.
 *
 * This is the guard, and it holds every number in ONE place: the cited file itself. The table names
 * the ANCHOR rather than the line, the test greps the anchor, derives the number the docblock must
 * be writing and asserts it writes it. A correct renumbering needs no edit here, and a stale one
 * fails with the number to write.
 *
 * The last test is what keeps that honest: every `path:line` in the source must be produced by this
 * table, so a citation added later cannot slip past unguarded, and an anchor that stops being
 * unique is a failure rather than a silently arbitrary pick.
 */
type CitedSite = {
  /** The path exactly as the docblock writes it, which is relative to whatever the prose is about. */
  as: string;
  /** The same file, repo-relative, for reading. */
  file: string;
  /** The line the citation means, or the first and last line when the citation is a range. */
  anchor: string | [string, string];
};

const SRC_POSTGRES = "src/lib/db/providers/sql/postgres.ts";
const SRC_TRINO = "src/lib/db/providers/sql/trino/index.ts";
const SRC_REDIS = "src/lib/db/providers/keyvalue/redis.ts";
const SRC_EDIT_PLAN = "src/app/api/db/objects/edit-plan/route.ts";
const SRC_EDIT_APPLY = "src/app/api/db/objects/edit-apply/route.ts";

const CITED_SITES: CitedSite[] = [
  // The three producers of `edit`: the spread that attaches the affordance, one per day-one engine.
  { as: "providers/sql/postgres.ts", file: SRC_POSTGRES, anchor: "edit: routineEditAffordance(" },
  { as: "providers/sql/trino/index.ts", file: SRC_TRINO, anchor: "spec.acceptsSourceEdits === true" },
  { as: "providers/keyvalue/redis.ts", file: SRC_REDIS, anchor: "spec.acceptsSourceEdits === true" },
  // Redis states the offer-on-a-truncated-part position in prose, so the citation is a range.
  {
    as: "redis.ts",
    file: SRC_REDIS,
    anchor: [
      "IT IS OFFERED ON A TRUNCATED PART TOO",
      "and refuses `guard` when the server's bytes are longer than the read bound.",
    ],
  },
  // The write path, THE KIND: asked of the connected provider on both edit routes.
  {
    as: "src/app/api/db/objects/edit-plan/route.ts",
    file: SRC_EDIT_PLAN,
    anchor: "requireEditableKind(provider.getCapabilities(), kind,",
  },
  {
    as: "src/app/api/db/objects/edit-apply/route.ts",
    file: SRC_EDIT_APPLY,
    anchor: "requireEditableKind(provider.getCapabilities(), plan.kind,",
  },
  // The write path, THE BOUND: the submitted text, then the read definition in all three builders.
  { as: "edit-plan/route.ts", file: SRC_EDIT_PLAN, anchor: "if (text.length > EDIT_CHARACTER_LIMIT) {" },
  { as: "providers/sql/postgres.ts", file: SRC_POSTGRES, anchor: "if (definition.length > EDIT_CHARACTER_LIMIT) {" },
  { as: "providers/keyvalue/redis.ts", file: SRC_REDIS, anchor: "if (definition.length > EDIT_CHARACTER_LIMIT) {" },
  { as: "providers/sql/trino/index.ts", file: SRC_TRINO, anchor: "if (definition.length > EDIT_CHARACTER_LIMIT) {" },
];

describe("the source lines object-route.ts cites in its docblocks", () => {
  const repoRoot = join(import.meta.dir, "../../../..");
  const source = readFileSync(join(repoRoot, "src/lib/api/object-route.ts"), "utf8");
  const linesOf = (file: string, anchor: string): number[] =>
    readFileSync(join(repoRoot, file), "utf8")
      .split("\n")
      .flatMap((line, index) => (line.includes(anchor) ? [index + 1] : []));
  const anchorsOf = (site: CitedSite): string[] => (Array.isArray(site.anchor) ? site.anchor : [site.anchor]);
  const citationOf = (site: CitedSite): string =>
    `${site.as}:${anchorsOf(site)
      .map((anchor) => linesOf(site.file, anchor)[0])
      .join("-")}`;

  test("every anchor sits on exactly one line of the file that holds it", () => {
    const ambiguous = CITED_SITES.flatMap((site) =>
      anchorsOf(site)
        .filter((anchor) => linesOf(site.file, anchor).length !== 1)
        .map((anchor) => `${site.file} :: ${anchor}`),
    );
    expect(ambiguous).toEqual([]);
  });

  test("every cited line number is the line its anchor actually sits on", () => {
    const stale = CITED_SITES.map(citationOf).filter((citation) => !source.includes(citation));
    expect(stale).toEqual([]);
  });

  test("no citation escapes the table", () => {
    const cited = [...new Set(source.match(/[A-Za-z0-9_./-]+\.ts:\d+(?:-\d+)?/g) ?? [])];

    expect(cited.length).toBeGreaterThan(0);
    const unguarded = cited.filter((citation) => !CITED_SITES.some((site) => citation.startsWith(`${site.as}:`)));
    expect(unguarded).toEqual([]);
  });
});
