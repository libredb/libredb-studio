import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderProse } from "@/components/rich-text";
import type { DatabaseType } from "@/lib/types";

/**
 * Fenced code blocks in model prose (#389).
 *
 * The gap these pin: plan mode is toolless, so its ENTIRE output is one block of model
 * prose, and a plan for anything worth planning contains SQL. `renderProse` read
 * headings, bullets, bold and inline code and deliberately not fences, so the SQL
 * arrived as a paragraph of literal backticks with its whitespace collapsed — the one
 * thing the mode produces, rendered as the one thing this renderer would not read.
 *
 * The security property of the block still holds and is pinned here too: a fence is
 * rendered as text nodes inside a `pre`, so nothing in it reaches an HTML parser.
 */

afterEach(cleanup);

const FENCE = "```";

describe("renderProse fenced blocks", () => {
  test("renders a fenced block verbatim, with the fence lines themselves gone", () => {
    const { container } = render(
      <div>{renderProse(`Look at this:\n${FENCE}sql\nSELECT 1;\n${FENCE}\nThat is all.`)}</div>,
    );

    const code = container.querySelector("pre");
    expect(code?.textContent).toBe("SELECT 1;");
    expect(container.textContent).not.toContain(FENCE);
  });

  test("keeps indentation and markdown characters inside a fence as the model typed them", () => {
    const sql = "SELECT *\n  FROM orders o\n  JOIN customers c ON c.id = o.customer_id\n- not a bullet";
    const { container } = render(<div>{renderProse(`${FENCE}sql\n${sql}\n${FENCE}`)}</div>);

    expect(container.querySelector("pre")?.textContent).toBe(sql);
    // Nothing inside the fence was read as prose: no list, no bold, no inline code.
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });

  test("renders the content of a fence the model never closed", () => {
    // A run cut off at its turn limit or its deadline ends mid-block, and the SQL it
    // had written is still the useful half.
    const { container } = render(<div>{renderProse(`${FENCE}sql\nSELECT 1;`)}</div>);

    expect(container.querySelector("pre")?.textContent).toBe("SELECT 1;");
  });

  test("renders nothing for a fence with nothing in it", () => {
    const { container } = render(<div>{renderProse(`${FENCE}sql\n\n${FENCE}`)}</div>);

    expect(container.querySelector("pre")).toBeNull();
  });

  test("ends an open bullet list where a fence begins", () => {
    const { container } = render(<div>{renderProse(`- first\n- second\n${FENCE}\nSELECT 1;\n${FENCE}`)}</div>);

    expect(container.querySelectorAll("li").length).toBe(2);
    expect(container.querySelector("pre")?.textContent).toBe("SELECT 1;");
  });

  test("renders two fences as two blocks", () => {
    const { container } = render(
      <div>{renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}\nthen\n${FENCE}sql\nSELECT 2;\n${FENCE}`)}</div>,
    );

    expect([...container.querySelectorAll("pre")].map((block) => block.textContent)).toEqual([
      "SELECT 1;",
      "SELECT 2;",
    ]);
  });

  test("renders an HTML payload inside a fence as text, never as an element", () => {
    const payload = '<img src=x onerror="steal()">';
    const { container } = render(<div>{renderProse(`${FENCE}sql\n${payload}\n${FENCE}`)}</div>);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(payload);
  });

  test("does not let a one-line fence swallow the rest of the plan", () => {
    // ```` ```sql SELECT 1``` ```` on one line. Read as an opener it would open a block
    // nothing closes, and everything after it — the whole remainder of the plan — would
    // render as code. CommonMark forbids a backtick in the info string for exactly this
    // reason, so the line stays the prose it was.
    const { container } = render(
      <div>{renderProse(`${FENCE}sql SELECT 1${FENCE}\n\n### Step 2\n\nA real paragraph.`)}</div>,
    );

    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("h4")?.textContent).toBe("Step 2");
    expect(container.textContent).toContain("A real paragraph.");
  });

  test("offers every fenced block to the clipboard", () => {
    const { getAllByTestId } = render(<div>{renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}`)}</div>);

    expect(getAllByTestId("prose-code-copy").length).toBe(1);
  });
});

describe("renderProse code hand-off to the editor", () => {
  test("offers a sql-tagged fence to the editor, with the statement the model wrote", () => {
    const onApplySql = mock((_sql: string) => {});
    const { getByTestId } = render(<div>{renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}`, { onApplySql })}</div>);

    fireEvent.click(getByTestId("prose-code-apply"));
    expect(onApplySql).toHaveBeenCalledWith("SELECT 1;");
  });

  test("offers an untagged fence, because a plan for a database writes one for its SQL", () => {
    const onApplySql = mock((_sql: string) => {});
    const { getByTestId } = render(<div>{renderProse(`${FENCE}\nSELECT 1;\n${FENCE}`, { onApplySql })}</div>);

    fireEvent.click(getByTestId("prose-code-apply"));
    expect(onApplySql).toHaveBeenCalledWith("SELECT 1;");
  });

  test("offers a fence tagged with an engine this product speaks", () => {
    const onApplySql = mock((_sql: string) => {});
    const { getByTestId } = render(<div>{renderProse(`${FENCE}PostgreSQL\nSELECT 1;\n${FENCE}`, { onApplySql })}</div>);

    fireEvent.click(getByTestId("prose-code-apply"));
    expect(onApplySql).toHaveBeenCalledWith("SELECT 1;");
  });

  test("offers a fence tagged with the embedded engine, which the first allowlist omitted", () => {
    // `libredb` is a `DatabaseType` and its provider declares `queryDialect: "libredb"`,
    // so a plan for one is as applicable as a plan for PostgreSQL. The hand-written set
    // this replaced claimed every engine was in it and left this one out (#389 review).
    const onApplySql = mock((_sql: string) => {});
    const { getByTestId } = render(<div>{renderProse(`${FENCE}libredb\nSELECT 1;\n${FENCE}`, { onApplySql })}</div>);

    fireEvent.click(getByTestId("prose-code-apply"));
    expect(onApplySql).toHaveBeenCalledWith("SELECT 1;");
  });

  test("offers a fence tagged with any engine the product speaks", () => {
    // The record is total over `DatabaseType`, so this is the assertion that a NEW engine
    // cannot ship without its tag: adding one to the union breaks the build, and adding
    // it here without a tag breaks this.
    const engines = [
      "postgres",
      "mysql",
      "sqlite",
      "mongodb",
      "redis",
      "oracle",
      "mssql",
      "libredb",
      "couchbase",
      "clickhouse",
      "druid",
      "trino",
    ] satisfies DatabaseType[];

    for (const engine of engines) {
      const onApplySql = mock((_sql: string) => {});
      const { getByTestId, unmount } = render(
        <div>{renderProse(`${FENCE}${engine}\nSELECT 1;\n${FENCE}`, { onApplySql })}</div>,
      );
      fireEvent.click(getByTestId("prose-code-apply"));
      expect(onApplySql).toHaveBeenCalledWith("SELECT 1;");
      unmount();
    }
  });

  test("withholds the editor from a fence the model said is not a query", () => {
    const onApplySql = mock((_sql: string) => {});
    const { queryByTestId, getByTestId } = render(
      <div>{renderProse(`${FENCE}bash\npg_dump mydb\n${FENCE}`, { onApplySql })}</div>,
    );

    expect(queryByTestId("prose-code-apply")).toBeNull();
    // Still copyable: withholding the editor is a claim about where the text belongs,
    // not about whether the user may have it.
    expect(getByTestId("prose-code-copy")).not.toBeNull();
  });

  test("offers no editor control at all where the host has no editor", () => {
    const { queryByTestId } = render(<div>{renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}`)}</div>);

    expect(queryByTestId("prose-code-apply")).toBeNull();
  });
});

/**
 * A block a surface beside this prose is already showing verbatim (L2, L5).
 *
 * Measured in Chrome on 2026-08-21: a plan run's closing prose HOLDS the fenced
 * statement, so every surface that rendered that prose reprinted the statement — the
 * answer card showed the statement, then the same statement again inside its own
 * `Why this statement` fold, and the transcript entry below printed it a third time,
 * each copy with its own clipboard.
 *
 * So the caller may name the ONE block it is already showing, and that block is not
 * printed a second time. It is the same shape the per-block editor control's
 * suppression already has — the caller says what the surface beside it is offering —
 * and it is deliberately keyed on the TEXT rather than on a flag: the recorded
 * deliverable is read out of the prose by `readPlanStatement`, which joins and trims
 * the fence's lines exactly as this does, so the block that matches is the block the
 * ledger took.
 *
 * What is NOT suppressed is the prose. Every other fence still renders, and `Copy all`
 * — which takes the string the model wrote, not this rendering of it — still carries
 * the whole text including the block that was not printed.
 */
describe("renderProse and a statement already shown beside it", () => {
  test("does not print the one block a caller says is displayed beside it", () => {
    const { container, queryByTestId } = render(
      <div>
        {renderProse(`Here is the read:\n${FENCE}sql\nSELECT 1;\n${FENCE}\nIt counts the rows.`, {
          cardedStatement: "SELECT 1;",
        })}
      </div>,
    );

    expect(container.querySelector("pre")).toBeNull();
    expect(queryByTestId("prose-code-copy")).toBeNull();
    // The words around it are untouched: one block is not printed, nothing is edited.
    expect(container.textContent).toContain("Here is the read:");
    expect(container.textContent).toContain("It counts the rows.");
  });

  test("prints every other block, because only the displayed one is a second copy", () => {
    const { container, getAllByTestId } = render(
      <div>
        {renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}\n${FENCE}sql\nSELECT 2;\n${FENCE}`, {
          cardedStatement: "SELECT 1;",
        })}
      </div>,
    );

    expect(getAllByTestId("prose-code-copy")).toHaveLength(1);
    const printed = [...container.querySelectorAll("pre")].map((block) => block.textContent);
    expect(printed).toEqual(["SELECT 2;"]);
  });

  test("matches the block the ledger took, which is trimmed as this one is", () => {
    // `readPlanStatement` records `lines.join("\n").trim()`, so a fence whose content is
    // padded is the SAME statement as the one recorded from it. Comparing the raw text
    // would leave the padded copy printed beside the card showing it.
    const { container } = render(
      <div>{renderProse(`${FENCE}sql\n  SELECT 1;  \n${FENCE}`, { cardedStatement: "SELECT 1;" })}</div>,
    );

    expect(container.querySelector("pre")).toBeNull();
  });

  test("a caller that names nothing gets every block, which is what every other caller is", () => {
    const { getAllByTestId } = render(<div>{renderProse(`${FENCE}sql\nSELECT 1;\n${FENCE}`, {})}</div>);

    expect(getAllByTestId("prose-code-copy")).toHaveLength(1);
  });
});
