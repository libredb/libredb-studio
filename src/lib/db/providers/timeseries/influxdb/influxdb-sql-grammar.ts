import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How InfluxDB (InfluxQL) statement text is read: grammar, SQL text, redaction, update target and completion. */
export const INFLUXDB_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `influxdb` takes one InfluxQL statement (InfluxDB spec 5.7), which is not SQL text either: InfluxQL strings
  // escape with a backslash, `/.../` is a regex where the parser asks for one, and a `--` comment ends at a lone
  // `\r`, so a SQL span reader misreads where a literal ends. The provider reads the text with its own lexer
  // (`src/lib/db/providers/timeseries/influxdb/influxql-lexer.ts`) and refuses every write before sending it.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
