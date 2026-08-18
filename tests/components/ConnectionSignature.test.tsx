import "../setup-dom";
import React from "react";
import { ConnectionSignature, SIGNATURE_URIS } from "@/components/login/connection-signature";
import { ENGINE_URI_SCHEMES, parseConnectionString } from "@/lib/connection-string-parser";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

/** The real `matchMedia` happy-dom installed, kept so the stub below can be handed back. */
const realMatchMedia = window.matchMedia;

/**
 * Stand in for `prefers-reduced-motion`. The component reads the preference inside an
 * effect rather than during render, so the stub only has to answer the one query - but it
 * must answer it before the effect runs, hence the assignment before `render`.
 *
 * The returned object is a whole `MediaQueryList` shape, not just `{ matches }`, and the
 * real implementation goes back on in `afterAll`. Both halves matter: `window` is shared by
 * every file in this component group (`tests/run-components.sh` Group 11), and `next-themes`
 * - which `RootLayout.test.tsx` renders in the same process - subscribes with the legacy
 * `addListener`. A stub missing that method, or left in place after this file finishes,
 * fails those tests instead of these, which is exactly the process-wide contamination the
 * grouping exists to prevent.
 */
function stubReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("reduce"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("ConnectionSignature", () => {
  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: realMatchMedia });
  });

  test("shows only schemes parseConnectionString accepts, one per engine that has one", () => {
    // The line is the evidence behind the engine count on the login hero, so it may only
    // show URIs the product honours. SQLite is a file, LibreDB is embedded and Druid is
    // plain HTTP - a scheme invented for any of them would be a claim the parser rejects.
    expect(SIGNATURE_URIS.length).toBe(Object.keys(ENGINE_URI_SCHEMES).length);
    for (const uri of SIGNATURE_URIS) {
      expect(parseConnectionString(`${uri.scheme}${uri.rest}`)?.type).toBe(uri.type);
    }
  });

  test("names every scheme at once for assistive technology", () => {
    // The visible line rewrites itself, so it is aria-hidden; the static list is what a
    // screen reader gets, and it has to carry the whole set rather than the current frame.
    stubReducedMotion(true);
    const { container, getByTestId } = render(<ConnectionSignature />);

    expect(getByTestId("connection-signature").getAttribute("aria-hidden")).toBe("true");
    const announced = Array.from(container.querySelectorAll("ul.sr-only li")).map((li) => li.textContent);
    expect(announced).toEqual(SIGNATURE_URIS.map((uri) => uri.scheme));
  });

  test("does not start the cycle when the viewer asked for reduced motion", async () => {
    stubReducedMotion(true);
    const { getByTestId } = render(<ConnectionSignature />);
    const first = getByTestId("connection-signature").textContent;

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getByTestId("connection-signature").textContent).toBe(first);
  });

  test("advances to the next URI on its own", async () => {
    stubReducedMotion(false);
    const { getByTestId } = render(<ConnectionSignature />);
    const first = getByTestId("connection-signature").textContent;
    expect(first).toContain(SIGNATURE_URIS[0].scheme);

    await waitFor(() => expect(getByTestId("connection-signature").textContent).not.toBe(first), { timeout: 6000 });
    expect(getByTestId("connection-signature").textContent).toContain(SIGNATURE_URIS[1].scheme);
  });
});
