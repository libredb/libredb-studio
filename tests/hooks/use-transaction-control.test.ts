import "../setup-dom";

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

// Shared mocks — process-wide singletons (no contamination)
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { useTransactionControl } from "@/hooks/use-transaction-control";
import type { DatabaseConnection } from "@/lib/types";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "conn-1",
    name: "Test DB",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "testdb",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("useTransactionControl", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("initially transactionActive is false and playgroundMode is false", () => {
    const { result } = renderHook(() => useTransactionControl({ activeConnection: makeConnection() }));

    expect(result.current.transactionActive).toBe(false);
    expect(result.current.playgroundMode).toBe(false);
  });

  test("handleTransaction begin calls fetch and sets transactionActive true", async () => {
    const connection = makeConnection();
    const fetchMock = mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    await act(async () => {
      await result.current.handleTransaction("begin");
    });

    // fetch was called with correct params
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/db/transaction");
    expect(options?.method).toBe("POST");
    const body = JSON.parse(options?.body as string);
    expect(body.action).toBe("begin");
    expect(body.connection.id).toBe("conn-1");

    // State updated
    expect(result.current.transactionActive).toBe(true);

    // Toast called with success (real useToast calls sonnerToast.success)
    expect(mockToastSuccess).toHaveBeenCalledWith("Transaction Started", expect.any(Object));
  });

  test("handleTransaction commit calls fetch and sets transactionActive false", async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    // First begin to set transactionActive true
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    expect(result.current.transactionActive).toBe(true);

    // Now commit
    await act(async () => {
      await result.current.handleTransaction("commit");
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith("Transaction Committed", expect.any(Object));
  });

  test("handleTransaction rollback calls fetch and sets transactionActive false", async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    // Begin first
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    expect(result.current.transactionActive).toBe(true);

    // Now rollback
    await act(async () => {
      await result.current.handleTransaction("rollback");
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith("Transaction Rolled Back", expect.any(Object));
  });

  test("a server that reports no transaction state is named in the BEGIN and ROLLBACK toasts", async () => {
    // Databend, StarRocks and Doris: the BEGIN opened a transaction, and nothing the server
    // answers can confirm it, so the UI does not claim what the ROLLBACK discarded.
    let stateReported: boolean | null = false;
    mockGlobalFetch({
      "/api/db/transaction": () => ({ ok: true, status: 200, json: { status: "active", stateReported } }),
    });
    const { result } = renderHook(() => useTransactionControl({ activeConnection: makeConnection() }));

    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    expect(result.current.transactionActive).toBe(true);
    expect(mockToastSuccess).toHaveBeenLastCalledWith(
      "Transaction Started",
      expect.objectContaining({ description: expect.stringContaining("cannot verify") }),
    );

    await act(async () => {
      await result.current.handleTransaction("rollback");
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith(
      "Rollback Sent",
      expect.objectContaining({ description: expect.stringContaining("cannot verify what was discarded") }),
    );

    // The next transaction is judged on its own answer: `null` (a provider that does not say)
    // gets the ordinary toasts.
    stateReported = null;
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    await act(async () => {
      await result.current.handleTransaction("rollback");
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Transaction Rolled Back", expect.any(Object));

    // A COMMIT there is no more verifiable than a ROLLBACK.
    stateReported = false;
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    await act(async () => {
      await result.current.handleTransaction("commit");
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith(
      "Commit Sent",
      expect.objectContaining({ description: expect.stringContaining("cannot verify what was saved") }),
    );
  });

  test("resetTransactionState forgets that the server reported no transaction state", async () => {
    let stateReported: boolean | null = false;
    mockGlobalFetch({
      "/api/db/transaction": () => ({ ok: true, status: 200, json: { status: "active", stateReported } }),
    });
    const { result } = renderHook(() => useTransactionControl({ activeConnection: makeConnection() }));
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    // A connection switch resets the controls; the next connection's transaction is judged
    // on its own BEGIN answer, here a provider that does not say.
    act(() => result.current.resetTransactionState());
    stateReported = null;
    await act(async () => {
      await result.current.handleTransaction("commit");
    });
    expect(mockToastSuccess).toHaveBeenLastCalledWith("Transaction Committed", expect.any(Object));
  });

  test("handleTransaction does nothing when activeConnection is null", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: null }));

    await act(async () => {
      await result.current.handleTransaction("begin");
    });

    // fetch should never have been called
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.transactionActive).toBe(false);
  });

  test("handleTransaction shows destructive toast on API error", async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      "/api/db/transaction": { ok: false, status: 400, json: { error: "Transaction not supported" } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    await act(async () => {
      await result.current.handleTransaction("begin");
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith(
      "Transaction Error",
      expect.objectContaining({ description: "Transaction not supported" }),
    );
  });

  test("a 409 TRANSACTION_CREDENTIAL_CHANGED and a provider rollback answer both end the editor transaction", async () => {
    // The server no longer holds the transaction in either answer: Studio rolled it back after the caller's grant level
    // or credential changed (docs/GOVERNANCE.md#per-user-providers), or the provider rolled it back on its own
    // five-minute timer, after which the provider answers every statement and ROLLBACK "No active transaction". The
    // editor leaves transaction mode, so the next statement runs outside a transaction instead of being refused until
    // the user switches connection.
    const connection = makeConnection();
    const answers = [
      {
        ok: false,
        status: 409,
        json: { error: "Your access changed.", code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: true },
      },
      { ok: false, status: 400, json: { error: "No active transaction", code: "QUERY_ERROR", statusCode: 400 } },
    ];
    for (const answer of answers) {
      mockGlobalFetch({ "/api/db/transaction": { ok: true, status: 200, json: { status: "active" } } });
      const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time, each on a fresh hook.
      await act(async () => {
        await result.current.handleTransaction("begin");
      });
      expect(result.current.transactionActive).toBe(true);

      mockGlobalFetch({ "/api/db/transaction": answer });
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await act(async () => {
        await result.current.handleTransaction("rollback");
      });

      expect(result.current.transactionActive).toBe(false);
      expect(mockToastError).toHaveBeenCalledWith(
        "Transaction Error",
        expect.objectContaining({ description: answer.json.error }),
      );
    }

    // Any other refusal leaves the transaction to the user: it is still open on the server.
    mockGlobalFetch({ "/api/db/transaction": { ok: true, status: 200, json: { status: "active" } } });
    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    mockGlobalFetch({
      "/api/db/transaction": {
        ok: false,
        status: 400,
        json: { error: 'deferred constraint "fk" violated', code: "QUERY_ERROR" },
      },
    });
    await act(async () => {
      await result.current.handleTransaction("commit");
    });
    expect(result.current.transactionActive).toBe(true);
  });

  test("handleTransaction shows destructive toast on network error", async () => {
    const connection = makeConnection();
    // Override fetch to throw a network error
    globalThis.fetch = mock(async () => {
      throw new Error("Network failure");
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    await act(async () => {
      await result.current.handleTransaction("begin");
    });

    expect(result.current.transactionActive).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith(
      "Transaction Error",
      expect.objectContaining({ description: "Network failure" }),
    );
  });

  test("resetTransactionState resets both states", async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));

    // Set transactionActive via begin
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    expect(result.current.transactionActive).toBe(true);

    // Set playgroundMode
    act(() => {
      result.current.setPlaygroundMode(true);
    });
    expect(result.current.playgroundMode).toBe(true);

    // Reset both
    act(() => {
      result.current.resetTransactionState();
    });

    expect(result.current.transactionActive).toBe(false);
    expect(result.current.playgroundMode).toBe(false);
  });

  test("markTransactionEnded closes the transaction the server ended, and leaves SANDBOX alone", async () => {
    const connection = makeConnection();
    mockGlobalFetch({
      "/api/db/transaction": { ok: true, status: 200, json: { success: true } },
    });

    const { result } = renderHook(() => useTransactionControl({ activeConnection: connection }));
    await act(async () => {
      await result.current.handleTransaction("begin");
    });
    act(() => {
      result.current.setPlaygroundMode(true);
    });

    act(() => {
      result.current.markTransactionEnded();
    });

    expect(result.current.transactionActive).toBe(false);
    expect(result.current.playgroundMode).toBe(true);
  });
});
