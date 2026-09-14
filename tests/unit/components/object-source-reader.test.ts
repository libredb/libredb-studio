import { afterEach, describe, expect, test } from "bun:test";
import { partEditability, type SourceEditablePart } from "@/components/object-source/source-editable";
import { httpSourceReader, isSourceDocumentShape } from "@/components/object-source/source-reader";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
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

  test("rejects a truncation reason longer than a text is allowed to be", () => {
    /*
     * THE ONE HOST-SUPPLIED RENDERED STRING THE FIRST ROUND'S BOUND MISSED (#789 fix round 1).
     * Round 1 bounded the text and the refusal SENTENCE with the argument that a refusal is a
     * text this component renders, and then did not apply it here: `ObjectSourceView` renders
     * `part.truncated.reason` verbatim into the warning banner, from the same unbounded host
     * path, on the one seam with no route in front of it. MEASURED before the bound landed: a
     * part carrying `reason: "r".repeat(SOURCE_CHARACTER_LIMIT * 5)` passed this predicate, so
     * five million characters reached a `<div>`.
     *
     * The CONTROL below sits exactly ON the bound and passes either way, which is what makes
     * this an off-by-one assertion rather than a refusal of everything large.
     */
    expect(
      isSourceDocumentShape({
        ...document,
        parts: [{ ...readable, truncated: { limit: 10, reason: "r".repeat(SOURCE_CHARACTER_LIMIT + 1) } }],
      }),
    ).toBe(false);
    expect(
      isSourceDocumentShape({
        ...document,
        parts: [{ ...readable, truncated: { limit: 10, reason: "r".repeat(SOURCE_CHARACTER_LIMIT) } }],
      }),
    ).toBe(true);
  });

  test("a malformed `edit` makes THAT PART not editable and leaves the document renderable", () => {
    // It fails SOFT, and that asymmetry is deliberate: refusing the whole document would regress an
    // existing adopter's READ, which is a feature they have today, over an affordance that is new.
    // Absence and malformation both read as not editable, and `partEditability` is what decides
    // that: `edit?.offered === true` is false for every malformed value, so the part answers
    // `not-offered` and the pane draws no Edit button.
    const malformed = { path: ["app", "f"], kind: "function", parts: [{ ...readable, edit: { offered: "yes" } }] };
    expect(isSourceDocumentShape(malformed)).toBe(true);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, edit: null }] })).toBe(true);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, edit: "offered" }] })).toBe(true);
    expect(isSourceDocumentShape({ ...document, parts: [{ ...readable, edit: { offered: false } }] })).toBe(true);
  });

  test("a well formed `edit` survives the check", () => {
    expect(
      isSourceDocumentShape({
        path: ["app", "f"],
        kind: "function",
        parts: [{ ...readable, edit: { offered: true } }],
      }),
    ).toBe(true);
    expect(
      isSourceDocumentShape({
        path: ["app", "f"],
        kind: "function",
        parts: [{ ...readable, edit: { offered: false, reason: "no" } }],
      }),
    ).toBe(true);
  });

  test("an `edit` on a REFUSAL part does not make the part editable", () => {
    // The client half of the same rule the route enforces, and the only half that runs on the
    // embedded shell, where a host cannot reach `boundSourceDocument` at all. The refusal arm never
    // reaches `partEditability`: `SourceEditablePart` is the TEXT arm and the refusal pane draws
    // first, so an `edit` sitting beside `unavailable` decides nothing.
    const refusal = {
      path: ["app", "f"],
      kind: "function",
      parts: [{ id: "d", label: "D", unavailable: "no", edit: { offered: true } }],
    };
    expect(isSourceDocumentShape(refusal)).toBe(true);
  });

  test("an over-long reason under `offered: true` leaves the document readable, because nothing renders it", () => {
    /*
     * THE BOUND IS ONE ARM WIDE, and this test is the population check that fix round 1 was
     * missing (#789 Phase 3). Round 1 checked the length wherever `reason` was a string, on the
     * argument that "a host shipping megabytes under an `offered: true` is handing this seam the
     * same value with a different label on it". MEASURED with the real `partEditability` below:
     * on the `offered: true` arm it answers `{ editable: true }` and never looks at `reason` at
     * all, so no component renders that string and there is nothing on that arm for a bound to
     * protect. Refusing the document over it cost the READ of every part in it for a field that
     * decides only an affordance, which is this epic's signature defect, a guard wider than the
     * population that renders.
     *
     * The assertion on `partEditability` is not decoration: it is the only thing that keeps this
     * test honest if `source-editable.ts` ever starts rendering the `offered: true` reason, at
     * which point the arm gains a renderer and this test must be reconsidered rather than
     * silently outlived.
     */
    const part = { ...readable, edit: { offered: true, reason: "n".repeat(SOURCE_CHARACTER_LIMIT + 1) } };
    expect(isSourceDocumentShape({ ...document, parts: [part] })).toBe(true);
    expect(partEditability(part as SourceEditablePart)).toEqual({ editable: true });
  });

  test("rejects an edit refusal whose reason is longer than a text is allowed to be", () => {
    /*
     * THE FOURTH HOST-SUPPLIED RENDERED STRING, and the first one this phase adds (#789 Phase 3).
     * `partEditability` answers `provider-refused` with `edit.reason` VERBATIM and unprefixed
     * (`source-editable.ts:110-112`), and `ObjectSourceView` renders that sentence, so an
     * unbounded `reason` is the same failure `unavailable` and `truncated.reason` were bounded
     * for: on the embedded seam there is no route in front of this predicate, and a host can hand
     * the shell tens of megabytes of prose to put in a `<span>`.
     *
     * IT IS A HARD REFUSAL and the malformed arm above is soft, which is not an inconsistency: a
     * malformed `edit` degrades safely, because every downstream reader of it answers "not
     * offered", while an over-long `reason` degrades into rendering the whole of it. Nothing
     * downstream bounds it: measured at this commit, `partEditability` does not look at the
     * length and it is not this task's file. An overrun is a failed read here for exactly the
     * reason the three strings beside it give, and no Phase 2 adopter regresses, because `edit` is
     * a field this phase invents and no document written before it carries one.
     *
     * The CONTROL sits exactly ON the bound and passes, which is what makes this an off-by-one
     * assertion rather than a refusal of everything large.
     */
    expect(
      isSourceDocumentShape({
        ...document,
        parts: [{ ...readable, edit: { offered: false, reason: "r".repeat(SOURCE_CHARACTER_LIMIT + 1) } }],
      }),
    ).toBe(false);
    expect(
      isSourceDocumentShape({
        ...document,
        parts: [{ ...readable, edit: { offered: false, reason: "r".repeat(SOURCE_CHARACTER_LIMIT) } }],
      }),
    ).toBe(true);
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
