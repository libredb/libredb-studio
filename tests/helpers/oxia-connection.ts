import { OXIA_TYPE } from "@/lib/db/providers/keyvalue/oxia/constants";
import type { DatabaseConnection } from "@/lib/types";

/** An Oxia connection to localhost:6648, namespace default, no token; `overrides` replaces fields. */
export function oxiaConnection(overrides?: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    id: "oxia-test",
    name: "Oxia test",
    type: OXIA_TYPE,
    host: "localhost",
    port: 6648,
    createdAt: new Date(0),
    ...overrides,
  };
}
