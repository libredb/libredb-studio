import { formatConsole } from "@/lib/db/console/format";
import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { WEAVIATE_CONSOLE, WEAVIATE_ROUTES } from "./routes";

/**
 * The Weaviate console request (#1566), registered and formatted as Qdrant's is.
 *
 * Lime's `-alt` step: no guard reads a Weaviate request, so its draft stands beside the amber "not checked" chip,
 * which rules out amber itself, yellow and orange, and red is ruled out as a failure hue. Of the chromatic declared
 * steps left, lime-alt stands furthest from every status hue and every other language in both palettes (0.0608 in
 * OKLab from InfluxQL's green, its nearest, in light), measured; the greys mauve and taupe stand further, but a grey
 * border reads as no accent.
 */
export const WEAVIATE_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "weaviate",
  console: Object.freeze({ spec: WEAVIATE_CONSOLE, routes: WEAVIATE_ROUTES }),
  format: (text: string) => formatConsole(WEAVIATE_CONSOLE, text),
  accent: "border-hue-lime-alt/40",
});
