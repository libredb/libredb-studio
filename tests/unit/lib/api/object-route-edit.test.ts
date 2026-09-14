import { describe, expect, test } from "bun:test";
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
    // measured end to end, is `tests/api/object-route-handler.test.ts`.
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
  // ADDED to the plan's own test list, with its reason, because the `code` arm of the catch in
  // `handleObjectRequest` HAS NO PRODUCER IN THIS REPOSITORY YET: `EDIT_PLAN_INVALID` is thrown by
  // the two edit routes, which a later task owns. Left inline in the catch it would be a branch
  // this phase's suite cannot reach, which line coverage reports as covered because it shares a
  // line with the arm every existing refusal takes. That is this epic's signature defect, a guard
  // over a population nothing builds, so the population is built here instead.
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
