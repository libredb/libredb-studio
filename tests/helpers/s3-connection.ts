import { S3_TYPE } from "@/lib/db/providers/objectstore/s3/constants";
import type { DatabaseConnection } from "@/lib/types";

/**
 * A signed S3 connection to localhost:9000 with no pinned bucket; `overrides` replaces fields. The key pair is a
 * named stand-in, never a vendor's published default, so a test can prove that a sentence never echoes it.
 */
export function s3Connection(overrides?: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: "s3-test",
    name: "S3 test",
    type: S3_TYPE,
    host: "localhost",
    port: 9000,
    user: "AKIDTESTKEY",
    password: "test-secret-key",
    createdAt: new Date(0),
    ...overrides,
  };
}
