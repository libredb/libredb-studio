import { describe, expect, test } from "bun:test";
import { AgentRepairLedger, AgentRepairLedgerError, fingerprintStatement } from "@/lib/agent/repair-ledger";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";

/**
 * The bounded repair loop and the statement fingerprint it keys on (#329 T6).
 *
 * Two properties carry the acceptance bar, and the fingerprint tests exist to
 * serve the second one: a normalisation a model can evade with a space is not a
 * ledger. Every "these two are the same statement" case below is therefore an
 * assertion about what CANNOT be retried, not a cosmetic one.
 */

describe("fingerprintStatement — canonical form", () => {
  test("is a stable hex digest, so it can travel in a durable record", () => {
    expect(fingerprintStatement("SELECT id FROM orders")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic across calls", () => {
    expect(fingerprintStatement("SELECT 1")).toBe(fingerprintStatement("SELECT 1"));
  });

  test("ignores the case of the statement's own code", () => {
    expect(fingerprintStatement("select id from orders")).toBe(fingerprintStatement("SELECT ID FROM ORDERS"));
  });

  test("ignores how much whitespace separates tokens", () => {
    expect(fingerprintStatement("SELECT   id\n\tFROM  orders")).toBe(fingerprintStatement("SELECT id FROM orders"));
  });

  test("ignores whether a token is separated from a literal at all", () => {
    // The evasion this closes: `SELECT'x'` and `SELECT 'x'` are the same
    // statement, so a retry must not slip past the ledger by deleting a space.
    expect(fingerprintStatement("SELECT'x'")).toBe(fingerprintStatement("SELECT 'x'"));
  });

  test("ignores comments, wherever they sit", () => {
    expect(fingerprintStatement("/* pick one */ SELECT id -- the key\nFROM orders")).toBe(
      fingerprintStatement("SELECT id FROM orders"),
    );
  });

  test("ignores a trailing terminator", () => {
    expect(fingerprintStatement("SELECT id FROM orders;")).toBe(fingerprintStatement("SELECT id FROM orders"));
    expect(fingerprintStatement("SELECT id FROM orders;  ")).toBe(fingerprintStatement("SELECT id FROM orders"));
  });

  /**
   * An INTERIOR terminator is kept, and the reason is not symmetry.
   *
   * The guard answers `MULTIPLE_STATEMENTS` for the first of these and ADMITS the
   * second (asserted below, so this test fails if that ever stops being true). If the
   * two shared a fingerprint, the admitted concatenation could run, fail at the
   * engine and enter the ledger — after which the genuine multi-statement probe would
   * come back as `STATEMENT_ALREADY_FAILED`, which this layer does not audit, instead
   * of the input-validation denial that it does.
   */
  test("keeps an interior terminator, so a multi-statement probe is not merged with a concatenation", () => {
    expect(inspectAgentStatement("SELECT 1; SELECT 2")).toBe("MULTIPLE_STATEMENTS");
    expect(inspectAgentStatement("SELECT 1 SELECT 2")).toBeNull();

    expect(fingerprintStatement("SELECT 1; SELECT 2")).not.toBe(fingerprintStatement("SELECT 1 SELECT 2"));
  });

  test("keeps a string literal's own case — the value is the meaning", () => {
    expect(fingerprintStatement("SELECT 'Ada'")).not.toBe(fingerprintStatement("SELECT 'ada'"));
  });

  test("keeps a quoted identifier's exact spelling, so quoting stays a real repair", () => {
    // Quoting is NOT canonicalised away, and the guard is the reason. It refuses
    // `SELECT copy FROM ads` because `copy` reads as a side-effect word and admits
    // the quoted form, so the two are genuinely different statements to this layer:
    // merging them would make the documented repair unaskable. The same holds for a
    // word only the ENGINE reserves (`select`, `order`), which the guard's word sets
    // do not contain at all — so no exclusion list could have made merging safe.
    expect(fingerprintStatement("SELECT copy FROM ads")).not.toBe(fingerprintStatement('SELECT "copy" FROM ads'));
    expect(fingerprintStatement("SELECT select FROM t")).not.toBe(fingerprintStatement('SELECT "select" FROM t'));
    expect(fingerprintStatement('SELECT "Id" FROM orders')).not.toBe(fingerprintStatement('SELECT "id" FROM orders'));
  });

  test("does not see through a re-spelling — the recorded under-refusal, bounded by the budget", () => {
    // Honest about the residual rather than implying the fingerprint closes it:
    // these all name one relation on the engines this milestone serves, and each
    // gets its own fingerprint. The repair budget is what bounds the waste, which
    // the ledger tests below assert.
    const bare = fingerprintStatement("SELECT x FROM orders");
    for (const respelling of [
      'SELECT x FROM "orders"',
      "SELECT x FROM `orders`",
      "SELECT x FROM [orders]",
      'SELECT x FROM "ORDERS"',
    ]) {
      expect(fingerprintStatement(respelling), respelling).not.toBe(bare);
    }
  });

  test("distinguishes a subscript from a differently spaced one", () => {
    expect(fingerprintStatement("SELECT a[1] FROM t")).not.toBe(fingerprintStatement("SELECT a[ 1 ] FROM t"));
  });

  test("distinguishes statements that differ only in a predicate", () => {
    expect(fingerprintStatement("SELECT id FROM orders WHERE id = 1")).not.toBe(
      fingerprintStatement("SELECT id FROM orders WHERE id = 2"),
    );
  });

  test("distinguishes a joined number run from two separate numbers", () => {
    expect(fingerprintStatement("SELECT 12")).not.toBe(fingerprintStatement("SELECT 1, 2"));
  });

  test("answers for an empty statement rather than throwing", () => {
    expect(fingerprintStatement("")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintStatement("   ")).toBe(fingerprintStatement(""));
  });

  test("answers for text carrying an unterminated literal", () => {
    // The statement guard refuses this shape, but the ledger is consulted BEFORE
    // the policy pipeline, so the fingerprint has to be defined for it.
    expect(fingerprintStatement("SELECT 'oops")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AgentRepairLedger — admitting a statement", () => {
  test("admits a statement it has never seen", () => {
    const ledger = new AgentRepairLedger();

    expect(ledger.admit(fingerprintStatement("SELECT 1"))).toEqual({ admitted: true });
  });

  test("refuses the identical statement on the second attempt after a database failure", () => {
    const ledger = new AgentRepairLedger();
    const fingerprint = fingerprintStatement("SELECT id FROM ordrs");

    expect(ledger.admit(fingerprint)).toEqual({ admitted: true });
    ledger.recordFailure(fingerprint, "database-error");

    expect(ledger.admit(fingerprint)).toEqual({ admitted: false, reasonCode: "STATEMENT_ALREADY_FAILED" });
  });

  test("refuses a re-spelled retry of the same failing statement", () => {
    const ledger = new AgentRepairLedger();
    ledger.recordFailure(fingerprintStatement("select id from ordrs"), "database-error");

    const retry = ledger.admit(fingerprintStatement("SELECT   id\nFROM ordrs;"));

    expect(retry).toEqual({ admitted: false, reasonCode: "STATEMENT_ALREADY_FAILED" });
  });

  test("still admits a genuinely different repair", () => {
    const ledger = new AgentRepairLedger();
    ledger.recordFailure(fingerprintStatement("SELECT id FROM ordrs"), "database-error");

    expect(ledger.admit(fingerprintStatement("SELECT id FROM orders"))).toEqual({ admitted: true });
  });
});

describe("AgentRepairLedger — the repair budget", () => {
  test("admits three database-error repairs and refuses the fourth statement", () => {
    const ledger = new AgentRepairLedger();

    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 3"]) {
      const fingerprint = fingerprintStatement(sql);
      expect(ledger.admit(fingerprint), `attempt for ${sql}`).toEqual({ admitted: true });
      ledger.recordFailure(fingerprint, "database-error");
    }

    expect(ledger.admit(fingerprintStatement("SELECT 4"))).toEqual({
      admitted: false,
      reasonCode: "REPAIR_BUDGET_EXHAUSTED",
    });
    expect(ledger.attemptsUsed).toBe(3);
  });

  test("a policy denial does not consume a repair attempt", () => {
    const ledger = new AgentRepairLedger();
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 3", "SELECT 4"]) {
      ledger.recordFailure(fingerprintStatement(sql), "policy-denied");
    }

    expect(ledger.attemptsUsed).toBe(0);
    expect(ledger.admit(fingerprintStatement("SELECT 5"))).toEqual({ admitted: true });
  });

  test("an approval requirement does not consume a repair attempt either", () => {
    const ledger = new AgentRepairLedger();
    ledger.recordFailure(fingerprintStatement("SELECT 1"), "approval-required");

    expect(ledger.attemptsUsed).toBe(0);
  });

  test("nor does a database error the SERVER answered, though it is still unrepeatable", () => {
    /*
      Measured, and it is the whole of why this class exists. Five `lfm2:24b` data-analysis runs
      were driven at one sitting and all five ended identically: three `no such column` errors,
      the budget spent, and the FOURTH statement — the correct one in the run that was read in
      full — refused before it reached the database. Not one of the five produced a single
      successful read, so every report rested on a table profile and every verdict said
      `no-answer`.

      The budget is right and stays at three. What was wrong is counting these against it. This
      layer's own rule is that a boundary decision costs nothing because "nothing ran, and a
      boundary decision is not a defect in a statement the model could fix" — and a statement
      whose error the server answered with the columns that DO exist is the same shape seen from
      the other side: the model is not guessing again, it is applying a correction this server
      dictated. What the budget exists to bound is a model inventing spellings, and it still does.

      Deliberately NOT decided by reading the engine's message. That text is untrusted input
      everywhere else in this system, and control flow that parsed it would be trusting a database
      to say how many attempts a run has left. The caller decides on ITS OWN state — whether it
      could build the advice from the inventory this process is holding — and passes the answer in.

      The fingerprint is still recorded, so the same statement can never be sent twice. That half
      is what stops a loop, and it is untouched.
    */
    const ledger = new AgentRepairLedger();
    const answered = ["SELECT a FROM t", "SELECT b FROM t", "SELECT c FROM t", "SELECT d FROM t"];
    for (const sql of answered) ledger.recordFailure(fingerprintStatement(sql), "database-error-answered");

    expect(ledger.attemptsUsed).toBe(0);
    // The fifth spelling still runs: four answered failures have not closed the door.
    expect(ledger.admit(fingerprintStatement("SELECT e FROM t"))).toEqual({ admitted: true });
    // But none of the four may be sent again.
    for (const sql of answered) {
      expect(ledger.admit(fingerprintStatement(sql))).toEqual({
        admitted: false,
        reasonCode: "STATEMENT_ALREADY_FAILED",
      });
    }
  });

  test("an unanswered database error still costs one, so a guessing model is still bounded", () => {
    // The half that must not move. The budget's purpose is a model inventing spellings the
    // server cannot help with, and that model reaches the same wall it always did.
    const ledger = new AgentRepairLedger();
    ledger.recordFailure(fingerprintStatement("SELECT 1"), "database-error-answered");
    for (const sql of ["SELECT 2", "SELECT 3", "SELECT 4"]) {
      ledger.recordFailure(fingerprintStatement(sql), "database-error");
    }

    expect(ledger.attemptsUsed).toBe(3);
    expect(ledger.admit(fingerprintStatement("SELECT 5"))).toEqual({
      admitted: false,
      reasonCode: "REPAIR_BUDGET_EXHAUSTED",
    });
  });

  test("a denied statement is still never re-asked — the fingerprint is recorded regardless of class", () => {
    const ledger = new AgentRepairLedger();
    const fingerprint = fingerprintStatement("DELETE FROM orders");
    ledger.recordFailure(fingerprint, "policy-denied");

    expect(ledger.admit(fingerprint)).toEqual({ admitted: false, reasonCode: "STATEMENT_ALREADY_FAILED" });
  });

  test("the already-failed answer takes precedence over an exhausted budget", () => {
    // Both refuse, but they tell the model different things: draft something
    // else, versus stop drafting. The more specific one has to win.
    const ledger = new AgentRepairLedger();
    const first = fingerprintStatement("SELECT 1");
    for (const sql of ["SELECT 1", "SELECT 2", "SELECT 3"]) {
      ledger.recordFailure(fingerprintStatement(sql), "database-error");
    }

    expect(ledger.admit(first)).toEqual({ admitted: false, reasonCode: "STATEMENT_ALREADY_FAILED" });
  });

  test("a statement that succeeded is not recorded, so an identical verified read may be re-run", () => {
    const ledger = new AgentRepairLedger();
    const fingerprint = fingerprintStatement("SELECT id FROM orders");

    expect(ledger.admit(fingerprint)).toEqual({ admitted: true });
    expect(ledger.admit(fingerprint)).toEqual({ admitted: true });
    expect(ledger.attemptsUsed).toBe(0);
  });

  test("refuses a blank fingerprint loudly — a ledger keyed on nothing bounds nothing", () => {
    const ledger = new AgentRepairLedger();

    // The typed class, not just the message: a caller has to be able to branch on it
    // rather than parse prose, which is this repository's standing rule for refusals.
    expect(() => ledger.admit("  ")).toThrow(AgentRepairLedgerError);
    expect(() => ledger.admit("  ")).toThrow(/fingerprint/);
    expect(() => ledger.recordFailure("", "database-error")).toThrow(AgentRepairLedgerError);
  });

  test("takes the repair bound from the shared constant rather than hardcoding it twice", async () => {
    const { AGENT_MAX_REPAIR_ATTEMPTS } = await import("@/lib/agent/execution-policy");
    const ledger = new AgentRepairLedger();

    for (let i = 0; i < AGENT_MAX_REPAIR_ATTEMPTS; i++) {
      ledger.recordFailure(fingerprintStatement(`SELECT ${i}`), "database-error");
    }

    expect(ledger.admit(fingerprintStatement("SELECT 'next'"))).toEqual({
      admitted: false,
      reasonCode: "REPAIR_BUDGET_EXHAUSTED",
    });
  });
});
