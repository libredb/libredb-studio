'use client';

import { useState, useCallback } from 'react';
import type { DatabaseConnection } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';

interface UseTransactionControlParams {
  activeConnection: DatabaseConnection | null;
}

export function useTransactionControl({ activeConnection }: UseTransactionControlParams) {
  const [transactionActive, setTransactionActive] = useState(false);
  const [playgroundMode, setPlaygroundMode] = useState(false);
  const { toast } = useToast();

  const handleTransaction = useCallback(async (action: 'begin' | 'commit' | 'rollback') => {
    if (!activeConnection) return;

    try {
      const res = await fetch('/api/db/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection: activeConnection, action }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast({ title: "Transaction Error", description: data.error, variant: "destructive" });
        return;
      }

      if (action === 'begin') {
        setTransactionActive(true);
        toast({ title: "Transaction Started", description: "BEGIN — all queries will run in this transaction until you COMMIT or ROLLBACK." });
      } else if (action === 'commit') {
        setTransactionActive(false);
        toast({ title: "Transaction Committed", description: "All changes have been saved." });
      } else if (action === 'rollback') {
        setTransactionActive(false);
        toast({ title: "Transaction Rolled Back", description: "All changes have been discarded." });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: "Transaction Error", description: msg, variant: "destructive" });
    }
  }, [activeConnection, toast]);

  const resetTransactionState = useCallback(() => {
    setTransactionActive(false);
    setPlaygroundMode(false);
  }, []);

  return {
    transactionActive,
    playgroundMode,
    setPlaygroundMode,
    handleTransaction,
    resetTransactionState,
  };
}
