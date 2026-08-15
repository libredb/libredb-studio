import type { ReactNode } from "react";

/**
 * Renders the inline markup an LLM emits — `**bold**` and `` `code` `` — as React nodes.
 *
 * Security: this replaces two string-concatenating renderers whose output was passed to
 * dangerouslySetInnerHTML. The input is LLM output derived from database identifiers and
 * monitoring data, both of which an attacker can influence, so it must never reach an HTML
 * parser. Returning React nodes makes escaping structural rather than a step someone can
 * forget to apply.
 *
 * Expects a single line: neither pattern is matched with the `s` flag, so no marker can
 * pair across a newline. Every caller splits its input on `\n` before calling this per line.
 */
export function renderInline(text: string): ReactNode[] {
  // One pass over both markers rather than one pass each, so a line holding both
  // renders them in the order they appear instead of in the order the passes ran.
  const pattern = /\*\*(.*?)\*\*|`([^`]+)`/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    nodes.push(
      match[1] === undefined ? (
        <code key={key} className="rounded bg-white/5 px-1 font-mono text-[0.9em] text-zinc-300">
          {match[2]}
        </code>
      ) : (
        <strong key={key} className="text-zinc-200">
          {match[1]}
        </strong>
      ),
    );

    key += 1;
    cursor = match.index + match[0].length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

/** A heading line: the hash marks, then at least one space, then what it says. */
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

/** A bullet: a dash or asterisk followed by a space, which `**bold**` cannot be. */
const BULLET_LINE = /^\s*[-*]\s+(.*)$/;

/**
 * Renders a block of model prose (#373 review).
 *
 * Measured in plan mode against a live model: the closing statement came back as
 * markdown — `### Step 1: Schema Integrity`, `* **What to inspect:** …` — and the rail
 * rendered it into one paragraph as literal characters. Plan mode's entire output is
 * one such block, so the mode read as broken.
 *
 * Three properties, in the order they matter:
 *
 *  - **No HTML parser, ever.** It is the same rule `renderInline` above was written
 *    for: this is text a model wrote after reading a database, and it reaches the page
 *    as React nodes so that escaping is structural. There is no `dangerouslySetInnerHTML`
 *    on this path and no markdown library that could produce one.
 *  - **Only what the models actually emit**, which is headings, bullets, bold,
 *    paragraphs and inline code. Not a markdown engine: no links, no images, no tables,
 *    no fenced blocks, no ordered lists. Anything else stays the characters the model
 *    typed, which is the honest rendering of text this build does not interpret.
 *  - **Every heading renders at ONE level**, whatever the hash count. The heading
 *    outline of the page belongs to the application; a model's hash count is a claim
 *    about the structure of its own answer, not about this document, and letting it
 *    emit an `h1` inside a timeline entry would let untrusted text pose as chrome.
 *
 * Callers are expected to render the result inside a container that keeps the quoting
 * boundary visible, because prose being READABLE must not make it look like the
 * application speaking.
 */
export function renderProse(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;

  const closeList = (): void => {
    if (bullets.length === 0) return;
    // Grouped rather than emitted per line: a `li` outside a list is not a list, and a
    // model writes its bullets as consecutive lines.
    blocks.push(
      <ul key={key} className="list-disc space-y-0.5 pl-4">
        {bullets.map((item, index) => (
          // Position IS the identity here: the list is rebuilt whole from one string,
          // so there is no reordering for an index key to get wrong.
          <li key={index} className="text-xs leading-relaxed text-zinc-400">
            {renderInline(item)}
          </li>
        ))}
      </ul>,
    );
    key += 1;
    bullets = [];
  };

  for (const line of text.split("\n")) {
    const bullet = BULLET_LINE.exec(line);
    if (bullet !== null) {
      bullets.push(bullet[1]);
      continue;
    }
    closeList();

    // `trimStart` rather than `trim`: the space after the hashes is what makes a
    // heading a heading — `#1` and `#orders` are ordinary words a model writes — and
    // trimming the end first would turn a bare `### ` into a line that never matched.
    const heading = HEADING_LINE.exec(line.trimStart());
    const title = heading === null ? "" : heading[2].trim();
    if (heading !== null) {
      // A heading with nothing after it is not a heading; rendering one would put an
      // empty landmark in front of a screen reader.
      if (title.length > 0) {
        blocks.push(
          <h4 key={key} className="mt-2 text-xs font-medium text-zinc-300">
            {renderInline(title)}
          </h4>,
        );
        key += 1;
      }
      continue;
    }

    if (line.trim().length === 0) continue;
    blocks.push(
      <p key={key} className="text-xs leading-relaxed text-zinc-400">
        {renderInline(line)}
      </p>,
    );
    key += 1;
  }

  closeList();
  return blocks;
}
