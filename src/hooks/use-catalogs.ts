"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/config/base-path";
import { declaresCatalogSessions } from "@/lib/db/object-kinds";
import type { Container, ProviderCapabilities } from "@/lib/db/types";
import { storage } from "@/lib/storage";
import type { DatabaseConnection } from "@/lib/types";
import { buildConnectionPayload } from "./use-connection-payload";

/**
 * The databases a server-level connection lists, and the one a page reads (#1530), for the pages
 * outside the studio shell: the monitoring page and the admin operations panel. They start on the
 * database the studio last chose for this connection and remember a new choice the same way, so
 * all three surfaces agree on which database is active. On every other connection there are none.
 */
export function useCatalogs(connection: DatabaseConnection | null, capabilities: ProviderCapabilities | undefined) {
  const serverLevel = connection !== null && capabilities !== undefined && declaresCatalogSessions(capabilities);
  const connectionId = serverLevel ? connection.id : null;
  const [listed, setListed] = useState<{ readonly connectionId: string; readonly catalogs: readonly string[] } | null>(
    null,
  );
  const [picked, setPicked] = useState<{ readonly connectionId: string; readonly catalog: string } | null>(null);

  useEffect(() => {
    if (connectionId === null || connection === null) return;
    let current = true;
    appFetch("/api/db/objects/containers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildConnectionPayload(connection)),
    })
      .then(async (res) => (res.ok ? ((await res.json()) as Container[]) : []))
      .catch(() => [] as Container[])
      .then((containers) => {
        if (current) setListed({ connectionId, catalogs: containers.map((container) => container.name) });
      });
    return () => {
      current = false;
    };
  }, [connection, connectionId]);

  const catalogs = listed !== null && listed.connectionId === connectionId ? listed.catalogs : [];
  const wanted =
    picked !== null && picked.connectionId === connectionId
      ? picked.catalog
      : connectionId === null
        ? null
        : storage.getActiveCatalog(connectionId);
  const catalog = wanted !== null && catalogs.includes(wanted) ? wanted : catalogs[0];

  const setCatalog = (next: string) => {
    if (connectionId === null) return;
    storage.setActiveCatalog(connectionId, next);
    setPicked({ connectionId, catalog: next });
  };

  return { catalogs, catalog, setCatalog };
}
