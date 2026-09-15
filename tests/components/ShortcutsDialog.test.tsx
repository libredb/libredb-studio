import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import ReactDOMServer from "react-dom/server";

import { ShortcutsDialog, type ShortcutsDialogRef } from "@/components/ShortcutsDialog";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";

afterEach(() => {
  cleanup();
});

describe("ShortcutsDialog", () => {
  test("renders nothing during server rendering", () => {
    // Both useSyncExternalStore calls take their SERVER snapshot during SSR (React never
    // runs the effects that would let either one see real module state), so this renders
    // null regardless of what any client-side instance has done to `sharedOpen` elsewhere -
    // there is no "started open" case to prove wrong here, only that this doesn't throw.
    expect(ReactDOMServer.renderToString(React.createElement(ShortcutsDialog))).toBe("");
  });

  test("is closed on mount", () => {
    const { queryByText } = render(<ShortcutsDialog />);
    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("pressing ? opens the dialog", () => {
    const { getByText } = render(<ShortcutsDialog />);

    fireEvent.keyDown(document, { key: "?" });

    expect(getByText("Keyboard Shortcuts")).not.toBeNull();
  });

  test("pressing ? while typing in an input does not open the dialog", () => {
    const { queryByText } = render(
      <>
        <input aria-label="search" />
        <ShortcutsDialog />
      </>,
    );

    const input = document.querySelector('input[aria-label="search"]')!;
    fireEvent.keyDown(input, { key: "?" });

    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("pressing ? while typing in a textarea does not open the dialog", () => {
    const { queryByText } = render(
      <>
        <textarea aria-label="notes" />
        <ShortcutsDialog />
      </>,
    );

    const textarea = document.querySelector('textarea[aria-label="notes"]')!;
    fireEvent.keyDown(textarea, { key: "?" });

    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("pressing ? in a contentEditable element does not open the dialog", () => {
    const { queryByText } = render(
      <>
        <div contentEditable aria-label="editable" />
        <ShortcutsDialog />
      </>,
    );

    const editable = document.querySelector('[aria-label="editable"]')!;
    fireEvent.keyDown(editable, { key: "?" });

    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("pressing ? inside Monaco's edit-context element does not open the dialog", () => {
    // Monaco 0.56 focuses a div.native-edit-context inside .monaco-editor — neither an
    // <input>/<textarea> nor contentEditable, which is exactly why this needs its own check
    // rather than being caught by the three above.
    const { queryByText, container } = render(
      <>
        <div className="monaco-editor">
          <div className="native-edit-context" aria-label="sql-input" />
        </div>
        <ShortcutsDialog />
      </>,
    );

    const editContext = container.querySelector('[aria-label="sql-input"]')!;
    fireEvent.keyDown(editContext, { key: "?" });

    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("a keydown that is not ? is ignored", () => {
    const { queryByText } = render(<ShortcutsDialog />);

    fireEvent.keyDown(document, { key: "Enter" });

    expect(queryByText("Keyboard Shortcuts")).toBeNull();
  });

  test("the imperative ref opens the dialog", () => {
    const ref = React.createRef<ShortcutsDialogRef>();
    const { getByText } = render(<ShortcutsDialog ref={ref} />);

    act(() => ref.current?.open());

    expect(getByText("Keyboard Shortcuts")).not.toBeNull();
  });

  test("lists every group heading and at least one shortcut per group", () => {
    const { getByText } = render(<ShortcutsDialog />);

    fireEvent.keyDown(document, { key: "?" });

    for (const group of SHORTCUT_GROUPS) {
      expect(getByText(group.heading)).not.toBeNull();
      expect(getByText(group.shortcuts[0].description)).not.toBeNull();
      expect(getByText(group.shortcuts[0].keys)).not.toBeNull();
    }
  });

  test("removes its keydown listener on unmount", () => {
    const originalRemove = document.removeEventListener.bind(document);
    let removed = false;
    document.removeEventListener = ((...args: Parameters<typeof document.removeEventListener>) => {
      if (args[0] === "keydown") removed = true;
      return originalRemove(...args);
    }) as typeof document.removeEventListener;

    const { unmount } = render(<ShortcutsDialog />);
    unmount();

    expect(removed).toBe(true);
    document.removeEventListener = originalRemove;
  });

  describe("multiple mounted instances (#746 review)", () => {
    // Reproduces Studio.tsx (mounted unconditionally) plus DataProfiler.tsx (mounted only
    // while the profiler is open) both being in the tree at once in the standalone shell.

    test("only the first-mounted instance renders the dialog content", () => {
      const { queryAllByText } = render(
        <>
          <ShortcutsDialog />
          <ShortcutsDialog />
        </>,
      );

      fireEvent.keyDown(document, { key: "?" });

      // Two instances, one Dialog: a second copy of the content would fail this.
      expect(queryAllByText("Keyboard Shortcuts")).toHaveLength(1);
    });

    test("? from either instance's listener opens the one shared dialog", () => {
      let second!: HTMLDivElement;
      const { queryAllByText } = render(
        <>
          <ShortcutsDialog />
          <div
            ref={(el) => {
              second = el as HTMLDivElement;
            }}
          >
            <ShortcutsDialog />
          </div>
        </>,
      );

      // Fired on the second instance's own subtree - still document-level, but proves
      // it isn't the first instance's DOM position that matters, its own listener is live.
      fireEvent.keyDown(second, { key: "?" });

      expect(queryAllByText("Keyboard Shortcuts")).toHaveLength(1);
    });

    test("unmounting the non-rendering instance leaves the dialog open", () => {
      function Harness({ mountSecond }: { mountSecond: boolean }): React.JSX.Element {
        return (
          <>
            <ShortcutsDialog />
            {mountSecond && <ShortcutsDialog />}
          </>
        );
      }

      const { getByText, queryByText, rerender } = render(<Harness mountSecond />);
      fireEvent.keyDown(document, { key: "?" });
      expect(getByText("Keyboard Shortcuts")).not.toBeNull();

      rerender(<Harness mountSecond={false} />);

      expect(queryByText("Keyboard Shortcuts")).not.toBeNull();
    });

    test("unmounting the last instance closes the dialog for the next mount", () => {
      const first = render(<ShortcutsDialog />);
      fireEvent.keyDown(document, { key: "?" });
      expect(first.getByText("Keyboard Shortcuts")).not.toBeNull();

      first.unmount();

      const second = render(<ShortcutsDialog />);
      expect(second.queryByText("Keyboard Shortcuts")).toBeNull();
    });
  });
});
