import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QuerySafetyDialog, isDangerousQuery } from "@/components/QuerySafetyDialog";

function createStreamResponse({
  chunks,
  ok = true,
  status = 200,
  jsonBody = {},
}: {
  chunks: string[];
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
}) {
  let idx = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (idx >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = new TextEncoder().encode(chunks[idx]);
          idx += 1;
          return { done: false, value };
        },
      }),
    },
    json: async () => jsonBody,
  } as unknown as Response;
}

describe("QuerySafetyDialog", () => {
  const onClose = mock(() => {});
  const onProceed = mock(() => {});

  beforeEach(() => {
    onClose.mockClear();
    onProceed.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders nothing when dialog is closed", () => {
    const { container } = render(
      <QuerySafetyDialog isOpen={false} query="SELECT 1" schemaContext="" onClose={onClose} onProceed={onProceed} />,
    );
    expect(container.textContent).toBe("");
  });

  test("renders parsed high-risk analysis and caution action label", async () => {
    const payload = {
      riskLevel: "high",
      summary: "This query can update many rows.",
      warnings: [
        {
          type: "update",
          severity: "warning",
          message: "Potential full-table update",
          detail: "WHERE clause is too broad.",
        },
      ],
      affectedRows: "12000",
      cascadeEffects: "none",
      recommendation: "Add stricter predicates before execution.",
    };
    const markdownJson = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    globalThis.fetch = mock(async () => createStreamResponse({ chunks: [markdownJson] })) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="UPDATE users SET role = 'admin'"
        schemaContext='[{"name":"users","rowCount":12000,"columns":[{"name":"id","type":"integer"}]}]'
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("High Risk")).not.toBeNull();
      expect(queryByText("This query can update many rows.")).not.toBeNull();
      expect(queryByText("Potential full-table update")).not.toBeNull();
      expect(queryByText("Affected rows:")).not.toBeNull();
      expect(queryByText("Proceed with Caution")).not.toBeNull();
    });
  });

  test("shows raw response when analysis payload cannot be parsed", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: ["Plain text analysis output"] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM users WHERE id = 5"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Plain text analysis output")).not.toBeNull();
    });
  });

  test("shows API error message when backend returns non-ok response", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({
        chunks: [],
        ok: false,
        status: 400,
        jsonBody: { error: "Rate limit exceeded" },
      }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog isOpen query="DROP TABLE users" schemaContext="" onClose={onClose} onProceed={onProceed} />,
    );

    await waitFor(() => {
      expect(queryByText("Rate limit exceeded")).not.toBeNull();
    });
  });

  test("calls onClose and onProceed from action buttons", async () => {
    const safePayload = {
      riskLevel: "safe",
      summary: "Query looks safe.",
      warnings: [],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "Proceed.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(safePayload)] }),
    ) as unknown as typeof fetch;

    const { queryByText, container } = render(
      <QuerySafetyDialog isOpen query="SELECT * FROM users" schemaContext="" onClose={onClose} onProceed={onProceed} />,
    );

    await waitFor(() => {
      expect(queryByText("Execute Query")).not.toBeNull();
    });

    const cancelButton = queryByText("Cancel");
    expect(cancelButton).not.toBeNull();
    fireEvent.click(cancelButton!);
    expect(onClose).toHaveBeenCalled();

    const proceedButton = queryByText("Execute Query");
    expect(proceedButton).not.toBeNull();
    fireEvent.click(proceedButton!);
    expect(onProceed).toHaveBeenCalled();

    const closeIconButton = container.querySelector("button");
    expect(closeIconButton).not.toBeNull();
    fireEvent.click(closeIconButton!);
    expect(onClose.mock.calls.length).toBeGreaterThan(1);
  });

  test("truncates query preview at 300 characters with ellipsis", async () => {
    const longQuery = "SELECT " + "a".repeat(350) + " FROM users";
    const safePayload = {
      riskLevel: "safe",
      summary: "Safe query.",
      warnings: [],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "OK.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(safePayload)] }),
    ) as unknown as typeof fetch;

    const { container } = render(
      <QuerySafetyDialog isOpen query={longQuery} schemaContext="" onClose={onClose} onProceed={onProceed} />,
    );

    const preElement = container.querySelector("pre");
    expect(preElement).not.toBeNull();
    const preText = preElement!.textContent || "";
    expect(preText.length).toBeLessThanOrEqual(303); // 300 chars + '...'
    expect(preText.endsWith("...")).toBe(true);
    expect(preText).toBe(longQuery.substring(0, 300) + "...");
  });

  test('shows "Execute Anyway" button text for critical risk', async () => {
    const criticalPayload = {
      riskLevel: "critical",
      summary: "Extremely dangerous operation.",
      warnings: [],
      affectedRows: "all",
      cascadeEffects: "none",
      recommendation: "Do not execute.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [`\`\`\`json\n${JSON.stringify(criticalPayload)}\n\`\`\``] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DROP DATABASE production"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Execute Anyway")).not.toBeNull();
      expect(queryByText("Critical Risk")).not.toBeNull();
    });
  });

  test('shows "Proceed with Caution" for high risk', async () => {
    const highPayload = {
      riskLevel: "high",
      summary: "High risk detected.",
      warnings: [],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "Be careful.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(highPayload)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog isOpen query="DELETE FROM orders" schemaContext="" onClose={onClose} onProceed={onProceed} />,
    );

    await waitFor(() => {
      expect(queryByText("Proceed with Caution")).not.toBeNull();
    });
  });

  test('shows "Execute Query" for safe, low, and medium risk levels', async () => {
    for (const riskLevel of ["safe", "low", "medium"] as const) {
      cleanup();
      onClose.mockClear();
      onProceed.mockClear();

      const payload = {
        riskLevel,
        summary: `${riskLevel} level query.`,
        warnings: [],
        affectedRows: "none",
        cascadeEffects: "none",
        recommendation: "OK.",
      };
      globalThis.fetch = mock(async () =>
        createStreamResponse({ chunks: [JSON.stringify(payload)] }),
      ) as unknown as typeof fetch;

      const { queryByText } = render(
        <QuerySafetyDialog isOpen query="SELECT 1" schemaContext="" onClose={onClose} onProceed={onProceed} />,
      );

      await waitFor(() => {
        expect(queryByText("Execute Query")).not.toBeNull();
      });

      cleanup();
    }
  });

  test('displays cascadeEffects when not "none"', async () => {
    const payload = {
      riskLevel: "high",
      summary: "Cascade risk.",
      warnings: [],
      affectedRows: "none",
      cascadeEffects: "Will delete related rows in orders and invoices tables",
      recommendation: "Check FK constraints.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(payload)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM customers WHERE id = 1"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Cascade effects:")).not.toBeNull();
      expect(queryByText("Will delete related rows in orders and invoices tables")).not.toBeNull();
    });
  });

  test('displays affectedRows when not "none"', async () => {
    const payload = {
      riskLevel: "medium",
      summary: "Medium risk update.",
      warnings: [],
      affectedRows: "5000",
      cascadeEffects: "none",
      recommendation: "Double check.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(payload)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="UPDATE users SET status = 'inactive'"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Affected rows:")).not.toBeNull();
      expect(queryByText("5000")).not.toBeNull();
    });
  });

  test("applies correct severity styling to warnings (critical=red, warning=amber, info=blue)", async () => {
    const payload = {
      riskLevel: "high",
      summary: "Multiple warnings.",
      warnings: [
        { type: "drop", severity: "critical", message: "Critical warning", detail: "Critical detail" },
        { type: "update", severity: "warning", message: "Warning level", detail: "Warning detail" },
        { type: "select", severity: "info", message: "Info level", detail: "Info detail" },
      ],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "Review carefully.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(payload)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DROP TABLE important_data"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Critical warning")).not.toBeNull();
      expect(queryByText("Warning level")).not.toBeNull();
      expect(queryByText("Info level")).not.toBeNull();
    });

    const criticalEl = queryByText("Critical warning")!.closest("div");
    expect(criticalEl?.className).toContain("bg-red-500/5");
    expect(criticalEl?.className).toContain("border-red-500/20");

    const warningEl = queryByText("Warning level")!.closest("div");
    expect(warningEl?.className).toContain("bg-amber-500/5");
    expect(warningEl?.className).toContain("border-amber-500/20");

    const infoEl = queryByText("Info level")!.closest("div");
    expect(infoEl?.className).toContain("bg-blue-500/5");
    expect(infoEl?.className).toContain("border-blue-500/20");
  });

  test("uses onAnalyzeSafety adapter instead of fetch when provided", async () => {
    const fetchMock = mock(async () => createStreamResponse({ chunks: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapterAnalysis = {
      riskLevel: "medium" as const,
      summary: "Adapter analysis result.",
      warnings: [],
      affectedRows: "42",
      cascadeEffects: "none",
      recommendation: "Review before running.",
    };
    const onAnalyzeSafety = mock(async (_params: { query: string; schemaContext: string }) => adapterAnalysis);

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="UPDATE users SET active = false WHERE id = 1"
        schemaContext='[{"name":"users","rowCount":42,"columns":[{"name":"id","type":"integer"}]}]'
        onClose={onClose}
        onProceed={onProceed}
        onAnalyzeSafety={onAnalyzeSafety}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Medium Risk")).not.toBeNull();
      expect(queryByText("Adapter analysis result.")).not.toBeNull();
      expect(queryByText("42")).not.toBeNull();
    });

    expect(onAnalyzeSafety).toHaveBeenCalledTimes(1);
    const params = onAnalyzeSafety.mock.calls[0][0];
    expect(params.query).toBe("UPDATE users SET active = false WHERE id = 1");
    expect(params.schemaContext).toContain("users (42 rows)");
    expect(params.schemaContext).toContain("id (integer)");
    // The built-in fetch path must be bypassed entirely
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows error when onAnalyzeSafety adapter rejects", async () => {
    const onAnalyzeSafety = mock(async (_params: { query: string; schemaContext: string }) => {
      throw new Error("Adapter unavailable");
    });

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM users WHERE id = 1"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
        onAnalyzeSafety={onAnalyzeSafety}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Adapter unavailable")).not.toBeNull();
    });
  });

  test("falls back to substring truncation when schemaContext is invalid JSON", async () => {
    const invalidSchema = "this is not valid JSON but is longer than we need for testing purposes";
    const safePayload = {
      riskLevel: "safe",
      summary: "Query is safe.",
      warnings: [],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "Proceed.",
    };
    const fetchMock = mock(async () => createStreamResponse({ chunks: [JSON.stringify(safePayload)] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="SELECT * FROM users"
        schemaContext={invalidSchema}
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Query is safe.")).not.toBeNull();
    });

    // Verify fetch was called with the fallback truncated schema (substring of invalid JSON)
    expect(fetchMock).toHaveBeenCalled();
    const callBody = JSON.parse(((fetchMock.mock.calls as unknown[][])[0][1] as RequestInit).body as string);
    expect(callBody.schemaContext).toBe(invalidSchema.substring(0, 2000));
  });

  test("parses plain JSON response without code block wrapping", async () => {
    const payload = {
      riskLevel: "low",
      summary: "Low risk query detected.",
      warnings: [{ type: "select", severity: "info", message: "Large result set", detail: "May return many rows." }],
      affectedRows: "none",
      cascadeEffects: "none",
      recommendation: "Consider adding LIMIT.",
    };
    // Send plain JSON without ```json wrapper
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(payload)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="SELECT * FROM large_table"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Low Risk")).not.toBeNull();
      expect(queryByText("Low risk query detected.")).not.toBeNull();
      expect(queryByText("Large result set")).not.toBeNull();
      expect(queryByText("Execute Query")).not.toBeNull();
    });
  });

  test("displays raw response text when JSON parsing fails completely", async () => {
    const rawText = "The query appears safe but I cannot provide structured analysis right now.";
    globalThis.fetch = mock(async () => createStreamResponse({ chunks: [rawText] })) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM temp_table WHERE created < NOW()"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText(rawText)).not.toBeNull();
    });
  });

  test("high and critical risk buttons have red background class", async () => {
    // Test critical risk button
    const criticalPayload = {
      riskLevel: "critical",
      summary: "Critical operation.",
      warnings: [],
      affectedRows: "all",
      cascadeEffects: "none",
      recommendation: "Stop.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(criticalPayload)] }),
    ) as unknown as typeof fetch;

    const { queryByText, unmount } = render(
      <QuerySafetyDialog
        isOpen
        query="TRUNCATE TABLE users"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(queryByText("Execute Anyway")).not.toBeNull();
    });

    const criticalButton = queryByText("Execute Anyway")!.closest("button");
    expect(criticalButton?.className).toContain("bg-red-600");

    unmount();
    cleanup();

    // Test high risk button
    const highPayload = {
      riskLevel: "high",
      summary: "High risk operation.",
      warnings: [],
      affectedRows: "10000",
      cascadeEffects: "none",
      recommendation: "Be very careful.",
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(highPayload)] }),
    ) as unknown as typeof fetch;

    const result2 = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM audit_log"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    await waitFor(() => {
      expect(result2.queryByText("Proceed with Caution")).not.toBeNull();
    });

    const highButton = result2.queryByText("Proceed with Caution")!.closest("button");
    expect(highButton?.className).toContain("bg-red-600");
  });
});

describe("isDangerousQuery", () => {
  test("detects dangerous DML and DDL statements", () => {
    expect(isDangerousQuery("DELETE FROM users")).toBe(true);
    expect(isDangerousQuery("DROP TABLE users")).toBe(true);
    expect(isDangerousQuery("ALTER TABLE users ADD COLUMN x int")).toBe(true);
    expect(isDangerousQuery("GRANT SELECT ON users TO analyst")).toBe(true);
  });

  test("detects UPDATE/DELETE without WHERE as dangerous", () => {
    expect(isDangerousQuery("UPDATE users SET active = false")).toBe(true);
    expect(isDangerousQuery("DELETE FROM sessions")).toBe(true);
  });

  test("allows read-only queries", () => {
    expect(isDangerousQuery("SELECT * FROM users")).toBe(false);
    expect(isDangerousQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(false);
  });

  // ── A comment cannot hide the statement (#294) ───────────────────────────

  /**
   * The predicate used to re-derive the leading-keyword test with its own anchored
   * patterns (`/^\s*DROP\b/i`, …), which tolerate whitespace but not a comment. So
   * writing a note above a destructive statement - the most ordinary habit there is
   * - skipped the confirmation dialog entirely on both execution paths.
   */
  test.each<[string, string]>([
    ["a line comment", "-- cleanup\nDROP TABLE users"],
    ["a block comment", "/* nightly */ TRUNCATE TABLE audit"],
    ["stacked comments", "-- one\n/* two */\n-- three\nDELETE FROM sessions"],
    ["a MySQL hash comment", "# note\nDELETE FROM sessions"],
    ["an indented comment", "   -- note\n   ALTER TABLE users ADD COLUMN x int"],
    ["a comment above GRANT", "-- audit\nGRANT SELECT ON users TO analyst"],
    ["a comment above REVOKE", "/* audit */ REVOKE SELECT ON users FROM analyst"],
    ["a comment above UPDATE", "-- fix\nUPDATE users SET admin = true"],
  ])("prompts for a destructive statement behind %s", (_label, query) => {
    expect(isDangerousQuery(query)).toBe(true);
  });

  test.each<[string, string]>([
    ["a plain read", "SELECT * FROM users"],
    ["a read behind a comment", "-- daily report\nSELECT * FROM users"],
    ["a read whose comment names DROP", "SELECT * FROM t -- DROP TABLE users"],
    ["a read whose comment names UPDATE ... SET", "SELECT * FROM t /* UPDATE t SET x = 1 */"],
    ["a read quoting UPDATE ... SET in a string", "SELECT note FROM logs WHERE note = 'UPDATE t SET x = 1'"],
    ["a read of a column named UPDATE", 'SELECT "UPDATE" FROM audit'],
  ])("never prompts for %s", (_label, query) => {
    expect(isDangerousQuery(query)).toBe(false);
  });

  // ── Writes a read-shaped statement carries ───────────────────────────────

  /**
   * The `UPDATE … SET` probe is deliberately NOT anchored to the statement's own
   * keyword, unlike the vocabulary test above.
   *
   * PostgreSQL's data-modifying CTE is OPERATED by its `SELECT` - which is the
   * honest answer, and the one the query limiter needs to avoid bounding the rows a
   * write commits (#287) - so anchoring this probe too would take the last human
   * check away from a statement that really does write. The probe reads the
   * statement's CODE (`findCodeWord`), so the cost of keeping it unanchored is no
   * longer a prompt on every read that merely mentions both words: the two string
   * and comment cases above used to prompt and now do not.
   */
  test("prompts for a write hidden inside a read-shaped statement", () => {
    expect(isDangerousQuery("WITH moved AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM moved")).toBe(true);
  });

  test("prompts for a destructive statement a CTE list only precedes", () => {
    expect(isDangerousQuery("WITH x AS (SELECT id FROM t) DELETE FROM t USING x WHERE t.id = x.id")).toBe(true);
  });

  // ── Nothing to read ─────────────────────────────────────────────────────

  test.each<[string, string]>([
    ["empty text", ""],
    ["whitespace only", "   \n"],
    ["a comment only", "-- just a note"],
    ["a parenthesised read", "(SELECT 1)"],
  ])("does not prompt for %s, which is not a statement", (_label, query) => {
    expect(isDangerousQuery(query)).toBe(false);
  });

  /**
   * A `WITH` whose list never closes cannot be read, so the destructive keyword
   * inside it is not reported. No dialect accepts the text either, so what the
   * server receives is a syntax error rather than a dropped table - pinned so the
   * gap stays a decision.
   */
  test("does not prompt when the statement's shape cannot be read at all", () => {
    expect(isDangerousQuery("WITH t AS (DELETE FROM x")).toBe(false);
  });

  /**
   * The gaps this predicate does NOT close, pinned so each stays a decision and so
   * `docs/editor/query-optimization.md` cannot drift from them.
   *
   * The write-inside-a-read probe looks for `UPDATE … SET` only, because widening it
   * to the other write keywords would make every read whose code names one of them
   * prompt. And the whole editor text is read as one statement, so a destructive
   * statement later in a script is only caught by that same unanchored probe.
   */
  test.each<[string, string, boolean]>([
    ["a DELETE hidden in a CTE body", "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone", false],
    ["a DROP after a leading SELECT", "SELECT 1; DROP TABLE users", false],
    ["an UPDATE after a leading SELECT", "SELECT 1;\nUPDATE t SET x = 1", true],
    ["a write behind an undeterminable literal", "SELECT '\\';\nUPDATE t SET x = 1", false],
  ])("answers %s with %p", (_label, query, expected) => {
    expect(isDangerousQuery(query)).toBe(expected);
  });

  // ── Shape of the scan ───────────────────────────────────────────────────

  /**
   * A timing guard: this predicate runs on the editor's execute path, and the
   * pattern it replaced was measurably quadratic.
   *
   * `/\bUPDATE\b[\s\S]*?\bSET\b/i` restarts its lazy tail at every `UPDATE` in the
   * text, so a script holding many of them and no `SET` cost one full scan each -
   * measured on the real export before this change: 10.5ms at 14 KB, **1025ms at
   * 140 KB**, 6406ms at 350 KB. A pasted migration script reaches those sizes.
   *
   * The statement below leads with `SELECT` on purpose: a leading `UPDATE` is
   * answered by the vocabulary test without the probe ever running, so it would
   * guard nothing.
   */
  test("answers in bounded time on a statement holding many UPDATE words and no SET", () => {
    const query = `SELECT ${"UPDATE ".repeat(20000)}(`;

    const started = performance.now();
    const dangerous = isDangerousQuery(query);
    const elapsed = performance.now() - started;

    expect(dangerous).toBe(false);
    expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
  });
});
