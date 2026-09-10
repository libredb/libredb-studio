import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as authEnv from "@/lib/config/auth-env";
import * as authBootstrap from "@/lib/auth-bootstrap";
import {
  STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE,
  STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE,
} from "@/lib/storage/encryption";

const ROOT = path.resolve(import.meta.dir, "../../../..");

describe("minimum-length message guard", () => {
  test("all five operator messages quote the enforced minimum", () => {
    const messages = [
      authEnv.JWT_SECRET_MISSING_MESSAGE,
      authEnv.JWT_SECRET_TOO_SHORT_MESSAGE,
      STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE,
      STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE,
      authBootstrap.BOOTSTRAP_JWT_SECRET_INVALID_MESSAGE,
    ];
    for (const message of messages) {
      expect(message).toContain(`at least ${authEnv.JWT_SECRET_MIN_LENGTH} char`);
    }
  });

  test("minimum-length messages contain no literal numeric floor and keep each template on one line", () => {
    const files = ["src/lib/config/auth-env.ts", "src/lib/storage/encryption.ts", "src/lib/auth-bootstrap.ts"];
    const templates = files.flatMap((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source).not.toMatch(/at least \d+ chars?/);
      return [...source.matchAll(/`[^`]*at least \$\{JWT_SECRET_MIN_LENGTH\}[^`]*`/g)];
    });
    expect(templates).toHaveLength(5);
    for (const [template] of templates) expect(template).not.toMatch(/[\r\n]/);
  });

  test("the development fallback meets the enforced minimum", () => {
    expect(authEnv.DEV_FALLBACK_SECRET.length).toBeGreaterThanOrEqual(authEnv.JWT_SECRET_MIN_LENGTH);
  });
});
