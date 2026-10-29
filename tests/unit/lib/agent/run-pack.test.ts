import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE, AGENT_WORKFLOW_VARIANTS } from "@/lib/agent/agent-manifest";
import { DEFAULT_STATEMENT_LANGUAGE, statementFamilyOf } from "@/lib/agent/languages/client";
import { engineFamily } from "@/lib/agent/languages/engines/client";
import { engineServerDialect, engineServerOverlay, runServerPack } from "@/lib/agent/languages/engines/server";
import { MONGO_SERVER_PACK } from "@/lib/agent/languages/mongo/server";
import { CURATED_CALL_LANGUAGE, languageServerPack } from "@/lib/agent/languages/server";
import { SQL_SERVER_PACK } from "@/lib/agent/languages/sql/server";
import { AGENT_WORKFLOW_PRESENTS_ANSWER } from "@/lib/agent/types";
import type { DatabaseType } from "@/lib/types";

/**
 * The run resolver (#1821): the server facet one run reads, from its persisted statement language and its connection
 * type. Held member for member against the family pack, so a reader moved onto `runServerPack` reads what it read
 * before, on every engine and every language a record may persist, an absent one included.
 */

const ALL_TYPES = Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[];
const LANGUAGES = [undefined, "sql", "mongo", "kubectl"] as const;

describe("statementFamilyOf", () => {
  test("an absent language reads as the default, and a present one as itself", () => {
    expect(DEFAULT_STATEMENT_LANGUAGE).toBe("sql");
    expect(statementFamilyOf(undefined)).toBe(DEFAULT_STATEMENT_LANGUAGE);
    expect(statementFamilyOf("mongo")).toBe("mongo");
    expect(statementFamilyOf("kubectl")).toBe("kubectl");
  });

  test("the default language's variant record is total over the workflows", () => {
    expect(Object.keys(AGENT_WORKFLOW_VARIANTS[DEFAULT_STATEMENT_LANGUAGE]).sort()).toEqual(
      Object.keys(AGENT_WORKFLOW_PRESENTS_ANSWER).sort(),
    );
  });
});

describe("CURATED_CALL_LANGUAGE", () => {
  test("a curated call is fingerprinted and refused as SQL", () => {
    expect(CURATED_CALL_LANGUAGE).toBe("sql");
  });
});

describe("engineFamily", () => {
  test("an engine's family is the language the manifest maps it onto", () => {
    for (const type of ALL_TYPES) expect(engineFamily(type)).toBe(AGENT_STATEMENT_LANGUAGE[type]);
  });

  test("a name that is no own key has no family", () => {
    expect(engineFamily("toString" as DatabaseType)).toBeNull();
  });
});

describe("runServerPack", () => {
  test("every member but the dialect and the overlay's own overrides is the family pack's, for every language and engine", () => {
    for (const language of LANGUAGES) {
      const family = languageServerPack(statementFamilyOf(language));
      for (const type of ALL_TYPES) {
        const run = runServerPack(language, type);
        // An engine of the run's family keeps the members its overlay overrides; held in engine-overlays.test.ts.
        const overridden =
          engineFamily(type) === statementFamilyOf(language)
            ? Object.keys(engineServerOverlay(type)).filter((key) => key !== "dialect")
            : [];
        for (const member of Object.keys(family) as (keyof typeof family)[]) {
          if (overridden.includes(member)) expect(run[member]).not.toBe(family[member]);
          else expect(run[member]).toBe(family[member]);
        }
        expect(Object.keys(run).filter((key) => !Object.hasOwn(family, key))).toEqual(
          "dialect" in run ? ["dialect"] : [],
        );
      }
    }
  });

  test("an engine with no family reads the family pack itself", () => {
    expect(runServerPack(undefined, "redis")).toBe(SQL_SERVER_PACK);
  });

  test("an engine whose family is not the run's reads the run's family pack itself", () => {
    expect(runServerPack("mongo", "postgres")).toBe(MONGO_SERVER_PACK);
  });

  test("an engine of the run's family carries its own dialect", () => {
    expect((runServerPack(undefined, "postgres") as { dialect?: unknown }).dialect).toBe(
      engineServerDialect("postgres"),
    );
  });

  test("a language this server does not know is the named error", () => {
    expect(() => runServerPack("cobol" as never, "postgres")).toThrow("no server adapter for cobol");
  });
});
