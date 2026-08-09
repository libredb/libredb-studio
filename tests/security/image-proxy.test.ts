import { describe, expect, test } from "bun:test";
import nextConfig from "../../next.config";

describe("next image optimizer exposure", () => {
  test("declares no images configuration at all", () => {
    // `/_next/*` is public in src/proxy.ts, so any configured remote pattern turns
    // /_next/image into an unauthenticated server-side fetch of an attacker-chosen URL.
    // Nothing in the app imports next/image, so the correct configuration is none at all.
    expect(nextConfig.images).toBeUndefined();
  });
});
