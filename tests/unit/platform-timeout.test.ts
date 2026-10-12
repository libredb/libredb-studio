/**
 * Unit tests for tests/helpers/platform-timeout.ts - the Windows-only raise a heavy test
 * applies to the bound it sets for itself.
 *
 * The whole point of the helper is the Windows branch, and the machine running this is not
 * Windows, so the platform is injected. The Linux and macOS cases are the paired control:
 * without them every case here would pass just as well for a helper that raised the bound
 * everywhere, which is the thing not wanted.
 */
import { describe, expect, test } from "bun:test";
import { platformTimeoutMs, WINDOWS_SLOW_FACTOR } from "../helpers/platform-timeout";
import { DEFAULT_FILE_TIMEOUT_MS, WINDOWS_PER_TEST_TIMEOUT_MS } from "../runner/options";

/** The bounds that actually pass through the helper today, as a per-test millisecond value. */
const BOUNDS_IN_USE = [40_000, 120_000];

describe("the Windows raise a self-bounded test applies", () => {
  test("Windows multiplies the bound, because its temp I/O costs an order of magnitude more", () => {
    expect(platformTimeoutMs(120_000, "win32")).toBe(120_000 * WINDOWS_SLOW_FACTOR);
  });

  test("Linux and macOS keep the bound they were given, so a real slowdown stays visible there", () => {
    expect(platformTimeoutMs(120_000, "linux")).toBe(120_000);
    expect(platformTimeoutMs(120_000, "darwin")).toBe(120_000);
  });

  test("the raised bound stays under the runner's per-file budget", () => {
    // At or above the budget the file's own kill fires first and the failure is reported
    // as a hang instead of as the test that ran long, which is what the per-test bound
    // exists to avoid.
    for (const bound of BOUNDS_IN_USE) {
      expect(platformTimeoutMs(bound, "win32")).toBeLessThan(DEFAULT_FILE_TIMEOUT_MS);
    }
  });

  test("the raised bound is above the per-test default the runner already gives Windows children", () => {
    // Below that default the helper would be lowering the timeout rather than raising it:
    // a test only sets its own bound because it needs more than the default.
    for (const bound of BOUNDS_IN_USE) {
      expect(platformTimeoutMs(bound, "win32")).toBeGreaterThan(WINDOWS_PER_TEST_TIMEOUT_MS);
    }
  });
});
