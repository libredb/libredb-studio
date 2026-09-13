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

mock.module("@monaco-editor/react", () => ({
  default: function MockEditor(props: {
    value?: string;
    language?: string;
    path?: string;
    theme?: string;
    options?: Record<string, unknown>;
    beforeMount?: (monaco: unknown) => void;
  }) {
    const ran = React.useRef(false);
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
    });
    return (
      <textarea
        data-testid="source-editor"
        data-language={props.language}
        data-path={props.path}
        data-theme={props.theme}
        readOnly={props.options?.readOnly === true}
        value={props.value ?? ""}
        onChange={() => {}}
      />
    );
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
  ObjectSourceView,
  type ObjectSourcePatch,
  type ObjectSourceReader,
} from "@/components/object-source";
import { pathKey } from "@/lib/db/object-path";
import type { ObjectSourceDocument } from "@/lib/db/types";
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
    const answers: Record<string, ObjectSourceDocument> = { one: oneReadablePart, two: twoParts };
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
