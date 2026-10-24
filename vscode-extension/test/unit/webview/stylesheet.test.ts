import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { themeInlineBlocks } from "../../../scripts/webview-css.mjs";

const extension = join(__dirname, "..", "..", "..");
const read = (...path: string[]) => readFileSync(join(...path), "utf8");
const bridge = read(extension, "src", "webview", "vscode-bridge.css");
const globals = read(extension, "..", "src", "app", "globals.css");
const theme = read(extension, "..", "src", "styles", "theme.css");

/** The declarations of the bridge's first rule whose selector is exactly `selector`, as a map. */
function declarations(selector: string): Map<string, string> {
  const at = bridge.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `the bridge has no "${selector}" rule`);
  const body = bridge.slice(bridge.indexOf("{", at) + 1, bridge.indexOf("}", at));
  const map = new Map<string, string>();
  for (const line of body.split(";")) {
    const colon = line.indexOf(":");
    if (colon !== -1) map.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return map;
}

/** Part 4's token table: each LibreDB token and the VS Code variable it reads. */
const TOKEN_TABLE: [string[], string][] = [
  [["--studio-canvas", "--studio-sunken", "--studio-surface", "--background"], "--vscode-panel-background"],
  [["--studio-overlay", "--studio-panel", "--muted"], "--vscode-editorWidget-background"],
  [["--popover"], "--vscode-menu-background"],
  [["--popover-foreground"], "--vscode-menu-foreground"],
  [["--accent"], "--vscode-menu-selectionBackground"],
  [["--accent-foreground"], "--vscode-menu-selectionForeground"],
  [["--studio-hairline", "--border"], "--vscode-panel-border"],
  [["--studio-hairline-strong", "--studio-edge"], "--vscode-editorWidget-border"],
  [["--input"], "--vscode-input-border"],
  [["--studio-edge-hover", "--ring", "--studio-brand-tint"], "--vscode-focusBorder"],
  [["--studio-fill-subtle"], "--vscode-toolbar-hoverBackground"],
  [["--studio-fill"], "--vscode-list-hoverBackground"],
  [["--studio-fill-strong"], "--vscode-list-inactiveSelectionBackground"],
  [["--studio-fg-bright", "--studio-fg", "--studio-fg-secondary", "--foreground"], "--vscode-foreground"],
  [["--studio-fg-tertiary", "--studio-fg-muted", "--muted-foreground"], "--vscode-descriptionForeground"],
  [["--studio-fg-subtle", "--studio-fg-faint"], "--vscode-disabledForeground"],
  [["--studio-brand", "--studio-brand-bright"], "--vscode-textLink-foreground"],
  [["--studio-brand-solid", "--primary"], "--vscode-button-background"],
  [["--studio-brand-solid-hover", "--studio-brand-solid-active"], "--vscode-button-hoverBackground"],
  [["--primary-foreground"], "--vscode-button-foreground"],
  [["--secondary"], "--vscode-button-secondaryBackground"],
  [["--secondary-foreground"], "--vscode-button-secondaryForeground"],
  [
    [
      "--studio-warning",
      "--studio-warning-bright",
      "--studio-warning-solid",
      "--studio-warning-solid-hover",
      "--studio-warning-tint",
    ],
    "--vscode-editorWarning-foreground",
  ],
  [
    [
      "--studio-danger",
      "--studio-danger-bright",
      "--studio-danger-solid",
      "--studio-danger-solid-hover",
      "--studio-danger-tint",
      "--destructive",
    ],
    "--vscode-errorForeground",
  ],
  [
    [
      "--studio-success",
      "--studio-success-bright",
      "--studio-success-solid",
      "--studio-success-solid-hover",
      "--studio-success-tint",
    ],
    "--vscode-charts-green",
  ],
  [["--font-geist-sans"], "--vscode-font-family"],
  [["--font-geist-mono"], "--vscode-editor-font-family"],
];

/** Each hue family's VS Code chart colour; the greys read the description foreground. */
const HUE_FAMILIES: Record<string, string> = {
  blue: "--vscode-charts-blue",
  sky: "--vscode-charts-blue",
  cyan: "--vscode-charts-blue",
  indigo: "--vscode-charts-blue",
  purple: "--vscode-charts-purple",
  violet: "--vscode-charts-purple",
  fuchsia: "--vscode-charts-purple",
  red: "--vscode-charts-red",
  rose: "--vscode-charts-red",
  pink: "--vscode-charts-red",
  orange: "--vscode-charts-orange",
  amber: "--vscode-charts-orange",
  yellow: "--vscode-charts-yellow",
  lime: "--vscode-charts-yellow",
  green: "--vscode-charts-green",
  emerald: "--vscode-charts-green",
  teal: "--vscode-charts-green",
  slate: "--vscode-descriptionForeground",
  stone: "--vscode-descriptionForeground",
  neutral: "--vscode-descriptionForeground",
  mist: "--vscode-descriptionForeground",
  taupe: "--vscode-descriptionForeground",
  mauve: "--vscode-descriptionForeground",
  zinc: "--vscode-descriptionForeground",
};

describe("the VS Code theming bridge", () => {
  const root = declarations(":root,\n:root.dark");

  it("copies globals.css's two @theme inline blocks, and of its base layer only the border colour", () => {
    assert.deepEqual(themeInlineBlocks(bridge), themeInlineBlocks(globals));
    assert.match(bridge, /@layer base \{\s*\* \{\s*border-color: var\(--border\);\s*\}\s*\}/);
    assert.equal(bridge.match(/^@layer/gm)?.length, 1);
  });

  it("assigns every row of part 4's token table", () => {
    for (const [tokens, variable] of TOKEN_TABLE) {
      for (const token of tokens) assert.equal(root.get(token), `var(${variable})`, token);
    }
    assert.equal(
      root.get("--studio-raised"),
      "var(--vscode-keybindingTable-headerBackground, var(--vscode-editorWidget-background))",
    );
  });

  it("maps every hue theme.css declares by its family", () => {
    const hues = [...new Set([...theme.matchAll(/--studio-hue-([a-z]+)[a-z-]*:/g)].map((match) => match[1]))].sort();
    assert.deepEqual(hues, Object.keys(HUE_FAMILIES).sort());
    for (const [token] of theme.matchAll(/--studio-hue-[a-z-]+(?=:)/g)) {
      const family = token.slice("--studio-hue-".length).split("-")[0];
      assert.equal(root.get(token), `var(${HUE_FAMILIES[family]})`, token);
    }
  });

  it("maps the hairlines and the ring to the contrast borders under a high-contrast theme", () => {
    const high = declarations(':root[data-libredb-contrast="high"],\n:root.dark[data-libredb-contrast="high"]');
    for (const token of ["--studio-hairline", "--studio-hairline-strong", "--studio-edge", "--border"]) {
      assert.equal(high.get(token), "var(--vscode-contrastBorder)", token);
    }
    assert.equal(high.get("--ring"), "var(--vscode-contrastActiveBorder)");
  });

  it("bounds the document to the view, so the grid scrolls in the page's place", () => {
    assert.ok(bridge.includes("html,\nbody,\n#root {\n  height: 100%;\n}"));
  });

  it("turns motion off under reduce motion, and meets the view's edges with an unlayered body rule", () => {
    assert.ok(
      bridge.includes(
        "body.vscode-reduce-motion *,\nbody.vscode-reduce-motion *::before,\nbody.vscode-reduce-motion *::after {\n  animation: none !important;\n  transition: none !important;\n}",
      ),
    );
    assert.ok(
      bridge
        .trimEnd()
        .endsWith("body {\n  margin: 0;\n  padding: 0;\n  background: var(--vscode-panel-background);\n}"),
    );
  });
});
