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
import type { ObjectSourcePatch, ObjectSourceReader } from "@/components/object-source";
import { ObjectSourceView } from "@/components/object-source/ObjectSourceView";
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

    expect(patches[0]?.activePartId).toBe("spec");
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

  test("draws a tablist with one tab per part for a two-part document, wired with aria-controls", async () => {
    // jsx-a11y categories.correctness is "error" in .oxlintrc.json:5 and this directory is not
    // in the one exempted path, so the tabs pattern is complete here even though the studio tab
    // bar is only half of it.
    render(<Harness reader={readerFor(twoParts)} />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Package specification", "Package body"]);

    const panel = screen.getByRole("tabpanel");
    let wired = 0;
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      // An IDREF may not carry a space: a part label or a provider-local id containing one
      // would split the reference in two and both halves would resolve to nothing.
      expect(controls?.includes(" ")).toBe(false);
      if (tab.getAttribute("aria-selected") === "true") {
        expect(panel.getAttribute("id")).toBe(controls);
        expect(panel.getAttribute("aria-labelledby")).toBe(tab.getAttribute("id"));
      }
      wired += 1;
    }
    // Non-vacuity: two tabs were walked, not zero.
    expect(wired).toBe(2);
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
