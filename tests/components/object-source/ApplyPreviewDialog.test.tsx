import "../../setup-dom";

import { mock } from "bun:test";
import React from "react";

/**
 * The apply preview dialog, six states and no other way in or out (#789 Phase 3, discussion #778).
 *
 * `@monaco-editor/react`'s `DiffEditor` is replaced with two `<textarea>`s plus a recorder,
 * because happy-dom cannot run Monaco and because what this suite asserts is the COMPOSITION
 * around the diff: which text is on which side, which ranges are shaded, which model paths the two
 * models take and which options the editor is constructed with. What only a real browser can
 * answer is answered in the browser, and the two facts this file builds on were measured there:
 * `createDiffEditor` mounts and computes under this app's production CSP, and a dispose left both
 * models in `monaco.editor.getModels()`.
 *
 * The double records the props rather than asserting on them, and it drives `onMount` with a
 * monaco double whose model maps offset `n` to line 1 column `n + 1`. That is what lets the
 * decoration assertions read as OFFSETS, which is the coordinate the component's own input
 * (`providerRanges`) is in, while still going through the real `model.getPositionAt` conversion
 * the component performs.
 */

interface CapturedDiffProps {
  original?: string;
  modified?: string;
  language?: string;
  originalModelPath?: string;
  modifiedModelPath?: string;
  keepCurrentOriginalModel?: boolean;
  keepCurrentModifiedModel?: boolean;
  theme?: string;
  options?: Record<string, unknown>;
}

interface FakeRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

let diffProps: CapturedDiffProps | undefined;
let painted: readonly { range: FakeRange }[] = [];
let paintCalls = 0;
let definedThemes: string[] = [];
/** Set by a single test, to drive the one branch where the modified model is not there yet. */
let modelIsNull = false;

class RangeDouble implements FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
}

function monacoDouble() {
  return {
    Range: RangeDouble,
    editor: {
      defineTheme: (id: string) => {
        definedThemes.push(id);
      },
    },
  };
}

function diffEditorDouble() {
  const model = {
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
  };
  const collection = {
    set: (decorations: readonly { range: FakeRange }[]) => {
      painted = decorations;
      paintCalls += 1;
    },
    clear: () => {},
  };
  const modified = {
    getModel: () => (modelIsNull ? null : model),
    createDecorationsCollection: (decorations: readonly { range: FakeRange }[]) => {
      painted = decorations;
      paintCalls += 1;
      return collection;
    },
  };
  return { getModifiedEditor: () => modified };
}

mock.module("@monaco-editor/react", () => ({
  DiffEditor: function MockDiffEditor(
    props: CapturedDiffProps & {
      beforeMount?: (monaco: unknown) => void;
      onMount?: (diff: unknown, monaco: unknown) => void;
    },
  ) {
    diffProps = props;
    const mounted = React.useRef(false);
    React.useEffect(() => {
      if (mounted.current) return;
      mounted.current = true;
      props.beforeMount?.(monacoDouble());
      props.onMount?.(diffEditorDouble(), monacoDouble());
    });
    return (
      <div>
        <textarea data-testid="diff-original" readOnly value={props.original ?? ""} />
        <textarea data-testid="diff-modified" readOnly value={props.modified ?? ""} />
      </div>
    );
  },
}));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ApplyPreviewDialog,
  type ApplyPreviewFailure,
  type ApplyPreviewState,
} from "@/components/object-source/ApplyPreviewDialog";
import { EDIT_PLAN_EXECUTABLE_LIMIT, providerRanges } from "@/lib/db/object-edit";
import type {
  ObjectEditConsequence,
  ObjectEditCurrentText,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditStep,
} from "@/lib/db/types";

/** The sent length the identity line and the payload line both report, verbatim from the brief. */
const SENT_LENGTH = 1234;

/**
 * MEASURED: `'SET LOCAL search_path="app",pg_catalog;\n'` is exactly 40 UTF-16 code units, which is
 * what makes the decoration assertion below a fixed pair of numbers rather than a derivation.
 */
const PG_PROVIDER_PREFIX = 'SET LOCAL search_path="app",pg_catalog;\n';

const PG_BODY = `CREATE OR REPLACE FUNCTION app.order_total(order_id integer)
RETURNS numeric
LANGUAGE sql
AS $$
  SELECT sum(li.amount)
  FROM app.line_item li
  WHERE li.order_id = order_total.order_id
$$;
`;

/** Padded with a SQL comment rule, so the step's text is exactly the length the identity line claims. */
const PG_USER_TEXT = PG_BODY.padEnd(SENT_LENGTH - PG_PROVIDER_PREFIX.length, "-");

const PG_STEP: ObjectEditStep = {
  text: PG_PROVIDER_PREFIX + PG_USER_TEXT,
  language: "sql",
  segments: [
    { from: "provider", text: PG_PROVIDER_PREFIX },
    { from: "user", start: 0, end: PG_USER_TEXT.length },
  ],
};

const PLAN: ObjectEditPlan = {
  planVersion: 1,
  planId: "plan-one",
  issuedAt: "2026-09-14T09:00:00.000Z",
  connectionFingerprint: "fingerprint-one",
  type: "postgres",
  path: ["app", "order_total(integer)"],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: { medium: "statement", steps: [PG_STEP] },
  session: [
    // The asserted pin comes FIRST, because it is the entry a lookup that forgot to filter on
    // `mode` would report as a pin. Nothing in this apply SETS `check_function_bodies`.
    { mode: "asserted", setting: "check_function_bodies", value: "on" },
    { mode: "pinned", setting: "search_path", value: '"app", pg_catalog' },
  ],
  revision: { check: "guarded", token: "md5:9f1", basis: "md5(prosrc)", scope: "server" },
  consequences: [],
};

const PREIMAGE: ObjectEditPreimage = {
  text: `CREATE OR REPLACE FUNCTION app.order_total(order_id integer)
RETURNS numeric
LANGUAGE sql
AS $$
  SELECT sum(li.amount) FROM app.line_item li WHERE li.order_id = order_total.order_id
$$;
`,
  language: "sql",
};

/**
 * The Trino-shaped plan, and the one property it exists for: the reader's OWN text contains the
 * provider's literal, EARLIER than the splice. A shading built by searching the sent text for
 * ` OR REPLACE` shades the reader's comment and leaves the real splice plain.
 */
const TRINO_USER_TEXT = `-- OR REPLACE is what LibreDB adds, not me
CREATE FUNCTION app.f(x integer)
RETURNS integer
RETURN x + 1`;
const TRINO_SPLICE_AT = TRINO_USER_TEXT.indexOf("CREATE") + "CREATE".length;
const TRINO_SPLICE = " OR REPLACE";

const TRINO_STEP: ObjectEditStep = {
  text: TRINO_USER_TEXT.slice(0, TRINO_SPLICE_AT) + TRINO_SPLICE + TRINO_USER_TEXT.slice(TRINO_SPLICE_AT),
  language: "sql",
  segments: [
    { from: "user", start: 0, end: TRINO_SPLICE_AT },
    { from: "provider", text: TRINO_SPLICE },
    { from: "user", start: TRINO_SPLICE_AT, end: TRINO_USER_TEXT.length },
  ],
};

const TRINO_PLAN: ObjectEditPlan = {
  ...PLAN,
  planId: "plan-trino",
  type: "trino",
  strategy: "replace-in-place-statement",
  unit: { medium: "statement", steps: [TRINO_STEP] },
  session: [],
};

const REDIS_PAYLOAD_TEXT = `#!lua name=orders
redis.register_function('order_total', function(keys, args) return 1 end)
`.padEnd(SENT_LENGTH, "-");

const REDIS_PLAN: ObjectEditPlan = {
  ...PLAN,
  planId: "plan-redis",
  type: "redis",
  strategy: "replace-in-place-command",
  unit: {
    medium: "command",
    name: "FUNCTION",
    arguments: ["LOAD", "REPLACE"],
    payload: {
      text: REDIS_PAYLOAD_TEXT,
      language: "lua",
      segments: [{ from: "user", start: 0, end: REDIS_PAYLOAD_TEXT.length }],
    },
  },
  session: [],
};

const COLLATERAL: ObjectEditConsequence = {
  loses: "replaces-whole-container",
  fact: {
    source: "FUNCTION LIST LIBRARYNAME orders",
    observed: "the library registers order_total and order_count",
  },
};

const CURRENT: ObjectEditCurrentText = {
  text: `CREATE OR REPLACE FUNCTION app.order_total(order_id integer)
RETURNS numeric
LANGUAGE sql
AS $$ SELECT 0 $$;
`,
  language: "sql",
};

const USER_TEXT = PG_USER_TEXT;

const handlers = {
  onApply: mock((_acknowledged: readonly string[]) => {}),
  onRebuild: mock(() => {}),
  onGoToError: mock((_at: unknown) => {}),
  onClose: mock(() => {}),
};

function draw(state: ApplyPreviewState) {
  return render(
    <ApplyPreviewDialog
      open
      state={state}
      objectLabel="app.order_total(integer)"
      partLabel="Definition"
      address="conn/app.f(integer)/function"
      partId="definition"
      onApply={handlers.onApply}
      onRebuild={handlers.onRebuild}
      onGoToError={handlers.onGoToError}
      onClose={handlers.onClose}
    />,
  );
}

const testId = (suffix: string) => `object-source-apply${suffix}`;
const query = (suffix: string) => screen.queryByTestId(testId(suffix));
const text = (suffix: string) => screen.getByTestId(testId(suffix)).textContent;
const rows = (suffix: string) => screen.queryAllByTestId(testId(suffix));
const button = (suffix: string) => screen.getByTestId(testId(suffix)) as HTMLButtonElement;
/**
 * The element's role as the ACCESSIBILITY layer computes it, implicit roles included.
 *
 * Not `getAttribute("role")`: the two live regions here are `<output>` elements, which carry
 * `status` natively and which is what this repository's jsx-a11y gate requires over a div with the
 * attribute. Reading the attribute would answer null for a region that is correctly a status.
 */
const role = (suffix: string) => {
  const node = screen.getByTestId(testId(suffix));
  const explicit = node.getAttribute("role");
  if (explicit !== null) return explicit;
  return screen.queryAllByRole("status").includes(node) ? "status" : null;
};
const click = (suffix: string) => {
  fireEvent.click(screen.getByTestId(testId(suffix)));
};
const headers = () => screen.queryAllByTestId(testId("-diff-header")).map((node) => node.textContent);
/**
 * A pointer press on the Radix overlay, the way a reader dismisses a modal by clicking the backdrop.
 *
 * MEASURED in this environment, and it is why this is three events behind one timer flush rather
 * than one `fireEvent.pointerDown`: Radix registers its document `pointerdown` listener inside a
 * `setTimeout(0)`, so a press fired before that timer reaches nothing at all, and a bare
 * `pointerdown` with no `mousedown`/`click` behind it is swallowed by the layer's own
 * outside-interaction interception. With the flush and the full sequence the press closes the
 * dialog in `preview`, which is the control that makes the `applying` block non-vacuous.
 */
async function pressOverlay(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const overlay = document.querySelector("[data-slot='dialog-overlay']");
  if (overlay === null) throw new Error("no overlay to press");
  await act(async () => {
    fireEvent.pointerDown(overlay, { button: 0 });
    fireEvent.mouseDown(overlay, { button: 0 });
    fireEvent.click(overlay, { button: 0 });
  });
}
/** Offsets, decoded from the fake model's line-1 mapping, which is what `providerRanges` speaks. */
const decorations = () => painted.map((one) => ({ start: one.range.startColumn - 1, end: one.range.endColumn - 1 }));

const PREVIEW: ApplyPreviewState = { kind: "preview", plan: PLAN, preimage: PREIMAGE };

function refusal(outcome: ApplyPreviewFailure, plan: ObjectEditPlan = PLAN): ApplyPreviewState {
  return { kind: "failed", plan, preimage: PREIMAGE, outcome };
}

/**
 * The state X24 made reachable, and the one the frame was most wrong about: an apply that
 * SUCCEEDED, destroyed a sibling function, and holds the dialog open to say so.
 */
const COLLATERAL_OUTCOME: ApplyPreviewState = refusal({
  outcome: "applied-with-collateral",
  lost: [
    {
      loses: "replaces-whole-container",
      fact: { source: "FUNCTION LIST LIBRARYNAME orders", observed: "order_count is gone" },
    },
  ],
  revision: { check: "guarded", token: "md5:9f3", basis: "md5(prosrc)", scope: "server" },
  duration: 18,
});

describe("ApplyPreviewDialog", () => {
  beforeEach(() => {
    diffProps = undefined;
    painted = [];
    paintCalls = 0;
    definedThemes = [];
    modelIsNull = false;
    handlers.onApply.mockClear();
    handlers.onRebuild.mockClear();
    handlers.onGoToError.mockClear();
    handlers.onClose.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("the fixture really contains the case the decoration test exists for", () => {
    // The population, asserted rather than assumed: a guard is only real over data that can fail
    // it. Here that means the reader's own text carries the provider's literal BEFORE the splice,
    // so a search-based shading picks the wrong range rather than the right one by luck.
    expect(TRINO_USER_TEXT.indexOf(TRINO_SPLICE)).toBeGreaterThanOrEqual(0);
    expect(TRINO_USER_TEXT.indexOf(TRINO_SPLICE)).toBeLessThan(TRINO_SPLICE_AT);
    expect(PG_STEP.text.length).toBe(SENT_LENGTH);
    expect(REDIS_PLAN.unit.medium === "command" && REDIS_PLAN.unit.payload.text.length).toBe(SENT_LENGTH);
  });

  test("building draws a spinner and a disabled primary, and no diff at all", () => {
    draw({ kind: "building" });
    expect(query("-building")).not.toBeNull();
    expect(text("-building")).toContain("Building the statement");
    expect(button("-confirm").disabled).toBe(true);
    expect(query("-diff")).toBeNull();
    expect(diffProps).toBeUndefined();
  });

  test("preview draws the diff, and the LEFT side is the BUILD's pre-image", () => {
    // A left side taken from the tab would hide a change somebody else made while the tab sat
    // open, which is the whole shape of the failure this phase exists to prevent.
    draw(PREVIEW);
    expect(diffProps?.original).toBe(PREIMAGE.text);
    // The RIGHT side is the WHOLE UNIT, the exact bytes that will execute, and not the reader's
    // draft: for Trino the statement differs from what the reader typed by eleven characters they
    // never wrote, and for PostgreSQL the FIRST thing in the diff is a generated guard block.
    expect(diffProps?.modified).toBe(PLAN.unit.medium === "statement" ? PLAN.unit.steps[0].text : "");
    expect(diffProps?.modified).not.toBe(PG_USER_TEXT);
    expect(headers()).toEqual(["On the server now", "Will be sent"]);
    expect(diffProps?.language).toBe("sql");
  });

  test("the provider's own regions are shaded, at the ranges the SEGMENTS give", () => {
    // Built from `providerRanges(step)` and never from a search of the text, which would shade a
    // reader's own line that happened to match.
    draw(PREVIEW);
    expect(decorations()).toEqual([{ start: 0, end: 40 }]);
  });

  test("a reader's own text carrying the provider's literal is NOT what gets shaded", () => {
    draw({ kind: "preview", plan: TRINO_PLAN, preimage: PREIMAGE });
    expect(decorations()).toEqual([{ start: TRINO_SPLICE_AT, end: TRINO_SPLICE_AT + TRINO_SPLICE.length }]);
    expect(decorations()).toEqual([...providerRanges(TRINO_STEP)]);
  });

  test("a rebuilt plan repaints the shading through the collection it already holds", () => {
    const view = draw(PREVIEW);
    expect(paintCalls).toBe(1);
    view.rerender(
      <ApplyPreviewDialog
        open
        state={{ kind: "preview", plan: TRINO_PLAN, preimage: PREIMAGE }}
        objectLabel="app.order_total(integer)"
        partLabel="Definition"
        address="conn/app.f(integer)/function"
        partId="definition"
        onApply={handlers.onApply}
        onRebuild={handlers.onRebuild}
        onGoToError={handlers.onGoToError}
        onClose={handlers.onClose}
      />,
    );
    expect(paintCalls).toBeGreaterThan(1);
    expect(decorations()).toEqual([{ start: TRINO_SPLICE_AT, end: TRINO_SPLICE_AT + TRINO_SPLICE.length }]);
  });

  test("a mount with no modified model yet paints nothing and does not throw", () => {
    modelIsNull = true;
    draw(PREVIEW);
    expect(paintCalls).toBe(0);
    expect(query("-diff")).not.toBeNull();
  });

  test("one line under the diff states the identity, with the character count", () => {
    draw(PREVIEW);
    expect(text("-identity")).toBe(
      "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you typed, and the whole of the right side is what will be sent, 1,234 characters.",
    );
  });

  test("a plan with more than one step says so, because the diff shows only the first", () => {
    const twoStep: ObjectEditPlan = {
      ...PLAN,
      planId: "plan-two-step",
      strategy: "temp-name-test-create",
      unit: { medium: "statement", steps: [PG_STEP, { ...PG_STEP, text: "SELECT 1;" }] },
    };
    draw({ kind: "preview", plan: twoStep, preimage: PREIMAGE });
    // The byte-identity clause is NOT claimed here, and that is the repair: with two steps the
    // right side is one of them, so "the whole of the right side is what will be sent" would be
    // false for exactly the case the second sentence was added for. The count belongs to the plan
    // and the diff names which statement it is showing.
    expect(text("-identity")).toBe(
      "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you " +
        "typed. The diff shows statement 1 of 2, and 1,243 characters will be sent in total.",
    );
    expect(text("-identity")).not.toContain("the whole of the right side");
    expect(diffProps?.modified).toBe(PG_STEP.text);
  });

  test("the PINNED session value is a line the reader sees BEFORE confirming", () => {
    // Ruling 2e: the apply pins `search_path`, and a pin the reader cannot see is a session
    // dependency they cannot reason about.
    draw(PREVIEW);
    expect(text("-session-pin")).toContain('search_path set to "app", pg_catalog');
    // The other half of that ruling, and the assertion the mode filter is FOR: this apply only
    // READS `check_function_bodies`, so a line claiming a pin for it would be worse than no line.
    expect(text("-session-pin")).not.toContain("check_function_bodies");
    expect(rows("-session-pin")).toHaveLength(1);
  });

  test("two PINNED entries for one setting draw ONE line, not two", () => {
    // The population the dedupe in the pin loop is for, built rather than assumed. Nothing this
    // repository ships emits it, and nothing refuses it either: `isObjectEditPlanShape` checks
    // every entry's shape and asserts NO uniqueness over `setting`, so an embedded host's
    // `objectEditor.build` can answer exactly this. Two lines for one setting would read as two
    // pins, and the second value is not even the one `pinnedSessionValue` resolves.
    draw({
      kind: "preview",
      plan: {
        ...PLAN,
        session: [
          { mode: "pinned", setting: "search_path", value: '"app", pg_catalog' },
          { mode: "pinned", setting: "search_path", value: '"other"' },
        ],
      },
      preimage: PREIMAGE,
    });
    expect(rows("-session-pin")).toHaveLength(1);
    expect(text("-session-pin")).toContain('search_path set to "app", pg_catalog');
    expect(text("-session-pin")).not.toContain("other");
  });

  test("a plan that pins nothing draws no session line", () => {
    draw({ kind: "preview", plan: TRINO_PLAN, preimage: PREIMAGE });
    expect(query("-session-pin")).toBeNull();
  });

  test("a consequence draws a warning row per consequence and GATES the primary", () => {
    const planned: ObjectEditPlan = { ...PLAN, consequences: [COLLATERAL] };
    draw({ kind: "preview", plan: planned, preimage: PREIMAGE });
    expect(rows("-consequence")).toHaveLength(1);
    expect(text("-consequence")).toBe(
      "Applying this replaces the whole container, so anything in it that your text does not re-create is deleted. FUNCTION LIST LIBRARYNAME orders answers: the library registers order_total and order_count.",
    );
    expect(button("-confirm").disabled).toBe(true);
    click("-ack");
    expect(button("-confirm").disabled).toBe(false);
    click("-confirm");
    // The acknowledgement is sent as the list of CLASSES and the ROUTE enforces it, because a
    // client-only confirmation satisfies nothing a server can assert.
    expect(handlers.onApply).toHaveBeenCalledWith(["replaces-whole-container"]);
  });

  test("the acknowledgement stays on screen WHILE applying, checked and frozen", () => {
    // The population for the `|| applying` arm of the checkbox's visibility, which nothing else in
    // this suite builds: a reader who acknowledged a consequence and is now watching the apply run.
    // Dropping the row at that moment would take the sentence they agreed to off the screen for
    // exactly the seconds the destruction is happening, and leave the dialog claiming nothing was
    // acknowledged.
    const planned: ObjectEditPlan = { ...PLAN, consequences: [COLLATERAL] };
    const view = draw({ kind: "preview", plan: planned, preimage: PREIMAGE });
    click("-ack");
    view.rerender(
      <ApplyPreviewDialog
        open
        state={{ kind: "applying", plan: planned, preimage: PREIMAGE }}
        objectLabel="app.order_total(integer)"
        partLabel="Definition"
        address="conn/app.f(integer)/function"
        partId="definition"
        onApply={handlers.onApply}
        onRebuild={handlers.onRebuild}
        onGoToError={handlers.onGoToError}
        onClose={handlers.onClose}
      />,
    );
    expect(query("-ack")).not.toBeNull();
    expect(screen.getByTestId(testId("-ack")).getAttribute("data-state")).toBe("checked");
    expect(button("-ack").disabled).toBe(true);
    expect(rows("-consequence")).toHaveLength(1);
  });

  test("a TRUNCATED pre-image says so in the header and DISABLES Apply", () => {
    // Design 6.3 by name, and it had no test. The population, stated because "never built over a
    // truncated read anyway" is exactly the sentence that makes a guard look unnecessary: a build
    // is refused server-side for a truncated PART, and `ObjectEditPreimage.truncated` is a separate
    // field on a separate value that the route does not bound. A provider that answered a bounded
    // pre-image beside a plan would reach this dialog, and the reader would approve a right side
    // against a left side that is not the whole definition. This is the last line of that defence
    // and the only one on the client.
    draw({
      kind: "preview",
      plan: PLAN,
      preimage: {
        ...PREIMAGE,
        truncated: { limit: 1_000_000, reason: "the source read was bounded at 1,000,000 characters by its caller" },
      },
    });
    expect(text("-preimage-truncated")).toContain("not the whole definition");
    expect(button("-confirm").disabled).toBe(true);
  });

  test("THE CONTROL: an untruncated pre-image draws no such header and leaves Apply enabled", () => {
    // Without this the assertion above passes against a dialog that disables Apply unconditionally.
    draw(PREVIEW);
    expect(query("-preimage-truncated")).toBeNull();
    expect(button("-confirm").disabled).toBe(false);
  });

  test("a plan ABOVE the apply route's own bound never reaches a Monaco model", () => {
    // The trust boundary this dialog sits on, and the bound is the EXISTING one rather than a
    // third number invented here: `EDIT_PLAN_EXECUTABLE_LIMIT` is what both apply routes enforce.
    // The population: the STANDALONE path is bounded at both routes, and the EMBEDDED path passes
    // through no route at all. `isObjectEditPlanShape` bounds NO string (grep `length` in
    // `src/lib/api/object-edit-wire.ts`: four shape predicates, no bound), so an embedded host's
    // `objectEditor.build` can answer a well-formed plan whose step text is 50 MB, and the tab
    // hangs building a diff model for bytes no apply could ever send.
    const huge = "-".repeat(EDIT_PLAN_EXECUTABLE_LIMIT + 1);
    draw({
      kind: "preview",
      plan: {
        ...PLAN,
        unit: {
          medium: "statement",
          steps: [{ text: huge, language: "sql", segments: [{ from: "user", start: 0, end: huge.length }] }],
        },
      },
      preimage: PREIMAGE,
    });
    expect(text("-oversize")).toBe(
      "One side of this diff is 1,200,001 characters, above the 1,200,000 an apply can send, so LibreDB is " +
        "not drawing it. Rebuild the preview, or shorten the definition.",
    );
    expect(query("-diff")).toBeNull();
    expect(diffProps).toBeUndefined();
    expect(query("-identity")).toBeNull();
    expect(button("-confirm").disabled).toBe(true);
  });

  test("THE CONTROL: a plan AT the bound still draws its diff and leaves Apply enabled", () => {
    // Without this the assertion above passes against a dialog that refuses every plan.
    const atLimit = "-".repeat(EDIT_PLAN_EXECUTABLE_LIMIT);
    draw({
      kind: "preview",
      plan: {
        ...PLAN,
        unit: {
          medium: "statement",
          steps: [{ text: atLimit, language: "sql", segments: [{ from: "user", start: 0, end: atLimit.length }] }],
        },
      },
      preimage: PREIMAGE,
    });
    expect(query("-oversize")).toBeNull();
    expect(diffProps?.modified).toBe(atLimit);
    expect(button("-confirm").disabled).toBe(false);
  });

  test("an oversized CONFLICT text is refused the same way, and it is not the plan that is big", () => {
    // The conflict screen's left side is `outcome.current.text`, which arrives over the same wire
    // and through the same unbounded predicate as the plan.
    draw({
      kind: "conflict",
      plan: PLAN,
      current: { text: "-".repeat(EDIT_PLAN_EXECUTABLE_LIMIT + 1), language: "sql" },
      userText: USER_TEXT,
    });
    expect(query("-oversize")).not.toBeNull();
    expect(query("-diff")).toBeNull();
    // The conflict header still says what happened, and the rebuild is still the way out.
    expect(text("-conflict")).toContain("This definition changed after you opened it.");
    click("-rebuild");
    expect(handlers.onRebuild).toHaveBeenCalled();
  });

  test("with NO consequences there is no checkbox, so the common case is two clicks", () => {
    draw(PREVIEW);
    expect(query("-ack")).toBeNull();
    expect(button("-confirm").disabled).toBe(false);
    click("-confirm");
    expect(handlers.onApply).toHaveBeenCalledWith([]);
  });

  test("the acknowledgement RESETS when the plan is rebuilt", () => {
    // A rebuilt plan can carry different consequences, so an acknowledgement that survived would be
    // a reader agreeing to something they were never shown.
    const first: ObjectEditPlan = { ...PLAN, consequences: [COLLATERAL] };
    const rebuilt: ObjectEditPlan = { ...first, planId: "plan-two" };
    const view = draw({ kind: "preview", plan: first, preimage: PREIMAGE });
    click("-ack");
    expect(button("-confirm").disabled).toBe(false);
    view.rerender(
      <ApplyPreviewDialog
        open
        state={{ kind: "preview", plan: rebuilt, preimage: PREIMAGE }}
        objectLabel="app.order_total(integer)"
        partLabel="Definition"
        address="conn/app.f(integer)/function"
        partId="definition"
        onApply={handlers.onApply}
        onRebuild={handlers.onRebuild}
        onGoToError={handlers.onGoToError}
        onClose={handlers.onClose}
      />,
    );
    expect(button("-confirm").disabled).toBe(true);
    expect(screen.getByTestId(testId("-ack")).getAttribute("data-state")).toBe("unchecked");
  });

  test("the revision note has one sentence per arm, and `guarded` draws nothing", () => {
    draw(PREVIEW);
    expect(query("-revision-note")).toBeNull();
    cleanup();

    draw({
      kind: "preview",
      plan: {
        ...PLAN,
        revision: { check: "compared", token: "t", basis: "SHOW CREATE FUNCTION", scope: "server" },
      },
      preimage: PREIMAGE,
    });
    expect(text("-revision-note")).toBe(
      "This apply re-reads the definition first and refuses if it differs from the left side.",
    );
    cleanup();

    // A WARNING row on this arm, carrying the provider's sentence plus ours. No day-one engine
    // produces it, and the design records that plainly rather than letting a later reader assume
    // it was exercised.
    draw({
      kind: "preview",
      plan: {
        ...PLAN,
        revision: { check: "unavailable", reason: "MySQL publishes no usable revision for a routine" },
      },
      preimage: PREIMAGE,
    });
    expect(text("-revision-note")).toContain("MySQL publishes no usable revision for a routine");
    expect(text("-revision-note")).toContain("cannot tell whether somebody else changed this definition first");
  });

  test("the COMMAND arm draws a payload block above the diff, summarised by length", () => {
    // The verb is shown as DATA and never as something that reads like SQL, because a reader who
    // thinks they are approving a statement will read the diff as one.
    draw({ kind: "preview", plan: REDIS_PLAN, preimage: { text: "#!lua name=orders\n", language: "lua" } });
    expect(text("-payload")).toBe("FUNCTION LOAD REPLACE <library code, 1,234 characters>");
    expect(diffProps?.modified).toBe(REDIS_PAYLOAD_TEXT);
    expect(diffProps?.language).toBe("lua");
    // The identity line belongs to the statement arm: on a command the payload block is what
    // carries the length, and a sentence about "the right side" would be describing the argument.
    expect(query("-identity")).toBeNull();
  });

  test("applying freezes the body, disables the primary and BLOCKS every way out", () => {
    // `onEscapeKeyDown` and `onPointerDownOutside` prevent default and `showCloseButton={false}`.
    draw({ kind: "applying", plan: PLAN, preimage: PREIMAGE });
    expect(button("-confirm").disabled).toBe(true);
    expect(text("-applying")).toContain("Applying");
    expect(button("-cancel").disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[data-slot='dialog-close']")).toBeNull();
  });

  test("THE CONTROL: Escape DOES close the dialog in preview, so the block above is not vacuous", () => {
    draw(PREVIEW);
    expect(document.querySelector("[data-slot='dialog-close']")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onClose).toHaveBeenCalled();
  });

  test("applying BLOCKS the overlay as well: a press on the backdrop does not close it", async () => {
    // The other half of "no other way out", and it was the half resting on a comment: Escape had a
    // test, the overlay had none, and deleting `onPointerDownOutside` and `onInteractOutside` left
    // the suite green. MEASURED here rather than deferred to a browser, with the control below.
    draw({ kind: "applying", plan: PLAN, preimage: PREIMAGE });
    await pressOverlay();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  test("THE CONTROL: a press on the backdrop DOES close the dialog in preview", async () => {
    // Without this the block above would pass in an environment where the press never reaches the
    // layer at all, which is exactly how this suite's first overlay probe read: a bare
    // `fireEvent.pointerDown` with no timer flush closes nothing in EITHER state.
    draw(PREVIEW);
    await pressOverlay();
    expect(handlers.onClose).toHaveBeenCalled();
  });

  test("a refusal keeps the dialog OPEN, shows the code as data, and offers Go to the error", () => {
    draw(
      refusal({
        outcome: "refused",
        duration: 41,
        refusal: {
          refusal: "definition",
          sentence: "cannot change return type of existing function",
          code: "42P13",
          hint: "Use DROP FUNCTION app.f_demo(integer) first.",
          at: { within: "user", line: 7, column: 3 },
        },
      }),
    );
    expect(query("-dialog")).not.toBeNull();
    expect(text("-outcome")).toContain("cannot change return type of existing function");
    expect(text("-outcome-code")).toBe("42P13");
    // The engine's own hint, kept because the shipped mapper destroys it.
    expect(text("-outcome")).toContain("Use DROP FUNCTION app.f_demo(integer) first.");
    // The diff is still under the failure, unchanged.
    expect(diffProps?.original).toBe(PREIMAGE.text);
    click("-goto-error");
    expect(handlers.onGoToError).toHaveBeenCalledWith({ within: "user", line: 7, column: 3 });
  });

  test("a PRIVILEGE refusal offers NO retry and says where the failure lives", () => {
    // Today the identical refusal reaches the browser prefixed "Authentication failed", at HTTP
    // 401, and a reader is sent to fix a credential that was never wrong.
    draw(
      refusal({
        outcome: "refused",
        duration: 12,
        refusal: {
          refusal: "privilege",
          sentence: "must be owner of function order_total",
          code: "42501",
          at: { within: "none" },
        },
      }),
    );
    expect(text("-outcome")).toContain("must be owner of function order_total");
    expect(text("-outcome")).toContain(
      "This apply runs as the database credential on this connection and not as your LibreDB login, so re-entering your password will not change this.",
    );
    expect(query("-goto-error")).toBeNull();
    expect(query("-confirm")).toBeNull();
  });

  test("an UNPLACEABLE coordinate is a sentence and never a marker", () => {
    // Turning a splice bug from invisible into reader-visible and test-visible.
    draw(
      refusal({
        outcome: "refused",
        duration: 8,
        refusal: {
          refusal: "definition",
          sentence: 'syntax error at or near "$$"',
          code: "42601",
          at: { within: "outside" },
        },
      }),
    );
    expect(text("-outcome")).toContain(
      "The engine reported a position inside the part LibreDB added, so no marker was placed.",
    );
    expect(query("-goto-error")).toBeNull();
  });

  test("a pinned-path refusal adds the sentence that names the path", () => {
    draw(
      refusal({
        outcome: "refused",
        duration: 9,
        refusal: {
          refusal: "definition",
          sentence: 'relation "t" does not exist',
          code: "42P01",
          at: { within: "user", line: 5, column: 10 },
        },
      }),
    );
    expect(text("-outcome")).toContain('search_path set to "app", pg_catalog');
    expect(text("-outcome")).toContain("Qualify the name");
  });

  test("a refusal on a plan that pinned no path adds no such sentence", () => {
    // The control for the line above: without it the assertion passes against a dialog that prints
    // the pinned-path sentence for every refusal.
    draw(
      refusal(
        {
          outcome: "refused",
          duration: 9,
          refusal: {
            refusal: "definition",
            sentence: 'relation "t" does not exist',
            code: "42P01",
            at: { within: "user", line: 5, column: 10 },
          },
        },
        TRINO_PLAN,
      ),
    );
    expect(text("-outcome")).not.toContain("search_path set to");
  });

  test("`applied-elsewhere` says the addressed object was NOT changed, and names what was written", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: false, wrote: "libredb_probe_v2", duration: 30 },
    });
    expect(text("-outcome")).toContain(
      "This text does not name `app.order_total(integer)`, so that object was not changed.",
    );
    expect(text("-outcome")).toContain(
      "A different object was created and LibreDB did not remove it: `libredb_probe_v2`.",
    );
    expect(query("-outcome-code")).toBeNull();
  });

  test("`applied-elsewhere` that was undone says the fork was taken back", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: true, duration: 30 },
    });
    expect(text("-outcome")).toContain("LibreDB took that back, so nothing was left behind");
  });

  test("`applied-elsewhere` with no name still says the object is there", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: false, duration: 30 },
    });
    expect(text("-outcome")).toContain("A different object was created and LibreDB did not remove it.");
  });

  test("`interrupted` never offers a retry, at any status", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: {
        outcome: "interrupted",
        committed: "unknown",
        sentence: "Query was cancelled",
        duration: 30_000,
      },
    });
    expect(text("-outcome")).toContain("The apply was sent and LibreDB never read an answer for it.");
    expect(query("-confirm")).toBeNull();
    cleanup();

    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: {
        outcome: "interrupted",
        committed: "rolled-back",
        sentence: "The transaction was rolled back",
        duration: 30_000,
      },
    });
    expect(text("-outcome")).toContain("rolled it back, so nothing was applied");
    expect(query("-confirm")).toBeNull();
  });

  test("an apply whose ANSWER could not be read is not described in the words of a timeout", () => {
    /*
     * X20's population. `ObjectSourceView` synthesises `{ outcome: "interrupted", committed:
     * "unknown" }` for an apply answer `isObjectEditOutcomeShape` refuses, because that arm's
     * `committed: "unknown"` half is exactly right and the outcome type carries no better arm. The
     * engine may have finished perfectly and the ANSWER is what could not be read, so a first line
     * saying the engine stopped the statement is a claim nobody measured for it.
     *
     * The synthesised sentence is reproduced here VERBATIM from `ObjectSourceView`'s
     * `UNREADABLE_OUTCOME`, so the assertion reads the two lines a real reader of this population
     * gets and not a shape invented for the test.
     */
    draw(
      refusal({
        outcome: "interrupted",
        committed: "unknown",
        sentence:
          "The apply was sent and its answer could not be read, so LibreDB cannot say whether this change landed. " +
          "Re-read this definition before trying again.",
        duration: 0,
      }),
    );
    expect(text("-outcome")).not.toContain("The engine stopped");
    expect(text("-outcome")).toContain("The apply was sent and LibreDB never read an answer for it.");
    expect(text("-outcome")).toContain("Re-read this definition before trying again.");
    cleanup();

    // The control, and the reason this is a SPLIT and not a rewrite of the arm: `rolled-back` is
    // claimable only by a provider that opened and closed the transaction itself, so there the
    // engine did stop the statement and the measured clause stays exactly as it was.
    draw(
      refusal({ outcome: "interrupted", committed: "rolled-back", sentence: "statement timeout", duration: 30_000 }),
    );
    expect(text("-outcome")).toContain(
      "The engine stopped this statement before it finished, and this apply rolled it back",
    );
  });

  test("the concurrent refusal is its own variant with Try again, and it REBUILDS", () => {
    // MEASURED: session A held a transaction over CREATE OR REPLACE FUNCTION for 3 seconds, session
    // B applied the same object 0.5 s later and blocked for 2.8 s before the refusal. The apply was
    // well formed and up to date, so a "this changed" screen would show two identical texts.
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: {
        outcome: "conflict",
        conflict: "engine-refused-concurrent",
        sentence: "tuple concurrently updated",
        code: "XX000",
        duration: 2_800,
      },
    });
    expect(text("-outcome")).toContain("Another session was changing this object at the same moment");
    expect(text("-outcome-code")).toBe("XX000");
    click("-confirm");
    expect(handlers.onRebuild).toHaveBeenCalled();
  });

  test("a SUCCESS that reached the failed state is still rendered rather than blank", () => {
    // Unreachable through the mount, which closes on success, and renderable because the prop type
    // cannot exclude it. A blank alert region would be the worse answer.
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: {
        outcome: "applied",
        revision: { check: "guarded", token: "md5:9f2", basis: "md5(prosrc)", scope: "server" },
        duration: 22,
      },
    });
    expect(text("-outcome")).toContain("The engine reported this apply as done.");
  });

  test("`applied-with-collateral` READS the lost facts instead of saying nothing needs fixing", () => {
    // The one arm whose outcome type carries a non-empty `lost` tuple precisely so the destruction
    // can be NAMED. Folding it into the plain `applied` sentence printed "Nothing here needs
    // fixing." over a function that had just been deleted.
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: {
        outcome: "applied-with-collateral",
        lost: [
          {
            loses: "replaces-whole-container",
            fact: { source: "FUNCTION LIST LIBRARYNAME orders", observed: "order_count is gone" },
          },
        ],
        revision: { check: "guarded", token: "md5:9f3", basis: "md5(prosrc)", scope: "server" },
        duration: 18,
      },
    });
    expect(text("-outcome")).toContain(
      "The engine applied this change and it destroyed something else, read back from the catalog after the apply.",
    );
    expect(text("-outcome")).toContain("FUNCTION LIST LIBRARYNAME orders answers: order_count is gone.");
    expect(text("-outcome")).not.toContain("Nothing here needs fixing.");
  });

  test("the `failed` state's TYPE excludes `object-changed`, which is the conflict SCREEN", () => {
    // A code comment saying "`object-changed` never reaches here" is not a guard. MEASURED before
    // this exclusion existed: a `failed` state carrying that outcome rendered "Another session was
    // changing this object at the same moment", threw `outcome.current` away and offered Close as
    // the only control, which is decision H3's whole reason for existing presented as a timing
    // collision. The mount that maps outcomes to states is Task 14's, so the refusal has to be one
    // the COMPILER makes: this directive is the test, and it fails typecheck (TS2578, unused
    // '@ts-expect-error') the moment the state type admits the arm again.
    const asFailed = (outcome: ObjectEditOutcome): ApplyPreviewState => ({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      // @ts-expect-error `object-changed` belongs to the `conflict` state, which has the text to diff.
      outcome,
    });
    const changed: ObjectEditOutcome = {
      outcome: "conflict",
      conflict: "object-changed",
      current: CURRENT,
      duration: 12,
    };
    expect(asFailed(changed).kind).toBe("failed");
  });

  test("conflict replaces the LEFT side with the server's text NOW and renames the right header", () => {
    draw({ kind: "conflict", plan: PLAN, current: CURRENT, userText: USER_TEXT });
    expect(text("-conflict")).toContain("This definition changed after you opened it. Nothing was applied.");
    expect(diffProps?.original).toBe(CURRENT.text);
    expect(diffProps?.modified).toBe(USER_TEXT);
    expect(headers()).toEqual(["On the server now", "Your edit"]);
    // Nothing on the right side was written by this product here, so nothing is shaded. The paint
    // count is what separates "painted an empty set" from "never painted at all": `painted` starts
    // as `[]` in `beforeEach`, so the assertion below passes either way on its own.
    expect(paintCalls).toBeGreaterThan(0);
    expect(decorations()).toEqual([]);
    expect(query("-identity")).toBeNull();
    expect(query("-session-pin")).toBeNull();
    click("-rebuild");
    expect(handlers.onRebuild).toHaveBeenCalled();
  });

  test("expired offers a rebuild and says nothing was applied", () => {
    draw({ kind: "expired" });
    expect(text("-expired")).toBe("This preview is no longer valid. Nothing was applied.");
    expect(query("-diff")).toBeNull();
    click("-rebuild");
    expect(handlers.onRebuild).toHaveBeenCalled();
  });

  test("the two models are namespaced away from the pane's own, and NEITHER keep flag is set", () => {
    // MEASURED: the browser probe disposed a diff editor and both models were still in
    // `monaco.editor.getModels()` afterwards, roughly 2 MB of retained text per opened preview on a
    // large object. The wrapper's defaults save us if we do not fight them, and the pane's model is
    // `libredb-source:${address}/${part.id}`, so a collision would hand the diff the pane's LIVE
    // model.
    draw(PREVIEW);
    expect(diffProps?.originalModelPath).toBe("libredb-apply-original:conn/app.f(integer)/function/definition");
    expect(diffProps?.modifiedModelPath).toBe("libredb-apply-modified:conn/app.f(integer)/function/definition");
    expect(diffProps?.keepCurrentOriginalModel).toBeFalsy();
    expect(diffProps?.keepCurrentModifiedModel).toBeFalsy();
  });

  test("the diff is not a keyboard trap, and is read-only on both sides", () => {
    // WCAG 2.1.2. `tabFocusMode` is on `IEditorOptions`, which `IDiffEditorConstructionOptions`
    // extends.
    draw(PREVIEW);
    expect(diffProps?.options).toMatchObject({
      tabFocusMode: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
    });
  });

  test("the diff registers this app's own themes rather than Monaco's stock pair", async () => {
    // `beforeMount` is per MOUNT, not per instance, so a mount that does not define them gets
    // Monaco's stock `vs`/`vs-dark` and sits visibly beside a query editor it does not match.
    draw(PREVIEW);
    expect(definedThemes).toEqual(["db-dark", "db-light"]);
    // happy-dom's document element carries no `dark` class, which is what `useEffectiveTheme`
    // reads, so the light theme is the one this environment is in.
    expect(diffProps?.theme).toBe("db-light");
    cleanup();

    // Inside `act`, because `useEffectiveTheme` subscribes to a MutationObserver on this class and
    // happy-dom delivers that callback asynchronously, so the re-render it causes lands outside the
    // render this test drove.
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    try {
      draw(PREVIEW);
      expect(diffProps?.theme).toBe("db-dark");
    } finally {
      await act(async () => {
        document.documentElement.classList.remove("dark");
      });
    }
  });

  test("the description names the object and the part, and focus opens on Cancel", () => {
    draw(PREVIEW);
    expect(document.querySelector("[data-slot='dialog-description']")?.textContent).toBe(
      "`app.order_total(integer)`, Definition. Nothing runs until you press Apply.",
    );
    // A destructive confirmation opens with the safe control focused, and it keeps focus out of the
    // diff.
    expect(document.activeElement).toBe(button("-cancel"));
  });

  test("the failure region is an alert and the applying line is a status", () => {
    draw(
      refusal({
        outcome: "refused",
        duration: 4,
        refusal: { refusal: "definition", sentence: "no", at: { within: "none" } },
      }),
    );
    expect(role("-outcome")).toBe("alert");
    cleanup();
    draw({ kind: "applying", plan: PLAN, preimage: PREIMAGE });
    expect(role("-applying")).toBe("status");
  });

  test("Cancel closes, and a closed dialog renders nothing", () => {
    draw(PREVIEW);
    click("-cancel");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <ApplyPreviewDialog
        open={false}
        state={PREVIEW}
        objectLabel="app.order_total(integer)"
        partLabel="Definition"
        address="conn/app.f(integer)/function"
        partId="definition"
        onApply={handlers.onApply}
        onRebuild={handlers.onRebuild}
        onGoToError={handlers.onGoToError}
        onClose={handlers.onClose}
      />,
    );
    expect(query("-dialog")).toBeNull();
  });

  /**
   * The FRAME, which is the title, the description and the two diff column headers (#789 Phase 3).
   *
   * X24 made the collateral report reachable, and the moment a reader could reach it the frame
   * around it started lying: a dialog reporting an apply that SUCCEEDED and destroyed a sibling
   * function still said `Apply this definition` and `Nothing runs until you press Apply.` and
   * still labelled the pre-image column `On the server now`, which on that path is the one text
   * the server no longer holds. INVENTORY, taken from `dialog.textContent` in every state this
   * component can reach before any of this changed: all twelve opened with the same
   * `Apply this definitionapp.order_total(integer), Definition. Nothing runs until you press
   * Apply.`, and all eleven that draw a diff carried `On the server nowWill be sent`. That
   * inventory was taken over a plan whose `consequences` was `[]`, so it could not see the row
   * that survived it, and the tests further down drive a plan that carries one.
   *
   * Asserted BY VALUE and per state, because the defect was never a missing element: every one of
   * these strings rendered, and every one of them was wrong about what had happened.
   */
  const frame = () => ({
    title: document.querySelector("[data-slot='dialog-title']")?.textContent,
    description: document.querySelector("[data-slot='dialog-description']")?.textContent,
  });
  const LABEL = "`app.order_total(integer)`, Definition. ";
  const UNCHANGED = "Nothing was applied and the definition on the server is unchanged.";

  test("the frame before anything runs says exactly that, in all three pre-apply states", () => {
    draw({ kind: "building" });
    expect(frame()).toEqual({
      title: "Apply this definition",
      description: `${LABEL}Nothing runs until you press Apply.`,
    });
    cleanup();
    draw(PREVIEW);
    expect(frame()).toEqual({
      title: "Apply this definition",
      description: `${LABEL}Nothing runs until you press Apply.`,
    });
    cleanup();
    draw({ kind: "applying", plan: PLAN, preimage: PREIMAGE });
    expect(frame()).toEqual({
      title: "Applying this definition",
      description: `${LABEL}This apply is running now.`,
    });
  });

  test("a preview that never ran says the object is untouched, in the frame and not only in the body", () => {
    draw({ kind: "expired" });
    // NOT `UNCHANGED`. The seal ran out after up to fifteen minutes and this client has asked the
    // server nothing since, so "the definition on the server is unchanged" is a claim about a
    // server this dialog has not spoken to: the `conflict` state exists precisely because another
    // session can replace the definition inside that window.
    expect(frame()).toEqual({
      title: "This preview expired",
      description: `${LABEL}Nothing was applied by this attempt.`,
    });
    cleanup();
    draw({ kind: "conflict", plan: PLAN, current: CURRENT, userText: USER_TEXT });
    expect(frame()).toEqual({
      title: "This definition changed while you had it open",
      description: `${LABEL}Nothing was applied. The left side below is what the server holds now.`,
    });
  });

  test("a REFUSED apply is framed as a refusal, and it says the object is unchanged", () => {
    draw(
      refusal({
        outcome: "refused",
        duration: 4,
        refusal: { refusal: "definition", sentence: "syntax error", at: { within: "none" } },
      }),
    );
    expect(frame()).toEqual({ title: "The engine refused this change", description: `${LABEL}${UNCHANGED}` });
    cleanup();
    draw(
      refusal({
        outcome: "conflict",
        conflict: "engine-refused-concurrent",
        sentence: "tuple concurrently updated",
        duration: 2_800,
      }),
    );
    expect(frame()).toEqual({ title: "The engine refused this change", description: `${LABEL}${UNCHANGED}` });
  });

  test("an INTERRUPTED apply is framed by its disposition, which is the one thing the two arms differ on", () => {
    // The whole point of the arm: `rolled-back` is a reader who may edit again, `unknown` is a
    // reader who must go and look. A frame that read the same for both would erase the difference
    // the outcome type was split to carry.
    draw(
      refusal({ outcome: "interrupted", committed: "rolled-back", sentence: "statement timeout", duration: 30_000 }),
    );
    expect(frame()).toEqual({
      title: "This apply was stopped before it finished",
      description: `${LABEL}${UNCHANGED}`,
    });
    cleanup();
    draw(
      refusal({ outcome: "interrupted", committed: "unknown", sentence: "connection terminated", duration: 30_000 }),
    );
    // The TITLE splits with the disposition and for the same reason X20 gives: on `unknown` the
    // statement may have run to completion and it is the ANSWER that is missing, so a title naming
    // a stopped statement is the loudest copy of the claim nobody measured.
    expect(frame()).toEqual({
      title: "This apply's outcome is unknown",
      description: `${LABEL}Whether it reached the server is unknown. Read the definition again before you edit it.`,
    });
  });

  test("the COLLATERAL frame says the apply succeeded and that something else went with it", () => {
    // This is the state X24 made reachable and the reason this whole item exists.
    draw(COLLATERAL_OUTCOME);
    expect(frame()).toEqual({
      title: "Applied, and it destroyed something else",
      description: `${LABEL}The new definition is on the server. What else went is named below.`,
    });
    // The attention level is unchanged and that is deliberate: a destroyed object deserves the
    // alert an engine refusal gets. The existing alert test drives a REFUSAL, which is a population
    // that does not contain this case, so the SUCCESS arm is asserted here.
    expect(role("-outcome")).toBe("alert");
    // And the frame is not the only thing on screen that changes: the left column is the one text
    // the server no longer holds.
    expect(headers()).toEqual(["On the server before this apply", "What was sent"]);
    expect(text("-identity")).toBe(
      "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you " +
        "typed, and the whole of the right side is what was sent, 1,234 characters.",
    );
  });

  test("a plain SUCCESS in this dialog is framed as done, not as a thing about to happen", () => {
    draw(
      refusal({
        outcome: "applied",
        revision: { check: "guarded", token: "md5:9f2", basis: "md5(prosrc)", scope: "server" },
        duration: 22,
      }),
    );
    expect(frame()).toEqual({
      title: "This apply is done",
      description: `${LABEL}The new definition is on the server.`,
    });
    expect(headers()).toEqual(["On the server before this apply", "What was sent"]);
  });

  test("`applied-elsewhere` frames the two dispositions apart, because one leaves an object behind", () => {
    draw(refusal({ outcome: "applied-elsewhere", undone: true, duration: 9 }));
    expect(frame()).toEqual({ title: "This apply changed nothing", description: `${LABEL}${UNCHANGED}` });
    // The addressed object is untouched on both arms, so the LEFT column is still current here.
    expect(headers()).toEqual(["On the server now", "What was sent"]);
    cleanup();
    draw(refusal({ outcome: "applied-elsewhere", undone: false, wrote: "app.other(integer)", duration: 9 }));
    expect(frame()).toEqual({
      title: "This apply wrote a different object",
      description: `${LABEL}This object is unchanged, and what the engine did write is named below.`,
    });
  });

  test("the LEFT column claims the server only where the server still holds that text", () => {
    // Three states, one rule. `refused` left the object alone, so `On the server now` is true;
    // `applied-with-collateral` replaced it, so it is false; `interrupted: unknown` cannot say, and
    // a header that claims the server there would be a guess printed as a fact.
    draw(
      refusal({
        outcome: "refused",
        duration: 4,
        refusal: { refusal: "definition", sentence: "syntax error", at: { within: "none" } },
      }),
    );
    expect(headers()).toEqual(["On the server now", "What was sent"]);
    cleanup();
    draw(
      refusal({ outcome: "interrupted", committed: "unknown", sentence: "connection terminated", duration: 30_000 }),
    );
    expect(headers()).toEqual(["On the server before this apply", "What was sent"]);
    cleanup();
    draw(
      refusal({ outcome: "interrupted", committed: "rolled-back", sentence: "statement timeout", duration: 30_000 }),
    );
    expect(headers()).toEqual(["On the server now", "What was sent"]);
  });

  test("the three lines BELOW the outcome move to the past tense too, or they re-frame the screen", () => {
    /*
     * The trap this item exists for, one level down: a conditional title over a body that still
     * reads as a plan. Read top to bottom on a completed apply, the pin line and the revision note
     * sit between the outcome and the diff, and in the future tense they tell a reader who has just
     * been told their function is gone that LibreDB "runs" this apply and "re-reads the definition
     * first". Both describe what already happened by the time this screen exists.
     */
    const compared: ObjectEditPlan = {
      ...PLAN,
      revision: { check: "compared", token: "md5:9f1", basis: "md5(prosrc)", scope: "server" },
    };
    draw({ kind: "preview", plan: compared, preimage: PREIMAGE });
    expect(text("-session-pin")).toBe(
      'LibreDB runs this apply with search_path set to "app", pg_catalog, for that one round trip only.',
    );
    expect(text("-revision-note")).toBe(
      "This apply re-reads the definition first and refuses if it differs from the left side.",
    );
    cleanup();
    draw({ ...COLLATERAL_OUTCOME, plan: compared } as ApplyPreviewState);
    expect(text("-session-pin")).toBe(
      'LibreDB ran this apply with search_path set to "app", pg_catalog, for that one round trip only.',
    );
    expect(text("-revision-note")).toBe(
      "This apply re-read the definition first, and it would have refused if it differed from the left side.",
    );
  });

  test("the UNAVAILABLE revision note carries the same tense, on the arm that admits it knew nothing", () => {
    const unavailable: ObjectEditPlan = {
      ...PLAN,
      revision: { check: "unavailable", reason: "This engine exposes no revision token" },
    };
    draw({ kind: "preview", plan: unavailable, preimage: PREIMAGE });
    expect(text("-revision-note")).toBe(
      "This engine exposes no revision token. This apply cannot tell whether somebody else changed this definition first.",
    );
    cleanup();
    draw({ ...COLLATERAL_OUTCOME, plan: unavailable } as ApplyPreviewState);
    expect(text("-revision-note")).toBe(
      "This engine exposes no revision token. This apply could not tell whether somebody else had changed this definition first.",
    );
  });

  test("the multi-step identity line moves to the past tense on a completed apply too", () => {
    // The arm that drops the byte-identity clause has its own sentence, so it has its own tense and
    // a fix that only touched the single-step arm would leave this one saying `will be sent`.
    const second: ObjectEditStep = {
      text: "SELECT 1;",
      language: "sql",
      segments: [{ from: "provider", text: "SELECT 1;" }],
    };
    const twoSteps: ObjectEditPlan = { ...PLAN, unit: { medium: "statement", steps: [PG_STEP, second] } };
    draw({
      kind: "failed",
      plan: twoSteps,
      preimage: PREIMAGE,
      outcome: {
        outcome: "applied",
        revision: { check: "guarded", token: "md5:9f2", basis: "md5(prosrc)", scope: "server" },
        duration: 22,
      },
    });
    expect(text("-identity")).toBe(
      "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you " +
        "typed. The diff shows statement 1 of 2, and 1,243 characters were sent in total.",
    );
  });
  /**
   * The whole screen on a completed apply, and the population that was missing from the inventory.
   *
   * The first inventory read `dialog.textContent` in twelve states over a plan whose
   * `consequences` was `[]`, so no state in it ever drew a consequence row, and the row is not a
   * corner case: `libraryCollateral` in `src/lib/db/providers/keyvalue/redis.ts` attaches
   * `replaces-whole-container` to every Redis function plan whose library registers at least one
   * function, and that same provider is the only day-one producer of `applied-with-collateral`.
   * So every screen the collateral frame exists for carries a consequence row, and each of the
   * eight sentences `describeConsequence` composes opens with `Applying this ...`.
   *
   * The plan below is LOADED on purpose: a consequence, a pinned setting and a `compared`
   * revision, so every optional row in the body renders and the read below covers them all.
   */
  const LOADED: ObjectEditPlan = {
    ...PLAN,
    consequences: [COLLATERAL],
    revision: { check: "compared", token: "md5:9f1", basis: "md5(prosrc)", scope: "server" },
  };
  /**
   * The same three rows on a COMMAND-medium plan, which is the shape the collateral frame actually
   * ships over and which the statement plan above cannot stand in for.
   *
   * `libraryCollateral` in `src/lib/db/providers/keyvalue/redis.ts` is the only day-one producer of
   * `applied-with-collateral`, and every Redis plan carries `medium: "command"`, so the completed
   * screen a reader meets first is this one. It draws one row no statement plan has,
   * `This apply sends a command, not a statement.`, and it draws no identity line at all.
   */
  const LOADED_COMMAND: ObjectEditPlan = {
    ...REDIS_PLAN,
    consequences: [COLLATERAL],
    revision: { check: "compared", token: "md5:9f1", basis: "md5(prosrc)", scope: "server" },
  };
  /** Every sentence the STATEMENT screen draws that is about something still to come. */
  const FUTURE = [
    "Nothing runs until you press Apply.",
    "Applying this replaces the whole container",
    "LibreDB runs this apply with search_path",
    "This apply re-reads the definition first",
    "I understand what this will replace.",
    "Will be sent",
    "what will be sent",
  ];
  /**
   * The same read for the COMMAND screen, and a DIFFERENT set rather than the list above reused.
   *
   * MEASURED off `dialog.textContent` on a `preview` holding `LOADED_COMMAND`: the identity line is
   * gated on `medium === "statement"` and the Redis plan pins no session setting, so two of the
   * seven above are never on that screen and asserting them as a control would assert nothing.
   */
  const FUTURE_COMMAND = [
    "Nothing runs until you press Apply.",
    "Applying this replaces the whole container",
    "This apply re-reads the definition first",
    "I understand what this will replace.",
    "Will be sent",
  ];
  /**
   * Future tense as a SHAPE, over the whole screen, and not as a list somebody wrote down.
   *
   * A sentence list can only catch a row that was already inventoried. The row this pattern set
   * exists for is `This apply sends a command, not a statement.`: it is in the PRESENT tense today,
   * so no future-tense list contains it, and an edit turning it into `will send` would pass every
   * list in this file while putting a prediction back onto a completed apply. These four patterns
   * are matched over `dialog.textContent`, so a NEW future-tense row fails them whether or not
   * anybody listed it. The controls beside each negative assert all four DO match on the matching
   * preview, in both media, which is what keeps the negatives from certifying an empty screen.
   */
  const FUTURE_SHAPE = [/\bwill\b/i, /\bApplying this\b/, /\bNothing runs\b/, /\bre-reads\b/];

  test("THE CONTROL: every future-tense sentence this screen can draw IS on the preview", () => {
    // Without this the assertion below passes over a screen that simply never drew the rows.
    draw({ kind: "preview", plan: LOADED, preimage: PREIMAGE });
    for (const sentence of FUTURE) expect(text("-dialog")).toContain(sentence);
    for (const shape of FUTURE_SHAPE) expect(text("-dialog")).toMatch(shape);
    expect(rows("-consequence")).toHaveLength(1);
  });

  test("a completed apply carries NO future-tense sentence anywhere on the screen", () => {
    draw({ ...COLLATERAL_OUTCOME, plan: LOADED } as ApplyPreviewState);
    for (const sentence of FUTURE) expect(text("-dialog")).not.toContain(sentence);
    for (const shape of FUTURE_SHAPE) expect(text("-dialog")).not.toMatch(shape);
  });

  test("THE CONTROL: the COMMAND screen draws its own future-tense rows on the preview", () => {
    draw({ kind: "preview", plan: LOADED_COMMAND, preimage: PREIMAGE });
    for (const sentence of FUTURE_COMMAND) expect(text("-dialog")).toContain(sentence);
    for (const shape of FUTURE_SHAPE) expect(text("-dialog")).toMatch(shape);
    expect(rows("-consequence")).toHaveLength(1);
    expect(query("-payload")).not.toBeNull();
  });

  test("a completed apply on the COMMAND medium is past tense too, down to the row only it draws", () => {
    /*
     * The gap the two reads above leave, and the medium that is the real day-one producer of this
     * state: the whole-screen read was taken over a statement plan, so nothing ever read the block
     * gated on `plan.unit.medium === "command"` on a state that carries an outcome. The payload
     * assertion is the non-vacuity check: without it this test would pass over a screen that never
     * drew the block at all, which is this epic's recurring shape.
     */
    draw({ ...COLLATERAL_OUTCOME, plan: LOADED_COMMAND } as ApplyPreviewState);
    expect(query("-payload")).not.toBeNull();
    expect(text("-dialog")).toContain("This apply sends a command, not a statement.");
    for (const sentence of FUTURE_COMMAND) expect(text("-dialog")).not.toContain(sentence);
    for (const shape of FUTURE_SHAPE) expect(text("-dialog")).not.toMatch(shape);
    expect(rows("-consequence")).toHaveLength(0);
  });

  test("a consequence is a PREDICTION, so it comes off the screen once the apply has run", () => {
    // It is not suppressed because it stopped mattering: it is suppressed because the sentence is
    // written in the future tense by `describeConsequence`, which this file does not own, and on
    // the collateral screen the outcome region above it already names what the catalog says went,
    // read back AFTER the apply. A prediction and a measurement of the same destruction, with the
    // prediction in the future tense, is the one contradiction this dialog must not print.
    draw({ ...COLLATERAL_OUTCOME, plan: LOADED } as ApplyPreviewState);
    expect(rows("-consequence")).toHaveLength(0);
    expect(text("-outcome")).toContain("FUNCTION LIST LIBRARYNAME orders answers: order_count is gone.");
    cleanup();
    // Every other outcome the `failed` state can carry, including the two where nothing was
    // applied: the dialog offers no Apply on any of them, so there is no apply left for a
    // prediction to be about.
    for (const outcome of [
      { outcome: "refused", duration: 4, refusal: { refusal: "definition", sentence: "x", at: { within: "none" } } },
      { outcome: "interrupted", committed: "unknown", sentence: "gone", duration: 30_000 },
      { outcome: "applied-elsewhere", undone: true, duration: 9 },
    ] as const) {
      draw(refusal(outcome as ApplyPreviewFailure, LOADED));
      expect(rows("-consequence")).toHaveLength(0);
      cleanup();
    }
  });

  test("the acknowledgement's rows are still drawn while the bytes are IN FLIGHT", () => {
    // The population that keeps the suppression above from becoming "hide it once Apply is
    // pressed": `applying` has sent nothing the reader can be told about in the past tense, and
    // the checkbox beside these rows stays on screen through it.
    draw({ kind: "applying", plan: LOADED, preimage: PREIMAGE });
    expect(rows("-consequence")).toHaveLength(1);
  });

  test("a refusal LibreDB made ITSELF does not tell the reader an engine spoke", () => {
    /*
     * MEASURED, `src/lib/db/providers/sql/postgres.ts`: a pooled client somebody else left inside a
     * transaction is refused with `refusal: "guard"` and the comment "No engine spoke, so there is
     * no SQLSTATE to carry". That is a day-one PostgreSQL path, filed as D78, and a title reading
     * "The engine refused this change" over it sends the reader to the database to look for an
     * error that is not there. `auditReadingFor` already separates a `guard` refusal from an
     * engine's for exactly this reason.
     */
    draw(
      refusal({
        outcome: "refused",
        duration: 4,
        refusal: {
          refusal: "guard",
          sentence: "this connection's pooled session is inside a transaction somebody else opened",
          at: { within: "none" },
        },
      }),
    );
    expect(frame()).toEqual({
      title: "LibreDB refused this change",
      description: `${LABEL}${UNCHANGED}`,
    });
    // The region under it still carries the refusing sentence, which is the provider's own here.
    expect(text("-outcome")).toContain("pooled session is inside a transaction");
    cleanup();
    // THE CONTROL, and the population this title is true over: every other refusal class at apply
    // time is a verdict an engine reached. `unsupported` stays with the engine deliberately: its
    // only day-one producer is Trino's coordinator answering NOT_SUPPORTED, errorCode 13.
    for (const klass of ["definition", "privilege", "identity", "unsupported"] as const) {
      draw(
        refusal({
          outcome: "refused",
          duration: 4,
          refusal: { refusal: klass, sentence: "the engine's own sentence", at: { within: "none" } },
        }),
      );
      expect(frame().title).toBe("The engine refused this change");
      cleanup();
    }
  });

  test("the state whose bytes are IN FLIGHT is in the present tense, top to bottom", () => {
    /*
     * The two mutations that SURVIVED the first round both lived here: `applying` is the one state
     * whose body nothing asserted, so `preimageIsCurrent` could be flipped false and `sent` could
     * be made true on it with every test green. The report's decision that `applying` is not in the
     * past tense was defended in prose and by nothing executable.
     */
    draw({ kind: "applying", plan: LOADED, preimage: PREIMAGE });
    expect(frame()).toEqual({
      title: "Applying this definition",
      description: `${LABEL}This apply is running now.`,
    });
    expect(headers()).toEqual(["On the server now", "Will be sent"]);
    expect(text("-session-pin")).toBe(
      'LibreDB runs this apply with search_path set to "app", pg_catalog, for that one round trip only.',
    );
    expect(text("-revision-note")).toBe(
      "This apply re-reads the definition first and refuses if it differs from the left side.",
    );
    expect(text("-identity")).toBe(
      "The shaded regions are added by LibreDB to make this apply safe. Everything else is exactly what you " +
        "typed, and the whole of the right side is what will be sent, 1,234 characters.",
    );
  });
});
