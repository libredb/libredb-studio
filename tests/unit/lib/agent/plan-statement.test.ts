import { describe, expect, test } from "bun:test";
import { PLAN_NO_STATEMENT_MARKER, readPlanStatement } from "@/lib/agent/plan-draft";
import { readStatementTables, validatePlanStatement } from "@/lib/agent/plan-statement";
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

  /*
    This test previously asserted the opposite — that a bare marker "is still a
    refusal" — and that is worth recording rather than quietly replacing. The
    convention exists so a run that cannot draft says WHAT it lacks and asks for it;
    a token with nothing after it says neither, and accepting it let the emptiest
    output a model can produce satisfy the one check built to stop a run being scored
    as answered when it answered nothing (#396 review).
  */
  test("a refusal marker with nothing after it is not a refusal", () => {
    expect(readPlanStatement("NO STATEMENT:")).toEqual({ kind: "absent" });
    expect(readPlanStatement("NO STATEMENT:   ")).toEqual({ kind: "absent" });
  });

  test("a bare marker does not suppress a statement written beside it", () => {
    // The precedence rule is refusal-beats-block, and a bare marker is not a refusal,
    // so the block is still this run's deliverable rather than being lost to a token.
    const draft = readPlanStatement(["NO STATEMENT:", "", "```sql", "SELECT 1;", "```"].join("\n"));

    expect(draft).toEqual({ kind: "statement", sql: "SELECT 1;", tag: "sql" });
  });

  test("the bar is substance and not a question mark", () => {
    // A refusal phrased as an imperative request is a proper refusal; requiring "?"
    // would fail it for its grammar.
    const draft = readPlanStatement("NO STATEMENT: tell me which column records the rental price.");

    expect(draft).toEqual({ kind: "refusal", detail: "tell me which column records the rental price." });
  });

  /*
    The fence tag is the model saying which engine it wrote for. A block tagged for a
    DIFFERENT engine than the connection is not this run's deliverable: the recorder
    stamps the event with the connection's own dialect, so taking it would file the
    model's MySQL as PostgreSQL and report the run as answered (#396 review).
  */
  test("a block tagged for another engine is not this run's deliverable", () => {
    const text = ["```mysql", "SELECT 1;", "```"].join("\n");

    expect(readPlanStatement(text, "postgres")).toEqual({ kind: "absent" });
    expect(readPlanStatement(text, "mysql")).toEqual({ kind: "statement", sql: "SELECT 1;", tag: "mysql" });
  });

  test("an alias that names the connection's engine is this run's deliverable", () => {
    const draft = readPlanStatement(["```postgresql", "SELECT 1;", "```"].join("\n"), "postgres");

    expect(draft).toEqual({ kind: "statement", sql: "SELECT 1;", tag: "postgresql" });
  });

  test("a generic or absent tag names no engine, so it contradicts none", () => {
    for (const fence of ["```sql", "```"]) {
      const draft = readPlanStatement([fence, "SELECT 1;", "```"].join("\n"), "postgres");
      expect(draft.kind).toBe("statement");
    }
  });

  test("a conflicting block does not hide the run's real one", () => {
    const draft = readPlanStatement(
      ["```mysql", "SELECT 1;", "```", "", "```postgres", "SELECT 2;", "```"].join("\n"),
      "postgres",
    );

    expect(draft).toEqual({ kind: "statement", sql: "SELECT 2;", tag: "postgres" });
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

  /*
    Measured, and it is our defect rather than the models'. `no-statement` blocks four cells
    and four of the losing runs across THREE models, `qwen3:4b` among them, end with exactly
    this:

        NO STATEMENT:
        The provided schema inventory includes the complete answer to the question, so a
        runnable SQL query is not needed. The question that would allow writing such a
        statement is: "..."

    The marker line ends where it ends and the explanation starts on the next line. Every one
    of those runs did what plan mode asks — refused, said what was missing, asked the one
    question — and every one was scored as having said nothing, because this reader looked
    only at the remainder of the marker's OWN line and found it empty.

    The #396 rule the empty check exists for is untouched: a marker with nothing after it
    ANYWHERE is still `absent`, because the convention exists so the run says what it lacks
    and a token that says nothing is not the ending the mode is for. What changes is where
    "after it" is allowed to be.
  */
  test("a refusal whose reason begins on the next line is still a refusal", () => {
    expect(readPlanStatement("NO STATEMENT:\nThe inventory has no table of payments.")).toEqual({
      kind: "refusal",
      detail: "The inventory has no table of payments.",
    });
    // Trailing space after the marker, and a blank line before the reason: both measured.
    expect(readPlanStatement("NO STATEMENT: \n\nThe inventory has no table of payments.")).toEqual({
      kind: "refusal",
      detail: "The inventory has no table of payments.",
    });
  });

  test("a marker with nothing after it anywhere is still not a refusal", () => {
    expect(readPlanStatement("NO STATEMENT:")).toEqual({ kind: "absent" });
    expect(readPlanStatement("NO STATEMENT:\n\n   \n")).toEqual({ kind: "absent" });
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

  /*
    A quoted alias is not a word, so the alias step walked off it and never reached the
    comma — the list ended at the first table and every later name escaped the
    unknown-table finding entirely. An invented table hidden behind a quoted alias is
    precisely what this validation exists to catch (#396 review).
  */
  test("a quoted alias does not end the list that follows it", () => {
    expect(readStatementTables('SELECT * FROM film AS "f", payments')).toEqual(["film", "payments"]);
    expect(readStatementTables('SELECT * FROM film "f", payments')).toEqual(["film", "payments"]);
  });

  /*
    `replace` with a string pattern rewrites ONE occurrence, so a name with two doubled
    delimiters came back still holding one and never matched the inventory — a real
    table reported as unknown (#396 review).
  */
  test("every doubled delimiter in a quoted name is one literal character", () => {
    expect(readStatementTables('SELECT * FROM "a""b""c"')).toEqual(['a"b"c']);
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
    expect(validatePlanStatement("SELECT title FROM film JOIN actor ON true", INVENTORY, "sql")).toEqual({
      readOnly: true,
      guardApplicable: true,
      identifiers: { kind: "checked", unknownTables: [] },
    });
  });

  test("a table the inventory does not hold is recorded, and the statement is not dropped", () => {
    const validation = validatePlanStatement("SELECT * FROM film JOIN payments ON true", INVENTORY, "sql");

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
    expect(validatePlanStatement("SELECT * FROM film", INVENTORY, "sql").identifiers).toEqual({
      kind: "checked",
      unknownTables: [],
    });
    expect(validatePlanStatement("SELECT * FROM main.film", SQLITE_INVENTORY, "sql").identifiers).toEqual({
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
    expect(validatePlanStatement("SELECT * FROM anything", null, "sql").identifiers).toEqual({ kind: "no-inventory" });
  });

  /*
    The owner's decision: a write is MARKED, never blocked. The classification is the
    shared guard in `src/lib/db/operations/statement-guard.ts` and not a second SQL
    reader — two wordings of one rule is how #350 happened — so the violation it
    reports travels with the mark.
  */
  test("a write is marked with the guard's own reason, and still recorded", () => {
    expect(validatePlanStatement("DELETE FROM film", INVENTORY, "sql")).toEqual({
      readOnly: false,
      guardApplicable: true,
      guardViolation: "NON_READ_STATEMENT",
      identifiers: { kind: "checked", unknownTables: [] },
    });
  });

  test("a read carrying a writing CTE is marked too, since its head says nothing about what it does", () => {
    const validation = validatePlanStatement(
      "WITH gone AS (DELETE FROM film RETURNING id) SELECT * FROM gone",
      null,
      "sql",
    );

    expect(validation.readOnly).toBe(false);
    expect(validation.guardViolation).toBe("SIDE_EFFECT_KEYWORD");
  });

  test("two statements are not read-only either, and the guard says which objection it had", () => {
    expect(validatePlanStatement("SELECT 1; SELECT 2", null, "sql").guardViolation).toBe("MULTIPLE_STATEMENTS");
  });
});

/*
  #414. Grounding reached the engines that speak no SQL, and both halves of this
  validation were wrong on them at once — which was invisible until then, because
  nothing recorded a plan statement on an engine outside PostgreSQL and SQLite.

  The guard reads every string as SQL: `db.orders.aggregate([...])` leads with the word
  `DB`, `INFO memory` with `INFO`, `SCAN 0 MATCH ...` with `SCAN`, and none of those is
  in its read allowlist — so a correct, purely-reading MongoDB or Redis draft came back
  `NON_READ_STATEMENT` every time, and structurally so: no command of either engine can
  ever lead with SELECT, VALUES, TABLE or EXPLAIN. The identifier half is wrong in the
  opposite direction: `readStatementTables` finds no table keyword in any of them, so it
  answers `[]`, which `checked` renders as "every table it names is in the inventory".
*/
describe("an engine whose statements are not SQL is not judged by a SQL reader (#414)", () => {
  const AGGREGATION = 'db.orders.aggregate([{ $group: { _id: "$customerId", n: { $sum: 1 } } }])';

  test("the guard declines to judge rather than reporting an objection it did not have", () => {
    const validation = validatePlanStatement(AGGREGATION, INVENTORY, "json");

    expect(validation.guardApplicable).toBe(false);
    // `false` and not `true`: a guard that read nothing has established nothing, and
    // `true` here would be it vouching for text it never examined.
    expect(validation.readOnly).toBe(false);
    // And no reason code, because there was no objection — only a reader that does
    // not speak this language.
    expect(validation.guardViolation).toBeUndefined();
  });

  test("the identifier check declines too, even though this run HAS an inventory", () => {
    // The distinction `not-applicable` draws that `no-inventory` cannot: there is an
    // inventory here, and what is missing is a reader that can find a name in this
    // engine's language.
    expect(validatePlanStatement(AGGREGATION, INVENTORY, "json").identifiers).toEqual({ kind: "not-applicable" });
    expect(validatePlanStatement(AGGREGATION, null, "json").identifiers).toEqual({ kind: "not-applicable" });
  });

  test("a Redis reading is treated the same way, whatever its leading word happens to be", () => {
    for (const command of ["INFO memory", 'SCAN 0 MATCH "user:*" COUNT 100']) {
      const validation = validatePlanStatement(command, INVENTORY, "json");
      expect(validation.guardApplicable, command).toBe(false);
      expect(validation.identifiers, command).toEqual({ kind: "not-applicable" });
    }
  });

  test("the same text on a SQL engine IS judged, so the language is what decides and not the text", () => {
    const validation = validatePlanStatement(AGGREGATION, INVENTORY, "sql");

    expect(validation.guardApplicable).toBe(true);
    expect(validation.readOnly).toBe(false);
    expect(validation.guardViolation).toBe("NON_READ_STATEMENT");
  });
});

describe("a statement the model wrote without a fence", () => {
  /*
    Measured, and the two shapes it comes in have to be told apart.

    One model was asked for a plan and produced this, verbatim:

        sqlite
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' …

        The statement retrieves the names of the tables in the database. …

    It had understood the contract well enough to write the engine tag on its own line
    and the statement under it. It simply left out the backticks, and the run was scored
    `no-statement` — the plan-mode bar — for a formatting slip around a real statement.

    Another produced the other shape on the same objective:

        sqlite
        <sqlite>
        The tables are: current_dept_emp, department, dept_emp, …
        </sqlite>

    That is prose, and it must NOT be read as a statement. `plan-statement-drafted` is
    recorded whenever this reader returns one and the validation result rides along
    rather than gating it, so a reader that accepted this would score the run answered
    while the user looked at a sentence. The whole value of loosening the fence rule
    depends on it staying closed to that.

    So an unfenced candidate is accepted only when the text plainly opens a statement —
    a line beginning with a query verb. That admits the first and rejects the second,
    and the guard and identifier checks still judge what it admits.
  */
  const ENGINE_THEN_SQL = [
    "sqlite",
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';",
    "",
    "The statement retrieves the names of the tables in the database.",
  ].join("\n");

  const ENGINE_THEN_PROSE = ["sqlite", "<sqlite>", "The tables are: department, employee, salary.", "</sqlite>"].join(
    "\n",
  );

  test("an unfenced statement is read, because the slip is the backticks and not the SQL", () => {
    const draft = readPlanStatement(ENGINE_THEN_SQL, "sqlite");

    expect(draft.kind).toBe("statement");
    if (draft.kind !== "statement") throw new Error("expected a statement");
    expect(draft.sql).toStartWith("SELECT table_name");
    // The prose that followed it is not part of the statement.
    expect(draft.sql).not.toContain("The statement retrieves");
  });

  test("prose is still not a statement, however the model wrapped it", () => {
    expect(readPlanStatement(ENGINE_THEN_PROSE, "sqlite").kind).toBe("absent");
  });

  test("a fenced block still wins, so nothing about the normal path changes", () => {
    const both = ["Here is my plan.", "```sql", "SELECT 1;", "```", "SELECT 2;"].join("\n");

    const draft = readPlanStatement(both, "sqlite");

    if (draft.kind !== "statement") throw new Error("expected a statement");
    expect(draft.sql).toBe("SELECT 1;");
  });

  test("a refusal still wins over an unfenced statement, for the reason it wins over a fenced one", () => {
    // A run that declined and then illustrated has not produced a deliverable.
    const text = [`${PLAN_NO_STATEMENT_MARKER} Tell me which column records the price.`, "SELECT 1;"].join("\n");

    expect(readPlanStatement(text, "sqlite").kind).toBe("refusal");
  });
});
