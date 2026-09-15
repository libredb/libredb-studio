import "../setup-dom";
import React from "react";
import { ConnectionSignature, SIGNATURE_URIS } from "@/components/login/connection-signature";
import { ENGINE_URI_SCHEMES, parseConnectionString } from "@/lib/connection-string-parser";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

/** The real `matchMedia` happy-dom installed, kept so the stub below can be handed back. */
const realMatchMedia = window.matchMedia;

/**
 * Stand in for `prefers-reduced-motion`. The component reads the preference inside an
 * effect rather than during render, so the stub only has to answer the one query - but it
 * must answer it before the effect runs, hence the assignment before `render`.
 *
 * The returned object is a whole `MediaQueryList` shape, not just `{ matches }`, and the
 * real implementation goes back on in `afterAll`. Both halves matter because `window` is
 * shared by every test in this file: a subscriber that reaches for the legacy `addListener`
 * gets `undefined is not a function` from a `{ matches }`-only stub, and a stub left standing
 * decides the outcome of whatever runs after it. The blast radius stops at the file, and only
 * because of how the suite runs: the runner gives every test file its own bun process, so a
 * file states an assumption like this one in its own docblock and needs no directory and no
 * registration anywhere.
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

/**
 * Records what the component hands `setInterval`, and keeps each handler so a test can fire it
 * instead of waiting for it. The swap follows the one in tests/components/admin/OverviewTab.test.tsx.
 *
 * The real interval is still started, so nothing about the component's lifetime changes and the
 * unmount still clears it. Restoring is the caller's job, in a `finally`: `globalThis` is shared
 * by every test in this file.
 */
function captureIntervals() {
  const realSetInterval = globalThis.setInterval;
  const scheduled: { delay: number | undefined; handler: () => void }[] = [];
  globalThis.setInterval = ((handler: () => void, delay?: number) => {
    scheduled.push({ delay, handler });
    return realSetInterval(handler, delay);
  }) as unknown as typeof setInterval;
  return {
    scheduled,
    restore: () => {
      globalThis.setInterval = realSetInterval;
    },
  };
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

  test("does not start the cycle when the viewer asked for reduced motion", () => {
    /*
     * Watched at the component's own timer rather than on the wall clock, because the wall clock
     * cannot see this. The cycle's first change is CYCLE_MS away, 2.6s, so the 200ms sleep this
     * test used to take proved nothing: it passed just as well with the `prefers-reduced-motion`
     * guard deleted, since nothing had moved yet either way. What the guard decides is whether
     * the interval is scheduled at all, so that is what is read.
     *
     * The second half is the control, and it is what stops the first from being vacuous: a
     * capture watching a surface the component does not use would record an empty list under
     * both preferences and the negative would pass for the wrong reason. Motion off must record
     * NO interval, motion on must record one, and firing that one must advance the line, which
     * is what proves the thing recorded is the cycle and not some other timer.
     */
    const cycle = captureIntervals();
    try {
      stubReducedMotion(true);
      const reduced = render(<ConnectionSignature />);
      expect(reduced.getByTestId("connection-signature").textContent).toContain(SIGNATURE_URIS[0].scheme);
      expect(cycle.scheduled).toHaveLength(0);
      cleanup();

      stubReducedMotion(false);
      const moving = render(<ConnectionSignature />);
      expect(cycle.scheduled).toHaveLength(1);
      act(() => {
        cycle.scheduled[0].handler();
      });
      expect(moving.getByTestId("connection-signature").textContent).toContain(SIGNATURE_URIS[1].scheme);
    } finally {
      cycle.restore();
    }
  });

  test("advances to the next URI on its own", async () => {
    /*
     * The wait asks for the URI it wants. It used to end on "the text changed at all" and
     * then demand index 1 on the line after, which is a component-bug report waiting for a
     * busy machine: the 6000ms window spans more than two 2600ms cycles, so a process that
     * stalls long enough to miss the index-1 plateau satisfies "not the first text" with
     * index 2 already on screen, and even a wait that ended on index 1 can have the interval
     * fire again before the next statement reads the node. Asked for index 1 by name, a poll
     * that finds index 2 is a failing poll rather than the end of the wait.
     *
     * The read before the wait is the control: it fixes the opening frame at index 0, so a
     * component that painted index 1 from the start could not pass this. Both reads compare
     * the whole URI rather than the scheme alone, because one scheme can be a prefix of
     * another and `toContain` would then answer for the wrong frame.
     */
    stubReducedMotion(false);
    const { getByTestId } = render(<ConnectionSignature />);
    const uriText = (uri: (typeof SIGNATURE_URIS)[number]) => `${uri.scheme}${uri.rest}`;
    expect(getByTestId("connection-signature").textContent).toBe(uriText(SIGNATURE_URIS[0]));

    await waitFor(() => expect(getByTestId("connection-signature").textContent).toBe(uriText(SIGNATURE_URIS[1])), {
      timeout: 6000,
    });
  });
});
