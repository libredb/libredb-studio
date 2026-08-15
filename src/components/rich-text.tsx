import type { ReactNode } from "react";
import { PencilLine } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { DatabaseType } from "@/lib/types";

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
 * A fence line: three backticks, and whatever the model called the block.
 *
 * The info string may hold no backtick, and that restriction is doing real work rather
 * than following the spec for its own sake. CommonMark forbids it so that a whole fence
 * written on ONE line — ```` ```sql SELECT 1``` ```` — is not read as an opener; without
 * the rule, that single line opens a block nothing closes and the entire rest of the
 * plan is swallowed into it. One malformed line would take the whole output with it, so
 * such a line is left as the ordinary prose it renders as today.
 */
const FENCE_LINE = /^\s*```([^`]*)$/;

/**
 * Every engine this product speaks, as a fence tag.
 *
 * A TOTAL RECORD over `DatabaseType` rather than a list, and that is the point: the
 * first version of this was a hand-written set whose comment claimed every engine was
 * in it, and `libredb` was not (#389 review). A comment cannot keep that promise and a
 * record can — an engine added to the union stops this file compiling until someone
 * decides what its blocks are called.
 *
 * The keys are the canonical type-ids because that is what the union holds; the aliases
 * models actually write live below.
 */
const ENGINE_FENCE_TAGS: Readonly<Record<DatabaseType, true>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  mongodb: true,
  redis: true,
  oracle: true,
  mssql: true,
  libredb: true,
  couchbase: true,
  clickhouse: true,
  druid: true,
});

/**
 * The other names the same query languages go by, which is what a model actually types.
 *
 * Separate from the record above because these answer to nothing: no union widens when
 * a model invents `pgsql`, so completeness here is a judgement rather than a guarantee.
 * A tag missing from either costs the user a button and never a wrong one — the copy
 * control is offered on every block regardless.
 */
const QUERY_FENCE_ALIASES: ReadonlySet<string> = new Set([
  "sql",
  "postgresql",
  "pgsql",
  "psql",
  "plpgsql",
  "mariadb",
  "sqlite3",
  "plsql",
  "tsql",
  "sqlserver",
  "mongo",
  "n1ql",
]);

/**
 * Whether a fence holds something the editor should be offered.
 *
 * Fail-closed on an unrecognised tag, the same posture the auto-execute gate takes about
 * a dialect it has no rule for: the tag is the model saying what the block is, and
 * offering to put a shell command into a SQL editor would be this surface claiming
 * something the model contradicted.
 *
 * An untagged fence counts. Models write one for SQL constantly, and in a document
 * whose entire subject is a database the bare fence is a query far more often than it
 * is anything else — while the cost of being wrong is one click that puts text in an
 * editor, which the user can see and undo.
 */
const isQueryTag = (tag: string | undefined): boolean =>
  tag === undefined || Object.hasOwn(ENGINE_FENCE_TAGS, tag) || QUERY_FENCE_ALIASES.has(tag);

export interface ProseOptions {
  /**
   * Puts a fenced statement into the host's editor. Absent where the host has no
   * editor to put one in, and the control is then not rendered — the rule every
   * affordance in the agent rail follows.
   */
  readonly onApplySql?: (sql: string) => void;
}

/**
 * One fenced block: the model's text as typed, and what a reader may do with it.
 *
 * The controls sit UNDER the block rather than floating over its corner. A plan's SQL
 * is often wider than the rail, so the block scrolls sideways; a control pinned inside
 * it would sit on top of the text a user is reading, and one pinned outside the scroll
 * would drift away from it.
 */
function CodeBlock({
  code,
  tag,
  onApplySql,
}: {
  readonly code: string;
  readonly tag: string | undefined;
  readonly onApplySql: ((sql: string) => void) | undefined;
}) {
  return (
    <div className="mt-1">
      <pre className="overflow-x-auto rounded bg-black/40 p-1.5 font-mono text-[0.625rem] text-zinc-300 whitespace-pre">
        {code}
      </pre>
      <div className="mt-0.5 flex items-center gap-1">
        {onApplySql !== undefined && isQueryTag(tag) && (
          <button
            type="button"
            data-testid="prose-code-apply"
            onClick={() => onApplySql(code)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors"
          >
            <PencilLine strokeWidth={1.5} className="w-3 h-3" />
            Apply to editor
          </button>
        )}
        <CopyButton text={code} testId="prose-code-copy" />
      </div>
    </div>
  );
}

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
 *    paragraphs, inline code and fenced blocks. Not a markdown engine: no links, no
 *    images, no tables, no ordered lists. Anything else stays the characters the model
 *    typed, which is the honest rendering of text this build does not interpret.
 *  - **A fenced block is verbatim, and it is the reason this reads fences at all**
 *    (#389). Plan mode is toolless, so its entire output is one of these blocks, and a
 *    plan worth having contains SQL. Without fence handling that SQL arrived as
 *    paragraphs of literal backticks with its whitespace collapsed — unreadable, and
 *    with no way to get it into the editor. Nothing inside a fence is read as prose:
 *    a `-` there is a minus sign and a `*` is a star, because that is what the model
 *    typed and a code block is the one place markup must not be interpreted.
 *  - **Every heading renders at ONE level**, whatever the hash count. The heading
 *    outline of the page belongs to the application; a model's hash count is a claim
 *    about the structure of its own answer, not about this document, and letting it
 *    emit an `h1` inside a timeline entry would let untrusted text pose as chrome.
 *
 * Callers are expected to render the result inside a container that keeps the quoting
 * boundary visible, because prose being READABLE must not make it look like the
 * application speaking.
 */
export function renderProse(text: string, options: ProseOptions = {}): ReactNode[] {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;
  /** The fence being collected, or null outside one. */
  let fence: { readonly tag: string | undefined; readonly lines: string[] } | null = null;

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

  const closeFence = (): void => {
    if (fence === null) return;
    const code = fence.lines.join("\n");
    // A fence with nothing in it is not a code block, for the same reason a heading
    // with nothing after it is not a heading: it would render an empty box offering a
    // copy of nothing.
    if (code.trim().length > 0) {
      blocks.push(<CodeBlock key={key} code={code} tag={fence.tag} onApplySql={options.onApplySql} />);
      key += 1;
    }
    fence = null;
  };

  for (const line of text.split("\n")) {
    const marker = FENCE_LINE.exec(line);
    if (fence !== null) {
      // Inside a fence NOTHING is prose — including a line that looks like a bullet or
      // a heading — so this branch comes before every other reading of the line.
      if (marker === null) fence.lines.push(line);
      else closeFence();
      continue;
    }
    if (marker !== null) {
      closeList();
      const tag = marker[1].trim().toLowerCase();
      fence = { tag: tag.length === 0 ? undefined : tag, lines: [] };
      continue;
    }

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
  // A fence the model never closed still renders what it holds: a run cut off at its
  // turn limit or its deadline ends mid-block, and the statement it had written by then
  // is the half the user came for.
  closeFence();
  return blocks;
}
