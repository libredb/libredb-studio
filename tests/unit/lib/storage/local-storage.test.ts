import { describe, test, expect, beforeEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub
  globalThis.window = globalThis;
}

import {
  readJSON,
  writeJSON,
  readString,
  writeString,
  remove,
  getKey,
  clearAccountWorkspace,
  workspaceTabsKey,
  WORKSPACE_OWNER_KEY,
  SERVER_MIGRATED_KEY,
  SOURCE_DRAFTS_KEY,
  AGENT_THREAD_KEY,
} from "@/lib/storage/local-storage";
import { STORAGE_COLLECTIONS } from "@/lib/storage/types";

describe("local-storage: getKey", () => {
  test("maps known collection names to libredb_ prefix keys", () => {
    expect(getKey("connections")).toBe("libredb_connections");
    expect(getKey("history")).toBe("libredb_history");
    expect(getKey("saved_queries")).toBe("libredb_saved_queries");
    expect(getKey("audit_log")).toBe("libredb_audit_log");
    expect(getKey("masking_config")).toBe("libredb_masking_config");
    expect(getKey("threshold_config")).toBe("libredb_threshold_config");
  });

  test("falls back to libredb_ prefix for unknown collections", () => {
    expect(getKey("unknown")).toBe("libredb_unknown");
  });
});

describe("local-storage: readJSON / writeJSON", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writeJSON / readJSON round-trip", () => {
    writeJSON("connections", [{ id: 1 }]);
    expect(readJSON<{ id: number }[]>("connections")).toEqual([{ id: 1 }]);
  });

  test("readJSON returns null for non-existent key", () => {
    expect(readJSON("nonexistent")).toBeNull();
  });

  test("readJSON returns null for invalid JSON", () => {
    localStorage.setItem("libredb_connections", "not-json{{{");
    expect(readJSON("connections")).toBeNull();
  });
});

describe("local-storage: readString / writeString", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writeString / readString round-trip", () => {
    writeString("active_connection_id", "conn-42");
    expect(readString("active_connection_id")).toBe("conn-42");
  });

  test("readString returns null for non-existent key", () => {
    expect(readString("active_connection_id")).toBeNull();
  });
});

describe("local-storage: writeJSON quota handling", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns true on success", () => {
    const result = writeJSON("test-key", { data: "value" });
    expect(result).toBe(true);
  });

  test("returns false on QuotaExceededError", () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      const result = writeJSON("test-key", { data: "value" });
      expect(result).toBe(false);
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});

describe("local-storage: writeString quota handling", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns true on success", () => {
    const result = writeString("active_connection_id", "conn-42");
    expect(result).toBe(true);
  });

  test("returns false on QuotaExceededError", () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      const result = writeString("active_connection_id", "conn-42");
      expect(result).toBe(false);
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});

describe("local-storage: remove", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("remove deletes the key", () => {
    writeString("active_connection_id", "conn-42");
    remove("active_connection_id");
    expect(readString("active_connection_id")).toBeNull();
  });
});

describe("local-storage: clearAccountWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("the account keys are named once, with their stored spelling", () => {
    expect(WORKSPACE_OWNER_KEY).toBe("libredb_workspace_owner");
    expect(SERVER_MIGRATED_KEY).toBe("libredb_server_migrated");
    expect(SOURCE_DRAFTS_KEY).toBe("libredb_source_drafts_v1");
    expect(AGENT_THREAD_KEY).toBe("libredb_agent_thread");
  });

  test("removes every key the signed-in account's browser copy is held under", () => {
    for (const collection of STORAGE_COLLECTIONS) localStorage.setItem(getKey(collection), "x");
    localStorage.setItem(workspaceTabsKey("c1"), "[]");
    localStorage.setItem(workspaceTabsKey("seed:sample"), "[]");
    localStorage.setItem(SOURCE_DRAFTS_KEY, "{}");
    localStorage.setItem(AGENT_THREAD_KEY, "{}");
    localStorage.setItem(SERVER_MIGRATED_KEY, "2026-10-07");
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");

    clearAccountWorkspace();

    expect(localStorage.length).toBe(0);
  });

  test("keeps the per-browser preferences", () => {
    const preferences = {
      "editor-line-numbers": "false",
      "libredb-theme": "dark",
      libredb_star_prompt_query_count: "3",
      libredb_star_prompt_handled: "1",
      "another-app": "kept",
    };
    for (const [key, value] of Object.entries(preferences)) localStorage.setItem(key, value);
    localStorage.setItem(getKey("connections"), "[]");

    clearAccountWorkspace();

    expect(localStorage.getItem(getKey("connections"))).toBeNull();
    for (const [key, value] of Object.entries(preferences)) expect(localStorage.getItem(key)).toBe(value);
  });
});
