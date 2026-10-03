import type { ConsoleDialectSpec, RouteClass, RouteSpec } from "./dialect";
import { ConsoleRefusal, parseConsole } from "./parser";

/**
 * The class of the route a console text runs, or `"refused"` when the grammar refuses it (vector-family spec 3.4).
 *
 * It reads the route table only, so it cannot see a body rule: each provider's `guard.ts` composes `parseConsole`
 * with its own phase 0 request rules, and that composition is the provider's browser verdict.
 */
export function classifyConsole(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec[],
  text: string,
): RouteClass | "refused" {
  try {
    return parseConsole(spec, routes, text).route.class;
  } catch (error) {
    if (error instanceof ConsoleRefusal) return "refused";
    throw error;
  }
}
