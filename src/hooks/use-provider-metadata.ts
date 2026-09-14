"use client";

import { appFetch } from "@/lib/config/base-path";
import { useCallback, useState, useEffect, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderCapabilities, ProviderLabels } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { buildConnectionPayload } from "./use-connection-payload";

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

/**
 * What one connection's declaration read answered.
 *
 * `error` is the third state and it is the one this hook used to lose (#789). A refused read
 * logged a warning and set the metadata to null, which is byte-identical to "not read yet" at
 * every consumer: the sidebar renders its pending spinner whenever metadata is absent, so a
 * reader whose read failed watched "Reading the connection..." for ever with no message and
 * nothing to press. This epic's rule everywhere else is that a refusal is shown in the engine's
 * own words rather than as an absence, and a log line is not a surface a reader can see.
 */
export interface ProviderMetadataState {
  metadata: ProviderMetadata | null;
  isLoading: boolean;
  /** Why the read failed, in the route's own words, or null when nothing has failed. */
  error: string | null;
  /** Read this connection's declaration again. */
  retry: () => void;
}

export function useProviderMetadata(connection: DatabaseConnection | null): ProviderMetadataState {
  const [metadataState, setMetadata] = useState<ProviderMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many times the reader has asked for the current connection again.
   *
   * A counter rather than a boolean, because a retry that fails must be retryable again. It is
   * part of the READ KEY below rather than a bare effect dependency, so what a settled response
   * is checked against is the exact read that asked for it: without that, a retry issued while
   * the first attempt is still in flight would let the first one's answer stand for it.
   */
  const [attempt, setAttempt] = useState(0);
  const lastReadKey = useRef<string | null>(null);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);

  /** Which read is wanted: one connection, one attempt. Null means there is nothing to read. */
  const readKey = connection === null ? null : `${attempt}:${connection.id}`;

  useEffect(() => {
    if (!connection || readKey === null) {
      lastReadKey.current = null;
      return;
    }

    // Avoid refetching for the same connection, and the same attempt at it.
    if (lastReadKey.current === readKey) {
      return;
    }

    const requestedKey = readKey;
    lastReadKey.current = requestedKey;
    // Callers gate controls on these capabilities (the inline-edit affordance, the
    // maintenance actions), so the previous connection's answer must not stand in
    // for this one while the new answer is in flight - that offers a control the
    // engine rejects. Absent capabilities read as unsupported everywhere.
    setMetadata(null);
    setError(null);
    setIsLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    appFetch("/api/db/provider-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `buildConnectionPayload`, not the connection object: a managed (seed)
      // connection reaches the browser with its credentials stripped, and one
      // defined by `connectionString` alone keeps nothing that identifies a
      // database at all. Posting that object made the route answer 400 for the
      // MongoDB seed, leaving capabilities null - which is what made the schema
      // tree offer SQL labels and generate `SELECT * FROM <collection> LIMIT 50`
      // against MongoDB. The server resolves `seed:<id>` to its own descriptor,
      // exactly as the schema, query and monitoring routes are already called.
      body: JSON.stringify(buildConnectionPayload(connection)),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) return res.json();
        // The route's own sentence, never a rewrite of it, and the status only when the body
        // carries none: a reader acts on "authentication failed for user postgres" and can do
        // nothing at all with "Failed to fetch provider metadata".
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `The connection could not be read (HTTP ${res.status})`);
      })
      // Requests can land out of order, so every settle path checks that this
      // connection is still the selected one before it answers for it. The check
      // is against the ref rather than an effect-cleanup flag on purpose: a
      // cleanup that fires for the SAME connection (React re-running the effect)
      // would otherwise discard the only response, and the id guard above means
      // no refetch would follow.
      .then((data: ProviderMetadata) => {
        if (lastReadKey.current === requestedKey) setMetadata(data);
      })
      .catch((err) => {
        logger.warn("Provider metadata request failed", {
          route: "use-provider-metadata",
          error: err instanceof Error ? err.message : String(err),
        });
        if (lastReadKey.current !== requestedKey) return;
        setMetadata(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (lastReadKey.current === requestedKey) setIsLoading(false);
      });
  }, [connection, readKey]);

  // Derived, not reset in the effect: with no connection there is nothing to
  // describe and nothing can have failed, and answering null during render costs no
  // extra pass. The state itself is still cleared at request time (see above) so a
  // previous connection's capabilities can never stand in for the one being fetched.
  const noConnection = connection === null;
  return {
    metadata: noConnection ? null : metadataState,
    isLoading,
    error: noConnection ? null : error,
    retry,
  };
}
