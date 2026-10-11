import "../setup-dom";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConnectionModal } from "@/components/ConnectionModal";

/**
 * The dialog's buttons once Test Connection has its answer, with the real dialog, the real form hook and the real
 * framer-motion, because an exit animation is what kept "Connecting..." on the primary button after the answer had
 * arrived. Measured 2026-10-11 in Chromium against a host that drops the packets:
 * the answer was on screen while the third button still read "Connecting...".
 */

// Animations run in real time, so an exit animation holds its node as it does in a browser. Without Element.animate
// motion drives them from its own frame loop rather than through happy-dom's Web Animations, whose cancel rejects a
// promise nobody awaits.
const nativeAnimate = Element.prototype.animate;
beforeAll(() => {
  Reflect.deleteProperty(Element.prototype, "animate");
});
afterAll(() => {
  Element.prototype.animate = nativeAnimate;
});

afterEach(cleanup);

const NO_ANSWER =
  "No answer from 10.255.255.1:5432 after 10 seconds: check the address, the port and the network path.";

function labels(): string[] {
  return screen.getAllByRole("button").map((button) => button.textContent?.trim() ?? "");
}

describe("Test Connection's answer", () => {
  test("once the answer is shown, no button is still connecting or testing", async () => {
    let answer: (outcome: { success: boolean; error?: string }) => void = () => {};
    const pending = new Promise<{ success: boolean; error?: string }>((resolve) => {
      answer = resolve;
    });
    render(<ConnectionModal isOpen onClose={() => {}} onConnect={() => {}} onTestConnection={() => pending} />);
    fireEvent.click(screen.getByRole("button", { name: "PostgreSQL" }));
    fireEvent.change(document.getElementById("host") as HTMLInputElement, { target: { value: "10.255.255.1" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    });
    expect(labels()).toContain("Testing...");

    await act(async () => {
      answer({ success: false, error: NO_ANSWER });
      await pending;
    });

    expect(screen.getByTestId("connection-test-result").textContent).toContain(NO_ANSWER);
    expect(labels().filter((label) => label.includes("Connecting...") || label.includes("Testing..."))).toEqual([]);
    expect(labels()).toContain("Test Connection");
    expect(labels()).toContain("Establish Connection");
  });
});
