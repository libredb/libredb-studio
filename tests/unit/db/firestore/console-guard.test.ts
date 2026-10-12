/**
 * The editor's verdict on a Firestore statement: the sentence the provider would refuse it with, from the same
 * lexer, parser and compiler, or null to send it; it never throws, whatever the editor holds.
 */
import { describe, expect, test } from "bun:test";
import { compileStatement } from "@/lib/db/providers/document/firestore/console/compile";
import { firestoreRefusal, GUARD_TARGET } from "@/lib/db/providers/document/firestore/console/guard";
import { parseStatement } from "@/lib/db/providers/document/firestore/console/parser";
import { projectIdRefusal } from "@/lib/db/providers/document/firestore/names";
import { refusal, seededRandom } from "../../../helpers/firestore-console";

describe("firestoreRefusal", () => {
  test("null for a statement the provider would run", () => {
    expect(firestoreRefusal('db.collection("users").where("age", ">=", 21)')).toBeNull();
    expect(firestoreRefusal('db.doc("users/alice")')).toBeNull();
    expect(firestoreRefusal("db.listCollections()")).toBeNull();
  });

  test.each([
    'db.collection("users").add({})',
    "const x = 1",
    'db.collection("users").limit(5000)',
    'db.collection("users/a:b/orders")',
    "",
    "x".repeat(70_000),
  ])("the provider's own sentence for %j", (text) => {
    const expected = refusal(() =>
      compileStatement(parseStatement(text), text, { target: GUARD_TARGET, explainButton: false }),
    ).message;
    expect(firestoreRefusal(text)).toBe(expected);
  });

  test("never throws on arbitrary text", () => {
    const random = seededRandom(0x6a7d);
    for (let iteration = 0; iteration < 500; iteration++) {
      const length = Math.floor(random() * 80);
      const text = Array.from({ length }, () => String.fromCharCode(Math.floor(random() * 0x10000))).join("");
      const verdict = firestoreRefusal(text);
      expect(verdict === null || typeof verdict === "string").toBe(true);
    }
  });

  test("the guard's target is a valid target of the default database", () => {
    expect(projectIdRefusal(GUARD_TARGET.projectId)).toBeNull();
    expect(GUARD_TARGET.databaseId).toBe("(default)");
  });
});
