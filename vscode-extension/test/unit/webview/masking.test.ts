import assert from "node:assert/strict";
import { DEFAULT_MASKING_CONFIG } from "@/lib/data-masking";
import { EXTENSION_MASKING_CONFIG } from "../../../src/webview/masking";

describe("the extension's masking configuration", () => {
  it("is the default configuration with both rights given to the user role", () => {
    assert.deepEqual(EXTENSION_MASKING_CONFIG, {
      ...DEFAULT_MASKING_CONFIG,
      roleSettings: { ...DEFAULT_MASKING_CONFIG.roleSettings, user: { canToggle: true, canReveal: true } },
    });
  });

  it("leaves DEFAULT_MASKING_CONFIG unchanged", () => {
    assert.notDeepEqual(DEFAULT_MASKING_CONFIG.roleSettings.user, { canToggle: true, canReveal: true });
    assert.notEqual(EXTENSION_MASKING_CONFIG.roleSettings, DEFAULT_MASKING_CONFIG.roleSettings);
  });
});
