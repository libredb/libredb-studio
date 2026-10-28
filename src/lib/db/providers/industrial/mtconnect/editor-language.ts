import type { EditorLanguageContribution } from "@/lib/db/editor-language/types";
import { MTC_CONSOLE_DIALECT, MTC_CONSOLE_ROUTES } from "./routes";

/**
 * MTConnect's request line, drawn by the shared console over the route table the guard runs. `MTC_CONSOLE_ROUTES` is
 * derived from that table rather than written again, so the editor cannot offer a route or a query key the provider
 * refuses (#1722).
 *
 * NO FORMATTER: the console formatter is the HTTP grammar's, which writes a method, a route and a JSON body, and this
 * dialect has no body at all. The SQL and JSON formatters both rewrite a URL line.
 *
 * The `-alt` step of the steel grey the `industrial/` family carries, its identity hue everywhere else in the product.
 * Its nearest neighbour is kubectl's teal-alt at 0.086 in OKLab in light and Oxia's purple-alt at 0.111 in dark, and it
 * is none of the rail's three status hues.
 */
export const MTCONNECT_EDITOR_LANGUAGE = Object.freeze<EditorLanguageContribution>({
  monacoId: "mtconnect",
  console: Object.freeze({ spec: MTC_CONSOLE_DIALECT, routes: MTC_CONSOLE_ROUTES }),
  accent: "border-hue-slate-alt/40",
});
