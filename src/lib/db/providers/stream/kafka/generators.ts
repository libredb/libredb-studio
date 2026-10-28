/**
 * The Kafka dialect's generators (#1088, section 3.3), collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the shared generator pieces.
 */
import { objectSegment } from "@/lib/db/query-generators/shared";
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * Kafka reads a topic through a JSON read request (#1088 3.3), and the name goes through JSON.stringify with the rest,
 * so no topic name leaves its string. "Generate Query" writes ONE read request, because the tab's whole buffer is sent
 * as one request (`handleGenerateSelect` in use-tab-manager.ts) and JSON has no comments to hold the other forms: it
 * names a partition and reads it from its earliest offset, which exists on any retention, and the result's `offset`
 * column shows the offsets the `{"offset": n}` form takes. The offset and timestamp forms are documented in
 * docs/providers/kafka.md. The columns are the fields each message comes back with, not keys of the request, so none
 * is written. Both keep their own bound, the request's `limit`: 50, the click's and the request's default (#1088).
 */
export const KAFKA_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path) => JSON.stringify({ topic: objectSegment(path), from: "latest", limit: 50 }, null, 2),
  select: (path) => JSON.stringify({ topic: objectSegment(path), partition: 0, from: "earliest", limit: 50 }, null, 2),
});
