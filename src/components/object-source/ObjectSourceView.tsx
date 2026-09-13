"use client";

import Editor from "@monaco-editor/react";
import { FileWarning, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import React, { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { httpSourceReader, isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
import { sourceCaption } from "./source-caption";
import { Button } from "@/components/ui/button";
import { isSourcePartUnavailable } from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type { ObjectSourceDocument, ObjectSourcePart } from "@/lib/db/types";
import { configureMonacoLoader } from "@/lib/editor/monaco-loader";
import { defineStudioThemes, STUDIO_THEME_DARK, STUDIO_THEME_LIGHT } from "@/lib/editor/monaco-theme";
import { useEffectiveTheme } from "@/hooks/use-effective-theme";
import type { DatabaseConnection } from "@/lib/types";

// Serve Monaco from our own origin rather than @monaco-editor/react's jsdelivr default.
// Called at module scope HERE as well as in `QueryEditor`, because it must run before the
// FIRST mount and a Source tab can be the first editor a session opens: a restored tab set
// whose active tab is a Source tab paints this component with no query editor ever mounted.
// `loader.config` is idempotent, so the second call rewrites the same path with the same value.
configureMonacoLoader();

/**
 * What a shell hands back to the tab when this viewer learns something (#789).
 *
 * The whole read lives in ONE place, this component, and the result is written back through
 * `onChange` so the tab keeps it across a tab switch and an unmount. Every field is optional
 * and a shell MERGES BY SPREAD, which is what makes an explicitly-`undefined` field a CLEAR:
 * the stale banner's control sends `{ document: undefined, failure: undefined, readAtToken:
 * undefined }` and the three keys are present on purpose, because an omitted key would leave
 * the stale document in place and the re-read would never be issued.
 */
export interface ObjectSourcePatch {
  readonly document?: ObjectSourceDocument;
  readonly failure?: string;
  readonly activePartId?: string;
  readonly readAtToken?: number;
}

export interface ObjectSourceViewProps {
  /**
   * The connection this definition was read from, and `null` when the shell has none.
   *
   * NULLABLE deliberately, and it is what closes the third door onto the empty-editor hazard
   * (#789). Both shells used to branch `sourceTab === undefined || activeConnection === null`
   * and mount the query toolbar plus the query editor for the second half, purely because this
   * prop could not take a null. A Source tab open when the last connection went away then came
   * back labelled `Source: <name>` over an EMPTY, EDITABLE buffer with a live Run button, which
   * is the composition this whole surface exists to prevent. The state is REACHED and not only
   * admitted by the type: `use-connection-adapter.ts` auto-selects whenever the host's list is
   * non-empty, so a null active connection means the host handed an empty array, which is what
   * a host does when a person deletes the last connection in the host's own UI.
   */
  readonly connection: DatabaseConnection | null;
  readonly path: readonly string[];
  readonly kind: string;
  /** The kind's own label from the declaration. The viewer never derives one from the id. */
  readonly kindLabel: string;
  /** The object's display label. `DatabaseObject.name`, which is NOT the last path segment. */
  readonly displayName: string;
  readonly document?: ObjectSourceDocument;
  readonly failure?: string;
  readonly activePartId?: string;
  /** The session's catalog-change counter. The shell owns it; 0 where a shell has none. */
  readonly refreshToken: number;
  /** The counter's value when this document was read. Absent until a read lands. */
  readonly readAtToken?: number;
  /** Absent means the standalone route. The embedded shell passes the host's reader. */
  readonly reader?: ObjectSourceReader;
  /** MUST be stable across renders, or the read effect re-issues for ever. */
  readonly onChange: (patch: ObjectSourcePatch) => void;
}

/** The sentence for a body neither shell can draw, which is OUR fact and not the engine's. */
const UNRENDERABLE = "The source read answered with a body this viewer cannot render.";

/** The sentence for a well-formed definition that names a DIFFERENT object. Also our fact. */
const MISMATCHED = "The source read answered with a definition for another object.";

/** The sentence for a pane whose connection is gone. Also our fact, and the shell's own state. */
const DISCONNECTED = "This connection is no longer open, so this definition cannot be read here.";

/**
 * Whether this document is a definition of THIS pane's object (#789).
 *
 * A source document carries the address it answers for, and every provider in the fleet writes
 * it as `path: [...path]` beside the `kind` it was asked for, 55 sites, so a document naming
 * anything else came from a HOST that answered the wrong question or from a shell holding one
 * state slot for two objects. Without this check such a document renders under the asked-for
 * name, in the header and on the tab, with nothing on screen saying so: the same fault the
 * `search` and `mongodb` providers were fixed for one level down.
 *
 * The KIND is half the address. Standing ruling 3 records it as measured that one name can be a
 * table and a routine in one MySQL database, so the path alone does not identify an object.
 *
 * `pathKey` and never `JSON.stringify`, per standing ruling 5g.
 */
function namesThisObject(document: ObjectSourceDocument, path: readonly string[], kind: string): boolean {
  return document.kind === kind && pathKey(document.path) === pathKey(path);
}

/**
 * The active part, and the fallback that makes the switcher's selection total.
 *
 * `activePartId` is remembered on the tab and the document is re-read from the engine, so the
 * two can disagree: a provider that renames a part between two reads, or a restored tab whose
 * remembered id belonged to an earlier shape. Falling back to the first part is what stops that
 * disagreement rendering as nothing at all, which is the empty-versus-unreadable collapse this
 * whole surface exists to prevent, one level in.
 *
 * The first part is addressed as a construction and never as a positional read of a path:
 * `parts` is a non-empty tuple, so `parts[0]` is total by the type.
 */
function activePart(document: ObjectSourceDocument, activePartId: string | undefined): ObjectSourcePart {
  return document.parts.find((part) => part.id === activePartId) ?? document.parts[0];
}

/**
 * The read-only viewer for one object's definition (#789).
 *
 * NOT `QueryEditor`, and the four reasons are measured rather than stylistic: that component
 * hardcodes `readOnly: false` with no prop to change it, installs a Run action and a Cmd+Enter
 * binding unconditionally on mount, renders an execute toolbar, and takes a closed four-member
 * `language` union reachable only through `resolveTabType`, which `CLAUDE.md` forbids
 * extending. A definition opened in it would offer to EXECUTE itself.
 *
 * `readOnly: true` is NOT a security boundary and this component does not pretend otherwise.
 * MEASURED on `@monaco-editor/react` 4.7.0: it blocks USER edits only, and the `value` effect
 * still calls `setValue` programmatically, so anything holding the editor handle can write to
 * the model. The boundary in Phase 2 is that no write path exists at all: no Run action is
 * installed, no key binding is added, and nothing reachable from here can execute a statement.
 *
 * THE ONE RULE THIS SURFACE EXISTS FOR: an unreadable source never opens an empty editor. An
 * empty editor reads as "there is no source", and a user who types over it deletes the object,
 * which is measured in DBeaver's own source. It is closed twice here. The TYPE gives a refused
 * part no `text` key. The COMPONENT renders a DIFFERENT element for a refusal and for a failed
 * read, so there is no editor on screen to type into even if a later change made one writable.
 * The renderer does not rely on the type for this, because the union does NOT make a part
 * carrying both `text` and `unavailable` a compile error: TypeScript's excess-property check on
 * a union admits any property declared on any member, so such a part narrows to the refusal.
 * `isSourceDocumentShape` refuses that part on BOTH entries: the read effect checks what a
 * reader answered, and the render checks what the `document` PROP carries, because a tab's
 * document survives a reload through `localStorage` and comes back as parsed JSON that no
 * compiler ever saw. Round 1 checked only the read effect, and a restored document with an
 * empty `text` then mounted an editor holding `""` over an object that HAS a definition.
 *
 * Nothing rendered here reads a kind id or a database type id. The kind's label arrives as a
 * prop from the declaration, the part's label is the engine's own word, and the language
 * travels on the part.
 */
export function ObjectSourceView(props: ObjectSourceViewProps): React.JSX.Element {
  const { connection, path, kind, document: sourceDocument, failure, refreshToken, reader, onChange } = props;
  const theme = useEffectiveTheme();
  const baseId = useId();

  /**
   * The read's identity, and the reason it is a STRING rather than the props themselves.
   *
   * `path` is an array prop and `connection` is an object prop, so both are a fresh identity on
   * every render of the shell. An effect keyed on either re-runs on every render, and an effect
   * that cancels its in-flight read in a cleanup would then cancel it for ever and the document
   * would never land. Keying on the address, plus a ref recording the address already asked,
   * means a re-render with identical props issues nothing and a genuinely new object issues one.
   *
   * `pathKey` and never `JSON.stringify(path)`, per standing ruling 5g: the key separator is a
   * control character no engine admits inside an identifier, so `["a.b"]` and `["a", "b"]`
   * cannot collide, while JSON escaping rewrites exotic names.
   */
  const address = `${connection?.id ?? ""}/${pathKey(path)}/${kind}`;
  /**
   * EVERY address this instance has issued a read for, and not one address (#789).
   *
   * A single ref held the LAST address and every answer whose address no longer matched it was
   * thrown away. Dropping an answer on UNMOUNT is intended and is documented below; dropping one
   * because the SAME PANE moved from object A to object B is the opposite, and both shells reach
   * it, because a reader switching between two Source tabs re-renders one mounted viewer with a
   * new address rather than mounting a second one. A's answer was discarded in silence, its tab
   * went back to "nothing read", and the next visit paid for a second round trip.
   *
   * A set, so an answer is kept when THIS instance asked for it, whatever it is showing now. The
   * answer is written through the `onChange` captured when the read was ISSUED, and in both
   * shells that callback names the tab that asked. What stops a shell holding ONE state slot for
   * two objects from drawing A's definition under B's name is `namesThisObject` above, which is
   * a check on the document rather than a race the reader cannot see.
   */
  const asked = useRef<Set<string>>(new Set());
  const needsRead = sourceDocument === undefined && failure === undefined;

  useEffect(() => {
    if (!needsRead || connection === null) {
      // This address has been answered, so a later CLEAR (the stale banner's control) issues a
      // fresh read rather than finding the address already asked.
      //
      // A NULL CONNECTION stops here for the same reason a failure does: there is nothing to
      // read with. Without it the default reader would post to `/api/db/objects/source` naming
      // a connection the shell no longer holds, and in the embedded package that route does not
      // exist at all.
      asked.current.delete(address);
      return;
    }
    if (asked.current.has(address)) return;
    asked.current.add(address);
    /*
     * The counter's value AT THE MOMENT THE READ WAS ISSUED, not when it landed. A DDL that
     * runs while this read is in flight cannot be attributed to either side of it, so recording
     * the earlier value marks the tab stale and offers a re-read, which is the honest half of
     * the repository's absence grammar: the client knows a DDL ran and does not know whether
     * this object changed.
     */
    const tokenAtRead = refreshToken;
    /*
     * No cleanup, no mounted guard and NO DROP, deliberately. A viewer unmounted by a tab
     * switch still writes its answer through `onChange`, and that is wanted rather than
     * tolerated: the patch lands on the tab's own state, so the read a user started before
     * switching away is there when they switch back instead of being issued a second time.
     * The same reasoning covers the pane that moved from one object to another without
     * unmounting, which the single-address ref used to throw away.
     */
    void (reader ?? httpSourceReader)(connection, path, kind).then(
      (answer) => {
        if (!isSourceDocumentShape(answer)) {
          onChange({ failure: UNRENDERABLE, readAtToken: tokenAtRead });
          return;
        }
        if (!namesThisObject(answer, path, kind)) {
          onChange({ failure: MISMATCHED, readAtToken: tokenAtRead });
          return;
        }
        /*
         * NO `activePartId` in this patch, and the omission is the fix rather than an oversight
         * (#789, Task 23). The shell merges by spread, so leaving the key out KEEPS whatever the
         * tab already remembered, and `activePart` above makes that total by falling back to the
         * first part when the new document holds no part of that id.
         *
         * Writing `answer.parts[0].id` here instead was measured in a real browser against Oracle
         * XE 21.3.0.0.0: reading a package BODY, running a CREATE OR REPLACE to mark the tab
         * stale, then pressing "Read again" silently put the reader back on the SPECIFICATION.
         * That write duplicated the fallback it sat above and could only ever lose a selection.
         */
        onChange({ document: answer, readAtToken: tokenAtRead });
      },
      (error: unknown) => {
        onChange({
          failure: error instanceof Error ? error.message : String(error),
          readAtToken: tokenAtRead,
        });
      },
    );
    // `path` and `connection` are read through `address`; `reader` and `onChange` are documented
    // as stable, and a change in either is answered by the address guard rather than a re-issue.
  }, [address, needsRead, refreshToken, connection, path, kind, reader, onChange]);

  /**
   * The SECOND entry, and the one round 1 left unguarded (#789).
   *
   * A document that arrives already present never passes through the read effect, so nothing
   * checked it. That entry is real rather than theoretical: `use-tab-manager.ts` restores the
   * tab set from `localStorage` with a `JSON.parse` guarded only by `Array.isArray`, so an
   * older shape, a truncated write or a hand-edited entry reaches this component with
   * `needsRead === false`. Measured on the round-1 component: a part with `text: ""` mounted
   * the editor with the value `""`, a part carrying both keys rendered the refusal pane over a
   * real definition, and `origin: "typed"` captioned "undefined Complete as shown.".
   *
   * A refused document is reported in the FAILURE grammar rather than thrown away silently,
   * and it is never re-read: the document is present, so `needsRead` is false and a re-read
   * would loop on the same bad value. The stale banner's control is the way back.
   */
  const renderableDocument = useMemo(
    () =>
      sourceDocument !== undefined &&
      isSourceDocumentShape(sourceDocument) &&
      namesThisObject(sourceDocument, path, kind)
        ? sourceDocument
        : undefined,
    [sourceDocument, path, kind],
  );
  /*
   * The two refusals are DIFFERENT sentences, because they are different facts: a body this
   * viewer cannot render is malformed, and a definition for another object is well formed and
   * about something else. One sentence for both would tell a reader nothing about which.
   */
  const shownFailure =
    failure ??
    (sourceDocument !== undefined && renderableDocument === undefined
      ? isSourceDocumentShape(sourceDocument)
        ? MISMATCHED
        : UNRENDERABLE
      : undefined) ??
    /*
     * LAST, so it never overwrites a fact about a read that really happened, and conditioned on
     * having nothing to show rather than on the connection alone: a definition already in hand
     * was read from the engine a moment ago and stays on screen, which is the same decision the
     * host-withdrawal arm makes one level up in `StudioWorkspace`. What it must not become is an
     * editable buffer, and a read-only editor holding the definition is not one.
     */
    (renderableDocument === undefined && connection === null ? DISCONNECTED : undefined);

  const reread = useCallback(() => {
    onChange({ document: undefined, failure: undefined, readAtToken: undefined });
  }, [onChange]);

  const part = useMemo(
    () => (renderableDocument === undefined ? undefined : activePart(renderableDocument, props.activePartId)),
    [renderableDocument, props.activePartId],
  );

  /*
   * A read lands with `readAtToken` set, so an absent one is "nothing has been read yet" and
   * never "read at token zero". Zero is a real token: it is what every shell that counts no
   * DDL passes for the whole session.
   */
  const stale = props.readAtToken !== undefined && props.readAtToken !== refreshToken;
  const parts = renderableDocument?.parts ?? [];
  const showSwitcher = parts.length > 1;
  const tabId = (index: number) => `${baseId}-tab-${index}`;
  const panelId = (index: number) => `${baseId}-panel-${index}`;
  const activeIndex = parts.findIndex((candidate) => candidate === part);

  /**
   * The KEYBOARD half of the WAI-ARIA tabs pattern, which round 1 omitted entirely.
   *
   * Both tab buttons sat at the implicit tabindex 0, so a keyboard user tabbing through a
   * two-part Oracle package landed on every part button in turn instead of entering the
   * tablist once and arrowing within it, and no arrow key did anything. `jsx-a11y` has NO rule
   * for roving tabindex or for arrow-key navigation, measured: `bun run lint` reported zero
   * errors over the version that had neither, so the lint gate cannot stand in for this.
   *
   * `StudioTabBar.tsx` is the repository's own spelling of the same pattern and this mirrors
   * it, including focus following activation: without that, the next arrow key would be
   * delivered to the tab that just lost the selection. The focus move addresses the button by
   * its part id and never by a position in the node list.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const wanted =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? parts.length - 1
              : undefined;
    if (wanted === undefined) return;
    event.preventDefault();
    const target = parts[(wanted + parts.length) % parts.length];
    onChange({ activePartId: target.id });
    /*
     * Matched through `dataset` and never through a built selector, the way `ObjectTree.tsx`
     * already matches a row id. A part id is the ENGINE's word: the first spelling interpolated
     * it into `[role="tab"][data-part-id="..."]`, and MEASURED on happy-dom 20, a part id of
     * `"char"(integer)`, which standing ruling 2 records as a real PostgreSQL routine identity,
     * raised `DOMException: ... is not a valid selector` out of this handler and the arrow key
     * did nothing, while the click path kept working because it carries the id as a VALUE. There
     * is no `CSS.escape` in every runtime this renders in, so the id never becomes syntax.
     */
    const buttons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    Array.from(buttons ?? [])
      .find((candidate) => candidate.dataset.partId === target.id)
      ?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="object-source-view">
      <div className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <span className="truncate text-sm font-medium" data-testid="object-source-name">
          {props.displayName}
        </span>
        <span className="ml-auto shrink-0 text-[11px] uppercase text-muted-foreground" data-testid="object-source-kind">
          {props.kindLabel}
        </span>
      </div>

      {stale && (
        <div
          className="flex items-center gap-2 border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning"
          data-testid="object-source-stale"
        >
          <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            This definition was read before a catalog change in this session. It may be out of date.
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-6 shrink-0 px-2 text-xs"
            data-testid="object-source-stale-reread"
            onClick={reread}
          >
            <RefreshCw aria-hidden="true" className="mr-1 h-3 w-3" />
            Read again
          </Button>
        </div>
      )}

      {shownFailure !== undefined ? (
        <div className="flex-1 px-3 py-8 text-center text-muted-foreground" data-testid="object-source-failure">
          <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p className="text-xs text-destructive">The source read failed.</p>
          <p
            className="mx-auto mt-1 max-w-xl break-words text-xs text-destructive"
            data-testid="object-source-failure-message"
          >
            {shownFailure}
          </p>
        </div>
      ) : part === undefined ? (
        <div
          className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
          data-testid="object-source-loading"
        >
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
          Reading the definition...
        </div>
      ) : (
        <>
          {showSwitcher && (
            <div role="tablist" aria-label="Definition parts" className="flex gap-1 border-b border-border px-2 py-1">
              {parts.map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  id={tabId(index)}
                  data-part-id={candidate.id}
                  /*
                   * Only the ACTIVE panel is in the tree, so only the active tab may name one.
                   * Round 1 gave every tab `aria-controls={panelId(index)}`, which left every
                   * non-selected tab pointing at an element that does not exist: an axe
                   * `aria-valid-attr-value` violation that shipped. An absent reference is
                   * honest about a panel that is not rendered; a dangling one is not.
                   */
                  {...(index === activeIndex ? { "aria-controls": panelId(index) } : {})}
                  aria-selected={index === activeIndex}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={
                    index === activeIndex
                      ? "rounded px-2 py-1 text-xs font-medium text-foreground bg-muted"
                      : "rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  }
                  onClick={() => onChange({ activePartId: candidate.id })}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          )}
          <div
            className="flex min-h-0 flex-1 flex-col"
            {...(showSwitcher
              ? { role: "tabpanel", id: panelId(activeIndex), "aria-labelledby": tabId(activeIndex) }
              : {})}
          >
            {isSourcePartUnavailable(part) ? (
              /*
               * A DIFFERENT component, not an editor with an empty buffer. This is the
               * composition DBeaver gets wrong, measured in its source: an unreadable
               * definition reaches a writable editor holding one comment line.
               */
              <div className="flex-1 px-3 py-8 text-center text-muted-foreground" data-testid="object-source-refused">
                <FileWarning aria-hidden="true" strokeWidth={1.5} className="mx-auto mb-2 h-8 w-8 opacity-50" />
                <p className="text-xs text-warning">This definition could not be read.</p>
                <p
                  className="mx-auto mt-1 max-w-xl break-words text-xs text-warning"
                  data-testid="object-source-refused-message"
                >
                  {part.unavailable}
                </p>
              </div>
            ) : (
              <>
                <p className="px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="object-source-caption">
                  {sourceCaption(part.form, part.origin)}
                </p>
                {part.truncated !== undefined && (
                  <div
                    className="flex items-center gap-2 border-y border-border bg-warning/10 px-3 py-1.5 text-xs text-warning"
                    data-testid="object-source-truncated"
                  >
                    <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 break-words">{part.truncated.reason}</span>
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <Editor
                    /*
                     * An explicit model path, because `@monaco-editor/react` keys models and
                     * view state by it and `QueryEditor` passes none: without one, both mounts
                     * would share an `undefined` view-state key and a Source tab would restore
                     * the query editor's cursor.
                     */
                    path={`libredb-source:${address}/${part.id}`}
                    language={part.language}
                    value={part.text}
                    height="100%"
                    theme={theme === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK}
                    beforeMount={defineStudioThemes}
                    options={{
                      readOnly: true,
                      domReadOnly: true,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      fontSize: 13,
                      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
