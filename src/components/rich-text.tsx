import type { ReactNode } from "react";

/**
 * Renders `**bold**` spans as React nodes.
 *
 * Security: this replaces two string-concatenating renderers whose output was passed to
 * dangerouslySetInnerHTML. The input is LLM output derived from database identifiers and
 * monitoring data, both of which an attacker can influence, so it must never reach an HTML
 * parser. Returning React nodes makes escaping structural rather than a step someone can
 * forget to apply.
 */
export function renderInlineBold(text: string): ReactNode[] {
  const pattern = /\*\*(.*?)\*\*/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  let match = pattern.exec(text);

  while (match !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    nodes.push(
      <strong key={key} className="text-zinc-200">
        {match[1]}
      </strong>,
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
