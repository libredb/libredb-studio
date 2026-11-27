/**
 * The SDK's source bounds and its bound helper (docs/providers/CONTRACT.md, clause C-115): `applySourceBound` cuts one
 * text at a character bound and marks only a text it cut, and `boundSourceAnswer` cuts each readable part of a source
 * document whose text is past `SOURCE_CHARACTER_LIMIT`, reading each part's form as `checkSourceAnswer` does, without
 * the members it holds with no value, and leaving every other part as answered.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  applySourceBound,
  boundSourceAnswer,
  type ObjectSourceDocument,
  type ObjectSourcePart,
  SOURCE_CHARACTER_LIMIT,
  SOURCE_PART_LIMIT,
  sourceBoundTruncationReason,
} from "@libredb/provider-sdk/calls";

const marker = (): string => randomUUID();

describe("the source bounds", () => {
  test("a source document holds at most eight parts, and a part's text or a sentence at most a million UTF-16 code units", () => {
    expect(SOURCE_PART_LIMIT).toBe(8);
    expect(SOURCE_CHARACTER_LIMIT).toBe(1_000_000);
    expect(sourceBoundTruncationReason(1_000_000)).toBe(
      "the source read was bounded at 1,000,000 characters by its caller",
    );
  });
});

describe("applySourceBound", () => {
  test("applySourceBound cuts a text at the bound, drops a surrogate pair whole and marks only a text it cut", () => {
    for (const bound of [undefined, 8, 9]) {
      const exact = applySourceBound("SELECT 1", bound);
      expect(exact).toEqual({ text: "SELECT 1" });
      expect(Object.hasOwn(exact, "truncated")).toBe(false);
    }
    expect(applySourceBound("SELECT 1", 6)).toEqual({
      text: "SELECT",
      truncated: { limit: 6, reason: sourceBoundTruncationReason(6) },
    });
    // A bound between the two halves of a surrogate pair drops the pair whole, and the mark names the caller's number.
    expect(applySourceBound("a\u{1F600}b", 2)).toEqual({
      text: "a",
      truncated: { limit: 2, reason: sourceBoundTruncationReason(2) },
    });
    expect(applySourceBound("a\u{1F600}b", 3).text).toBe("a\u{1F600}");
    expect(applySourceBound("SELECT 1", 0)).toEqual({
      text: "",
      truncated: { limit: 0, reason: sourceBoundTruncationReason(0) },
    });
  });
});

describe("boundSourceAnswer", () => {
  test("boundSourceAnswer cuts each readable part past the character bound and joins a provider's own reason, and leaves every other part as answered", () => {
    const over = "x".repeat(SOURCE_CHARACTER_LIMIT + 1);
    const reason = marker();
    const fitting: ObjectSourcePart = {
      id: marker(),
      label: marker(),
      text: "x".repeat(SOURCE_CHARACTER_LIMIT),
      language: "sql",
      form: "complete",
      origin: "stored",
    };
    const refused: ObjectSourcePart = { id: marker(), label: marker(), unavailable: marker() };
    const statement: ObjectSourcePart = { id: marker(), label: marker(), unavailable: marker(), statement: true };
    const cut: ObjectSourcePart = { ...fitting, id: marker(), text: over, edit: { offered: true } };
    const marked: ObjectSourcePart = {
      ...fitting,
      id: marker(),
      text: over,
      truncated: { limit: 10, reason },
      edit: { offered: false, reason: marker() },
    };
    const answer: ObjectSourceDocument = Object.freeze({
      path: Object.freeze([marker()]),
      kind: "routine",
      parts: Object.freeze([fitting, refused, cut, statement, marked]) as unknown as ObjectSourceDocument["parts"],
    });
    const bound = boundSourceAnswer(answer);
    const mark = { limit: SOURCE_CHARACTER_LIMIT, reason: sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT) };

    expect(bound).not.toBe(answer);
    expect(bound.path).toBe(answer.path);
    expect(bound.kind).toBe(answer.kind);
    expect(bound.parts[0]).toBe(fitting);
    expect(bound.parts[1]).toBe(refused);
    expect(bound.parts[3]).toBe(statement);
    expect(bound.parts[2]).toEqual({ ...cut, text: "x".repeat(SOURCE_CHARACTER_LIMIT), truncated: mark });
    // The provider's own reason comes first, the SDK's bound joined to it, and the mark names the SDK's bound.
    expect(bound.parts[4]).toEqual({
      ...marked,
      text: "x".repeat(SOURCE_CHARACTER_LIMIT),
      truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: `${reason}; ${mark.reason}` },
    });
    // The answer is never mutated.
    expect(answer.parts[2]).toBe(cut);
    expect((answer.parts[2] as { text: string }).text).toBe(over);
    // A document of no part past the bound is answered with its parts by reference.
    const within: ObjectSourceDocument = { path: [marker()], kind: "routine", parts: [fitting, refused] };
    const same = boundSourceAnswer(within);
    expect(same.parts[0]).toBe(fitting);
    expect(same.parts[1]).toBe(refused);
  });

  test("boundSourceAnswer reads a part's form as checkSourceAnswer does and drops each member it holds with no value, so a readable part with an own undefined sentence is cut", () => {
    const over = "x".repeat(SOURCE_CHARACTER_LIMIT + 5);
    const id = marker();
    const label = marker();
    const sentence = marker();
    // An in-process answer keeps an own member whose value is undefined; the check reads it as absent.
    const readable = {
      id,
      label,
      text: over,
      language: "sql",
      form: "complete",
      origin: "stored",
      truncated: undefined,
      edit: undefined,
      unavailable: undefined,
      statement: undefined,
    } as unknown as ObjectSourcePart;
    const refused = {
      id: marker(),
      label,
      unavailable: sentence,
      statement: undefined,
      text: undefined,
    } as unknown as ObjectSourcePart;
    const bound = boundSourceAnswer({ path: [marker()], kind: "routine", parts: [readable, refused] });

    expect(bound.parts[0]).toEqual({
      id,
      label,
      text: "x".repeat(SOURCE_CHARACTER_LIMIT),
      language: "sql",
      form: "complete",
      origin: "stored",
      truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT) },
    });
    expect(Object.keys(bound.parts[0])).toEqual(["id", "label", "text", "language", "form", "origin", "truncated"]);
    expect(Object.keys(bound.parts[1])).toEqual(["id", "label", "unavailable"]);
    expect(bound.parts[1]).toEqual({ id: refused.id, label, unavailable: sentence });
    // The answer is never mutated.
    expect(Object.hasOwn(readable, "unavailable")).toBe(true);
    expect((readable as { text: string }).text).toBe(over);
  });
});
