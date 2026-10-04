"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useCallback } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { buildConnectionPayload } from "./use-connection-payload";

interface UseTransactionControlParams {
  activeConnection: DatabaseConnection | null;
}

export function useTransactionControl({ activeConnection }: UseTransactionControlParams) {
  const [transactionActive, setTransactionActive] = useState(false);
  const [playgroundMode, setPlaygroundMode] = useState(false);
  // The server answered BEGIN without reporting any transaction state (`stateReported: false`
  // from the route), so nothing Studio reads can confirm what a ROLLBACK discarded.
  const [stateUnreported, setStateUnreported] = useState(false);
  const { toast } = useToast();

  const handleTransaction = useCallback(
    async (action: "begin" | "commit" | "rollback") => {
      if (!activeConnection) return;

      try {
        const res = await appFetch("/api/db/transaction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...buildConnectionPayload(activeConnection),
            action,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          toast({ title: "Transaction Error", description: data.error, variant: "destructive" });
          return;
        }

        if (action === "begin") {
          const unreported = data.stateReported === false;
          setTransactionActive(true);
          setStateUnreported(unreported);
          toast({
            title: "Transaction Started",
            description: unreported
              ? "BEGIN sent. This server does not report transaction state, so Studio cannot verify that the transaction is open or notice a statement that ends it. Queries run on this connection until you COMMIT or ROLLBACK."
              : "BEGIN — all queries will run in this transaction until you COMMIT or ROLLBACK.",
          });
        } else if (action === "commit") {
          setTransactionActive(false);
          toast(
            stateUnreported
              ? {
                  title: "Commit Sent",
                  description: "This server does not report transaction state, so Studio cannot verify what was saved.",
                }
              : { title: "Transaction Committed", description: "All changes have been saved." },
          );
        } else if (action === "rollback") {
          setTransactionActive(false);
          toast(
            stateUnreported
              ? {
                  title: "Rollback Sent",
                  description:
                    "This server does not report transaction state, so Studio cannot verify what was discarded.",
                }
              : { title: "Transaction Rolled Back", description: "All changes have been discarded." },
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        toast({ title: "Transaction Error", description: msg, variant: "destructive" });
      }
    },
    [activeConnection, toast, stateUnreported],
  );

  const resetTransactionState = useCallback(() => {
    setTransactionActive(false);
    setPlaygroundMode(false);
    setStateUnreported(false);
  }, []);

  // The server ended the transaction itself (a COMMIT typed in it, or a statement the engine
  // commits implicitly), so there is nothing left for COMMIT or ROLLBACK to act on.
  const markTransactionEnded = useCallback(() => setTransactionActive(false), []);

  return {
    transactionActive,
    playgroundMode,
    setPlaygroundMode,
    handleTransaction,
    resetTransactionState,
    markTransactionEnded,
  };
}
