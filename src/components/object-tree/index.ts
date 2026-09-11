/**
 * What a SHELL imports from the object tree, and nothing else.
 *
 * The folder's own modules import each other by path, and the tests import the unit under
 * test by path, so a re-export here earns its place only by having a consumer outside this
 * directory: `Sidebar` mounts `ObjectTree`, and both shells call `flatTargetName` with the
 * handler type beside it. The barrel carried the whole folder until the required `knip`
 * check named eighteen of those lines as reaching nobody (#789); a barrel that re-exports
 * everything cannot be read as a statement about what the outside uses.
 */
export { ObjectTree } from "./ObjectTree";
export { flatTargetName, type TreeRowActionHandlers } from "./row-actions";
