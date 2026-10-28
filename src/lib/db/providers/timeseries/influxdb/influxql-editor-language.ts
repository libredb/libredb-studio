import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { influxqlCompletionSchemaOf, registerInfluxqlCompletionProvider } from "./influxql-editor-completions";
import { registerInfluxqlLanguage } from "./influxql-editor-syntax";

/**
 * InfluxQL (InfluxDB spec 6.7), drawn over the provider's own lexer. No formatter (I12).
 *
 * Completion reads sources and keys from the schema objects' `[database, measurement]` paths and typed columns, and
 * every insert is quoted by the provider's own quoter, so an inserted name passes the read policy.
 *
 * Green (I12, R11). Of the hues no other language or status takes, green is the one whose neighbouring status hue
 * (emerald, the `checked` chip) never stands beside an InfluxQL draft, because no guard reads InfluxQL and its draft
 * always carries the amber `not checked` chip.
 */
export const INFLUXQL_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "influxql",
  register: registerInfluxqlLanguage,
  completions: (monaco, context) =>
    registerInfluxqlCompletionProvider(monaco, influxqlCompletionSchemaOf(context.schemaObjects)),
  accent: "border-hue-green/40",
});
