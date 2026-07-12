// Classic worker wrapper: elk-worker registers its own onmessage handler on
// the worker global. Referenced via `new Worker(new URL("./elk.worker.ts",
// import.meta.url))` in layout-engine.ts so both webpack and Turbopack emit a
// proper worker chunk.
import "elkjs/lib/elk-worker.min.js";
