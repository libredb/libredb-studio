import "../../setup-dom";

import React, { type RefObject } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConsentCard } from "@/components/agent/ConsentCard";
import { AGENT_HANDOVER_BUDGET } from "@/lib/agent/execution-policy";
import { autoExecuteTerms } from "@/lib/agent/posture";
import type { DatabaseType } from "@/lib/types";

/**
 * The hand-over consent step, as its own component (spec Deliverable 4).
 *
 * It decides exactly what the inline section in `AgentRail.tsx` decided: whether the
 * run's final statement also lands in the user's editor and runs there. So the things
 * these tests pin are the things that made that section correct, and none of them are
 * presentational:
 *
 *  - **the tick is OFF unless the caller says otherwise**, because a widening that is
 *    on by default is not consented to;
 *  - **`autoExecuteTerms` is the accessible description of the checkbox**, and stays
 *    one after it moved into a popover. A description that is only rendered when a
 *    popover is open is a description a screen-reader user is never given, so the node
 *    is always in the DOM and the popover only unhides it;
 *  - **the figures are DERIVED** — the chips read `AGENT_HANDOVER_BUDGET`, so a change
 *    to the budget cannot leave the copy behind (#425's lesson);
 *  - **the SQLite sentence is read off the engine the start was decided on**, keeps its
 *    exact words, and does not wait for the tick: it is true of the run either way;
 *  - **focus moves into the region when it is raised**, which is the announcement a
 *    keyboard user gets that two buttons appeared under a Start that just went
 *    disabled.
 */

const WORKFLOW_LABEL = "Analyze";

function refObject(): RefObject<HTMLElement | null> {
  return { current: null };
}

interface Overrides {
  readonly connectionName?: string | null;
  readonly engine?: DatabaseType | null;
  readonly autoExecute?: boolean;
  readonly onAutoExecuteChange?: (next: boolean) => void;
  readonly onOpen?: () => void;
  readonly onCancel?: () => void;
  readonly regionRef?: RefObject<HTMLElement | null>;
}

function renderCard(overrides: Overrides = {}) {
  return render(
    <ConsentCard
      workflowType="data-analysis"
      workflowLabel={WORKFLOW_LABEL}
      connectionName={overrides.connectionName === undefined ? "Sales" : overrides.connectionName}
      engine={overrides.engine === undefined ? "postgres" : overrides.engine}
      autoExecute={overrides.autoExecute ?? false}
      onAutoExecuteChange={overrides.onAutoExecuteChange ?? (() => {})}
      onOpen={overrides.onOpen ?? (() => {})}
      onCancel={overrides.onCancel ?? (() => {})}
      regionRef={overrides.regionRef ?? refObject()}
    />,
  );
}

describe("ConsentCard", () => {
  afterEach(() => {
    cleanup();
  });

  describe("the region a screen reader lands in", () => {
    test("it is a named, described region that takes focus when it is raised", () => {
      const regionRef = refObject();
      const { getByTestId } = renderCard({ regionRef });

      const region = getByTestId("agent-consent");
      expect(region.tagName).toBe("SECTION");
      // The name is the sentence naming the workflow and the connection; the
      // description is the terms. Entering the region reads out what is being
      // consented to rather than "group".
      expect(region.getAttribute("aria-labelledby")).toBe("agent-consent-workflow");
      expect(region.getAttribute("aria-describedby")).toBe("agent-consent-terms");
      // Focusable programmatically, out of the tab order: the pattern for a region
      // focus is moved TO rather than through.
      expect(region.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(region);
      // The caller keeps a handle on the node, because the exit half of the focus
      // contract (Cancel returns focus to Start) is the caller's to decide.
      expect(regionRef.current).toBe(region);
    });
  });

  describe("what the card says before the checkbox", () => {
    test("the heading states the default, and the run is read-only either way", () => {
      const { getByTestId } = renderCard();

      expect(getByTestId("agent-consent-heading").textContent).toContain("Start this run");
      expect(getByTestId("agent-consent-pill").textContent).toBe("read-only");
      expect(getByTestId("agent-consent-editor-note").textContent).toBe(
        "Nothing runs in your editor unless you ask for it below.",
      );
    });

    test("the region's own name carries the workflow AND the connection the start was decided on", () => {
      const { getByTestId } = renderCard({ connectionName: "Sales" });

      const named = getByTestId("agent-consent-workflow");
      expect(named.id).toBe("agent-consent-workflow");
      expect(named.textContent).toBe("This run will open as Analyze on Sales, which answers with a result.");
    });

    test("an unnamed connection is said as the one the start was made on, never as a blank", () => {
      const { getByTestId } = renderCard({ connectionName: null });

      expect(getByTestId("agent-consent-workflow").textContent).toBe(
        "This run will open as Analyze on the connection you started it on, which answers with a result.",
      );
    });

    test("the decision is stated as frozen at open time", () => {
      const { getByTestId } = renderCard();

      expect(getByTestId("agent-consent-frozen").textContent).toBe(
        "This is decided by the request that opens the run and stays what it was: a later request cannot widen a run the server already holds.",
      );
    });
  });

  describe("the checkbox, which carries the whole decision", () => {
    test("it is off by default and reports a tick to the caller", () => {
      const ticks: boolean[] = [];
      const { getByTestId } = renderCard({ onAutoExecuteChange: (next) => ticks.push(next) });

      const box = getByTestId("agent-auto-execute") as HTMLInputElement;
      expect(box.type).toBe("checkbox");
      expect(box.checked).toBe(false);
      expect(getByTestId("agent-auto-execute-label").textContent).toBe("Also run the final answer in my editor");

      fireEvent.click(box);
      expect(ticks).toEqual([true]);
    });

    test("a ticked box is rendered ticked, and unticking is reported as off", () => {
      const ticks: boolean[] = [];
      const { getByTestId } = renderCard({ autoExecute: true, onAutoExecuteChange: (next) => ticks.push(next) });

      const box = getByTestId("agent-auto-execute") as HTMLInputElement;
      expect(box.checked).toBe(true);

      fireEvent.click(box);
      expect(ticks).toEqual([false]);
    });

    test("the terms are the checkbox's accessible description, whether or not the popover is open", () => {
      const { getByTestId } = renderCard();

      const terms = getByTestId("agent-auto-execute-terms");
      expect(terms.id).toBe("agent-consent-terms");
      // Verbatim, and from the one author: the sentence the safety strip's widened
      // reading quotes is the sentence this checkbox is described by.
      expect(terms.textContent).toBe(autoExecuteTerms("data-analysis"));
      expect(getByTestId("agent-auto-execute").getAttribute("aria-describedby")).toBe("agent-consent-terms");
      // Present in the accessibility tree while the popover is closed — hidden from
      // sight only. `aria-hidden` or a conditional render here would remove the
      // description the checkbox claims to have.
      expect(terms.className).toContain("sr-only");
      expect(terms.getAttribute("aria-hidden")).toBeNull();
    });

    test("the info control is a keyboard-reachable button that unhides the terms", () => {
      const { getByTestId } = renderCard();

      const info = getByTestId("agent-consent-terms-info");
      expect(info.tagName).toBe("BUTTON");
      expect(info.getAttribute("type")).toBe("button");
      // Named, because a lone glyph names nothing.
      expect(info.getAttribute("aria-label")).toBe("What the editor run adds");
      expect(info.getAttribute("aria-controls")).toBe("agent-consent-terms");
      expect(info.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(info);
      expect(info.getAttribute("aria-expanded")).toBe("true");
      expect(getByTestId("agent-auto-execute-terms").className).not.toContain("sr-only");

      fireEvent.click(info);
      expect(info.getAttribute("aria-expanded")).toBe("false");
      expect(getByTestId("agent-auto-execute-terms").className).toContain("sr-only");
    });

    test("the info control is outside the label, so reading the terms cannot tick the box", () => {
      const ticks: boolean[] = [];
      const { getByTestId } = renderCard({ onAutoExecuteChange: (next) => ticks.push(next) });

      fireEvent.click(getByTestId("agent-consent-terms-info"));
      expect(ticks).toEqual([]);
      expect(getByTestId("agent-auto-execute-label").contains(getByTestId("agent-consent-terms-info"))).toBe(false);
    });
  });

  describe("the bounds of what was ticked", () => {
    test("no chips while the box is off: there is no widening to bound", () => {
      const { queryByTestId } = renderCard({ autoExecute: false });

      expect(queryByTestId("agent-consent-bounds")).toBeNull();
    });

    test("the chips are read off AGENT_HANDOVER_BUDGET, not typed", () => {
      const { getByTestId } = renderCard({ autoExecute: true });

      const chips = getByTestId("agent-consent-bounds").textContent ?? "";
      expect(chips).toContain("same read-only session");
      // Derived: a budget change that leaves the copy behind fails here.
      expect(chips).toContain(`${AGENT_HANDOVER_BUDGET.maxResultRows} rows`);
      expect(chips).toContain("no time limit");
    });

    test("the SQLite chip is shown on SQLite and on nothing else", () => {
      const { getByTestId } = renderCard({ autoExecute: true, engine: "sqlite" });
      expect(getByTestId("agent-consent-bounds").textContent).toContain("SQLite: not interruptible");
      cleanup();

      const other = renderCard({ autoExecute: true, engine: "postgres" });
      expect(other.getByTestId("agent-consent-bounds").textContent).not.toContain("SQLite");
    });
  });

  describe("the sentence that is true of one engine", () => {
    test("SQLite is told what a long read costs there, in the words the budget meter uses", () => {
      const { getByTestId } = renderCard({ engine: "sqlite" });

      expect(getByTestId("agent-auto-execute-sqlite").textContent).toBe(
        "On SQLite a read is not interrupted when it runs long: it blocks other writers and this application until it finishes.",
      );
    });

    test("it does not wait for the tick: it is true of the run either way", () => {
      const { getByTestId } = renderCard({ engine: "sqlite", autoExecute: false });

      expect(getByTestId("agent-auto-execute-sqlite")).toBeTruthy();
    });

    test("another engine is not told a SQLite fact, and neither is an unresolved one", () => {
      const { queryByTestId } = renderCard({ engine: "postgres" });
      expect(queryByTestId("agent-auto-execute-sqlite")).toBeNull();
      cleanup();

      const unresolved = renderCard({ engine: null });
      expect(unresolved.queryByTestId("agent-auto-execute-sqlite")).toBeNull();
    });
  });

  describe("the two exits", () => {
    test("Start run opens the run, and keeps the testid the rail's tests reach for", () => {
      const onOpen = mock(() => {});
      const { getByTestId } = renderCard({ onOpen });

      const open = getByTestId("agent-consent-open");
      expect(open.textContent).toBe("Start run");
      expect(open.getAttribute("type")).toBe("button");

      fireEvent.click(open);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    test("Cancel opens nothing and hands the focus decision back to the caller", () => {
      const onCancel = mock(() => {});
      const onOpen = mock(() => {});
      const { getByTestId } = renderCard({ onCancel, onOpen });

      const cancel = getByTestId("agent-consent-cancel");
      expect(cancel.textContent).toBe("Cancel");

      fireEvent.click(cancel);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    });
  });
});
