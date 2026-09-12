/**
 * What a SHELL imports from the object tree, and nothing else.
 *
 * The folder's own modules import each other by path, and the tests import the unit under
 * test by path, so a re-export here earns its place only by having a consumer outside this
 * directory: `Sidebar` mounts `ObjectTree`, and both shells declare their row handlers with
 * the type below. `flatTargetName` stood here too, narrowing an object to its LABEL for the
 * four consumers that looked their target up by name; Task 35 moved them onto the address and
 * deleted it, because a string-splitting name helper left alive with no caller is how that
 * defect comes back (#789). The barrel carried the whole folder until the required `knip`
 * check named eighteen of those lines as reaching nobody (#789); a barrel that re-exports
 * everything cannot be read as a statement about what the outside uses.
 */
export { ObjectTree } from "./ObjectTree";
export type { ObjectSource } from "./use-tree-nodes";
export { type TreeRowActionHandlers } from "./row-actions";
