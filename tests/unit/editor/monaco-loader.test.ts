import { afterEach, describe, expect, test } from "bun:test";
import { configureMonacoLoader, DEFAULT_MONACO_VS_PATH, resolveMonacoVsPath } from "@/lib/editor/monaco-loader";

// ---------------------------------------------------------------------------
// Fake loader — stands in for @monaco-editor/react's module-level loader,
// recording the config it is handed instead of fetching Monaco.
// ---------------------------------------------------------------------------

function createFakeLoader() {
  const calls: Array<{ paths?: { vs?: string } }> = [];
  return {
    calls,
    config: (config: { paths?: { vs?: string } }) => {
      calls.push(config);
    },
  };
}

const ENV_KEY = "NEXT_PUBLIC_MONACO_VS_PATH";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveMonacoVsPath", () => {
  test("defaults to the self-hosted /monaco/vs path", () => {
    expect(resolveMonacoVsPath(undefined)).toBe("/monaco/vs");
    expect(DEFAULT_MONACO_VS_PATH).toBe("/monaco/vs");
  });

  test("uses an explicit override path", () => {
    expect(resolveMonacoVsPath("/studio-assets/monaco/vs")).toBe("/studio-assets/monaco/vs");
  });

  test("strips trailing slashes from an override", () => {
    expect(resolveMonacoVsPath("/assets/monaco/vs//")).toBe("/assets/monaco/vs");
  });

  test("falls back to the default when the override is blank", () => {
    expect(resolveMonacoVsPath("   ")).toBe(DEFAULT_MONACO_VS_PATH);
  });
});

describe("configureMonacoLoader", () => {
  test("points the loader at the self-hosted path instead of a CDN", () => {
    const fakeLoader = createFakeLoader();

    configureMonacoLoader(fakeLoader);

    expect(fakeLoader.calls).toEqual([{ paths: { vs: "/monaco/vs" } }]);
  });

  test("honours a NEXT_PUBLIC_MONACO_VS_PATH override", () => {
    process.env[ENV_KEY] = "/embedded/monaco/vs";
    const fakeLoader = createFakeLoader();

    configureMonacoLoader(fakeLoader);

    expect(fakeLoader.calls).toEqual([{ paths: { vs: "/embedded/monaco/vs" } }]);
  });
});
