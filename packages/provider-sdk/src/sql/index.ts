/**
 * The SQL grammar facts: the `SqlGrammar` type and its member types, the compatibility default
 * `DEFAULT_SQL_GRAMMAR`, and `hashRunIsAmbiguous` (docs/providers/CONTRACT.md, "SQL grammar"). Studio's SQL readers
 * and every engine's grammar row import them from `@libredb/provider-sdk/sql` by name.
 */
export {
  type BlockCommentGrammar,
  type BracketGrammar,
  type ConfirmCodeForm,
  type ConfirmFormWhen,
  DEFAULT_SQL_GRAMMAR,
  type HashGrammar,
  hashRunIsAmbiguous,
  type ProceduralBlockGrammar,
  type ScriptGrammar,
  type SqlGrammar,
} from "./grammar";
