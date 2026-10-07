import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import { enabledOperatorSources, resetOperatorSourceCaches } from "@/lib/seed/sources/registry";

const NOT_FOUND = "Seed config file not found, seed connections disabled";

describe("operator source registry (A1)", () => {
  let dir: string;

  beforeEach(() => {
    resetOperatorSourceCaches();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "seed-registry-"));
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("enables the file source alone", () => {
    expect(enabledOperatorSources().map((source) => source.name)).toEqual(["SEED_CONFIG_PATH"]);
  });

  it("clears the file source's not-found log on reset", async () => {
    process.env.SEED_CONFIG_PATH = path.join(dir, "absent.yaml");
    const [file] = enabledOperatorSources();
    if (file === undefined) throw new Error("the premise: the file source is enabled");

    await file.load({ literalValues: false });
    await file.load({ literalValues: false });
    resetOperatorSourceCaches();
    await file.load({ literalValues: false });

    expect((warn.mock.calls as unknown[][]).filter((call) => call[0] === NOT_FOUND)).toHaveLength(2);
  });
});
