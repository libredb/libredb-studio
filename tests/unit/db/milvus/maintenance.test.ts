/**
 * Load and Release: the two declared per-row operations, Load
 * previewed and plainly confirmed, Release previewed and confirmed by the collection's exact name; the one-load lock,
 * FIFO, released once, left by a waiter whose signal aborts; and the poll's sleep, which an abort ends.
 */
import { describe, expect, test } from "bun:test";
import {
  abortableSleep,
  MILVUS_LOAD_POLL_MS,
  MILVUS_LOAD_WINDOW_MS,
  MILVUS_MAINTENANCE_OPERATIONS,
  MILVUS_MAINTENANCE_SPECS,
  MilvusLoadLock,
  RELEASE_DESCRIPTION,
} from "@/lib/db/providers/vector/milvus/maintenance";
import { declaredEntityOperations, maintenanceControl, type ProviderCapabilities } from "@/lib/db/types";
import { settle } from "../../../helpers/milvus-catalog-client";

const CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "json",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsMaintenance: true,
  maintenanceOperations: [...MILVUS_MAINTENANCE_OPERATIONS],
  maintenanceOperationSpecs: MILVUS_MAINTENANCE_SPECS,
  supportsConnectionString: false,
  defaultPort: 19530,
  schemaRefreshPattern: "(?!)",
};

describe("the declared operations", () => {
  test("Load and Release, each its own member, never a reused one", () => {
    expect(MILVUS_MAINTENANCE_OPERATIONS).toEqual(["load", "release"]);
  });

  test("the two specs, exactly", () => {
    expect(MILVUS_MAINTENANCE_SPECS).toEqual({
      load: { label: "Load", perEntity: true, global: false, preview: true },
      release: {
        label: "Release",
        perEntity: true,
        global: false,
        confirmation: "typed-target",
        preview: true,
        description:
          "Every other client's search and query on this collection then fails with code 101 until it is loaded again.",
      },
    });
    expect(MILVUS_MAINTENANCE_SPECS.release?.description).toBe(RELEASE_DESCRIPTION);
  });

  test("both are offered per row, in declaration order, and neither on a whole-database card", () => {
    expect(declaredEntityOperations(CAPABILITIES)).toEqual([
      { type: "load", label: "Load" },
      { type: "release", label: "Release" },
    ]);
    expect(maintenanceControl(CAPABILITIES, "load", "global").offered).toBe(false);
    expect(maintenanceControl(CAPABILITIES, "release", "global").offered).toBe(false);
  });

  test("Release asks for the collection's exact name and both read the preview before the confirm button", () => {
    expect(maintenanceControl(CAPABILITIES, "release", "perEntity")).toEqual({
      offered: true,
      label: "Release",
      description: RELEASE_DESCRIPTION,
      confirmation: "typed-target",
      preview: true,
    });
    expect(maintenanceControl(CAPABILITIES, "load", "perEntity")).toEqual({
      offered: true,
      label: "Load",
      preview: true,
    });
  });

  test("the poll asks every second for at most 10 seconds", () => {
    expect(MILVUS_LOAD_POLL_MS).toBe(1_000);
    expect(MILVUS_LOAD_WINDOW_MS).toBe(10_000);
  });
});

describe("MilvusLoadLock", () => {
  test("the first acquire holds it at once; the next waits until the holder releases", async () => {
    const lock = new MilvusLoadLock();
    const free = new AbortController().signal;
    const first = await lock.acquire(free);
    expect(lock.held).toBe(true);
    let second: (() => void) | undefined;
    void lock.acquire(free).then((release) => {
      second = release;
    });
    await settle();
    expect(second).toBeUndefined();
    first();
    await settle();
    expect(second).toBeDefined();
    expect(lock.held).toBe(true);
    second?.();
    expect(lock.held).toBe(false);
  });

  test("waiters are admitted in arrival order, and a release given twice admits one", async () => {
    const lock = new MilvusLoadLock();
    const free = new AbortController().signal;
    const order: string[] = [];
    const holder = await lock.acquire(free);
    const b = lock.acquire(free).then((release) => {
      order.push("b");
      return release;
    });
    const c = lock.acquire(free).then((release) => {
      order.push("c");
      return release;
    });
    holder();
    holder();
    await settle();
    expect(order).toEqual(["b"]);
    (await b)();
    (await c)();
    expect(order).toEqual(["b", "c"]);
    expect(lock.held).toBe(false);
  });

  test("a waiter whose signal aborts leaves with the signal's reason and is never admitted", async () => {
    const lock = new MilvusLoadLock();
    const holder = await lock.acquire(new AbortController().signal);
    const leaving = new AbortController();
    const waiting = lock.acquire(leaving.signal);
    leaving.abort(new Error("the connection closed"));
    await expect(waiting).rejects.toThrow("the connection closed");
    holder();
    expect(lock.held).toBe(false);
  });

  test("an already aborted signal is refused at once", async () => {
    const lock = new MilvusLoadLock();
    const aborted = new AbortController();
    aborted.abort(new Error("closed"));
    await expect(lock.acquire(aborted.signal)).rejects.toThrow("closed");
    expect(lock.held).toBe(false);
  });
});

describe("abortableSleep", () => {
  test("resolves after the time", async () => {
    const started = Date.now();
    await abortableSleep(20, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("an abort ends it with the signal's reason, and an aborted signal refuses it at once", async () => {
    const stopping = new AbortController();
    const sleeping = abortableSleep(60_000, stopping.signal);
    stopping.abort(new Error("stopped"));
    await expect(sleeping).rejects.toThrow("stopped");
    await expect(abortableSleep(10, stopping.signal)).rejects.toThrow("stopped");
  });
});
