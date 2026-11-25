import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * docs/providers/CONTRACT.md's change notes are closed until the first published contract.
 *
 * Every change to the contract used to append a line to the notes against the contract's earlier text, so any two open
 * changes conflicted on the end of that list and each merge sent the others back for a rebase and a fresh CI run. Until
 * the first published contract a change states itself in its commit and its pull request instead, and the first
 * published contract writes its notes once. These tests hold the list at the length it closed at, so a change that
 * appends to it fails here rather than in the next change's rebase.
 */

const CONTRACT = readFileSync(path.resolve(import.meta.dir, "../../docs/providers/CONTRACT.md"), "utf8");

/** The number of notes the list against the contract's earlier text held when it closed. */
const CLOSED_AT = 70;

/** The top-level notes of the list against the contract's earlier text, the last list of the change notes. */
function earlierTextNotes(document: string): readonly string[] {
  const notes = document.split(/^## Change notes$/m)[1] ?? "";
  const list = notes.split(/^Against this contract's earlier text:$/m)[1] ?? "";
  return list.split("\n").filter((line) => line.startsWith("- "));
}

describe("the contract's change notes", () => {
  test("the notes say they are closed until the first published contract", () => {
    expect(CONTRACT).toContain("These notes are closed until the first published contract.");
  });

  test("the list against the contract's earlier text holds the notes it closed with, and no more", () => {
    expect(earlierTextNotes(CONTRACT)).toHaveLength(CLOSED_AT);
  });

  test("a note appended to the list is counted", () => {
    expect(earlierTextNotes(`${CONTRACT}\n- an appended note`)).toHaveLength(CLOSED_AT + 1);
  });
});
