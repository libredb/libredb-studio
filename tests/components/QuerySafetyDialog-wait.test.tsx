import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { installStandInVocabulary, STAND_IN_TYPE } from "../helpers/stand-in-vocabulary";

/*
  How long the dialog waits for the AI analysis, shortened so a test can outlast it. Its own file because
  bun's module mocks are process-wide: every other dialog test reads the real wait, which
  tests/unit/llm/query-safety-timeouts.test.ts pins at 15 seconds.
*/
const WAIT_MS = 500;
mock.module("@/lib/llm/query-safety", () => ({
  QUERY_SAFETY_ANALYSIS_TIMEOUT_MS: WAIT_MS,
  QUERY_SAFETY_ROUTE_TIMEOUT_MS: 30_000,
}));

const { QuerySafetyDialog } = await import("@/components/QuerySafetyDialog");

const TIMED_OUT = "AI analysis could not be completed";
const SKIPPED = "AI analysis skipped";

/** The signal the dialog handed its last request, so a test can see the request was really stopped. */
let lastSignal: AbortSignal | undefined;

/** A model that never answers: no response at all, until the request is aborted. */
function hangingFetch() {
  return mock(async (_url: string, init?: RequestInit) => {
    lastSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
}

/** A model that starts answering and then stalls: the first chunk arrives, the rest never does. */
function stallingFetch(firstChunk: string) {
  return mock(async (_url: string, init?: RequestInit) => {
    lastSignal = init?.signal ?? undefined;
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (!sent) {
              sent = true;
              return Promise.resolve({ done: false, value: new TextEncoder().encode(firstChunk) });
            }
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
          },
        }),
      },
    } as unknown as Response;
  });
}

const execute = () => screen.getByRole("button", { name: "Execute Query" }) as HTMLButtonElement;

describe("QuerySafetyDialog: a slow or hung AI analysis", () => {
  const onClose = mock(() => {});
  const onProceed = mock(() => {});

  beforeEach(() => {
    onClose.mockClear();
    onProceed.mockClear();
    lastSignal = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof QuerySafetyDialog>> = {}) {
    return render(
      <QuerySafetyDialog
        isOpen
        query="UPDATE users SET price = 9.99 WHERE id = 1"
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
        {...props}
      />,
    );
  }

  test("while the analysis runs, Execute waits and Skip analysis is offered", () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();
    expect(screen.getByText("Analyzing query safety...")).toBeTruthy();
    expect(execute().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Skip analysis" })).toBeTruthy();
  });

  test("an analysis that does not finish in time is stopped, said so, and Execute is enabled", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();

    await waitFor(() => expect(screen.queryByText(TIMED_OUT)).not.toBeNull());
    expect(lastSignal?.aborted).toBe(true);
    expect(screen.queryByText("Analyzing query safety...")).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip analysis" })).toBeNull();
    // Said in a live region, so a screen reader hears why the button it is on just became usable.
    expect(screen.getByText(TIMED_OUT).closest("output")).not.toBeNull();
    // The abort is how the dialog stopped the request, not a failure to show as one.
    expect(screen.queryByText(/abort/i)).toBeNull();
    expect(
      screen.getByText(
        "This statement may change data, database objects, or permissions. Review the query before proceeding.",
      ),
    ).toBeTruthy();
    expect(execute().disabled).toBe(false);
    fireEvent.click(execute());
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  test("Execute stays disabled until the wait is over", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS / 3));
    expect(execute().disabled).toBe(true);
    fireEvent.click(execute());
    expect(onProceed).not.toHaveBeenCalled();
  });

  test("a stream that stalls part way is stopped the same way, and its half answer is not shown", async () => {
    globalThis.fetch = stallingFetch('```json\n{"riskLevel": "sa') as unknown as typeof fetch;
    renderDialog();

    await waitFor(() => expect(screen.queryByText(TIMED_OUT)).not.toBeNull());
    expect(lastSignal?.aborted).toBe(true);
    expect(screen.queryByText(/riskLevel/)).toBeNull();
    expect(execute().disabled).toBe(false);
  });

  test("Skip analysis stops the request at once, says so, enables Execute and keeps focus in the dialog", () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Skip analysis" }));
    expect(lastSignal?.aborted).toBe(true);
    expect(screen.getByText(SKIPPED)).toBeTruthy();
    expect(screen.getByText(SKIPPED).closest("output")).not.toBeNull();
    expect(screen.queryByText(TIMED_OUT)).toBeNull();
    expect(screen.queryByText("Analyzing query safety...")).toBeNull();
    // The button that had focus is gone; focus lands on Cancel, the dialog's safe default, not on Execute.
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(execute().disabled).toBe(false);
    fireEvent.click(execute());
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  test("after a skip, the wait running out says nothing more", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Skip analysis" }));
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 2));
    expect(screen.queryByText(TIMED_OUT)).toBeNull();
    expect(screen.getByText(SKIPPED)).toBeTruthy();
  });

  test("an analysis that finishes in time clears the wait, and nothing is said about it", async () => {
    const payload = {
      riskLevel: "low",
      summary: "One row changes.",
      warnings: [],
      affectedRows: "1",
      cascadeEffects: "none",
      recommendation: "Proceed.",
    };
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: new TextEncoder().encode(JSON.stringify(payload)) };
            },
          };
        },
      },
    })) as unknown as typeof fetch;
    renderDialog();

    await waitFor(() => expect(screen.queryByText("One row changes.")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 2));
    expect(screen.queryByText(TIMED_OUT)).toBeNull();
    expect(screen.getByText("One row changes.")).toBeTruthy();
  });

  // The dialog stays mounted between openings (the editor renders it closed), so a run cut short by closing must
  // not leave its spinner behind for the next opening, which may post nothing at all.
  test("closed mid-analysis and reopened on an engine that keeps statements local, it does not wait", async () => {
    const remove = installStandInVocabulary({ safetyAnalysis: false });
    try {
      globalThis.fetch = hangingFetch() as unknown as typeof fetch;
      const view = renderDialog();
      expect(screen.getByText("Analyzing query safety...")).toBeTruthy();
      const closed = (
        <QuerySafetyDialog
          isOpen={false}
          query="UPDATE users SET price = 9.99 WHERE id = 1"
          schemaContext=""
          databaseType="postgres"
          onClose={onClose}
          onProceed={onProceed}
        />
      );
      view.rerender(closed);
      await new Promise((resolve) => setTimeout(resolve, 20));
      view.rerender(
        <QuerySafetyDialog
          isOpen
          query="wipe everything"
          schemaContext=""
          databaseType={STAND_IN_TYPE}
          onClose={onClose}
          onProceed={onProceed}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText("Analyzing query safety...")).toBeNull();
      expect(screen.queryByRole("button", { name: "Skip analysis" })).toBeNull();
      expect(execute().disabled).toBe(false);
    } finally {
      remove();
    }
  });

  test("when the wait runs out with focus on Skip, focus moves to Cancel", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();
    screen.getByRole("button", { name: "Skip analysis" }).focus();
    expect(document.activeElement?.textContent).toBe("Skip analysis");
    await waitFor(() => expect(screen.queryByText(TIMED_OUT)).not.toBeNull());
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  test("when the wait runs out with focus elsewhere, focus stays there", async () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    renderDialog();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    await waitFor(() => expect(screen.queryByText(TIMED_OUT)).not.toBeNull());
    expect(document.activeElement).toBe(close);
  });

  test("a chunk that arrives after a skip is not shown", async () => {
    let deliver: () => void = () => {};
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      lastSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            // A reader that does not honour the abort: its pending read still resolves with a chunk.
            read: () =>
              new Promise((resolve) => {
                deliver = () => resolve({ done: false, value: new TextEncoder().encode("late chunk") });
              }),
          }),
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    renderDialog();
    await waitFor(() => expect(lastSignal).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 10));
    fireEvent.click(screen.getByRole("button", { name: "Skip analysis" }));
    deliver();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("late chunk")).toBeNull();
    expect(screen.getByText(SKIPPED)).toBeTruthy();
  });

  test("closing the dialog stops the request it was waiting on", () => {
    globalThis.fetch = hangingFetch() as unknown as typeof fetch;
    const view = renderDialog();
    expect(lastSignal?.aborted).toBe(false);
    view.rerender(
      <QuerySafetyDialog
        isOpen={false}
        query="UPDATE users SET price = 9.99 WHERE id = 1"
        schemaContext=""
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />,
    );
    expect(lastSignal?.aborted).toBe(true);
  });

  describe("through an onAnalyzeSafety adapter", () => {
    test("the adapter is handed the signal, and an answer after the wait is not shown", async () => {
      let resolveLate: (value: unknown) => void = () => {};
      let adapterSignal: AbortSignal | undefined;
      const onAnalyzeSafety = mock(async (params: { query: string; schemaContext: string; signal?: AbortSignal }) => {
        adapterSignal = params.signal;
        return new Promise((resolve) => {
          resolveLate = resolve;
        }) as never;
      });
      renderDialog({ onAnalyzeSafety });

      await waitFor(() => expect(screen.queryByText(TIMED_OUT)).not.toBeNull());
      expect(adapterSignal?.aborted).toBe(true);
      resolveLate({
        riskLevel: "safe",
        summary: "Too late to matter.",
        warnings: [],
        affectedRows: "none",
        cascadeEffects: "none",
        recommendation: "",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText("Too late to matter.")).toBeNull();
      expect(execute().disabled).toBe(false);
    });

    test("an adapter that rejects on the abort is not reported as an error", async () => {
      const onAnalyzeSafety = mock(
        (params: { query: string; schemaContext: string; signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            params.signal?.addEventListener("abort", () => reject(new Error("adapter aborted")));
          }),
      );
      renderDialog({ onAnalyzeSafety });
      fireEvent.click(screen.getByRole("button", { name: "Skip analysis" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText("adapter aborted")).toBeNull();
      expect(screen.getByText(SKIPPED)).toBeTruthy();
    });
  });

  describe("a typed confirmation", () => {
    let remove: () => void = () => {};

    afterEach(() => {
      remove();
      remove = () => {};
    });

    const asks = (text: string): TypedConfirmationAsk | undefined =>
      text.startsWith("wipe-prefix ") ? { type: "text", text: text.slice("wipe-prefix ".length) } : undefined;

    // Skipping the AI's opinion is not skipping the confirmation the engine's vocabulary asks for.
    test.each(["skip", "timeout"])("still holds Execute after the analysis ends by %s", async (how) => {
      // No `safetyAnalysis: false`: this row sends its statements to the model, so there is an analysis to wait on.
      remove = installStandInVocabulary({ typedConfirmation: asks });
      globalThis.fetch = hangingFetch() as unknown as typeof fetch;
      renderDialog({ query: "wipe-prefix /App/", databaseType: STAND_IN_TYPE });

      if (how === "skip") fireEvent.click(screen.getByRole("button", { name: "Skip analysis" }));
      await waitFor(() => expect(screen.queryByText(how === "skip" ? SKIPPED : TIMED_OUT)).not.toBeNull());
      expect(execute().disabled).toBe(true);
      fireEvent.change(screen.getByLabelText("Type /App/ to confirm"), { target: { value: "/App/" } });
      expect(execute().disabled).toBe(false);
    });
  });
});
