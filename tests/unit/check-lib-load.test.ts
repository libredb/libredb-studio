/**
 * The packed library check (`bun run lib:load`, scripts/check-lib-load.mjs) and the library build's handling of
 * workspace packages (docs/TOOLCHAIN.md, "The packed library loads").
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { workspacePackageNames } from "../../scripts/workspace-packages.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");

describe("the repository's lib:load wiring", () => {
  test("tsup.config.ts bundles every workspace package, code and types", async () => {
    const config = (await import("../../tsup.config.ts")).default as {
      noExternal?: (string | RegExp)[];
      dts?: unknown;
    };
    const names = workspacePackageNames(REPOSITORY_ROOT);

    expect(config.noExternal?.filter((entry) => typeof entry === "string")).toEqual(names);
    expect(config.noExternal?.filter((entry) => entry instanceof RegExp).map((entry) => entry.source)).toEqual([
      "\\.css$",
    ]);
    expect(config.dts).toEqual({ resolve: names });
  });
});
