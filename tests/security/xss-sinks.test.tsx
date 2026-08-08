import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { renderInlineBold } from "@/components/rich-text";

const IMG_PAYLOAD = '<img src=x onerror="steal()">';
const SVG_PAYLOAD = "<svg onload=alert(1)>";

afterEach(cleanup);

describe("renderInlineBold", () => {
  test("renders an HTML payload as text, never as an element", () => {
    const { container } = render(<div>{renderInlineBold(IMG_PAYLOAD)}</div>);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(IMG_PAYLOAD);
  });

  test("renders an HTML payload inside bold markers as text", () => {
    const { container } = render(<div>{renderInlineBold(`**${SVG_PAYLOAD}**`)}</div>);

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe(SVG_PAYLOAD);
  });

  test("returns plain text unchanged when there are no bold markers", () => {
    const { container } = render(<div>{renderInlineBold("plain line")}</div>);

    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("plain line");
  });

  test("renders a bold span at the start with no leading text node", () => {
    const { container } = render(<div>{renderInlineBold("**lead** tail")}</div>);

    expect(container.querySelector("strong")?.textContent).toBe("lead");
    expect(container.textContent).toBe("lead tail");
  });

  test("renders a bold span at the end with no trailing text node", () => {
    const { container } = render(<div>{renderInlineBold("head **tail**")}</div>);

    expect(container.querySelector("strong")?.textContent).toBe("tail");
    expect(container.textContent).toBe("head tail");
  });

  test("renders multiple bold spans with the interleaved text between them", () => {
    const { container } = render(<div>{renderInlineBold("a **b** c **d** e")}</div>);

    const bold = container.querySelectorAll("strong");
    expect(bold.length).toBe(2);
    expect(bold[0].textContent).toBe("b");
    expect(bold[1].textContent).toBe("d");
    expect(container.textContent).toBe("a b c d e");
  });

  test("returns no nodes for an empty string", () => {
    expect(renderInlineBold("")).toEqual([]);
  });

  test("applies the bold styling class the components rely on", () => {
    const { container } = render(<div>{renderInlineBold("**x**")}</div>);

    expect(container.querySelector("strong")?.className).toBe("text-zinc-200");
  });
});
