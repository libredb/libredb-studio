// Registers tsx for the unit leg with tsconfig.test.json, whose paths send "vscode" to the fake
// and "@/" to the repository's src/.
// The ESM hooks serve a test's dynamic import(), which Node resolves through its ESM loader even from CommonJS.
// A CommonJS file, so require() is its only import form.
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");

process.env.TSX_TSCONFIG_PATH = path.join(__dirname, "..", "..", "tsconfig.test.json");
require("tsx/cjs");
require("tsx/esm/api").register();
