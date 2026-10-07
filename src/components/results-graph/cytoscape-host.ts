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
import { ChunkLoadError } from "@/lib/lazy";

/** The library's own types, re-exported so the rest of the view never names the package. */
export type { Core, ElementDefinition, EventObject, StylesheetJson } from "cytoscape";

/** Builds one Cytoscape instance from its options. */
export type CreateCytoscape = (options: CytoscapeOptions) => Core;

/** Resolves to a `CreateCytoscape`; the view's injectable factory prop has this type. */
export type CytoscapeFactory = () => Promise<CreateCytoscape>;

export interface FcoseLayoutOptions extends BaseLayoutOptions {
  readonly name: "fcose";
  readonly randomize: boolean;
  readonly animate: boolean;
  readonly fit: boolean;
  readonly nodeDimensionsIncludeLabels: boolean;
  readonly packComponents: boolean;
  readonly nodeSeparation: number;
  readonly idealEdgeLength: number;
  readonly tilingPaddingVertical: number;
  readonly tilingPaddingHorizontal: number;
}

/** How far the wheel, the toolbar and the keys may zoom. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
/** The most a fit zooms in: at 1 a node and its caption are drawn at their stylesheet sizes. */
export const MAX_FIT_ZOOM = 1;
/** Room left around the graph when it is fitted. */
export const FIT_PADDING = 30;

/**
 * Loads both packages and registers fcose. Registering again on a later call
 * replaces the layout with the same one, so a remounted view may call it freely.
 * A package that cannot be imported is a chunk that never arrived, so that
 * failure, and only that one, is a `ChunkLoadError`.
 */
export const loadCytoscape: CytoscapeFactory = async () => {
  const [{ default: cytoscape }, { default: fcose }] = await Promise.all([
    import("cytoscape"),
    import("cytoscape-fcose"),
  ]).catch((error: unknown) => {
    throw ChunkLoadError.from(error);
  });
  cytoscape.use(fcose);
  return (options) => cytoscape(options);
};

/**
 * The layout the view runs, first and on Re-layout. Randomized placement lets
 * fcose untangle any input; with animation off, a run has finished when `run()`
 * returns, which keeps the view and its tests deterministic about when nodes
 * have their positions.
 *
 * The layout leaves the viewport alone (`fit: false`); the view calls `fitGraph`
 * after a run. Spacing counts a node's caption as part of the node, and the
 * tiling paddings are the room between nodes that have no relationship, which
 * fcose sets out in a grid. `packComponents` asks for disconnected components to
 * be packed apart; fcose does that only when the layout-utilities extension is
 * registered, which this host does not load, so today it states the intent and
 * the separation comes from the other options.
 */
export function fcoseLayout(): FcoseLayoutOptions {
  return {
    name: "fcose",
    randomize: true,
    animate: false,
    fit: false,
    nodeDimensionsIncludeLabels: true,
    packComponents: true,
    nodeSeparation: 75,
    idealEdgeLength: 60,
    tilingPaddingVertical: 16,
    tilingPaddingHorizontal: 16,
  };
}

/**
 * Fits the whole graph in the canvas, never zooming in past `MAX_FIT_ZOOM`: a
 * graph smaller than the canvas is drawn at its own size in the middle, where an
 * uncapped fit would blow three nodes up into discs that fill the panel.
 */
export function fitGraph(cy: Core): void {
  cy.fit(undefined, FIT_PADDING);
  if (cy.zoom() <= MAX_FIT_ZOOM) return;
  cy.zoom(MAX_FIT_ZOOM);
  cy.center();
}
