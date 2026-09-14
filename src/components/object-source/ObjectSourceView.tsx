"use client";

import Editor from "@monaco-editor/react";
import { FileWarning, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type * as Monaco from "monaco-editor";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApplyPreviewDialog, type ApplyPreviewState } from "./ApplyPreviewDialog";
import { httpSourceReader, isSourceDocumentShape, type ObjectSourceReader } from "./source-reader";
import { sourceCaption } from "./source-caption";
import { type ObjectSourceApplier, ObjectEditRequestError } from "./source-applier";
import {
  type DraftFailure,
  DRAFT_KEY,
  draftKeyFor,
  dropDraft,
  readDraft,
  type SourceDraft,
  writeDraft,
} from "./source-drafts";
import { partEditability, type SourceEditability } from "./source-editable";
import { Button } from "@/components/ui/button";
import { isObjectEditBuildResponseShape, isObjectEditOutcomeShape } from "@/lib/api/object-edit-wire";
import { isSourcePartUnavailable, SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type {
  ObjectEditConsequenceClass,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPosition,
  ObjectEditPreimage,
  ObjectEditRevision,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
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
  /**
   * WHICH part is being edited, and never a boolean (#789 Phase 3, from discussion #778).
   *
   * PER PART and not per tab, which buys three behaviours with no second flag: two parts of one
   * Oracle package can hold two independent drafts, the writable buffer can only ever be the part
   * on screen, and a part switch is what leaves edit mode. A boolean would have to be paired with
   * `activePartId` at every read, and the pair can disagree.
   */
  readonly editingPartId?: string;
  /**
   * Whether the buffer differs from the text the engine answered, written ONLY WHEN IT FLIPS.
   *
   * `undefined` is the clear, on the spread grammar this whole patch type is built on. The tab bar
   * is the reader of it, and it is deliberately NOT reset by a part switch: a draft that survives
   * the switch is still unsaved, and a mark that vanished when the reader looked at another part
   * would say the opposite.
   */
  readonly dirty?: boolean;
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
  /** The tab's own edit state, mirrored from `SourceTabState`. Absent means nothing is being edited. */
  readonly editingPartId?: string;
  /** The tab's own unsaved mark. Read here only to seed the flip detector across a remount. */
  readonly dirty?: boolean;
  /**
   * WHO performs an edit, and ABSENT MEANS THE PANE IS EXACTLY PHASE 2 (#789 Phase 3).
   *
   * No bar, no sentence, no draft, nothing: that is the absent-handler rule every optional host
   * method in `src/workspace/types.ts` already states, and it is what keeps an existing embedded
   * adopter from changing at all when this phase ships.
   */
  readonly onApply?: ObjectSourceApplier;
  /** Called once after an apply that CHANGED the addressed object, so a shell can re-read. */
  readonly onApplied?: () => void;
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
 * The one marker owner this pane ever writes under (#789 Phase 3).
 *
 * `setModelMarkers` REPLACES the whole marker set for an owner on a model, so one constant is what
 * makes clearing total: an owner per apply would leave the previous apply's marker on screen with
 * nothing able to remove it. The MODEL is already per part, so two parts cannot overwrite each
 * other's markers, and `libredb-` namespaces this away from every marker Monaco's own language
 * services publish.
 */
const MARKER_OWNER = "libredb-object-apply";

/** The same 500 ms the workspace save effect uses at `use-tab-manager.ts:214`, so the two writers have one rhythm. */
const DRAFT_DEBOUNCE_MS = 500;

/** Why a draft is NOT in this browser. Four from the draft store, plus the one only this pane can see. */
type DraftUnsavedReason = DraftFailure | "evicted";

/**
 * One sentence per reason, and the fifth is not a fold of the other four.
 *
 * `evicted` is the reason the STORE cannot answer, because it is not a failure of a write at all:
 * the write succeeded and another browser tab of this application later needed the space and took
 * it. MEASURED by grep before this pane was written: there is no `addEventListener("storage", ...)`
 * and no `BroadcastChannel` anywhere in `src/`, so with one key and oldest-first eviction two
 * Studio tabs silently destroy each other's drafts and both keep saying "Saved in this browser".
 * That is X14's shape inside the subsystem decision H2 created to avoid it, and the storage event
 * below is what closes it.
 */
const UNSAVED_SENTENCE: Readonly<Record<DraftUnsavedReason, string>> = Object.freeze({
  quota: "This browser refused to save this draft, because its storage is full.",
  budget: "This draft is larger than the space LibreDB keeps for drafts in this browser.",
  "too-long": `This text is longer than the ${SOURCE_CHARACTER_LIMIT.toLocaleString("en-US")} characters this definition can be read at, so it cannot be saved and it cannot be applied.`,
  unavailable: "This browser has no local storage, so nothing can be kept here.",
  evicted: "This draft was dropped because another LibreDB tab needed the space.",
});

/** The clause every unsaved sentence ends with, which is the CONSEQUENCE and not the cause. */
const UNSAVED_CONSEQUENCE = "It will be lost if you reload or close this tab.";

/** OURS. The sentence for an apply whose answer this pane could not narrow. */
const UNREADABLE_OUTCOME =
  "The apply was sent and its answer could not be read, so LibreDB cannot say whether this change landed. Re-read this definition before trying again.";

/** OURS. The sentence for a build whose answer this pane could not narrow. */
const UNREADABLE_BUILD = "The apply preview could not be read, so nothing was previewed and nothing was sent.";

/** The Monaco model path for one part, in ONE place, because the marker guard compares against it. */
function modelPathFor(address: string, partId: string): string {
  return `libredb-source:${address}/${partId}`;
}

/**
 * A token for the text a draft was started from, so the restore banner can say whether the
 * definition MOVED under the draft (#789 Phase 3).
 *
 * FNV-1a over UTF-16 code units, with the length in front of it. The length is not decoration: a
 * 32-bit hash collides, and a collision here would tell a reader their draft is still based on
 * what the server holds when it is not, which is the one thing this banner exists to say.
 *
 * WHY A TOKEN THIS PANE MINTS RATHER THAN THE PROVIDER'S REVISION, stated because it is a decision
 * and not an oversight: a draft starts the moment the reader presses Edit, and no plan exists then,
 * so the provider's `ObjectEditRevision` has not been issued and cannot be. `basis` says whose
 * value this is, in the engine-neutral words this pane is entitled to use, and nothing downstream
 * consumes it: `SourceDraft.base` is carried opaquely by the draft store and is compared here and
 * nowhere else.
 */
function textToken(text: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${String(text.length)}:${(hash >>> 0).toString(36)}`;
}

/** The revision a draft records for the text it was started from. */
function paneRevision(text: string): ObjectEditRevision {
  return {
    check: "compared",
    token: textToken(text),
    basis: "the source pane's own read of this part",
    scope: "connection",
  };
}

/**
 * Whether the server's text still matches what this draft was started from.
 *
 * A `base` this pane did not write reaches here: the draft store validates that `base` is an
 * object and no further, deliberately, and a future writer of the same key or an extension can put
 * any arm of `ObjectEditRevision` there. An arm with no token cannot answer the question, so it
 * answers MOVED, which is the arm that tells the reader to look before restoring.
 */
function draftIsCurrent(base: ObjectEditRevision, text: string): boolean {
  return base.check !== "unavailable" && base.token === textToken(text);
}

/**
 * `Storage` or null, asked for at the MOMENT OF USE and never captured.
 *
 * Two reasons, and the second is measured. `typeof window === "undefined"` is the server render,
 * where there is no store at all and the draft module answers `unavailable` rather than throwing.
 * And a test that needs a failing store replaces `window.localStorage` itself: MEASURED on
 * happy-dom 20, patching `window.Storage.prototype.setItem` does NOT change what
 * `window.localStorage.setItem` resolves to, because that store is a Proxy answering from its own
 * target, so a captured handle would make the quota arm untestable.
 */
function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/**
 * The open edit of ONE part: the buffer the editor was last HANDED, and the engine's text that
 * buffer was started from (#789 Phase 3).
 *
 * `base` is not a second copy of the buffer and is not the buffer's current value: it is what
 * `part.text` said at the moment edit mode was entered, which is the only thing that can answer
 * "has the definition moved under this edit" without asking the engine a second time.
 */
interface EditSession {
  readonly partId: string;
  readonly value: string;
  readonly base: string;
}

/** What this browser holds for the open edit. `saved` is this pane's own last write, not a read. */
interface DraftState {
  readonly saved: boolean;
  readonly unsaved?: DraftUnsavedReason;
}

const IDLE_DRAFT: DraftState = Object.freeze({ saved: false });
const SAVED_DRAFT: DraftState = Object.freeze({ saved: true });

/**
 * The dialog's state PLUS the three facts the dialog does not carry and the apply needs.
 *
 * `modelPath` is pinned at BUILD time and never read off the pane at apply time, which is what
 * makes the marker guard meaningful: a reader who switches parts while an apply is in flight has
 * moved the live model, and the coordinate in the answer belongs to the part they left.
 */
interface PreviewSession {
  readonly state: ApplyPreviewState;
  readonly planToken?: string;
  readonly userText: string;
  readonly modelPath: string;
  readonly partId: string;
}

/** A build that issued no plan. `refusal` is rendered as DATA, so a test asserts an id and not prose. */
interface BuildRefusal {
  readonly refusal: string;
  readonly sentence: string;
}

/** The live editor and the live Monaco namespace, both handed over by `onMount`. */
interface MountedEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly monaco: typeof Monaco;
}

/**
 * The two outcomes that mean THE ADDRESSED OBJECT NOW HOLDS THE READER'S TEXT.
 *
 * `applied-elsewhere` is deliberately NOT one of them: the engine accepted the text and wrote a
 * DIFFERENT object, so the reader's edit did not land where they were looking and closing the
 * dialog on it would report a success for a change that is not there. `applied-with-collateral`
 * IS one: the addressed object was replaced, the plan named what else would be lost, and the
 * reader acknowledged it before the apply ran.
 */
const APPLIED_OUTCOMES: ReadonlySet<string> = new Set(["applied", "applied-with-collateral"]);

/** OURS. The outcome this pane synthesises for an answer it could not narrow. */
const UNREADABLE_APPLY = Object.freeze({
  outcome: "interrupted",
  committed: "unknown",
  sentence: UNREADABLE_OUTCOME,
  duration: 0,
} as const);

/**
 * The one conflict arm that carries the server's current text, told apart by a GUARD rather than
 * by a conjunction, so the narrowing survives the early return and `ApplyPreviewFailure` is
 * satisfied without a cast.
 */
function isObjectChanged(
  outcome: ObjectEditOutcome,
): outcome is Extract<ObjectEditOutcome, { readonly conflict: "object-changed" }> {
  return outcome.outcome === "conflict" && outcome.conflict === "object-changed";
}

/** A thrown value's sentence. A non-Error reaches here from a host applier and from a proxy alike. */
function sentenceOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether this document is a definition of THIS pane's object (#789).
 *
 * A source document carries the address it answers for, and every provider in the fleet writes
 * it as `path: [...path]` beside the `kind` it was asked for, so a document naming anything
 * else came from a HOST that answered the wrong question or from a shell holding one state
 * slot for two objects.
 *
 * THE NUMBER THAT STOOD HERE COUNTED A DIFFERENT POPULATION, and it is corrected rather than
 * deleted. It said 55 sites, which is how often `path: [...path]` occurs under `src/lib/db`
 * altogether. MEASURED on this tree: 24 of those build a source DOCUMENT, counted by
 * `grep -rn -A6 'path: \[\.\.\.path\]' src/lib/db | grep -cE '\bparts\b'`, and the other
 * 31 are `describeObject` returns of the shape `{ path: [...path], columns, indexes,
 * foreignKeys }`, which carry no `kind` and are not this claim's subject. The claim itself is
 * unchanged and holds at all 24. What actually holds a provider to it is the conformance
 * helper, which compares a document's `path` and `kind` against the request it was built from,
 * not the count. Without this check such a document renders under the asked-for
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
  const {
    connection,
    path,
    kind,
    document: sourceDocument,
    failure,
    refreshToken,
    reader,
    onApply,
    onApplied,
    onChange: patchTab,
  } = props;
  const theme = useEffectiveTheme();
  const baseId = useId();

  /**
   * EVERY patch this pane writes, with ONE rule added in Phase 3 (#789, discussion #778).
   *
   * A patch that moves `activePartId` also clears `editingPartId`, and it does so IN THE SAME
   * PATCH rather than through a second write, because the shell merges by spread and two writes
   * are two renders with a state in between where the tab says "editing the part you just left".
   *
   * It is done HERE and not in the part switcher for a reason that is about the population and
   * not about tidiness: the switcher has TWO entry points, the click and the arrow-key handler,
   * and a rule written at one of them would leave a keyboard user in edit mode on a part that is
   * no longer on screen. Everything this component writes goes through this one function, so the
   * rule cannot be reached around. Phase 2's own JSX is untouched by it.
   *
   * `Object.hasOwn` and never `in`, per this repository's standing rule, and the test is on the
   * KEY rather than on the value: `{ activePartId: undefined }` is a clear and is still a move.
   */
  const onChange = useCallback(
    (patch: ObjectSourcePatch) => {
      patchTab(Object.hasOwn(patch, "activePartId") ? { ...patch, editingPartId: undefined } : patch);
    },
    [patchTab],
  );

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

  /*
   * ==========================================================================================
   * PHASE 3 (#789, from discussion #778): the edit bar, the draft, the preview and the marker.
   * Everything above this line is Phase 2 and this phase changes none of it.
   * ==========================================================================================
   */

  /**
   * The text arm of the active part, and the editability predicate over it.
   *
   * The refusal arm never reaches the predicate: the refusal PANE draws instead of the editor,
   * so a part with no text has no bar either, and the two facts a bar would state about it are
   * already on screen in the engine's own words. `partId` and `serverText` are total so that
   * every hook below can be declared unconditionally, which is what React requires; they are
   * never read on a render where `part` is absent, because the whole bar is inside that branch.
   */
  const editablePart = part !== undefined && !isSourcePartUnavailable(part) ? part : undefined;
  const editability: SourceEditability | undefined =
    editablePart === undefined ? undefined : partEditability(editablePart);
  const canEdit = editability?.editable === true;
  const refusalShown = editability === undefined || editability.editable ? undefined : editability;
  const partId = part?.id ?? "";
  const serverText = editablePart?.text ?? "";
  const draftKey = draftKeyFor(address, partId);

  /**
   * THE THREE CONJUNCTS, and each one is a different fact that a reader can change independently.
   *
   * The PREDICATE says this text may be replaced at all; `editingPartId` says the reader asked to
   * replace it and names WHICH part, so a second part of the same object is not writable by
   * accident; and `onApply` says a shell that can perform an apply is mounted, which is false in
   * an embedded host that supplied no `objectEditor`. Dropping any one of them leaves a writable
   * editor over a definition nothing can send, which is the empty-editor failure this whole
   * surface exists to prevent, one level up.
   */
  const writable = canEdit && props.editingPartId === partId && onApply !== undefined;

  const [session, setSession] = useState<EditSession | undefined>(undefined);
  const [draftState, setDraftState] = useState<DraftState>(IDLE_DRAFT);
  const [preview, setPreview] = useState<PreviewSession | undefined>(undefined);
  const [buildRefusal, setBuildRefusal] = useState<BuildRefusal | undefined>(undefined);

  /**
   * The reader's own text, in a REF and never in state, which is the decision this pane turns on.
   *
   * MEASURED by reading the installed wrapper, `@monaco-editor/react` 4.7.0: once the editor is
   * not `readOnly`, its `value` effect runs on `[value]` and replaces the FULL MODEL RANGE with
   * `executeEdits` plus an undo stop. A `value` prop that followed the buffer would therefore
   * clobber the reader's text, and their cursor with it, every time the debounced draft landed.
   * So `editorValue` moves at FIVE moments and at no other: entering edit mode, Restore, Discard,
   * a successful apply and leaving edit mode. Typing writes this ref, and nothing else.
   */
  const bufferRef = useRef<string>("");
  /** Seeded from the tab, so a remount inside an unsaved edit does not re-announce the flip. */
  const dirtyRef = useRef<boolean>(props.dirty === true);
  /** The key this pane last WROTE a draft under, which is what makes an eviction detectable. */
  const savedKeyRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const mountedEditor = useRef<MountedEditor | null>(null);
  const markerRef = useRef(false);

  /**
   * THE BUFFER ON SCREEN, and the five moments are the only things that move it.
   *
   * Gated on `writable` and not merely on the session's existence, so leaving edit mode by ANY of
   * its four routes puts the engine's own text back with no second state change to forget:
   * Discard, a successful apply, a part switch, and a shell that cleared the flag itself. A
   * read-only editor holding anything but what the engine answered would read as "this is what
   * the database holds" over text it never sent, which is the same lie the draft is deliberately
   * never restored into a read-only pane to avoid.
   *
   * Derived here rather than reset by an effect: `set-state-in-effect` is an error in this
   * repository's lint gate, and it is right, because an effect that cleared the session would
   * paint one render of the stale buffer before it ran.
   */
  const editorValue = writable && session !== undefined && session.partId === partId ? session.value : serverText;
  /**
   * The definition MOVED under an open edit, said out loud rather than resolved silently.
   *
   * The read effect above rewrites `document` with no drop, deliberately, so a landed re-read can
   * change `part.text` while the reader is typing. The buffer does not follow it, which is the
   * only safe answer: swapping the buffer would destroy their work. Saying nothing would be the
   * other failure, because their next Preview would then diff against a text they never saw.
   */
  const moved = writable && session !== undefined && session.partId === partId && session.base !== serverText;

  const cancelDraft = useCallback(() => {
    if (pendingRef.current !== null) clearTimeout(pendingRef.current);
    pendingRef.current = null;
  }, []);

  /**
   * The debounced draft write, and the ONE place a draft is stored.
   *
   * The same 500 ms the workspace save effect uses at `use-tab-manager.ts:214`, so the two
   * writers have one rhythm rather than two the reader can feel the difference between.
   *
   * A buffer typed back to what the engine holds DROPS the draft instead of storing it: a draft
   * identical to the server's text is not an unsaved edit, and one left behind would outlive the
   * change it was a record of and offer to restore nothing on the next mount.
   */
  const flushDraft = useCallback(() => {
    if (pendingRef.current === null) return;
    clearTimeout(pendingRef.current);
    pendingRef.current = null;
    const text = bufferRef.current;
    if (text === serverText) {
      savedKeyRef.current = undefined;
      dropDraft(browserStorage(), draftKey);
      setDraftState(IDLE_DRAFT);
      return;
    }
    const write = writeDraft(browserStorage(), draftKey, {
      text,
      savedAt: Date.now(),
      base: paneRevision(session?.base ?? serverText),
    });
    savedKeyRef.current = write.ok ? draftKey : undefined;
    setDraftState(write.ok ? SAVED_DRAFT : { saved: false, unsaved: write.reason });
  }, [draftKey, serverText, session]);

  useEffect(() => {
    flushRef.current = flushDraft;
  }, [flushDraft]);

  useEffect(
    () => () => {
      /*
       * A SECOND effect with its own cleanup, and it does not touch the read effect above, whose
       * documented no-cleanup no-drop shape is what makes a read survive a tab switch. This one
       * flushes a pending draft write, because a tab switch inside the 500 ms window is exactly
       * when a reader loses work and never learns they did.
       */
      flushRef.current();
    },
    [],
  );

  /**
   * A FOREIGN tab that evicted this draft, which is the reason the store cannot answer.
   *
   * MEASURED by grep before this was written: there is no `addEventListener("storage", ...)` and
   * no `BroadcastChannel` anywhere in `src/`. With one key and oldest-first eviction, two Studio
   * browser tabs silently destroy each other's drafts: tab B evicts tab A's, tab B is told, and
   * tab A keeps saying "Saved in this browser" over a draft that is gone. That is X14's shape
   * inside the subsystem decision H2 created to avoid it.
   *
   * Registered unconditionally rather than while editing, because the restore banner reads the
   * same store and a draft can be taken out from under it just as easily.
   */
  useEffect(() => {
    const onForeignWrite = (event: StorageEvent) => {
      if (event.key !== DRAFT_KEY || savedKeyRef.current === undefined) return;
      if (readDraft(browserStorage(), savedKeyRef.current) !== undefined) return;
      savedKeyRef.current = undefined;
      setDraftState({ saved: false, unsaved: "evicted" });
    };
    window.addEventListener("storage", onForeignWrite);
    return () => {
      window.removeEventListener("storage", onForeignWrite);
    };
  }, []);

  /** The marker set for our own owner, emptied. `setModelMarkers` REPLACES the set, so this is total. */
  const clearMarker = useCallback(() => {
    if (!markerRef.current) return;
    markerRef.current = false;
    const mounted = mountedEditor.current;
    const model = mounted?.editor.getModel() ?? null;
    if (mounted === null || model === null) return;
    mounted.monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }, []);

  /**
   * The engine's refusal, drawn on the reader's own line.
   *
   * THE MODEL GUARD IS THE WHOLE OF IT. An apply is in flight for the part the reader pressed
   * Preview on, and the reader may switch parts before it answers, at which point the LIVE model
   * belongs to another part and a coordinate from this refusal would be painted on somebody
   * else's text. `getModel()` is asked at the moment of use rather than captured at mount,
   * because the wrapper keeps ONE editor and swaps its model when `path` changes.
   *
   * `endColumn` is `column + 1` so the marker has width. That end MAY be past the end of the
   * line and Monaco clamps it, which is benign for an end and is never done to the START:
   * MEASURED in a real browser, an uncorrected START was clamped in silence and sat at line 10
   * column 1 while the real error was at line 7 column 3, which is why `within: "outside"` is a
   * sentence in the dialog and never a number handed to Monaco.
   */
  const paintMarker = useCallback(
    (modelPath: string, at: { readonly line: number; readonly column: number }, message: string) => {
      const mounted = mountedEditor.current;
      const model = mounted?.editor.getModel() ?? null;
      if (mounted === null || model === null) return;
      if (model.uri.toString() !== mounted.monaco.Uri.parse(modelPath).toString()) return;
      mounted.monaco.editor.setModelMarkers(model, MARKER_OWNER, [
        {
          severity: mounted.monaco.MarkerSeverity.Error,
          message,
          startLineNumber: at.line,
          startColumn: at.column,
          endLineNumber: at.line,
          endColumn: at.column + 1,
        },
      ]);
      markerRef.current = true;
    },
    [],
  );

  const revealPosition = useCallback((at: ObjectEditPosition) => {
    const mounted = mountedEditor.current;
    if (at.within !== "user" || mounted === null) return;
    const position = { lineNumber: at.line, column: at.column };
    mounted.editor.setPosition(position);
    mounted.editor.revealPositionInCenter(position);
    mounted.editor.focus();
  }, []);

  /** `dirty` reaches the tab ONLY when the boolean flips, so it costs one render per transition. */
  const noteDirty = useCallback(
    (text: string) => {
      const isDirty = text !== serverText;
      if (isDirty === dirtyRef.current) return;
      dirtyRef.current = isDirty;
      onChange({ dirty: isDirty ? true : undefined });
    },
    [onChange, serverText],
  );

  const onEditorMount = useCallback((instance: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    mountedEditor.current = { editor: instance, monaco };
  }, []);

  const onEditorChange = useCallback(
    (value: string | undefined) => {
      const text = value ?? "";
      bufferRef.current = text;
      // The refusal was about the text that has just changed, so it is no longer about anything.
      clearMarker();
      noteDirty(text);
      cancelDraft();
      pendingRef.current = setTimeout(() => {
        flushRef.current();
      }, DRAFT_DEBOUNCE_MS);
    },
    [cancelDraft, clearMarker, noteDirty],
  );

  /** Entering edit mode, from Edit with the engine's text and from Restore with the draft's. */
  const startEditing = useCallback(
    (value: string) => {
      bufferRef.current = value;
      setSession({ partId, value, base: serverText });
      noteDirty(value);
      onChange({ editingPartId: partId });
    },
    [noteDirty, onChange, partId, serverText],
  );

  /** Leaving it, from Discard and from a successful apply. The draft goes with the edit. */
  const leaveEditMode = useCallback(() => {
    cancelDraft();
    dropDraft(browserStorage(), draftKey);
    savedKeyRef.current = undefined;
    setDraftState(IDLE_DRAFT);
    dirtyRef.current = false;
    onChange({ editingPartId: undefined, dirty: undefined });
  }, [cancelDraft, draftKey, onChange]);

  /**
   * A stored draft for the part on screen, offered rather than restored.
   *
   * The pane NEVER shows draft text in a read-only editor, because a read-only editor reads as
   * "this is what the engine holds" and a silent restore would make that sentence false on the
   * one screen this phase asks a reader to trust.
   */
  const storedDraft = useMemo(
    () => (writable || !canEdit || onApply === undefined ? undefined : readDraft(browserStorage(), draftKey)),
    [canEdit, draftKey, onApply, writable],
  );
  const driftSentence =
    storedDraft !== undefined && !draftIsCurrent(storedDraft.base, serverText)
      ? " The definition on the server has changed since then."
      : "";

  const landApplyError = useCallback(
    (current: PreviewSession, plan: ObjectEditPlan, preimage: ObjectEditPreimage, error: unknown) => {
      /*
       * An EXPIRED plan is not a failed apply and the reader's next action differs: the plan's
       * 15-minute seal ran out, nothing was executed, and the answer is to rebuild the preview.
       * Reading the CODE and never the sentence, because a sentence is prose and matching
       * substrings against one is the defect this repository already carries in its error mapper.
       */
      const expired = error instanceof ObjectEditRequestError && error.code === "EDIT_PLAN_INVALID";
      setPreview({
        ...current,
        state: expired
          ? { kind: "expired" }
          : {
              kind: "failed",
              plan,
              preimage,
              outcome: { outcome: "interrupted", committed: "unknown", sentence: sentenceOf(error), duration: 0 },
            },
      });
    },
    [],
  );

  const landOutcome = useCallback(
    (current: PreviewSession, plan: ObjectEditPlan, preimage: ObjectEditPreimage, answer: unknown) => {
      /*
       * A read that lies shows the wrong text; an apply that lies tells a reader their change
       * landed when it did not. This narrowing is the only thing standing on the embedded seam,
       * where the answer is a host object and no route of ours has seen it.
       */
      if (!isObjectEditOutcomeShape(answer)) {
        setPreview({ ...current, state: { kind: "failed", plan, preimage, outcome: UNREADABLE_APPLY } });
        return;
      }
      if (APPLIED_OUTCOMES.has(answer.outcome)) {
        setPreview(undefined);
        leaveEditMode();
        onApplied?.();
        return;
      }
      if (isObjectChanged(answer)) {
        setPreview({
          ...current,
          state: { kind: "conflict", plan, current: answer.current, userText: current.userText },
        });
        return;
      }
      setPreview({ ...current, state: { kind: "failed", plan, preimage, outcome: answer } });
      if (answer.outcome === "refused" && answer.refusal.at.within === "user")
        paintMarker(current.modelPath, answer.refusal.at, answer.refusal.sentence);
    },
    [leaveEditMode, onApplied, paintMarker],
  );

  /**
   * BUILD, which is the only thing Preview does: it issues a plan and executes nothing.
   *
   * Ruling 1a: what the reader approves in the dialog is what the engine receives, so the text
   * leaves this pane exactly once, here, and the apply below sends the PLAN back and never the
   * source text again.
   */
  const runBuild = useCallback(() => {
    const applier = onApply;
    if (applier === undefined || connection === null) return;
    const shot = { userText: bufferRef.current, modelPath: modelPathFor(address, partId), partId };
    setBuildRefusal(undefined);
    setPreview({ ...shot, state: { kind: "building" } });
    void applier.build(connection, { path: [...path], kind, partId, text: shot.userText }).then(
      (answer) => {
        if (!isObjectEditBuildResponseShape(answer)) {
          setPreview(undefined);
          setBuildRefusal({ refusal: "unreadable", sentence: UNREADABLE_BUILD });
          return;
        }
        if (!answer.built) {
          setPreview(undefined);
          setBuildRefusal({ refusal: answer.refusal.refusal, sentence: answer.refusal.sentence });
          return;
        }
        setPreview({
          ...shot,
          state: { kind: "preview", plan: answer.plan, preimage: answer.preimage },
          planToken: answer.planToken,
        });
      },
      (error: unknown) => {
        setPreview(undefined);
        setBuildRefusal({ refusal: "request", sentence: sentenceOf(error) });
      },
    );
  }, [address, connection, kind, onApply, partId, path]);

  const runApply = useCallback(
    (acknowledged: readonly ObjectEditConsequenceClass[]) => {
      const applier = onApply;
      const current = preview;
      if (applier === undefined || connection === null || current === undefined || current.state.kind !== "preview")
        return;
      const { plan, preimage } = current.state;
      setPreview({ ...current, state: { kind: "applying", plan, preimage } });
      void applier.apply(connection, plan, current.planToken, acknowledged).then(
        (answer) => {
          landOutcome(current, plan, preimage, answer);
        },
        (error: unknown) => {
          landApplyError(current, plan, preimage, error);
        },
      );
    },
    [connection, landApplyError, landOutcome, onApply, preview],
  );

  const closePreview = useCallback(() => {
    setPreview(undefined);
  }, []);

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
                  {sourceCaption(part.form, part.origin, part.truncated !== undefined)}
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
                {onApply !== undefined && (
                  /*
                   * THE BAR, and there is NO Apply control on it (#789 Phase 3). The only route
                   * from here to a database is the modal, because ruling 1a binds the bytes the
                   * reader approves to the bytes the engine receives, and a control that applied
                   * straight from the buffer would be a second route with nothing binding it.
                   *
                   * It sits between the truncation banner and the editor because both of the
                   * facts above it, the caption and the bound, are things a reader has to have
                   * read before deciding to replace a definition.
                   */
                  <div
                    className="flex flex-col gap-1.5 border-y border-border px-3 py-1.5"
                    data-testid="object-source-edit-bar"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {writable ? (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            data-testid="object-source-preview"
                            disabled={draftState.unsaved === "too-long" || connection === null}
                            onClick={runBuild}
                          >
                            Preview changes
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            data-testid="object-source-discard"
                            onClick={leaveEditMode}
                          >
                            Discard changes
                          </Button>
                          <span className="text-[11px] text-muted-foreground" data-testid="object-source-draft-state">
                            {draftState.saved ? "Saved in this browser." : "Not saved in this browser yet."}
                          </span>
                        </>
                      ) : canEdit ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          data-testid="object-source-edit"
                          onClick={() => {
                            startEditing(serverText);
                          }}
                        >
                          Edit
                        </Button>
                      ) : (
                        refusalShown !== undefined && (
                          <span
                            className="text-[11px] text-muted-foreground"
                            data-testid="object-source-edit-refusal"
                            data-refusal={refusalShown.refusal}
                          >
                            {refusalShown.sentence}
                          </span>
                        )
                      )}
                    </div>

                    {moved && (
                      <div
                        className="flex items-center gap-2 text-xs text-warning"
                        data-testid="object-source-edit-moved"
                      >
                        <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-words">
                          This definition changed on the server while you were editing it. Your text here is untouched,
                          and the preview will compare it against what the server holds now.
                        </span>
                      </div>
                    )}

                    {storedDraft !== undefined && (
                      <div
                        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                        data-testid="object-source-draft-restore"
                      >
                        <span className="min-w-0 break-words">
                          {`This browser holds an unsaved edit of this part, from ${new Date(storedDraft.savedAt).toLocaleString()}.${driftSentence}`}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 shrink-0 px-2 text-xs"
                          data-testid="object-source-draft-restore-accept"
                          onClick={() => {
                            startEditing(storedDraft.text);
                          }}
                        >
                          Restore it
                        </Button>
                      </div>
                    )}

                    {draftState.unsaved !== undefined && (
                      /*
                       * A BANNER AND NOT A TOAST, because it is a STATE that persists for as long
                       * as the reader keeps typing, and a toast that scrolled away three minutes
                       * ago is X14 with extra steps. MEASURED for X14: an uncaught
                       * QuotaExceededError out of the workspace blob's own writer produced zero
                       * toasts, zero alerts, and the word "quota" nowhere in the document.
                       *
                       * `output` rather than a div with role="status", which is this repository's
                       * own spelling of a live region (`LazyView.tsx:25`) and what its jsx-a11y
                       * gate asks for.
                       */
                      <output
                        className="flex items-start gap-2 text-xs text-warning"
                        data-testid="object-source-draft-unsaved"
                      >
                        <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-words">
                          {`${UNSAVED_SENTENCE[draftState.unsaved]} ${UNSAVED_CONSEQUENCE}`}
                        </span>
                      </output>
                    )}

                    {buildRefusal !== undefined && (
                      <div
                        className="flex items-start gap-2 text-xs text-warning"
                        data-testid="object-source-edit-refused"
                        data-refusal={buildRefusal.refusal}
                      >
                        <TriangleAlert aria-hidden="true" strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-words">{buildRefusal.sentence}</span>
                      </div>
                    )}
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
                    path={modelPathFor(address, part.id)}
                    language={part.language}
                    value={editorValue}
                    height="100%"
                    theme={theme === "light" ? STUDIO_THEME_LIGHT : STUDIO_THEME_DARK}
                    beforeMount={defineStudioThemes}
                    onMount={onEditorMount}
                    onChange={onEditorChange}
                    options={{
                      /*
                       * BOTH FLAGS MOVE TOGETHER, and the second is not a duplicate of the first:
                       * `domReadOnly` sets the underlying textarea's own `readonly`, which is what
                       * blocks an IME composition and a paste at the DOM level, below the level
                       * `readOnly` operates at. MEASURED on a live editor instance: Phase 2 set
                       * both to `true`, so driving only one here would leave a pane that a reader
                       * can paste into behind a flag that says it is read only.
                       */
                      readOnly: !writable,
                      domReadOnly: !writable,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      fontSize: 13,
                      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
                    }}
                  />
                </div>
                {preview !== undefined && (
                  <ApplyPreviewDialog
                    open
                    state={preview.state}
                    objectLabel={props.displayName}
                    partLabel={part.label}
                    address={address}
                    partId={preview.partId}
                    onApply={runApply}
                    onRebuild={runBuild}
                    onGoToError={revealPosition}
                    onClose={closePreview}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
