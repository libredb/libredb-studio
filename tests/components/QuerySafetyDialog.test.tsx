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

  // ── Honesty about text the reading could not resolve (#297) ────────────────
  //
  // The gate now opens this dialog for a statement carrying a run no reader can
  // resolve, and a silent `true` would be only half of the bar: the operator is
  // then reading a risk analysis produced from text whose reading stopped early.
  // So the dialog says which of the two situations it is in.

  const UNREADABLE_QUERY = "SELECT '\\';\nUPDATE t SET x = 1";

  const SAFE_PAYLOAD = {
    riskLevel: "safe",
    summary: "Read-only query.",
    warnings: [],
    affectedRows: "none",
    cascadeEffects: "none",
    recommendation: "Proceed.",
  };

  test("says part of the statement could not be read, and that this is why it asks", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(SAFE_PAYLOAD)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query={UNREADABLE_QUERY}
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    // Said immediately, without waiting on the analysis: the reason for asking is
    // this client-side reading, not anything the model returns.
    expect(queryByText("Part of this statement could not be read")).not.toBeNull();
    expect(queryByText(/never closes/)).not.toBeNull();
    expect(queryByText(/why you are being asked/)).not.toBeNull();

    // And it goes on saying so BESIDE a verdict that read the statement as safe.
    // The analysis was produced from text whose reading stopped early, so a "Safe"
    // answer is not allowed to be the last thing the operator sees.
    await waitFor(() => {
      expect(queryByText("Safe")).not.toBeNull();
    });
    expect(queryByText("Part of this statement could not be read")).not.toBeNull();
  });

  test("says nothing of the kind for a statement it read whole", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(SAFE_PAYLOAD)] }),
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM users WHERE id = 5"
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );

    expect(queryByText("Part of this statement could not be read")).toBeNull();

    await waitFor(() => {
      expect(queryByText("Safe")).not.toBeNull();
    });
    expect(queryByText("Part of this statement could not be read")).toBeNull();
  });

  /**
   * The notice is the DIALECT's answer, like the gate that opened the dialog: the
   * component already receives the connection's type, so it resolves the grammar
   * itself rather than being told what to say.
   */
  test("reads the statement under the dialect it was given", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(SAFE_PAYLOAD)] }),
    ) as unknown as typeof fetch;

    // An Oracle alternate-quoted literal: an unresolvable run to a reader that does
    // not have the form, one closed literal to Oracle's.
    const alternateQuoted = "SELECT q'{it's}' FROM dual";

    const { queryByText, unmount } = render(
      <QuerySafetyDialog
        isOpen
        query={alternateQuoted}
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );
    expect(queryByText("Part of this statement could not be read")).not.toBeNull();

    unmount();
    cleanup();

    const onOracle = render(
      <QuerySafetyDialog
        isOpen
        query={alternateQuoted}
        schemaContext=""
        databaseType="oracle"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );
    expect(onOracle.queryByText("Part of this statement could not be read")).toBeNull();
  });

  /**
   * The nesting fact reaches the notice as well (#300), and the two halves of that
   * issue's dialog bar are visible here side by side: a nested comment that never
   * closes is text the reader could not resolve and the notice says so, while a
   * balanced one was read WHOLE - the dialog is open because the statement really
   * is a `DROP`, and claiming the text could not be read would be the false half.
   */
  test("says so for a nested comment that never closes, and nothing for one that does", async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(SAFE_PAYLOAD)] }),
    ) as unknown as typeof fetch;

    const unclosed = render(
      <QuerySafetyDialog
        isOpen
        query="/* outer /* inner */ DROP TABLE users"
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );
    expect(unclosed.queryByText("Part of this statement could not be read")).not.toBeNull();

    unclosed.unmount();
    cleanup();

    const balanced = render(
      <QuerySafetyDialog
        isOpen
        query="/* outer /* inner */ still a note */ DROP TABLE users"
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );
    expect(balanced.queryByText("Part of this statement could not be read")).toBeNull();
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
   * A `WITH` whose list never closes cannot be TYPED, so the destructive keyword
   * inside it is not reported. No dialect accepts the text either, so what the
   * server receives is a syntax error rather than a dropped table - pinned so the
   * gap stays a decision.
   *
   * This is the boundary of #297's rule, which is about text no reader can RESOLVE:
   * here every character was read, and the shape it spells is an incomplete
   * statement rather than a run hiding what is written inside it. The keyword inside
   * the unclosed list is a CTE-body write, which the row above pins as not prompting
   * even when the list DOES close - so the answer is inherited from that gap, not
   * from the reading stopping early.
   */
  test("does not prompt when the statement's shape cannot be typed", () => {
    expect(isDangerousQuery("WITH t AS (DELETE FROM x")).toBe(false);
  });

  /**
   * The gaps this predicate does NOT close, pinned so each stays a decision and so
   * `docs/editor/query-optimization.md` cannot drift from them.
   *
   * The write-inside-a-read probe looks for `UPDATE … SET` only, because widening it
   * to the other write keywords would make every read whose code names one of them
   * prompt.
   *
   * The gap this list used to record beside it - "the whole editor text is read as one
   * statement, so a destructive statement later in a script is only caught by that same
   * unanchored probe" - is closed (S1): the predicate now reads the SAME fragments
   * `/api/db/multi-query` will run, so a later `DROP` is answered by its own fragment's
   * keyword rather than by luck. The row below is kept, with the answer it now has,
   * because a regression there is silence on a script's second statement.
   */
  test.each<[string, string, boolean]>([
    ["a DELETE hidden in a CTE body", "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone", false],
    ["a DROP after a leading SELECT", "SELECT 1; DROP TABLE users", true],
    ["an UPDATE after a leading SELECT", "SELECT 1;\nUPDATE t SET x = 1", true],
  ])("answers %s with %p", (_label, query, expected) => {
    expect(isDangerousQuery(query)).toBe(expected);
  });

  // ── Text no reader can resolve asks instead of staying silent (#297) ──────
  //
  // Every OTHER reader in `src/lib/sql/` errs toward not ACTING on text it cannot
  // resolve, and that is the safe direction for them: their mistake is a row bound
  // appended to a write, i.e. a partial commit. Here the costs are reversed - a
  // false prompt costs one click, silence costs an unconfirmed destructive
  // statement - so this predicate reads the span reader's `terminated: false` as
  // its own answer rather than discarding it.

  test("prompts for a write hidden behind an undeterminable literal", () => {
    // `'\'` closes the string under PostgreSQL's reading and continues it under
    // MySQL's, so `spans.ts` declines to guess and everything after the quote is
    // invisible to a reader walking code words. The write is the second statement
    // of a script node-postgres sends through the simple query protocol.
    expect(isDangerousQuery("SELECT '\\';\nUPDATE t SET x = 1")).toBe(true);
    // Not only the unanchored probe's vocabulary: a DROP written there was
    // invisible too, and this predicate never looked for it past the leading word.
    expect(isDangerousQuery("SELECT '\\';\nDROP TABLE users")).toBe(true);
  });

  test.each<[string, string]>([
    ["a literal that never closes", "SELECT 'unclosed FROM t"],
    ["a block comment that never closes", "SELECT 1 /* unclosed"],
    ["a dollar-quoted body that never closes", "SELECT $fn$ begin"],
    ["a bracket-quoted name that never closes", "SELECT [name FROM t"],
    ["a double-quoted name that never closes", 'SELECT "name FROM t'],
  ])("prompts for %s", (_label, query) => {
    expect(isDangerousQuery(query)).toBe(true);
  });

  /**
   * The cost of asking, bounded by assertion rather than by hope.
   *
   * The reason this predicate stayed silent was the false prompts the honest answer
   * buys: `spans.ts` reports an undeterminable literal for any closing quote behind
   * an ODD backslash run, and a legitimate PostgreSQL literal ending in a backslash
   * is exactly that shape. What must NOT happen is a prompt for every statement
   * that merely CONTAINS a backslash, which is what a text-level backslash test
   * would have produced.
   */
  test.each<[string, string]>([
    ["a backslash inside a literal", "SELECT 'a\\nb' FROM t"],
    ["a literal ending in a doubled backslash", "SELECT 'C:\\\\Users\\\\me' FROM files"],
    ["an escaped LIKE wildcard", "SELECT * FROM t WHERE p LIKE 'a\\_b'"],
    ["a backslash in a comment", "-- C:\\\nSELECT 1"],
  ])("never prompts for %s, whose runs all resolve", (_label, query) => {
    expect(isDangerousQuery(query)).toBe(false);
  });

  /**
   * The most frequent prompt this rule buys, named rather than left to be
   * discovered: `\'` is MySQL's OWN escape for an apostrophe, and `spans.ts` reports
   * any closing quote behind an odd backslash run as undeterminable whatever the
   * dialect - backslash semantics are deliberately not a fact the grammar record
   * carries yet, because fixtures across this milestone rest on the undeterminable
   * reading. So an everyday MySQL read asks, and naming the dialect does not narrow
   * it: this is the one cost the channel cannot resolve today.
   */
  test("prompts for a literal escaping its apostrophe with a backslash, under either dialect", () => {
    const everyday = "SELECT * FROM t WHERE name = 'it\\'s'";

    expect(isDangerousQuery(everyday, "mysql")).toBe(true);
    expect(isDangerousQuery(everyday, "postgres")).toBe(true);
  });

  /**
   * PostgreSQL reads `[…]` as a subscript, so none of these is unresolvable and an
   * everyday read does not ask. The rule was established from the manual (4.2.3
   * Subscripts, 4.2.12 Array Constructors, whose own example is
   * `SELECT ARRAY[[1,2],[3,4]]`) after the dialect was briefly left at the
   * compatibility NAME reading, which could not close a nested array or a key
   * carrying a `]` and therefore prompted on ordinary statements. A confirmation
   * the operator learns to click through protects nothing, so a false prompt on
   * everyday syntax is not the cheap direction it looks like.
   */
  test.each<[string, string]>([
    ["a nested array", "SELECT ARRAY[[1,2],[3,4]] AS a FROM t"],
    ["a subscript key holding a close bracket", "SELECT j['a]b'] FROM t"],
    ["a nested subscript", "SELECT t.data[idx[0]] FROM t"],
    ["an ordinary subscript and array literal", "SELECT a[1], ARRAY[1,2] FROM t"],
  ])("does not prompt for %s on PostgreSQL", (_label, query) => {
    expect(isDangerousQuery(query, "postgres")).toBe(false);
  });

  // The reading is a reading, not a licence: a subscript run that never closes is
  // still unresolvable, and a write inside one still asks.
  test("still prompts where a PostgreSQL subscript run does not close", () => {
    expect(isDangerousQuery("SELECT ARRAY[[1,2] AS a FROM t", "postgres")).toBe(true);
  });

  /**
   * The same class on SQLite, because the shared name reading honours SQL Server's
   * doubled `]` for it: the escape swallows the real closer, so the run never
   * terminates and the statement asks. SQLite rejects the text either way - recorded
   * in `docs/providers/sqlite.md` beside the bound that divergence already cost.
   */
  test("prompts for a SQLite name whose doubled bracket swallows its closer", () => {
    expect(isDangerousQuery("SELECT [a]] FROM t", "sqlite")).toBe(true);
  });

  /**
   * Both execution paths ask about whatever is in the editor, so this predicate is
   * handed MongoDB documents and Redis commands too - and the unresolvable-run rule
   * must not fire on them. Their text is not SQL, so a SQL span reader's verdict
   * about it is not evidence of anything: the escaped quote below closes perfectly
   * in JSON and in Redis's own argument parsing, and the dialog would have said
   * "part of this statement could not be read" about text that reads fine.
   *
   * The rule that keeps this honest is the one the repo already applies to
   * behaviour that differs by database: ask the single type-to-facts table
   * (`readsSqlText`), never a type test written here.
   */
  test("does not prompt for non-SQL query text whose escaped quote a SQL reader cannot resolve", () => {
    expect(isDangerousQuery('{"operation":"find","filter":{"msg":"say \\"hi\\""}}', "mongodb")).toBe(false);
    expect(isDangerousQuery('{"operation":"find","filter":{"msg":"hi"}}', "mongodb")).toBe(false);
    // A READ whose argument carries the same escaped quote. This case used to be
    // `SET k "a\"b"`, which the non-SQL vocabulary now prompts for on its own merits
    // (S8) - so the escaped quote is asserted through a command that asks for nothing.
    expect(isDangerousQuery('GETRANGE k "a\\"b" 0 1', "redis")).toBe(false);
  });

  // ── The non-SQL half of the vocabulary (S8) ──────────────────────────────
  //
  // Both execution paths ask this predicate about every connection, and for these two
  // types it answered false whatever the text said: a `FLUSHALL` and a `deleteMany`
  // reached the engine with no confirmation at all. What each command or operation
  // means, and which of them these two providers can actually dispatch, is pinned in
  // tests/unit/db/destructive-commands.test.ts; these rows pin that the GATE reads it.

  test.each<[string, "mongodb" | "redis", string]>([
    ["a MongoDB deleteMany", "mongodb", '{"collection":"users","operation":"deleteMany","filter":{}}'],
    ["a MongoDB updateMany", "mongodb", '{"collection":"u","operation":"updateMany","filter":{},"update":{}}'],
    ["a Redis FLUSHALL", "redis", "FLUSHALL"],
    ["a Redis DEL", "redis", "DEL session:1"],
    ["a Redis DEL in the JSON form", "redis", '{"command":"DEL","args":["session:1"]}'],
  ])("prompts for %s", (_label, type, query) => {
    expect(isDangerousQuery(query, type)).toBe(true);
  });

  test.each<[string, "mongodb" | "redis", string]>([
    ["a MongoDB find", "mongodb", '{"collection":"users","operation":"find","filter":{}}'],
    ["a MongoDB aggregate that only groups", "mongodb", '{"collection":"o","operation":"aggregate","pipeline":[]}'],
    ["a Redis SCAN", "redis", "SCAN 0 MATCH session:* COUNT 50"],
    ["a Redis HGETALL", "redis", "HGETALL user:1"],
  ])("does not prompt for %s", (_label, type, query) => {
    expect(isDangerousQuery(query, type)).toBe(false);
  });

  // An empty tab is not a command, and both call sites hand this predicate the buffer
  // as it stands - so the unreadable-asks rule must not fire on nothing.
  test.each<["mongodb" | "redis"]>([["mongodb"], ["redis"]])("does not prompt for an empty %s buffer", (type) => {
    expect(isDangerousQuery("", type)).toBe(false);
  });

  // Only the unresolvable-run half was narrowed. The keyword half still reads the
  // text it is given, whatever connection it is about to run on - not realistic
  // Mongo input, but it is what pins that the predicate was not switched off
  // wholesale for these two types.
  test("still prompts for a destructive keyword under a non-SQL type", () => {
    expect(isDangerousQuery("DROP TABLE users", "mongodb")).toBe(true);
  });

  // ── The dialect decides what the statement says (#292) ──────────────────
  //
  // This predicate is the last check before a destructive statement runs, and it
  // was reading `#` by a rule that belongs to PostgreSQL. On MySQL that rule let
  // a comment hide the `)` that closes a CTE body, so the reader reported the
  // `SELECT` inside the comment's reach and the `DELETE` after the list ran with
  // no confirmation at all. Both callers hold the active connection's type, so
  // the predicate is told which dialect it is reading.

  test("prompts for a DELETE a hash comment hid, once the dialect is named", () => {
    const query = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

    expect(isDangerousQuery(query)).toBe(false);
    expect(isDangerousQuery(query, "mysql")).toBe(true);
  });

  // The other direction, which is why the dialect and not a blanket "a hash is a
  // comment" is the fix: in MySQL the write really is commented out and prompting
  // would be a false alarm, while in PostgreSQL those characters are an operator
  // and the write is the statement's own code.
  test("reads a write written after a hash as the dialect reads it", () => {
    const query = "SELECT 1 # UPDATE t SET x = 1";

    expect(isDangerousQuery(query, "mysql")).toBe(false);
    expect(isDangerousQuery(query, "postgres")).toBe(true);
  });

  test("a dialect changes nothing for a statement carrying no hash", () => {
    expect(isDangerousQuery("DROP TABLE users", "postgres")).toBe(true);
    expect(isDangerousQuery("SELECT * FROM users", "mysql")).toBe(false);
  });

  // The bracket grammar reaches this predicate for the same reason (#295): under
  // ClickHouse's reading a nested array closes, so the keyword after the CTE list
  // is read and asked about, where the quoted-name reading took the closing `]]`
  // for an escape and never closed the run.
  //
  // Both readings ask now, and for two different reasons - ClickHouse's because it
  // read the `DELETE`, the name reading because it could not read the statement at
  // all (#297), which is also what the dialog then tells the operator. Which
  // reading resolves that text is pinned in tests/unit/sql/spans.test.ts.
  test("prompts for a DELETE a nested array hid, whether or not the dialect is named", () => {
    const query = "WITH [[1,2],[3,4]] AS x DELETE FROM t";

    expect(isDangerousQuery(query)).toBe(true);
    expect(isDangerousQuery(query, "clickhouse")).toBe(true);
  });

  /**
   * The narrowing #295 recorded here, now closed by #297's rule rather than left
   * pinned: bracket text that does not balance is undeterminable under the subscript
   * reading, so naming ClickHouse used to LOSE this prompt (the name reading happened
   * to close its run at the inner `]` and read the `DELETE`). Both readings ask now -
   * one because it read the statement, the other because it could not.
   */
  test("asks for bracket text no reader can resolve, under either reading", () => {
    const query = "WITH [[1,2] AS x DELETE FROM t";

    expect(isDangerousQuery(query)).toBe(true);
    expect(isDangerousQuery(query, "clickhouse")).toBe(true);
  });

  // ── `//` is a line comment on two engines and an operator on the rest (S1) ──
  //
  // The fourth grammar fact, and the only one two unrelated engines share: CQL and
  // ClickHouse read `//` to end of line, so a `;` behind it separates nothing and a
  // statement behind it is text nobody wrote. Measured 2026-08-25 - Cassandra 5.0.9
  // and ScyllaDB 2026.2.4 return the row for `SELECT release_version FROM
  // system.local // note; DROP KEYSPACE nope`, and ClickHouse 26.7.1 answers 1 for
  // `SELECT 1 // note; DROP TABLE nope` while the bare DROP is refused on both. Every
  // other dialect here reads the characters where they stand: PostgreSQL 18 answers
  // "operator does not exist: integer // integer".
  //
  // This predicate splits the buffer and asks about each fragment, so the fact decides
  // whether there IS a second fragment to ask about - which is what makes the answer
  // differ by dialect for one identical string.

  test.each<["cassandra" | "clickhouse"]>([["cassandra"], ["clickhouse"]])(
    "stays silent on %s, where the destructive half is commented out",
    (type) => {
      expect(isDangerousQuery("SELECT 1 // note; DROP TABLE users", type)).toBe(false);
    },
  );

  test.each<[string]>([["postgres"], ["mysql"], ["trino"], ["mssql"]])(
    "prompts on %s, where `//` is not a comment and the DROP is a statement",
    (type) => {
      expect(isDangerousQuery("SELECT 1 // note; DROP TABLE users", type as "postgres")).toBe(true);
    },
  );

  // The compatibility default, for a dialect this product has not measured: `//` is
  // not a comment there either, so the fragment behind it is asked about. Silence
  // would be the answer that needs the evidence, not the prompt.
  test("prompts with no dialect at all, which is the unmeasured reading", () => {
    expect(isDangerousQuery("SELECT 1 // note; DROP TABLE users")).toBe(true);
  });

  // The line comment ENDS at the newline, so what follows is code again - the same
  // reading `--` gets, and the reason `//` is not a to-end-of-buffer rule. The `;` here
  // sits on the second line, so it really is a boundary and the DROP really is a
  // statement: Cassandra 5.0.9 answers "line 2:0 mismatched input 'DROP'" for the same
  // text, which is the engine agreeing there are two things here.
  test("prompts on cassandra where the separator is on the line after the comment", () => {
    expect(isDangerousQuery("SELECT 1 // note\n; DROP TABLE users", "cassandra")).toBe(true);
  });

  // ── Where a block comment ends decides what this predicate reads (#300) ──
  //
  // The third grammar fact, and the one that reaches this predicate through the
  // KEYWORD rather than through unresolvable text: with the comment closed at its
  // first `*/`, the word after it answers for the statement, and a word an
  // operator commented out is never in the dangerous set. So a destructive
  // statement written after a nested comment ran with no confirmation at all on
  // every dialect that nests - which is PostgreSQL, SQL Server and ClickHouse.

  test.each<["postgres" | "mssql" | "clickhouse"]>([["postgres"], ["mssql"], ["clickhouse"]])(
    "prompts on %s for a destructive statement a nested comment hid",
    (type) => {
      const query = "/* outer /* inner */ still a note */ DROP TABLE users";

      expect(isDangerousQuery(query, type)).toBe(true);
    },
  );

  test.each<[string, string]>([
    ["a DELETE", "DELETE FROM users WHERE id = 1"],
    ["a TRUNCATE", "TRUNCATE TABLE users"],
    ["a write inside a CTE list", "WITH t AS (UPDATE users SET seen = true RETURNING id) SELECT * FROM t"],
  ])("prompts for %s hidden behind a nested comment under a nesting grammar", (_label, statement) => {
    expect(isDangerousQuery(`/* outer /* inner */ still a note */ ${statement}`, "postgres")).toBe(true);
  });

  // The answer a flat grammar requires, pinned rather than left to the
  // implementation: MySQL closes the comment at the first `*/`, so `still` really
  // is the word that follows it and `*/ DROP …` is text MySQL rejects outright.
  // Staying silent there is the dialect's own reading, not a missed prompt.
  test("stays silent under a flat grammar, where the same text is a syntax error", () => {
    const query = "/* outer /* inner */ still a note */ DROP TABLE users";

    expect(isDangerousQuery(query)).toBe(false);
    expect(isDangerousQuery(query, "mysql")).toBe(false);
    expect(isDangerousQuery(query, "sqlite")).toBe(false);
  });

  // One opener too many: the comment never closes under a nesting grammar, so the
  // statement is unreadable rather than misread - and unresolvable text asks
  // (#297). The two halves of #300's dialog bar meet here: whichever way the text
  // goes, a null keyword no longer means silence.
  test("asks where the nested comment never closes, because the text cannot be read", () => {
    const query = "/* outer /* inner */ DROP TABLE users";

    expect(isDangerousQuery(query, "postgres")).toBe(true);
    // Flat, the comment closed and the DROP is the statement's own leading keyword.
    expect(isDangerousQuery(query, "mysql")).toBe(true);
  });

  /**
   * The trivia alphabet the reader shares with the rest of the folder is ASCII, and the
   * LEADING scan's is deliberately wider (JS `\s`) - the alphabet the pattern it
   * replaced used, so the conversion answers what that pattern answered.
   *
   * On one engine the narrower reading would cost this prompt rather than merely
   * differ: a `latin1` MySQL connection reads byte 0xA0 as a space and executes the
   * statement behind it (verified on MySQL 26.7 through mysql2 - a row comes back under
   * `charset=latin1`, and the same text is rejected under the `utf8mb4` the provider
   * negotiates by default), and a connection string is where that charset comes from.
   * U+2028 is here for the compatibility rule alone; no engine tried accepts it.
   */
  test.each<[string, string]>([
    ["a no-break space", " DROP TABLE users"],
    ["a line separator", " DROP TABLE users"],
  ])("still prompts for a destructive statement behind %s", (_label, query) => {
    expect(isDangerousQuery(query, "mysql")).toBe(true);
    expect(isDangerousQuery(query)).toBe(true);
  });

  test("ordinary comments keep their answers under a nesting grammar", () => {
    expect(isDangerousQuery("/* note */ DROP TABLE users", "postgres")).toBe(true);
    expect(isDangerousQuery("/* a */ /* b */ SELECT * FROM users", "postgres")).toBe(false);
    expect(isDangerousQuery("/* was a DELETE once */ SELECT 1", "postgres")).toBe(false);
    expect(isDangerousQuery("/* a * b */ SELECT 1", "postgres")).toBe(false);
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

  // ── The gate reads what the RUNNER will run (S1) ─────────────────────────

  /**
   * A buffer holding more than one statement does not run as one: the editor sends it
   * to `/api/db/multi-query`, which splits it and runs the fragments in order. This
   * predicate read only the whole text, so the operative keyword of
   * `SELECT 1; DROP TABLE users` is SELECT and the DROP ran unconfirmed - the gate and
   * the runner disagreed about what was going to run.
   *
   * The fix is the shared splitter under the same grammar, so the two ask about the
   * same fragments.
   */
  test.each<[string, string]>([
    ["a DROP in the second statement", "SELECT 1; DROP TABLE users"],
    ["a DELETE after a read", "SELECT count(*) FROM users;\nDELETE FROM sessions"],
    ["an UPDATE ... SET in the last statement", "SELECT 1; SELECT 2; UPDATE t SET x = 1"],
    ["a write behind a comment in a later fragment", "SELECT 1;\n-- cleanup\nTRUNCATE TABLE audit"],
  ])("prompts for %s, which only a fragment carries", (_label, query) => {
    expect(isDangerousQuery(query, "postgres")).toBe(true);
  });

  test("a script of reads still does not prompt", () => {
    expect(isDangerousQuery("SELECT 1; SELECT 2;\nSELECT * FROM users", "postgres")).toBe(false);
  });

  /**
   * The entry's own attack, from both sides - and the two dialects answer differently
   * because the ENGINES do, which is the whole point of threading the grammar.
   *
   * Measured on postgres 18 (container libredb-postgres): block comments nest, so the
   * operator's text is one read and the table survives it - `ran = 1`, and the table
   * still in `pg_class` afterwards. The splitter now agrees, so no bare DROP fragment
   * exists to run and the gate has nothing to ask about.
   *
   * Measured on MySQL (container libredb-mysql): comments are flat, so the same text
   * really does drop the table - `information_schema.tables` for that schema went to
   * 0 - and the whole-text reading found no operative keyword at all, because the
   * first code character there is the `;`. That is the silence this test closes.
   */
  test("the S1 attack: silent under PostgreSQL because nothing destructive runs", () => {
    const attack = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";

    expect(isDangerousQuery(attack, "postgres")).toBe(false);
  });

  test("the S1 attack: prompts under MySQL, where the DROP really is a statement", () => {
    const attack = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";

    expect(isDangerousQuery(attack, "mysql")).toBe(true);
  });

  /**
   * The narrowing that keeps this from becoming a false-prompt machine on the two
   * dialects whose text is not SQL: a `;` in a Mongo document or a Redis command
   * separates nothing, so a fragment cut there is invented (#427) - and the
   * multi-statement route is a SQL route those never take.
   *
   * Written so that removing the narrowing changes the answer. The first fixture of
   * this test put the `;` inside quotes, where the splitter cuts nothing under any
   * grammar, so both arms produced one fragment either way and the assertion held
   * with the guard deleted.
   */
  test("does not cut a Redis buffer at a `;` outside quotes to invent a fragment to prompt about", () => {
    // A Redis key may contain a `;`, and this is one command - `GET`, a read. Cut
    // under the SQL grammar the same text is `GET migration` plus
    // `drop table users`, and that second, invented fragment is a write: measured
    // here as two fragments from `splitStatements`, the second of which
    // `isDangerousQuery` alone calls dangerous.
    expect(isDangerousQuery("GET migration;drop table users", "redis")).toBe(false);
  });

  test("answers a MongoDB buffer from its own vocabulary, not from a split reading", () => {
    // Valid JSON cannot carry a `;` outside a string, so this is the direction that
    // shape can produce. mongosh syntax is what the provider refuses, so the
    // vocabulary reports it unreadable and the gate asks - while a split-and-keyword
    // reading of the same two fragments finds no operative write at all
    // (`deleteMany` is not the word DELETE, and `db.notes.drop()` is not DROP TABLE).
    expect(isDangerousQuery("db.notes.deleteMany({});db.notes.find({})", "mongodb")).toBe(true);
    // And the everyday read that motivated the narrowing still does not prompt: the
    // SQL inside the filter is a value, and `find` is not in the vocabulary.
    expect(isDangerousQuery('{"operation":"find","filter":{"note":"; drop table t"}}', "mongodb")).toBe(false);
  });
});
