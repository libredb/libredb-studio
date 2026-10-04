/**
 * `cytoscape-fcose` 2.2.0 ships no type declarations (its package.json has no
 * `types` field and the package holds no `.d.ts`). It is a Cytoscape extension:
 * a CommonJS function passed to `cytoscape.use()`, which is the shape
 * `cytoscape`'s own typings give as `Ext` for exactly this case.
 */
declare module "cytoscape-fcose" {
  import type { Ext } from "cytoscape";
  const fcose: Ext;
  export default fcose;
}
