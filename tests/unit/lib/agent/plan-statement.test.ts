import { describe, expect, test } from "bun:test";
import {
  PLAN_NO_STATEMENT_MARKER,
  readPlanStatement,
  readStatementTables,
  validatePlanStatement,
} from "@/lib/agent/plan-statement";
import type { TableSchema } from "@/lib/types";

/**
 * The statement a plan run drafted, made a fact rather than a parse (the plan-mode
 * SQL-generator design of 2026-08-15, work item 5).
 *
 * Three properties are what this module is for, and each is asserted rather than
 * assumed:
 *
 *  1. **The fence is read by CommonMark's rule, not by "find some backticks".** A
 *     one-line ```` ```sql SELECT 1``` ```` is NOT an opener, because a backtick may
 *     not appear in an info string — the rule `src/components/rich-text.tsx` adopted
 *     in #389 after such a line swallowed the whole rest of a plan into one block.
 *     The two readers have to agree: the browser renders what this records.
 *  2. **The refusal is an outcome, not a failure.** `NO STATEMENT:` is a convention
 *     in the output rather than a tool, which is what lets a toolless mode have two
 *     mechanically distinguishable legitimate endings.
 *  3. **Nothing here claims a statement will RUN.** The inventory records what
 *     exists, not what the user's role may select from, and the shared statement
 *     guard's own docblock says a `null` violation is not a safety claim. So the
 *     tests below pin what the validation reports and, deliberately, what it does
 *     not: an unknown table is recorded, a write is marked, and neither is blocked.
 */

const INVENTORY: readonly TableSchema[] = [
  { name: "public.film", columns: [], indexes: [] },
  { name: "public.actor", columns: [], indexes: [] },
];

/** SQLite's inventory carries bare names, which is why matching cannot be strict. */
const SQLITE_INVENTORY: readonly TableSchema[] = [{ name: "film", columns: [], indexes: [] }];

describe("the drafted statement is read out of the closing prose", () => {
  test("a fenced block tagged with the engine is the statement", () => {
    const draft = readPlanStatement(
      [
        "Here is what I would run.",
        "",
        "```postgres",
        "SELECT title FROM film;",
        "```",
        "",
        "It reads one table.",
      ].join("\n"),
    );

    expect(draft).toEqual({ kind: "statement", sql: "SELECT title FROM film;", tag: "postgres" });
  });

  test("an untagged fence still carries a statement", () => {
    const draft = readPlanStatement(["```", "SELECT 1", "```"].join("\n"));

    expect(draft).toEqual({ kind: "statement", sql: "SELECT 1", tag: undefined });
  });

  test("prose with no fence at all drafts nothing", () => {
    expect(readPlanStatement("I would start by inspecting the indexes on the orders table.")).toEqual({
      kind: "absent",
    });
  });

  test("an empty fence drafts nothing, rather than an empty statement", () => {
    expect(readPlanStatement(["```sql", "   ", "```"].join("\n"))).toEqual({ kind: "absent" });
  });

  /*
    The #389 defect, in this reader. `\`\`\`sql SELECT 1\`\`\`` carries a backtick in
    its info string, so CommonMark does not open a block there — and that rule is the
    only thing standing between one malformed line and a reader that swallows every
    line after it as SQL. It stays the prose it renders as, and the run drafted
    nothing.
  */
  test("a whole fence written on one line is not an opener, and swallows nothing", () => {
    expect(readPlanStatement("```sql SELECT 1```\nand then check the plan.")).toEqual({ kind: "absent" });
  });

  /*
    The contract asks for ONE statement. When a run writes more blocks anyway, the
    first is the deliverable and the rest are illustration: nothing here can tell
    which of several a user meant, and #389's per-block control in the rail still
    offers every one of them by hand.
  */
  test("the first fenced block is the deliverable when a run writes several", () => {
    const draft = readPlanStatement(
      ["```sql", "SELECT title FROM film;", "```", "compare that with", "```sql", "SELECT 1;", "```"].join("\n"),
    );

    expect(draft).toEqual({ kind: "statement", sql: "SELECT title FROM film;", tag: "sql" });
  });

  /*
    The tag dimension of the agreement this reader claims with `renderProse`, and the
    half that was missing until 2026-08-15: the two agreed about where a fence STARTS
    and not about which block is a statement. The rail offers the editor only a block
    whose tag names a query language, so a run that opens with an illustration and
    writes its SQL below had the illustration recorded as its deliverable — shown in
    the statement card, and, because the guard reads prose as `NO_STATEMENT`, marked
    there as SQL that may change data.

    Both readers now ask `isQueryFenceTag` the same question.
  */
  test("an illustration the model tagged as something else is not the deliverable", () => {
    const draft = readPlanStatement(
      [
        "The shape of the answer:",
        "```text",
        "title | rentals",
        "```",
        "and the statement that produces it:",
        "```postgres",
        "SELECT title FROM film;",
        "```",
      ].join("\n"),
    );

    expect(draft).toEqual({ kind: "statement", sql: "SELECT title FROM film;", tag: "postgres" });
  });

  /*
    Fail-closed, the same posture the rail takes: the model said what the block is,
    and recording a shell script as this run's SQL deliverable would be the server
    contradicting it. The run then has no statement, which the verdict reads as the
    shortfall it is rather than as a success.
  */
  test("a run whose only block is not a query language drafted no statement", () => {
    expect(readPlanStatement(["```bash", "pg_dump dvdrental", "```"].join("\n"))).toEqual({ kind: "absent" });
  });

  /*
    A run cut off at its turn limit or its deadline ends mid-block, and the statement
    it had written by then is the half the user came for. `renderProse` makes the same
    call for the same reason, and the two readers agreeing is what keeps the rail from
    showing a block the ledger does not record.
  */
  test("a fence the run never closed still carries what it holds", () => {
    expect(readPlanStatement(["```sql", "SELECT title", "FROM film"].join("\n"))).toEqual({
      kind: "statement",
      sql: "SELECT title\nFROM film",
      tag: "sql",
    });
  });

  test("the refusal marker is an outcome of its own, and carries what it says is missing", () => {
    const draft = readPlanStatement(
      [`${PLAN_NO_STATEMENT_MARKER} the inventory has no table of payments.`, "Which table records them?"].join("\n"),
    );

    expect(draft).toEqual({ kind: "refusal", detail: "the inventory has no table of payments." });
  });

  test("a refusal marker with nothing after it is still a refusal", () => {
    expect(readPlanStatement("NO STATEMENT:")).toEqual({ kind: "refusal", detail: "" });
  });

  /*
    A run that refused and also pasted an illustrative block has not drafted a
    deliverable, and offering that block to the editor as the answer would be exactly
    the mislabelling this event exists to prevent.
  */
  test("a refusal outside a fence beats a block written beside it", () => {
    const draft = readPlanStatement(
      ["NO STATEMENT: no table records payments.", "", "```sql", "SELECT 1;", "```"].join("\n"),
    );

    expect(draft).toEqual({ kind: "refusal", detail: "no table records payments." });
  });

  /*
    Inside a fence nothing is prose — the rule `renderProse` follows line for line —
    so a statement that merely CONTAINS the marker text is a statement, not a refusal.
  */
  test("the marker inside a fence is part of the statement, not a refusal", () => {
    const draft = readPlanStatement(["```sql", "SELECT 'NO STATEMENT: none' AS note", "```"].join("\n"));

    expect(draft).toEqual({ kind: "statement", sql: "SELECT 'NO STATEMENT: none' AS note", tag: "sql" });
  });

  test("only the first refusal line is read, so a run repeating itself says one thing", () => {
    expect(readPlanStatement("NO STATEMENT: first.\nNO STATEMENT: second.")).toEqual({
      kind: "refusal",
      detail: "first.",
    });
  });
});

describe("the tables a statement names are read from its own code", () => {
  test("a join names both of its tables", () => {
    expect(readStatementTables("SELECT * FROM public.film f JOIN actor a ON a.id = f.actor_id")).toEqual([
      "public.film",
      "actor",
    ]);
  });

  test("a comma-separated FROM list names every table in it", () => {
    expect(readStatementTables("SELECT * FROM film f, actor AS a, category")).toEqual(["film", "actor", "category"]);
  });

  test("a name a statement merely mentions in a literal or a comment is not a table it reads", () => {
    expect(readStatementTables("SELECT 'FROM ghosts' AS note -- FROM spectres\nFROM film")).toEqual(["film"]);
  });

  test("a subquery in the FROM position names no table of its own", () => {
    expect(readStatementTables("SELECT * FROM (SELECT id FROM film) t")).toEqual(["film"]);
  });

  test("a table-valued function is not a table", () => {
    expect(readStatementTables("SELECT * FROM generate_series(1, 10)")).toEqual([]);
  });

  test("a CTE is defined by the statement, so it is not one of the tables it names", () => {
    expect(readStatementTables("WITH recent AS (SELECT id FROM film) SELECT * FROM recent")).toEqual(["film"]);
  });

  test("a CTE declaring its columns is still recognised as defined by the statement", () => {
    expect(readStatementTables("WITH recent (id) AS (SELECT id FROM film) SELECT * FROM recent")).toEqual(["film"]);
  });

  test("a quoted name is read as the name it quotes", () => {
    expect(readStatementTables('SELECT * FROM "public"."odd name"')).toEqual(["public.odd name"]);
  });

  test("a write names the table it writes to", () => {
    expect(readStatementTables("INSERT INTO film (title) VALUES ('x')")).toEqual(["film"]);
    expect(readStatementTables("UPDATE film SET title = 'x'")).toEqual(["film"]);
    expect(readStatementTables("DROP TABLE film")).toEqual(["film"]);
  });

  test("the same table named twice is reported once", () => {
    expect(readStatementTables("SELECT * FROM film JOIN film ON true")).toEqual(["film"]);
  });

  test("a keyword that is not a name ends the reading rather than becoming one", () => {
    expect(readStatementTables("SELECT * FROM ONLY film")).toEqual([]);
    expect(readStatementTables("SELECT 1 FROM")).toEqual([]);
  });
});

describe("a drafted statement is validated before anything offers it", () => {
  test("a read of tables the inventory holds is read-only with nothing unknown", () => {
    expect(validatePlanStatement("SELECT title FROM film JOIN actor ON true", INVENTORY)).toEqual({
      readOnly: true,
      identifiers: { kind: "checked", unknownTables: [] },
    });
  });

  test("a table the inventory does not hold is recorded, and the statement is not dropped", () => {
    const validation = validatePlanStatement("SELECT * FROM film JOIN payments ON true", INVENTORY);

    expect(validation.readOnly).toBe(true);
    expect(validation.identifiers).toEqual({ kind: "checked", unknownTables: ["payments"] });
  });

  /*
    The engines qualify their inventories differently — PostgreSQL records
    `public.film`, SQLite records `film` — so a strict comparison would report every
    SQLite statement's tables as unknown. The leniency is stated where it is spent:
    a name matching a same-named table in another schema is accepted here.
  */
  test("a bare name matches the qualified inventory entry it names, and the other way round", () => {
    expect(validatePlanStatement("SELECT * FROM film", INVENTORY).identifiers).toEqual({
      kind: "checked",
      unknownTables: [],
    });
    expect(validatePlanStatement("SELECT * FROM main.film", SQLITE_INVENTORY).identifiers).toEqual({
      kind: "checked",
      unknownTables: [],
    });
  });

  /*
    A run with no inventory validated NOTHING, and says so. Reporting an empty
    unknown-table list here would claim every table checked out against an inventory
    that was never read — the precision this repository keeps being caught claiming.
  */
  test("an ungrounded run reports no identifier check rather than an empty one", () => {
    expect(validatePlanStatement("SELECT * FROM anything", null).identifiers).toEqual({ kind: "no-inventory" });
  });

  /*
    The owner's decision: a write is MARKED, never blocked. The classification is the
    shared guard in `src/lib/db/operations/statement-guard.ts` and not a second SQL
    reader — two wordings of one rule is how #350 happened — so the violation it
    reports travels with the mark.
  */
  test("a write is marked with the guard's own reason, and still recorded", () => {
    expect(validatePlanStatement("DELETE FROM film", INVENTORY)).toEqual({
      readOnly: false,
      guardViolation: "NON_READ_STATEMENT",
      identifiers: { kind: "checked", unknownTables: [] },
    });
  });

  test("a read carrying a writing CTE is marked too, since its head says nothing about what it does", () => {
    const validation = validatePlanStatement("WITH gone AS (DELETE FROM film RETURNING id) SELECT * FROM gone", null);

    expect(validation.readOnly).toBe(false);
    expect(validation.guardViolation).toBe("SIDE_EFFECT_KEYWORD");
  });

  test("two statements are not read-only either, and the guard says which objection it had", () => {
    expect(validatePlanStatement("SELECT 1; SELECT 2", null).guardViolation).toBe("MULTIPLE_STATEMENTS");
  });
});
