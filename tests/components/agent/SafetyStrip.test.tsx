import "../../setup-dom";

import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SafetyStrip } from "@/components/agent/SafetyStrip";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { type AgentPosture, type AgentPostureTone, agentPosture } from "@/lib/agent/posture";
import { getDBConfig } from "@/lib/db-ui-config";
import type { DatabaseType } from "@/lib/types";

/**
 * The standing safety strip: one always-visible row saying what the SELECTED MODE does
 * to the database.
 *
 * The claims themselves are `src/lib/agent/posture.ts`'s, and
 * `tests/unit/lib/agent/posture.test.ts` is where their exact reviewed wording is pinned.
 * These tests therefore assert against `agentPosture` rather than against copied strings:
 * a paraphrase here would be a second opinion about a sentence with one author, and a
 * literal would pass while the strip rendered the wrong half of the posture. What is
 * pinned HERE is that the strip renders that posture whole —
 *
 *  - the headline in the pill and the qualifier BESIDE it, never folded away. The
 *    qualifier is the half a compressed headline drops, and dropping it overclaims;
 *  - the full claim reaching assistive technology whether or not the popover is open,
 *    which is the one property an ⓘ can quietly lose;
 *  - a real `<button>` for the ⓘ, so the keyboard path is the platform's rather than a
 *    click handler on a `<span>`;
 *  - a tone for each of the four levels, expressed in palette classes and never in a
 *    literal colour.
 */

afterEach(cleanup);

/** An engine agent mode has no read-only statement path on, taken from the real gate. */
const UNSUPPORTED_ENGINE: DatabaseType = (["mongodb", "redis", "oracle", "mssql", "mysql"] as DatabaseType[]).filter(
  (type) => !AGENT_EXECUTION_ENGINES.includes(type),
)[0] as DatabaseType;

/** An engine it does, so this file cannot pin a tone the gate no longer produces. */
const SUPPORTED_ENGINE: DatabaseType = AGENT_EXECUTION_ENGINES[0] as DatabaseType;

interface StripCase {
  readonly mode: "planning" | "agent";
  readonly engine: DatabaseType | null;
  readonly handover: boolean;
}

const PLAN: StripCase = { mode: "planning", engine: SUPPORTED_ENGINE, handover: false };
const READS: StripCase = { mode: "agent", engine: SUPPORTED_ENGINE, handover: false };
const WIDENED: StripCase = { mode: "agent", engine: SUPPORTED_ENGINE, handover: true };
const BLOCKED: StripCase = { mode: "agent", engine: UNSUPPORTED_ENGINE, handover: false };
const UNRESOLVED: StripCase = { mode: "agent", engine: null, handover: false };

const labelFor = (engine: DatabaseType | null): string => (engine === null ? "" : getDBConfig(engine).label);

const postureFor = (input: StripCase): AgentPosture =>
  agentPosture({
    mode: input.mode,
    engine: input.engine,
    engineLabel: labelFor(input.engine),
    handover: input.handover,
  });

function renderStrip(input: StripCase) {
  return render(
    <SafetyStrip
      mode={input.mode}
      engine={input.engine}
      engineLabel={labelFor(input.engine)}
      handover={input.handover}
    />,
  );
}

describe("SafetyStrip renders the posture whole", () => {
  test("the pill carries the headline and the qualifier sits beside it, visible", () => {
    const { getByTestId } = renderStrip(PLAN);
    const expected = postureFor(PLAN);

    expect(getByTestId("agent-safety-headline").textContent).toBe(expected.headline);
    expect(getByTestId("agent-safety-qualifier").textContent).toBe(expected.qualifier);
    // Not merely present: not hidden either. A qualifier folded behind the ⓘ is the
    // compression the posture module's header says overclaims.
    expect(getByTestId("agent-safety-qualifier").className).not.toContain("sr-only");
    expect(getByTestId("agent-safety-qualifier").getAttribute("aria-hidden")).toBeNull();
  });

  test("plan mode's headline is the reviewed one, so a strip rendering the wrong field fails", () => {
    const { getByTestId } = renderStrip(PLAN);
    expect(getByTestId("agent-safety-headline").textContent).toBe("Executes nothing it drafts");
  });

  test("the qualifier wraps to a second line rather than being truncated", () => {
    const { getByTestId } = renderStrip(BLOCKED);
    expect(getByTestId("agent-safety-strip").className).toContain("flex-wrap");
    expect(getByTestId("agent-safety-qualifier").className).not.toContain("truncate");
    expect(getByTestId("agent-safety-qualifier").className).not.toContain("text-ellipsis");
  });

  test("the strip renders the posture and invents nothing — no connection name of its own", () => {
    const { getByTestId } = renderStrip(READS);
    const expected = postureFor(READS);
    // Everything the strip says, in the order it says it. The connection name is the
    // rail header's and stays there, so anything here that is not one of the posture's
    // four fields is copy this component wrote by itself.
    expect(getByTestId("agent-safety-strip").textContent).toBe(
      `${expected.headline}${expected.qualifier}${expected.title}${expected.body}`,
    );
  });
});

describe("SafetyStrip tones", () => {
  const CASES: ReadonlyArray<readonly [string, StripCase, AgentPostureTone]> = [
    ["plan mode is safe", PLAN, "safe"],
    ["agent mode on an executable engine reads", READS, "reads"],
    ["a consented hand-over is widened", WIDENED, "widened"],
    ["an engine with no read-only statement path is blocked", BLOCKED, "blocked"],
    ["no resolved connection is blocked too", UNRESOLVED, "blocked"],
  ];

  for (const [name, input, tone] of CASES) {
    test(`${name}, and the tone is the posture's own`, () => {
      const { getByTestId } = renderStrip(input);
      expect(postureFor(input).tone).toBe(tone);
      // Carried as data rather than inferred from a class name, so a restyle cannot
      // change which level this strip claims.
      expect(getByTestId("agent-safety-strip").getAttribute("data-tone")).toBe(tone);
      expect(getByTestId("agent-safety-headline").textContent).toBe(postureFor(input).headline);
    });
  }

  test("each of the four tones paints a different pill", () => {
    const painted = new Set<string>();
    for (const input of [PLAN, READS, WIDENED, BLOCKED]) {
      const { getByTestId, unmount } = renderStrip(input);
      painted.add(getByTestId("agent-safety-headline").className);
      unmount();
    }
    expect(painted.size).toBe(4);
  });

  test("no tone is written as a literal colour", () => {
    for (const input of [PLAN, READS, WIDENED, BLOCKED, UNRESOLVED]) {
      const { container, unmount } = renderStrip(input);
      for (const node of container.querySelectorAll<HTMLElement>("[class]")) {
        expect(node.className).not.toMatch(/#[0-9a-f]{3}/i);
        expect(node.className).not.toMatch(/\b(rgb|hsl|oklch)\(/i);
      }
      unmount();
    }
  });
});

describe("SafetyStrip's info affordance", () => {
  test("is a real button, not a span with a handler", () => {
    const { getByTestId } = renderStrip(READS);
    const info = getByTestId("agent-safety-info");

    expect(info.tagName).toBe("BUTTON");
    expect(info.getAttribute("type")).toBe("button");
    // Named for a user who cannot see the pill: the label says which axis this is and
    // which level the strip is on.
    expect(info.getAttribute("aria-label")).toContain(postureFor(READS).headline);
  });

  test("is keyboard reachable and reports its own state", () => {
    const { getByTestId } = renderStrip(READS);
    const info = getByTestId("agent-safety-info") as HTMLButtonElement;

    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(info.hasAttribute("disabled")).toBe(false);
    expect(info.getAttribute("tabindex")).toBeNull();

    info.focus();
    expect(document.activeElement).toBe(info);
  });

  test("toggles the claim open and shut", () => {
    const { getByTestId } = renderStrip(WIDENED);
    const info = getByTestId("agent-safety-info");
    const claim = getByTestId("agent-safety-claim");

    expect(claim.getAttribute("data-open")).toBe("false");

    fireEvent.click(info);
    expect(claim.getAttribute("data-open")).toBe("true");
    expect(info.getAttribute("aria-expanded")).toBe("true");
    expect(claim.className).not.toContain("sr-only");

    fireEvent.click(info);
    expect(claim.getAttribute("data-open")).toBe("false");
    expect(info.getAttribute("aria-expanded")).toBe("false");
  });

  /*
    The keyboard path in full, on the ⓘ itself: it is the only focusable node in the strip,
    so it is where a keyboard user is when the card is open and the only place Escape can
    be pressed from.
  */
  test("Escape shuts an open claim and leaves focus on the button", () => {
    const { getByTestId } = renderStrip(BLOCKED);
    const info = getByTestId("agent-safety-info") as HTMLButtonElement;

    info.focus();
    fireEvent.click(info);
    expect(getByTestId("agent-safety-claim").getAttribute("data-open")).toBe("true");

    fireEvent.keyDown(info, { key: "Escape" });
    expect(getByTestId("agent-safety-claim").getAttribute("data-open")).toBe("false");
    expect(document.activeElement).toBe(info);
  });

  test("a key that is not Escape leaves the claim alone", () => {
    const { getByTestId } = renderStrip(BLOCKED);
    const info = getByTestId("agent-safety-info");
    fireEvent.click(info);
    fireEvent.keyDown(info, { key: "a" });
    expect(getByTestId("agent-safety-claim").getAttribute("data-open")).toBe("true");
  });

  test("Escape on a shut claim is not an error", () => {
    const { getByTestId } = renderStrip(BLOCKED);
    fireEvent.keyDown(getByTestId("agent-safety-info"), { key: "Escape" });
    expect(getByTestId("agent-safety-claim").getAttribute("data-open")).toBe("false");
  });
});

describe("SafetyStrip's accessible description", () => {
  test("the strip is described by the claim node, and the claim holds title and body", () => {
    const { getByTestId } = renderStrip(BLOCKED);
    const strip = getByTestId("agent-safety-strip");
    const claim = getByTestId("agent-safety-claim");
    const expected = postureFor(BLOCKED);

    expect(claim.id.length).toBeGreaterThan(0);
    expect(strip.getAttribute("aria-describedby")).toBe(claim.id);

    // BOTH halves, and the body is the whole claim rather than a summary of it.
    expect(claim.textContent).toContain(expected.title);
    expect(claim.textContent).toContain(expected.body);
    // The engine the mode cannot execute on is named, not implied.
    expect(claim.textContent).toContain(getDBConfig(UNSUPPORTED_ENGINE).label);
  });

  test("the claim reaches assistive tech while the popover is visually shut", () => {
    const { getByTestId } = renderStrip(PLAN);
    const claim = getByTestId("agent-safety-claim");

    // Shut, so it is out of the layout — and still rendered, still named by
    // `aria-describedby`, and NOT `aria-hidden`, which would take it back out of the
    // accessibility tree and leave the ⓘ as the only way to the claim.
    expect(claim.getAttribute("data-open")).toBe("false");
    expect(claim.className).toContain("sr-only");
    expect(claim.getAttribute("aria-hidden")).toBeNull();
    expect(claim.getAttribute("hidden")).toBeNull();
    expect(claim.textContent).toContain(postureFor(PLAN).body);
  });

  test("the button points at the claim it toggles", () => {
    const { getByTestId } = renderStrip(READS);
    expect(getByTestId("agent-safety-info").getAttribute("aria-controls")).toBe(getByTestId("agent-safety-claim").id);
  });

  test("every posture's body reaches the description, on all four levels", () => {
    for (const input of [PLAN, READS, WIDENED, BLOCKED, UNRESOLVED]) {
      const { getByTestId, unmount } = renderStrip(input);
      expect(getByTestId("agent-safety-claim").textContent).toContain(postureFor(input).body);
      unmount();
    }
  });
});
