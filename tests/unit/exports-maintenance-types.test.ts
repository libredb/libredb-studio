import { describe, expect, test } from "bun:test";
import type { MaintenanceOperationSpec, MaintenancePreview } from "@/exports/types";
import type { DatabaseProvider } from "@/lib/db/types";

/**
 * The published half of spec 3.11. The assignments are checked by `bun run typecheck`, and the values at run time:
 * the package names `MaintenancePreview`, `MaintenanceOperationSpec` takes `"typed-target"` and `preview`, and
 * `DatabaseProvider`, which reaches a host through `createDatabaseProvider`'s return type, declares the two optional
 * methods. This file reads `src/exports/types.ts`, not the built `dist/`: no tracked test or CI step compiles a fixture
 * against the packed tarball, so a tsup entry or export map that dropped these names would pass here. That fixture was
 * run by hand before merge, and it failed on the base and passed on this change.
 */
describe("the maintenance extensions a package consumer can name (spec 3.11)", () => {
  test("MaintenancePreview, the widened spec and the two optional provider methods", async () => {
    const preview: MaintenancePreview = {
      summary: "Loads orders.",
      facts: [{ label: "Rows", value: "1200" }],
      refusal: "Not now.",
      note: "possibly several seconds old",
    };
    const spec: MaintenanceOperationSpec = {
      label: "Load Object",
      perEntity: true,
      global: false,
      confirmation: "typed-target",
      preview: true,
    };
    const previewMaintenance: NonNullable<DatabaseProvider["previewMaintenance"]> = async (_type, path) => ({
      ...preview,
      summary: `Loads ${path.join(".")}.`,
    });
    const engineUser: NonNullable<DatabaseProvider["engineUser"]> = () => "reader";

    expect(await previewMaintenance("compact", ["app", "orders"])).toEqual({
      ...preview,
      summary: "Loads app.orders.",
    });
    expect(engineUser()).toBe("reader");
    expect(spec.confirmation).toBe("typed-target");
  });
});
