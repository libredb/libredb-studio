/**
 * The shared reading behind Q5: a statement is session-changing when it LEADS with a keyword of
 * the engine's vocabulary, past whitespace and comments, or carries one of its markers anywhere.
 * The engine vocabularies themselves are pinned in each provider's own suite.
 */
import { describe, expect, test } from "bun:test";
import { changesSessionState, type SessionStateVocabulary } from "@/lib/db/providers/sql/session-state";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

const vocabulary: SessionStateVocabulary = { leading: new Set(["SET", "USE"]), markers: [/:=/] };
const grammar = resolveSqlGrammar("mysql");

describe("changesSessionState", () => {
  test("a leading keyword of the vocabulary is session-changing, in any case and behind comments", () => {
    expect(changesSessionState("SET @v = 42", vocabulary, grammar)).toBe(true);
    expect(changesSessionState("  use rg", vocabulary, grammar)).toBe(true);
    expect(changesSessionState("/* note */ -- more\nset @v = 1", vocabulary, grammar)).toBe(true);
    expect(changesSessionState("# a MySQL comment\nSET @v = 1", vocabulary, grammar)).toBe(true);
  });

  test("a marker anywhere is session-changing", () => {
    expect(changesSessionState("SELECT @v := 1", vocabulary, grammar)).toBe(true);
  });

  test("a keyword that only appears later, and a statement with no keyword at all, are not", () => {
    expect(changesSessionState("UPDATE t SET a = 1", vocabulary, grammar)).toBe(false);
    expect(changesSessionState("SELECT @v", vocabulary, grammar)).toBe(false);
    expect(changesSessionState("", vocabulary, grammar)).toBe(false);
    expect(changesSessionState("-- only a comment", vocabulary, grammar)).toBe(false);
  });
});
