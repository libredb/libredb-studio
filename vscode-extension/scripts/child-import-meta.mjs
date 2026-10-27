// Injected into the child bundle (CHILD_IMPORT_META in bundle-checks.mjs): the child's own file URL, which the define
// puts where a bundled driver reads import.meta.url. It runs inside the bundle, after its "use strict".
import { pathToFileURL } from "node:url";

export const libredbImportMetaUrl = pathToFileURL(__filename).href;
