import type { ConsoleDialectSpec, RouteClass, RouteSpec } from "./dialect";

/**
 * The console's route completions and its route list (vector-family spec 3.4).
 *
 * A completion inserts the route template as plain text, braces included: one accepted unedited meets the
 * parser's template refusal, "Replace {name} with ...", rather than running against an object literally named
 * after the placeholder. The template goes in alone where the dialect takes the short form, and after the
 * dialect's prefix where it does not; the route whose template is empty is always the prefix, so no completion
 * is blank and each one, its placeholders filled, is a route the parser reads.
 */

export interface RouteCompletion {
  readonly label: string;
  readonly insertText: string;
  readonly route: RouteSpec;
}

/** Every route of the table under `method`, in table order, as the editor offers them after the method. */
export function routeCompletions(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec[],
  method: string,
): readonly RouteCompletion[] {
  if (!spec.methods.includes(method)) return [];
  return routes
    .filter((route) => route.method === method)
    .map((route) => {
      const text = spec.shortForm && route.template !== "" ? route.template : `${spec.pathPrefix}${route.template}`;
      return { label: text, insertText: text, route };
    });
}

/** The routes of the given classes as `METHOD template`, in table order, for a provider's statement-language sentence. */
export function routeListText(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec[],
  classes: readonly RouteClass[],
): string {
  return routes
    .filter((route) => spec.methods.includes(route.method) && classes.includes(route.class))
    .map((route) => `${route.method} ${route.template}`)
    .join(", ");
}
