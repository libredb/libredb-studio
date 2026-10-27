import { afterEach, describe, expect, test } from "bun:test";
import { workerEnvironment } from "@/lib/db/providers/sql/sqlite-worker";

/**
 * The worker's environment (#1623): only the keys it needs, never the parent's secrets. ELECTRON_RUN_AS_NODE is one
 * of them: the VS Code extension's backend runs on VS Code's own binary with it set, and the worker spawned from that
 * binary without it starts as the app instead of Node and dies.
 */
describe("sqlite worker environment", () => {
  const saved = { electron: process.env.ELECTRON_RUN_AS_NODE, secret: process.env.JWT_SECRET };

  afterEach(() => {
    for (const [key, value] of [
      ["ELECTRON_RUN_AS_NODE", saved.electron],
      ["JWT_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("passes ELECTRON_RUN_AS_NODE through when the parent runs Electron as Node", () => {
    process.env.ELECTRON_RUN_AS_NODE = "1";
    expect(workerEnvironment().ELECTRON_RUN_AS_NODE).toBe("1");
  });

  test("leaves ELECTRON_RUN_AS_NODE unset when the parent has none, as the web app's Node does", () => {
    delete process.env.ELECTRON_RUN_AS_NODE;
    expect("ELECTRON_RUN_AS_NODE" in workerEnvironment()).toBe(false);
  });

  test("still forces the node driver and carries no secret of the parent", () => {
    process.env.JWT_SECRET = "parent-secret";
    const env = workerEnvironment();
    expect(env.LIBREDB_SQLITE_DRIVER).toBe("node");
    expect("JWT_SECRET" in env).toBe(false);
  });
});
