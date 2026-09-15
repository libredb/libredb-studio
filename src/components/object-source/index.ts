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
 * The apply seam's three names earn their place the same way (#789 Phase 3), and BOTH SHELLS NOW
 * NAME THEM. The standalone one builds its `onApply` from `httpSourceApplier`
 * (`src/components/Studio.tsx`), the embedded one builds an `ObjectSourceApplier` from its host's
 * `objectEditor` exactly as it builds a reader from the host's source method
 * (`src/workspace/hooks/use-connection-adapter.ts`, mounted at `src/workspace/StudioWorkspace.tsx`),
 * and both tell an expired plan apart from a failure by reading `ObjectEditRequestError`'s `code`
 * (`src/components/object-source/ObjectSourceView.tsx`). RE-MEASURED at this commit:
 * `grep -rnE "httpSourceApplier|objectEditor|sourceApplier" src/` answers thirteen lines outside
 * this directory. An earlier revision of this paragraph said it found nothing and that both shells
 * landed in later waves, which was read off this same grep before they did; the barrel test in
 * `tests/unit/components/object-source-applier.test.ts` is still worth its place, because it is
 * what makes a dropped line here fail on the line itself rather than in whichever shell notices
 * first. Nothing else from `source-applier.ts` is re-exported: `postJson` and the bound helpers are
 * this folder's own.
 */
export { ObjectSourceView, type ObjectSourcePatch } from "./ObjectSourceView";
export { httpSourceApplier, ObjectEditRequestError, type ObjectSourceApplier } from "./source-applier";
export { isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
