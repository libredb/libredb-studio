import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputPackage } from "../../../scripts/bundle-checks.mjs";
import { renderNotices } from "../../../scripts/notices.mjs";
import {
  CSS_INPUT,
  CSS_OUTPUT,
  sourceCoverageViolations,
  sourcesOf,
  stylesheetViolations,
  tailwindArgs,
  tailwindNoticeInput,
  themeInlineBlocks,
} from "../../../scripts/webview-css.mjs";

const extension = join(__dirname, "..", "..", "..");
const resultsCss = readFileSync(join(extension, CSS_INPUT), "utf8");

describe("the webview stylesheet's build", () => {
  it("runs the Tailwind CLI from results.css to dist/webview/results.css, minified or watching", () => {
    assert.equal(CSS_INPUT, "src/webview/results.css");
    assert.equal(CSS_OUTPUT, "dist/webview/results.css");
    assert.deepEqual(tailwindArgs({ watch: false }), [
      "-i",
      "src/webview/results.css",
      "-o",
      "dist/webview/results.css",
      "--minify",
    ]);
    assert.deepEqual(tailwindArgs({ watch: true }), [
      "-i",
      "src/webview/results.css",
      "-o",
      "dist/webview/results.css",
      "--watch",
    ]);
  });

  it("is part 4's eleven lines", () => {
    assert.equal(
      resultsCss,
      `@import "tailwindcss" source(none);
@import "../../../src/styles/theme.css";
@import "./vscode-bridge.css";
@source "../../../src/components/ResultsGrid.tsx";
@source "../../../src/components/results-grid";
@source "../../../src/components/ui/context-menu.tsx";
@source "../../../src/components/ui/sheet.tsx";
@source "../../../src/components/ui/button.tsx";
@source "../../../src/components/ui/scroll-area.tsx";
@source "./";
@custom-variant dark (&:where(.dark, .dark *));
`,
    );
  });

  it("reads a stylesheet's @source paths in order", () => {
    assert.deepEqual(sourcesOf(resultsCss), [
      "../../../src/components/ResultsGrid.tsx",
      "../../../src/components/results-grid",
      "../../../src/components/ui/context-menu.tsx",
      "../../../src/components/ui/sheet.tsx",
      "../../../src/components/ui/button.tsx",
      "../../../src/components/ui/scroll-area.tsx",
      "./",
    ]);
  });

  it("reads the two top-level @theme inline blocks of globals.css", () => {
    const blocks = themeInlineBlocks(readFileSync(join(extension, "..", "src", "app", "globals.css"), "utf8"));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], "--font-sans: var(--font-geist-sans); --font-mono: var(--font-geist-mono);");
    assert.ok(blocks[1].startsWith("--color-background: var(--background);"), blocks[1]);
    assert.deepEqual(themeInlineBlocks("@theme inline {\n  --a: b;\n}\n@layer x { @theme inline { --c: d; } }"), [
      "--a: b;",
    ]);
  });

  describe("the notice input", () => {
    let repo: string;
    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "libredb-webview-css-"));
    });
    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    it("names the tailwindcss package the CLI compiles from, so the notices list it", () => {
      const wd = join(repo, "vscode-extension");
      const dir = join(wd, "node_modules", "tailwindcss");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "tailwindcss", version: "4.3.3", license: "MIT" }),
      );
      writeFileSync(join(dir, "LICENSE"), "Tailwind MIT text");
      const notice = tailwindNoticeInput(wd);
      const inputs = Object.keys(notice.inputs);
      assert.equal(inputs.length, 1);
      assert.equal(inputPackage(inputs[0]), "tailwindcss");
      const text = renderNotices([notice], wd);
      assert.ok(text.includes("tailwindcss@4.3.3 (MIT)"), text);
      assert.ok(text.includes("Tailwind MIT text"), text);
    });

    it("refuses a working directory where tailwindcss does not resolve", () => {
      assert.throws(() => tailwindNoticeInput(join(repo, "empty")), /tailwindcss/);
    });
  });

  describe("the built stylesheet's check", () => {
    it("keeps a stylesheet that carries the bridge and fetches nothing", () => {
      assert.deepEqual(stylesheetViolations("body{background:var(--vscode-panel-background)}"), []);
    });

    it("refuses an empty stylesheet, one without the bridge, and one with url(", () => {
      assert.deepEqual(stylesheetViolations(""), [
        "dist/webview/results.css: the stylesheet is empty",
        "dist/webview/results.css: the stylesheet lacks the bridge's --vscode-panel-background",
      ]);
      assert.deepEqual(stylesheetViolations("a{b:url(x.png)}body{background:var(--vscode-panel-background)}"), [
        "dist/webview/results.css: the stylesheet loads url(, which the CSP has no img-src or font-src for",
      ]);
    });
  });

  describe("the @source coverage check", () => {
    const wd = "/repo/vscode-extension";
    const meta = (...inputs: string[]) => ({ inputs: Object.fromEntries(inputs.map((input) => [input, {}])) });
    const sources = sourcesOf(resultsCss);
    const exists = () => true;

    it("keeps a bundle whose components all lie under an @source path", () => {
      const clean = meta(
        "src/webview/results-app.tsx",
        "../src/components/ResultsGrid.tsx",
        "../src/components/results-grid/StatsBar.tsx",
        "../src/components/ui/sheet.tsx",
        "../src/lib/db/sql-grammar/index.ts",
      );
      assert.deepEqual(sourceCoverageViolations(clean, sources, wd, exists), []);
    });

    it("refuses a component no @source path covers", () => {
      assert.deepEqual(sourceCoverageViolations(meta("../src/components/ui/dialog.tsx"), sources, wd, exists), [
        "src/components/ui/dialog.tsx: a bundled component that no @source path of results.css covers",
      ]);
      assert.deepEqual(sourceCoverageViolations(meta("../src/components/results-gridx/a.tsx"), sources, wd, exists), [
        "src/components/results-gridx/a.tsx: a bundled component that no @source path of results.css covers",
      ]);
    });

    it("refuses an @source path that does not exist", () => {
      const missing = (path: string) => !path.endsWith("sheet.tsx");
      assert.deepEqual(sourceCoverageViolations(meta(), sources, wd, missing), [
        "src/components/ui/sheet.tsx: an @source path of results.css that does not exist",
      ]);
    });
  });
});
