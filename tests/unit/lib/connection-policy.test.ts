import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  connectionAllowed,
  connectionsUnderPolicy,
  CUSTOM_CONNECTIONS_ALLOWED,
  mergeVisibleOrder,
  readConnectionPolicy,
} from "@/lib/connection-policy";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

const at = new Date(0);
const managedSeed: DatabaseConnection = {
  id: "seed:orders",
  seedId: "orders",
  name: "Orders",
  type: "postgres",
  managed: true,
  createdAt: at,
};
const editableCopy: DatabaseConnection = {
  id: "seed:sandbox",
  seedId: "sandbox",
  name: "Sandbox",
  type: "postgres",
  managed: false,
  createdAt: at,
};
const own: DatabaseConnection = {
  id: "k3j2h1",
  name: "Mine",
  type: "postgres",
  host: "anywhere.example",
  createdAt: at,
};
const duplicate: DatabaseConnection = { ...editableCopy, id: "q9w8e7", name: "Sandbox (copy)", seedId: undefined };
const REFUSED = { customConnections: false };
const UNREAD = "The connection policy could not be read; custom connections stay offered and the server still decides";

afterEach(() => {
  restoreGlobalFetch();
});

describe("connectionAllowed", () => {
  test("allows every connection while custom connections are allowed", () => {
    for (const connection of [managedSeed, editableCopy, own, duplicate]) {
      expect(connectionAllowed(connection, CUSTOM_CONNECTIONS_ALLOWED)).toBe(true);
    }
  });

  test("while they are refused, allows exactly the seed namespace the server resolves itself", () => {
    expect(connectionAllowed(managedSeed, REFUSED)).toBe(true);
    expect(connectionAllowed(editableCopy, REFUSED)).toBe(true);
    expect(connectionAllowed(own, REFUSED)).toBe(false);
    expect(connectionAllowed(duplicate, REFUSED)).toBe(false);
  });
});

describe("connectionsUnderPolicy", () => {
  test("hands back the same array when nothing is refused", () => {
    const list = [managedSeed, own];
    expect(connectionsUnderPolicy(list, CUSTOM_CONNECTIONS_ALLOWED)).toBe(list);
  });

  test("keeps the seeds, in their order, when custom connections are refused", () => {
    expect(connectionsUnderPolicy([own, managedSeed, duplicate, editableCopy], REFUSED)).toEqual([
      managedSeed,
      editableCopy,
    ]);
  });
});

// The full saved order after a drag in a list that shows only some connections: [a, b, c, d]
// with a and c hidden and [b, d] reordered to [d, b] is the example the hidden ids must survive.
describe("mergeVisibleOrder", () => {
  test("keeps every hidden id at its index and writes the reordered ids into the indices the shown ones held", () => {
    expect(mergeVisibleOrder(["a", "b", "c", "d"], ["d", "b"])).toEqual(["a", "d", "c", "b"]);
  });

  test("hands back the previous order when the shown ids kept their sequence", () => {
    expect(mergeVisibleOrder(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  test("keeps the new sequence when the previous order does not name every shown id, the rest following at the end", () => {
    expect(mergeVisibleOrder(["a", "b", "c"], ["x", "b"])).toEqual(["a", "x", "c", "b"]);
  });

  test("is the reordered list when there is no previous order", () => {
    expect(mergeVisibleOrder([], ["d", "b"])).toEqual(["d", "b"]);
  });
});

describe("readConnectionPolicy", () => {
  test("reads a refusal from GET /api/connections/policy", async () => {
    const fetchMock = mockGlobalFetch({ "/api/connections/policy": { json: { customConnections: false } } });
    expect(await readConnectionPolicy()).toEqual({ customConnections: false });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/connections/policy");
  });

  test("reads an allowance", async () => {
    mockGlobalFetch({ "/api/connections/policy": { json: { customConnections: true } } });
    expect(await readConnectionPolicy()).toEqual({ customConnections: true });
  });

  test("only an explicit false withholds anything", async () => {
    mockGlobalFetch({ "/api/connections/policy": { json: { customConnections: "false" } } });
    expect(await readConnectionPolicy()).toEqual(CUSTOM_CONNECTIONS_ALLOWED);
  });

  test("a shell without the route is answered silently and changes nothing", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockGlobalFetch({});
      expect(await readConnectionPolicy()).toEqual(CUSTOM_CONNECTIONS_ALLOWED);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a refused read is logged and changes nothing", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockGlobalFetch({
        "/api/connections/policy": { status: 401, json: { error: "Authentication required", code: "AUTH_REQUIRED" } },
      });
      expect(await readConnectionPolicy()).toEqual(CUSTOM_CONNECTIONS_ALLOWED);
      expect(warn).toHaveBeenCalledWith(UNREAD, { route: "connection-policy", status: 401 });
    } finally {
      warn.mockRestore();
    }
  });

  test("an unreachable server is logged and changes nothing", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockGlobalFetch({
        "/api/connections/policy": () => {
          throw new Error("network down");
        },
      });
      expect(await readConnectionPolicy()).toEqual(CUSTOM_CONNECTIONS_ALLOWED);
      expect(warn).toHaveBeenCalledWith(UNREAD, { route: "connection-policy", error: "network down" });
    } finally {
      warn.mockRestore();
    }
  });
});
