/**
 * The npx launcher sets the Kubernetes provider's loopback plain-HTTP flag only when the server binds to this machine,
 * and keeps a value the operator set.
 */
import { describe, expect, test } from "bun:test";
import { isLoopbackBind, LOOPBACK_PLAINTEXT_FLAG, loopbackPlaintextEnv } from "../../bin/lib/launcher-utils.mjs";

describe("isLoopbackBind", () => {
  test.each(["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST", " 127.0.0.1 "])(
    "%s is this machine",
    (host) => {
      expect(isLoopbackBind(host)).toBe(true);
    },
  );
  test.each(["0.0.0.0", "::", "192.168.1.5", "studio.internal", "127.0.0.1.example", "", undefined])(
    "%s is not",
    (host) => {
      expect(isLoopbackBind(host)).toBe(false);
    },
  );
});

describe("loopbackPlaintextEnv", () => {
  test("names the flag the provider reads", () => {
    expect(LOOPBACK_PLAINTEXT_FLAG).toBe("KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT");
  });
  test("sets it on a loopback bind with no operator value", () => {
    expect(loopbackPlaintextEnv("127.0.0.1", undefined)).toEqual({ KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT: "true" });
    expect(loopbackPlaintextEnv("::1", "  ")).toEqual({ KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT: "true" });
  });
  test("leaves it unset on a bind other machines can reach", () => {
    expect(loopbackPlaintextEnv("0.0.0.0", undefined)).toEqual({});
  });
  test("keeps the operator's own value, off included", () => {
    expect(loopbackPlaintextEnv("127.0.0.1", "false")).toEqual({});
  });
});
