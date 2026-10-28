/**
 * A runtime without `@libredb/libredb` installed.
 *
 * Its own file because the missing package is a process-wide `mock.module`: every other LibreDB test
 * needs the real one.
 */
import { expect, mock, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

mock.module("@libredb/libredb", () => {
  throw new Error("Cannot find package '@libredb/libredb'");
});

const { LibreDBProvider } = await import("@/lib/db/providers/embedded/libredb");

const connection = (): DatabaseConnection => ({
  id: "libredb-missing",
  name: "LibreDB without its package",
  type: "libredb",
  database: path.join(os.tmpdir(), "libredb-package-missing.libredb"),
  createdAt: new Date(),
});

test("connect names the missing package and how to install it, and a second connect says the same", async () => {
  const first = await new LibreDBProvider(connection()).connect().catch((error: unknown) => error);
  expect(first).toBeInstanceOf(DatabaseConfigError);
  expect((first as Error).message).toBe(
    "LibreDB package (@libredb/libredb) is not available in this environment. Install it with: bun add @libredb/libredb",
  );
  const second = await new LibreDBProvider(connection()).connect().catch((error: unknown) => error);
  expect(second).toBe(first);
});
