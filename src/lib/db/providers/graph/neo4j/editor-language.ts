import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { graphPolicyProfileOf } from "@/lib/db/graph-policy-profiles";
import { cypherCompletionSchemaOf, registerCypherCompletionProvider } from "./editor-completions";
import { registerCypherLanguage } from "./editor-syntax";

/**
 * Cypher (Neo4j spec 6.5), under the id `graph-cypher`, not `cypher`, which Monaco's own bundle registers. No
 * formatter.
 *
 * Completion (SR6) reads its names from the schema objects' kind-qualified paths, never from the SQL cache's lowercased
 * table names, and its CALL and SHOW allowlists from the connected engine's policy profile, looked up by type as the
 * SQL source gets its dialect.
 *
 * Purple (SR20): a hue no other language uses and none of the rail's three status hues. No guard reads Cypher, so its
 * draft stands beside the amber "not checked" chip.
 */
export const CYPHER_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "graph-cypher",
  register: registerCypherLanguage,
  completions: (monaco, context) =>
    registerCypherCompletionProvider(
      monaco,
      cypherCompletionSchemaOf(context.schemaObjects),
      graphPolicyProfileOf(context.databaseType),
    ),
  accent: "border-hue-purple/40",
});
