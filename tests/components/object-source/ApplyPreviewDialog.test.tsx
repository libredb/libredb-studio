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

import { ApplyPreviewDialog, type ApplyPreviewState } from "@/components/object-source/ApplyPreviewDialog";
import { providerRanges } from "@/lib/db/object-edit";
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
/** Offsets, decoded from the fake model's line-1 mapping, which is what `providerRanges` speaks. */
const decorations = () => painted.map((one) => ({ start: one.range.startColumn - 1, end: one.range.endColumn - 1 }));

const PREVIEW: ApplyPreviewState = { kind: "preview", plan: PLAN, preimage: PREIMAGE };

function refusal(outcome: ObjectEditOutcome, plan: ObjectEditPlan = PLAN): ApplyPreviewState {
  return { kind: "failed", plan, preimage: PREIMAGE, outcome };
}

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
    expect(text("-identity")).toContain("1,243 characters.");
    expect(text("-identity")).toContain("This plan sends 2 statements and the diff shows the first of them.");
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
    expect(text("-failure")).toContain("cannot change return type of existing function");
    expect(text("-failure-code")).toBe("42P13");
    // The engine's own hint, kept because the shipped mapper destroys it.
    expect(text("-failure")).toContain("Use DROP FUNCTION app.f_demo(integer) first.");
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
    expect(text("-failure")).toContain("must be owner of function order_total");
    expect(text("-failure")).toContain(
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
    expect(text("-failure")).toContain(
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
    expect(text("-failure")).toContain('search_path set to "app", pg_catalog');
    expect(text("-failure")).toContain("Qualify the name");
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
    expect(text("-failure")).not.toContain("search_path set to");
  });

  test("`applied-elsewhere` says the addressed object was NOT changed, and names what was written", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: false, wrote: "libredb_probe_v2", duration: 30 },
    });
    expect(text("-failure")).toContain(
      "This text does not name `app.order_total(integer)`, so that object was not changed.",
    );
    expect(text("-failure")).toContain(
      "A different object was created and LibreDB did not remove it: `libredb_probe_v2`.",
    );
    expect(query("-failure-code")).toBeNull();
  });

  test("`applied-elsewhere` that was undone says the fork was taken back", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: true, duration: 30 },
    });
    expect(text("-failure")).toContain("LibreDB took that back, so nothing was left behind");
  });

  test("`applied-elsewhere` with no name still says the object is there", () => {
    draw({
      kind: "failed",
      plan: PLAN,
      preimage: PREIMAGE,
      outcome: { outcome: "applied-elsewhere", undone: false, duration: 30 },
    });
    expect(text("-failure")).toContain("A different object was created and LibreDB did not remove it.");
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
    expect(text("-failure")).toContain(
      "The engine stopped this statement before it finished. Whether it was applied is unknown.",
    );
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
    expect(text("-failure")).toContain("rolled it back, so nothing was applied");
    expect(query("-confirm")).toBeNull();
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
    expect(text("-failure")).toContain("Another session was changing this object at the same moment");
    expect(text("-failure-code")).toBe("XX000");
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
    expect(text("-failure")).toContain("The engine reported this apply as done.");
  });

  test("conflict replaces the LEFT side with the server's text NOW and renames the right header", () => {
    draw({ kind: "conflict", plan: PLAN, current: CURRENT, userText: USER_TEXT });
    expect(text("-conflict")).toContain("This definition changed after you opened it. Nothing was applied.");
    expect(diffProps?.original).toBe(CURRENT.text);
    expect(diffProps?.modified).toBe(USER_TEXT);
    expect(headers()).toEqual(["On the server now", "Your edit"]);
    // Nothing on the right side was written by this product here, so nothing is shaded.
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
    expect(role("-failure")).toBe("alert");
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
});
