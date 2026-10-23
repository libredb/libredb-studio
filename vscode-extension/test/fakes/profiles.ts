// Part 2's two saved entries, and the same two connections as connection/test and connection/open carry them,
// written out rather than computed, for every connection test to share. The secret values are built at run time from
// TEST_PASSWORD, so no credential literal sits in the repository for a secret scanner to report.
import type { ProfileEntry } from "../../src/host/connections/profile";
import type { WireConnection } from "../../src/protocol";
import { TEST_PASSWORD } from "./credentials";

export const PG: ProfileEntry = {
  id: "1kq2v7x93j0ab",
  name: "shop",
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "app",
  database: "shop",
  createdAt: "2026-10-20T10:14:03.512Z",
  secretFields: ["password"],
};

export const MONGO: ProfileEntry = {
  id: "3f9wz0c1m2rt",
  name: "orders",
  type: "mongodb",
  database: "orders",
  ssl: { mode: "verify-system" },
  createdAt: "2026-10-20T10:20:41.007Z",
  secretFields: ["connectionString"],
};

export const SRV = `mongodb+srv://app:${TEST_PASSWORD}@cluster0.example.net/orders`;

export const wirePg: WireConnection = {
  id: "1kq2v7x93j0ab",
  name: "shop",
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "app",
  password: TEST_PASSWORD,
  database: "shop",
  createdAt: "2026-10-20T10:14:03.512Z",
};

export const wireMongo: WireConnection = {
  id: "3f9wz0c1m2rt",
  name: "orders",
  type: "mongodb",
  database: "orders",
  ssl: { mode: "verify-system" },
  connectionString: SRV,
  createdAt: "2026-10-20T10:20:41.007Z",
};
