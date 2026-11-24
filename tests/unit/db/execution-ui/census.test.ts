import { describe, expect, test } from "bun:test";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import { admittedDeclarations } from "../../../../scripts/generate-engine-catalog";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_EXECUTION_UI } from "@/lib/db/engine-catalog/editor.generated";
import { EXECUTION_UI, executionUiFor } from "@/lib/db/execution-ui";
import { NO_CONNECTION_EXECUTION_UI } from "@/lib/db/execution-ui/no-connection";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

const ALL: readonly DatabaseType[] = [...EXTERNAL_DATABASE_TYPES, "libredb"];

/** The admitted declarations, read once: admission compiles the schema and validates every declaration. */
const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();

/** The admitted declaration of `id`. */
function admitted(id: string): EngineDeclaration {
  const declaration = ADMITTED.find((d) => d.id === id);
  if (declaration === undefined) throw new Error(`no admitted declaration of ${id}`);
  return declaration;
}

const idsWhere = (has: (id: DatabaseType) => boolean) => ALL.filter(has).sort();

describe("execution UI registry census", () => {
  test("one row per shipped type id", () => {
    expect(Object.keys(EXECUTION_UI).sort()).toEqual([...ALL].sort());
    expect(Object.isFrozen(EXECUTION_UI)).toBe(true);
  });

  test("each row is its declaration's commit keyword and consent deadline, read from the generated execution UI record", () => {
    expect(EXECUTION_UI).toBe(BUNDLED_EXECUTION_UI);
    for (const id of ALL) {
      expect(EXECUTION_UI[id]).toBe(BUNDLED_EXECUTION_UI[id]);
      const { editor } = admitted(id);
      expect(EXECUTION_UI[id]).toEqual({
        commitKeyword: editor.commitKeyword,
        consentDeadline: editor.consentDeadline,
      });
    }
  });

  test("rows are pairwise distinct objects", () => {
    expect(new Set(Object.values(EXECUTION_UI)).size).toBe(ALL.length);
  });

  test("the commit keyword and consent deadline rows are the ones today's code has", () => {
    expect(idsWhere((id) => EXECUTION_UI[id].commitKeyword !== "COMMIT")).toEqual(["redis"]);
    expect(EXECUTION_UI.redis.commitKeyword).toBe("EXEC");
    expect(idsWhere((id) => EXECUTION_UI[id].consentDeadline !== null)).toEqual(["sqlite"]);
    expect(EXECUTION_UI.sqlite.consentDeadline).toEqual({
      chip: "SQLite: killed at its timeout",
      sentence:
        "On SQLite a read that runs past its timeout is now killed mid-flight; the in-memory database is the exception and still blocks this application until the read finishes.",
    });
  });

  test("executionUiFor answers no connection with its own spec and a type id with its row", () => {
    expect(executionUiFor(undefined)).toBe(NO_CONNECTION_EXECUTION_UI);
    expect(NO_CONNECTION_EXECUTION_UI).toEqual({ commitKeyword: "COMMIT", consentDeadline: null });
    expect(executionUiFor("redis")).toBe(EXECUTION_UI.redis);
  });

  test.each(OUTSIDE_THE_UNION)("executionUiFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => executionUiFor(value as string))).toEqual(refusalOf(value));
  });
});
