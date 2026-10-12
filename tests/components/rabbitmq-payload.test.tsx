/**
 * A stream message is data in the results area (R-S7): markup in a payload or a header renders as text in the grid's
 * card and in the row detail, and a payload nested 6,000 levels deep, which the provider shows in the base64 form,
 * opens and copies in the row detail without a recursive render.
 *
 * The rows are the provider's own, built by renderMessage from raw messages, so the test holds the whole path from the
 * wire value to the DOM.
 *
 * The desktop grid lays its rows out through a virtualizer that renders none in happy-dom unless the module is replaced,
 * which new tests here do not do; each of its cells renders `formatCellValue(value, renderContextFor(...)).display` as
 * a React text child (`src/components/ResultsGrid.tsx`, the desktop row), so the grid's cell is pinned at that
 * function, and ResultCard renders the same function into the DOM.
 */
import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResultCard } from "@/components/results-grid/ResultCard";
import { RowDetailSheet } from "@/components/results-grid/RowDetailSheet";
import { formatCellValue, renderContextFor } from "@/components/results-grid/utils";
import type { RawMessage } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import { emptyTally, renderMessage } from "@/lib/db/providers/stream/rabbitmq/render";
import { RABBITMQ_RESULT_FIELDS } from "@/lib/db/providers/stream/rabbitmq/results";

const utf8 = (text: string) => new TextEncoder().encode(text);
const MARKUP = "<img src=x onerror=alert(1)>";

function row(body: Uint8Array, headerValue = "plain"): Record<string, unknown> {
  const message: RawMessage = {
    offset: BigInt(42),
    exchange: utf8(""),
    routingKey: utf8("orders"),
    properties: {
      headers: [
        { name: utf8("x-stream-offset"), value: { tag: "l", value: BigInt(42) } },
        { name: utf8("note"), value: { tag: "S", bytes: utf8(headerValue) } },
      ],
    },
    body,
    bodySize: body.length,
    retainedHeaderBytes: 0,
  };
  return renderMessage(message, "orders", emptyTally());
}

afterEach(() => {
  cleanup();
});

describe("markup in a message renders as text", () => {
  test("in the grid's card, as the primary value", () => {
    const markup = row(utf8(MARKUP), MARKUP);
    const { container } = render(
      <ResultCard
        row={markup}
        fields={[...RABBITMQ_RESULT_FIELDS]}
        primaryColumn="payload"
        idColumn="offset"
        index={0}
        onSelect={mock(() => {})}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(MARKUP);
  });

  test("in the desktop grid's cell function, payload and header alike", () => {
    const markup = row(utf8(MARKUP), MARKUP);
    for (const field of ["payload", "headers"]) {
      const { display } = formatCellValue(markup[field], renderContextFor(undefined, field));
      expect(display).toContain(MARKUP);
    }
  });

  test("in the row detail, payload and header alike", () => {
    render(
      <RowDetailSheet
        row={row(utf8(MARKUP), MARKUP)}
        fields={[...RABBITMQ_RESULT_FIELDS]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );
    expect(document.body.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain(MARKUP);
    expect(document.body.textContent).toContain(JSON.stringify(MARKUP).slice(1, -1));
  });
});

describe("a payload nested 6,000 levels deep", () => {
  test("is base64 in the row, and the row detail opens and copies it", async () => {
    const depth = 6000;
    const deep = row(utf8(`${"[".repeat(depth)}${"]".repeat(depth)}`));
    expect(deep.payload_encoding).toBe("base64");
    const writeText = mock(async (text: string) => {
      void text;
    });
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <RowDetailSheet row={deep} fields={[...RABBITMQ_RESULT_FIELDS]} isOpen onClose={mock(() => {})} rowIndex={0} />,
    );
    expect(document.body.textContent).toContain(`(${depth * 2} bytes)`);
    fireEvent.click(screen.getByText("Copy JSON"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = JSON.parse(writeText.mock.calls[0][0]) as Record<string, unknown>;
    expect(copied.payload).toBe(deep.payload);
    expect(copied.offset).toBe("42");
  });
});
