/**
 * The K4 snapshot's canonical form and its diff, kept apart from the live check so a scratch
 * reproduction can drive them over captured tool output without starting the run.
 *
 * The broker's tools print entities in an order of their own (kafka-configs.sh does not print its
 * topics in a stable order), so the lines are sorted. Sorting a bare line cuts a config line off
 * the "All configs for topic X are:" header that says whose it is, and twelve topics hold the same
 * default line, so every line carries its section title and the header it sits under before it is
 * sorted. The comparison is then exact: the same lines, each as many times.
 */

/**
 * A header line opens an entity's block: an unindented line ending in a colon ("All configs for
 * topic orders are:", "Current ACLs for resource ...:"), or a line underlined by "=" (rpk's
 * SUMMARY, CONFIGS and PARTITIONS parts).
 */
function isHeader(line: string, next: string | undefined): boolean {
  return (!/^\s/.test(line) && line.trimEnd().endsWith(":")) || /^=+$/.test(next ?? "");
}

/** One section's lines, each as "title | header | line", blank lines dropped. */
function attributed(title: string, text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let header = "";
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    if (isHeader(line, lines[index + 1])) header = line.trimEnd();
    out.push(`${title} | ${header} | ${line}`);
  });
  return out;
}

/** The snapshot of every (tool, output) part, as sorted attributed lines. */
export function snapshotLines(parts: readonly (readonly [string, string])[]): string[] {
  return parts.flatMap(([title, text]) => attributed(title, text)).sort();
}

/** The lines whose count differs between the two snapshots, as "- line (n)" and "+ line (n)"; "" when equal. */
export function snapshotDiff(before: readonly string[], after: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) - 1);
  for (const line of after) counts.set(line, (counts.get(line) ?? 0) + 1);
  const diff = [...counts]
    .filter(([, count]) => count !== 0)
    .map(([line, count]) => `${count < 0 ? "-" : "+"} ${line} (${Math.abs(count)})`);
  return diff.join("\n");
}

/** Whether two snapshots hold the same lines in the same order, which K4 asserts. */
export function sameSnapshot(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((line, index) => line === after[index]);
}
