import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SaveQueryModal } from "@/components/SaveQueryModal";

describe("SaveQueryModal", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders dialog elements when open", () => {
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);
    expect(body.queryAllByText("Save Query").length).toBeGreaterThan(0);
    expect(body.queryByPlaceholderText("e.g. Monthly Active Users")).not.toBeNull();
    expect(body.queryByPlaceholderText("What does this query do?")).not.toBeNull();
  });

  test("shows query preview", () => {
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT * FROM users" />,
    );
    expect(baseElement.textContent).toContain("SELECT * FROM users");
  });

  test("saves query with parsed tags and resets the form", () => {
    const onClose = mock(() => {});
    const onSave = mock(() => {});
    const { baseElement } = render(<SaveQueryModal isOpen onClose={onClose} onSave={onSave} defaultQuery="SELECT 1" />);
    const body = within(baseElement);

    const nameInput = body.getByPlaceholderText("e.g. Monthly Active Users") as HTMLInputElement;
    const descriptionInput = body.getByPlaceholderText("What does this query do?") as HTMLTextAreaElement;
    const tagsInput = body.getByPlaceholderText("reports, analytics, users") as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: "Monthly Active Users" } });
    fireEvent.change(descriptionInput, { target: { value: "Counts active users per month" } });
    fireEvent.change(tagsInput, { target: { value: " reports , analytics ,, users " } });

    fireEvent.click(body.getByRole("button", { name: "Save Query" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Monthly Active Users", "Counts active users per month", [
      "reports",
      "analytics",
      "users",
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(nameInput.value).toBe("");
    expect(descriptionInput.value).toBe("");
    expect(tagsInput.value).toBe("");
  });

  test("saves with empty tag list when tags input is blank", () => {
    const onSave = mock(() => {});
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={onSave} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);

    fireEvent.change(body.getByPlaceholderText("e.g. Monthly Active Users"), { target: { value: "Untagged" } });
    fireEvent.click(body.getByRole("button", { name: "Save Query" }));

    expect(onSave).toHaveBeenCalledWith("Untagged", "", []);
  });

  test("disables the save button while the name is empty", () => {
    const onSave = mock(() => {});
    const { baseElement } = render(
      <SaveQueryModal isOpen onClose={mock(() => {})} onSave={onSave} defaultQuery="SELECT 1" />,
    );
    const body = within(baseElement);

    const saveButton = body.getByRole("button", { name: "Save Query" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    expect(onSave).not.toHaveBeenCalled();
  });
});
