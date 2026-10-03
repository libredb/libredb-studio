import "../setup-dom";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import {
  MaintenanceEntityDialog,
  closedEntityDialog,
  entityRequest,
  type LoadMaintenancePreview,
  type MaintenanceEntityRequest,
} from "@/components/maintenance-entity-dialog";
import type { MaintenancePreview, ProviderCapabilities } from "@/lib/db/types";
import {
  SYNTHETIC_ENTITY_CAPABILITIES,
  SYNTHETIC_PREVIEW,
  SYNTHETIC_REFUSED_PREVIEW,
} from "../fixtures/maintenance-entity-operations";

const capabilities = SYNTHETIC_ENTITY_CAPABILITIES as unknown as ProviderCapabilities;

const TYPED: MaintenanceEntityRequest = {
  type: "disarm",
  label: "Release Object",
  target: "users",
  container: "public",
  typedTarget: true,
  preview: false,
};
const PREVIEWED: MaintenanceEntityRequest = { ...TYPED, type: "compact", label: "Load Object", preview: true };

function renderDialog(
  request: MaintenanceEntityRequest,
  loadPreview?: LoadMaintenancePreview,
  onConfirm = mock(async (): Promise<string | null> => null),
) {
  const onOpenChange = mock<(open: boolean) => void>(() => {});
  const view = render(
    <MaintenanceEntityDialog
      open
      request={request}
      onOpenChange={onOpenChange}
      loadPreview={loadPreview}
      onConfirm={onConfirm}
    />,
  );
  const confirmButton = () => view.queryByRole("button", { name: request.label }) as HTMLButtonElement | null;
  return { view, onConfirm, onOpenChange, confirmButton };
}

const resolving = (preview: MaintenancePreview) => mock(async () => preview);

afterEach(() => {
  cleanup();
});

describe("entityRequest (spec 3.11)", () => {
  test("a control that asks for neither a typed target nor a preview opens no dialog", () => {
    expect(entityRequest(capabilities, "analyze", "users", "public")).toBeNull();
    expect(entityRequest(undefined, "disarm", "users", "public")).toBeNull();
  });

  test("a typed target is read from the spec, with the row's own name and container", () => {
    expect(entityRequest(capabilities, "disarm", "users", "public")).toEqual({
      type: "disarm",
      label: "Release Object",
      title: undefined,
      description: undefined,
      target: "users",
      container: "public",
      typedTarget: true,
      preview: false,
    });
  });

  test("a preview is read from the spec beside its typed target", () => {
    expect(entityRequest(capabilities, "compact", "users")).toMatchObject({
      type: "compact",
      label: "Load Object",
      target: "users",
      container: undefined,
      typedTarget: true,
      preview: true,
    });
  });

  test("a spec's title and description travel with the request", () => {
    const worded = {
      ...capabilities,
      maintenanceOperationSpecs: {
        ...capabilities.maintenanceOperationSpecs,
        compact: {
          label: "Load Object",
          title: "Load the object",
          description: "Reads it into memory.",
          perEntity: true,
          global: false,
          preview: true as const,
        },
      },
    } as ProviderCapabilities;
    expect(entityRequest(worded, "compact", "users")).toMatchObject({
      title: "Load the object",
      description: "Reads it into memory.",
      typedTarget: false,
      preview: true,
    });
  });
});

describe("closedEntityDialog", () => {
  test("closes an opening in place and leaves no opening alone", () => {
    expect(closedEntityDialog(null)).toBeNull();
    expect(closedEntityDialog({ request: TYPED, open: true, key: 3 })).toEqual({ request: TYPED, open: false, key: 3 });
  });
});

describe("MaintenanceEntityDialog with a typed target", () => {
  test("asks for the row's own name, refuses every near miss, and sends once on the exact name", async () => {
    const { view, onConfirm, onOpenChange, confirmButton } = renderDialog(TYPED);

    expect(view.getByRole("alertdialog", { name: "Release Object" }).textContent).toContain(
      "Release Object runs on users only.",
    );
    const input = view.getByLabelText("Type users to confirm") as HTMLInputElement;
    for (const wrong of ["drop", "USERS", "Users", " users", "users ", "public.users"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect({ wrong, disabled: confirmButton()?.disabled }).toEqual({ wrong, disabled: true });
    }
    fireEvent.submit(view.getByRole("alertdialog").querySelector("form") as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "users" } });
    fireEvent.click(confirmButton() as HTMLButtonElement);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("a row with no name gets a sentence in place of the field, and nothing can be sent", () => {
    const { view, confirmButton } = renderDialog({ ...TYPED, target: "" });

    expect(
      view.getByText("This operation is confirmed by typing the object's name, and this row has none."),
    ).toBeTruthy();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(confirmButton()?.disabled).toBe(true);
  });
});

describe("MaintenanceEntityDialog with a preview", () => {
  test("while the preview is read, it says so and offers no confirm button and no field", () => {
    const { view, confirmButton } = renderDialog(PREVIEWED, () => new Promise<MaintenancePreview>(() => {}));

    expect(view.getByRole("status").textContent).toContain("Reading the preview from the server");
    expect(confirmButton()).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  test("draws the summary, the facts and the note, then asks for the row's name before it sends", async () => {
    const loadPreview = resolving(SYNTHETIC_PREVIEW);
    const { view, onConfirm, onOpenChange, confirmButton } = renderDialog(PREVIEWED, loadPreview);

    await waitFor(() => expect(view.queryByText(SYNTHETIC_PREVIEW.summary)).not.toBeNull());
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect(loadPreview).toHaveBeenCalledWith("compact", "users", "public");
    for (const fact of SYNTHETIC_PREVIEW.facts) {
      expect(view.getByText(fact.label).tagName).toBe("DT");
      expect(view.getByText(fact.value).tagName).toBe("DD");
    }
    expect(view.getByText("as reported by the server, possibly several seconds old")).toBeTruthy();

    expect(confirmButton()?.disabled).toBe(true);
    fireEvent.change(view.getByLabelText("Type users to confirm"), { target: { value: "Users" } });
    expect(confirmButton()?.disabled).toBe(true);
    fireEvent.change(view.getByLabelText("Type users to confirm"), { target: { value: "users" } });
    fireEvent.click(confirmButton() as HTMLButtonElement);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("a preview that asks for no typed target offers its confirm button as soon as the preview arrives", async () => {
    const { view, confirmButton } = renderDialog({ ...PREVIEWED, typedTarget: false }, resolving(SYNTHETIC_PREVIEW));

    await waitFor(() => expect(confirmButton()?.disabled).toBe(false));
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("a refused preview shows the refusal, with no confirm button and no field", async () => {
    const { view, onConfirm, confirmButton } = renderDialog(PREVIEWED, resolving(SYNTHETIC_REFUSED_PREVIEW));

    await waitFor(() => expect(view.getByRole("alert").textContent).toBe(SYNTHETIC_REFUSED_PREVIEW.refusal!));
    expect(view.getByText(SYNTHETIC_REFUSED_PREVIEW.summary)).toBeTruthy();
    expect(confirmButton()).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test.each<[string, unknown, string]>([
    ["an Error", new Error("Unauthorized. Admin access required."), "Unauthorized. Admin access required."],
    ["a value that is not an Error", "the preview route is down", "the preview route is down"],
  ])("a preview that fails with %s shows its words, with no confirm button", async (_label, failure, words) => {
    const { view, confirmButton } = renderDialog(
      PREVIEWED,
      mock(async () => Promise.reject(failure)),
    );

    await waitFor(() => expect(view.getByRole("alert").textContent).toBe(words));
    expect(confirmButton()).toBeNull();
  });

  test("a failure the confirm answers stays in the dialog, which stays open", async () => {
    const onConfirm = mock(async (): Promise<string | null> => "The server refused the load.");
    const { view, onOpenChange, confirmButton } = renderDialog(
      { ...PREVIEWED, typedTarget: false },
      resolving(SYNTHETIC_PREVIEW),
      onConfirm,
    );

    await waitFor(() => expect(confirmButton()?.disabled).toBe(false));
    fireEvent.click(confirmButton() as HTMLButtonElement);

    await waitFor(() => expect(view.getByText("The server refused the load.")).toBeTruthy());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("the preview is read once per opening, even when the caller hands a new function on each render", async () => {
    const first = resolving(SYNTHETIC_PREVIEW);
    const { view } = renderDialog(PREVIEWED, first);
    await waitFor(() => expect(view.queryByText(SYNTHETIC_PREVIEW.summary)).not.toBeNull());

    const second = resolving(SYNTHETIC_PREVIEW);
    view.rerender(
      <MaintenanceEntityDialog
        open
        request={PREVIEWED}
        onOpenChange={() => {}}
        loadPreview={second}
        onConfirm={async () => null}
      />,
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test("a preview request on a surface that cannot read one is a programming error, raised", () => {
    expect(() =>
      MaintenanceEntityDialog({ open: true, request: PREVIEWED, onOpenChange: () => {}, onConfirm: async () => null }),
    ).toThrow("Load Object declares a preview, and this surface was handed no way to read one");
  });
});
