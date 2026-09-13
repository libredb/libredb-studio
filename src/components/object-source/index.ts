/**
 * What a SHELL imports from the object source package, and nothing else.
 *
 * The folder's own modules import each other by path and the tests import the unit under test
 * by path, so a re-export here earns its place only by having a consumer OUTSIDE this
 * directory: both shells mount `ObjectSourceView`, declare their tab state with
 * `ObjectSourcePatch`, and the embedded shell builds an `ObjectSourceReader` from its host's
 * method while the standalone one falls through to `httpSourceReader`.
 *
 * `sourceCaption`, `httpSourceReader` and `ObjectSourceViewProps` are deliberately absent, and
 * the last two were REMOVED after the required `knip` check named them. Each is imported by
 * path inside this folder, or by a test that names the module it lives in, and none has a
 * consumer that reaches it through this file: the standalone shell mounts `ObjectSourceView`
 * without passing a reader and the viewer falls through to `httpSourceReader` internally, so
 * the fall-through is not an outside edge. `object-tree/index.ts` records what happens
 * otherwise: knip named eighteen re-exported lines there as reaching nobody, and a barrel that
 * re-exports everything cannot be read as a statement about what the outside uses (#789).
 */
export { ObjectSourceView, type ObjectSourcePatch } from "./ObjectSourceView";
export { isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
