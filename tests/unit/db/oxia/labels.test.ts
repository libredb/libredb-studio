/**
 * The Oxia provider's labels (SB2-9.2) and the key order in words (SB2-9.3).
 *
 * Plan mode states `statementLanguage` verbatim after "Write it in", so each example in it is parsed with the
 * provider's own parser and classified with the confirmation gate's reader, and every verb and flag of the parser's
 * table is named in it.
 */
import { describe, expect, test } from "bun:test";
import { OXIA_COMMAND_TABLE, parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { readOxiaOperations } from "@/lib/db/providers/keyvalue/oxia/guard";
import {
  keyOrderWords,
  OXIA_DRAFTED_READS,
  OXIA_LABELS,
  OXIA_STATEMENT_EXAMPLES,
  oxiaStatementLanguage,
} from "@/lib/db/providers/keyvalue/oxia/labels";

const STATEMENT_LANGUAGE =
  "the oxia client read command this editor runs: exactly one command per run, written as oxia client writes it, optionally after oxia client, with no pipe, no redirect, no second command and no -a, -n or --auth-token, because the connection decides where a command runs, in which namespace and as whom; plan mode drafts only a read, one of " +
  "get KEY [-t|--comparison-type] [-p|--partition-key] [--index] [--hex] [-v|--include-version], " +
  "list [MIN [MAX]] [-s|--key-min] [-e|--key-max] [-p|--partition-key] [--index] [--prefix] [--limit], " +
  "range-scan [MIN [MAX]] [-s|--key-min] [-e|--key-max] [-p|--partition-key] [--index] [--prefix] [--limit] [-v|--include-version] [--hex]" +
  ", with --limit at most 500; the keys under a path P are read with list --prefix P/ or range-scan --prefix P/, never with -s P/ -e P//, which misses keys under natural key order; keys under __oxia/ are never read; for example list --prefix /admin/policies/ --limit 50 or get /admin/policies/public; every write (put, delete, delete-range) and every stream (notifications, sequence-updates) is the user's to run with the oxia CLI and is never drafted";

describe("OXIA_LABELS", () => {
  test("holds every member of SB2-9.2's table, and no reindex or vacuum operation", () => {
    expect(OXIA_LABELS).toEqual({
      entityName: "Shard",
      entityNamePlural: "Shards",
      rowName: "Key",
      rowNamePlural: "Keys",
      selectAction: "List Keys",
      generateAction: "Generate Command",
      analyzeAction: "Shard Statistics",
      vacuumAction: "Compact",
      searchPlaceholder: "Search shards...",
      analyzeGlobalLabel: "Statistics",
      analyzeGlobalTitle: "Not available",
      analyzeGlobalDesc: "Oxia keeps no statistics to update.",
      vacuumGlobalLabel: "Compact",
      vacuumGlobalTitle: "Not available",
      vacuumGlobalDesc: "Oxia compacts its own storage, and Studio sends it no maintenance.",
      statementLanguage: STATEMENT_LANGUAGE,
      slowQueriesEmptyState: "Oxia keeps no query log",
      sessionsEmptyState: "Oxia does not list client sessions",
      tableStatsCaption:
        "Oxia has no tables: its shards are listed under Shards, and its keys in the Keys panel and with list in the console.",
    });
    expect(Object.isFrozen(OXIA_LABELS)).toBe(true);
  });
});

describe("statementLanguage", () => {
  test("is SB2-9.2's sentence, built from the parser's table", () => {
    expect(oxiaStatementLanguage()).toBe(STATEMENT_LANGUAGE);
  });

  test("drafts the three reads, in the table's order", () => {
    expect(OXIA_DRAFTED_READS).toEqual(["get", "list", "range-scan"]);
    expect(OXIA_COMMAND_TABLE.map((command) => command.verb)).toEqual([...OXIA_DRAFTED_READS]);
  });

  test("names every verb and every flag of the parser's table", () => {
    for (const command of OXIA_COMMAND_TABLE) {
      expect(STATEMENT_LANGUAGE).toContain(`${command.verb} ${command.arguments}`);
      for (const flag of command.flags) expect(STATEMENT_LANGUAGE).toContain(`[${flag}]`);
    }
  });

  test.each(OXIA_STATEMENT_EXAMPLES.map((example) => [example]))(
    "the example %s parses and is classified as the read it is",
    (example) => {
      expect(OXIA_STATEMENT_EXAMPLES).toEqual([
        "list --prefix /admin/policies/ --limit 50",
        "get /admin/policies/public",
      ]);
      const parsed = parseOxiaCommand(example, {});
      expect(parsed.ok).toBe(true);
      expect(readOxiaOperations(example)).toEqual([example.split(" ")[0]]);
      expect(STATEMENT_LANGUAGE).toContain(example);
    },
  );

  test("each write and stream the sentence keeps from plan mode is refused by the parser", () => {
    for (const verb of ["put", "delete", "delete-range", "notifications", "sequence-updates"]) {
      expect(STATEMENT_LANGUAGE).toContain(verb);
      expect(readOxiaOperations(`${verb} k`)).toBeUndefined();
    }
  });
});

describe("keyOrderWords (SB2-9.3)", () => {
  test.each([
    [{ order: "hierarchical", learnedBy: "ceiling-probe" }, "hierarchical, detected from key order"],
    [{ order: "hierarchical", learnedBy: "decisive-list" }, "hierarchical, detected from key order"],
    [{ order: "hierarchical", learnedBy: "pair-sample" }, "hierarchical, detected from key order"],
    [{ order: "natural", learnedBy: "ceiling-probe" }, "natural, detected from key order"],
    [{ order: "natural", learnedBy: "decisive-list" }, "natural, detected from key order"],
    [{ order: "natural", learnedBy: "pair-sample" }, "natural, detected from key order"],
    [
      { order: "hierarchical", learnedBy: "assumed", exhausted: true },
      "hierarchical, assumed: Studio could not tell the orders apart from the keys read",
    ],
    [{ order: "hierarchical", learnedBy: "assumed" }, "hierarchical: no key holds /"],
    [{ order: "hierarchical", learnedBy: "empty" }, "empty namespace"],
  ] as const)("%j", (verdict, words) => {
    expect(keyOrderWords(verdict)).toBe(words);
  });
});
