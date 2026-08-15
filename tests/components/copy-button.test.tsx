import "../setup-dom";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CopyButton } from "@/components/copy-button";

/**
 * The copy control (#389).
 *
 * What these tests pin is one property, and it is the reason this component exists
 * rather than a `navigator.clipboard.writeText` call at each site:
 *
 *  - **The async clipboard is a secure-context API.** It is absent over plain HTTP on
 *    any host but loopback, and this product ships that way on several distribution
 *    channels — the same trap `crypto.randomUUID` set in `use-query-execution.ts`. A
 *    button that reads "Copy" and does nothing on those channels is worse than no
 *    button, so the legacy command is the fallback and a failure of BOTH is said out
 *    loud rather than swallowed.
 */

const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(globalThis.document, "execCommand");

/** Installs a clipboard object, or removes it entirely to model an insecure context. */
function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { value: clipboard, configurable: true });
}

function setExecCommand(execCommand: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(globalThis.document, "execCommand", { value: execCommand, configurable: true });
}

afterEach(() => {
  cleanup();
  if (originalClipboard === undefined) setClipboard(undefined);
  else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
  if (originalExecCommand === undefined) setExecCommand(undefined);
  else Object.defineProperty(globalThis.document, "execCommand", originalExecCommand);
});

describe("CopyButton", () => {
  test("writes the text with the async clipboard when the browser has one", async () => {
    const writeText = mock(() => Promise.resolve());
    setClipboard({ writeText });

    const { getByTestId } = render(<CopyButton text="SELECT 1" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copied"));
    expect(writeText).toHaveBeenCalledWith("SELECT 1");
  });

  test("falls back to the legacy command when there is no clipboard object at all", async () => {
    setClipboard(undefined);
    const execCommand = mock(() => true);
    setExecCommand(execCommand);

    const { getByTestId } = render(<CopyButton text="SELECT 2" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copied"));
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  test("falls back to the legacy command when the clipboard object rejects", async () => {
    setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
    const execCommand = mock(() => true);
    setExecCommand(execCommand);

    const { getByTestId } = render(<CopyButton text="SELECT 3" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copied"));
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  test("leaves nothing behind in the document after the fallback", async () => {
    setClipboard(undefined);
    setExecCommand(() => true);

    const { getByTestId } = render(<CopyButton text="SELECT 4" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copied"));
    expect(globalThis.document.querySelectorAll("textarea").length).toBe(0);
  });

  test("says the copy failed when the legacy command reports it did nothing", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    const { getByTestId } = render(<CopyButton text="SELECT 5" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copy failed"));
  });

  test("says the copy failed when the legacy command is absent too", async () => {
    setClipboard(undefined);
    setExecCommand(undefined);

    const { getByTestId } = render(<CopyButton text="SELECT 6" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copy failed"));
  });

  test("tells a user whose copy failed what to do instead, in the accessible name", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    const { getByTestId } = render(<CopyButton text="SELECT 7" testId="copy" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copy failed"));
    expect(getByTestId("copy").getAttribute("aria-label")).toContain("select");
  });

  test("tells a screen reader the copy happened, in a name that contains the visible label", async () => {
    // The accessible name overrides the button's text, so one left at the resting label
    // would report "Copy all" over a button reading "Copied" — no outcome for a screen
    // reader, and a WCAG 2.5.3 failure for voice control, which names what it sees.
    setClipboard({ writeText: () => Promise.resolve() });

    const { getByTestId } = render(<CopyButton text="SELECT 9" testId="copy" label="Copy all" />);
    expect(getByTestId("copy").getAttribute("aria-label")).toBe("Copy all");

    fireEvent.click(getByTestId("copy"));
    await waitFor(() => expect(getByTestId("copy").getAttribute("aria-label")).toBe("Copied"));
    expect(getByTestId("copy").textContent).toContain("Copied");
  });

  test("returns to its resting label, so a second copy reads as a second copy", async () => {
    setClipboard({ writeText: () => Promise.resolve() });

    const { getByTestId } = render(<CopyButton text="SELECT 8" testId="copy" label="Copy plan" />);
    fireEvent.click(getByTestId("copy"));

    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copied"));
    await waitFor(() => expect(getByTestId("copy").textContent).toContain("Copy plan"), { timeout: 4_000 });
  });
});
