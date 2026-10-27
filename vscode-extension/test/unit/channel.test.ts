import assert from "node:assert/strict";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENABLED_PROVIDERS, HELD_BACK } from "../../src/host/channel";

describe("ENABLED_PROVIDERS", () => {
  it("is every external engine HELD_BACK does not hold, in EXTERNAL_DATABASE_TYPES order", () => {
    assert.deepEqual(
      ENABLED_PROVIDERS,
      EXTERNAL_DATABASE_TYPES.filter((type) => !Object.hasOwn(HELD_BACK, type)),
    );
  });

  it("holds back the engines whose driver the VSIX does not ship", () => {
    assert.deepEqual(Object.keys(HELD_BACK).sort(), ["db2", "duckdb", "oracle"]);
    for (const reason of Object.values(HELD_BACK)) assert.ok(reason.length > 0);
  });

  it("names only external type ids the factory knows, enabled or held back", () => {
    assert.deepEqual(
      [...ENABLED_PROVIDERS, ...Object.keys(HELD_BACK)].filter(
        (type) => !EXTERNAL_DATABASE_TYPES.includes(type as (typeof EXTERNAL_DATABASE_TYPES)[number]),
      ),
      [],
    );
  });
});
