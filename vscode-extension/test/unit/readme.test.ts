import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";
import { ENABLED_PROVIDERS } from "../../src/host/channel";
import { MORE_OPTIONS_TOOLTIP } from "../../src/host/connections/add-connection-flow";
import { COMMANDS, CONTEXT_KEYS } from "../../src/host/names";

const root = join(__dirname, "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

interface Command {
  title: string;
  category: string;
}
interface Named {
  name?: string;
  title?: string;
}

const commands: Command[] = manifest.contributes.commands;
const COMMAND_TITLES = new Set(commands.map((command) => command.title));
const containers: Named[] = Object.values<Named[]>(manifest.contributes.viewsContainers).flat();
const views: Named[] = Object.values<Named[]>(manifest.contributes.views).flat();
/** The view and container names a reader sees: Connections, Results, LibreDB and LibreDB Results. */
const VIEW_NAMES = new Set([...views.map((view) => view.name), ...containers.map((container) => container.title)]);
/**
 * The product's own names: the display name, the command category and the container titles. The embedded LibreDB
 * store's engine label is one of them, so the README naming the product is not the README naming that engine.
 */
const PRODUCT_NAMES = new Set([manifest.displayName, ...commands.map((command) => command.category), ...VIEW_NAMES]);

/** Where the README's screenshots live: media/screenshots on main, raw, so the Marketplace page can load them. */
const SCREENSHOT_BASE = `https://raw.githubusercontent.com/libredb/libredb-studio/main/vscode-extension/media/screenshots/`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the Marketplace README", () => {
  it("names each enabled engine by its label, and no other engine", () => {
    for (const type of ENABLED_PROVIDERS) assert.ok(readme.includes(CONNECTION_FORM[type].label), type);
    const others = Object.entries(CONNECTION_FORM).filter(
      ([type, form]) => !ENABLED_PROVIDERS.includes(type as DatabaseType) && !PRODUCT_NAMES.has(form.label),
    );
    assert.ok(others.length > 0);
    for (const [, form] of others) assert.ok(!new RegExp(`\\b${escape(form.label)}\\b`).test(readme), form.label);
  });

  it("says it is a pre-release, as the odd minor of the manifest's version makes it", () => {
    assert.equal(Number(manifest.version.split(".")[1]) % 2, 1);
    assert.match(readme, /pre-release/);
  });

  it("names the floor VS Code version the manifest asks for", () => {
    assert.ok(readme.includes(`VS Code ${manifest.engines.vscode.replace(/^\^/, "").replace(/\.0$/, "")}`));
  });

  it("shows a keybindings.json entry for Run Query on a bound document's editor", () => {
    const entry = JSON.parse(/```json\n([^`]+)\n```/.exec(readme)?.[1] ?? "null");
    assert.equal(entry.command, COMMANDS.runQuery);
    assert.equal(entry.when, `editorTextFocus && resource in ${CONTEXT_KEYS.boundDocuments}`);
  });

  it("names only commands the manifest contributes, by their palette titles", () => {
    const bold = [...readme.matchAll(/\*\*([A-Z][A-Za-z ]+)\*\*/g)].map((match) => match[1]);
    assert.ok(bold.length > 0);
    for (const title of bold) {
      assert.ok(
        COMMAND_TITLES.has(title) || VIEW_NAMES.has(title),
        `${title} is neither a command title nor a view name`,
      );
    }
  });

  it("names every setting the manifest declares, with the row limit's default and bounds", () => {
    for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(readme.includes(key), key);
    assert.ok(readme.includes(String(DEFAULT_QUERY_LIMIT)));
    const { minimum, maximum } = manifest.contributes.configuration.properties["libredb.query.rowLimit"];
    assert.ok(readme.includes(String(minimum)) && readme.includes(String(maximum)));
  });

  it("links the repository's issues for feedback", () => {
    assert.ok(readme.includes(`${manifest.repository.url}/issues`));
  });

  it("puts Review behind More Options on the details walk, as add-connection-flow.ts does, never as a step of it", () => {
    const step = readme.split("\n").find((line) => line.includes("one at a time"));
    assert.ok(step, "Getting started names no details walk");
    assert.ok(!/one at a time, review them/.test(step), step);
    assert.ok(step.includes(`gear button titled ${MORE_OPTIONS_TOOLTIP} opens a review of every field`), step);
  });

  it("shows screenshots only from this repository's main branch by https, each a file the repository holds", () => {
    // The Marketplace renders README images from https URLs only, and the VSIX packs none of them (.vscodeignore).
    const images = [...readme.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
    assert.ok(images.length > 0, "the README shows no screenshot");
    for (const [, alt, url] of images) {
      assert.ok(alt.trim().length > 0, `${url} has no alt text`);
      assert.ok(url.startsWith(SCREENSHOT_BASE), `${url} is not under ${SCREENSHOT_BASE}`);
      const file = url.slice(SCREENSHOT_BASE.length);
      assert.match(file, /^[a-z0-9-]+\.png$/, url);
      assert.ok(existsSync(join(root, "media", "screenshots", file)), `${file} is not in media/screenshots`);
    }
    assert.equal(readme.match(/<img\b/g), null, "an HTML image");
  });

  it("keeps the repository's Markdown rules: no em or en dash, one sentence per line", () => {
    assert.ok(!/[\u2013\u2014]/.test(readme));
    const lines = readme.split("\n").map((each) => each.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
    for (const line of lines.filter((each) => /^[A-Z]/.test(each))) {
      assert.ok(!/[a-z0-9)]\. [A-Z]/.test(line), `two sentences on one line: ${line}`);
    }
  });
});
