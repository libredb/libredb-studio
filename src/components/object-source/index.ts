/**
 * What a SHELL imports from the object source package, and nothing else.
 *
 * The folder's own modules import each other by path and the tests import the unit under test
 * by path, so a re-export here earns its place only by having a consumer OUTSIDE this
 * directory: both shells mount `ObjectSourceView`, declare their tab state with
 * `ObjectSourcePatch`, and the embedded shell builds an `ObjectSourceReader` from its host's
 * method while the standalone one falls through to `httpSourceReader`.
 *
 * `sourceCaption` is deliberately absent. It is imported by path inside this folder and has no
 * consumer outside it, and `object-tree/index.ts` records what happens otherwise: the required
 * `knip` check named eighteen re-exported lines there as reaching nobody, and a barrel that
 * re-exports everything cannot be read as a statement about what the outside uses (#789).
 */
export { ObjectSourceView, type ObjectSourcePatch, type ObjectSourceViewProps } from "./ObjectSourceView";
export { httpSourceReader, isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
