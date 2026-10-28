/**
 * The MQTT dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the shared generator pieces.
 */
import { objectSegment } from "@/lib/db/query-generators/shared";
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * MQTT has no query console at all: its surface is the Keys panel, and a declared key-browser kind opens a topic's
 * value in its Source tab rather than a generated read, so these are reached only by a path that asks for text where
 * there is none. They answer a sentence saying so, never a statement, because a statement would be a command this
 * provider cannot send.
 */
export const MQTT_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path) => `// MQTT has no query console. ${objectSegment(path)} opens in its Source tab from the Keys panel.`,
  select: (path) => `// MQTT has no query console. ${objectSegment(path)} opens in its Source tab from the Keys panel.`,
});
