import "../setup-dom";

import { describe, test, expect, afterEach } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useReturnFocus } from "@/hooks/use-return-focus";

afterEach(cleanup);

// A dialog opened from app state, with no AlertDialogTrigger, the way the three
// confirmation dialogs in #1198 are.
function Harness() {
  const [open, setOpen] = React.useState(false);
  const returnFocus = useReturnFocus();
  return (
    <>
      <button onClick={() => setOpen(true)}>Delete connection</button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent {...returnFocus}>
          <AlertDialogTitle>Delete connection?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

describe("useReturnFocus", () => {
  // Radix hands focus back in a setTimeout, hence waitFor on the last assertion.
  test.each([
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
  ])("after %s, focus is back on the element that had it when the dialog opened", async (_label, dismiss) => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete connection" });
    opener.focus();
    fireEvent.click(opener);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeNull());
    dismiss();

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("leaves Radix to move focus to Cancel when the dialog opens", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Delete connection" });
    opener.focus();
    fireEvent.click(opener);

    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
  });
});
