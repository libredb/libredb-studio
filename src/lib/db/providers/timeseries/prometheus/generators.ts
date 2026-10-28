/**
 * The PromQL language's generators (#1085), collected as its row by `LANGUAGE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the PromQL builder and the shared pieces.
 */
import { commentName, objectSegment } from "@/lib/db/query-generators/shared";
import type { LanguageGenerators } from "@/lib/db/query-generators/types";
import { metricSelector } from "./promql";

/**
 * A metric is addressed by a SELECTOR, never by a quoted path: the bare name where the lexer reads it as one and a
 * `__name__` matcher for every other name, both written by `metricSelector`, the one PromQL builder (#1085 S4).
 *
 * A tree click writes the instant selector, which evaluates at now and answers one row per series; the provider caps
 * the series (#1085, section 5.4), so no bound is written, and PromQL has no statement terminator to append.
 *
 * Generate Query writes exactly ONE runnable expression, the metric's selector on the last line, and the two range
 * forms #1085 section 5.1 teaches as `#` comments above it. PromQL reads `#` as a comment to the end of the line, so
 * the whole buffer, run as it stands, is that one expression. The name reaches its comment through `commentName`,
 * which escapes CR and LF; the selector reaches its comments already escaped, because `metricSelector` writes any name
 * that is not a bare identifier as a JSON-quoted `__name__` matcher. So neither can end a comment line early and turn
 * its remainder into a second expression. The label columns are not read: a label name is server text too, and
 * nothing here needs one. The rate form is written whatever the metric's type, because nothing a generator receives
 * says it, so its comment says it is the form for a counter. PromQL names are never SQL-quoted, so the row declares no
 * quoting of its own.
 */
export const PROMQL_GENERATORS: LanguageGenerators = Object.freeze<LanguageGenerators>({
  table: (path: readonly string[]) => metricSelector(objectSegment(path)),
  select: (path: readonly string[]) => {
    const tableName = objectSegment(path);
    const selector = metricSelector(tableName);
    return [
      `# PromQL for the metric ${commentName(tableName)}. Only the last line runs: a line starting with # is a comment.`,
      "# To try a form below, select it after its # and use Run Selected.",
      "#",
      "# Every raw sample from the last five minutes, one column per series:",
      `#   ${selector}[5m]`,
      "# For a counter: its per-second rate over the last hour, one row a minute:",
      `#   rate(${selector}[5m])[1h:1m]`,
      "#",
      "# Every series of the metric as of now, one row per series:",
      selector,
    ].join("\n");
  },
});
