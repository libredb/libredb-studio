// A text document and its editor for the editor commands' unit tests: the fields and methods the host reads, with
// offsets and positions computed over the text's lines as VS Code computes them for "\n" line ends.
import type * as vscode from "vscode";
import { Position } from "./vscode";

/** A document over a text that only `edit` changes, raising `version` as VS Code does; `isUntitled` follows the uri's scheme. */
export class FakeTextDocument {
  version = 1;

  constructor(
    readonly uri: vscode.Uri,
    private text: string,
    public languageId = "sql",
  ) {}

  /** Replaces the whole text, as the person typing would, and raises the version. */
  edit(text: string): void {
    this.text = text;
    this.version += 1;
  }

  get isUntitled(): boolean {
    return this.uri.scheme === "untitled";
  }

  getText(): string {
    return this.text;
  }

  offsetAt(position: Pick<vscode.Position, "line" | "character">): number {
    const lines = this.text.split("\n");
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) offset += lines[line].length + 1;
    return offset + position.character;
  }

  positionAt(offset: number): Position {
    const before = this.text.slice(0, offset).split("\n");
    return new Position(before.length - 1, before[before.length - 1].length);
  }

  /** The document as the host's typings see it. */
  asDocument(): vscode.TextDocument {
    return this as unknown as vscode.TextDocument;
  }
}

/** A primary selection, by its anchor and active ends, as a vscode.Selection reads them. */
export interface FakeSelection {
  readonly anchor: Position;
  readonly active: Position;
  readonly start: Position;
  readonly end: Position;
}

/** An editor showing a FakeTextDocument, with one primary selection and the decorations it was given. */
export class FakeTextEditor {
  selection: FakeSelection;
  /** Each setDecorations call, as [type, ranges]. */
  readonly decorations: [vscode.TextEditorDecorationType, readonly vscode.Range[]][] = [];

  constructor(
    readonly document: FakeTextDocument,
    anchor = 0,
    active = anchor,
  ) {
    this.selection = this.selectionOf(anchor, active);
  }

  /** Sets the primary selection from anchor to active, as offsets; start and end are the earlier and later ends. */
  select(anchor: number, active: number): void {
    this.selection = this.selectionOf(anchor, active);
  }

  setDecorations(type: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[]): void {
    this.decorations.push([type, ranges]);
  }

  /** The editor as the host's typings see it. */
  asEditor(): vscode.TextEditor {
    return this as unknown as vscode.TextEditor;
  }

  private selectionOf(anchor: number, active: number): FakeSelection {
    const at = (offset: number) => this.document.positionAt(offset);
    return {
      anchor: at(anchor),
      active: at(active),
      start: at(Math.min(anchor, active)),
      end: at(Math.max(anchor, active)),
    };
  }
}
