import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MobileNav } from "@/components/MobileNav";

describe("MobileNav", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders 3 tab buttons", () => {
    const { queryByText } = render(<MobileNav activeTab="editor" onTabChange={mock(() => {})} />);
    expect(queryByText("DB")).not.toBeNull();
    expect(queryByText("Schema")).not.toBeNull();
    expect(queryByText("SQL")).not.toBeNull();
  });

  test("fires onTabChange when tab is clicked", () => {
    const onTabChange = mock((tab: string) => {
      void tab;
    });
    const { queryByText } = render(<MobileNav activeTab="editor" onTabChange={onTabChange} />);
    fireEvent.click(queryByText("DB")!);
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  /**
   * The agent control (#329 T10a) is how the rail is reached below `md`, where its
   * panel is display:none. It is absent unless the caller passes a handler, which is
   * how "the flag is off" stays "there is no agent surface" rather than "there is a
   * control that does nothing". It is not a tab: it opens a sheet over whatever tab
   * the user is on, so it never becomes `activeTab`.
   */
  test("offers no agent control unless one is wired", () => {
    const { queryByTestId } = render(<MobileNav activeTab="editor" onTabChange={mock(() => {})} />);

    expect(queryByTestId("mobile-nav-agent")).toBeNull();
  });

  test("opens the agent rail without changing the active tab", () => {
    const onOpenAgent = mock(() => {});
    const onTabChange = mock(() => {});
    const { getByTestId } = render(
      <MobileNav activeTab="editor" onTabChange={onTabChange} onOpenAgent={onOpenAgent} />,
    );

    fireEvent.click(getByTestId("mobile-nav-agent"));

    expect(onOpenAgent).toHaveBeenCalledTimes(1);
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
