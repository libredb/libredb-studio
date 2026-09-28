import "../../../setup-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TypedConfirmDialog, typedValueMatches } from "@/components/admin/accounts/typed-confirm-dialog";

const EMAIL = "Priya@Example.com";

function renderDialog(overrides: Partial<React.ComponentProps<typeof TypedConfirmDialog>> = {}) {
  const onConfirm = mock(async (): Promise<string | null> => null);
  const onOpenChange = mock<(open: boolean) => void>(() => {});
  const view = render(
    <TypedConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this account?"
      description="Their saved connections are removed."
      expected={EMAIL}
      confirmLabel="Delete account"
      destructive
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  const input = () => view.getByLabelText(`Type ${EMAIL} to confirm`) as HTMLInputElement;
  const button = () => view.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
  return { view, input, button, onConfirm, onOpenChange };
}

describe("typedValueMatches", () => {
  test("ignores surrounding whitespace and case, and nothing else", () => {
    expect(typedValueMatches("priya@example.com", EMAIL)).toBe(true);
    expect(typedValueMatches("  PRIYA@EXAMPLE.COM \n", EMAIL)).toBe(true);
    expect(typedValueMatches("priya@example.co", EMAIL)).toBe(false);
    expect(typedValueMatches("priya @example.com", EMAIL)).toBe(false);
    expect(typedValueMatches("", EMAIL)).toBe(false);
  });
});

describe("TypedConfirmDialog", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows the title, the description and the value to type", () => {
    const { view, input } = renderDialog();
    const dialog = view.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete this account?");
    expect(dialog.textContent).toContain("Their saved connections are removed.");
    expect(input().value).toBe("");
  });

  test("keeps the button disabled until the typed value matches", () => {
    const { input, button } = renderDialog();
    expect(button().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "priya@example.co" } });
    expect(button().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "someone@example.com" } });
    expect(button().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "  PRIYA@example.COM  " } });
    expect(button().disabled).toBe(false);
  });

  test("pressing Enter on a wrong value confirms nothing", () => {
    const { view, input, onConfirm } = renderDialog();
    fireEvent.change(input(), { target: { value: "wrong" } });
    fireEvent.submit(view.getByRole("alertdialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("confirms once and closes when the change is made", async () => {
    const { input, button, onConfirm, onOpenChange } = renderDialog();
    fireEvent.change(input(), { target: { value: EMAIL.toLowerCase() } });
    fireEvent.click(button());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("shows a refusal inside the dialog and stays open", async () => {
    const { view, input, button, onOpenChange } = renderDialog({
      onConfirm: async () => "The last enabled admin cannot be removed.",
    });
    fireEvent.change(input(), { target: { value: EMAIL } });
    fireEvent.click(button());
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("The last enabled admin cannot be removed."));
    expect(view.getByRole("alertdialog").contains(view.getByRole("alert"))).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  test("is busy while the change is in flight", async () => {
    let finish: (value: string | null) => void = () => {};
    const { view, input, button } = renderDialog({
      onConfirm: () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    });
    fireEvent.change(input(), { target: { value: EMAIL } });
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    // The spinner is decoration: the button keeps its name while it waits.
    expect(button().querySelector(".animate-spin")).not.toBeNull();
    finish("refused");
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("refused"));
  });

  test("Cancel closes without confirming", async () => {
    const { view, input, onConfirm, onOpenChange } = renderDialog();
    fireEvent.change(input(), { target: { value: EMAIL } });
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a change that is not destructive gets the primary button", () => {
    const { view } = renderDialog({ destructive: false, confirmLabel: "Make admin" });
    expect(view.getByRole("button", { name: "Make admin" }).className).toContain("bg-brand-solid");
  });
});
