// The engine logos and labels of the Connections tree (part 3, "Icons"), rendered at build time from DB_UI_CONFIG so the
// host bundle never loads React or src/lib/db-ui-config.ts. The output under media/engines/ is a build artifact: git
// ignores it and every build writes it again.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DB_UI_CONFIG, type DBIcon } from "@/lib/db-ui-config";

/** The default icon foreground of the Light and Dark themes (builder's call in part 3; the owner's manual check accepts them). */
export const ICON_COLOURS = { light: "#424242", dark: "#C5C5C5" } as const;

export interface IconSource {
  readonly label: string;
  readonly icon: DBIcon;
}

function listed(types: readonly string[]): string {
  return types.length === 0 ? "none" : types.join(", ");
}

/**
 * Empties outDir, renders each source with createElement(icon, { width: 16, height: 16 }), writes <type>.light.svg and
 * <type>.dark.svg with every currentColor replaced by ICON_COLOURS, then index.json as { "<type>": { "label": "<label>" } }.
 * Throws before writing anything unless the source keys and `expected` are the same set.
 */
export function writeEngineIcons(
  sources: Readonly<Record<string, IconSource>>,
  expected: readonly string[],
  outDir: string,
): void {
  const given = Object.keys(sources);
  const missing = expected.filter((type) => !Object.hasOwn(sources, type));
  const unknown = given.filter((type) => !expected.includes(type));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `engine-icons: every DatabaseType needs a logo and a label; missing: ${listed(missing)}; unknown: ${listed(unknown)}.`,
    );
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const index: Record<string, { label: string }> = {};
  for (const [type, { label, icon }] of Object.entries(sources)) {
    const markup = renderToStaticMarkup(createElement(icon, { width: 16, height: 16 }));
    for (const theme of ["light", "dark"] as const) {
      writeFileSync(join(outDir, `${type}.${theme}.svg`), markup.replaceAll("currentColor", ICON_COLOURS[theme]));
    }
    index[type] = { label };
  }
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

/** The build's call: DB_UI_CONFIG over SHIPPED_DATABASE_TYPES into <extensionRoot>/media/engines. */
export function writeShippedEngineIcons(extensionRoot: string): void {
  const sources = Object.fromEntries(
    Object.entries(DB_UI_CONFIG).map(([type, config]) => [type, { label: config.label, icon: config.icon }]),
  );
  writeEngineIcons(sources, SHIPPED_DATABASE_TYPES, join(extensionRoot, "media", "engines"));
}
