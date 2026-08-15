/**
 * Stage the studio theme layer into the package as `dist/styles.css`.
 *
 * tsup cannot do this: its `handle-css-and-xyflow` plugin resolves every `.css`
 * import to an empty module on purpose, because CSS is the consumer's bundler's
 * job at build time, not the runtime's. So the token stylesheet — the one part of
 * studio's CSS a consumer genuinely needs — has to be copied verbatim.
 *
 * It runs after `tsup`, which is `clean: true` and would otherwise delete it.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src", "styles", "theme.css");
const target = join(root, "dist", "styles.css");

if (!existsSync(source)) {
  console.error(`copy-theme: ${source} is missing — the package would ship without its theme tokens.`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`copy-theme: ${source} → ${target}`);
