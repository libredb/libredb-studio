import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { renderInline, renderProse } from "@/components/rich-text";

const IMG_PAYLOAD = '<img src=x onerror="steal()">';
const SVG_PAYLOAD = "<svg onload=alert(1)>";

afterEach(cleanup);

describe("renderInline", () => {
  test("renders an HTML payload as text, never as an element", () => {
    const { container } = render(<div>{renderInline(IMG_PAYLOAD)}</div>);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(IMG_PAYLOAD);
  });

  test("renders an HTML payload inside bold markers as text", () => {
    const { container } = render(<div>{renderInline(`**${SVG_PAYLOAD}**`)}</div>);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe(SVG_PAYLOAD);
  });

  test("renders an HTML payload inside code markers as text", () => {
    const { container } = render(<div>{renderInline(`\`${SVG_PAYLOAD}\``)}</div>);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(SVG_PAYLOAD);
  });

  test("returns plain text unchanged when there are no markers", () => {
    const { container } = render(<div>{renderInline("plain line")}</div>);

    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("plain line");
  });

  test("renders a bold span at the start with no leading text node", () => {
    const { container } = render(<div>{renderInline("**lead** tail")}</div>);

    expect(container.querySelector("strong")?.textContent).toBe("lead");
    expect(container.textContent).toBe("lead tail");
  });

  test("renders a bold span at the end with no trailing text node", () => {
    const { container } = render(<div>{renderInline("head **tail**")}</div>);

    expect(container.querySelector("strong")?.textContent).toBe("tail");
    expect(container.textContent).toBe("head tail");
  });

  test("renders multiple bold spans with the interleaved text between them", () => {
    const { container } = render(<div>{renderInline("a **b** c **d** e")}</div>);

    const bold = container.querySelectorAll("strong");
    expect(bold.length).toBe(2);
    expect(bold[0].textContent).toBe("b");
    expect(bold[1].textContent).toBe("d");
    expect(container.textContent).toBe("a b c d e");
  });

  test("renders an identifier in backticks as code, with the markers gone", () => {
    // Models name tables and columns this way constantly, and a user reading
    // `orders` with its backticks is reading punctuation the model did not mean.
    const { container } = render(<div>{renderInline("scan on `orders`")}</div>);

    expect(container.querySelector("code")?.textContent).toBe("orders");
    expect(container.textContent).toBe("scan on orders");
  });

  test("renders bold and code in one line, in the order they appear", () => {
    const { container } = render(<div>{renderInline("**check** the `orders` table")}</div>);

    expect(container.querySelector("strong")?.textContent).toBe("check");
    expect(container.querySelector("code")?.textContent).toBe("orders");
    expect(container.textContent).toBe("check the orders table");
  });

  test("returns no nodes for an empty string", () => {
    expect(renderInline("")).toEqual([]);
  });

  test("applies the bold styling class the components rely on", () => {
    const { container } = render(<div>{renderInline("**x**")}</div>);

    expect(container.querySelector("strong")?.className).toBe("text-zinc-200");
  });
});

/**
 * The block renderer for model prose (#373 review).
 *
 * Measured in plan mode, live: the closing statement came back as markdown — headings
 * and bulleted sub-points — and the rail rendered it into one paragraph as literal
 * characters, so the user read hash marks and asterisks. Plan mode's whole output is
 * one such block.
 *
 * It renders what the models actually emit and nothing else, and it renders it the
 * only way this repository renders LLM text: to React nodes, so escaping is
 * structural. There is no HTML parser anywhere on this path and no markdown library
 * that could produce one.
 */
describe("renderProse", () => {
  test("renders an HTML payload as text, never as an element", () => {
    const { container } = render(<div>{renderProse(IMG_PAYLOAD)}</div>);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(IMG_PAYLOAD);
  });

  test("renders an HTML payload in a heading and in a bullet as text", () => {
    const { container } = render(<div>{renderProse(`### ${SVG_PAYLOAD}\n* ${IMG_PAYLOAD}`)}</div>);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("h4")?.textContent).toBe(SVG_PAYLOAD);
    expect(container.querySelector("li")?.textContent).toBe(IMG_PAYLOAD);
  });

  test("renders a heading as a heading, with the hash marks gone", () => {
    const { container } = render(<div>{renderProse("### Step 1: Schema Integrity")}</div>);

    expect(container.querySelector("h4")?.textContent).toBe("Step 1: Schema Integrity");
    expect(container.textContent).not.toContain("#");
  });

  test("renders every hash depth the models use at one level, because the outline is not theirs", () => {
    const { container } = render(<div>{renderProse("# One\n## Two\n###### Six")}</div>);

    const headings = container.querySelectorAll("h4");
    expect(headings.length).toBe(3);
    expect([...headings].map((heading) => heading.textContent)).toEqual(["One", "Two", "Six"]);
  });

  test("groups consecutive bullets into one list, whichever marker they use", () => {
    const { container } = render(<div>{renderProse("* first\n- second\n  * third")}</div>);

    expect(container.querySelectorAll("ul").length).toBe(1);
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["first", "second", "third"]);
  });

  test("starts a new list after prose comes between two runs of bullets", () => {
    const { container } = render(<div>{renderProse("* a\n\nthen\n\n* b")}</div>);

    expect(container.querySelectorAll("ul").length).toBe(2);
    expect(container.querySelector("p")?.textContent).toBe("then");
  });

  test("closes a list that a heading follows", () => {
    const { container } = render(<div>{renderProse("* a\n### Next")}</div>);

    expect(container.querySelectorAll("ul").length).toBe(1);
    expect(container.querySelectorAll("li").length).toBe(1);
    expect(container.querySelector("h4")?.textContent).toBe("Next");
  });

  test("renders bold and code inside a bullet", () => {
    const { container } = render(<div>{renderProse("* **What to inspect:** the `orders` table")}</div>);

    expect(container.querySelector("li strong")?.textContent).toBe("What to inspect:");
    expect(container.querySelector("li code")?.textContent).toBe("orders");
  });

  test("renders each line of prose as its own paragraph and drops the blank ones", () => {
    const { container } = render(<div>{renderProse("one\n\n  \ntwo")}</div>);

    expect([...container.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual(["one", "two"]);
  });

  test("renders no empty heading for a hash with nothing after it", () => {
    const { container } = render(<div>{renderProse("### ")}</div>);

    expect(container.querySelector("h4")).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("returns no nodes for an empty string", () => {
    expect(renderProse("")).toEqual([]);
  });

  test("keeps a lone asterisk as text rather than reading it as a bullet", () => {
    // `**bold**` opens a line often enough that a bullet rule which swallowed it
    // would eat the emphasis and the words after it.
    const { container } = render(<div>{renderProse("**Finding:** the index is missing")}</div>);

    expect(container.querySelector("li")).toBeNull();
    expect(container.querySelector("p strong")?.textContent).toBe("Finding:");
  });
});
