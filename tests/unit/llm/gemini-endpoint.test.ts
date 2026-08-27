import { describe, test, expect } from "bun:test";
import {
  GEMINI_DEFAULT_API_VERSION,
  resolveGeminiChatBaseUrl,
  resolveGeminiSdkBaseUrl,
} from "@/lib/llm/utils/gemini-endpoint";

// One `LLM_API_URL` is read two ways because the two installed SDKs disagree about
// whether the version segment belongs to the base URL. These tests pin the seam;
// tests/unit/llm/gemini-provider.test.ts and tests/isolated/agent-model-adapter.test.ts
// pin that each consumer actually reaches the resolved host.

describe("resolveGeminiChatBaseUrl", () => {
  test("returns undefined when nothing is configured, so the SDK keeps its Google default", () => {
    expect(resolveGeminiChatBaseUrl(undefined)).toBeUndefined();
  });

  test("treats a blank or whitespace value as unconfigured", () => {
    expect(resolveGeminiChatBaseUrl("")).toBeUndefined();
    expect(resolveGeminiChatBaseUrl("   ")).toBeUndefined();
  });

  test("strips the version segment, because the SDK appends the version itself", () => {
    expect(resolveGeminiChatBaseUrl("https://proxy.example.com/v1beta")).toBe("https://proxy.example.com");
    expect(resolveGeminiChatBaseUrl("https://proxy.example.com/v1")).toBe("https://proxy.example.com");
    expect(resolveGeminiChatBaseUrl("https://proxy.example.com/v1alpha")).toBe("https://proxy.example.com");
  });

  test("passes a bare origin through, trailing slashes and surrounding space removed", () => {
    expect(resolveGeminiChatBaseUrl("  https://proxy.example.com//  ")).toBe("https://proxy.example.com");
  });

  test("keeps a path prefix a proxy mounts the API under", () => {
    expect(resolveGeminiChatBaseUrl("https://gw.example.com/google/v1beta")).toBe("https://gw.example.com/google");
  });

  test("returns undefined when the version segment is all there was", () => {
    expect(resolveGeminiChatBaseUrl("/v1beta")).toBeUndefined();
  });
});

describe("resolveGeminiSdkBaseUrl", () => {
  test("returns undefined when nothing is configured, so the SDK keeps its Google default", () => {
    expect(resolveGeminiSdkBaseUrl(undefined)).toBeUndefined();
    expect(resolveGeminiSdkBaseUrl("  ")).toBeUndefined();
  });

  test("keeps a configured version segment rather than doubling it", () => {
    expect(resolveGeminiSdkBaseUrl("https://proxy.example.com/v1beta")).toBe("https://proxy.example.com/v1beta");
    expect(resolveGeminiSdkBaseUrl("https://proxy.example.com/v1alpha/")).toBe("https://proxy.example.com/v1alpha");
  });

  test("appends the default version to a bare origin", () => {
    expect(resolveGeminiSdkBaseUrl("https://proxy.example.com")).toBe(
      `https://proxy.example.com/${GEMINI_DEFAULT_API_VERSION}`,
    );
  });

  test("resolves the same host as the chat surface for either spelling", () => {
    const versioned = resolveGeminiSdkBaseUrl("https://proxy.example.com/v1beta");
    const bare = resolveGeminiSdkBaseUrl("https://proxy.example.com");
    expect(bare).toBe(versioned);
  });
});
