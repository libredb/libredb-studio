import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mockToastDefault } from "../../../helpers/mock-sonner";

import { maybeInviteToStar, showStarPromptToast } from "@/lib/community/star-prompt-toast";
import { REPO_URL } from "@/lib/community/repo";
import { STAR_PROMPT_QUERY_THRESHOLD } from "@/lib/community/star-prompt";

const COUNT_KEY = "libredb_star_prompt_query_count";
const HANDLED_KEY = "libredb_star_prompt_handled";

type ToastOptions = {
  duration: number;
  action: { label: string; onClick: () => void };
  cancel: { label: string; onClick: () => void };
};

function lastToastCall() {
  const call = mockToastDefault.mock.calls.at(-1) as unknown as [string, ToastOptions];
  return { message: call[0], options: call[1] };
}

const originalOpen = window.open;

beforeEach(() => {
  mockToastDefault.mockClear();
  localStorage.removeItem(HANDLED_KEY);
  localStorage.removeItem(COUNT_KEY);
});

afterEach(() => {
  window.open = originalOpen;
});

describe("showStarPromptToast", () => {
  test("waits for the user instead of vanishing", () => {
    showStarPromptToast();

    expect(lastToastCall().options.duration).toBe(Number.POSITIVE_INFINITY);
  });

  test("asks calmly, in one sentence, without emoji or exclamation", () => {
    showStarPromptToast();

    const { message } = lastToastCall();
    expect(message).toContain("open source");
    expect(message).not.toContain("!");
    // Plain ASCII only - the repo bans emoji everywhere.
    expect(/^[\x20-\x7E]+$/.test(message)).toBe(true);
  });

  test("opens the repository in a new tab with noopener noreferrer, and never asks again", () => {
    const openMock = mock(() => null);
    window.open = openMock as unknown as typeof window.open;

    showStarPromptToast();
    lastToastCall().options.action.onClick();

    expect(openMock).toHaveBeenCalledWith(REPO_URL, "_blank", "noopener,noreferrer");
    expect(REPO_URL).toBe("https://github.com/libredb/libredb-studio");
    expect(localStorage.getItem(HANDLED_KEY)).not.toBeNull();
  });

  test("declining also means never asking again", () => {
    const openMock = mock(() => null);
    window.open = openMock as unknown as typeof window.open;

    showStarPromptToast();
    lastToastCall().options.cancel.onClick();

    expect(openMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(HANDLED_KEY)).not.toBeNull();
  });

  test("labels both paths", () => {
    showStarPromptToast();

    const { options } = lastToastCall();
    expect(options.action.label.length).toBeGreaterThan(0);
    expect(options.cancel.label.length).toBeGreaterThan(0);
  });
});

/**
 * The single entry point both query paths use. Its contract is as much about
 * what it must NOT do - throw into the caller's try block, which owns a query
 * result that has already been fetched - as about when it asks.
 */
describe("maybeInviteToStar", () => {
  test("asks on the run that reaches the threshold", () => {
    localStorage.setItem(COUNT_KEY, String(STAR_PROMPT_QUERY_THRESHOLD - 1));

    maybeInviteToStar();

    expect(mockToastDefault).toHaveBeenCalled();
  });

  test("counts quietly before the threshold", () => {
    maybeInviteToStar();

    expect(mockToastDefault).not.toHaveBeenCalled();
    expect(localStorage.getItem(COUNT_KEY)).toBe("1");
  });

  test("swallows a failing toast rather than breaking the query that earned it", () => {
    localStorage.setItem(COUNT_KEY, String(STAR_PROMPT_QUERY_THRESHOLD - 1));
    mockToastDefault.mockImplementationOnce(() => {
      throw new Error("sonner exploded");
    });

    expect(() => {
      maybeInviteToStar();
    }).not.toThrow();
  });
});
