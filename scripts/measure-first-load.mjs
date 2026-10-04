import { readFileSync, existsSync, statSync } from "node:fs";

// Total byte size of the JS chunks the prerendered `/` page references on first
// load. Lazy (`React.lazy` / dynamic import) chunks are NOT in this list, so the
// number measures the first-load JavaScript a browser must download before the
// page becomes interactive.
const htmlPath = ".next/server/app/index.html";
const html = readFileSync(htmlPath, "utf8");
const refs = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
let total = 0;
for (const ref of refs) {
  const p = ".next" + ref.replace("/_next", "");
  if (existsSync(p)) total += statSync(p).size;
}
console.log(`first-load JS: ${(total / 1024).toFixed(1)} kB across ${refs.length} scripts`);
