/**
 * Stage the package's one stylesheet, `dist/styles.css`, after tsup has built the JavaScript.
 *
 * The published JavaScript imports no stylesheet: tsup.config.ts loads every `.css` import as an empty module,
 * because Node cannot load a `.css` import and a host that imported the package under Node would fail on it. So
 * the CSS a host needs reaches it through the one documented import, `@libredb/studio/styles.css`, which this
 * script writes as two parts:
 *
 * - first the line `@import "@xyflow/react/dist/style.css";`, the ER diagram's base styles, which the diagram's
 *   own `import` brought before; the host's bundler resolves it from the package's location, and an `@import`
 *   redistributes none of xyflow's text;
 * - then `src/styles/theme.css`, the token stylesheet, unchanged.
 *
 * It exits 1 naming the file when `@xyflow/react/dist/style.css` does not resolve from this repository's install,
 * so the package never ships an `@import` of a stylesheet that is not there.
 *
 * It runs after `tsup`, which is `clean: true` and would otherwise delete it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "styles", "theme.css");
const target = join(root, "dist", "styles.css");
const XYFLOW_STYLESHEET = "@xyflow/react/dist/style.css";

if (!existsSync(source)) {
  console.error(`copy-theme: ${source} is missing, so the package would ship without its theme tokens.`);
  process.exit(1);
}

try {
  createRequire(join(root, "package.json")).resolve(XYFLOW_STYLESHEET);
} catch (error) {
  console.error(
    `copy-theme: ${XYFLOW_STYLESHEET} does not resolve from ${root} (${error.code}), so dist/styles.css would import a stylesheet that is not there. Run bun install.`,
  );
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `@import "${XYFLOW_STYLESHEET}";\n${readFileSync(source, "utf8")}`);
console.log(`copy-theme: @import "${XYFLOW_STYLESHEET}" and ${source} -> ${target}`);
