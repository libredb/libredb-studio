import { afterEach, describe, expect, test } from "bun:test";
import { httpSourceReader, isSourceDocumentShape } from "@/components/object-source/source-reader";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The client's shape check and the standalone reader (#789).
 *
 * `isSourceDocumentShape` is the LIVE home of the invariants the compiler cannot hold. Three
 * of the cases below are not about malformed data at all, they are about two facts collapsing
 * into one, and every one of them is reachable from a host: the embedded shell's document
 * comes from ordinary JavaScript outside our compiler, where a declared return type is not a
 * runtime guarantee.
 */

const readable = {
  id: "definition",
  label: "Definition",
  text: "SELECT 1",
  language: "sql",
  form: "complete",
  origin: "stored",
};
const document = { path: ["app", "v"], kind: "view", parts: [readable] };

describe("isSourceDocumentShape", () => {
  test("accepts a document a provider of ours would build", () => {
    expect(isSourceDocumentShape(document)).toBe(true);
  });

  test("accepts a refusal part carrying only the engine's sentence", () => {
    expect(
      isSourceDocumentShape({ ...document, parts: [{ id: "d", label: "D", unavailable: "It is wrapped." }] }),
    ).toBe(true);
  });

  test("accepts a readable part carrying a truncation mark", () => {
    expect(
      isSourceDocumentShape({
        ...document,
        parts: [{ ...readable, truncated: { limit: 10, reason: "bounded at 10 characters" } }],
      }),
    ).toBe(true);
  });

  test("accepts two parts with distinct ids, which is the Oracle package shape", () => {
    expect(isSourceDocumentShape({ ...document, parts: [readable, { ...readable, id: "body" }] })).toBe(true);
  });

  test("rejects a value that is not a record at all", () => {
    expect(isSourceDocumentShape(null)).toBe(false);
    expect(isSourceDocumentShape([document])).toBe(false);
    expect(isSourceDocumentShape("a document")).toBe(false);
  });

  test("rejects a document with no parts, because there would be nothing to draw", () => {
    expect(isSourceDocumentShape({ ...document, parts: [] })).toBe(false);
  });

  test("rejects parts that are not an array", () => {
    expect(isSourceDocumentShape({ ...document, parts: { 0: readable } })).toBe(false);
  });

  test("rejects a part that is not a record", () => {
    expect(isSourceDocumentShape({ ...document, parts: [null] })).toBe(false);
  });

  test("rejects a part carrying BOTH text and unavailable, because the text would be dropped in silence", () => {
    // `isSourcePartUnavailable` asks `"unavailable" in part`, so such a part narrows to the
    // refusal and the editor never sees the text. A host can build one; our compiler cannot,
    // and TypeScript's excess-property check on a union admits the key on either arm.
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, unavailable: "nope" }] })).toBe(false);
  });

  test("rejects a refusal with an empty sentence, which would draw our headline over a blank line", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ id: "d", label: "D", unavailable: "   " }] })).toBe(false);
  });

  test("rejects an empty text, because an empty definition is not a definition", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, text: "  " }] })).toBe(false);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, text: 7 }] })).toBe(false);
  });

  test("rejects a blank id or a blank label, which the switcher could not address or name", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, id: " " }] })).toBe(false);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, label: "" }] })).toBe(false);
  });

  test("rejects two parts sharing one id, because the switcher could not address either", () => {
    expect(isSourceDocumentShape({ ...document, parts: [readable, { ...readable, text: "SELECT 2" }] })).toBe(false);
  });

  test("rejects a blank language, because the editor would be handed nothing to resolve", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, language: " " }] })).toBe(false);
  });

  test("rejects a form or an origin outside its union", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, form: "whole" }] })).toBe(false);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, origin: "typed" }] })).toBe(false);
  });

  test("rejects a truncation mark that is not a limit and a reason", () => {
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, truncated: { limit: 10 } }] })).toBe(false);
    expect(
      isSourceDocumentShape({ ...document, parts: [{ ...readable, truncated: { limit: "10", reason: "r" } }] }),
    ).toBe(false);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, truncated: null }] })).toBe(false);
  });

  test("rejects a path that is not an array of strings", () => {
    expect(isSourceDocumentShape({ ...document, path: ["app", null] })).toBe(false);
    expect(isSourceDocumentShape({ ...document, path: "app.v" })).toBe(false);
  });

  test("rejects a kind that is not a string", () => {
    expect(isSourceDocumentShape({ ...document, kind: 7 })).toBe(false);
  });
});

const connection: DatabaseConnection = {
  id: "pg-1",
  name: "conn",
  type: "postgres",
  createdAt: new Date("2026-01-01"),
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("httpSourceReader", () => {
  test("posts the connection payload beside the address, and answers the parsed body", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify(document), { status: 200 });
    }) as unknown as typeof fetch;

    const answered = await httpSourceReader(connection, ["app", "v"], "view");

    expect(seenUrl.endsWith("/api/db/objects/source")).toBe(true);
    expect(seenBody).toEqual({
      connection: { ...connection, createdAt: connection.createdAt.toISOString() },
      path: ["app", "v"],
      kind: "view",
    });
    expect(answered).toEqual(document);
  });

  test("sends a managed connection by its seed id and never its credentials", async () => {
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify(document), { status: 200 });
    }) as unknown as typeof fetch;

    await httpSourceReader({ ...connection, managed: true, seedId: "demo", password: "hunter2" }, ["app", "v"], "view");

    expect(seenBody.connectionId).toBe("seed:demo");
    expect(seenBody.connection).toBeUndefined();
  });

  test("raises the route's own sentence when the read is refused", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Object app.v was not found." }), {
        status: 400,
      })) as unknown as typeof fetch;

    await expect(httpSourceReader(connection, ["app", "v"], "view")).rejects.toThrow("Object app.v was not found.");
  });

  test("stands the status in for a sentence when the route answered no body at all", async () => {
    globalThis.fetch = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;

    await expect(httpSourceReader(connection, ["app", "v"], "view")).rejects.toThrow(
      "The source read failed with HTTP 502",
    );
  });
});
