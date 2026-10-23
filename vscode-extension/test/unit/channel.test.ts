import assert from "node:assert/strict";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { ENABLED_PROVIDERS } from "../../src/host/channel";

describe("ENABLED_PROVIDERS", () => {
  it("is the four v0 engines, in the order the child's environment lists them", () => {
    assert.deepEqual(ENABLED_PROVIDERS, ["postgres", "mssql", "mysql", "mongodb"]);
  });

  it("names only external type ids the factory knows", () => {
    assert.deepEqual(
      ENABLED_PROVIDERS.filter((type) => !EXTERNAL_DATABASE_TYPES.includes(type)),
      [],
    );
  });
});
