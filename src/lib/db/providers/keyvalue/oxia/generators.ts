/**
 * What a tree click and Generate Command write for an Oxia object (SB2-4.5), read through `DIALECT_GENERATORS.oxia`
 * in `src/lib/query-generators.ts`.
 *
 * Pure, and shipped to the browser. No shipped click reaches these in v1 (SB2-12 D2): a key row of the Keys panel
 * opens the key's Source tab, a folder row only opens and closes, and a shard row opens its Source tab. They exist
 * because `DIALECT_GENERATORS` is a `Record` over every dialect, and they write the forms a later relation kind or
 * folder action reads unchanged: the click `get <key>`, and Generate Command that get with the `list --prefix` and
 * `range-scan --prefix` forms as comments below it. Every text they write is a command the parser accepts, or a
 * comment.
 */
import { quoteShellWord } from "@/lib/db/console/shell-words";

const CR_NOTE = "# This key holds a carriage return, which a command line cannot spell: open it from the Keys panel.";
const NUL_NOTE = "# This key holds a NUL character, which a command line cannot pass: open it from the Keys panel.";

/** The key a path names: its last segment, as the other console dialects read it. */
const keyOf = (path: readonly string[]): string => path[path.length - 1];

/** The note for a key no command line spells, or undefined when it has a spelling. */
function unspelledNote(key: string): string | undefined {
  if (key.includes("\r")) return CR_NOTE;
  if (key.includes("\u0000")) return NUL_NOTE;
  return undefined;
}

/** `get <key>`, the key as quoteShellWord writes it, after `--` when it begins with `-`, which a flag would. */
function getCommand(key: string): string {
  return `get ${key.startsWith("-") ? "-- " : ""}${quoteShellWord(key)}`;
}

/** A tree click (run): `get <key>` for the path's key, or the note for a key no command line spells. */
export function oxiaTableQuery(path: readonly string[]): string {
  const key = keyOf(path);
  return unspelledNote(key) ?? getCommand(key);
}

/**
 * Generate Command (written, not run): the get, then `# list --prefix <key>/` and `# range-scan --prefix <key>/
 * --limit 50` as comments. A key that holds a line feed spells over two lines, which no comment line holds, so its
 * text is the get alone.
 */
export function oxiaSelectQuery(path: readonly string[]): string {
  const key = keyOf(path);
  const note = unspelledNote(key);
  if (note !== undefined) return note;
  if (key.includes("\n")) return getCommand(key);
  const prefix = quoteShellWord(`${key}/`);
  return [getCommand(key), `# list --prefix ${prefix}`, `# range-scan --prefix ${prefix} --limit 50`].join("\n");
}
