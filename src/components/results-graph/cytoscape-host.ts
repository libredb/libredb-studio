/**
 * The Cytoscape host: the one module that loads the graph canvas library
 *
 * `cytoscape` and its `cytoscape-fcose` layout are loaded here and nowhere else
 * (a test parses every source file to hold that), and only through a dynamic
 * `import()` that the view awaits inside an effect. So importing this module
 * loads neither package, and nothing touches `window` at module load or during
 * a server render.
 *
 * `loadCytoscape` is the view's default factory. The view takes the factory as a
 * prop, so a component test passes a fake or a `headless: true` instance instead,
 * with no module mock.
 */
import type { BaseLayoutOptions, Core, CytoscapeOptions } from "cytoscape";

/** Builds one Cytoscape instance from its options. */
export type CreateCytoscape = (options: CytoscapeOptions) => Core;

/** Resolves to a `CreateCytoscape`; the view's injectable factory prop has this type. */
export type CytoscapeFactory = () => Promise<CreateCytoscape>;

export interface FcoseLayoutOptions extends BaseLayoutOptions {
  readonly name: "fcose";
  readonly randomize: boolean;
  readonly animate: boolean;
}

/**
 * Loads both packages and registers fcose. Registering again on a later call
 * replaces the layout with the same one, so a remounted view may call it freely.
 */
export const loadCytoscape: CytoscapeFactory = async () => {
  const [{ default: cytoscape }, { default: fcose }] = await Promise.all([
    import("cytoscape"),
    import("cytoscape-fcose"),
  ]);
  cytoscape.use(fcose);
  return (options) => cytoscape(options);
};

/**
 * The layout the view runs, first and on Re-layout. Randomized placement lets
 * fcose untangle any input; with animation off, a run has finished when `run()`
 * returns, which keeps the view and its tests deterministic about when nodes
 * have their positions.
 */
export function fcoseLayout(): FcoseLayoutOptions {
  return { name: "fcose", randomize: true, animate: false };
}
