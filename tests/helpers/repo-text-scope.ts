/**
 * Shared pieces of the repository-wide text guards: the tracked file list, a glob matcher whose `**` spans zero or
 * more directories, and the whole-word engine label matcher the MCP doc tests use too.
 */

/** Every tracked path, with `/` separators on every platform, as `git ls-files -z` lists them. */
export function trackedFiles(root: string): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ls-files failed in ${root}`);
  return proc.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

/** A glob as a whole-path matcher: `**` spans zero or more directories, `*` and `?` stay inside one. */
export function globMatcher(glob: string): (path: string) => boolean {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${pattern}$`);
  return (path) => regex.test(path);
}

/** True when the path matches any of the globs. */
export function matchesAny(globs: readonly string[]): (path: string) => boolean {
  const matchers = globs.map(globMatcher);
  return (path) => matchers.some((matches) => matches(path));
}

/** "LibreDB Studio" is the product, never the LibreDB engine, so the product name is blanked before labels are read. */
const PRODUCT_NAME = /LibreDB Studio/g;

/**
 * The labels named in a text, each as a whole label: a label starts and ends at a word boundary, so "SQL" is never
 * read inside "PostgreSQL" or "MySQL", and a longer label wins over one it contains ("InfluxDB 3" over "InfluxDB").
 */
export function namedLabels(text: string, labels: readonly string[]): string[] {
  let rest = text.replace(PRODUCT_NAME, " ");
  const found: string[] = [];
  for (const label of [...new Set(labels)].sort((a, b) => b.length - a.length)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g");
    if (regex.test(rest)) {
      found.push(label);
      rest = rest.replace(regex, " ");
    }
  }
  return found;
}
