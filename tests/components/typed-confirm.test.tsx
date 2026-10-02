import "../setup-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { FormError, TypedConfirmDialog, TypedConfirmField, typedValueMatches } from "@/components/typed-confirm";

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
      match="case-insensitive"
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
    expect(typedValueMatches("priya@example.com", EMAIL, "case-insensitive")).toBe(true);
    expect(typedValueMatches("  PRIYA@EXAMPLE.COM \n", EMAIL, "case-insensitive")).toBe(true);
    expect(typedValueMatches("priya@example.co", EMAIL, "case-insensitive")).toBe(false);
    expect(typedValueMatches("priya @example.com", EMAIL, "case-insensitive")).toBe(false);
    expect(typedValueMatches("", EMAIL, "case-insensitive")).toBe(false);
  });

  // An etcd key is bytes, so `/app/` and `/App/` are two prefixes and ` a` is not `a` (#1089, section 5.5).
  test("exact compares every character: case, a leading space and an empty field all fail", () => {
    expect(typedValueMatches("/App/", "/App/", "exact")).toBe(true);
    expect(typedValueMatches(" a", " a", "exact")).toBe(true);
    expect(typedValueMatches("/app/", "/App/", "exact")).toBe(false);
    expect(typedValueMatches("/app/", " /app/", "exact")).toBe(false);
    expect(typedValueMatches("a", " a", "exact")).toBe(false);
    expect(typedValueMatches("", "/App/", "exact")).toBe(false);
  });

  test("an empty typed value confirms nothing under either rule, one the rule trims to nothing included", () => {
    expect(typedValueMatches("", "  ", "case-insensitive")).toBe(false);
    expect(typedValueMatches("   ", "  ", "case-insensitive")).toBe(false);
    expect(typedValueMatches("", "  ", "exact")).toBe(false);
  });

  test("an empty expected value throws under either rule, since an empty field would confirm it", () => {
    expect(() => typedValueMatches("", "", "exact")).toThrow("an empty expected value");
    expect(() => typedValueMatches("x", "", "case-insensitive")).toThrow("an empty expected value");
  });
});

describe("TypedConfirmField", () => {
  afterEach(() => {
    cleanup();
  });

  test("reports no match on mount, and again each time the answer changes", () => {
    const onMatchChange = mock<(matches: boolean) => void>(() => {});
    const view = render(<TypedConfirmField expected="/App/" match="exact" onMatchChange={onMatchChange} />);
    expect(onMatchChange.mock.calls).toEqual([[false]]);

    const input = view.getByLabelText("Type /App/ to confirm") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "/app/" } });
    fireEvent.change(input, { target: { value: "/App/" } });
    fireEvent.change(input, { target: { value: "/App" } });

    // "/app/" left the answer false, so it was not reported a second time.
    expect(onMatchChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  test("draws the value to type with its whitespace kept", () => {
    const view = render(<TypedConfirmField expected=" a" match="exact" onMatchChange={() => {}} />);
    const shown = view.container.querySelector("label span") as HTMLElement;
    expect(shown.textContent).toBe(" a");
    expect(shown.className).toContain("whitespace-pre-wrap");
  });
});

describe("FormError", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders nothing without a message, and the message as an alert with one", () => {
    const empty = render(<FormError message={null} />);
    expect(empty.container.innerHTML).toBe("");
    cleanup();

    const shown = render(<FormError message="The last enabled admin cannot be removed." />);
    expect(shown.getByRole("alert").textContent).toBe("The last enabled admin cannot be removed.");
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

  test("an exact dialog tells /app/ from /App/, and a leading or trailing space from none", () => {
    const { view, button } = renderDialog({ expected: "/App/", match: "exact" });
    const input = view.getByLabelText("Type /App/ to confirm") as HTMLInputElement;
    for (const wrong of ["/app/", " /App/", "/App/ ", "/APP/"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect({ wrong, disabled: button().disabled }).toEqual({ wrong, disabled: true });
    }
    fireEvent.change(input, { target: { value: "/App/" } });
    expect(button().disabled).toBe(false);
  });

  test("with nothing to type, says so in place of the field and confirms nothing", () => {
    const { view, button, onConfirm } = renderDialog({
      expected: "",
      match: "exact",
      unavailable: "This connection has no name, so there is nothing to type.",
    });
    const dialog = view.getByRole("alertdialog");
    expect(dialog.textContent).toContain("This connection has no name, so there is nothing to type.");
    expect(view.queryByRole("textbox")).toBeNull();
    expect(button().disabled).toBe(true);
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // The field reports its match only while it is mounted, so the sentence that replaces a matched field has to take
  // the button back itself: the connection's name can go away while the dialog is open.
  test("a sentence that replaces a matched field takes the button back", () => {
    const onConfirm = mock(async (): Promise<string | null> => null);
    const dialog = (unavailable?: string) => (
      <TypedConfirmDialog
        open
        onOpenChange={() => {}}
        title="Compact history"
        description="Removes every revision before the current one."
        expected="PG Dev"
        match="exact"
        unavailable={unavailable}
        confirmLabel="Compact now"
        destructive
        onConfirm={onConfirm}
      />
    );
    const view = render(dialog());
    const button = () => view.getByRole("button", { name: "Compact now" }) as HTMLButtonElement;
    fireEvent.change(view.getByLabelText("Type PG Dev to confirm"), { target: { value: "PG Dev" } });
    expect(button().disabled).toBe(false);

    view.rerender(dialog("This connection has no name, so there is nothing to type."));
    expect(view.queryByRole("textbox")).toBeNull();
    expect(button().disabled).toBe(true);
    fireEvent.submit(view.getByRole("alertdialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // Every caller opens this dialog from app state, with no AlertDialogTrigger for Radix to hand focus back to (#1198).
  test.each([
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))],
  ])("after %s, focus is back on the element that opened it", async (_label, dismiss) => {
    function Opener() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <TypedConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Delete this account?"
            description="Their saved connections are removed."
            expected={EMAIL}
            match="case-insensitive"
            confirmLabel="Delete account"
            destructive
            onConfirm={async () => null}
          />
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeNull());
    dismiss();

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
