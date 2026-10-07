import { describe, test, expect, beforeEach, afterEach } from "bun:test";

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
  claimAccountWorkspace,
  resetAccountWorkspace,
  workspaceTabsKey,
  removeWorkspaceTabs,
  holdsAccountWorkspace,
  WORKSPACE_OWNER_KEY,
  SERVER_MIGRATED_KEY,
  SOURCE_DRAFTS_KEY,
  AGENT_THREAD_KEY,
} from "@/lib/storage/local-storage";
import { STORAGE_COLLECTIONS } from "@/lib/storage/types";
import { heldWorkspaceOwner, holdWorkspaceOwner } from "@/lib/config/base-path";

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

describe("local-storage: writes while another tab changed whose copy this is", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    holdWorkspaceOwner(null);
  });

  test("before a claim, as in local mode, every write lands whatever the owner key says", () => {
    localStorage.setItem(WORKSPACE_OWNER_KEY, "bob@libredb.org");

    expect(holdsAccountWorkspace()).toBe(true);
    expect(writeJSON("history", [])).toBe(true);
    expect(writeString("active_connection_id", "c1")).toBe(true);
  });

  test("server mode: the browser copy is written only while it still belongs to the claimed account", () => {
    holdWorkspaceOwner("ana@libredb.org");
    localStorage.setItem(WORKSPACE_OWNER_KEY, "ana@libredb.org");
    expect(holdsAccountWorkspace()).toBe(true);
    expect(writeJSON("history", [{ id: "h1" }])).toBe(true);
    localStorage.setItem(workspaceTabsKey("c1"), "[]");

    localStorage.setItem(WORKSPACE_OWNER_KEY, "bob@libredb.org");

    expect(holdsAccountWorkspace()).toBe(false);
    expect(writeJSON("history", [{ id: "h2" }])).toBe(false);
    expect(writeString("active_connection_id", "c2")).toBe(false);
    remove("history");
    removeWorkspaceTabs("c1");
    expect(localStorage.getItem(getKey("history"))).toBe(JSON.stringify([{ id: "h1" }]));
    expect(localStorage.getItem(getKey("active_connection_id"))).toBeNull();
    expect(localStorage.getItem(workspaceTabsKey("c1"))).toBe("[]");
  });

  test("server mode: a copy cleared by a sign-out elsewhere is not written either", () => {
    holdWorkspaceOwner("ana@libredb.org");
    resetAccountWorkspace(null);

    expect(writeJSON("connections", [{ id: "c1" }])).toBe(false);
    expect(localStorage.getItem(getKey("connections"))).toBeNull();
  });

  test("the owner is read from the storage it is given", () => {
    holdWorkspaceOwner("ana@libredb.org");
    const other = { getItem: (key: string) => (key === WORKSPACE_OWNER_KEY ? "ana@libredb.org" : null) };

    expect(holdsAccountWorkspace(other)).toBe(true);
    expect(holdsAccountWorkspace()).toBe(false);
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

    expect(localStorage).toHaveLength(0);
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

describe("local-storage: resetAccountWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("clears the copy and leaves it marked as handed to a server account, with no owner", () => {
    localStorage.setItem(getKey("history"), "[]");
    localStorage.setItem(workspaceTabsKey("c1"), "[]");
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");

    resetAccountWorkspace(null);

    expect(localStorage.getItem(getKey("history"))).toBeNull();
    expect(localStorage.getItem(workspaceTabsKey("c1"))).toBeNull();
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBeNull();
  });

  test("records the given owner", () => {
    resetAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
  });
});

describe("local-storage: claimAccountWorkspace", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(getKey("connections"), '[{"id":"c1"}]');
    localStorage.setItem(workspaceTabsKey("default"), "[]");
  });

  afterEach(() => {
    holdWorkspaceOwner(null);
  });

  test("every outcome holds the signed-in account for the requests this tab sends", () => {
    claimAccountWorkspace("admin@libredb.org");
    expect(heldWorkspaceOwner()).toBe("admin@libredb.org");
    claimAccountWorkspace("admin@libredb.org");
    expect(heldWorkspaceOwner()).toBe("admin@libredb.org");
    claimAccountWorkspace("user@libredb.org");
    expect(heldWorkspaceOwner()).toBe("user@libredb.org");
  });

  test("the same owner keeps the copy", () => {
    localStorage.setItem(WORKSPACE_OWNER_KEY, "user@libredb.org");
    localStorage.setItem(SERVER_MIGRATED_KEY, "2026-10-07");

    claimAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(getKey("connections"))).not.toBeNull();
    expect(localStorage.getItem(workspaceTabsKey("default"))).toBe("[]");
  });

  test("a copy with no owner that was never handed to a server account is kept for the signed-in account", () => {
    claimAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(getKey("connections"))).not.toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).toBeNull();
  });

  test("a copy the first account kept and wrote to belongs to it, so a different account starts empty", () => {
    localStorage.clear();
    claimAccountWorkspace("admin@libredb.org");
    localStorage.setItem(getKey("threshold_config"), '{"slowQueryMs":10}');

    claimAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(getKey("threshold_config"))).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
  });

  test("another owner's copy is cleared and the signed-in account becomes its owner", () => {
    localStorage.setItem(WORKSPACE_OWNER_KEY, "admin@libredb.org");
    localStorage.setItem(SERVER_MIGRATED_KEY, "2026-10-07");

    claimAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(getKey("connections"))).toBeNull();
    expect(localStorage.getItem(workspaceTabsKey("default"))).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
    expect(localStorage.getItem(SERVER_MIGRATED_KEY)).not.toBeNull();
  });

  test("a copy left after a sign-out is cleared, whatever was written to it since", () => {
    resetAccountWorkspace(null);
    localStorage.setItem(getKey("history"), '[{"id":"h1"}]');

    claimAccountWorkspace("user@libredb.org");

    expect(localStorage.getItem(getKey("history"))).toBeNull();
    expect(localStorage.getItem(WORKSPACE_OWNER_KEY)).toBe("user@libredb.org");
  });
});
