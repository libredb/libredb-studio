import "../setup-dom";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CONNECTION_IMPORT_ACTION_ID, ConnectionImportPanel } from "@/components/ConnectionImportPanel";
import type {
  ConnectionImportDeclaration,
  ConnectionImporter,
  ConnectionImportResult,
  ImportedContext,
} from "@/lib/connection-import";

/**
 * The connection dialog's import panel with a stub importer: when the parser loads, what is kept of the pasted text,
 * and that nothing an importer throws reaches the page or the console.
 */

const MARKER = "panel-marker-91c2";
const STAGING: ImportedContext = { name: "staging", fields: { host: "db.example", password: MARKER }, notices: [] };
const LOCAL: ImportedContext = { name: "local", fields: { host: "127.0.0.1" }, notices: [] };

/** Every console method a careless importer or panel could print through, recorded instead of printed. */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
const printed: unknown[][] = [];
const originals = new Map<string, (...args: unknown[]) => void>();
beforeEach(() => {
  for (const method of CONSOLE_METHODS) {
    originals.set(method, console[method]);
    console[method] = (...args: unknown[]) => {
      printed.push(args);
    };
  }
});
afterEach(() => {
  cleanup();
  for (const method of CONSOLE_METHODS) console[method] = originals.get(method) as (...args: unknown[]) => void;
  printed.length = 0;
});

function declaration(importer: ConnectionImporter, load?: () => Promise<ConnectionImporter>) {
  const loads = mock(load ?? (async () => importer));
  const value: ConnectionImportDeclaration = { label: "Import from a file", load: loads };
  return { value, loads };
}

function returning(result: ConnectionImportResult) {
  return mock((_text: string) => result);
}

async function openPanel() {
  await act(async () => {
    fireEvent.click(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID));
  });
}

function paste(text: string) {
  fireEvent.change(screen.getByTestId("connection-import-text"), { target: { value: text } });
}

describe("ConnectionImportPanel", () => {
  test("shows only the declared action until it is opened, and loads nothing before", () => {
    const { value, loads } = declaration(returning({ contexts: [], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    expect(screen.getByTestId(CONNECTION_IMPORT_ACTION_ID).textContent).toBe("Import from a file");
    expect(screen.queryByTestId("connection-import-text")).toBeNull();
    expect(loads).not.toHaveBeenCalled();
  });

  test("loads the parser when the import opens, once however often it opens", async () => {
    const { value, loads } = declaration(returning({ contexts: [], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    await openPanel();
    await openPanel();
    expect(loads).toHaveBeenCalledTimes(1);
  });

  test("the paste box asks the browser for no spelling check, autocomplete or correction", async () => {
    const { value } = declaration(returning({ contexts: [], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    const box = screen.getByTestId("connection-import-text");
    expect([
      box.getAttribute("spellcheck"),
      box.getAttribute("autocomplete"),
      box.getAttribute("autocorrect"),
      box.getAttribute("autocapitalize"),
    ]).toEqual(["false", "off", "off", "off"]);
  });

  test("Read waits for a loaded parser and for text", async () => {
    let finish: (importer: ConnectionImporter) => void = () => {};
    const { value } = declaration(
      returning({ contexts: [], refusals: [] }),
      () => new Promise<ConnectionImporter>((resolve) => (finish = resolve)),
    );
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste("text");
    expect((screen.getByTestId("connection-import-read") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(returning({ contexts: [], refusals: [] })));
    expect((screen.getByTestId("connection-import-read") as HTMLButtonElement).disabled).toBe(false);
    paste("   ");
    expect((screen.getByTestId("connection-import-read") as HTMLButtonElement).disabled).toBe(true);
  });

  test("Read hands the text to the parser, empties the box and lists each entry and refusal", async () => {
    const importer = returning({ contexts: [STAGING, LOCAL], refusals: ["One entry was not read."] });
    const { value } = declaration(importer);
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste(`pasted ${MARKER}`);
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(importer.mock.calls).toEqual([[`pasted ${MARKER}`]]);
    expect((screen.getByTestId("connection-import-text") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getAllByTestId("connection-import-context").map((button) => button.textContent)).toEqual([
      "Fill the form from staging",
      "Fill the form from local",
    ]);
    expect(screen.getByTestId("connection-import-refusals").textContent).toBe("One entry was not read.");
    expect(document.body.textContent).not.toContain(MARKER);
  });

  test("choosing an entry fills the form from it and closes the import, keeping nothing", async () => {
    const onApply = mock((_context: ImportedContext) => true);
    const { value } = declaration(returning({ contexts: [STAGING, LOCAL], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={onApply} />);
    await openPanel();
    paste("text");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    fireEvent.click(screen.getAllByTestId("connection-import-context")[1]);
    expect(onApply.mock.calls).toEqual([[LOCAL]]);
    expect(screen.queryByTestId("connection-import-text")).toBeNull();
    await openPanel();
    expect(screen.queryByTestId("connection-import-context")).toBeNull();
  });

  test("an entry the form refuses keeps the import open with its entries, so another can be chosen", async () => {
    const onApply = mock((_context: ImportedContext) => false);
    const { value } = declaration(returning({ contexts: [STAGING, LOCAL], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={onApply} />);
    await openPanel();
    paste("text");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    fireEvent.click(screen.getAllByTestId("connection-import-context")[0]);
    expect(onApply.mock.calls).toEqual([[STAGING]]);
    expect(screen.getAllByTestId("connection-import-context")).toHaveLength(2);
  });

  test("closing the import drops the entries it read", async () => {
    const { value } = declaration(returning({ contexts: [STAGING], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste("text");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    await openPanel();
    await openPanel();
    expect(screen.queryByTestId("connection-import-context")).toBeNull();
  });

  test("a text with no entry and no refusal says so", async () => {
    const { value } = declaration(returning({ contexts: [], refusals: [] }));
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste("text");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(screen.getByTestId("connection-import-empty").textContent).toBe("No entry was found in the text.");
  });

  test("a parser that throws shows a fixed sentence, and its error reaches neither the page nor the console", async () => {
    const { value } = declaration(() => {
      throw new Error(`could not parse ${MARKER}`);
    });
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste(`token: ${MARKER}`);
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(screen.getByTestId("connection-import-error").textContent).toBe(
      "The import could not read the text, so nothing was filled.",
    );
    expect(document.body.textContent).not.toContain(MARKER);
    expect(JSON.stringify(printed.map((args) => args.map(String)))).not.toContain(MARKER);
  });

  test.each([
    ["no refusals", { contexts: [] }],
    ["no contexts", { refusals: [] }],
    ["refusals that are not sentences", { contexts: [STAGING], refusals: [1] }],
    ["contexts that are not a list", { contexts: MARKER, refusals: [] }],
    ["nothing at all", undefined],
  ])("a parser that returns a result with %s shows a fixed sentence and lists nothing", async (_label, returned) => {
    const { value } = declaration(() => returned as unknown as ConnectionImportResult);
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste("text");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(screen.getByTestId("connection-import-error").textContent).toBe(
      "The import could not read the text, so nothing was filled.",
    );
    expect(screen.queryByTestId("connection-import-context")).toBeNull();
    expect(screen.queryByTestId("connection-import-refusals")).toBeNull();
    expect(document.body.textContent).not.toContain(MARKER);
  });

  test("a read that succeeds after a failed one takes the sentence away", async () => {
    let fail = true;
    const { value } = declaration((text) => {
      if (fail) throw new Error(text);
      return { contexts: [STAGING], refusals: [] };
    });
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    paste("first");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    fail = false;
    paste("second");
    fireEvent.click(screen.getByTestId("connection-import-read"));
    expect(screen.queryByTestId("connection-import-error")).toBeNull();
    expect(screen.getAllByTestId("connection-import-context")).toHaveLength(1);
  });

  test("a parser that fails to load says so, and the next open loads it again", async () => {
    let attempts = 0;
    const importer = returning({ contexts: [], refusals: [] });
    const { value, loads } = declaration(importer, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error(`chunk ${MARKER}`);
      return importer;
    });
    render(<ConnectionImportPanel declaration={value} onApply={() => true} />);
    await openPanel();
    expect(screen.getByTestId("connection-import-error").textContent).toBe(
      "The import could not be loaded. Close it and open it again to retry.",
    );
    expect((screen.getByTestId("connection-import-read") as HTMLButtonElement).disabled).toBe(true);
    await openPanel();
    await openPanel();
    expect(loads).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("connection-import-error")).toBeNull();
    expect(document.body.textContent).not.toContain(MARKER);
  });
});
