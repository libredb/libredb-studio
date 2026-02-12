'use client';

import { useState, useEffect, useRef } from 'react';
import type { DatabaseConnection } from '@/lib/types';
import type { ProviderCapabilities, ProviderLabels } from '@/lib/db/types';

export interface ProviderMetadata {
  capabilities: ProviderCapabilities;
  labels: ProviderLabels;
}

export function useProviderMetadata(connection: DatabaseConnection | null): {
  metadata: ProviderMetadata | null;
  isLoading: boolean;
} {
  const [metadata, setMetadata] = useState<ProviderMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastConnectionId = useRef<string | null>(null);

  useEffect(() => {
    if (!connection) {
      setMetadata(null);
      lastConnectionId.current = null;
      return;
    }

    // Avoid refetching for the same connection
    if (lastConnectionId.current === connection.id) {
      return;
    }

    lastConnectionId.current = connection.id;
    setIsLoading(true);

    fetch('/api/db/provider-meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connection),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch provider metadata');
        return res.json();
      })
      .then((data: ProviderMetadata) => {
        setMetadata(data);
      })
      .catch((err) => {
        console.error('[useProviderMetadata]', err);
        setMetadata(null);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [connection]);

  return { metadata, isLoading };
}
