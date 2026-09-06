import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The token layer only holds if adding a literal is harder than adding a token.
 *
 * #384 tokenised the neutrals and left the accents behind; nothing failed, so the
 * accents kept dark-tuned values on a light ground for four months (#402). That was
 * not an oversight anyone could have caught by reading a diff — 955 colour literals
 * across 68 files look exactly like 954 do.
 *
 * Two guards, pointing in opposite directions:
 *
 *   - Nothing in `src` paints a colour Tailwind chose. A new `text-blue-400` fails
 *     here, at the moment it is written, rather than in whichever theme the author
 *     did not happen to be looking at.
 *   - Nothing in `theme.css` is declared and unused. A token nobody reaches for is a
 *     value nobody has checked, and the next person to need that colour will not
 *     find it — they will write a literal.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));

const HUES = "blue|sky|indigo|violet|purple|cyan|teal|emerald|green|lime|yellow|amber|orange|red|rose|pink|fuchsia";

/**
 * `from-`, `via-`, `to-` and `shadow-` are the decorative half — gradients, blur
 * orbs, glow rings. They are never read as text, they are never the only signal for
 * anything, and giving each of them a token would mean tokenising a hundred values
 * to change none of them. They stay literal, deliberately, and this pattern is the
 * record of that decision rather than an oversight.
 */
const LITERAL = new RegExp(
  `\\b(?:text|bg|border|ring|divide|outline|decoration)-(?:${HUES})-\\d{2,3}(?:/\\d{1,3})?\\b`,
  "g",
);

describe("no component paints a colour Tailwind chose", () => {
  /**
   * `src/components/ui/**` is vendored shadcn and stays upstream-pure — it is
   * restyled from `globals.css`, never edited. It happens to contain no accent
   * literal at all, so the exemption costs nothing today; it is here so that a
   * `shadcn add` does not turn into a failing build.
   */
  const owned = files.filter(({ path }) => !path.startsWith("src/components/ui/"));

  test("the sweep actually reaches the components (guard against an empty walk)", () => {
    expect(owned.length).toBeGreaterThan(100);
    expect(owned.some(({ path }) => path === "src/components/agent/AgentRail.tsx")).toBe(true);
  });

  test("every accent is a token", () => {
    const offenders = owned.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, index) =>
        // Prose may name a Tailwind step to explain which value a token
        // reproduces; that is documentation, not a painted colour.
        /^\s*(?:\/\/|\*|\/\*)/.test(line)
          ? []
          : Array.from(line.matchAll(LITERAL), (m) => `${path}:${index + 1}  ${m[0]}`),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("no token is declared and unreachable", () => {
  const theme = readFileSync(join(ROOT, "src", "styles", "theme.css"), "utf8");
  const globals = readFileSync(join(ROOT, "src", "app", "globals.css"), "utf8");
  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * Only the accent families. The surface and text ramps predate this guard and a
   * couple of their steps are held in reserve as a documented ramp rather than for
   * a specific call site; widening the guard to them is a separate argument, and
   * making it here would mean deleting ramp steps to get the suite green.
   */
  const accentTokens = Array.from(
    new Set(
      Array.from(
        stripComments(theme).matchAll(/(--studio-(?:brand|warning|success|danger|hue)[a-z0-9-]*)\s*:/g),
        (m) => m[1],
      ),
    ),
  );

  test("the token sweep found the family (guard against a regex that matches nothing)", () => {
    expect(accentTokens.length).toBeGreaterThan(40);
    expect(accentTokens).toContain("--studio-brand");
  });

  test("every accent token is reachable as a utility", () => {
    const mapping = stripComments(theme);
    const unmapped = accentTokens.filter((token) => !mapping.includes(`var(${token})`));
    expect(unmapped).toEqual([]);
  });

  test("every accent token is used by something", () => {
    const haystack = files.map(({ text }) => text).join("\n") + stripComments(globals);
    const unused = accentTokens.filter((token) => {
      // `--studio-brand-tint` is reached as `bg-accent-tint`, `text-accent-tint`,
      // `border-accent-tint/20`, … so the utility suffix is what has to appear.
      const utility = token.replace("--studio-", "");
      return !new RegExp(
        `[-:\\[\\s"'\`](?:text|bg|border|ring|divide|outline|decoration|from|via|to)-${utility}\\b`,
      ).test(haystack);
    });
    expect(unused).toEqual([]);
  });
});
