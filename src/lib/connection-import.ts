/**
 * The connection import a type may declare on its `DB_UI_CONFIG` entry (`connectionImport`): the label of the
 * connection dialog's import action and a loader of the parser that reads a pasted text into entries the dialog can
 * fill the form from. The dialog calls `load` only when the import opens, so the parser and what it imports reach the
 * browser only then.
 *
 * Types only, so a parser module can name them without importing the dialog, its icons or anything server-side. A
 * parser runs in the browser: it imports no `node:` module and no provider, sends nothing, logs nothing and stores
 * nothing.
 */
import type { ConnectionField } from "@/lib/db-ui-config";
import type { SSLConfig } from "@/lib/types";

/**
 * The connection fields an import may fill: every addressing field except the consent to send a password without TLS,
 * which only the person filling the form may give.
 */
export type ImportedField = Exclude<ConnectionField, "allowInsecureAuth">;

/** The SSL / TLS settings an import may fill: the ones the dialog draws a control for. */
export type ImportedSsl = Pick<SSLConfig, "mode" | "caCert" | "clientCert" | "clientKey">;

/** One entry of the pasted text, ready to fill the form for the type that declared the import. */
export interface ImportedContext {
  /** The entry's own name, shown in the picker and used as the connection name when the dialog has none. */
  readonly name: string;
  readonly fields: Readonly<Partial<Record<ImportedField, string>>>;
  readonly ssl?: Readonly<Partial<ImportedSsl>>;
  /** Sentences about this entry, such as a setting that was not imported and why; never a value from the text. */
  readonly notices: readonly string[];
}

export interface ConnectionImportResult {
  readonly contexts: readonly ImportedContext[];
  /** Sentences about the text as a whole or about an entry that could not be read; never a value from the text. */
  readonly refusals: readonly string[];
}

/**
 * Reads a pasted text. It never throws, and it keeps no reference to a parser's own error, whose message can quote
 * the text and so a credential in it.
 */
export type ConnectionImporter = (text: string) => ConnectionImportResult;

export interface ConnectionImportDeclaration {
  /** The import action's label, such as "Import from a client configuration file". */
  readonly label: string;
  /** Loads the parser; called when the import opens, never before. */
  readonly load: () => Promise<ConnectionImporter>;
}
