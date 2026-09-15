import { describe, test, expect, beforeEach, mock } from "bun:test";

// Ensure `typeof window !== 'undefined'` passes
if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub
  globalThis.window = globalThis;
}

import { storage } from "@/lib/storage";
import type { DatabaseConnection } from "@/lib/types";
import type { AuditEvent } from "@/lib/audit";
import type { MaskingConfig } from "@/lib/data-masking";
import type { ThresholdConfig } from "@/lib/monitoring-thresholds";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "conn-1",
    name: "Test DB",
    type: "postgres",
    host: "localhost",
    port: 5432,
    createdAt: new Date("2025-01-01"),
    ...overrides,
  };
}

function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    timestamp: "2025-01-01T00:00:00Z",
    type: "query_execution",
    action: "SELECT",
    target: "users",
    user: "admin",
    result: "success",
    ...overrides,
  };
}

// ── CustomEvent dispatch ─────────────────────────────────────────────────────

describe("storage facade: CustomEvent dispatch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("saveConnection dispatches libredb-storage-change event", () => {
    let captured: CustomEvent | null = null;
    const handler = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.saveConnection(makeConnection());

    expect(captured).not.toBeNull();
    expect(captured!.detail.collection).toBe("connections");

    window.removeEventListener("libredb-storage-change", handler);
  });

  test("deleteConnection dispatches event", () => {
    storage.saveConnection(makeConnection());
    const handler = mock(() => {});
    window.addEventListener("libredb-storage-change", handler);

    storage.deleteConnection("conn-1");

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("libredb-storage-change", handler);
  });

  test("addToHistory dispatches event", () => {
    const handler = mock(() => {});
    window.addEventListener("libredb-storage-change", handler);

    storage.addToHistory({
      id: "h-1",
      connectionId: "c-1",
      query: "SELECT 1",
      executionTime: 42,
      status: "success",
      executedAt: new Date(),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("libredb-storage-change", handler);
  });

  test("setActiveConnectionId dispatches event", () => {
    let captured: CustomEvent | null = null;
    const handler = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.setActiveConnectionId("conn-42");

    expect(captured).not.toBeNull();
    expect(captured!.detail.collection).toBe("active_connection_id");
    expect(captured!.detail.data).toBe("conn-42");

    window.removeEventListener("libredb-storage-change", handler);
  });
});

// ── Audit log ────────────────────────────────────────────────────────────────

describe("storage facade: audit log", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("getAuditLog returns empty array when nothing stored", () => {
    expect(storage.getAuditLog()).toEqual([]);
  });

  test("saveAuditLog / getAuditLog round-trip", () => {
    const events = [makeAuditEvent({ id: "e1" }), makeAuditEvent({ id: "e2" })];
    storage.saveAuditLog(events);
    const result = storage.getAuditLog();
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("e1");
  });

  test("saveAuditLog trims to 1000 events", () => {
    const events: AuditEvent[] = [];
    for (let i = 0; i < 1050; i++) {
      events.push(makeAuditEvent({ id: `e-${i}` }));
    }
    storage.saveAuditLog(events);
    expect(storage.getAuditLog().length).toBe(1000);
  });
});

// ── Masking config ───────────────────────────────────────────────────────────

describe("storage facade: masking config", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("getMaskingConfig returns defaults when nothing stored", () => {
    const config = storage.getMaskingConfig();
    expect(config.enabled).toBe(true);
    expect(config.patterns.length).toBeGreaterThan(0);
  });

  test("saveMaskingConfig / getMaskingConfig round-trip", () => {
    const config: MaskingConfig = {
      enabled: false,
      patterns: [],
      roleSettings: {
        admin: { canToggle: true, canReveal: true },
        user: { canToggle: false, canReveal: false },
      },
    };
    storage.saveMaskingConfig(config);
    const result = storage.getMaskingConfig();
    expect(result.enabled).toBe(false);
  });
});

// ── Threshold config ─────────────────────────────────────────────────────────

describe("storage facade: threshold config", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("getThresholdConfig returns defaults when nothing stored", () => {
    const config = storage.getThresholdConfig();
    expect(config.length).toBeGreaterThan(0);
    expect(config[0].metric).toBe("cacheHitRatio");
  });

  test("saveThresholdConfig / getThresholdConfig round-trip", () => {
    const config: ThresholdConfig[] = [
      { metric: "custom", warning: 50, critical: 80, direction: "above", label: "Custom" },
    ];
    storage.saveThresholdConfig(config);
    const result = storage.getThresholdConfig();
    expect(result.length).toBe(1);
    expect(result[0].metric).toBe("custom");
  });
});

// ── Favorite connections ─────────────────────────────────────────────────────

describe("storage facade: favorite connections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("getFavoriteConnectionIds returns an empty array when nothing stored", () => {
    expect(storage.getFavoriteConnectionIds()).toEqual([]);
  });

  test("toggleFavoriteConnection adds an id not already favorited", () => {
    const result = storage.toggleFavoriteConnection("conn-1");
    expect(result).toEqual(["conn-1"]);
    expect(storage.getFavoriteConnectionIds()).toEqual(["conn-1"]);
  });

  test("toggleFavoriteConnection removes an id already favorited", () => {
    storage.toggleFavoriteConnection("conn-1");
    const result = storage.toggleFavoriteConnection("conn-1");
    expect(result).toEqual([]);
    expect(storage.getFavoriteConnectionIds()).toEqual([]);
  });

  test("toggleFavoriteConnection preserves other favorited ids", () => {
    storage.toggleFavoriteConnection("conn-1");
    storage.toggleFavoriteConnection("conn-2");
    const result = storage.toggleFavoriteConnection("conn-1");
    expect(result).toEqual(["conn-2"]);
  });

  test("toggleFavoriteConnection dispatches libredb-storage-change with collection favorite_connections", () => {
    let captured: CustomEvent | null = null;
    const handler = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.toggleFavoriteConnection("conn-1");

    window.removeEventListener("libredb-storage-change", handler);
    expect(captured).not.toBeNull();
    expect((captured as unknown as CustomEvent).detail.collection).toBe("favorite_connections");
    expect((captured as unknown as CustomEvent).detail.data).toEqual(["conn-1"]);
  });

  test("deleteConnection prunes the deleted id out of favorite_connections", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.toggleFavoriteConnection("conn-1");
    storage.toggleFavoriteConnection("conn-2"); // a favorite for a connection that isn't this one

    storage.deleteConnection("conn-1");

    expect(storage.getFavoriteConnectionIds()).toEqual(["conn-2"]);
  });

  test("deleteConnection does not touch favorite_connections when the deleted id wasn't favorited", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.toggleFavoriteConnection("conn-2");

    storage.deleteConnection("conn-1");

    expect(storage.getFavoriteConnectionIds()).toEqual(["conn-2"]);
  });

  test("deleteConnection dispatches a favorite_connections change only when the deleted id was favorited", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.toggleFavoriteConnection("conn-1");
    const collections: string[] = [];
    const handler = (e: Event) => {
      collections.push((e as CustomEvent).detail.collection);
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.deleteConnection("conn-1");

    expect(collections).toContain("favorite_connections");
    window.removeEventListener("libredb-storage-change", handler);
  });
});

// ── Connection order (#748) ──────────────────────────────────────────────────

describe("storage facade: connection order", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("getConnectionOrder returns an empty array when nothing stored", () => {
    expect(storage.getConnectionOrder()).toEqual([]);
  });

  test("setConnectionOrder persists the full id list", () => {
    storage.setConnectionOrder(["conn-2", "conn-1"]);
    expect(storage.getConnectionOrder()).toEqual(["conn-2", "conn-1"]);
  });

  test("setConnectionOrder replaces any previously persisted order", () => {
    storage.setConnectionOrder(["conn-1", "conn-2"]);
    storage.setConnectionOrder(["conn-2", "conn-1"]);
    expect(storage.getConnectionOrder()).toEqual(["conn-2", "conn-1"]);
  });

  test("setConnectionOrder dispatches libredb-storage-change with collection connection_order", () => {
    let captured: CustomEvent | null = null;
    const handler = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.setConnectionOrder(["conn-1"]);

    window.removeEventListener("libredb-storage-change", handler);
    expect(captured).not.toBeNull();
    expect((captured as unknown as CustomEvent).detail.collection).toBe("connection_order");
    expect((captured as unknown as CustomEvent).detail.data).toEqual(["conn-1"]);
  });

  test("deleteConnection prunes the deleted id out of connection_order", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.setConnectionOrder(["conn-2", "conn-1"]);

    storage.deleteConnection("conn-1");

    expect(storage.getConnectionOrder()).toEqual(["conn-2"]);
  });

  test("deleteConnection does not touch connection_order when the deleted id wasn't in it", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.setConnectionOrder(["conn-2"]);

    storage.deleteConnection("conn-1");

    expect(storage.getConnectionOrder()).toEqual(["conn-2"]);
  });

  test("deleteConnection dispatches a connection_order change only when the deleted id was ordered", () => {
    storage.saveConnection(makeConnection({ id: "conn-1" }));
    storage.setConnectionOrder(["conn-1"]);
    const collections: string[] = [];
    const handler = (e: Event) => {
      collections.push((e as CustomEvent).detail.collection);
    };
    window.addEventListener("libredb-storage-change", handler);

    storage.deleteConnection("conn-1");

    expect(collections).toContain("connection_order");
    window.removeEventListener("libredb-storage-change", handler);
  });
});
