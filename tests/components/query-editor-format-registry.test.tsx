/**
 * `QueryEditor` formats through the dialect registry and through nothing else (vector-family spec 3.8): whether
 * a tab has a Format button, and what Format writes, are its `DIALECT_EDITORS` formatter.
 *
 * The registry is replaced by a stand-in that gives PromQL a formatter and takes SQL's away, which no real record
 * does, so an editor that still branched on its language could not draw these buttons. A module mock is
 * process-wide, so the real formatters are pinned in `tests/unit/editor/dialect-editors.test.ts` and the real
 * toolbar in `QueryEditor.test.tsx`. The Monaco double here is the smallest that mounts the editor.
 */
import "../setup-dom";
import "../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import React from "react";

/** Each text the stand-in formatter was handed, in order. */
const formatted: string[] = [];

/** The last value the editor set on each Monaco context key, by key name. */
const contextKeys = new Map<string, unknown>();

mock.module("@/lib/editor/dialect-editors", () => ({
  DIALECT_EDITORS: {},
  formatterForLanguage: (language: string) =>
    language === "promql"
      ? (text: string) => {
          formatted.push(text);
          return text.toUpperCase();
        }
      : undefined,
  // The stand-in registry carries no console language, so registering its consoles before mount does nothing.
  registerDialectConsoles: () => {},
}));

mock.module("@monaco-editor/react", () => ({
  default: function MockEditor(props: {
    defaultValue?: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) {
    const { defaultValue, onChange, onMount } = props;
    const valueRef = React.useRef(defaultValue ?? "");
    const [text, setText] = React.useState(defaultValue ?? "");
    React.useEffect(() => {
      const editor = {
        getValue: () => valueRef.current,
        setValue: (next: string) => {
          valueRef.current = next;
          setText(next);
          onChange?.(next);
        },
        getSelection: () => null,
        getModel: () => null,
        getPosition: () => null,
        onDidBlurEditorText: () => undefined,
        onDidChangeCursorSelection: () => undefined,
        addCommand: () => undefined,
        addAction: () => undefined,
        createContextKey: (name: string, initial: unknown) => {
          contextKeys.set(name, initial);
          return {
            set: (value: unknown) => contextKeys.set(name, value),
            get: () => contextKeys.get(name),
            reset: () => contextKeys.delete(name),
          };
        },
        updateOptions: () => undefined,
        deltaDecorations: () => [],
        focus: () => undefined,
      };
      const monaco = { KeyMod: { CtrlCmd: 1, Alt: 2, Shift: 4 }, KeyCode: { Enter: 3, KeyF: 36 } };
      onMount?.(editor, monaco);
      // Mounted once, as @monaco-editor/react calls the first render's onMount once.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement("textarea", { "data-testid": "mock-monaco-editor", value: text, readOnly: true });
  },
  loader: { init: mock(() => Promise.resolve()), config: mock(() => {}) },
}));

mock.module("@/hooks/use-monaco-instance", () => ({ useMonacoInstance: () => null }));

const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { QueryEditor } = await import("@/components/QueryEditor");

afterEach(() => {
  cleanup();
  formatted.length = 0;
  contextKeys.clear();
});

describe("QueryEditor's Format control follows the tab language's registry formatter", () => {
  test("a language whose record has a formatter draws Format, and Format writes the formatter's text", () => {
    const onChange = mock(() => {});
    const { getByTestId, queryByText } = render(
      React.createElement(QueryEditor, { value: "up == 0", language: "promql", onChange }),
    );
    const button = queryByText("Format");
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(formatted).toEqual(["up == 0"]);
    expect((getByTestId("mock-monaco-editor") as HTMLTextAreaElement).value).toBe("UP == 0");
    expect(onChange).toHaveBeenCalledWith("UP == 0");
  });

  test("a language whose record has no formatter draws no Format control", () => {
    const { queryByText } = render(React.createElement(QueryEditor, { value: "SELECT 1", language: "sql" }));
    expect(queryByText("Format")).toBeNull();
    expect(formatted).toEqual([]);
  });

  test("an InfluxQL tab, whose record has no formatter, draws no Format control (InfluxDB spec 6.7, I12)", () => {
    const { queryByText } = render(
      React.createElement(QueryEditor, { value: "SELECT * FROM cpu WHERE host =~ /a\\/b/", language: "influxql" }),
    );
    expect(queryByText("Format")).toBeNull();
    expect(formatted).toEqual([]);
  });

  test("an SQL tab whose record has no formatter offers no Format SQL context-menu entry", () => {
    // The entry's label stays SQL-only, but it is offered only where the registry gives SQL a formatter, so the
    // menu never offers a Format that does nothing.
    render(React.createElement(QueryEditor, { value: "SELECT 1", language: "sql" }));
    expect(contextKeys.get("libredbCanFormatSql")).toBe(false);
  });
});
