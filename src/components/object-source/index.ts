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
 *
 * The apply seam's three names are here for the same test, and the test is passed by INTENT and
 * not yet by a consumer (#789 Phase 3). Both shells are to name them: the standalone one will
 * build its `onApply` from `httpSourceApplier`, the embedded one will build an
 * `ObjectSourceApplier` from its host's `objectEditor` exactly as it builds a reader from the
 * host's source method, and both will tell an expired plan apart from a failure by reading
 * `ObjectEditRequestError`'s `code`. MEASURED in fix round 1 at this commit:
 * `grep -rnE "httpSourceApplier|objectEditor|sourceApplier" src/` finds nothing outside this
 * directory, because both shells land in later waves of this phase, so the only consumer through
 * this file today is the barrel test in `tests/unit/components/object-source-applier.test.ts`,
 * which exists so that a dropped line here fails now rather than in a wave nobody is reading this
 * file. Nothing else from `source-applier.ts` is re-exported: `postJson` and the bound helpers are
 * this folder's own.
 */
export { ObjectSourceView, type ObjectSourcePatch } from "./ObjectSourceView";
export { httpSourceApplier, ObjectEditRequestError, type ObjectSourceApplier } from "./source-applier";
export { isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
