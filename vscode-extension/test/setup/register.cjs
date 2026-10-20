// Registers tsx for the unit leg with tsconfig.test.json, whose paths send "vscode" to the fake
// and "@/" to the repository's src/.
// The ESM hooks serve a test's dynamic import(), which Node resolves through its ESM loader even from CommonJS.
// A CommonJS file, so require() is its only import form.
/* eslint-disable @typescript-eslint/no-require-imports */

// registerShutdownHandlers in src/lib/db/factory.ts runs at the factory's module load unless NODE_ENV is "test",
// and would give the test process a SIGTERM and a SIGINT handler that end it; set before anything loads the factory.
// The integration leg requires this file too, which is harmless there: it forks its children with NODE_ENV=production.
process.env.NODE_ENV = "test";

const path = require("node:path");

process.env.TSX_TSCONFIG_PATH = path.join(__dirname, "..", "..", "tsconfig.test.json");
require("tsx/cjs");
require("tsx/esm/api").register();
