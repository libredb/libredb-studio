import "../setup-dom";
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

afterEach(cleanup);

function State() {
  const { open, openMobile } = useSidebar();
  return <output>{`${open}:${openMobile}`}</output>;
}

test("sidebar shortcut matches a physical key and releases its listener on unmount", () => {
  const { container, unmount } = render(
    <SidebarProvider>
      <State />
    </SidebarProvider>,
  );
  const before = container.textContent;
  fireEvent.keyDown(window, { key: "и", code: "KeyB", ctrlKey: true });
  expect(container.textContent).not.toBe(before);
  fireEvent.keyDown(window, { key: "B", code: "KeyB", metaKey: true });
  expect(container.textContent).toBe(before);
  for (const change of [{ code: "KeyV" }, { shiftKey: true }, { altKey: true }, { ctrlKey: false }]) {
    fireEvent.keyDown(window, { code: "KeyB", ctrlKey: true, ...change });
    expect(container.textContent).toBe(before);
  }
  unmount();
  const event = new KeyboardEvent("keydown", { code: "KeyB", ctrlKey: true, cancelable: true });
  fireEvent(window, event);
  expect(event.defaultPrevented).toBe(false);
});
