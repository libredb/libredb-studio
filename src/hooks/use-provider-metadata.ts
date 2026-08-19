"use client";

import { useState, useEffect, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { logger } from "@/lib/logger";

export interface ProviderMetadata {
  capabilities: ProviderCapabilities;
  /**
   * Optional because one producer genuinely cannot supply it. `/api/db/provider-meta`
   * always answers with both, but the embedded shell has no such route: the host
   * declares each connection's metadata, and `WorkspaceConnection.labels` is
   * optional there so a host that only knows the capabilities need not restate
   * fifteen strings (#427). Every consumer already reads labels through `?.` with
   * its own fallback wording, so this states what was already true rather than
   * changing any behaviour — and it removes an `as ProviderLabels` cast that was
   * laundering `undefined` into a field declared required.
   */
  labels?: ProviderLabels;
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

    const requestedId = connection.id;
    lastConnectionId.current = requestedId;
    // Callers gate controls on these capabilities (the inline-edit affordance, the
    // maintenance actions), so the previous connection's answer must not stand in
    // for this one while the new answer is in flight - that offers a control the
    // engine rejects. Absent capabilities read as unsupported everywhere.
    setMetadata(null);
    setIsLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    fetch("/api/db/provider-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(connection),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch provider metadata");
        return res.json();
      })
      // Requests can land out of order, so every settle path checks that this
      // connection is still the selected one before it answers for it. The check
      // is against the ref rather than an effect-cleanup flag on purpose: a
      // cleanup that fires for the SAME connection (React re-running the effect)
      // would otherwise discard the only response, and the id guard above means
      // no refetch would follow.
      .then((data: ProviderMetadata) => {
        if (lastConnectionId.current === requestedId) setMetadata(data);
      })
      .catch((err) => {
        logger.warn("Provider metadata request failed", {
          route: "use-provider-metadata",
          error: err instanceof Error ? err.message : String(err),
        });
        if (lastConnectionId.current === requestedId) setMetadata(null);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (lastConnectionId.current === requestedId) setIsLoading(false);
      });
  }, [connection]);

  return { metadata, isLoading };
}
