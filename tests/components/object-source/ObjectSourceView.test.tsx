import "../../setup-dom";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

/**
 * The read-only object source viewer (#789).
 *
 * `@monaco-editor/react` is replaced with a `<textarea>` carrying the value, the language, the
 * model path and the `readOnly` option, because happy-dom cannot run Monaco and because what
 * this suite asserts is the COMPOSITION around the editor, never Monaco itself. The mock also
 * invokes `beforeMount` with a Monaco double, so the one thing this file does assert about
 * Monaco is the thing Task 3 exists for: that this mount registers the same two themes the
 * query editor does instead of falling back to the stock `vs-dark`.
 *
 * THE RULE THIS WHOLE PHASE EXISTS FOR is pinned here twice over: an unreadable source never
 * opens an empty editor, because an empty editor reads as "there is no source" and a user who
 * types over it deletes the object. Every refusal assertion below therefore pairs the sentence
 * it DOES draw with `queryByRole("textbox")` being null.
 */

let definedThemes: string[] = [];

/**
 * What the ONE mounted editor double recorded (#789 Phase 3).
 *
 * `values` is the `value` PROP's history and not the DOM's, and that distinction is the whole
 * point of recording it. MEASURED by reading the installed wrapper, `@monaco-editor/react`
 * 4.7.0: once the editor is not `readOnly`, its `value` effect runs on `[value]` and replaces
 * the FULL MODEL RANGE with `executeEdits` plus an undo stop. So a `value` that followed the
 * reader's buffer would clobber their text every time the debounced draft landed, and the
 * assertion that catches that is "the prop was handed exactly one value", never a read of the
 * textarea, which the double keeps in step with the prop by construction.
 */
interface EditorProbe {
  values: string[];
  options: Record<string, unknown>;
  path: string;
  change?: (value: string | undefined) => void;
  markers: {
    model: unknown;
    owner: string;
    markers: { startLineNumber?: number; startColumn?: number; severity?: number; message?: string }[];
  }[];
  revealed: { lineNumber: number; column: number }[];
  mounted: boolean;
}

let probe: EditorProbe = { values: [], options: {}, path: "", markers: [], revealed: [], mounted: false };

function resetProbe(): void {
  probe = { values: [], options: {}, path: "", markers: [], revealed: [], mounted: false };
}

/** The marker severities Monaco publishes. `Error` is 8 and the pane reads it off the namespace. */
const MARKER_SEVERITY = { Hint: 1, Info: 2, Warning: 4, Error: 8 };

mock.module("@monaco-editor/react", () => ({
  default: function MockEditor(props: {
    value?: string;
    language?: string;
    path?: string;
    theme?: string;
    options?: Record<string, unknown>;
    beforeMount?: (monaco: unknown) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
    onChange?: (value: string | undefined) => void;
  }) {
    const ran = React.useRef(false);
    probe.options = props.options ?? {};
    probe.path = props.path ?? "";
    probe.change = props.onChange;
    if (probe.values[probe.values.length - 1] !== (props.value ?? "")) probe.values.push(props.value ?? "");
    React.useEffect(() => {
      if (ran.current) return;
      ran.current = true;
      props.beforeMount?.({
        editor: {
          defineTheme: (id: string) => {
            definedThemes.push(id);
          },
        },
      });
      probe.mounted = true;
      props.onMount?.(
        {
          // The LIVE model and not the one this mount was created with: the wrapper keeps one
          // editor and swaps models when `path` changes, so a handler that captured the model at
          // mount would hold the previous part's after a switch.
          getModel: () => ({ uri: { toString: () => `parsed:${probe.path}` } }),
          setPosition: (position: { lineNumber: number; column: number }) => {
            probe.revealed.push(position);
          },
          revealPositionInCenter: () => {},
          focus: () => {},
        },
        {
          editor: {
            setModelMarkers: (model: unknown, owner: string, markers: EditorProbe["markers"][number]["markers"]) => {
              probe.markers.push({ model, owner, markers });
            },
          },
          Uri: { parse: (value: string) => ({ toString: () => `parsed:${value}` }) },
          MarkerSeverity: MARKER_SEVERITY,
        },
      );
    });
    return (
      <textarea
        data-testid="source-editor"
        data-language={props.language}
        data-path={props.path}
        data-theme={props.theme}
        data-dom-readonly={String(props.options?.domReadOnly === true)}
        readOnly={props.options?.readOnly === true}
        value={props.value ?? ""}
        onChange={() => {}}
      />
    );
  },
  /*
   * `ApplyPreviewDialog` mounts a `DiffEditor` and this suite mounts that dialog, so the module
   * double owes both exports. Without it the dialog throws on render and every apply test fails
   * on a message about an undefined component rather than on what it asserts.
   */
  DiffEditor: function MockDiffEditor(props: { original?: string; modified?: string }) {
    return <div data-testid="diff-editor" data-original={props.original ?? ""} data-modified={props.modified ?? ""} />;
  },
}));

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Imported from the BARREL and not by path, deliberately: `index.ts` had no runtime importer
// anywhere in the tree, so its re-export lines produced no `DA:` record at all and the 100
// percent gate could not see them. A type-only import is erased and does not count (#789).
import {
  isSourceDocumentShape,
  ObjectEditRequestError,
  ObjectSourceView,
  type ObjectSourceApplier,
  type ObjectSourcePatch,
  type ObjectSourceReader,
} from "@/components/object-source";
import { DRAFT_KEY, draftKeyFor, readDraft } from "@/components/object-source/source-drafts";
import { NOT_OFFERED_SENTENCE } from "@/components/object-source/source-editable";
import { SOURCE_CHARACTER_LIMIT, SOURCE_PART_LIMIT } from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type {
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditStep,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import { STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";
import type { DatabaseConnection } from "@/lib/types";

const connection: DatabaseConnection = {
  id: "ora-1",
  name: "conn",
  type: "oracle",
  createdAt: new Date("2026-01-01"),
};

const PATH = ["APP", "APP_ORDERS_PKG"] as const;

const oneReadablePart: ObjectSourceDocument = {
  path: [...PATH],
  kind: "package",
  parts: [
    {
      id: "spec",
      label: "Package specification",
      text: "CREATE OR REPLACE PACKAGE APP.APP_ORDERS_PKG AS\n  FUNCTION total RETURN NUMBER;\nEND;",
      language: "sql",
      form: "complete",
      origin: "regenerated",
    },
  ],
};

const twoParts: ObjectSourceDocument = {
  path: [...PATH],
  kind: "package",
  parts: [
    oneReadablePart.parts[0],
    {
      id: "body",
      label: "Package body",
      text: "CREATE OR REPLACE PACKAGE BODY APP.APP_ORDERS_PKG AS\nEND;",
      language: "sql",
      form: "complete",
      origin: "stored",
    },
  ],
};

const refusedSecondPart: ObjectSourceDocument = {
  path: [...PATH],
  kind: "package",
  parts: [
    oneReadablePart.parts[0],
    {
      id: "body",
      label: "Package body",
      unavailable: "The text for object 'customer_summary' is encrypted.",
    },
  ],
};

function editorValue(): string {
  return (screen.getByTestId("source-editor") as HTMLTextAreaElement).value;
}

/**
 * The shell, as Tasks 19 and 20 will build it: it owns the tab state and merges every patch by
 * SPREAD, which is what makes `{ document: undefined }` a clear rather than a no-op.
 */
function Harness(props: {
  readonly reader: ObjectSourceReader;
  readonly refreshToken?: number;
  readonly onPatch?: (patch: ObjectSourcePatch) => void;
}) {
  const [state, setState] = React.useState<ObjectSourcePatch>({});
  const record = props.onPatch;
  const onChange = React.useCallback(
    (patch: ObjectSourcePatch) => {
      record?.(patch);
      setState((previous) => ({ ...previous, ...patch }));
    },
    [record],
  );
  return (
    <ObjectSourceView
      connection={connection}
      path={[...PATH]}
      kind="package"
      kindLabel="Package"
      displayName="APP_ORDERS_PKG"
      document={state.document}
      failure={state.failure}
      activePartId={state.activePartId}
      refreshToken={props.refreshToken ?? 0}
      readAtToken={state.readAtToken}
      reader={props.reader}
      onChange={onChange}
    />
  );
}

function readerFor(answer: unknown): ObjectSourceReader & { calls: number } {
  const reader = Object.assign(
    async () => {
      reader.calls += 1;
      return answer;
    },
    { calls: 0 },
  );
  return reader;
}

beforeEach(() => {
  definedThemes = [];
  resetProbe();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
});

describe("ObjectSourceView", () => {
  test("reads once on mount and hands the document back through onChange", async () => {
    const reader = readerFor(oneReadablePart);
    const patches: ObjectSourcePatch[] = [];
    const record = (patch: ObjectSourcePatch) => {
      patches.push(patch);
    };
    const { rerender } = render(<Harness reader={reader} onPatch={record} />);

    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    // Re-render twice more: the prop `path` is a fresh array on every render, so an effect
    // keyed on it would re-issue for ever. The guard is what this asserts.
    rerender(<Harness reader={reader} onPatch={record} />);
    rerender(<Harness reader={reader} onPatch={record} />);
    await waitFor(() => expect(reader.calls).toBe(1));

    expect(patches).toHaveLength(1);
    expect(patches[0]?.document).toEqual(oneReadablePart);
    expect(patches[0]?.readAtToken).toBe(0);
  });

  test("draws the object's display name and its kind's declared label", async () => {
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.getByTestId("object-source-name").textContent).toBe("APP_ORDERS_PKG");
    expect(screen.getByTestId("object-source-kind").textContent).toBe("Package");
  });

  test("draws the caption for the active part", async () => {
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.getByTestId("object-source-caption").textContent).toBe(
      "Rebuilt by the engine from its catalog. Complete as shown.",
    );
  });

  test("draws a loading state before the read lands, and it is not an editor", async () => {
    let release: (value: unknown) => void = () => {};
    const pending: ObjectSourceReader = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    render(<Harness reader={pending} />);

    expect(screen.getByTestId("object-source-loading")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();

    await act(async () => {
      release(oneReadablePart);
    });
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
  });

  test("selects the first part when the document lands, so a switcher always has a selection", async () => {
    /*
     * The SELECTION is what this asserts, never the patch field. The landing patch used to carry
     * `activePartId: parts[0].id` and this test asserted it; that write also destroyed a
     * remembered selection on a re-read, which Task 23 measured in a browser, so the write is
     * gone and `activePart`'s fallback is what makes the selection total (#789). Asserting the
     * patch would have pinned the mechanism and defended the defect; asserting the rendering
     * pins the property the test's own name states.
     */
    const patches: ObjectSourcePatch[] = [];
    render(
      <Harness
        reader={readerFor(twoParts)}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    /*
     * THE FLOOR FIRST, because `.every` over an empty array is `true` and would certify nothing
     * (#789, Task 23 fix round 1). The floor is not redundant with the `waitFor` above: the
     * editor renders from the harness's own state, so a future component that seeded the
     * document without ever calling `onChange` would satisfy the wait and leave `patches`
     * empty. Measured: with the floor removed and the harness seeded with `twoParts` and no
     * reader, the `.every` line passed over zero patches.
     */
    expect(patches.length).toBeGreaterThan(0);
    // Nothing named the part, and the first one is still the one on screen.
    expect(patches.every((patch) => !Object.hasOwn(patch, "activePartId"))).toBe(true);
    expect(screen.getByTestId("source-editor").getAttribute("data-path")?.endsWith("/spec")).toBe(true);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  test("falls back to the first part when the remembered selection names no part of this document", () => {
    render(
      <ObjectSourceView
        connection={connection}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        document={twoParts}
        activePartId="a-part-that-was-renamed"
        refreshToken={0}
        readAtToken={0}
        reader={readerFor(twoParts)}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId("source-editor").getAttribute("data-path")?.endsWith("/spec")).toBe(true);
    expect(editorValue()).toContain("FUNCTION total");
  });

  test("draws no switcher for a one-part document", async () => {
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  /**
   * Every `aria-controls` a tab carries RESOLVES, and the panel it names points back at it.
   *
   * The first spelling of this test walked both tabs and resolved the IDREF only inside
   * `if (aria-selected === "true")`, so the non-selected tab's wiring was certified by the
   * attribute being truthy and containing no space. Mutation G, `panelId(index)` to
   * `panelId(activeIndex)`, survived it: 24 pass 0 fail. Only the ACTIVE panel is in the tree,
   * so a tab naming any other panel is an axe `aria-valid-attr-value` violation that ships.
   */
  function assertTabWiring(): number {
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(1);
    let carried = 0;
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls");
      if (controls === null) {
        // A tab whose panel is NOT rendered carries no reference at all, which is the other
        // half of the same invariant: an absent IDREF is honest, a dangling one is not.
        expect(tab.getAttribute("aria-selected")).toBe("false");
        continue;
      }
      expect(tab.getAttribute("aria-selected")).toBe("true");
      // An IDREF may not carry a space: a part label or a provider-local id containing one
      // would split the reference in two and both halves would resolve to nothing.
      expect(controls.includes(" ")).toBe(false);
      const panel = window.document.getElementById(controls);
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.getAttribute("id"));
      carried += 1;
    }
    return carried;
  }

  test("draws a tablist with one tab per part for a two-part document, wired with aria-controls", async () => {
    render(<Harness reader={readerFor(twoParts)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Package specification", "Package body"]);
    // Exactly one panel is in the tree, so exactly one tab may name one.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(assertTabWiring()).toBe(1);

    // And the wiring FOLLOWS the selection rather than being correct only at index 0.
    await userEvent.click(screen.getAllByRole("tab")[1]!);
    await waitFor(() => expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(assertTabWiring()).toBe(1);
  });

  /**
   * The KEYBOARD half of the WAI-ARIA tabs pattern, which the first round omitted entirely.
   *
   * Both tab buttons sat at the implicit tabindex 0, so a keyboard user tabbing through a
   * two-part Oracle package landed on every part button in turn instead of entering the
   * tablist once and arrowing, and no arrow key did anything. `jsx-a11y` has NO rule for
   * roving tabindex or for arrow-key navigation, measured: `bun run lint` reported 0 errors
   * over the version that had neither, so the lint gate says nothing about this.
   * `StudioTabBar.tsx` is the repository's own spelling and this mirrors it.
   */
  test("gives the tablist one tab stop and moves the selection with the arrow keys", async () => {
    render(<Harness reader={readerFor(twoParts)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1"]);

    tabs[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");

    await waitFor(() => expect(editorValue()).toContain("PACKAGE BODY"));
    const moved = screen.getAllByRole("tab");
    expect(moved.map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0"]);
    // Focus FOLLOWS activation, or the next arrow key would go to the tab that lost it.
    expect(window.document.activeElement).toBe(moved[1]!);
  });

  test("wraps the arrow keys around the tablist and jumps with Home and End", async () => {
    render(<Harness reader={readerFor(twoParts)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    screen.getAllByRole("tab")[0]!.focus();
    // ArrowLeft from the first part wraps to the last rather than doing nothing.
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(editorValue()).toContain("PACKAGE BODY"));

    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(editorValue()).toContain("FUNCTION total"));

    await userEvent.keyboard("{End}");
    await waitFor(() => expect(editorValue()).toContain("PACKAGE BODY"));

    // A key the pattern does not claim is left to the browser: no selection change, no throw.
    await userEvent.keyboard("{ArrowDown}");
    expect(editorValue()).toContain("PACKAGE BODY");
  });

  test("moves focus with the arrow keys when a part id holds a quote and a bracket", async () => {
    /*
     * A part id is an ENGINE's word, so it can carry any character an identifier can, and the
     * first spelling of the focus move built a CSS selector out of it:
     * `[role="tab"][data-part-id="${target.id}"]`. A quote closes the attribute value early and
     * `querySelector` raises `SyntaxError: ... is not a valid selector`, which happens inside a
     * React event handler and takes the arrow key with it, while the CLICK path, which carries
     * the id as a value rather than as syntax, keeps working. Standing ruling 2 records
     * `"char"(integer)` as a MEASURED PostgreSQL routine identity, so this is not an invented
     * shape. Matched through `dataset` the way `ObjectTree.tsx` already does, because there is
     * no `CSS.escape` in every runtime this renders in.
     */
    const quoted: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [
        { ...oneReadablePart.parts[0], id: '"char"(integer)' },
        { ...twoParts.parts[1], id: "body[1]" },
      ],
    };
    render(<Harness reader={readerFor(quoted)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    await userEvent.keyboard("{ArrowRight}");

    await waitFor(() => expect(editorValue()).toContain("PACKAGE BODY"));
    // Focus FOLLOWS activation here too, and this is the half the selector broke.
    expect(window.document.activeElement).toBe(screen.getAllByRole("tab")[1]!);

    // And back, so the id carrying a BRACKET is exercised as the move's target as well.
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(editorValue()).toContain("FUNCTION total"));
    expect(window.document.activeElement).toBe(screen.getAllByRole("tab")[0]!);
  });

  test("switching to the second part shows its text and asks for no second read", async () => {
    const reader = readerFor(twoParts);
    render(<Harness reader={reader} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    await userEvent.click(screen.getAllByRole("tab")[1]!);

    await waitFor(() => expect(editorValue()).toContain("PACKAGE BODY"));
    expect(reader.calls).toBe(1);
  });

  test("a refused part draws the engine's sentence and NO editor", async () => {
    // The hazard is closed twice: the TYPE gives a refusal no text key, and the COMPONENT renders
    // a different element, so there is no editor on screen to type into.
    render(<Harness reader={readerFor(refusedSecondPart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    await userEvent.click(screen.getAllByRole("tab")[1]!);

    await waitFor(() => expect(screen.getByTestId("object-source-refused")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("This definition could not be read.")).toBeTruthy();
    expect(screen.getByText("The text for object 'customer_summary' is encrypted.")).toBeTruthy();
    expect(screen.getByTestId("object-source-refused-message").className).toContain("text-warning");
    // A refusal carries no caption either: there is no form and no origin to describe.
    expect(screen.queryByTestId("object-source-caption")).toBeNull();
  });

  test("a failed read draws the route's own sentence in the failure grammar and NO editor", async () => {
    const failing: ObjectSourceReader = async () => {
      throw new Error("Object APP.APP_ORDERS_PKG was not found.");
    };
    render(<Harness reader={failing} />);

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("The source read failed.")).toBeTruthy();
    expect(screen.getByText("Object APP.APP_ORDERS_PKG was not found.")).toBeTruthy();
    expect(screen.getByTestId("object-source-failure-message").className).toContain("text-destructive");
  });

  test("reports a thrown value that is not an Error, rather than rendering nothing", async () => {
    const failing: ObjectSourceReader = async () => {
      throw "the host rejected with a string";
    };
    render(<Harness reader={failing} />);

    await waitFor(() => expect(screen.getByText("the host rejected with a string")).toBeTruthy());
  });

  test("a truncated part draws the banner ABOVE the editor and still shows the text", async () => {
    const bounded: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [
        {
          ...oneReadablePart.parts[0],
          truncated: {
            limit: 1_000_000,
            reason: "the source read was bounded at 1,000,000 characters by its caller",
          },
        },
      ],
    };
    render(<Harness reader={readerFor(bounded)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-truncated")).toBeTruthy());
    const banner = screen.getByTestId("object-source-truncated");
    const editor = screen.getByTestId("source-editor");
    expect(banner.textContent).toContain("the source read was bounded at 1,000,000 characters by its caller");
    // ABOVE, asserted by document order rather than by a rect: happy-dom returns zeros for
    // layout, so a coordinate comparison here would pass whatever the order.
    expect(banner.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
    expect(editorValue()).toContain("APP_ORDERS_PKG");
    /*
     * X17 on the screen it was measured on (#789 Phase 3, adjudication 2c). The caption is four
     * lines above this banner and it used to read "Complete as shown." for a text the banner in
     * the same viewport says was cut. This is the composition assertion; the caption's own six
     * truncated compositions are pinned without a DOM in
     * `tests/unit/components/object-source-caption.test.ts`.
     */
    expect(screen.getByTestId("object-source-caption").textContent).toBe(
      "Rebuilt by the engine from its catalog. Shortened when it was read, so this is not the whole definition.",
    );
  });

  test("the editor is mounted read-only", async () => {
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).readOnly).toBe(true);
  });

  test("the editor carries the part's own language and a model path nothing else can collide with", async () => {
    render(<Harness reader={readerFor(twoParts)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    const editor = screen.getByTestId("source-editor");
    expect(editor.getAttribute("data-language")).toBe("sql");
    expect(editor.getAttribute("data-path")).toBe(`libredb-source:ora-1/${pathKey([...PATH])}/package/spec`);
  });

  test("registers the studio themes on its own mount and applies the effective one", async () => {
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(definedThemes).toContain(STUDIO_THEME_DARK);
    expect(definedThemes).toContain(STUDIO_THEME_LIGHT);
    expect(screen.getByTestId("source-editor").getAttribute("data-theme")).toBe(STUDIO_THEME_LIGHT);
  });

  test("applies the dark studio theme when the document is in dark mode", async () => {
    document.documentElement.classList.add("dark");
    render(<Harness reader={readerFor(oneReadablePart)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.getByTestId("source-editor").getAttribute("data-theme")).toBe(STUDIO_THEME_DARK);
  });

  test("a host answering a body this viewer cannot render is reported as a failure, not rendered", async () => {
    // The live home of the non-empty invariant: the reader resolves a shape check failure.
    const bothKeys = {
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], unavailable: "wrapped" }],
    };
    render(<Harness reader={readerFor(bothKeys)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
  });

  test("marks itself stale when the session's catalog-change counter has moved since the read", async () => {
    // Phase 1 threaded `objectRefreshToken` for the tree; a Source tab holding a body from before
    // a CREATE OR REPLACE is exactly the text Phase 3's restore-before-apply would be built on.
    const reader = readerFor(oneReadablePart);
    const { rerender } = render(<Harness reader={reader} refreshToken={0} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(screen.queryByTestId("object-source-stale")).toBeNull();

    rerender(<Harness reader={reader} refreshToken={1} />);

    expect(screen.getByTestId("object-source-stale")).toBeTruthy();
    // The text is still on screen: marking is not hiding, and the definition read before the
    // DDL is still the only one we have.
    expect(screen.getByTestId("source-editor")).toBeTruthy();
  });

  test("does not mark itself stale before any read has landed", () => {
    const pending: ObjectSourceReader = () => new Promise(() => {});
    render(<Harness reader={pending} refreshToken={4} />);

    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });

  test("re-reads when the stale banner's control is used", async () => {
    const reader = readerFor(oneReadablePart);
    const patches: ObjectSourcePatch[] = [];
    const record = (patch: ObjectSourcePatch) => {
      patches.push(patch);
    };
    const { rerender } = render(<Harness reader={reader} refreshToken={0} onPatch={record} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    rerender(<Harness reader={reader} refreshToken={1} onPatch={record} />);

    await userEvent.click(screen.getByTestId("object-source-stale-reread"));

    await waitFor(() => expect(reader.calls).toBe(2));
    // The clear patch names all three fields explicitly, because the shell merges by spread and
    // an omitted key would leave the stale document in place.
    const clear = patches.find((patch) => Object.hasOwn(patch, "document") && patch.document === undefined);
    expect(clear).toBeTruthy();
    expect(Object.hasOwn(clear!, "failure")).toBe(true);
    expect(Object.hasOwn(clear!, "readAtToken")).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("object-source-stale")).toBeNull());
  });

  test("keeps the part the reader was on across a re-read, so the stale control does not move them", async () => {
    /*
     * Found in the browser on Oracle XE 21.3.0.0.0 (#789, Task 23), driving the ACTION rather
     * than the render: reading APP.APP_ORDERS_PKG's BODY, running a CREATE OR REPLACE in a query
     * tab to mark the tab stale, then pressing "Read again" put the reader back on the
     * SPECIFICATION with nothing on screen saying so. The landing patch wrote
     * `activePartId: answer.parts[0].id` unconditionally, which threw away a selection the tab
     * still held and which `activePart`'s own fallback already made safe.
     *
     * The mutation that proves this test binds: restore that write in `ObjectSourceView.tsx` and
     * this test fails on the second part being deselected.
     */
    const reader = readerFor(twoParts);
    const { rerender } = render(<Harness reader={reader} refreshToken={0} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    await userEvent.click(screen.getByRole("tab", { name: "Package body" }));
    expect(screen.getByTestId("source-editor").getAttribute("data-path")?.endsWith("/body")).toBe(true);

    rerender(<Harness reader={reader} refreshToken={1} />);
    await userEvent.click(screen.getByTestId("object-source-stale-reread"));
    await waitFor(() => expect(reader.calls).toBe(2));
    await waitFor(() => expect(screen.queryByTestId("object-source-stale")).toBeNull());

    expect(screen.getByTestId("source-editor").getAttribute("data-path")?.endsWith("/body")).toBe(true);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  test("re-reads after a failed read when the stale control is used, so a failure is not a dead end", async () => {
    let attempt = 0;
    const reader = Object.assign(
      async () => {
        reader.calls += 1;
        attempt += 1;
        if (attempt === 1) throw new Error("Connection reset.");
        return oneReadablePart;
      },
      { calls: 0 },
    );
    const { rerender } = render(<Harness reader={reader} refreshToken={0} />);
    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());

    rerender(<Harness reader={reader} refreshToken={1} />);
    await userEvent.click(screen.getByTestId("object-source-stale-reread"));

    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(reader.calls).toBe(2);
  });

  test("re-reads when the address changes", async () => {
    // Each answer names the object it is FOR, which is what every provider in the fleet writes
    // (`path: [...path]`, 55 sites) and what the viewer now checks before rendering one.
    const answers: Record<string, ObjectSourceDocument> = {
      one: { ...oneReadablePart, path: ["APP", "one"] },
      two: { ...twoParts, path: ["APP", "two"] },
    };
    const asked: string[] = [];
    const reader: ObjectSourceReader = async (_connection, path) => {
      const name = path[path.length - 1] ?? "";
      asked.push(name);
      return answers[name] ?? oneReadablePart;
    };
    function Two({ name }: { readonly name: string }) {
      const [state, setState] = React.useState<ObjectSourcePatch>({});
      const onChange = React.useCallback((patch: ObjectSourcePatch) => {
        setState((previous) => ({ ...previous, ...patch }));
      }, []);
      // A shell that reuses one tab for a different object clears its state; this mirrors that,
      // with React's own adjust-state-during-render pattern rather than an effect.
      const [shown, setShown] = React.useState(name);
      if (shown !== name) {
        setShown(name);
        setState({});
      }
      return (
        <ObjectSourceView
          connection={connection}
          path={["APP", name]}
          kind="package"
          kindLabel="Package"
          displayName={name}
          document={state.document}
          failure={state.failure}
          activePartId={state.activePartId}
          refreshToken={0}
          readAtToken={state.readAtToken}
          reader={reader}
          onChange={onChange}
        />
      );
    }
    const { rerender } = render(<Two name="one" />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    rerender(<Two name="two" />);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(asked).toEqual(["one", "two"]);
  });

  /**
   * THE PROP PATH IS AN ENTRY TOO, and round 1 left the invariant enforced on only one of them.
   *
   * `isSourceDocumentShape` ran inside the read effect alone, so a document arriving already
   * present through the `document` prop was never checked. That is not a hypothetical entry:
   * `use-tab-manager.ts` restores the tab set from `localStorage` with a `JSON.parse` guarded
   * only by `Array.isArray(parsed.tabs)`, so once a Source tab carries its document, an older
   * shape, a truncated write or a hand-edited entry arrives with `needsRead === false`. A part
   * with an empty `text` then mounted an editor holding `""` over an object that HAS a
   * definition, which is the exact DBeaver composition this phase exists to prevent (#789).
   */
  function renderWithDocument(value: ObjectSourceDocument) {
    render(
      <ObjectSourceView
        connection={connection}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        document={value}
        refreshToken={0}
        readAtToken={0}
        reader={readerFor(oneReadablePart)}
        onChange={() => {}}
      />,
    );
  }

  test("refuses a prop-supplied document whose only part carries an EMPTY text, and draws no editor", () => {
    renderWithDocument({
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], text: "" }],
    });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
  });

  test("refuses a prop-supplied part carrying BOTH text and unavailable, rather than dropping the text", () => {
    // tsc 6.0.3 admits this literal: the excess-property check on a union accepts any property
    // declared on any member, so `isSourcePartUnavailable` would narrow it to the refusal and
    // the definition the engine returned would vanish behind our own headline.
    renderWithDocument({
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], unavailable: "wrapped" }],
    });

    expect(screen.queryByTestId("object-source-refused")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
  });

  test("refuses a prop-supplied origin outside its union, which would caption `undefined`", () => {
    // A host-shaped lie: `origin: "typed"` indexes the frozen record at a key it has no entry
    // for, so the caption read "undefined Complete as shown." with an editor open beneath it.
    renderWithDocument({
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], origin: "typed" }],
    } as unknown as ObjectSourceDocument);

    expect(screen.queryByTestId("object-source-caption")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
  });

  test("still renders a prop-supplied document that the shape check accepts", () => {
    // The control for the three refusals above. Without it they could all pass over a viewer
    // that simply refused every prop-supplied document.
    renderWithDocument(oneReadablePart);

    expect(screen.queryByTestId("object-source-failure")).toBeNull();
    expect(editorValue()).toContain("FUNCTION total");
  });

  test("draws the refusal pane for a document whose ONLY part is a refusal, with no tablist", async () => {
    const onlyRefusal: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [refusedSecondPart.parts[1]!],
    };
    render(<Harness reader={readerFor(onlyRefusal)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-refused")).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("The text for object 'customer_summary' is encrypted.")).toBeTruthy();
  });

  /**
   * A LATE ANSWER BELONGS TO THE OBJECT THAT ASKED FOR IT, and one ref could not say that.
   *
   * The first spelling kept ONE `asked` ref holding the last address issued, and dropped any
   * answer whose address no longer matched it. Dropping on UNMOUNT is intended and documented:
   * the read a reader started before switching tabs is there when they switch back, because the
   * unmounted instance still writes through the `onChange` it held. But a shell that reuses ONE
   * mounted pane for a second object, which is what both shells do when the reader switches
   * between two Source tabs, moves the address on the SAME instance, and the first object's
   * answer was then thrown away in silence: its tab went back to "nothing read" and paid for a
   * second round trip on the next visit.
   *
   * The answer is written through the `onChange` captured when the read was ISSUED, and in both
   * shells that callback names the tab that asked, so the write lands on the right tab. What
   * stops the OTHER shape, a shell holding one state slot for two objects, is the identity check
   * below rather than a dropped answer.
   */
  test("writes an answer for the object that asked, even after the pane moved to another", async () => {
    const released: Record<string, (value: unknown) => void> = {};
    const reader: ObjectSourceReader = (_connection, path) =>
      new Promise((resolve) => {
        released[path[path.length - 1] ?? ""] = resolve;
      });
    const patches: { readonly tab: string; readonly patch: ObjectSourcePatch }[] = [];
    function OnePane({ name }: { readonly name: string }) {
      // The real shells' writer: its identity moves with the ACTIVE tab, so the callback the
      // viewer captured when it issued the read names the tab that asked for it.
      const onChange = React.useCallback(
        (patch: ObjectSourcePatch) => {
          patches.push({ tab: name, patch });
        },
        [name],
      );
      return (
        <ObjectSourceView
          connection={connection}
          path={["APP", name]}
          kind="package"
          kindLabel="Package"
          displayName={name}
          refreshToken={0}
          reader={reader}
          onChange={onChange}
        />
      );
    }
    const { rerender } = render(<OnePane name="one" />);
    await waitFor(() => expect(released.one).toBeTruthy());
    rerender(<OnePane name="two" />);
    await waitFor(() => expect(released.two).toBeTruthy());

    // The FIRST object answers last, after the same pane has moved on.
    await act(async () => {
      released.one({ ...oneReadablePart, path: ["APP", "one"] });
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.tab).toBe("one");
    expect(patches[0]?.patch.document?.path).toEqual(["APP", "one"]);
  });

  /**
   * A DOCUMENT NAMES THE OBJECT IT IS FOR, and the pane refuses one that names another (#789).
   *
   * Every provider in the fleet writes `path: [...path]` and `kind` onto the document it
   * answers, so this is a check against a HOST and against a shell that holds one state slot for
   * two objects: without it, a well-formed definition for another object renders under the
   * asked-for name, in the header and in the tab, with nothing on screen saying so. That is the
   * same fault `search` and `mongodb` were fixed for one level down, and it is the one shape a
   * late answer can still take now that late answers are kept.
   */
  test("refuses a document that names another object, rather than drawing it under this name", () => {
    render(
      <ObjectSourceView
        connection={connection}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        document={{ ...oneReadablePart, path: ["APP", "SOMETHING_ELSE"] }}
        refreshToken={0}
        readAtToken={0}
        reader={readerFor(oneReadablePart)}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a definition for another object.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    // The header still says what was ASKED for, so the sentence is about this pane's object.
    expect(screen.getByTestId("object-source-name").textContent).toBe("APP_ORDERS_PKG");
  });

  test("refuses a document that names this object under another KIND", () => {
    // The kind is half the address: one name can be a table and a routine in one schema on
    // MySQL, which standing ruling 3 records as measured, so the path alone does not identify.
    render(
      <ObjectSourceView
        connection={connection}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        document={{ ...oneReadablePart, kind: "procedure" }}
        refreshToken={0}
        readAtToken={0}
        reader={readerFor(oneReadablePart)}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a definition for another object.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("reports a READER that answers another object's definition as a failed read", async () => {
    const patches: ObjectSourcePatch[] = [];
    render(
      <Harness
        reader={readerFor({ ...oneReadablePart, path: ["APP", "SOMETHING_ELSE"] })}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(patches).toHaveLength(1);
    expect(patches[0]?.failure).toBe("The source read answered with a definition for another object.");
    expect(patches[0]?.document).toBeUndefined();
  });

  /**
   * THE HOST PATH HAS NO ROUTE IN FRONT OF IT, so the two bounds live in the shape check (#789).
   *
   * `/api/db/objects/source` applies `SOURCE_CHARACTER_LIMIT` and `SOURCE_PART_LIMIT` to every
   * answer it serialises, and the EMBEDDED shell calls none of it: the document comes back from a
   * host function and goes straight into this component. Without the bounds a host could hand the
   * shell tens of megabytes per part and any number of parts.
   *
   * An overrun is reported as a FAILED READ and never as a silent truncation, because this seam
   * cannot say whether the host already cut the text and a mark it composed would be a claim
   * about a cut it did not make.
   */
  test("refuses a host part whose text is longer than the route's own character bound", async () => {
    const huge: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], text: "x".repeat(SOURCE_CHARACTER_LIMIT + 1) }],
    };
    render(<Harness reader={readerFor(huge)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("accepts a host part sitting exactly ON the character bound, so the bound is not off by one", async () => {
    // The CONTROL for the test above: the bound is what the route itself emits after cutting, so
    // refusing a text OF that length would refuse every truncated definition the route answers.
    const exact: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [{ ...oneReadablePart.parts[0], text: "x".repeat(SOURCE_CHARACTER_LIMIT) }],
    };
    render(<Harness reader={readerFor(exact)} />);

    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(editorValue()).toHaveLength(SOURCE_CHARACTER_LIMIT);
  });

  test("refuses a host document carrying more parts than the route will carry", async () => {
    const many = {
      path: [...PATH],
      kind: "package",
      parts: Array.from({ length: SOURCE_PART_LIMIT + 1 }, (_unused, index) => ({
        ...oneReadablePart.parts[0],
        id: `p${index}`,
        label: `Part ${index}`,
      })),
    } as unknown as ObjectSourceDocument;
    render(<Harness reader={readerFor(many)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("accepts a host document holding exactly the part bound, so the bound is not off by one", async () => {
    const many = {
      path: [...PATH],
      kind: "package",
      parts: Array.from({ length: SOURCE_PART_LIMIT }, (_unused, index) => ({
        ...oneReadablePart.parts[0],
        id: `p${index}`,
        label: `Part ${index}`,
      })),
    } as unknown as ObjectSourceDocument;
    render(<Harness reader={readerFor(many)} />);

    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(SOURCE_PART_LIMIT));
  });

  test("refuses a host refusal SENTENCE longer than a text is allowed to be", async () => {
    /*
     * A refusal is a text this component renders, and the route carries it through untouched on
     * the reasoning that a refusal has nothing to bound. So the sentence was the one string on
     * this surface with no bound at all, on both paths.
     */
    const shouting: ObjectSourceDocument = {
      path: [...PATH],
      kind: "package",
      parts: [{ id: "body", label: "Package body", unavailable: "u".repeat(SOURCE_CHARACTER_LIMIT + 1) }],
    };
    render(<Harness reader={readerFor(shouting)} />);

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.queryByTestId("object-source-refused")).toBeNull();
  });

  test("refuses when there is no connection to read with, rather than being handed one", async () => {
    /*
     * The THIRD door onto the empty-editor hazard, and the one round 1 named and left open
     * (#789 fix round 1). Both shells branched on `sourceTab === undefined || activeConnection
     * === null` and mounted the query toolbar plus the query editor for the second half, so a
     * Source tab that was open when the last connection went away came back labelled
     * `Source: <name>` over an EMPTY, EDITABLE buffer with a live Run button. The state is
     * reached rather than merely admitted by the type: `use-connection-adapter.ts` auto-selects
     * whenever the host's list is non-empty, so a null active connection is exactly "the host
     * handed an empty connections array", which is what a host does when a person deletes the
     * last connection in the host's own UI.
     *
     * So the branch is `sourceTab === undefined` alone in both shells and the viewer takes a
     * nullable connection, because the connection is the one thing a read cannot be issued
     * without. NO READ IS ISSUED: the reader's call count is asserted at zero, which is the
     * half that keeps the standalone shell from asking a route for a connection that is gone.
     */
    const reader = readerFor(oneReadablePart);
    render(
      <ObjectSourceView
        connection={null}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        refreshToken={0}
        reader={reader}
        onChange={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "This connection is no longer open, so this definition cannot be read here.",
    );
    // The two halves of the hazard, asserted apart: no editor to type into, and the pane still
    // names the object the tab was opened for.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("object-source-name").textContent).toBe("APP_ORDERS_PKG");
    expect(reader.calls).toBe(0);
  });

  test("keeps a definition already in hand when the connection goes away", async () => {
    /*
     * The same decision the host-withdrawal arm makes one level up: a definition on screen was
     * really read from the engine a moment ago, and losing the connection is not a reason to
     * replace a real definition with a sentence. What it must not become is an editable buffer,
     * and the read-only editor with the text in it is not one.
     */
    const reader = readerFor(oneReadablePart);
    render(
      <ObjectSourceView
        connection={null}
        path={[...PATH]}
        kind="package"
        kindLabel="Package"
        displayName="APP_ORDERS_PKG"
        document={oneReadablePart}
        refreshToken={0}
        reader={reader}
        onChange={() => {}}
      />,
    );

    expect(editorValue()).toContain("CREATE OR REPLACE PACKAGE APP.APP_ORDERS_PKG");
    expect(screen.queryByTestId("object-source-failure")).toBeNull();
    expect(reader.calls).toBe(0);
  });

  test("the barrel re-exports the live shape check, not a second copy of it", () => {
    // The barrel had no runtime importer anywhere in the tree, so its lines produced no `DA:`
    // record and the coverage gate could not see them. This is that importer.
    expect(isSourceDocumentShape(oneReadablePart)).toBe(true);
    expect(isSourceDocumentShape({ ...oneReadablePart, parts: [] })).toBe(false);
  });

  test("uses the application's own route when no reader is supplied", async () => {
    const realFetch = globalThis.fetch;
    let seenUrl = "";
    globalThis.fetch = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify(oneReadablePart), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      render(
        <ObjectSourceView
          connection={connection}
          path={[...PATH]}
          kind="package"
          kindLabel="Package"
          displayName="APP_ORDERS_PKG"
          refreshToken={0}
          onChange={() => {}}
        />,
      );
      await waitFor(() => expect(seenUrl.endsWith("/api/db/objects/source")).toBe(true));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * EDIT MODE (#789 Phase 3, from discussion #778).
 *
 * Everything below is about the bar between the truncation banner and the editor, the buffer the
 * reader types into, the draft that outlives a tab switch, and the modal that is the ONLY way
 * from this pane to a database. Phase 2's pane is what this suite's first test pins: with no
 * `onApply`, nothing here renders at all.
 *
 * WHAT A COMPONENT TEST CANNOT SEE, said once here rather than implied by silence: the editor is a
 * `<textarea>`, so there is no model, no marker glyph and no diff. Every marker assertion below is
 * an assertion about the CALL this pane makes into Monaco's own namespace, and the rendering half
 * belongs to the end-to-end spec.
 */
const EDIT_PATH = ["app", "f(integer)"] as const;

const pgConnection: DatabaseConnection = {
  id: "pg-1",
  name: "pg",
  type: "postgres",
  createdAt: new Date("2026-01-01"),
};

const READABLE = {
  id: "definition",
  label: "Definition",
  text: "CREATE OR REPLACE FUNCTION app.f(integer) RETURNS integer\n  LANGUAGE sql\n  AS $$ SELECT 1 $$;",
  language: "sql",
  form: "complete",
  origin: "regenerated",
  edit: { offered: true },
} as const;

const SECOND_PART = {
  id: "grants",
  label: "Grants",
  text: "GRANT EXECUTE ON FUNCTION app.f(integer) TO app_reader;",
  language: "sql",
  form: "complete",
  origin: "regenerated",
  edit: { offered: true },
} as const;

function withPart(...parts: readonly ObjectSourcePart[]): ObjectSourceDocument {
  return {
    path: [...EDIT_PATH],
    kind: "function",
    parts: parts as unknown as ObjectSourceDocument["parts"],
  };
}

const STEP_TEXT = "CREATE OR REPLACE FUNCTION app.f(integer) RETURNS integer\n  LANGUAGE sql\n  AS $$ SELECT 2 $$;";

/**
 * A step whose MAP SPANS ITS OWN TEXT, which is what `isObjectEditPlanShape` requires and what a
 * real provider produces.
 *
 * The first spelling of this fixture ended the single user segment at offset 10 over an
 * 88-character text, and MEASURED against the shipped predicate that plan is REFUSED: ruling 1a's
 * span check (`spansTheText` in `src/lib/api/object-edit-wire.ts`) answers false when the
 * segments laid end to end do not reach `text.length`, so every test below that expects a preview
 * would have been asserting the pane's UNREADABLE arm while reading as if it asserted the happy
 * path. Corrected here rather than routed around, because the fixture was wrong and the
 * assertions were right.
 */
const STEP: ObjectEditStep = {
  text: STEP_TEXT,
  language: "sql",
  segments: [{ from: "user", start: 0, end: STEP_TEXT.length }],
};

const PLAN: ObjectEditPlan = {
  planVersion: 1,
  planId: "plan-1",
  issuedAt: "2026-09-14T00:00:00.000Z",
  connectionFingerprint: "fingerprint",
  type: "postgres",
  path: [...EDIT_PATH],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: { medium: "statement", steps: [STEP] },
  session: [],
  revision: { check: "compared", token: "t1", basis: "pg_proc.xmin", scope: "connection" },
  consequences: [],
};

const PREIMAGE: ObjectEditPreimage = { text: READABLE.text, language: "sql" };

const BUILT = { built: true, plan: PLAN, preimage: PREIMAGE, planToken: "token-1" };

/**
 * A plan that carries a CONSEQUENCE, which is the everyday Redis shape and not a corner (#789).
 *
 * `libraryCollateral` in `src/lib/db/providers/keyvalue/redis.ts` fills `consequences` for every
 * function library registering two or more functions, so a plan with a consequence is what the
 * one shipped collateral engine builds for an ordinary library. The pane's suite held no such
 * plan at all before the external review of PR #831 asked for the apply contract, which is why
 * the acknowledgement argument was reaching `apply` unmeasured.
 */
const COLLATERAL_PLAN: ObjectEditPlan = {
  ...PLAN,
  planId: "plan-with-a-consequence",
  consequences: [
    {
      loses: "replaces-whole-container",
      fact: { source: "FUNCTION LIST", observed: "libredb_probe registers libredb_ping and libredb_echo_key" },
    },
  ],
};

const COLLATERAL_BUILT = {
  built: true,
  plan: COLLATERAL_PLAN,
  preimage: PREIMAGE,
  planToken: "token-for-the-collateral-plan",
};

/**
 * The patch BOTH shipped shells emit from `onApplied`, copied from the source rather than
 * invented: `Studio.tsx` and `StudioWorkspace.tsx` each run
 * `onSourceChange({ document: undefined, failure: undefined, readAtToken: undefined })` there.
 * It is what drives the re-read, and it is what used to unmount the collateral report.
 */
const SHELL_APPLIED_PATCH: ObjectSourcePatch = { document: undefined, failure: undefined, readAtToken: undefined };

/**
 * An applier that BUILDS a plan carrying one consequence and APPLIES with one loss, which is the
 * Redis library shape: the plan warns that the whole container is replaced, and only the catalog
 * read AFTER the apply knows which function actually went.
 */
function collateralApply(): {
  readonly applier: ObjectSourceApplier;
  readonly apply: ReturnType<typeof mock>;
  readonly applied: ReturnType<typeof mock>;
  readonly patches: ObjectSourcePatch[];
} {
  const build = mock(async () => COLLATERAL_BUILT as unknown);
  const apply = mock(
    async () =>
      ({
        outcome: "applied-with-collateral",
        lost: [
          {
            loses: "replaces-whole-container",
            fact: {
              source: "FUNCTION LIST LIBRARYNAME libredb_probe",
              observed: "libredb_ping is no longer registered",
            },
          },
        ],
        revision: PLAN.revision,
        duration: 4,
      }) as unknown,
  );
  return { applier: { build, apply } as unknown as ObjectSourceApplier, apply, applied: mock(() => {}), patches: [] };
}

function applierDouble(): {
  readonly applier: ObjectSourceApplier;
  readonly build: ReturnType<typeof mock>;
  readonly apply: ReturnType<typeof mock>;
} {
  const build = mock(async () => BUILT as unknown);
  const apply = mock(async () => ({ outcome: "applied", revision: PLAN.revision, duration: 3 }) as unknown);
  return { applier: { build, apply } as unknown as ObjectSourceApplier, build, apply };
}

/**
 * The shell for the edit tests: it owns the tab state and merges every patch by SPREAD.
 *
 * A CLEARED DOCUMENT IS REPRESENTABLE HERE, and that is a repair rather than a tidy-up (#789,
 * fix round 1 of Task 30). This harness read `document={state.document ?? props.document}`, so a
 * patch clearing the document to `undefined` fell straight back to the static prop and the pane
 * kept drawing the definition. Both shipped shells clear it: `Studio.tsx` and
 * `StudioWorkspace.tsx` both answer `onApplied` with
 * `onSourceChange({ document: undefined, failure: undefined, readAtToken: undefined })`. So the
 * population this harness could build EXCLUDED the only two live mounts, and the collateral
 * report test below was green over a state neither shell reaches. `failure` and `readAtToken`
 * are passed through for the same reason: the pane writes both through `onChange` and a harness
 * that drops them cannot model a re-read that failed.
 */
function EditHarness(props: {
  readonly document: ObjectSourceDocument;
  readonly applier?: ObjectSourceApplier;
  readonly onPatch?: (patch: ObjectSourcePatch) => void;
  readonly onApplied?: () => void;
  readonly seed?: ObjectSourcePatch;
  /** The one label the shell derives rather than the pane, so a test may move it under a plan. */
  readonly displayName?: string;
  /**
   * What the SHELL does when the pane says the apply landed. Both shipped shells clear the
   * document here, which drives the re-read; a test that leaves this out models neither.
   */
  readonly appliedPatch?: ObjectSourcePatch;
  /** The reader the RE-READ gets, so a test may hang it or fail it. Defaults to the document. */
  readonly reader?: ObjectSourceReader;
}) {
  const [state, setState] = React.useState<ObjectSourcePatch>(props.seed ?? {});
  const record = props.onPatch;
  const onChange = React.useCallback(
    (patch: ObjectSourcePatch) => {
      record?.(patch);
      setState((previous) => ({ ...previous, ...patch }));
    },
    [record],
  );
  const hostApplied = props.onApplied;
  const appliedPatch = props.appliedPatch;
  const onApplied = React.useCallback(() => {
    hostApplied?.();
    if (appliedPatch !== undefined) setState((previous) => ({ ...previous, ...appliedPatch }));
  }, [hostApplied, appliedPatch]);
  return (
    <ObjectSourceView
      connection={pgConnection}
      path={[...EDIT_PATH]}
      kind="function"
      kindLabel="Function"
      displayName={props.displayName ?? "app.f(integer)"}
      /*
       * `in` and not `??`: an explicit `document: undefined` is a CLEAR and must reach the pane,
       * while a document the harness has never been told about falls back to the prop, which is
       * how the three tests below land a re-read by moving that prop.
       */
      document={"document" in state ? state.document : props.document}
      failure={state.failure}
      activePartId={state.activePartId}
      editingPartId={state.editingPartId}
      dirty={state.dirty}
      refreshToken={0}
      readAtToken={"readAtToken" in state ? state.readAtToken : 0}
      reader={props.reader ?? readerFor(props.document)}
      onApply={props.applier}
      onApplied={onApplied}
      onChange={onChange}
    />
  );
}

function editor(): HTMLTextAreaElement {
  return screen.getByTestId("source-editor") as HTMLTextAreaElement;
}

function domReadOnly(): boolean {
  return editor().getAttribute("data-dom-readonly") === "true";
}

/** Typing the way Monaco reports it: the model changed and the `value` PROP did not move. */
async function type(text: string): Promise<void> {
  await act(async () => {
    probe.change?.(text);
    await Promise.resolve();
  });
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    (screen.getByTestId(testId) as HTMLElement).click();
    await Promise.resolve();
  });
}

/** The debounce is REAL: bun:test has no timer clock, so the draft window is waited out. */
async function settleDraft(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 620));
  });
}

function draftKey(partId: string): string {
  return draftKeyFor(`${pgConnection.id}/${pathKey([...EDIT_PATH])}/function`, partId);
}

async function enterEditMode(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("object-source-edit")).toBeTruthy());
  await click("object-source-edit");
  await waitFor(() => expect(editor().readOnly).toBe(false));
}

/** The whole reader-side journey of a collateral apply: edit, preview, tick the warning, apply. */
async function applyTheCollateralEdit(): Promise<void> {
  await enterEditMode();
  await type("edited");
  await settleDraft();
  await click("object-source-preview");
  await waitFor(() => expect(screen.getByTestId("object-source-apply-ack")).toBeTruthy());
  await click("object-source-apply-ack");
  await click("object-source-apply-confirm");
}

describe("ObjectSourceView edit mode", () => {
  test("the bar is absent entirely when the shell cannot apply", async () => {
    // `onApply === undefined` means the pane is exactly Phase 2: no bar, no sentence, nothing.
    // That is the absent-handler rule `src/workspace/types.ts` already states for every optional
    // host method, and it is what keeps an existing embedded adopter from changing at all.
    render(<EditHarness document={withPart(READABLE)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(screen.queryByTestId("object-source-edit-bar")).toBeNull();
    expect(screen.queryByTestId("object-source-edit")).toBeNull();
    expect(editor().readOnly).toBe(true);
    expect(domReadOnly()).toBe(true);
  });

  test("the bar draws the predicate's sentence with a stable data-refusal, and no Edit control", async () => {
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart({ ...READABLE, edit: undefined })} />);
    await waitFor(() => expect(screen.getByTestId("object-source-edit-bar")).toBeTruthy());

    expect(screen.getByTestId("object-source-edit-refusal").getAttribute("data-refusal")).toBe("not-offered");
    expect(screen.getByTestId("object-source-edit-refusal").textContent).toBe(NOT_OFFERED_SENTENCE);
    expect(screen.queryByTestId("object-source-edit")).toBeNull();
    expect(editor().readOnly).toBe(true);
  });

  test("Edit makes the editor writable, and BOTH readOnly flags move together", async () => {
    // `domReadOnly` also blocks IME composition and paste at the DOM level, and MEASURED on a live
    // editor instance both are `true` in Phase 2, so driving only one leaves a writable pane
    // behind a read-only flag.
    const { applier } = applierDouble();
    const patches: ObjectSourcePatch[] = [];
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("object-source-edit")).toBeTruthy());
    await click("object-source-edit");

    expect(patches).toContainEqual({ editingPartId: "definition" });
    await waitFor(() => expect(editor().readOnly).toBe(false));
    expect(domReadOnly()).toBe(false);
  });

  test("the editor is writable ONLY when the predicate, editingPartId and onApply ALL hold", async () => {
    const { applier } = applierDouble();
    const seed = { editingPartId: "definition" } as const;

    // No applier, and the tab already says this part is being edited.
    const withoutApplier = render(<EditHarness document={withPart(READABLE)} seed={seed} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(editor().readOnly).toBe(true);
    withoutApplier.unmount();

    // The predicate refuses this part, and the tab still says it is being edited.
    const refused = render(
      <EditHarness applier={applier} document={withPart({ ...READABLE, form: "partial" })} seed={seed} />,
    );
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refusal").getAttribute("data-refusal")).toBe("body-only");
    expect(editor().readOnly).toBe(true);
    refused.unmount();

    // Everything holds except that the OTHER part is the one being edited.
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE, SECOND_PART)}
        seed={{ editingPartId: "grants", activePartId: "definition" }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(editor().readOnly).toBe(true);
  });

  test("switching to another part leaves edit mode, and switching back returns to the draft", async () => {
    // PER PART and not per tab, which buys three behaviours with no second flag: two parts of one
    // package can hold two independent drafts, the writable buffer can only ever be the part on
    // screen, and a switch is what clears the flag.
    const { applier } = applierDouble();
    const patches: ObjectSourcePatch[] = [];
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE, SECOND_PART)}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await enterEditMode();
    await type(`${READABLE.text} -- one`);
    await settleDraft();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe(`${READABLE.text} -- one`);

    await act(async () => {
      (screen.getAllByRole("tab")[1] as HTMLElement).click();
      await Promise.resolve();
    });
    expect(patches).toContainEqual(expect.objectContaining({ activePartId: "grants", editingPartId: undefined }));
    await waitFor(() => expect(editor().readOnly).toBe(true));
    expect(editor().value).toBe(SECOND_PART.text);

    await act(async () => {
      (screen.getAllByRole("tab")[0] as HTMLElement).click();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());
    await click("object-source-draft-restore-accept");
    await waitFor(() => expect(editor().value).toBe(`${READABLE.text} -- one`));
  });

  test("a part switch INSIDE the debounce window keeps the draft on the part it was typed on", async () => {
    /*
     * The population the test above does NOT build, and it is the common one in the product: it
     * calls `settleDraft()` before the switch, so it only ever exercises the already-flushed case.
     *
     * MEASURED on the first spelling of this pane: the pending timer's callback read the CURRENT
     * render's `draftKey` and `serverText`, and a part switch inside the 500 ms window therefore
     * wrote the DEFINITION's buffer under the GRANTS key. The definition was left with no draft at
     * all, and the grants part then offered to restore the definition's text as its own, with the
     * drift sentence on it because the definition's base token does not match the grants text. A
     * Restore-then-Preview from there would build a plan for `partId: "grants"` out of the
     * definition's bytes. The pending write is now keyed on the part it was SCHEDULED for, so a
     * switch inside the window costs nothing and misattributes nothing.
     */
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE, SECOND_PART)} />);
    await enterEditMode();
    await type(`${READABLE.text} -- mine`);

    // No `settleDraft()` here: the switch happens while the write is still pending.
    await act(async () => {
      (screen.getAllByRole("tab")[1] as HTMLElement).click();
      await Promise.resolve();
    });
    await settleDraft();

    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe(`${READABLE.text} -- mine`);
    expect(readDraft(window.localStorage, draftKey("grants"))).toBeUndefined();
    expect(screen.queryByTestId("object-source-draft-restore")).toBeNull();
  });

  test("a draft write that FAILS after a part switch says nothing about the part now on screen", async () => {
    /*
     * The other half of keying the pending write: a write scheduled on the definition lands after
     * the reader has moved to the grants part, by design, and if it fails it is the DEFINITION's
     * unsaved edit that is at risk. Drawn on the grants part, "It will be lost if you reload or
     * close this tab." is a statement about a draft the grants part does not have, and it sits
     * directly above a grants Edit button. The draft state carries the key it is about.
     */
    const { applier } = applierDouble();
    const realStorage = window.localStorage;
    const throwingStorage = {
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
    } as unknown as Storage;
    try {
      render(<EditHarness applier={applier} document={withPart(READABLE, SECOND_PART)} />);
      await enterEditMode();
      Object.defineProperty(window, "localStorage", { value: throwingStorage, configurable: true });
      await type(`${READABLE.text} -- mine`);

      await act(async () => {
        (screen.getAllByRole("tab")[1] as HTMLElement).click();
        await Promise.resolve();
      });
      await settleDraft();

      expect(screen.getByTestId("object-source-edit")).toBeTruthy();
      expect(screen.queryByTestId("object-source-draft-unsaved")).toBeNull();
    } finally {
      Object.defineProperty(window, "localStorage", { value: realStorage, configurable: true });
    }
  });

  test("`value` DOES NOT CHANGE while the reader is typing", async () => {
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    const before = probe.values.length;

    await type("CREATE OR REPLACE FUNCTION app.order_total(order_id integer) RETURNS numeric ...");
    await type("CREATE OR REPLACE FUNCTION app.order_total(order_id integer) RETURNS numeric AS ...");

    expect(probe.values.length).toBe(before);
    expect(editor().value).toBe(READABLE.text);
  });

  test("`dirty` is written to the tab only when the boolean FLIPS", async () => {
    const { applier } = applierDouble();
    const patches: ObjectSourcePatch[] = [];
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await enterEditMode();

    await type(`${READABLE.text}a`);
    await type(`${READABLE.text}ab`);
    await type(`${READABLE.text}abc`);
    expect(patches.filter((patch) => Object.hasOwn(patch, "dirty"))).toHaveLength(1);
    expect(patches.filter((patch) => Object.hasOwn(patch, "dirty"))[0]?.dirty).toBe(true);

    // Back to the original text flips it the other way, once.
    await type(READABLE.text);
    const flips = patches.filter((patch) => Object.hasOwn(patch, "dirty"));
    expect(flips).toHaveLength(2);
    expect(flips[1]?.dirty).toBeUndefined();
  });

  test("a landed read that changes the document does NOT swap the buffer under the typing", async () => {
    // The read effect rewrites `document` with no drop, deliberately. The buffer does not follow
    // `part.text` while editing, so the document may change beneath the reader and the text they
    // are typing is untouched; the pane SAYS the underlying text moved rather than hiding it.
    const { applier } = applierDouble();
    function Moving(): React.JSX.Element {
      const [document, setDocument] = React.useState(withPart(READABLE));
      return (
        <>
          <button
            type="button"
            data-testid="move-the-document"
            onClick={() => {
              setDocument(withPart({ ...READABLE, text: `${READABLE.text} -- somebody else` }));
            }}
          >
            move
          </button>
          <EditHarness applier={applier} document={document} />
        </>
      );
    }
    render(<Moving />);
    await enterEditMode();
    await type(`${READABLE.text} -- mine`);
    const values = [...probe.values];

    await click("move-the-document");

    expect(probe.values).toEqual(values);
    expect(editor().value).toBe(READABLE.text);
    expect(screen.getByTestId("object-source-edit-moved").textContent).toContain("changed on the server");
  });

  test("a draft is written debounced, and the cleanup FLUSHES the pending write", async () => {
    // The same 500 ms the workspace save effect uses at `use-tab-manager.ts:214`, so the two
    // writers have one rhythm. The READ effect keeps its documented no-cleanup, no-drop shape:
    // this is a SECOND effect and it does not touch that one.
    const { applier } = applierDouble();
    const view = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();

    await type("abc");
    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
    await settleDraft();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("abc");

    await type("abcd");
    view.unmount();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("abcd");
  });

  test("a draft identical to the server's text is never written, so `dirty` cannot outlive its change", async () => {
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();

    await type("abc");
    await type(READABLE.text);
    await settleDraft();

    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
  });

  test("a stored draft shows the ENGINE's text read-only under a restore banner", async () => {
    // The pane NEVER shows draft text in a read-only editor, because a read-only editor reads as
    // "this is what the engine holds" and a silent restore would make that false.
    //
    // The draft is written BY THE PANE and never by a hand-built record, which is what makes the
    // `base` this banner compares against the value the real writer stores rather than a value
    // this file invented to match.
    const { applier } = applierDouble();
    const first = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- the unsaved one");
    await settleDraft();
    first.unmount();

    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());

    expect(editor().value).toBe(READABLE.text);
    expect(editor().readOnly).toBe(true);
    expect(screen.getByTestId("object-source-draft-restore").textContent).toContain("unsaved edit of this part");
    expect(screen.getByTestId("object-source-draft-restore").textContent).not.toContain(
      "The definition on the server has changed since then.",
    );

    await click("object-source-draft-restore-accept");
    await waitFor(() => expect(editor().value).toBe("-- the unsaved one"));
    expect(editor().readOnly).toBe(false);
  });

  test("the restore banner says so when the definition MOVED under the draft", async () => {
    const { applier } = applierDouble();
    const first = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- the unsaved one");
    await settleDraft();
    first.unmount();

    render(
      <EditHarness
        applier={applier}
        document={withPart({ ...READABLE, text: `${READABLE.text}\n-- and somebody else edited it` })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());

    expect(screen.getByTestId("object-source-draft-restore").textContent).toContain(
      "The definition on the server has changed since then.",
    );
  });

  test("Discard drops the draft, leaves edit mode and puts the engine's text back", async () => {
    const { applier } = applierDouble();
    const patches: ObjectSourcePatch[] = [];
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await enterEditMode();
    await type("-- mine");
    await settleDraft();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("-- mine");

    await click("object-source-discard");

    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
    expect(patches).toContainEqual(expect.objectContaining({ editingPartId: undefined, dirty: undefined }));
    await waitFor(() => expect(editor().readOnly).toBe(true));
    expect(editor().value).toBe(READABLE.text);
  });

  test("Edit pressed over a draft the reader never restored, then Discard, LEAVES that draft", async () => {
    /*
     * The bar offers Edit and the restore banner AT THE SAME TIME, so a reader can press Edit by
     * mistake while an older unsaved edit is still on offer. Edit seeds the buffer from the
     * engine's text and leaves the draft alone, and a Discard that dropped it regardless would
     * destroy an unsaved edit the reader never saw the contents of and never asked to lose.
     *
     * The rule is OWNERSHIP: this pane drops a stored draft only when the session either restored
     * it or wrote it, and here it did neither.
     */
    const { applier } = applierDouble();
    const first = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- the older unsaved one");
    await settleDraft();
    first.unmount();

    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());
    await click("object-source-edit");
    await waitFor(() => expect(editor().readOnly).toBe(false));

    await click("object-source-discard");

    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("-- the older unsaved one");
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());
  });

  test("Restore and then Discard DOES drop it, because that session took the draft on", async () => {
    // The other half of the ownership rule, and the half a reader means by Discard: they read the
    // restored text, decided against it, and the draft is what they discarded.
    const { applier } = applierDouble();
    const first = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- the older unsaved one");
    await settleDraft();
    first.unmount();

    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());
    await click("object-source-draft-restore-accept");
    await waitFor(() => expect(editor().value).toBe("-- the older unsaved one"));

    await click("object-source-discard");

    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
    expect(screen.queryByTestId("object-source-draft-restore")).toBeNull();
  });

  test("a failed draft write is a PERSISTENT banner, with one sentence per reason, and editing is NOT blocked", async () => {
    // A banner and not a toast, because it is a STATE that persists for as long as the reader
    // keeps typing, and a toast that scrolled away three minutes ago is X14 with extra steps.
    // MEASURED: X14 was reproduced through the product's own New tab button, an uncaught
    // QuotaExceededError, zero toasts, zero alerts, and no occurrence of the word "quota"
    // anywhere in the document.
    const { applier } = applierDouble();
    /*
     * THE WHOLE `localStorage` IS REPLACED, and the two spellings that do not work are recorded
     * here because both of them LOOK like they do.
     *
     * A bare `Storage.prototype.setItem` raises `ReferenceError: Storage is not defined`:
     * MEASURED on happy-dom 20, the constructor is a property of the window and is NOT installed
     * on `globalThis`. Reaching it as `window.Storage.prototype.setItem` gets past that and still
     * does nothing, and this is the one worth writing down: MEASURED in the same run,
     * `Object.getPrototypeOf(window.localStorage) === window.Storage.prototype` is TRUE while
     * `window.localStorage.setItem === window.Storage.prototype.setItem` is FALSE, because
     * happy-dom's storage is a Proxy that answers `setItem` from its own target. So the patched
     * prototype method is never called, the draft is written successfully, and the test asserts
     * the failure banner over a store that did not fail.
     *
     * A property on the window is what the pane actually reads: `browserStorage()` asks for
     * `window.localStorage` at the moment of use for exactly this reason.
     */
    const realStorage = window.localStorage;
    const throwingStorage = {
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", { value: throwingStorage, configurable: true });
    try {
      render(<EditHarness applier={applier} document={withPart(READABLE)} />);
      await enterEditMode();
      await type("-- mine");
      await settleDraft();

      const banner = screen.getByTestId("object-source-draft-unsaved");
      expect(banner.getAttribute("role") ?? banner.tagName.toLowerCase()).toBe("output");
      expect(banner.textContent).toContain("It will be lost if you reload or close this tab.");
      expect(banner.textContent).toContain("storage");
      expect(editor().readOnly).toBe(false);
      expect((screen.getByTestId("object-source-preview") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", { value: realStorage, configurable: true });
    }
  });

  test("the over-limit reason is the ONE that disables Preview, because the route would refuse it anyway", async () => {
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();

    await type("x".repeat(SOURCE_CHARACTER_LIMIT + 1));
    await settleDraft();

    expect(screen.getByTestId("object-source-draft-unsaved").textContent).toContain("1,000,000");
    expect((screen.getByTestId("object-source-preview") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a foreign tab that evicted this draft is TOLD, through a storage event", async () => {
    // MEASURED by grep: there is no `addEventListener("storage", ...)` and no `BroadcastChannel`
    // anywhere in `src/`. With one key and oldest-first eviction, two Studio browser tabs silently
    // destroy each other's drafts: tab B evicts tab A's, tab B shows its own failure, and tab A
    // keeps saying "Saved in this browser" over a draft that is gone. That is X14's shape inside
    // the subsystem decision H2 created to avoid it.
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- mine");
    await settleDraft();
    expect(screen.getByTestId("object-source-draft-state").textContent).toContain("Saved in this browser");

    await act(async () => {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({}));
      // `window.StorageEvent` for the same measured reason as `window.Storage` above: happy-dom 20
      // installs neither constructor on `globalThis`.
      window.dispatchEvent(new window.StorageEvent("storage", { key: DRAFT_KEY, newValue: JSON.stringify({}) }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("object-source-draft-unsaved").textContent).toContain(
      "another LibreDB tab needed the space",
    );
  });

  test("a draft this mount only OFFERS, evicted by a foreign tab, is TOLD and stops being offered", async () => {
    /*
     * The half of the eviction listener its own docblock claimed and its code excluded. MEASURED
     * on the first spelling: the listener returned early unless `savedKeyRef.current` was set, and
     * that ref is written only by THIS mount's own draft write, so a draft written in an earlier
     * session and offered by the restore banner was never watched. The banner kept offering a
     * draft that was gone, `object-source-draft-unsaved` was absent, and pressing Restore would
     * have seeded the buffer from... nothing, because `storedDraft` is memoised and none of its
     * dependencies move when a foreign tab empties the store.
     */
    const { applier } = applierDouble();
    const first = render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- the unsaved one");
    await settleDraft();
    first.unmount();

    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());

    await act(async () => {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({}));
      window.dispatchEvent(new window.StorageEvent("storage", { key: DRAFT_KEY, newValue: JSON.stringify({}) }));
      await Promise.resolve();
    });

    expect(screen.getByTestId("object-source-draft-unsaved").textContent).toContain(
      "another LibreDB tab needed the space",
    );
    expect(screen.queryByTestId("object-source-draft-restore")).toBeNull();
  });

  test("Preview changes opens the dialog, builds through the applier, and sends the REF's text", async () => {
    const { applier, build } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");

    await click("object-source-preview");

    expect(build).toHaveBeenCalledWith(pgConnection, {
      path: [...EDIT_PATH],
      kind: "function",
      partId: "definition",
      text: "edited",
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy());
  });

  test("a build that REFUSES never opens a preview, and says why in the bar", async () => {
    const { applier, build } = applierDouble();
    build.mockResolvedValueOnce({
      built: false,
      refusal: {
        refusal: "privilege",
        sentence: "must be owner of function order_total",
        code: "42501",
        at: { within: "none" },
      },
    } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");

    await click("object-source-preview");

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("privilege");
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain(
      "must be owner of function order_total",
    );
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("a build answer that is not a build response at all is refused in OUR own sentence", async () => {
    const { applier, build } = applierDouble();
    build.mockResolvedValueOnce({ built: true, plan: PLAN } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");

    await click("object-source-preview");

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain("could not be read");
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("an EDIT_PLAN_INVALID answer puts the dialog in `expired`, which is the only control that rebuilds", async () => {
    const { applier, apply } = applierDouble();
    apply.mockRejectedValueOnce(new ObjectEditRequestError("this preview has expired", "EDIT_PLAN_INVALID"));
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-expired")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-rebuild")).toBeTruthy();
  });

  test("a malformed answer from the applier is a FAILED apply carrying our own sentence", async () => {
    // A read that lies shows the wrong text; an apply that lies tells a reader their change landed
    // when it did not. This is the only thing standing on the embedded seam.
    const { applier, apply } = applierDouble();
    apply.mockResolvedValueOnce({ outcome: "applied", conflict: "object-changed" } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-outcome")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-outcome").textContent).toContain("could not be read");
  });

  test("a foreign tab that wrote the key WITHOUT taking this draft is not reported as an eviction", async () => {
    /*
     * The control for the eviction test above, and it exists because the guard it controls
     * SURVIVED its mutation: deleting the `readDraft(...) !== undefined` line left the suite at 75
     * pass 0 fail, so the eviction detector was a guard over a population nothing built.
     *
     * The population is ordinary and is the common case rather than the rare one: one key holds
     * every draft, so ANOTHER Studio tab saving ITS OWN draft writes this key and fires this event
     * without touching ours. Reported as an eviction, that is a banner telling a reader their
     * unsaved work is gone while it is sitting in the store, which is the false half of exactly
     * the silence the eviction banner was added to break.
     */
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("-- mine");
    await settleDraft();
    const held = window.localStorage.getItem(DRAFT_KEY) ?? "{}";
    const withAForeignDraft = JSON.stringify({
      ...(JSON.parse(held) as Record<string, unknown>),
      "another-connection/other/function/definition": {
        text: "-- theirs",
        savedAt: 1,
        base: { check: "unavailable", reason: "none" },
      },
    });

    await act(async () => {
      window.localStorage.setItem(DRAFT_KEY, withAForeignDraft);
      window.dispatchEvent(new window.StorageEvent("storage", { key: DRAFT_KEY, newValue: withAForeignDraft }));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("object-source-draft-unsaved")).toBeNull();
    expect(screen.getByTestId("object-source-draft-state").textContent).toContain("Saved in this browser");
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("-- mine");
  });

  test("a build the ROUTE refused carries the route's own sentence into the bar", async () => {
    // The build seam throws rather than answering on every non-2xx: `httpSourceApplier` mints an
    // `ObjectEditRequestError` from the body's `error`, and an embedded host's `build` may throw
    // anything at all. Either way nothing was previewed and nothing was sent, so the answer is the
    // same refusal line the bar uses for a build that answered `built: false`.
    const { applier, build } = applierDouble();
    build.mockRejectedValueOnce(new ObjectEditRequestError("The apply preview could not be built: HTTP 503."));
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");

    await click("object-source-preview");

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain("HTTP 503");
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("an apply that THROWS anything other than an expired plan is a failed apply, not an expired one", async () => {
    // The arm the `EDIT_PLAN_INVALID` test above is the exception to, and it is a different
    // outcome for the reader: the plan is still valid, so the control is Close and not Rebuild.
    // `interrupted` with `committed: "unknown"` is the honest disposition, because the statement
    // was SENT and no answer this pane can read came back.
    const { applier, apply } = applierDouble();
    apply.mockRejectedValueOnce(new ObjectEditRequestError("The apply failed: HTTP 502.", "DATABASE_ERROR"));
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-outcome")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-outcome").textContent).toContain("HTTP 502");
    expect(screen.getByTestId("object-source-apply-outcome").textContent).toContain(
      "Whether it was applied is unknown",
    );
    expect(screen.queryByTestId("object-source-apply-expired")).toBeNull();
  });

  test("an apply that answers `object-changed` puts the SERVER's text on the left of a conflict diff", async () => {
    // Decision H3's user-facing half: the lost update is not reported as a failure, it is shown.
    // The reader's own edit is the right side and it is taken from the shot the BUILD was made
    // from, so the two sides of the diff are the two texts that actually disagree.
    const { applier, apply } = applierDouble();
    apply.mockResolvedValueOnce({
      outcome: "conflict",
      conflict: "object-changed",
      current: { text: `${READABLE.text}\n-- somebody else got there first`, language: "sql" },
      duration: 5,
    } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-conflict")).toBeTruthy());
    expect(screen.getByTestId("diff-editor").getAttribute("data-original")).toContain("somebody else got there first");
    expect(screen.getByTestId("diff-editor").getAttribute("data-modified")).toBe("edited");
    expect(screen.getByTestId("object-source-apply-rebuild")).toBeTruthy();
  });

  test("Cancel closes the dialog and leaves the edit exactly where it was", async () => {
    const { applier } = applierDouble();
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-cancel")).toBeTruthy());

    await click("object-source-apply-cancel");

    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
    expect(editor().readOnly).toBe(false);
    expect((screen.getByTestId("object-source-preview") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a successful apply closes the dialog, drops the draft, clears edit mode and calls onApplied", async () => {
    const { applier } = applierDouble();
    const patches: ObjectSourcePatch[] = [];
    const applied = mock(() => {});
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onApplied={applied}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await enterEditMode();
    await type("edited");
    await settleDraft();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
    expect(patches).toContainEqual(expect.objectContaining({ editingPartId: undefined, dirty: undefined }));
    expect(applied).toHaveBeenCalledTimes(1);
  });

  test("an apply that DESTROYED something else keeps the dialog open and names what went", async () => {
    /*
     * X24, the last open item of the external review of PR #831, and it is a REACHABILITY defect
     * rather than a rendering one.
     *
     * `ApplyPreviewDialog`'s `applied-with-collateral` arm was written in Task 14 and covered by
     * `tests/components/object-source/ApplyPreviewDialog.test.tsx`, which drives it by handing
     * `draw()` a `{ kind: "failed", outcome: applied-with-collateral }` state DIRECTLY. That state
     * was one the only mount of that dialog in `src/` could not produce: this pane held
     * `applied-with-collateral` in `APPLIED_OUTCOMES`, so it landed the outcome with
     * `setPreview(undefined)` and the dialog unmounted on a plain success. A green test over a
     * region no screen could ever show, which is this phase's signature defect one more time.
     *
     * The population is not theoretical, and the first spelling of this docblock got its size
     * WRONG in the other direction: it said `3a4511a5` had grown it. RUN in fix round 1,
     * `git show 3a4511a5 -- src/lib/db/providers/keyvalue/redis.ts`, that commit moves one
     * behavioural line, `functions.length < 2` to `functions.length === 0`, inside
     * `libraryCollateral`, which is the BUILD's warning; the outcome's producer is
     * `if (disappeared.length > 0)`, landed in `1d6ac884` and not touched since. So the WARNING
     * population grew and this one is exactly what it was: every Redis library edit whose new
     * body does not re-register every name the old one did, which is the ordinary result of
     * editing a library of two or more functions. The reader ticked a SUPERSET beforehand, which
     * is what keeps ruling 1b amended satisfied. What was missing is the report of what ACTUALLY
     * went, and only the catalog read AFTER the apply knows that: the plan's warning says what
     * WOULD be lost.
     *
     * This test drives it at the PANE and not at the dialog, so it fails if the mount cannot
     * produce the state, which is exactly what the dialog's own test cannot see.
     */
    const { applier, applied, patches } = collateralApply();
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onApplied={applied}
        onPatch={(patch) => {
          patches.push(patch);
        }}
      />,
    );
    await applyTheCollateralEdit();

    // THE REPORT IS ON SCREEN, and it names the catalog fact read after the apply. Asserted on the
    // rendered text rather than on a testid alone, because a region that renders with the tuple
    // dropped would satisfy a testid and tell the reader nothing.
    await waitFor(() => expect(screen.getByTestId("object-source-apply-outcome")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy();
    const report = screen.getByTestId("object-source-apply-outcome").textContent ?? "";
    expect(report).toContain("destroyed something else");
    expect(report).toContain("FUNCTION LIST LIBRARYNAME libredb_probe answers: libredb_ping is no longer registered.");

    // AND IT DID NOT READ AS A FAILURE. The apply SUCCEEDED, so everything the plain `applied` arm
    // does still happens: the draft goes, edit mode ends and the host re-reads. A screen that kept
    // the reader in edit mode over text the engine already holds would be the worse defect.
    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
    expect(patches).toContainEqual(expect.objectContaining({ editingPartId: undefined, dirty: undefined }));
    expect(applied).toHaveBeenCalledTimes(1);
    // There is nothing to retry and nothing to rebuild: the only control is the way out.
    expect(screen.queryByTestId("object-source-apply-confirm")).toBeNull();
    expect(screen.queryByTestId("object-source-apply-rebuild")).toBeNull();
    expect(screen.getByTestId("object-source-apply-cancel").textContent).toBe("Close");
  });

  test("the report SURVIVES the document clear both shells answer `onApplied` with", async () => {
    /*
     * X24 AT THE LEVEL THE READER ACTUALLY SEES IT (#789 Phase 3, fix round 1 of Task 30).
     *
     * The test above holds the preview session open and stops there, and holding the session open
     * is NOT enough, because this pane's dialog mount used to sit inside the `part !== undefined`
     * branch of the render. `onApplied` is the shell's cue to re-read, and BOTH shipped shells
     * answer it by clearing the document: `Studio.tsx` and `StudioWorkspace.tsx` each run
     * `onSourceChange({ document: undefined, failure: undefined, readAtToken: undefined })`. With
     * no document there is no `part`, so the branch holding the dialog was replaced by
     * `object-source-loading` and the report the arm had just created was destroyed by the arm's
     * own `onApplied`. MEASURED against the real `<Studio />` by the reviewer of round 1 and
     * reproduced here at the pane: `report GONE | loading yes`.
     *
     * So the mount moved OUT of that branch, to the top of the pane, where nothing about the
     * document can unmount it. The dialog is a Radix portal, so where it sits in this tree costs
     * the layout nothing; what it buys is that the reader keeps the only screen that names the
     * loss for as long as the loss is news, rather than for one network round trip.
     */
    const { applier, applied, patches } = collateralApply();
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onApplied={applied}
        onPatch={(patch) => {
          patches.push(patch);
        }}
        appliedPatch={SHELL_APPLIED_PATCH}
        // The re-read never lands. This is the connection that dropped, the route that is slow,
        // the tab the reader closes first: the loss is not less real because the read is pending.
        reader={() => new Promise<never>(() => {})}
      />,
    );
    await applyTheCollateralEdit();

    // The pane behind it is honestly in its loading state, which is the state that used to
    // REPLACE the dialog. Both are on screen at once, and that is the fix.
    await waitFor(() => expect(screen.getByTestId("object-source-loading")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy();
    expect(screen.getByTestId("object-source-apply-outcome").textContent ?? "").toContain(
      "FUNCTION LIST LIBRARYNAME libredb_probe answers: libredb_ping is no longer registered.",
    );
    expect(applied).toHaveBeenCalledTimes(1);
  });

  test("the report survives a re-read that FAILED, which is where losing it is permanent", async () => {
    /*
     * The same defect, on the path where it cannot be repaired by waiting (#789 Phase 3, fix
     * round 1 of Task 30). The apply succeeded and destroyed something; the read that follows it
     * answers HTTP 500, so the pane draws "The source read failed." and, before this fix, the
     * only record of what was destroyed was the audit ring, which no reader of this pane can
     * reach. That is X24 verbatim, one commit after X24 was called closed.
     *
     * The failure arrives the way a real one does, through the pane's own read effect and out to
     * the shell as a `failure` patch, rather than being handed in as a prop.
     */
    const { applier, applied, patches } = collateralApply();
    render(
      <EditHarness
        applier={applier}
        document={withPart(READABLE)}
        onApplied={applied}
        onPatch={(patch) => {
          patches.push(patch);
        }}
        appliedPatch={SHELL_APPLIED_PATCH}
        reader={() => Promise.reject(new Error("HTTP 500 from the source route"))}
      />,
    );
    await applyTheCollateralEdit();

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe("HTTP 500 from the source route");
    expect(screen.getByTestId("object-source-apply-outcome").textContent ?? "").toContain(
      "FUNCTION LIST LIBRARYNAME libredb_probe answers: libredb_ping is no longer registered.",
    );
  });

  test("the apply is called with the connection, the SEALED plan, its token and the classes the reader ticked", async () => {
    /*
     * THE APPLY CONTRACT, ASSERTED BY VALUE (#789, external review of PR #831, item 5).
     *
     * The suite around this one drove the apply a dozen times and never once said WHAT was sent.
     * MEASURED, as three mutation windows over `runApply` in `ObjectSourceView.tsx`, each run
     * against this file and against `tests/components/studio/source-tab.test.tsx`:
     *
     *   * `apply(connection, plan, undefined, [])`, dropping the token AND the acknowledgement:
     *     this file 92 pass 0 fail, so it certified nothing. `source-tab.test.tsx` DID catch it,
     *     1 fail, because it asserts the request BODY the standalone shell's applier sends. So
     *     the reviewer's mechanism is right and its claim that only an E2E covers this is not.
     *   * `apply(connection, plan, current.planToken, [])`, dropping the acknowledgement ALONE:
     *     this file 92 pass 0 fail AND `source-tab.test.tsx` 33 pass 0 fail. NOTHING in this
     *     repository killed it, because every other plan in both suites carries no consequence
     *     and `acknowledged: []` is then the correct value. That is what this test is for.
     *   * `current = preview` instead of `previewHere` in `runApply`, unbinding the apply from
     *     the address: 94 pass 0 fail, re-measured in fix round 1 at this file's baseline. The
     *     round-1 spelling of this line claimed 1 fail and that claim was FALSE. The mutant is
     *     UNOBSERVABLE rather than merely uncovered: `runApply` has exactly one caller,
     *     `onApply={runApply}` on `ApplyPreviewDialog`, and that mount is itself gated on
     *     `previewHere !== undefined`, so at every reachable call `preview` and `previewHere` are
     *     the same object. What a test CAN reach is the render-site binding, and
     *     "a build that lands after the reader moved to another tab does not open over that tab"
     *     is what kills that one. A SECOND caller of `runApply`, a keyboard shortcut or a
     *     host-driven apply, or a dialog re-mounted from `preview`, would put the word back in the
     *     reachable population, and nothing in this file would then notice it going.
     *
     * WHAT THE UNKILLED MUTATION COSTS A READER, and it is a live population rather than a
     * theoretical one: `src/app/api/db/objects/edit-apply/route.ts:128` refuses a plan whose
     * consequence classes are not all in `acknowledged`, so a pane that dropped the tick would
     * make every Redis library of two or more functions permanently unappliable, with the reader
     * looking at a ticked box and a refusal that says they did not tick it.
     */
    const build = mock(async () => COLLATERAL_BUILT as unknown);
    const apply = mock(async () => ({ outcome: "applied", revision: PLAN.revision, duration: 3 }) as unknown);
    const applier = { build, apply } as unknown as ObjectSourceApplier;
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-ack")).toBeTruthy());

    // The population the fourth argument comes from: Apply is DISABLED until the box is ticked,
    // so a test that pressed Apply without ticking would be asserting over an unreachable press.
    expect((screen.getByTestId("object-source-apply-confirm") as HTMLButtonElement).disabled).toBe(true);
    await click("object-source-apply-ack");
    await click("object-source-apply-confirm");

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    // All four by VALUE, which is the half ruling 1a actually needs: the bytes the reader
    // approved are the bytes the engine receives. `toHaveBeenCalledWith` is DEEP equality and
    // certifies no more than that, measured in fix round 1: with `runApply` mutated to send
    // `structuredClone(plan)` this file is 94 pass 0 fail on the line below alone.
    expect(apply).toHaveBeenCalledWith(pgConnection, COLLATERAL_PLAN, "token-for-the-collateral-plan", [
      "replaces-whole-container",
    ]);
    // And the plan is the OBJECT the build issued, not a rebuild of it that happens to compare
    // equal. This is the assertion that goes red under the `structuredClone` mutation above.
    expect((apply.mock.calls[0] as readonly unknown[])[1]).toBe(COLLATERAL_PLAN);
  });

  test("a successful apply after a re-read MOVED the active part drops the draft of the part applied", async () => {
    /*
     * The same root cause as the part-switch draft above, on the apply path: leaving edit mode
     * read the CURRENT render's `draftKey`. MEASURED on the first spelling: a re-read that landed
     * while the apply was in flight moved `activePart` to `grants`, and the successful apply then
     * dropped the GRANTS key, leaving the definition's now-applied draft in the store to be
     * offered back as an unsaved edit of a definition the engine already holds. The apply path now
     * drops the key of the part the PLAN was built for, which is pinned on the preview session.
     */
    const { applier, apply } = applierDouble();
    let landTheApply: (value: unknown) => void = () => {};
    apply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landTheApply = resolve;
        }),
    );
    function Moving(): React.JSX.Element {
      const [document, setDocument] = React.useState(withPart(READABLE, SECOND_PART));
      return (
        <>
          <button
            type="button"
            data-testid="land-a-reread"
            onClick={() => {
              setDocument(withPart(SECOND_PART));
            }}
          >
            re-read
          </button>
          <EditHarness applier={applier} document={document} />
        </>
      );
    }
    render(<Moving />);
    await enterEditMode();
    await type("edited");
    await settleDraft();
    expect(readDraft(window.localStorage, draftKey("definition"))?.text).toBe("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");

    await click("land-a-reread");
    expect(probe.path.endsWith("/grants")).toBe(true);
    await act(async () => {
      landTheApply({ outcome: "applied", revision: PLAN.revision, duration: 3 });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
    expect(readDraft(window.localStorage, draftKey("definition"))).toBeUndefined();
  });

  test("a MARKER is placed only for a `within: user` coordinate, on the RIGHT model", async () => {
    // Owner is one constant, `libredb-object-apply`. The MODEL is already per part, so two parts
    // cannot overwrite each other's markers, and the guard compares the live model's uri against
    // the path this pane expects, because a reader who switches parts while an apply is in flight
    // must not get the other part's error painted on this one.
    const { applier, apply } = applierDouble();
    apply.mockResolvedValueOnce({
      outcome: "refused",
      refusal: {
        refusal: "definition",
        sentence: "syntax error at end of input",
        code: "42601",
        at: { within: "user", line: 7, column: 3 },
      },
      duration: 4,
    } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-goto-error")).toBeTruthy());

    await click("object-source-apply-goto-error");

    expect(probe.markers.length).toBeGreaterThan(0);
    const placed = probe.markers[probe.markers.length - 1];
    expect(placed.owner).toBe("libredb-object-apply");
    expect(placed.markers[0]).toMatchObject({
      startLineNumber: 7,
      startColumn: 3,
      severity: MARKER_SEVERITY.Error,
      message: "syntax error at end of input",
    });
    expect(probe.revealed).toContainEqual({ lineNumber: 7, column: 3 });
  });

  test("an `outside` coordinate places NO marker at all", async () => {
    // MEASURED in a real browser: an uncorrected coordinate did not throw, did not warn and did
    // not look wrong, because Monaco silently CLAMPED it to the end of the model.
    const { applier, apply } = applierDouble();
    apply.mockResolvedValueOnce({
      outcome: "refused",
      refusal: {
        refusal: "definition",
        sentence: "syntax error at or near the placeholder",
        at: { within: "outside" },
      },
      duration: 4,
    } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-outcome")).toBeTruthy());
    expect(probe.markers.filter((call) => call.markers.length > 0)).toHaveLength(0);
    expect(screen.queryByTestId("object-source-apply-goto-error")).toBeNull();
  });

  test("a model that MOVED while the apply is in flight is not painted with the other part's error", async () => {
    /*
     * The population the model-uri guard exists for, BUILT rather than asserted, and it is not
     * the population this test was first written over.
     *
     * The first spelling clicked the part switcher while the dialog was open, and MEASURED, that
     * click is not reachable: the preview is a Radix modal, `DialogContent` takes the rest of the
     * document out of the accessible tree, and `getAllByRole("tab")` therefore answers
     * "Unable to find an accessible element with the role tab" with the dialog as the only role
     * in the document. A reader cannot switch parts through the switcher while an apply is in
     * flight, so THAT population is empty and a guard tested over it would certify nothing.
     *
     * The population that IS real needs no user action at all, which is why the guard stays. The
     * read effect above has no cleanup and no drop, deliberately, so a re-read issued before the
     * apply can land at any moment and REPLACE the document. When the parts it answers with do
     * not carry the remembered id, `activePart` falls back to the first part, the model path
     * changes under the open dialog, and the refusal that arrives a moment later carries a
     * coordinate in a text that is no longer on screen. That is what is driven here, the same way
     * the landed-read test above drives it: by moving the document prop.
     */
    const { applier, apply } = applierDouble();
    let landTheFailure: (value: unknown) => void = () => {};
    apply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          landTheFailure = resolve;
        }),
    );
    function Moving(): React.JSX.Element {
      const [document, setDocument] = React.useState(withPart(READABLE, SECOND_PART));
      return (
        <>
          <button
            type="button"
            data-testid="land-a-reread"
            onClick={() => {
              setDocument(withPart(SECOND_PART));
            }}
          >
            re-read
          </button>
          <EditHarness applier={applier} document={document} />
        </>
      );
    }
    render(<Moving />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");

    await click("land-a-reread");
    expect(probe.path.endsWith("/grants")).toBe(true);
    await act(async () => {
      landTheFailure({
        outcome: "refused",
        refusal: {
          refusal: "definition",
          sentence: "syntax error at end of input",
          at: { within: "user", line: 7, column: 3 },
        },
        duration: 4,
      });
      await Promise.resolve();
    });

    expect(probe.markers.filter((call) => call.markers.length > 0)).toHaveLength(0);
  });

  test("the marker is cleared on the first content change after it was placed", async () => {
    const { applier, apply } = applierDouble();
    apply.mockResolvedValueOnce({
      outcome: "refused",
      refusal: {
        refusal: "definition",
        sentence: "syntax error at end of input",
        at: { within: "user", line: 2, column: 1 },
      },
      duration: 4,
    } as unknown as never);
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(probe.markers.filter((call) => call.markers.length > 0).length).toBe(1));

    await type("edited again");

    const last = probe.markers[probe.markers.length - 1];
    expect(last.owner).toBe("libredb-object-apply");
    expect(last.markers).toEqual([]);
    // And a SECOND change does not clear a second time: the flag is what stops a `setModelMarkers`
    // on every keystroke of the rest of the session.
    const after = probe.markers.length;
    await type("edited again and again");
    expect(probe.markers.length).toBe(after);
  });
});

/**
 * TWO SOURCE TABS THROUGH ONE PANE, and an in-flight build that outlives the press (#789 Phase 3).
 *
 * Both shells mount this component with NO `key`: `Studio.tsx` and `StudioWorkspace.tsx` each render
 * exactly one `<ObjectSourceView>` and swap its props when the reader moves between two Source tabs,
 * which is the shape the read effect's `asked` SET was built for. Everything React holds in this
 * component therefore survives that move: `useState` and `useRef` alike. The read path was bound to
 * the address for that reason; the edit path added in this phase was not, and these tests are the
 * populations that difference produces.
 *
 * Written for the external review of PR #831, items C1 and C2, and kept as the regression.
 */
const A_PATH = ["app", "fa(integer)"] as const;
const B_PATH = ["app", "fb(integer)"] as const;

const A_TEXT = "CREATE OR REPLACE FUNCTION app.fa(integer) RETURNS integer\n  LANGUAGE sql\n  AS $$ SELECT 1 $$;";
const B_TEXT = "CREATE OR REPLACE FUNCTION app.fb(integer) RETURNS integer\n  LANGUAGE sql\n  AS $$ SELECT 2 $$;";

function functionDocument(path: readonly string[], text: string): ObjectSourceDocument {
  return {
    path: [...path],
    kind: "function",
    parts: [{ ...READABLE, text } as unknown as ObjectSourcePart],
  };
}

/** A second plan whose step SPANS its own text, which `isObjectEditPlanShape` requires. */
const SECOND_STEP_TEXT =
  "CREATE OR REPLACE FUNCTION app.f(integer) RETURNS integer\n  LANGUAGE sql\n  AS $$ SELECT 22 $$;";

const A_DOCUMENT = functionDocument(A_PATH, A_TEXT);
const B_DOCUMENT = functionDocument(B_PATH, B_TEXT);

/**
 * A build answer TAB A CAN ACTUALLY ACCEPT, and the reason this fixture exists at all (#789,
 * review fix round 2).
 *
 * `BUILT` above carries `PLAN`, whose `path` is `EDIT_PATH`, and every tab in `TwoSourceTabs`
 * renders `A_PATH` or `B_PATH`. MEASURED: landing `BUILT` in this harness reaches
 * `!namesThisObject(answer.plan, path, kind)` in `runBuild`'s resolve arm, which calls
 * `setPreview(undefined)` and raises the unreadable refusal, so no dialog can EVER open in this
 * describe. A tab-switch test that landed `BUILT` therefore asserted a null that was null because
 * the answer was refused, and it survived the mutation that unbinds the dialog from the address.
 * That is this epic's own named failure mode, a guard over a population nothing builds, and it is
 * what this fixture removes: `A_BUILT` names tab A's address, so the resolve arm's happy path runs
 * and the dialog's address binding is the only thing left that can close it.
 */
const A_PLAN: ObjectEditPlan = { ...PLAN, planId: "plan-for-tab-a", path: [...A_PATH] };

const A_BUILT = {
  built: true,
  plan: A_PLAN,
  preimage: { text: A_TEXT, language: "sql" } satisfies ObjectEditPreimage,
  planToken: "token-for-tab-a",
};
const A_READER = readerFor(A_DOCUMENT);
const B_READER = readerFor(B_DOCUMENT);

/**
 * TWO tab states and ONE pane, which is exactly what the shells do.
 *
 * `onChange` closes over the ACTIVE tab, the way both shells' writers do, so a patch lands on the
 * tab that produced it. The document is served from the tab's own state so that a re-read that
 * lands for one tab cannot be read by the other.
 */
function TwoSourceTabs(props: {
  readonly active: "a" | "b";
  readonly applier: ObjectSourceApplier;
  readonly onApplied?: () => void;
  readonly onPatch?: (tab: "a" | "b", patch: ObjectSourcePatch) => void;
}) {
  const [tabs, setTabs] = React.useState<Record<"a" | "b", ObjectSourcePatch>>({ a: {}, b: {} });
  const active = props.active;
  const record = props.onPatch;
  // `active` is the whole point of this callback's identity: it names the tab that asked.
  const onChange = React.useCallback(
    (patch: ObjectSourcePatch) => {
      record?.(active, patch);
      setTabs((previous) => ({ ...previous, [active]: { ...previous[active], ...patch } }));
    },
    [active, record],
  );
  const state = tabs[active];
  const onA = active === "a";
  return (
    <ObjectSourceView
      connection={pgConnection}
      path={onA ? [...A_PATH] : [...B_PATH]}
      kind="function"
      kindLabel="Function"
      displayName={onA ? "app.fa(integer)" : "app.fb(integer)"}
      document={state.document ?? (onA ? A_DOCUMENT : B_DOCUMENT)}
      activePartId={state.activePartId}
      editingPartId={state.editingPartId}
      dirty={state.dirty}
      refreshToken={0}
      readAtToken={0}
      reader={onA ? A_READER : B_READER}
      onApply={props.applier}
      onApplied={props.onApplied}
      onChange={onChange}
    />
  );
}

describe("ObjectSourceView across two Source tabs", () => {
  test("an edit open in a SECOND tab does not become the first tab's buffer, or the text it previews", async () => {
    /*
     * ITEM C1, reproduced. Edit tab A, edit tab B, come back to A. A's tab still carries
     * `editingPartId: "definition"`, so the pane is writable; `partId` is `"definition"` for both,
     * because it is `"definition"` for every kind in the day-one editable set; and the session and
     * the buffer are the ones tab B left behind. Before the fix, `editorValue` matched on the part
     * id alone, so tab A drew tab B's text, and `Preview changes` sent tab B's text to tab A's
     * address, which is the one thing ruling 1a exists to make impossible.
     */
    const { applier, build } = applierDouble();
    const { rerender } = render(<TwoSourceTabs active="a" applier={applier} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);

    rerender(<TwoSourceTabs active="b" applier={applier} />);
    await enterEditMode();
    await type(`${B_TEXT} -- edited on B`);

    rerender(<TwoSourceTabs active="a" applier={applier} />);
    await waitFor(() => expect(editor().readOnly).toBe(false));

    expect(editor().value).toBe(A_TEXT);
    await click("object-source-preview");
    const call = build.mock.calls[0] as unknown[];
    expect((call[1] as { path: string[]; text: string }).path).toEqual([...A_PATH]);
    expect((call[1] as { path: string[]; text: string }).text).toBe(A_TEXT);
  });

  test("the unsaved mark for a second tab is announced, and is not swallowed by the first tab's flag", async () => {
    /*
     * THE SAME CLAIM ASKED OF THE FLIP DETECTOR, AND IT DID NOT REPRODUCE. Recorded as a control
     * rather than dropped, because the reasoning that says it should have is sound and the reason
     * it does not is worth pinning.
     *
     * `dirtyRef` really is one boolean for the whole pane and really does outlive a tab switch, so
     * arriving on tab B with tab A's `true` in it should swallow B's first flip. It does not,
     * because entering edit mode CALLS the detector: `startEditing` seeds the buffer from the
     * engine's text and `noteDirty` therefore flips the ref back to false before the reader types.
     * The detector is against the text in hand rather than against remembered state, so it is
     * self-correcting on every path that reaches it. This test goes red if that stops being true.
     */
    const { applier } = applierDouble();
    const marks: { readonly tab: string; readonly dirty: boolean | undefined }[] = [];
    const onPatch = (tab: "a" | "b", patch: ObjectSourcePatch) => {
      if (Object.hasOwn(patch, "dirty")) marks.push({ tab, dirty: patch.dirty });
    };
    const { rerender } = render(<TwoSourceTabs active="a" applier={applier} onPatch={onPatch} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);

    rerender(<TwoSourceTabs active="b" applier={applier} onPatch={onPatch} />);
    await enterEditMode();
    await type(`${B_TEXT} -- edited on B`);

    expect(marks).toContainEqual({ tab: "a", dirty: true });
    expect(marks).toContainEqual({ tab: "b", dirty: true });
  });

  test("coming back to the first tab OFFERS the edit it left behind, rather than hiding it", async () => {
    /*
     * The other half of binding the session to the address, and the reason the fix is not just a
     * refusal. Once tab A's session no longer counts as A's open edit, A draws the engine's own
     * text in a writable editor, and the reader's work is in the draft store where the debounce
     * put it. If the restore banner stayed suppressed by `writable` alone, that work would be on
     * screen nowhere: not in the editor, not on the bar, and reachable only by leaving edit mode.
     * So the suppression asks whether there is an open edit FOR THIS ADDRESS, not whether the tab
     * says the reader is editing.
     */
    const { applier } = applierDouble();
    const { rerender } = render(<TwoSourceTabs active="a" applier={applier} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);

    rerender(<TwoSourceTabs active="b" applier={applier} />);
    await enterEditMode();
    // Typing on B flushes A's pending write, which is the debounce rule this pane already states.
    await type(`${B_TEXT} -- edited on B`);

    rerender(<TwoSourceTabs active="a" applier={applier} />);
    await waitFor(() => expect(screen.getByTestId("object-source-draft-restore")).toBeTruthy());
    await click("object-source-draft-restore-accept");

    await waitFor(() => expect(editor().value).toBe(`${A_TEXT} -- edited on A`));
  });

  test("a build refusal raised on one tab is not drawn over the other", async () => {
    const { applier, build } = applierDouble();
    build.mockResolvedValueOnce({ built: false, refusal: { refusal: "unsupported", sentence: "No." } } as never);
    const { rerender } = render(<TwoSourceTabs active="a" applier={applier} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());

    rerender(<TwoSourceTabs active="b" applier={applier} />);

    expect(screen.queryByTestId("object-source-edit-refused")).toBeNull();
  });

  test("a build that lands after Cancel does not open the dialog again", async () => {
    /*
     * ITEM C2, reproduced. `ApplyPreviewDialog` blocks dismissal while APPLYING and not while
     * BUILDING, so Cancel is a live control for the whole of the build round trip, and
     * `closePreview` was `setPreview(undefined)` and nothing else. The build's `.then` then set the
     * preview a second time, from a press the reader had already withdrawn.
     */
    const { applier, build } = applierDouble();
    let land: (value: unknown) => void = () => {};
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-building")).toBeTruthy());

    await click("object-source-apply-cancel");
    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
    await act(async () => {
      land(BUILT);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("a build that FAILS after Cancel draws no refusal, because the press was withdrawn", async () => {
    // The rejection arm of the same withdrawal. Before the generation counter the request error
    // landed as a warning line on the bar, about a press the reader had already taken back.
    const { applier, build } = applierDouble();
    let fail: (error: unknown) => void = () => {};
    build.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-building")).toBeTruthy());

    await click("object-source-apply-cancel");
    await act(async () => {
      fail(new Error("the network went away"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("object-source-edit-refused")).toBeNull();
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("a build cancelled and re-pressed shows the SECOND plan, whichever answer lands last", async () => {
    const { applier, build } = applierDouble();
    let landFirst: (value: unknown) => void = () => {};
    build
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            landFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => ({
        ...BUILT,
        plan: {
          ...PLAN,
          planId: "plan-2",
          unit: {
            medium: "statement",
            steps: [
              {
                text: SECOND_STEP_TEXT,
                language: "sql",
                segments: [{ from: "user", start: 0, end: SECOND_STEP_TEXT.length }],
              },
            ],
          },
        },
      }));
    render(<EditHarness applier={applier} document={withPart(READABLE)} />);
    await enterEditMode();
    await type("edited once");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-building")).toBeTruthy());
    await click("object-source-apply-cancel");
    await type("edited twice");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("diff-editor")).toBeTruthy());
    expect(screen.getByTestId("diff-editor").getAttribute("data-modified")).toContain(SECOND_STEP_TEXT);

    await act(async () => {
      landFirst(BUILT);
      await Promise.resolve();
    });

    expect(screen.getByTestId("diff-editor").getAttribute("data-modified")).toContain(SECOND_STEP_TEXT);
    expect(screen.getByTestId("diff-editor").getAttribute("data-modified")).not.toContain(STEP_TEXT);
  });

  test("a build ACCEPTED for this tab opens the dialog, which is the control for the tab-switch test", async () => {
    /*
     * THE CONTROL, and it is not optional here (#789, review fix round 2). The negative below
     * asserts that no dialog opens after a tab switch. A negative like that is worth nothing
     * unless the same answer, landing on the tab it was built for, DOES open one: the first
     * spelling of the negative landed `BUILT`, whose plan names `EDIT_PATH`, so `runBuild`
     * refused it for naming another object and the dialog was null for a reason that had nothing
     * to do with the tab switch. This test is what makes that mistake loud: it goes red the
     * moment `A_BUILT` stops being an answer tab A accepts.
     */
    const { applier, build } = applierDouble();
    build.mockResolvedValueOnce(A_BUILT as never);
    render(<TwoSourceTabs active="a" applier={applier} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);
    await click("object-source-preview");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy());
    expect(screen.queryByTestId("object-source-edit-refused")).toBeNull();
    expect(screen.getByTestId("object-source-apply-dialog").textContent).toContain("app.fa(integer)");
  });

  test("a build that lands after the reader moved to another tab does not open over that tab", async () => {
    /*
     * DEFENCE IN DEPTH, and the population is named honestly rather than implied (#789, review
     * fix rounds 1 and 2). Unlike the refusal test above, this one is NOT something a reader can
     * drive today: while the build is in flight the modal is open, a mouse press on the strip hits
     * the overlay and closes the dialog, focus is trapped, and the document-level listeners that
     * move the active tab, the new-tab shortcut and the command palette, unmount this pane instead
     * of re-addressing it. The rerender below moves the address at a moment no shipped shell moves
     * it.
     *
     * That unmount is D82, and it is a BUILD window here rather than an apply window: nothing has
     * been sent, so nothing is lost by it. The apply window is where it cost the reader an answer,
     * and the standalone shell now refuses both gestures there. The embedded shell does not yet.
     *
     * What it now certifies, which the round-1 spelling did NOT: the answer landed is `A_BUILT`,
     * addressed to tab A, so the resolve arm's happy path runs and the only thing left holding the
     * dialog shut is `previewHere`. MEASURED both ways: with `previewHere` unbound to the address
     * this test fails, and with `BUILT` landed instead of `A_BUILT` it passes with the binding
     * removed, which is what it used to do.
     */
    const { applier, build } = applierDouble();
    let land: (value: unknown) => void = () => {};
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    const { rerender } = render(<TwoSourceTabs active="a" applier={applier} />);
    await enterEditMode();
    await type(`${A_TEXT} -- edited on A`);
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-building")).toBeTruthy());

    rerender(<TwoSourceTabs active="b" applier={applier} />);
    await act(async () => {
      land(A_BUILT);
      await Promise.resolve();
    });

    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
  });

  test("the dialog names the part its PLAN was built for, after a re-read moved the active part", async () => {
    /*
     * The population the marker guard was already built for, asked of the dialog's own words. The
     * read effect lands with no cleanup and no drop, deliberately, so a re-read can replace the
     * document while the dialog is open; when the new parts do not carry the remembered id,
     * `activePart` falls back to the first part and `part.label` becomes the other part's label.
     * The dialog then said `Grants` over a plan built for `Definition`.
     */
    const { applier } = applierDouble();
    function Moving(): React.JSX.Element {
      const [document, setDocument] = React.useState(withPart(READABLE, SECOND_PART));
      return (
        <>
          <button
            type="button"
            data-testid="land-a-reread"
            onClick={() => {
              setDocument(withPart(SECOND_PART));
            }}
          >
            re-read
          </button>
          <EditHarness applier={applier} document={document} />
        </>
      );
    }
    render(<Moving />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("land-a-reread");

    expect(screen.getByTestId("object-source-apply-dialog").textContent).toContain("Definition");
    expect(screen.getByTestId("object-source-apply-dialog").textContent).not.toContain("Grants");
  });

  test("the dialog names the OBJECT its plan was built for, and a caller cannot rename it under the plan", async () => {
    /*
     * DEFENCE IN DEPTH, and said so rather than dressed as a live defect. Both shipped shells
     * derive `displayName` from `sourceTab.path`, which is inside the address the dialog is bound
     * to, so neither can move it under an open plan today. It is the ONE fact the dialog printed
     * that came off the render instead of the sealed session, and it is the fact an embedded host
     * supplies freely, so it is pinned by the same rule as the address, the part id and the part
     * label: what the reader approves is what the plan was built for.
     */
    const { applier } = applierDouble();
    function Renaming(): React.JSX.Element {
      const [name, setName] = React.useState("app.f(integer)");
      return (
        <>
          <button
            type="button"
            data-testid="rename-the-pane"
            onClick={() => {
              setName("app.other(integer)");
            }}
          >
            rename
          </button>
          <EditHarness applier={applier} displayName={name} document={withPart(READABLE)} />
        </>
      );
    }
    render(<Renaming />);
    await enterEditMode();
    await type("edited");
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    await click("rename-the-pane");

    expect(screen.getByTestId("object-source-apply-dialog").textContent).toContain("app.f(integer)");
    expect(screen.getByTestId("object-source-apply-dialog").textContent).not.toContain("app.other(integer)");
  });
});
