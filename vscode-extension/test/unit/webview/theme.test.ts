import assert from "node:assert/strict";
import type { ThemeKind } from "../../../src/results-protocol";
import { applyTheme } from "../../../src/webview/theme";
import { useDom } from "../../setup/dom";

describe("the theme on <html>", () => {
  useDom();

  afterEach(() => {
    document.documentElement.className = "";
    delete document.documentElement.dataset.libredbContrast;
  });

  const table: [ThemeKind, boolean, string | undefined][] = [
    ["light", false, undefined],
    ["dark", true, undefined],
    ["highContrast", true, "high"],
    ["highContrastLight", false, "high"],
  ];

  for (const [kind, dark, contrast] of table) {
    it(`marks ${kind} with dark ${dark} and contrast ${contrast ?? "absent"}`, () => {
      const root = document.documentElement;
      applyTheme(root, kind);
      assert.equal(root.classList.contains("dark"), dark);
      assert.equal(root.dataset.libredbContrast, contrast);
      assert.equal(root.hasAttribute("data-libredb-contrast"), contrast !== undefined);
    });
  }

  it("removes both marks going from highContrast to light, and keeps the other classes", () => {
    const root = document.documentElement;
    root.classList.add("vscode-body", "other");
    applyTheme(root, "highContrast");
    applyTheme(root, "light");
    assert.equal(root.classList.contains("dark"), false);
    assert.equal(root.hasAttribute("data-libredb-contrast"), false);
    assert.deepEqual([...root.classList], ["vscode-body", "other"]);
  });
});
