// elkjs ships elk-worker.d.ts for elk-worker.js but nothing for the minified
// twin; the import is side-effect-only (registers the worker onmessage).
declare module "elkjs/lib/elk-worker.min.js";
